import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRing, renderQuantum, ringViews } from '@seikou/engine/audio/ring';
import { registerClassLibraryIntrinsics } from '../../src/bdj-classlib/intrinsics/index';
import { runBdjWorker, type BdjPort, type BdjWorkerHandle } from '../../src/bdj/bdj-worker';
import { GraphicsPlaneReader, GraphicsPlaneWriter, planeHash } from '../../src/bdj/graphics-plane';
import type { TraceEntry } from '../../src/bdj/host';
import type { ClassLibrarySource } from '../../src/bdj/runtime';
import { seikouBdjProvider } from '../../src/bdj/provider';
import { MemoryBdjStore, type BdjStore } from '../../src/bdj/store/bdj-store';
import type { WorkerLike } from '../../src/bdj/session';
import type { BdjCallName, BdjWireValue, FromBdj, ToBdj } from '../../src/bdj/worker-protocol';
import { createAudioDecoderFactory } from '@seikou/engine/decode/audio-decoder';
import { Player } from '@seikou/engine/player';
import type { CompositorLike } from '@seikou/engine/render/compositor';
import type { DecodeImage } from '../../src/bdj/background';
import type { EngineEvent } from '@seikou/engine/protocol';
import type { MemoryProfileName } from '@seikou/engine/memory-profile';
import { fakeVideoCodecApi } from '../helpers/fake-video-decoder';
import { directoryEntries } from '../helpers/file-blob';
import { HARNESS_SETTINGS } from './replay';
import { testBdjFonts } from '../helpers/bdj-fonts';
import type { KeyStep, SettledStep } from './key-script';

const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../src/bdj-classlib/${name}`, import.meta.url))));

/** `wait menu`: how long a visible plane may go on flushing before the step holds anyway (bdj_trace.c MENU_ANIMATED_S). */
const MENU_ANIMATED_MS = 30_000;

/** One virtual-clock step: 5 render quanta of 128 frames at 48 kHz. */
const STEP_MS = 640 / 48;

/**
 * A turn of the replay loop takes milliseconds; one this long means the run did not go on as it measures it. Node's
 * clock on macOS counts the time the host is asleep, so after a sleep every wait and timeout in the run has expired at
 * once (Task 7e: the ~1,000 s "hangs" were lid-closed sleeps). Under heavy load the longest turn seen was far below this.
 */
export const LOOP_GAP_MS = 20_000;

/**
 * Why a gap of `gapMs` between two turns of the replay loop, in which the process used `cpuMs` of CPU, voids the run;
 * null for a gap under LOOP_GAP_MS. Little CPU: the process did not run (host sleep, or starved); busy: our own code
 * held the event loop, which is a bug.
 */
export function loopGap(gapMs: number, cpuMs: number): string | null {
  if (gapMs < LOOP_GAP_MS) return null;
  const s = (ms: number, digits: number): string => (ms / 1000).toFixed(digits);
  return cpuMs < gapMs / 2
    ? `the process did not run for ${s(gapMs, 0)} s (${s(cpuMs, 2)} s of CPU): the host slept or was starved; the run is void`
    : `the event loop was blocked for ${s(gapMs, 0)} s (${s(cpuMs, 1)} s of CPU): synchronous work held it`;
}

/** What the loop-gap check reads at each turn of the replay loop: the time and this process's CPU time, in ms. */
export interface LoopClock {
  readonly nowMs: () => number;
  readonly cpuMs: () => number;
}

const processLoopClock: LoopClock = {
  nowMs: () => performance.now(),
  cpuMs: () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  },
};

export interface PlayerBdjReplay {
  /** Java's calls that the engine answered, in reply order, in trace.patch's format. */
  readonly trace: TraceEntry[];
  /** Wall time from the open command to Java's first selectPlaylist reaching the engine. */
  readonly firstPlaylistMs: number;
  /** Wall time from the open command to the reply that ended the run. */
  readonly untilMs: number;
  /** Virtual (player clock) time from the open command to the end of the run. */
  readonly virtualMs: number;
  /** Everything the player emitted up to the end of the run (not the close that follows). */
  readonly events: readonly EngineEvent[];
  /** The graphics plane of the last BD-J worker started, as the engine reads it. */
  readonly plane: GraphicsPlaneReader | null;
  /** With a script: the plane hash at every flush, in order (tools/bdj-trace's `{"plane":"flush"}` lines). */
  readonly flushes: readonly string[];
  /** With a script: each step as it ran, a `wait still` step with the hash of the plane it settled on. */
  readonly steps: readonly SettledStep[];
  /** With a script: how many calls had been traced when each step ran (steps[i] ran after trace[0..stepCalls[i]]). */
  readonly stepCalls: readonly number[];
}

/** Records the plane's hash at every flush of every GraphicsPlaneWriter (the BD-J worker runs in process) until undone. */
function hookFlushes(record: (hash: string) => void): () => void {
  const proto = GraphicsPlaneWriter.prototype;
  const flush = proto.flush;
  proto.flush = function (this: GraphicsPlaneWriter): void {
    flush.call(this);
    record(planeHash(this.buffer)); // the writer holds the plane's lock here
  };
  return () => {
    proto.flush = flush;
  };
}

/** sixDigits: %.6g of a Java float, as trace.patch prints selectRateN's rate. */
const sixDigits = (v: number): number => Number(v.toPrecision(6));

/** A call and the engine's reply as tools/bdj-trace/trace.patch prints the native: `<name>N`, Java ints signed. */
export function traceEntryOf(name: BdjCallName, args: readonly BdjWireValue[], value: number | string): TraceEntry {
  const call = `${name}N`;
  switch (name) {
    case 'selectRate':
      return { call, args: [sixDigits(Number(args[0])), args[1]!], ret: Number(value) | 0 };
    case 'writeReg':
      return { call, args: args.map((a) => Number(a) | 0), ret: Number(value) | 0 };
    case 'seek':
      return { call, args: [...args], ret: String(value) };
    case 'setUOMask':
    case 'setKeyInterest':
      return { call, args: [...args], ret: null };
    default:
      return { call, args: [...args], ret: Number(value) | 0 };
  }
}

/**
 * Two ends of an in-process channel between the engine and runBdjWorker: messages are delivered by reference (the
 * disc's Blob stand-ins for clips over 4 GiB cannot be cloned) on a later macrotask, in order, as a MessagePort does.
 */
function inProcessWorker(onToBdj: (m: ToBdj) => void, onFromBdj: (m: FromBdj) => void, onHandle: (h: BdjWorkerHandle) => void, store: BdjStore): WorkerLike {
  let closed = false;
  let handle: BdjWorkerHandle | null = null;
  const port: BdjPort = {
    onmessage: null,
    postMessage: (m) =>
      setImmediate(() => {
        if (closed) return;
        onFromBdj(m);
        worker.onmessage?.({ data: m } as MessageEvent<FromBdj>);
      }),
  };
  const worker: WorkerLike = {
    onmessage: null,
    postMessage: (m) => {
      onToBdj(m);
      setImmediate(() => {
        if (!closed) port.onmessage?.({ data: m });
      });
    },
    terminate: () => {
      closed = true;
      handle?.runtime?.jvm.threads.halt();
    },
  };
  handle = runBdjWorker(port, { extraIntrinsics: registerClassLibraryIntrinsics, ...testBdjFonts, createStore: () => store });
  onHandle(handle);
  return worker;
}

/**
 * Opens a disc directory in the real Player (fake video decoders, no compressed audio decoders, LPCM played through
 * a render loop), with BD-J in an in-process runBdjWorker and the bdj-trace harness's player settings. The player's
 * clock is virtual and runs ahead in steps as fast as the engine keeps up, so playlists end through the player's own
 * end-of-playlist path in a fraction of their duration. Records Java's calls as the engine replies to them and stops
 * after the `occurrence`-th reply to `until` (a trace name such as selectPlaylistN), or, with `untilPlane`, once it
 * returns true for the graphics plane (checked after every step). With `script` (tools/bdj-trace's key scripts), the
 * steps run as the harness runs them, in wall time (`wait still`) and on the player's events (`wait playlist`: a
 * `chapters` event), keys and clicks going in as the UI sends them (menuKey, pointer), and the player's clock kept to
 * wall time, as libbluray's reads are; the run then ends only once the script has finished too. A thrown Error carries what was recorded so far as `trace`, `steps`, `flushes` and `events`.
 */
export async function replayPlayerBdj(
  discDir: URL | string,
  opts: {
    until: string;
    occurrence?: number;
    timeoutMs?: number;
    log?: (line: string) => void;
    classLibrary?: ClassLibrarySource;
    untilPlane?: (plane: GraphicsPlaneReader) => boolean;
    /** Also ends the run once it returns true for the calls traced so far (checked after each reply). */
    untilTrace?: (trace: readonly TraceEntry[]) => boolean;
    /** Once the run would end, go on this long (wall time), still tracing, so calls past the end show up. */
    tailMs?: number;
    /** The player's compositor (default: one that draws nothing). */
    compositor?: CompositorLike;
    /** The BD-J provider's decodeImage, for background stills (default: none, so none are shown). */
    decodeImage?: DecodeImage;
    /** A key script to replay (key-script.ts), with the plane hashed at every flush. */
    script?: readonly KeyStep[];
    /** How long a script step may wait (default 60 s, the harness's --wait-timeout in golden.sh). */
    stepTimeoutMs?: number;
    /** The memory profile the player runs under (setMemoryProfile before the open; default the player's, desktop). */
    memoryProfile?: MemoryProfileName;
    /** Called once the run has ended, before the player closes, with the player and the last BD-J worker started. */
    beforeClose?: (player: Player, worker: BdjWorkerHandle | null) => void | Promise<void>;
    /** The loop-gap check's clock (default: performance.now and process.cpuUsage); tests inject one. */
    loopClock?: LoopClock;
    /** The disc's saved data (default: a new, empty one, as in a browser that never played it); a test passes one store to several runs as to several viewings. */
    store?: BdjStore;
  },
): Promise<PlayerBdjReplay> {
  const dir = typeof discDir === 'string' ? discDir : fileURLToPath(discDir);
  const occurrence = opts.occurrence ?? 1;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const classes: ClassLibrarySource = opts.classLibrary ?? {
    rt: jar('rt-bdj.jar'),
    libbluray: jar('libbluray-j2se.jar'),
    libblurayAwt: jar('libbluray-awt-j2se.jar'),
  };
  const trace: TraceEntry[] = [];
  const calls = new Map<number, { name: BdjCallName; args: readonly BdjWireValue[] }>();
  const events: EngineEvent[] = [];
  const clock = { ms: 1000 };
  let seen = 0;
  let done = false;
  /** Tracing stops at `done`, or, with a tail, when the tail is over. */
  let traced = false;
  let firstPlaylistAt: number | null = null;
  let t0 = 0;
  let plane: GraphicsPlaneReader | null = null;
  const script = opts.script ?? [];
  const stepTimeoutMs = opts.stepTimeoutMs ?? 60_000;
  const flushes: string[] = [];
  const steps: SettledStep[] = [];
  const stepCalls: number[] = [];
  let lastFlushAt = 0;
  /** Since when the flushed plane has been visible (null: it is not), for `wait menu`. */
  let visibleSince: number | null = null;
  let stepIdx = 0;
  let stepFrom = { events: 0, flushes: 0, at: 0 };
  let lastWorker: BdjWorkerHandle | null = null;

  const onFromBdj = (m: FromBdj): void => {
    if (m.type !== 'call') return;
    calls.set(m.id, { name: m.name, args: m.args });
    if (m.name === 'selectPlaylist' && firstPlaylistAt === null) firstPlaylistAt = performance.now();
  };
  const onToBdj = (m: ToBdj): void => {
    if (m.type === 'boot') plane = new GraphicsPlaneReader(m.plane);
    if (m.type !== 'reply' || traced) return;
    const c = calls.get(m.id);
    if (!c) return;
    calls.delete(m.id);
    const e = traceEntryOf(c.name, c.args, m.value);
    trace.push(e);
    if ((e.call === opts.until && ++seen >= occurrence) || opts.untilTrace?.(trace)) {
      done = true;
      if (!opts.tailMs) traced = true;
    }
  };

  // the disc's saved data, empty at first as in a browser that never played it, and kept across its BD-J workers
  const store = opts.store ?? new MemoryBdjStore();
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeVideoCodecApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm in the replay'))),
    createCompositor: () => opts.compositor ?? { resize: () => undefined, drawVideo: () => undefined },
    // the replay has its own timeout; the first-playlist timer would measure the virtual clock's real-time steps
    setTimer: () => () => undefined,
    bdj: seikouBdjProvider({
      missing: [],
      createWorker: () =>
        inProcessWorker(
          onToBdj,
          onFromBdj,
          (h) => {
            lastWorker = h;
          },
          store,
        ),
      loadClassLibrary: async () => classes,
      ...(opts.decodeImage ? { decodeImage: opts.decodeImage } : {}),
    }),
    bdjLog: opts.log ? (line) => opts.log!(line) : undefined,
    playerSettings: HARNESS_SETTINGS,
  });
  const fail = (why: string): Error =>
    Object.assign(new Error(`replayPlayerBdj: ${why} before ${opts.until}#${occurrence} (${trace.length} calls traced)`), {
      trace: [...trace],
      steps: [...steps],
      stepCalls: [...stepCalls],
      flushes: [...flushes],
      events: [...events],
      threadDump: (lastWorker as BdjWorkerHandle | null)?.runtime?.threadDump() ?? [],
    });
  /** Runs the script's steps from the current one while their waits hold (bdj_trace.c's step loop). */
  const runSteps = async (): Promise<void> => {
    while (stepIdx < script.length) {
      const s = script[stepIdx]!;
      // where the next step's waits count from: a key or click is sent at once, so what it causes, even while it is
      // being handed over, belongs to the next step (bdj_trace.c takes step_flushes before running a step's input)
      const mark = { events: events.length, flushes: flushes.length, at: performance.now() };
      let held = true;
      let animated = false;
      switch (s.kind) {
        case 'waitFlush':
          held = flushes.length >= s.n;
          break;
        case 'waitStill':
          held = flushes.length > stepFrom.flushes && performance.now() - lastFlushAt >= s.ms;
          break;
        case 'waitQuiet':
          // bdj_trace.c's plane_quiet: no flush for ms since the later of the last flush and the step's start
          held = performance.now() - Math.max(lastFlushAt, stepFrom.at) >= s.ms;
          break;
        case 'waitMenu': {
          // bdj_trace.c's plane_menu: visible and still for ms, or visible for 30 s while flushing on (animated)
          if (!plane?.visible()) visibleSince = null; // an init or close clears the plane without a flush
          const visible = visibleSince !== null;
          const still = visible && performance.now() - lastFlushAt >= s.ms;
          animated = !still && visible && performance.now() - visibleSince! >= MENU_ANIMATED_MS;
          held = still || animated;
          break;
        }
        case 'waitPlaylist':
          held = events.slice(stepFrom.events).some((e) => e.type === 'chapters' && (s.playlist === null || Number(e.playlistId) === s.playlist));
          break;
        case 'key':
          await player.handle({ type: 'menuKey', key: s.key });
          break;
        case 'pointer':
          await player.handle({ type: 'pointer', kind: s.click ? 'click' : 'move', x: s.x, y: s.y });
          break;
      }
      if (!held) {
        if (performance.now() - stepFrom.at > stepTimeoutMs) throw fail(`script step ${stepIdx} "${s.text}" did not hold within ${stepTimeoutMs} ms`);
        return;
      }
      stepCalls.push(trace.length);
      steps.push({
        script: 'step',
        n: stepIdx,
        step: s.text,
        // an animated menu has no settled plane: only that it was visible counts (tools/bdj-library/README.md)
        ...(animated ? { animated: true as const } : s.kind === 'waitStill' || s.kind === 'waitMenu' || s.kind === 'waitQuiet' ? { hash: flushes.at(-1) ?? null } : {}),
      });
      stepIdx++;
      stepFrom = s.kind === 'key' || s.kind === 'pointer' ? mark : { events: events.length, flushes: flushes.length, at: performance.now() };
    }
  };
  const unhook = script.length
    ? hookFlushes((hash) => {
        flushes.push(hash);
        lastFlushAt = performance.now();
        // the hook runs after the writer published the flush, so the reader's flag is this flush's
        if (!plane?.visible()) visibleSince = null;
        else visibleSince ??= lastFlushAt;
      })
    : () => undefined;
  try {
    const ring = createRing(48_000, 2);
    const views = ringViews(ring);
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    if (opts.memoryProfile) await player.handle({ type: 'setMemoryProfile', profile: opts.memoryProfile });
    await player.handle({ type: 'attachAudio', ring });
    await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
    const start = clock.ms;
    t0 = performance.now();
    stepFrom = { events: 0, flushes: 0, at: t0 };
    await player.handle({ type: 'open', disc: { kind: 'files', entries: await directoryEntries(dir) } });
    let tailFrom: number | null = null;
    const loopClock = opts.loopClock ?? processLoopClock;
    let turn = { at: loopClock.nowMs(), cpu: loopClock.cpuMs() };
    for (;;) {
      // before any wait or timeout is judged: after a host sleep they have all expired, and none of them is the cause
      const next = { at: loopClock.nowMs(), cpu: loopClock.cpuMs() };
      const gap = loopGap(next.at - turn.at, next.cpu - turn.cpu);
      if (gap) throw fail(gap);
      turn = next;
      if (done && stepIdx >= script.length) {
        tailFrom ??= performance.now();
        if (performance.now() - tailFrom >= (opts.tailMs ?? 0)) break;
      }
      if (performance.now() - t0 > timeoutMs) throw fail(`timed out after ${timeoutMs} ms`);
      const failed = events.find((e) => e.type === 'notice' && e.code === 'bdj-failed');
      if (failed?.type === 'notice') throw fail(`BD-J failed (${failed.message})`);
      if (events.some((e) => e.type === 'state' && e.state === 'error')) throw fail('the player failed');
      // a script runs in wall time, as the harness reads in real time: the player's clock must not run ahead of it
      if (!script.length || clock.ms - start <= performance.now() - t0) {
        clock.ms += STEP_MS;
        for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
      }
      player.tick();
      await new Promise((r) => setTimeout(r, 1));
      if (opts.untilPlane && plane && opts.untilPlane(plane)) done = true;
      await runSteps();
    }
    traced = true;
    const end = performance.now();
    await opts.beforeClose?.(player, lastWorker);
    return {
      trace,
      firstPlaylistMs: (firstPlaylistAt ?? end) - t0,
      untilMs: end - t0,
      virtualMs: clock.ms - start,
      events: [...events], // before the close in finally
      plane,
      flushes: [...flushes],
      steps: [...steps],
      stepCalls: [...stepCalls],
    };
  } finally {
    await player.handle({ type: 'close' });
    unhook();
  }
}
