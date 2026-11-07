import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { directoryEntries } from '../helpers/file-blob';
import { normalizeDiscPaths } from '@seikou/engine/disc/paths';
import { FileSource } from '@seikou/engine/disc/file-source';
import { loadClips, openDisc, readBdid } from '@seikou/engine/disc/open-disc';
import { RecordingHost } from '../../src/bdj/host';
import { applyPlayerSettings, type PlayerSettings } from '@seikou/engine/disc/player-settings';
import type { RegisterFile } from '@seikou/engine/hdmv/registers';
import type { BdjHost, TraceEntry } from '../../src/bdj/host';
import { BdjRuntime } from '../../src/bdj/runtime';
import { testBdjFonts } from '../helpers/bdj-fonts';

const FIRST_PLAY = 0xffff;
const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../src/bdj-classlib/${name}`, import.meta.url))));

/** tools/bdj-trace/bdj_trace.c's bd_set_player_setting_str calls before bd_play: country us, languages eng. */
export const HARNESS_SETTINGS: PlayerSettings = { audioLanguage: 'eng', pgLanguage: 'eng', menuLanguage: 'eng', country: 'us' };

export function applyHarnessSettings(registers: RegisterFile): void {
  applyPlayerSettings(registers, HARNESS_SETTINGS);
}

export interface BdjReplay {
  readonly trace: TraceEntry[];
  readonly bootMs: number;
  readonly untilMs: number;
}

/**
 * Boots the BD-J stack on a disc directory, starts First Play and runs until a trace entry with call name `until`
 * (or until idle), on the real clock so multi-second local-disc runs behave as on a device. `log` receives the
 * runtime's log (bdj_process_event lines, Logger.logN lines and Java's stdout/stderr). A thrown Error carries the
 * trace recorded so far as `trace`. `wrapHost` gives the natives another host over the recording one.
 */
export async function replayBdj(
  discDir: URL | string,
  opts: { until?: string; timeoutMs?: number; log?: (line: string) => void; wrapHost?: (host: RecordingHost) => BdjHost } = {},
): Promise<BdjReplay> {
  const dir = typeof discDir === 'string' ? discDir : fileURLToPath(discDir);
  const source = new FileSource(normalizeDiscPaths(await directoryEntries(dir)));
  const disc = await openDisc(source);
  const clips = await loadClips(source, [...new Set([...disc.playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)))]);
  let host: RecordingHost | null = null;
  const rt = new BdjRuntime({
    disc: source,
    discId: (await readBdid(source))?.discId ?? null,
    classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
    host: (startTitle, onTrace) => {
      host = new RecordingHost(disc, clips, { startTitle, onTrace });
      applyHarnessSettings(host.registers);
      return opts.wrapHost ? opts.wrapHost(host) : host;
    },
    nowMs: () => Date.now(),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    log: opts.log ?? (() => {}),
    fonts: testBdjFonts,
  });
  const ac = new AbortController();
  let booted = false;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timeout = setTimeout(() => {
    ac.abort();
    if (!booted) rt.jvm.threads.halt();
  }, timeoutMs);
  const traced = (): TraceEntry[] => [...((host as RecordingHost | null)?.trace ?? [])];
  const calls = (): number => traced().length;
  try {
    const t0 = performance.now();
    const bootTimeout = (cause: string): Error => new Error(`replayBdj: boot timed out after ${timeoutMs} ms${cause}`);
    try {
      await rt.boot();
    } catch (e) {
      if (ac.signal.aborted) throw bootTimeout(` (${String(e)})`);
      throw e;
    }
    if (ac.signal.aborted) throw bootTimeout('');
    booted = true;
    const bootMs = performance.now() - t0;
    rt.start(FIRST_PLAY);
    const until = opts.until;
    const outcome = await rt.run(until === undefined ? { signal: ac.signal } : { signal: ac.signal, until: (e) => e.call === until });
    if (until !== undefined && outcome !== 'until') {
      throw new Error(
        `replayBdj: run ended '${outcome}' before ${until} (timed out: ${ac.signal.aborted}, exit status ${rt.exitStatus ?? 'none'}, ${calls()} calls traced)`,
      );
    }
    return { trace: traced(), bootMs, untilMs: performance.now() - t0 };
  } catch (e) {
    // the trace so far, for a caller that compares it (tests/bdj/run.ts)
    if (e instanceof Error) Object.assign(e, { trace: traced() });
    throw e;
  } finally {
    clearTimeout(timeout);
    rt.jvm.threads.halt();
  }
}
