/**
 * The library check's records and verdicts (tools/bdj-library/README.md): what one run of the generic key script did,
 * in our player or in libbluray, and how a disc is judged from the two runs. No disc, file or process access.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TraceEntry } from '../../src/bdj/host';
import { CONTROL_CALLS } from '../../tests/bdj/format';

export type DiscVerdict = 'works' | 'unconfirmed' | 'libbluray-fails-too' | 'missing-class' | 'unsupported-video' | 'stall' | 'diverges' | 'error';

export const VERDICTS: readonly DiscVerdict[] = ['works', 'unconfirmed', 'libbluray-fails-too', 'missing-class', 'unsupported-video', 'stall', 'diverges', 'error'];

/** A script step as it ran: `calls` is how many control calls the run had made before it ran. */
export interface RunStep {
  readonly n: number;
  readonly step: string;
  /** `wait still` steps: the settled plane's hash (the last flush before the step; null before any flush). */
  readonly hash?: string | null;
  /** A `wait menu` step that held on an animated menu (visible, still flushing after 30 s): no hash, only visible. */
  readonly animated?: boolean;
  readonly calls: number;
}

/**
 * How a run ended. `done`: the script ran to its end (and the tail after it). `timeout`: a step's wait did not hold in
 * time (the step is the first one missing from `steps`). `limit`: the run's own time limit. `bdj-failed`: our player
 * gave up on BD-J. `error`: the player or harness failed. `killed`: the process outlived the hard kill. `no-output`:
 * the process left no record.
 */
export type RunEnd = 'done' | 'timeout' | 'limit' | 'bdj-failed' | 'error' | 'killed' | 'no-output';

/** One run of the generic script on one disc, by one side. */
export interface RunRecord {
  readonly side: 'ours' | 'libbluray';
  readonly end: RunEnd;
  /** Why the run failed, when it did (an error message, never a path). */
  readonly endDetail: string | null;
  /** The steps that ran, in order. */
  readonly steps: readonly RunStep[];
  /** The control calls (tests/bdj/format.ts CONTROL_CALLS), in order, up to the end of the run's tail. */
  readonly calls: readonly TraceEntry[];
  /** The last flushed plane at the end of the run (null: none). */
  readonly endHash: string | null;
  readonly flushes: number;
  /** Platform classes Java could not load (NoClassDefFoundError, or ClassNotFoundException of a platform class). */
  readonly missingClasses: readonly string[];
  /**
   * Entries of missingClasses whose every ClassNotFoundException died inside platform code, never reaching the disc's
   * code nor ending a thread (gapExempt, Ruling R13): a designed lookup, such as java.net.URL looking for a protocol
   * handler. Not counted as gaps (countedGaps). Absent in records made before R13.
   */
  readonly caughtGaps?: readonly string[];
  /** selectPlaylistN calls that returned 0, with the playlist's video codec (null: no video stream or unreadable). */
  readonly rejectedPlaylists: readonly { readonly playlist: number; readonly video: string | null }[];
  readonly wallMs: number;
}

/** The generic script's steps (generic.keys), by index. */
export const STEP = { menu: 0, right: 1, afterRight: 2, down: 3, afterDown: 4, ok: 5, playlist: 6 } as const;

/** $BDJ_LIBRARY_DIR, by default ~/.cache/bluray-web/bdj-library (outside the repo: disc names are private). */
export function libraryDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.BDJ_LIBRARY_DIR || join(homedir(), '.cache', 'bluray-web', 'bdj-library');
}

/** A disc's id: the first 10 hex digits of the SHA-1 of its folder path on the NAS (only hex, never a path). */
export function discId(nasPath: string): string {
  return createHash('sha1').update(nasPath).digest('hex').slice(0, 10);
}

/** The hash of a fully transparent 1920x1080 plane (tools/bdj-trace/README.md, Hash). */
export const EMPTY_PLANE_HASH: string = (() => {
  let h = 0x811c9dc5;
  for (let i = 0; i < 1920 * 1080 * 4; i++) h = Math.imul(h, 0x01000193); // h ^ 0 is h
  return (h >>> 0).toString(16).padStart(8, '0');
})();

const visible = (hash: string | null | undefined): boolean => hash !== null && hash !== undefined && hash !== EMPTY_PLANE_HASH;

const PLATFORM = /^(java|javax|sun|com\.sun|org\.dvb|org\.havi|org\.davic|org\.bluray|org\.videolan|org\.w3c|org\.xml|jdk)\./;

/** A class name as Java prints it (dots), or null when it is not a platform class (the disc's own, or a resource). */
export function platformClass(name: string): string | null {
  const n = name.trim().replace(/\//g, '.');
  // a disc's own obfuscated classes sometimes sit in a platform package (`org.w3c.dom.a`): not a platform class
  return PLATFORM.test(n) && /^[\w.$]+$/.test(n) && !/\.[a-z]{1,2}$/.test(n) ? n : null;
}

/** A missingClasses entry from a gap throwable's description, or null when it is not a platform gap. */
export function gapOf(description: string): string | null {
  const m = /^java\.lang\.(NoClassDefFoundError|ClassNotFoundException|UnsatisfiedLinkError|NoSuchMethodError): (\S+)/.exec(description);
  if (!m) return null;
  const [, kind, what] = m as unknown as [string, string, string];
  if (kind === 'UnsatisfiedLinkError') return `native: ${what}`;
  if (kind === 'NoSuchMethodError') {
    // only a method missing from a platform class (a disc's own classes are the disc's business)
    const owner = what.replace(/\.[^.(]+\(.*$/, '');
    // MethodHandleImpl.array/fillArray: lambda bootstrap probes that fail benignly on every disc, working ones too
    if (/^java\.lang\.invoke\.MethodHandleImpl\.(array|fillArray)\(/.test(what)) return null;
    return platformClass(owner) ? `method: ${what}` : null;
  }
  const c = platformClass(what.replace(/[^\w$]+$/, ''));
  // libbluray's own stack probes for optional org.videolan classes; a ClassNotFoundException there is no failure
  return c && !(kind === 'ClassNotFoundException' && c.startsWith('org.videolan.')) ? c : null;
}

/**
 * The class-library gaps named in a Java log, in order (gapOf): NoClassDefFoundError and ClassNotFoundException of
 * platform classes, UnsatisfiedLinkError (`native: ...`) and NoSuchMethodError of platform methods (`method: ...`).
 */
export function missingClassesFromLog(lines: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(/(?:java\.lang\.)?(NoClassDefFoundError|ClassNotFoundException|UnsatisfiedLinkError|NoSuchMethodError):?\s+(\S+)/g)) {
      const g = gapOf(`java.lang.${m[1]}: ${m[2]}`);
      if (g) out.add(g);
    }
  }
  return [...out];
}

/**
 * Where a gap throwable went as the interpreter unwound it (interpreter.ts setUnwindObserver): each Java method it
 * reached, in order, platform (boot class path) or the disc's, and 'uncaught' when it ended its thread.
 */
export type UnwindStep = { readonly platform: boolean } | 'uncaught';

/**
 * Ruling R13: whether a ClassNotFoundException is exempt from the gaps, a lookup the platform made and dropped (java.net.URL
 * asking for a protocol handler, a parent loader's miss inside ClassLoader.loadClass). Exempt only when the object
 * died inside platform frames: it never unwound into a method of the disc's, nor ended its thread, however many times
 * it was caught and rethrown on the way (a catch-and-rethrow, or a finally, does not end it). A NoClassDefFoundError
 * or another gap kind is never exempt. `kind` is the throwable's class (internal name).
 */
export function gapExempt(kind: string, steps: readonly UnwindStep[]): boolean {
  return kind === 'java/lang/ClassNotFoundException' && steps.every((s) => s !== 'uncaught' && s.platform);
}

/** The class-library gaps a run counts (Ruling R13): missingClasses less the ones the platform always caught itself. */
export function countedGaps(r: RunRecord): readonly string[] {
  const caught = new Set(r.caughtGaps ?? []);
  return caught.size ? r.missingClasses.filter((c) => !caught.has(c)) : r.missingClasses;
}

const isControl = (o: { call?: unknown }): o is TraceEntry => typeof o.call === 'string' && CONTROL_CALLS.has(o.call);

/**
 * Reads a libbluray run of the generic script (tools/bdj-trace/run.sh --keys: stdout, stderr), as settled.py reduces
 * one: control calls up to the script's end line, the steps with their settled hashes, the last flush.
 */
export function parseLibblurayRun(stdout: string, stderr: string, wallMs: number, exitKilled = false): Omit<RunRecord, 'rejectedPlaylists'> {
  const calls: TraceEntry[] = [];
  const steps: RunStep[] = [];
  let last: string | null = null;
  let flushes = 0;
  let end: { why?: string } | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (isControl(o)) {
      if (end === null) calls.push(o);
    } else if (o.plane === 'flush') {
      if (end === null) {
        last = String(o.hash);
        flushes++;
      }
    } else if (o.script === 'step') {
      const text = String(o.step);
      const settled = text.startsWith('wait still') || text.startsWith('wait menu') || text.startsWith('wait quiet');
      steps.push({ n: Number(o.n), step: text, ...(o.animated ? { animated: true } : settled ? { hash: last } : {}), calls: calls.length });
    } else if (o.script === 'end') {
      end = o as { why?: string };
    }
  }
  const why = end?.why;
  const runEnd: RunEnd = exitKilled ? 'killed' : why === 'done' ? 'done' : why === 'timeout' ? 'timeout' : why === 'limit' ? 'limit' : why === 'error' ? 'error' : stdout.trim() ? 'error' : 'no-output';
  const errLine = stderr.split('\n').find((l) => /bdj_trace:|bd_open failed|bd_play failed|cannot/.test(l)) ?? null;
  return {
    side: 'libbluray',
    end: runEnd,
    endDetail: runEnd === 'done' ? null : (errLine?.slice(0, 200) ?? why ?? null),
    steps,
    calls,
    endHash: last,
    flushes,
    missingClasses: missingClassesFromLog(stderr.split('\n')),
    wallMs,
  };
}

/** What a run achieved of the script's three goals. */
export interface Progress {
  /** A settled plane (any `wait still` step, or the end) was visible: the disc reached a menu. */
  readonly menu: boolean;
  /** An arrow key changed the settled plane (step 2 against 0, or step 4 against 2), with a visible plane on one side. */
  readonly arrows: boolean;
  /** After `key ok`: a title change, a playlist other than the one playing before it, or a seek (a chapter). */
  readonly ok: boolean;
}

/** selectTitleN, a successful selectPlaylistN of a real playlist, or seekN: what starting something looks like. */
const isNav = (c: TraceEntry): boolean => c.call === 'selectTitleN' || c.call === 'seekN' || (c.call === 'selectPlaylistN' && c.ret === 1 && Number(c.args[0]) >= 0);

export function progress(r: RunRecord): Progress {
  const s = r.steps;
  const h = (i: number): string | null | undefined => s[i]?.hash;
  const menu = s.some((x) => x.animated || visible(x.hash)) || visible(r.endHash);
  // a real change: both steps ran with a settled plane, the planes differ, and one of them shows something. An animated
  // menu step has no settled plane, so after one only the second arrow (step 2 to 4) can count.
  const changed = (a: number, b: number): boolean => {
    const ha = h(a);
    const hb = h(b);
    return s.length > b && typeof ha === 'string' && typeof hb === 'string' && ha !== hb && (visible(ha) || visible(hb));
  };
  const arrows = menu && (changed(STEP.menu, STEP.afterRight) || changed(STEP.afterRight, STEP.afterDown));
  let ok = false;
  const okStep = s[STEP.ok];
  if (menu && okStep) {
    const before = r.calls.slice(0, okStep.calls).filter((c) => c.call === 'selectPlaylistN' && c.ret === 1 && Number(c.args[0]) >= 0).at(-1);
    ok = r.calls.slice(okStep.calls).some((c) => isNav(c) && !(c.call === 'selectPlaylistN' && before && c.args[0] === before.args[0]));
  }
  return { menu, arrows, ok };
}

const show = (c: TraceEntry | undefined): string => (c ? `${c.call}(${c.args.join(',')})=${String(c.ret)}` : '(none)');
const key = (c: TraceEntry): string => JSON.stringify([c.call, c.args, c.ret]);

/**
 * The distinct starting calls of a segment (isNav: selectPlaylistN of a real playlist, selectTitleN, seekN), as Ruling
 * R3 compares them. Everything else (registers, rates, UO masks, key interest) moves with the stub streams' timing.
 */
const navSet = (calls: readonly TraceEntry[]): Map<string, TraceEntry> => new Map(calls.filter(isNav).map((c) => [key(c), c]));

/** The first starting call one segment has and the other lacks, in words; null when the sets are equal. */
function setDiff(ours: readonly TraceEntry[], lib: readonly TraceEntry[]): string | null {
  const o = navSet(ours);
  const l = navSet(lib);
  const onlyL = [...l].find(([k]) => !o.has(k));
  if (onlyL) return `libbluray calls ${show(onlyL[1])}, ours does not`;
  const onlyO = [...o].find(([k]) => !l.has(k));
  return onlyO ? `ours calls ${show(onlyO[1])}, libbluray does not` : null;
}

/** The calls a run made before step i ran (since the step before it). */
const segment = (r: RunRecord, i: number): readonly TraceEntry[] => r.calls.slice(i === 0 ? 0 : r.steps[i - 1]!.calls, r.steps[i]!.calls);

/** Where two runs first differ (tools/bdj-library/README.md, Comparison). */
export interface Comparison {
  /** Same steps, settled hashes and starting calls. */
  readonly equal: boolean;
  /** libbluray's run, which ran fewer steps, agrees with ours on every step both ran and on what it did after. */
  readonly libPrefix: boolean;
  /** The first difference (null when equal). */
  readonly first: string | null;
  /** Ours stopped at an earlier step, agreeing with libbluray on every step both ran. */
  readonly oursShort?: boolean;
}

/**
 * Compares two runs of the generic script step by step (Ruling R3). Up to `key ok`: for each step both ran, the distinct
 * starting calls made since the step before, then its settled hash (not for an animated step). After `key ok`, where
 * the disc plays and the stub streams make each side loop at its own pace: the first starting call. When libbluray
 * stopped first, the starting calls it made after its last step must be among ours up to our next step (a prefix).
 */
export function compareRuns(ours: RunRecord, lib: RunRecord): Comparison {
  const n = Math.min(ours.steps.length, lib.steps.length);
  for (let i = 0; i < Math.min(n, STEP.ok + 1); i++) {
    const a = ours.steps[i]!;
    const b = lib.steps[i]!;
    const d = setDiff(segment(ours, i), segment(lib, i));
    if (d) return { equal: false, libPrefix: false, first: `step ${i} (${a.step}): ${d}` };
    // an animated menu (either side) has no settled plane: that it was visible is the whole check
    if (!a.animated && !b.animated && a.hash !== b.hash) return { equal: false, libPrefix: false, first: `step ${i} (${a.step}): settled plane libbluray ${b.hash ?? 'none'}, ours ${a.hash ?? 'none'}` };
  }
  if (n > STEP.ok) {
    const after = (r: RunRecord): TraceEntry | undefined => r.calls.slice(r.steps[STEP.ok]!.calls).find(isNav);
    const navO = after(ours);
    const navL = after(lib);
    if ((navO ? key(navO) : null) !== (navL ? key(navL) : null)) return { equal: false, libPrefix: false, first: `after key ok: libbluray starts ${show(navL)}, ours ${show(navO)}` };
    if (ours.steps.length > lib.steps.length) return { equal: false, libPrefix: true, first: `libbluray stops before step ${n} (${ours.steps[n]!.step}), ours goes on` };
    if (ours.steps.length < lib.steps.length) return { equal: false, libPrefix: false, oursShort: true, first: `ours stops before step ${n} (${lib.steps[n]!.step}), libbluray goes on` };
    return { equal: true, libPrefix: false, first: null };
  }
  const tail = (r: RunRecord): readonly TraceEntry[] => r.calls.slice(n === 0 ? 0 : r.steps[n - 1]!.calls);
  if (lib.steps.length < ours.steps.length) {
    const o = navSet(ours.calls.slice(n === 0 ? 0 : ours.steps[n - 1]!.calls, ours.steps[n]!.calls));
    const missing = [...navSet(tail(lib)).values()].find((c) => !o.has(key(c)));
    return missing
      ? { equal: false, libPrefix: false, first: `step ${n} (${ours.steps[n]!.step}): libbluray calls ${show(missing)}, ours does not` }
      : { equal: false, libPrefix: true, first: `libbluray stops before step ${n} (${ours.steps[n]!.step}), ours goes on` };
  }
  if (lib.steps.length > ours.steps.length) return { equal: false, libPrefix: false, oursShort: true, first: `ours stops before step ${n} (${lib.steps[n]!.step}), libbluray goes on` };
  const d = setDiff(tail(ours), tail(lib));
  if (d) return { equal: false, libPrefix: false, first: `after step ${n - 1}: ${d}` };
  // both timed out on the same `wait quiet` step: the plane kept flushing to the end on both sides (a wait quiet holds
  // after 1000 ms without a flush), so the planes they ended on are two frames of an animation, not a difference. A
  // `wait menu` that timed out held nothing visible, and its planes are still compared
  const quietStep = (i: number): boolean => i === STEP.afterRight || i === STEP.afterDown;
  const unsettled = ours.end === 'timeout' && lib.end === 'timeout' && ours.steps.length === lib.steps.length && quietStep(ours.steps.length);
  if (!unsettled && ours.endHash !== lib.endHash) return { equal: false, libPrefix: false, first: `end plane: libbluray ${lib.endHash ?? 'none'}, ours ${ours.endHash ?? 'none'}` };
  return { equal: true, libPrefix: false, first: null };
}

const UNSUPPORTED_VIDEO = /MPEG-2|VC-1/;

/** What a run failed at, in words. */
function shortfall(r: RunRecord): string {
  const p = progress(r);
  const stop = r.end === 'done' ? '' : `, stops at step ${r.steps.length}${r.end === 'timeout' ? ' (timeout)' : ` (${r.end})`}`;
  if (r.steps.length === 0) return `${!r.flushes ? 'draws nothing' : visible(r.endHash) ? 'never settles' : 'flushes, nothing visible'}${stop}`;
  if (!p.menu) return `no menu${stop}`;
  if (!p.arrows) return `arrows change nothing${stop}`;
  if (!p.ok) return `${r.steps.length <= STEP.ok ? 'ok never pressed' : 'ok starts nothing'}${stop}`;
  return `script ran${stop}`;
}

/**
 * Whether libbluray's run failed on its own: an error, crash or no output, or it never selected a playlist, or never
 * showed a visible plane.
 */
export function libFailed(lib: RunRecord): boolean {
  return (
    lib.end === 'error' ||
    lib.end === 'killed' ||
    lib.end === 'no-output' ||
    !lib.calls.some((c) => c.call === 'selectPlaylistN' && c.ret === 1 && Number(c.args[0]) >= 0) ||
    !progress(lib).menu
  );
}

/**
 * The keys of the script that changed nothing in either run (Ruling R5: a valid settled outcome when libbluray did the
 * same): `right` and `down` when the settled plane after the key equals the one before on both sides, `ok` when
 * neither run started anything after it. Only keys both runs pressed, with a settled plane on both sides around them.
 */
export function noReaction(ours: RunRecord, lib: RunRecord): string[] {
  const out: string[] = [];
  const same = (r: RunRecord, a: number, b: number): boolean | null => {
    const ha = r.steps[a]?.hash;
    const hb = r.steps[b]?.hash;
    return typeof ha === 'string' && typeof hb === 'string' ? ha === hb : null;
  };
  if (same(ours, STEP.menu, STEP.afterRight) === true && same(lib, STEP.menu, STEP.afterRight) === true) out.push('right');
  if (same(ours, STEP.afterRight, STEP.afterDown) === true && same(lib, STEP.afterRight, STEP.afterDown) === true) out.push('down');
  const okRan = (r: RunRecord): boolean => r.steps.length > STEP.ok;
  if (okRan(ours) && okRan(lib) && !progress(ours).ok && !progress(lib).ok) out.push('ok');
  return out;
}

const HARD = new Set<RunEnd>(['error', 'bdj-failed', 'killed', 'no-output']);

/**
 * Ruling R6: the script's key steps that are not confirmed, in words (none: every key confirmed). A key is confirmed
 * when both runs got past it (its settled step, or for ok its press) and so were compared, or when only ours did and
 * ours reacted to it (the arrow changed the settled plane; ok started something). A key ours never got past was not
 * tried.
 */
export function unconfirmedKeys(ours: RunRecord, lib: RunRecord): string[] {
  const out: string[] = [];
  const h = (i: number): string | null | undefined => ours.steps[i]?.hash;
  const reacted = (a: number, b: number): boolean => typeof h(a) === 'string' && typeof h(b) === 'string' && h(a) !== h(b);
  const keys = [
    { name: 'right', past: STEP.afterRight + 1, reacted: () => reacted(STEP.menu, STEP.afterRight) },
    { name: 'down', past: STEP.afterDown + 1, reacted: () => reacted(STEP.afterRight, STEP.afterDown) },
    { name: 'ok', past: STEP.ok + 1, reacted: () => progress(ours).ok },
  ];
  for (const k of keys) {
    if (ours.steps.length < k.past) out.push(`${k.name} not tried`);
    else if (lib.steps.length < k.past && !k.reacted()) out.push(`${k.name}: no reaction, libbluray never got there`);
  }
  return out;
}

/**
 * The verdict for a disc from our run and libbluray's (null: libbluray was not run). In order (Rulings R3, R5):
 *  - error: our run failed hard (error, BD-J failure, killed, no record), with the reason.
 *  - unconfirmed (Ruling R6): as works, but a key step was never compared and ours showed no reaction there, or a
 *    key was never tried (unconfirmedKeys); listed for a check by hand.
 *  - works: ours showed a visible menu and agrees with libbluray on every step both ran (settled planes and starting
 *    calls): the runs are equal, or libbluray stopped earlier (stub streams) and its run is a prefix of ours. A key
 *    that changed nothing on both sides is a valid outcome, noted "no reaction to <key>"; arrows and ok are required
 *    only as far as libbluray shows them (a reaction on one side only is a difference). Without a libbluray run, ours
 *    alone decides: menu, arrows and ok ("not compared").
 *  - missing-class: Java lacked a platform class, native (`native: ...`) or platform method (`method: ...`), the first
 *    one named, whatever libbluray did (with stub streams it often gets no further, which the detail says). A class
 *    the platform looked up and always caught itself is not counted (countedGaps, Ruling R13).
 *  - unsupported-video: a playlist with MPEG-2 or VC-1 video was refused (the same).
 *  - libbluray-fails-too: libbluray failed on its own (libFailed) and ours showed no menu either.
 *  - stall: ours never showed a menu, or stopped at an earlier step than libbluray.
 *  - diverges: otherwise, with the first difference (a reaction to a key on one side only, another settled plane, other
 *    starting calls, or a libbluray run that never selects a playlist where ours does).
 */
export function classify(ours: RunRecord, lib: RunRecord | null): { verdict: DiscVerdict; detail: string } {
  const p = progress(ours);
  if (HARD.has(ours.end)) return { verdict: 'error', detail: `${ours.end}${ours.endDetail ? `: ${ours.endDetail}` : ''}` };
  const cmp = lib ? compareRuns(ours, lib) : null;
  if (!lib && p.menu && p.arrows && p.ok) return { verdict: 'works', detail: 'not compared: no libbluray run' };
  if (lib && p.menu && (cmp?.equal || cmp?.libPrefix)) {
    const quiet = noReaction(ours, lib);
    const note = quiet.length ? `; no reaction to ${quiet.join(', ')} (libbluray neither)` : '';
    const how = cmp.equal ? 'same as libbluray' : `libbluray stopped early (stub): ${shortfall(lib)}`;
    const open = unconfirmedKeys(ours, lib);
    if (open.length) return { verdict: 'unconfirmed', detail: `${open.join('; ')} (${how})` };
    return { verdict: 'works', detail: `${how}${note}` };
  }
  // a class ours lacks or a video codec ours refuses is ours to fix whatever libbluray does with stub streams
  const libToo = lib && libFailed(lib) ? `; libbluray (stub) also: ${shortfall(lib)}` : '';
  const gaps = countedGaps(ours);
  if (gaps.length) {
    const more = gaps.length > 1 ? ` (+${gaps.length - 1} more)` : '';
    return { verdict: 'missing-class', detail: `${gaps[0]}${more}${libToo}` };
  }
  const refused = ours.rejectedPlaylists.find((r) => r.video !== null && UNSUPPORTED_VIDEO.test(r.video));
  if (refused) return { verdict: 'unsupported-video', detail: `playlist ${refused.playlist} (${refused.video}) refused${libToo}` };
  if (!p.menu && lib && libFailed(lib)) {
    const noPlaylist = lib.calls.some((c) => c.call === 'selectPlaylistN' && c.ret === 1) ? '' : ', selects no playlist';
    return { verdict: 'libbluray-fails-too', detail: `libbluray: ${shortfall(lib)}${noPlaylist}; ours: ${shortfall(ours)}` };
  }
  const libSteps = lib?.steps.length ?? Infinity;
  // ours stopped first, agreeing as far as both went (a difference at a common step is diverges)
  if (!p.menu || (ours.end !== 'done' && ours.steps.length < libSteps && (!cmp || cmp.oursShort))) {
    const theirs = lib ? `; libbluray reaches step ${lib.steps.length}${lib.end === 'done' ? ' (done)' : ''}` : '';
    return { verdict: 'stall', detail: `ours: ${shortfall(ours)}${theirs}` };
  }
  return { verdict: 'diverges', detail: cmp?.first ?? `no libbluray run; ours: ${shortfall(ours)}` };
}
