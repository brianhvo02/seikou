/**
 * npm run bdj-library:check -- [--only <id>...] [--ours-only] [--force] [--jobs N] [--lib-jobs N] [--no-run]
 *
 * Runs the generic key script (generic.keys) on every BD-J disc copied by sync.ts, in our player (one child process
 * per disc, hard kill at 150 s, --jobs at a time, default 6) and in libbluray (tools/bdj-trace/run.sh --keys, Docker,
 * --lib-jobs at a time, default 3), classifies each disc (classify.ts) and writes $BDJ_LIBRARY_DIR/results/<id>.json
 * and $BDJ_LIBRARY_DIR/summary.md. Incremental: a run is reused while the disc's copy, the script and (ours) the code
 * under src/, tests/bdj/ and tools/bdj-library/ or (libbluray) the harness image are unchanged. --only re-runs the
 * given discs; --force re-runs everything; --ours-only leaves libbluray's runs as they are (reused when present);
 * --no-run only reclassifies and rewrites the summary. See tools/bdj-library/README.md.
 *
 * Child mode (used by the above): check.ts --run-ours <disc dir> <out.json>
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceEntry } from '../../src/bdj/host';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import { codingName } from '@seikou/bdmv/stream-types';
import { CONTROL_CALLS } from '../../tests/bdj/format';
import { parseKeyScript } from '../../tests/bdj/key-script';
import { replayPlayerBdj, type PlayerBdjReplay } from '../../tests/bdj/replay-player';
import { classify, countedGaps, gapOf, libraryDir, missingClassesFromLog, parseLibblurayRun, platformClass, VERDICTS, type DiscVerdict, type RunEnd, type RunRecord } from './classify';
import { trackGaps } from './gaps';
import { libRunArgs } from './lib-run';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SCRIPT = fileURLToPath(new URL('./generic.keys', import.meta.url));
const RUN_SH = join(ROOT, 'tools', 'bdj-trace', 'run.sh');
/** The hard kill per disc and side. */
const KILL_MS = 150_000;
/** Both sides: each script step may wait 60 s; the whole run ends at 140 s; 5 s of tail after the script's end. */
const STEP_TIMEOUT_S = 60;
const RUN_LIMIT_S = 140;
const TAIL_S = 5;

/** What check.ts keeps per disc in results/<id>.json. */
export interface DiscResult {
  readonly id: string;
  /** The disc copy's fingerprint (sync.ts: the hash of its NAS file list). */
  readonly fingerprint: string;
  readonly oursStamp: string;
  readonly libStamp: string | null;
  readonly ours: RunRecord;
  readonly lib: RunRecord | null;
  readonly verdict: DiscVerdict;
  readonly detail: string;
  readonly checkedAt: string;
  /** Whether the menu's clips were real (sync.ts --video) or stubs; the same for both sides. */
  readonly video: 'real' | 'stub';
}

/** The video codec of a playlist's first video stream, or null (none, or unreadable). */
function playlistVideo(dir: string, playlist: number): string | null {
  try {
    const mpls = parseMpls(new Uint8Array(readFileSync(join(dir, 'BDMV', 'PLAYLIST', `${String(playlist).padStart(5, '0')}.mpls`))));
    const v = mpls.playItems.flatMap((p) => p.stn.video)[0];
    return v ? codingName(v.codingType) : null;
  } catch {
    return null;
  }
}

function rejectedPlaylists(dir: string, calls: readonly TraceEntry[]): RunRecord['rejectedPlaylists'] {
  const seen = new Set<number>();
  for (const c of calls) if (c.call === 'selectPlaylistN' && c.ret === 0) seen.add(Number(c.args[0]));
  return [...seen].map((playlist) => ({ playlist, video: playlistVideo(dir, playlist) }));
}

/** No paths in records: anything after a slash-led word becomes <path> (class names keep their dots). */
const scrub = (s: string): string => s.replace(/(^|\s)\/\S+/g, '$1<path>').slice(0, 300);

// ---------------------------------------------------------------------------------------------------- child: ours

async function runOurs(dir: string, out: string): Promise<void> {
  const t0 = performance.now();
  const tracker = trackGaps();
  const logs: string[] = [];
  let run: Partial<PlayerBdjReplay> & { stepCalls?: readonly number[] };
  let end: RunEnd = 'done';
  let endDetail: string | null = null;
  try {
    run = await replayPlayerBdj(dir, {
      until: '-',
      untilPlane: () => true, // the run ends with the script (and its tail)
      script: parseKeyScript(readFileSync(SCRIPT, 'utf8')),
      tailMs: TAIL_S * 1000,
      timeoutMs: RUN_LIMIT_S * 1000,
      stepTimeoutMs: STEP_TIMEOUT_S * 1000,
      log: (line) => logs.push(line),
    });
  } catch (err) {
    const e = err as Error & Partial<PlayerBdjReplay>;
    run = e;
    const m = e.message ?? String(err);
    end = /did not hold within/.test(m) ? 'timeout' : /timed out after/.test(m) ? 'limit' : /BD-J failed/.test(m) ? 'bdj-failed' : 'error';
    endDetail = scrub(m.replace(/^replayPlayerBdj: /, ''));
  }
  const trace = run.trace ?? [];
  const controlBefore: number[] = [];
  let n = 0;
  trace.forEach((c, i) => {
    controlBefore[i] = n;
    if (CONTROL_CALLS.has(c.call)) n++;
  });
  controlBefore[trace.length] = n;
  const calls = trace.filter((c) => CONTROL_CALLS.has(c.call));
  const { all, counted } = tracker.gaps();
  tracker.stop();
  const missing = new Set<string>(all);
  const seen = new Set<string>(counted); // a gap some throw of which reached the disc's code or ended a thread, or the log
  for (const c of missingClassesFromLog(logs)) {
    missing.add(c);
    seen.add(c);
  }
  const caughtGaps = [...missing].filter((c) => !seen.has(c));
  const flushes = run.flushes ?? [];
  const record: RunRecord = {
    side: 'ours',
    end,
    endDetail,
    steps: (run.steps ?? []).map((s, i) => ({ ...s, calls: controlBefore[run.stepCalls?.[i] ?? trace.length] ?? n })).map(({ script: _s, ...s }) => s),
    calls,
    endHash: flushes.at(-1) ?? null,
    flushes: flushes.length,
    missingClasses: [...missing],
    ...(caughtGaps.length ? { caughtGaps } : {}),
    rejectedPlaylists: rejectedPlaylists(dir, calls),
    wallMs: Math.round(performance.now() - t0),
  };
  writeFileSync(out, JSON.stringify(record));
  writeFileSync(`${out}.log`, logs.join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------- orchestration

/** Children running now (process group leaders, and the Docker container a libbluray run names), for a kill on a signal. */
const active = new Set<{ pid: number; container: string | null }>();

/** Kills a child's process group, and first its container (the docker CLI dying does not stop a container). */
function killChild(c: { pid: number; container: string | null }): void {
  if (c.container) spawnSync('docker', ['kill', c.container], { stdio: 'ignore' });
  try {
    process.kill(-c.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const c of active) killChild(c);
    console.log(`${sig}: stopped ${active.size} runs; finished discs keep their stamps, so a re-run resumes`);
    process.exit(130);
  });
}

/** Runs a command with a hard kill (its container, then its whole process group); stdout and stderr to the given files. */
function runKilled(cmd: string, args: readonly string[], stdoutFile: string, stderrFile: string, container: string | null = null): Promise<{ killed: boolean; code: number | null; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const child = { pid: p.pid!, container };
    active.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => err.push(d));
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killChild(child);
    }, KILL_MS);
    p.on('close', (code) => {
      clearTimeout(timer);
      active.delete(child);
      writeFileSync(stdoutFile, Buffer.concat(out));
      writeFileSync(stderrFile, Buffer.concat(err));
      resolve({ killed, code, ms: Date.now() - t0 });
    });
  });
}

async function pool<T>(items: readonly T[], jobs: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const sha = (s: string | Buffer): string => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** What our side's result depends on: the contents of the code (committed or not) and the script. */
function oursStamp(): string {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'tests/bdj', 'tools/bdj-library'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter((f) => f && existsSync(join(ROOT, f)))
    .sort();
  const h = createHash('sha1');
  for (const f of files) h.update(`${f}\0`).update(readFileSync(join(ROOT, f)));
  return sha(`${h.digest('hex')}\n${readFileSync(SCRIPT, 'utf8')}`);
}

/** What libbluray's result depends on: the harness image and the script. */
function libStamp(): string {
  const image = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', 'bluray-web-bdj-trace:latest'], { encoding: 'utf8' }).trim();
  return sha(`${image}\n${readFileSync(SCRIPT, 'utf8')}\n${STEP_TIMEOUT_S} ${RUN_LIMIT_S} ${TAIL_S}`);
}

/** raw/<id>.<side>.stamp: what the side's run was made with. */
interface Stamp {
  readonly stamp: string | null;
  readonly fingerprint: string;
}

interface Disc {
  readonly id: string;
  readonly dir: string;
  readonly fingerprint: string;
  readonly video: 'real' | 'stub';
}

function discs(lib: string): Disc[] {
  const map = join(lib, 'map.tsv');
  if (!existsSync(map)) throw new Error(`no ${map}: run npm run bdj-library:sync first`);
  return readFileSync(map, 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([, bdj]) => bdj === '1')
    .map(([id, , fingerprint]) => {
      // real menu clips (sync.ts --video) change what both sides play, so they are part of the fingerprint
      const video = join(lib, 'manifests', `${id}.video.tsv`);
      const real = existsSync(video) ? readFileSync(video, 'utf8').trim() : '';
      return { id: id!, dir: join(lib, 'discs', id!), fingerprint: real ? `${fingerprint!}+v${sha(real)}` : fingerprint!, video: real ? ('real' as const) : ('stub' as const) };
    });
}

const readJson = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
};

function writeSummary(lib: string, results: readonly DiscResult[], runtime: string): Record<DiscVerdict, number> {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<DiscVerdict, number>;
  for (const r of results) counts[r.verdict]++;
  const tally = (xs: readonly string[]): string[] => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`);
  };
  const by = (v: DiscVerdict): DiscResult[] => results.filter((r) => r.verdict === v);
  const lines = [
    `# BD-J library check`,
    ``,
    `${new Date().toISOString()}: ${results.length} discs. ${runtime}`,
    ``,
    `| verdict | discs |`,
    `|---|---|`,
    ...VERDICTS.map((v) => `| ${v} | ${counts[v]} |`),
    ``,
    `## Unconfirmed: for a check by hand (Ruling R6)`,
    ``,
    `The menu was reached and ours agrees with libbluray on every step both ran, but a key was never compared and ours showed no reaction there, or a key was never tried.`,
    ``,
    `| id | reason | video |`,
    `|---|---|---|`,
    ...by('unconfirmed')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => `| ${r.id} | ${r.detail.replace(/\|/g, '\\|')} | ${r.video ?? 'stub'} |`),
    ``,
    `## Missing classes (first blocker, missing-class discs)`,
    ``,
    `| class | discs |`,
    `|---|---|`,
    ...tally(by('missing-class').map((r) => countedGaps(r.ours)[0]!)),
    ``,
    `## Missing classes (any, every disc)`,
    ``,
    `| class | discs |`,
    `|---|---|`,
    ...tally(results.flatMap((r) => countedGaps(r.ours))),
    ``,
    `## Classes the platform looked up and dropped in its own code (not counted, Ruling R13)`,
    ``,
    `| class | discs |`,
    `|---|---|`,
    ...tally(results.flatMap((r) => r.ours.caughtGaps ?? [])),
    ``,
    `## Refused video (unsupported-video discs)`,
    ``,
    `| codec | discs |`,
    `|---|---|`,
    ...tally(by('unsupported-video').map((r) => r.ours.rejectedPlaylists.find((p) => p.video)?.video ?? '?')),
    ``,
    `## Where ours stops (stall, diverges, error)`,
    ``,
    `| verdict, steps ours ran, end | discs |`,
    `|---|---|`,
    ...tally(results.filter((r) => ['stall', 'diverges', 'error'].includes(r.verdict)).map((r) => `${r.verdict}, ${r.ours.steps.length}, ${r.ours.end}`)),
    ``,
    `## Discs`,
    ``,
    `| id | verdict | detail | ours steps/end | libbluray steps/end | video |`,
    `|---|---|---|---|---|---|`,
    ...[...results]
      .sort((a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || a.id.localeCompare(b.id))
      .map((r) => `| ${r.id} | ${r.verdict} | ${r.detail.replace(/\|/g, '\\|')} | ${r.ours.steps.length} ${r.ours.end} | ${r.lib ? `${r.lib.steps.length} ${r.lib.end}` : '-'} | ${r.video ?? 'stub'} |`),
    ``,
  ];
  writeFileSync(join(lib, 'summary.md'), lines.join('\n'));
  return counts;
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === '--run-ours') return runOurs(argv[1]!, argv[2]!);
  const count = (name: string, v: string | undefined): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error(`${name} wants a whole number from 1 to 64, got ${v ?? 'nothing'}`);
    return n;
  };
  const only: string[] = [];
  let oursOnly = false;
  let force = false;
  let noRun = false;
  let jobs = 6;
  let libJobs = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--only') while (argv[i + 1] && !argv[i + 1]!.startsWith('--')) only.push(argv[++i]!);
    else if (a === '--ours-only') oursOnly = true;
    else if (a === '--force') force = true;
    else if (a === '--no-run') noRun = true;
    else if (a === '--jobs') jobs = count(a, argv[++i]);
    else if (a === '--lib-jobs') libJobs = count(a, argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  const lib = libraryDir();
  const raw = join(lib, 'raw');
  const resultsDir = join(lib, 'results');
  mkdirSync(raw, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  const all = discs(lib);
  const unknown = only.filter((id) => !all.some((d) => d.id === id));
  if (unknown.length) throw new Error(`not in the library: ${unknown.join(' ')}`);
  const selected = only.length ? all.filter((d) => only.includes(d.id)) : all;
  const t0 = Date.now();
  const oStamp = oursStamp();
  const lStamp = oursOnly || noRun ? null : libStamp();
  // each phase writes raw/<id>.<side>.stamp once the disc's run is in, so an interrupted check resumes where it stopped
  const stampOf = (d: Disc, side: 'ours' | 'lib'): Stamp | null => readJson<Stamp>(join(raw, `${d.id}.${side}.stamp`));
  const fresh = (d: Disc, side: 'ours' | 'lib', stamp: string | null): boolean => {
    const s = stampOf(d, side);
    return !force && !only.length && s?.fingerprint === d.fingerprint && s.stamp === stamp;
  };
  const writeStamp = (d: Disc, side: 'ours' | 'lib', stamp: string | null): void => writeFileSync(join(raw, `${d.id}.${side}.stamp`), JSON.stringify({ stamp, fingerprint: d.fingerprint }));
  const oursTodo = noRun ? [] : selected.filter((d) => !fresh(d, 'ours', oStamp));
  const libTodo = noRun || oursOnly ? [] : selected.filter((d) => !fresh(d, 'lib', lStamp));
  console.log(`${selected.length} discs: ours ${oursTodo.length} to run, libbluray ${libTodo.length} to run`);

  let done = 0;
  await pool(oursTodo, jobs, async (d) => {
    const out = join(raw, `${d.id}.ours.json`);
    const r = await runKilled(process.execPath, ['--import', 'tsx', SELF, '--run-ours', d.dir, out + '.tmp'], join(raw, `${d.id}.ours.stdout`), join(raw, `${d.id}.ours.stderr`));
    const rec = readJson<RunRecord>(out + '.tmp');
    const fallback: RunRecord = { side: 'ours', end: r.killed ? 'killed' : 'no-output', endDetail: r.killed ? null : `exit ${r.code}`, steps: [], calls: [], endHash: null, flushes: 0, missingClasses: [], rejectedPlaylists: [], wallMs: r.ms };
    writeFileSync(out, JSON.stringify(rec ?? fallback));
    writeStamp(d, 'ours', oStamp);
    console.log(`ours ${++done}/${oursTodo.length} ${d.id} ${rec ? `${rec.steps.length} steps, ${rec.end}` : fallback.end} ${Math.round(r.ms / 1000)} s`);
  });
  done = 0;
  await pool(libTodo, libJobs, async (d) => {
    const base = join(raw, `${d.id}.lib`);
    const run = (attempt: number): ReturnType<typeof runKilled> => {
      const name = `bdjlib-${d.id}-${attempt}`;
      const limits = { seconds: RUN_LIMIT_S, waitTimeout: STEP_TIMEOUT_S, tail: TAIL_S };
      return runKilled('bash', libRunArgs(RUN_SH, d.dir, SCRIPT, limits, attempt, name), `${base}.jsonl`, `${base}.err`, name);
    };
    let r = await run(1);
    // a crashed run (no script end line: HotSpot under amd64 emulation now and then dies with a SIGSEGV in libzip, or the
    // run was killed) is run once more, without memory-mapped zip directories (libRunArgs)
    let retried = false;
    if (!readFileSync(`${base}.jsonl`, 'utf8').includes('"script":"end"')) {
      retried = true;
      r = await run(2);
    }
    writeFileSync(`${base}.meta.json`, JSON.stringify({ killed: r.killed, code: r.code, ms: r.ms, retried }));
    writeStamp(d, 'lib', lStamp);
    console.log(`libbluray ${++done}/${libTodo.length} ${d.id} exit ${r.killed ? 'killed' : r.code}${retried ? ' (retried)' : ''} ${Math.round(r.ms / 1000)} s`);
  });

  /** The current gap rules (gapOf) over a record's entries. */
  const stillAGap = (c: string): boolean =>
    c.startsWith('native: ') || (c.startsWith('method: ') ? gapOf(`java.lang.NoSuchMethodError: ${c.slice(8)}`) !== null : platformClass(c) !== null);
  const runtime = noRun ? 'Reclassified only.' : `This run: ours ${oursTodo.length}, libbluray ${libTodo.length} discs in ${Math.round((Date.now() - t0) / 60000)} min.`;
  for (const d of selected) {
    const raw0 = readJson<RunRecord>(join(raw, `${d.id}.ours.json`));
    if (!raw0) continue;
    // reapply the current platform-class rule, so a rule change needs no re-run
    const ours: RunRecord = { ...raw0, missingClasses: raw0.missingClasses.filter(stillAGap) };
    let libRec: RunRecord | null = null;
    const meta = readJson<{ killed: boolean; ms: number }>(join(raw, `${d.id}.lib.meta.json`));
    if (meta && existsSync(join(raw, `${d.id}.lib.jsonl`))) {
      const parsed = parseLibblurayRun(readFileSync(join(raw, `${d.id}.lib.jsonl`), 'utf8'), readFileSync(join(raw, `${d.id}.lib.err`), 'utf8'), meta.ms, meta.killed);
      libRec = { ...parsed, rejectedPlaylists: rejectedPlaylists(d.dir, parsed.calls) };
    }
    const { verdict, detail } = classify(ours, libRec);
    const result: DiscResult = {
      id: d.id,
      fingerprint: d.fingerprint,
      video: d.video,
      oursStamp: stampOf(d, 'ours')?.stamp ?? '-',
      libStamp: stampOf(d, 'lib')?.stamp ?? null,
      ours,
      lib: libRec,
      verdict,
      detail,
      checkedAt: new Date().toISOString(),
    };
    writeFileSync(join(resultsDir, `${d.id}.json`), JSON.stringify(result, null, 1));
  }
  const ids = new Set(all.map((d) => d.id));
  const results = readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json') && ids.has(f.slice(0, -5)))
    .map((f) => readJson<DiscResult>(join(resultsDir, f))!)
    .filter(Boolean);
  const counts = writeSummary(lib, results, runtime);
  console.log(`${runtime} Verdicts over ${results.length} discs: ${VERDICTS.map((v) => `${v} ${counts[v]}`).join(', ')}`);
  console.log(`summary: ${join(lib, 'summary.md')}`);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  console.error(`bdj-library:check: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
