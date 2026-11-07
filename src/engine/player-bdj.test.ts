import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeNas } from '../../tests/helpers/fake-nas';
import { fakeVideoCodecApi } from '../../tests/helpers/fake-video-decoder';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { VirtualClock, storedZip } from '../../tests/helpers/jvm-asm';
import { asm, buildMovieObjects, imm, psr, reg } from '../../tests/helpers/hdmv-builders';
import { buildSyntheticDisc, discEntries, lpcmStream, syntheticClip, type SyntheticDiscSpec } from '../../tests/helpers/synthetic-disc';
import { createRing, renderQuantum, ringViews } from './audio/ring';
import { runBdjWorker } from './bdj/bdj-worker';
import { ZipArchive } from './bdj/jvm/zip';
import { BdjEvent, type ClassLibrarySource } from './bdj/runtime';
import { DUMP_WAIT_MS, type WorkerLike } from './bdj/session';
import type { FromBdj, ToBdj } from './bdj/worker-protocol';
import type { DecodeImage } from './bdj/background';
import { SharedRegisterView } from './bdj/shared-registers';
import { seikouBdjProvider } from './bdj/provider';
import type { DiscSpec, RemoteDiscSpec } from './disc/disc-spec';
import type { PlayerSettings } from './disc/player-settings';
import { serveFetch } from './disc/port-fetch';
import { CodingType } from '@seikou/bdmv/stream-types';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import { Player } from './player';
import { MEMORY_PROFILES, type MemoryProfileName } from './memory-profile';
import type { CompositorLike } from './render/compositor';
import { GraphicsPlaneReader, GraphicsPlaneWriter, updateGraphic } from './bdj/graphics-plane';
import { BDJ_STORAGE_MESSAGE, NO_PICTURE_MESSAGE, type EngineEvent, type PlaybackState, type StartPoint, type Telemetry } from './protocol';

const file = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const CLASSES: ClassLibrarySource = {
  rt: file('../bdj-classlib/rt-bdj.jar'),
  libbluray: file('../bdj-classlib/libbluray-j2se.jar'),
  libblurayAwt: file('../bdj-classlib/libbluray-awt-j2se.jar'),
};
const STEP_MS = 640 / 48;
const START = 1;
/** UO mask table: time search, skip to next / previous point (byte 0) and pause on (byte 1). */
const PLAYBACK_MASKED = [0x1c, 0x80, 0, 0, 0, 0, 0, 0];

/** disc-bdj's index, BD-J objects, jar and certificates over synthetic clips and playlists. */
function bdjDisc(spec: Partial<SyntheticDiscSpec> = {}): Map<string, Uint8Array<ArrayBuffer>> {
  const files = buildSyntheticDisc({
    clips: [
      syntheticClip('00000', 4, { audioStreams: [lpcmStream(0x1100, 4, { lang: 'eng' }), lpcmStream(0x1101, 4, { lang: 'fra' })] }),
      syntheticClip('00001', 4, { audio: CodingType.LPCM }),
    ],
    playlists: [
      { id: '00000', clipIds: ['00000'], chapterEverySeconds: 1, uoMask: PLAYBACK_MASKED },
      { id: '00001', clipIds: ['00001'], chapterEverySeconds: 1 },
    ],
    ...spec,
  });
  const fixture = fixtureDiscFiles('disc-bdj');
  for (const [path, bytes] of fixture) {
    if (path.startsWith('BDMV/BDJO/') || path.startsWith('BDMV/JAR/') || path.startsWith('CERTIFICATE/')) files.set(path, bytes);
    if (path === 'BDMV/index.bdmv' && !spec.index) files.set(path, bytes);
  }
  return files;
}

interface Harness {
  readonly player: Player;
  readonly events: EngineEvent[];
  /** Everything the engine sent to the BD-J worker. */
  readonly sent: ToBdj[];
  readonly terminated: () => boolean;
  /** How many BD-J workers the player created. */
  readonly workers: () => number;
  /** Paths read from the fake NAS (remote harness only). */
  readonly requested: readonly string[];
  /** The workers' own fetch on the port route, which must go unused. */
  readonly ownFetch: ReturnType<typeof vi.fn>;
  /** Delivers a message to the engine as if the BD-J worker had sent it. */
  inject(m: FromBdj): void;
  play(ms: number): Promise<void>;
}

const players: Player[] = [];
/** The fetch ports' serving ends. */
const servedPorts: MessagePort[] = [];
afterEach(async () => {
  for (const p of players.splice(0)) await p.handle({ type: 'close' });
  for (const port of servedPorts.splice(0)) port.close();
});

interface HarnessOptions {
  readonly classes?: ClassLibrarySource;
  /** A worker the test drives by hand instead of the in-process one. */
  readonly worker?: WorkerLike;
  readonly setTimer?: (ms: number, fn: () => void) => () => void;
  /** PlayerDeps.wallMs: the BD-J start-up timeout's clock (a VirtualClock's nowMs with its setTimer). */
  readonly wallMs?: () => number;
  readonly playerSettings?: PlayerSettings;
  readonly compositor?: CompositorLike;
  readonly decodeImage?: DecodeImage;
  readonly bdjMissing?: readonly string[];
  readonly planeHashTelemetry?: boolean;
  readonly memoryProfile?: MemoryProfileName;
  readonly memoryTelemetry?: boolean;
  /**
   * Serve the disc from a fake NAS: the engine and the BD-J worker read it by HTTP range reads. `'port'`: through a
   * fetch port, as on the WebRTC route; neither worker's own fetch may be used.
   */
  readonly remote?: boolean | 'port';
  /** Open the NAS disc with this spec in place of the fake NAS's own (a quality level's, say). */
  readonly remoteSpec?: (spec: RemoteDiscSpec) => RemoteDiscSpec;
  /** Open the disc at this place. */
  readonly start?: StartPoint;
}

async function harness(files: Map<string, Uint8Array<ArrayBuffer>>, opts: HarnessOptions = {}): Promise<Harness> {
  const classes = opts.classes ?? CLASSES;
  const events: EngineEvent[] = [];
  const sent: ToBdj[] = [];
  let terminated = false;
  let workers = 0;
  let toEngine: MessagePort | null = null;
  const clock = { ms: 1000 };
  const nas = opts.remote ? fakeNas(files) : null;
  /** On the port route, the workers' own fetch: never called. */
  const ownFetch = vi.fn(async () => {
    throw new TypeError('fetched directly');
  });
  const workerFetch = opts.remote === 'port' ? (ownFetch as unknown as typeof fetch) : nas?.fetch;
  let spec: DiscSpec | null = nas ? (opts.remoteSpec?.(nas.spec) ?? nas.spec) : null;
  if (nas && opts.remote === 'port') {
    const { port1, port2 } = new MessageChannel();
    serveFetch(port1, nas.fetch);
    servedPorts.push(port1);
    spec = { ...nas.spec, fetchPort: port2 };
  }
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeVideoCodecApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
    createCompositor: () => opts.compositor ?? { resize: () => undefined, drawVideo: () => undefined },
    setTimer: opts.setTimer ?? (() => () => undefined),
    ...(opts.wallMs ? { wallMs: opts.wallMs } : {}),
    bdj: seikouBdjProvider({
      missing: opts.bdjMissing ?? [],
      createWorker: () => {
        workers++;
        if (opts.worker) return opts.worker;
        const { port1, port2 } = new MessageChannel();
        runBdjWorker(port2 as unknown as Parameters<typeof runBdjWorker>[0], workerFetch ? { fetch: workerFetch } : {});
        toEngine = port2;
        const worker: WorkerLike = {
          postMessage: (m: ToBdj, transfer: Transferable[] = []) => {
            sent.push(m);
            port1.postMessage(m, transfer as never);
          },
          set onmessage(fn: ((e: MessageEvent<FromBdj>) => void) | null) {
            port1.onmessage = fn as ((e: MessageEvent) => void) | null;
          },
          get onmessage() {
            return port1.onmessage as ((e: MessageEvent<FromBdj>) => void) | null;
          },
          terminate: () => {
            terminated = true;
            port1.close();
            port2.close();
          },
        };
        return worker;
      },
      loadClassLibrary: async () => classes,
      ...(opts.decodeImage ? { decodeImage: opts.decodeImage } : {}),
    }),
    ...(opts.playerSettings ? { playerSettings: opts.playerSettings } : {}),
    ...(opts.planeHashTelemetry ? { planeHashTelemetry: true } : {}),
    ...(opts.memoryTelemetry ? { memoryTelemetry: true } : {}),
    ...(workerFetch ? { fetch: workerFetch } : {}),
  });
  players.push(player);
  const ring = createRing(48_000, 2);
  const views = ringViews(ring);
  if (opts.memoryProfile) await player.handle({ type: 'setMemoryProfile', profile: opts.memoryProfile });
  await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  await player.handle({ type: 'open', disc: spec ?? { kind: 'files', entries: discEntries(files) }, ...(opts.start ? { start: opts.start } : {}) });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    events,
    sent,
    terminated: () => terminated,
    workers: () => workers,
    requested: nas?.requested ?? [],
    ownFetch,
    inject: (m) => toEngine!.postMessage(m),
    async play(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
        player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

/** A BD-J worker the test drives by hand. */
function handWorker(): { readonly worker: WorkerLike; readonly sent: ToBdj[]; emit(m: FromBdj): void; readonly terminated: () => boolean } {
  const sent: ToBdj[] = [];
  let terminated = false;
  const worker: WorkerLike = { postMessage: (m) => void sent.push(m), onmessage: null, terminate: () => void (terminated = true) };
  return { worker, sent, emit: (m) => worker.onmessage?.({ data: m } as MessageEvent<FromBdj>), terminated: () => terminated };
}

const lastState = (h: Harness): PlaybackState | undefined => h.events.flatMap((e) => (e.type === 'state' ? [e.state] : [])).at(-1);
const notices = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'notice' ? [e.code] : []));
const playlistsPlayed = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : []));
const lastTelemetry = (h: Harness): Telemetry | undefined => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : [])).at(-1);
const bdjEvents = (h: Harness, ev: number): number[] => h.sent.flatMap((m) => (m.type === 'event' && m.ev === ev ? [m.param] : []));

async function until(h: Harness, cond: () => boolean, timeout = 60_000): Promise<void> {
  await vi.waitFor(
    async () => {
      await h.play(50);
      expect(cond()).toBe(true);
    },
    { timeout, interval: 1 },
  );
}

/** Opens the disc and waits until Java's first playlist plays. */
async function playing(files = bdjDisc()): Promise<Harness> {
  const h = await harness(files);
  await until(h, () => lastState(h) === 'playing' && playlistsPlayed(h).length > 0);
  return h;
}

describe('Player with BD-J titles (in-process BD-J worker)', () => {
  it('a browser that lacks something BD-J needs opens the disc to the picker, naming it, and starts no worker', async () => {
    const h = await harness(bdjDisc(), { bdjMissing: ['workers started from workers'] });
    await h.play(500);
    expect(h.workers()).toBe(0);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'titles', usesBdj: true, bdjSupported: false, bdjMissing: ['workers started from workers'] }));
    expect(h.events).toContainEqual({
      type: 'notice',
      code: 'bdj',
      message: "This disc uses BD-J (Java) menus, which this browser can't run: it lacks workers started from workers. Choose a playlist to play.",
    });
    expect(h.events).not.toContainEqual(expect.objectContaining({ type: 'bdjActive', active: true }));
    expect(lastState(h)).toBe('idle');
  });

  it('runs First Play from a disc on the NAS: the engine and the BD-J worker both read it by range reads', async () => {
    const h = await harness(fixtureDiscFiles('disc-bdj'), { remote: true });
    await until(h, () => lastState(h) === 'playing' && playlistsPlayed(h).length > 0);
    expect(playlistsPlayed(h)).toEqual(['00000']);
    const boot = h.sent.find((m) => m.type === 'boot');
    expect(boot).toMatchObject({ disc: { kind: 'remote', base: 'https://nas.example/bluray/api/discs/d1/' }, readAheadBytes: 16 * 1024 * 1024 }); // the BD-J worker's own budget (R20)
    expect(h.requested).toContain('BDMV/JAR/00000.JAR'); // only the BD-J worker reads the jar
    expect(h.requested).toContain('BDMV/STREAM/00000.M2TS');
  }, 90_000);

  it('runs First Play from a disc on the WebRTC route: the BD-J worker reads its jar through the port the engine relays', async () => {
    const h = await harness(fixtureDiscFiles('disc-bdj'), { remote: 'port' });
    await until(h, () => lastState(h) === 'playing' && playlistsPlayed(h).length > 0);
    expect(playlistsPlayed(h)).toEqual(['00000']);
    const boot = h.sent.find((m) => m.type === 'boot');
    expect(boot?.type === 'boot' && boot.disc.kind === 'remote' && boot.disc.fetchPort).toBeInstanceOf(MessagePort); // a port of its own, not the engine's
    expect(h.requested).toContain('BDMV/JAR/00000.JAR'); // only the BD-J worker reads the jar
    expect(h.requested).toContain('BDMV/STREAM/00000.M2TS');
    expect(h.ownFetch).not.toHaveBeenCalled();
  }, 90_000);

  it('runs First Play: Java plays playlist 00000 with no picker and no notice', async () => {
    const h = await playing();
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'titles', bdjSupported: true }));
    expect(h.events).toContainEqual({ type: 'bdjActive', active: true });
    expect(notices(h)).toEqual([]); // 5c's "menu isn't shown yet" is gone: menus are drawn and take input
    expect(h.events.some((e) => e.type === 'bdjMenu')).toBe(false); // disc-bdj draws nothing
    expect(playlistsPlayed(h)).toEqual(['00000']);
    expect(h.sent.filter((m) => m.type === 'start')).toEqual([{ type: 'start', title: 0xffff }]);
    // the disc's playlist masks pause and seeks, but under a BD-J title the UI is told only of menu call and title search
    expect(h.events.filter((e) => e.type === 'uoMask').every((e) => e.type === 'uoMask' && e.masked.length === 0)).toBe(true);
  }, 90_000);

  it('reports start-up times since the open in telemetry: boot, Java\'s first playlist, its first presented frame (spec §4.7)', async () => {
    const h = await playing();
    await h.play(600); // a telemetry interval
    const bdj = lastTelemetry(h)?.bdj;
    expect(bdj).toBeTruthy();
    const { bootMs, firstPlaylistMs, firstFrameMs } = bdj!;
    expect(bootMs).toBeGreaterThanOrEqual(0);
    expect(firstPlaylistMs).toBeGreaterThanOrEqual(bootMs!);
    expect(firstFrameMs).toBeGreaterThan(firstPlaylistMs!);
    // later playlists and frames do not move them
    await h.play(2000);
    expect(lastTelemetry(h)?.bdj).toEqual(bdj);
  }, 90_000);

  it('never refuses pause or play under a BD-J title, and Java hears RATE', async () => {
    const h = await playing();
    await h.player.handle({ type: 'pause' });
    expect(lastState(h)).toBe('paused');
    await h.player.handle({ type: 'play' });
    await until(h, () => lastState(h) === 'playing');
    expect(notices(h)).not.toContain('uo-masked');
    await until(h, () => bdjEvents(h, BdjEvent.RATE).length >= 2);
    expect(bdjEvents(h, BdjEvent.RATE)).toEqual([0, 90_000]);
  }, 90_000);

  it("leaves playback alone when Java starts a playlist that already plays", async () => {
    const h = await playing();
    const before = h.events.length;
    h.inject({ type: 'call', id: 9001, name: 'selectRate', args: [1, START] });
    h.inject({ type: 'call', id: 9002, name: 'selectRate', args: [1, START] });
    await until(h, () => h.sent.some((m) => m.type === 'reply' && m.id === 9002));
    await h.play(300);
    expect(h.events.slice(before).filter((e) => e.type === 'state' || e.type === 'chapters' || e.type === 'playlistCleared')).toEqual([]);
  }, 90_000);

  it('never refuses a seek or chapter skip under a BD-J title, and Java hears SEEK', async () => {
    const h = await playing();
    await h.player.handle({ type: 'seek', timeUs: 1_200_000 });
    await h.player.handle({ type: 'nextChapter' });
    expect(notices(h)).not.toContain('uo-masked');
    await until(h, () => bdjEvents(h, BdjEvent.SEEK).length >= 2);
    expect(bdjEvents(h, BdjEvent.SEEK)).toEqual([1.2 * 45_000, 2 * 45_000]);
  }, 90_000);

  /** disc-bdj with playlist 00000's one 4 s play item a still: Java plays 00000 and selects it again when it ends. */
  const stillDisc = (still: { mode: number; time?: number }) =>
    bdjDisc({
      playlists: [
        { id: '00000', clipIds: ['00000'], chapterEverySeconds: 1, uoMask: PLAYBACK_MASKED, stills: { 0: still } },
        { id: '00001', clipIds: ['00001'], chapterEverySeconds: 1 },
      ],
    });
  const clockUs = (h: Harness): number => h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1) ?? 0;

  it('holds at the end of an infinite still play item, as _bd_read_locked does under BD-J: no END_OF_PLAYLIST', async () => {
    const h = await playing(stillDisc({ mode: 2 }));
    await h.play(8000);
    expect(bdjEvents(h, BdjEvent.END_OF_PLAYLIST)).toEqual([]);
    expect(playlistsPlayed(h)).toEqual(['00000']);
    expect(clockUs(h)).toBeGreaterThanOrEqual(3_600_000);
    expect(clockUs(h)).toBeLessThan(4_000_000);
  }, 90_000);

  it('holds a time still for its still_time, then the playlist ends (bd_read_skip_still)', async () => {
    const h = await playing(stillDisc({ mode: 1, time: 2 }));
    await until(h, () => clockUs(h) >= 3_600_000);
    await h.play(1500);
    expect(bdjEvents(h, BdjEvent.END_OF_PLAYLIST)).toEqual([]);
    await until(h, () => bdjEvents(h, BdjEvent.END_OF_PLAYLIST).length > 0);
    expect(playlistsPlayed(h).length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('a pause and play from Java during a still hold go back to playing, and the time still still ends', async () => {
    const h = await playing(stillDisc({ mode: 1, time: 5 }));
    await until(h, () => clockUs(h) >= 3_600_000);
    await h.play(300); // held at the item's end
    h.inject({ type: 'call', id: 9101, name: 'selectRate', args: [0, 0] }); // a rate change, not BDJ_PLAYBACK_STOP
    await until(h, () => lastState(h) === 'paused');
    h.inject({ type: 'call', id: 9102, name: 'selectRate', args: [1, 0] });
    await until(h, () => h.sent.some((m) => m.type === 'reply' && m.id === 9102));
    await h.play(100);
    expect(lastState(h)).toBe('playing');
    expect(bdjEvents(h, BdjEvent.END_OF_PLAYLIST)).toEqual([]);
    await until(h, () => bdjEvents(h, BdjEvent.END_OF_PLAYLIST).length > 0); // still_time (5 s) passed: on to the end
  }, 90_000);

  it("refuses a menu call masked by Java's UO mask, with uo-masked and UO_MASKED to Java", async () => {
    const h = await playing();
    h.inject({ type: 'call', id: 9001, name: 'setUOMask', args: [true, false] });
    await until(h, () => h.events.some((e) => e.type === 'uoMask' && e.masked.includes('menuCall')));
    const starts = h.sent.filter((m) => m.type === 'start').length;
    await h.player.handle({ type: 'menuCall' });
    expect(notices(h)).toContain('uo-masked');
    await until(h, () => bdjEvents(h, BdjEvent.UO_MASKED).length > 0);
    expect(bdjEvents(h, BdjEvent.UO_MASKED)).toEqual([0]); // UO_MASK_MENU_CALL_INDEX
    expect(h.sent.filter((m) => m.type === 'start')).toHaveLength(starts);
  }, 90_000);

  it('starts the top menu title on an unmasked menu call', async () => {
    const h = await playing();
    await h.player.handle({ type: 'menuCall' });
    await until(h, () => h.sent.some((m) => m.type === 'start' && m.title === 0));
    expect(notices(h)).not.toContain('uo-masked');
  }, 90_000);

  it('a playlist chosen in the picker stops BD-J, and no later Java call reaches the player', async () => {
    const h = await playing();
    h.inject({ type: 'call', id: 9001, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    await new Promise((r) => setTimeout(r, 0)); // the call reaches the host and starts opening
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    expect(h.terminated()).toBe(true);
    expect(h.events).toContainEqual({ type: 'bdjActive', active: false });
    h.inject({ type: 'call', id: 9002, name: 'selectRate', args: [0, START] });
    h.inject({ type: 'call', id: 9003, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    await until(h, () => lastState(h) === 'playing');
    await h.play(500);
    expect(playlistsPlayed(h).at(-1)).toBe('00001');
    expect(lastState(h)).toBe('playing');
    expect(h.sent.some((m) => m.type === 'reply' && m.id >= 9001)).toBe(false);
  }, 90_000);

  it('a playlist chosen in the picker also stops BD-J while it is still booting', async () => {
    const h = await harness(bdjDisc());
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    expect(h.terminated()).toBe(true);
    await until(h, () => lastState(h) === 'playing');
    await h.play(1000);
    expect(playlistsPlayed(h)).toEqual(['00001']);
    expect(h.sent.some((m) => m.type === 'start')).toBe(false);
  }, 90_000);

  it('says BD-J is active before the player goes idle, so the picker never flashes on First Play', async () => {
    const h = await harness(bdjDisc(), { worker: handWorker().worker });
    const types = h.events.map((e) => (e.type === 'state' ? `state:${e.state}` : e.type));
    const titles = types.indexOf('titles');
    expect(types.indexOf('bdjActive', titles)).toBeLessThan(types.indexOf('state:idle', titles));
  });

  it('reads the place of a BD-J title: its registers, with no title and no GPRs', async () => {
    const h = await harness(bdjDisc(), { worker: handWorker().worker });
    await h.player.handle({ type: 'readPlace' });
    const place = h.events.filter((e) => e.type === 'placeState').at(-1);
    expect(place).toMatchObject({ type: 'placeState', mode: 'bdj', title: null, gprs: null });
    expect(place?.type === 'placeState' && place.psrs).toHaveLength(128);
  });

  it('opens a BD-J disc at a place directly, with BD-J off: no worker, the saved audio stream', async () => {
    const h = await harness(bdjDisc(), { start: { playlistId: '00000', timeUs: 1e6, hdmv: null, playback: { psr1: 2, psr2: 0, psr3: 1 } } });
    await until(h, () => lastState(h) === 'playing');
    expect(h.workers()).toBe(0);
    expect(h.events).not.toContainEqual(expect.objectContaining({ type: 'bdjActive', active: true }));
    expect(playlistsPlayed(h)).toEqual(['00000']);
    expect(h.events.flatMap((e) => (e.type === 'tracks' ? [e.selectedAudio] : []))).toEqual([2]);
    await h.player.handle({ type: 'readPlace' });
    expect(h.events.filter((e) => e.type === 'placeState').at(-1)).toMatchObject({ mode: 'none', title: null, gprs: null });
  });

  it("boots a BD-J First Play's worker while the disc opens (spec §4.7), once, and the title starts once it has booted", async () => {
    const order: string[] = [];
    const w = handWorker();
    const recording: WorkerLike = {
      postMessage: (m) => {
        order.push(`post:${m.type}`);
        w.worker.postMessage(m);
      },
      get onmessage() {
        return w.worker.onmessage;
      },
      set onmessage(fn) {
        w.worker.onmessage = fn;
      },
      terminate: () => w.worker.terminate(),
    };
    const player = new Player({
      emit: (e) => void order.push(`emit:${e.type}`),
      videoCodecApi: fakeVideoCodecApi,
      nowMs: () => 1000,
      requestFrame: () => undefined,
      createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
      createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }),
      setTimer: () => () => undefined,
      bdj: seikouBdjProvider({ missing: [], createWorker: () => recording, loadClassLibrary: async () => CLASSES }),
    });
    players.push(player);
    await player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(bdjDisc()) } });
    await vi.waitFor(() => expect(order).toContain('post:boot'));
    expect(order.filter((o) => o === 'post:boot')).toHaveLength(1);
    expect(order.indexOf('post:boot')).toBeLessThan(order.indexOf('emit:titles'));
    expect(w.sent.some((m) => m.type === 'start')).toBe(false);
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.filter((m) => m.type === 'start')).toEqual([{ type: 'start', title: 0xffff }]));
  });

  it("flushes BD-J's saved data on flushSaves (pagehide), and a disc reopened boots only once the stopped worker has saved", async () => {
    const workers = [handWorker(), handWorker()];
    let created = 0;
    const player = new Player({
      emit: () => undefined,
      videoCodecApi: fakeVideoCodecApi,
      nowMs: () => 1000,
      requestFrame: () => undefined,
      createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
      createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }),
      setTimer: () => () => undefined,
      bdj: seikouBdjProvider({ missing: [], createWorker: () => workers[created++]!.worker, loadClassLibrary: async () => CLASSES }),
    });
    players.push(player);
    const [first, second] = workers as [ReturnType<typeof handWorker>, ReturnType<typeof handWorker>];
    const disc = { kind: 'files', entries: discEntries(bdjDisc()) } as const;
    await player.handle({ type: 'open', disc });
    await vi.waitFor(() => expect(first.sent.some((m) => m.type === 'boot')).toBe(true));
    first.emit({ type: 'booted', bootMs: 1 });
    first.emit({ type: 'unsaved', unsaved: true }); // Java wrote under /persistent/
    void player.handle({ type: 'flushSaves' });
    expect(first.sent.at(-1)).toEqual({ type: 'flush' });

    await player.handle({ type: 'close' });
    expect(first.sent.at(-1)).toEqual({ type: 'stop' });
    expect(first.terminated()).toBe(false);
    await player.handle({ type: 'open', disc });
    await new Promise((r) => setTimeout(r, 20));
    expect(created).toBe(2);
    expect(second.sent.some((m) => m.type === 'boot')).toBe(false); // it would load the scopes before they are saved
    first.emit({ type: 'stopped' });
    expect(first.terminated()).toBe(true);
    await vi.waitFor(() => expect(second.sent.some((m) => m.type === 'boot')).toBe(true));
  });

  it('BD-J boots on the original manifest without the level query, and setLevel leaves its worker alone', async () => {
    const w = handWorker();
    let original: RemoteDiscSpec['manifest'] | null = null;
    const toLevel = (spec: RemoteDiscSpec): RemoteDiscSpec => {
      original = spec.manifest;
      return { ...spec, manifest: { ...spec.manifest, name: 'level' }, query: 'level=h264-1080&audio=1', original: spec.manifest };
    };
    const h = await harness(bdjDisc(), { worker: w.worker, remote: true, remoteSpec: toLevel });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    if (boot.type !== 'boot' || boot.disc.kind !== 'remote') throw new Error('no remote boot');
    expect(boot.disc.manifest).toBe(original);
    expect(boot.disc.query).toBeUndefined();
    const level: RemoteDiscSpec = toLevel({ ...boot.disc, manifest: original! });
    await h.player.handle({ type: 'setLevel', disc: { ...level, query: 'level=phone-720&audio=1' } });
    expect(h.events).toContainEqual({ type: 'levelChanged', ok: true });
    expect(h.workers()).toBe(1);
    expect(w.terminated()).toBe(false);
    expect(w.sent.filter((m) => m.type === 'boot')).toHaveLength(1);
  });

  it("writes the application's player settings to the registers Java reads (bd_set_player_setting_str)", async () => {
    const w = handWorker();
    await harness(bdjDisc(), { worker: w.worker, playerSettings: { audioLanguage: 'jpn', pgLanguage: 'eng', menuLanguage: 'fra', country: 'jp' } });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    const regs = new SharedRegisterView(boot.type === 'boot' ? boot.registers : new SharedArrayBuffer(0));
    expect([16, 17, 18, 19].map((i) => regs.psrRead(i))).toEqual([0x6a706e, 0x656e67, 0x667261, 0x6a70]);
  });

  it("sends the memory profile's BD-J budgets with the boot, from an early worker and from a title's", async () => {
    for (const profile of ['desktop', 'constrained'] as const) {
      const w = handWorker();
      await harness(bdjDisc(), { worker: w.worker, memoryProfile: profile });
      await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
      const p = MEMORY_PROFILES[profile];
      expect(w.sent.find((m) => m.type === 'boot')).toMatchObject({ memory: { classBytes: p.bdjClassCacheBytes, vfsBytes: p.bdjVfsCacheBytes } });
    }
    const w = handWorker();
    const movieObjects = buildMovieObjects([{ cmds: [asm.jumpTitle(imm(1))] }]);
    const files = bdjDisc({ movieObjects, index: { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'bdj', name: '00001' }] } });
    await harness(files, { worker: w.worker, memoryProfile: 'constrained' });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    expect(w.sent.find((m) => m.type === 'boot')).toMatchObject({ memory: { classBytes: MEMORY_PROFILES.constrained.bdjClassCacheBytes } });
  });

  it('applies the player settings at the open of a disc that uses BD-J, so its HDMV First Play reads them (bd_open)', async () => {
    const w = handWorker();
    // First Play copies the menu language (PSR18) into GPR98, as a mixed disc does to choose its BD-J menu's language
    const movieObjects = buildMovieObjects([{ cmds: [asm.set('move', reg(98), psr(18)), asm.jumpTitle(imm(1))] }]);
    const files = bdjDisc({ movieObjects, index: { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'bdj', name: '00001' }] } });
    await harness(files, { worker: w.worker, playerSettings: { audioLanguage: 'jpn', pgLanguage: 'eng', menuLanguage: 'fra', country: 'jp' } });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    const regs = new SharedRegisterView(boot.type === 'boot' ? boot.registers : new SharedArrayBuffer(0));
    expect([16, 17, 18, 19].map((i) => regs.psrRead(i))).toEqual([0x6a706e, 0x656e67, 0x667261, 0x6a70]);
    expect(regs.gprRead(98)).toBe(0x667261);
  });

  it('falls back with a timeout bdj-failed 20,000 ms after a boot that never completes', async () => {
    const clock = new VirtualClock();
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker, setTimer: clock.setTimer, wallMs: clock.nowMs });
    await vi.waitFor(() => expect(w.sent.map((m) => m.type)).toEqual(['boot']));
    clock.advance(19_999);
    expect(notices(h)).not.toContain('bdj-failed');
    clock.advance(1);
    // the worker is asked for its thread dump first; one that does not answer is stopped DUMP_WAIT_MS later
    expect(w.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    expect(notices(h)).not.toContain('bdj-failed');
    clock.advance(DUMP_WAIT_MS);
    expect(h.events.find((e) => e.type === 'notice' && e.code === 'bdj-failed')).toMatchObject({
      message: "BD-J couldn't start this disc (timeout: no playlist was selected and nothing was shown within 20 s). Choose a playlist to play.",
    });
    expect(h.events.filter((e) => e.type === 'bdjActive').at(-1)).toEqual({ type: 'bdjActive', active: false });
    expect(w.terminated()).toBe(true);
  });

  it('a hidden page pauses the start-up timeout (the visibility command, ruling R22), before and after the open', async () => {
    const clock = new VirtualClock();
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker, setTimer: clock.setTimer, wallMs: clock.nowMs });
    await vi.waitFor(() => expect(w.sent.map((m) => m.type)).toEqual(['boot']));
    clock.advance(10_000);
    await h.player.handle({ type: 'visibility', hidden: true });
    clock.advance(120_000);
    expect(w.sent.some((m) => m.type === 'dump')).toBe(false);
    await h.player.handle({ type: 'visibility', hidden: false });
    clock.advance(9_999);
    expect(w.sent.some((m) => m.type === 'dump')).toBe(false);
    clock.advance(1);
    expect(w.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
  });

  it("shows the bdj-storage notice once per disc open when the worker says saved data won't last (ruling R32)", async () => {
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    expect(notices(h)).not.toContain('bdj-storage');
    w.emit({ type: 'storageLost', reason: 'memory-only' });
    w.emit({ type: 'booted', bootMs: 1 });
    w.emit({ type: 'storageLost', reason: 'full' }); // a worker tells once; the player shows it once all the same
    const storage = (): EngineEvent[] => h.events.filter((e) => e.type === 'notice' && e.code === 'bdj-storage');
    expect(storage()).toEqual([{ type: 'notice', code: 'bdj-storage', message: BDJ_STORAGE_MESSAGE }]);
    expect(BDJ_STORAGE_MESSAGE).toBe("This disc's saved data can't be kept right now, so progress you make may be lost.");
    // the disc opened again: its own notice
    const boots = w.sent.filter((m) => m.type === 'boot').length;
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(bdjDisc()) } });
    await vi.waitFor(() => expect(w.sent.filter((m) => m.type === 'boot').length).toBe(boots + 1));
    w.emit({ type: 'storageLost', reason: 'put-failed' });
    expect(storage()).toHaveLength(2);
  });

  /** A booted hand-driven title on a virtual timer clock, and its plane's writer. */
  async function bootedOnClock(): Promise<{ h: Harness; w: ReturnType<typeof handWorker>; clock: VirtualClock; writer: GraphicsPlaneWriter }> {
    const clock = new VirtualClock();
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker, setTimer: clock.setTimer, wallMs: clock.nowMs, decodeImage: async () => ({ width: 1, height: 1, close: () => undefined }) as unknown as ImageBitmap });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    if (boot.type !== 'boot') throw new Error('no boot');
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    return { h, w, clock, writer: new GraphicsPlaneWriter(boot.plane) };
  }

  it('a menu Java shows without selecting a playlist keeps BD-J alive past the 20 s timeout (ruling R7)', async () => {
    const { h, w, clock, writer } = await bootedOnClock();
    clock.advance(10_000);
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 100, 100, 299, 149);
    await h.play(20); // the flush becomes visible at the next tick: bdjMenu visible
    expect(h.events).toContainEqual({ type: 'bdjMenu', visible: true });
    clock.advance(60_000);
    expect(notices(h)).not.toContain('bdj-failed');
    expect(w.terminated()).toBe(false);
  });

  it('a background still Java shows without selecting a playlist keeps BD-J alive past the 20 s timeout (ruling R7)', async () => {
    const { h, w, clock } = await bootedOnClock();
    w.emit({ type: 'background', image: new Uint8Array([1, 2, 3]), rect: { x: 0, y: 0, width: 1, height: 1 } });
    clock.advance(60_000);
    expect(notices(h)).not.toContain('bdj-failed');
    expect(w.terminated()).toBe(false);
  });

  it('a title that draws nothing, shows no still and selects nothing still falls back at 20 s', async () => {
    const { h, w, clock, writer } = await bootedOnClock();
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0); // an opened but empty plane is no menu
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080), 100, 100, 299, 149);
    w.emit({ type: 'background', image: null, rect: { x: 0, y: 0, width: 1, height: 1 } }); // a cleared still neither
    await h.play(20);
    clock.advance(19_999);
    expect(notices(h)).not.toContain('bdj-failed');
    clock.advance(1);
    expect(w.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    w.emit({ type: 'dumped' });
    expect(notices(h)).toContain('bdj-failed');
    expect(w.terminated()).toBe(true);
  });

  it('a playlist Java asked for that is still loading when BD-J fails does not open behind the picker', async () => {
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(lastState(h)).toBe('loading');
    w.emit({ type: 'failed', code: 'internal', message: 'boom' });
    await h.play(500);
    expect(playlistsPlayed(h)).toEqual([]);
    expect(lastState(h)).toBe('idle');
    expect(notices(h)).toContain('bdj-failed');
  });

  /** A hand-driven BD-J worker that has booted and started its title. */
  async function startedHand(): Promise<{ readonly h: Harness; readonly w: ReturnType<typeof handWorker> }> {
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    return { h, w };
  }

  it.each([
    ['MPEG-2 video', CodingType.MPEG2_VIDEO],
    ['VC-1', CodingType.VC1],
  ])("selects a playlist of %s, which plays without a picture: selectPlaylist returns 1 and Java gets the playlist's events", async (codec, videoCodingType) => {
    const w = handWorker();
    const files = bdjDisc({
      playlists: [
        { id: '00000', clipIds: ['00000'], chapterEverySeconds: 1, uoMask: PLAYBACK_MASKED },
        { id: '00001', clipIds: ['00001'], chapterEverySeconds: 1, videoCodingType },
      ],
    });
    const h = await harness(files, { worker: w.worker });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    const events = (ev: number): number[] => w.sent.flatMap((m) => (m.type === 'event' && m.ev === ev ? [m.param] : []));
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [1, -1, -1, '-1'] });
    await until(h, () => w.sent.some((m) => m.type === 'reply' && m.id === 1));
    expect(w.sent.find((m) => m.type === 'reply' && m.id === 1)).toEqual({ type: 'reply', id: 1, value: 1 });
    expect(events(BdjEvent.PLAYLIST)).toContain(1);
    w.emit({ type: 'call', id: 2, name: 'selectRate', args: [1, START] });
    await until(h, () => lastState(h) === 'playing');
    expect(h.events.filter((e) => e.type === 'unsupported')).toEqual([{ type: 'unsupported', kind: 'video', codec, message: NO_PICTURE_MESSAGE, noPicture: true }]);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    // the first frame is the black one with the planes over it, composited once the playlist plays
    await until(h, () => (lastTelemetry(h)?.bdj?.firstFrameMs ?? null) !== null);
    const bdj = lastTelemetry(h)!.bdj!;
    expect(bdj.firstFrameMs).toBeGreaterThanOrEqual(bdj.firstPlaylistMs!);
    expect(lastTelemetry(h)!.framesPresented).toBe(0);
    await until(h, () => events(BdjEvent.END_OF_PLAYLIST).length > 0);
    expect(events(BdjEvent.END_OF_PLAYLIST)).toEqual([1]);
    // Java selecting it again: no second notice
    w.emit({ type: 'call', id: 3, name: 'selectPlaylist', args: [1, -1, -1, '-1'] });
    await until(h, () => w.sent.some((m) => m.type === 'reply' && m.id === 3));
    expect(w.sent.find((m) => m.type === 'reply' && m.id === 3)).toEqual({ type: 'reply', id: 3, value: 1 });
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
  }, 30_000);

  /** A compositor that records its calls by name; drawBdj also notes the plane's buffer and copies it, as the real one does. */
  function recordingCompositor(): { readonly compositor: CompositorLike; readonly calls: string[]; readonly planes: SharedArrayBuffer[] } {
    const calls: string[] = [];
    const planes: SharedArrayBuffer[] = [];
    const image = { data: new Uint8ClampedArray(1920 * 1080 * 4), width: 1920, height: 1080 } as ImageData;
    const compositor: CompositorLike = {
      resize: () => void calls.push('resize'),
      drawVideo: () => void calls.push('drawVideo'),
      drawIg: () => void calls.push('drawIg'),
      drawBdj: (plane) => {
        calls.push('drawBdj');
        planes.push(plane.buffer);
        plane.copyDirtyInto(image);
      },
      clearBdj: () => void calls.push('clearBdj'),
      setBackground: (still) => void calls.push(still ? `setBackground:${(still.image as unknown as { name: string }).name}` : 'setBackground:null'),
    };
    return { compositor, calls, planes };
  }

  /** A booted hand-driven BD-J title whose Java has drawn a menu into the plane, shown by a recording compositor. */
  async function menuShown(
    opts: HarnessOptions = {},
    wrap: (c: CompositorLike) => CompositorLike = (c) => c,
  ): Promise<{ h: Harness; w: ReturnType<typeof handWorker>; rec: ReturnType<typeof recordingCompositor>; writer: GraphicsPlaneWriter }> {
    const w = handWorker();
    const rec = recordingCompositor();
    const h = await harness(bdjDisc(), { ...opts, worker: w.worker, compositor: wrap(rec.compositor) });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    if (boot.type !== 'boot') throw new Error('no boot');
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    const writer = new GraphicsPlaneWriter(boot.plane);
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 100, 100, 299, 149);
    await h.play(50);
    expect(rec.planes.at(-1)).toBe(boot.plane);
    expect(new GraphicsPlaneReader(boot.plane).visible()).toBe(true);
    return { h, w, rec, writer };
  }

  it("draws Java's plane on its flush, with no playlist playing, and not again until it changes", async () => {
    const { h, rec, writer } = await menuShown();
    const at = rec.calls.length;
    await h.play(50);
    // a visible plane is drawn whenever the picture is; with no playlist nothing changed, so nothing is drawn
    expect(rec.calls.slice(at)).toEqual([]);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080), 100, 100, 299, 149); // the menu taken down
    await h.play(20);
    expect(rec.calls.slice(at)).toEqual(['drawVideo', 'drawBdj']);
  });

  it('repaints with the plane drawn last when the window is resized (Review Focus 1)', async () => {
    const { h, rec } = await menuShown();
    const at = rec.calls.length;
    await h.player.handle({ type: 'resize', width: 390, height: 844 });
    expect(rec.calls.slice(at)).toEqual(['resize', 'drawVideo', 'drawBdj']);
  });

  /** After `leave`, the plane is cleared at once (a repaint without it) and never drawn again (Review Focus 2). */
  async function clearedBy(leave: (h: Harness, w: ReturnType<typeof handWorker>) => Promise<void>): Promise<void> {
    const { h, w, rec, writer } = await menuShown();
    const at = rec.calls.length;
    await leave(h, w);
    const after = rec.calls.slice(at);
    expect(after.slice(0, 2)).toEqual(['clearBdj', 'drawVideo']);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 0, 0, 9, 9); // a worker still drawing as it dies
    await h.play(500);
    expect(rec.calls.slice(at)).not.toContain('drawBdj');
    expect(w.terminated()).toBe(true);
  }

  it('clears the plane at once when the user picks a playlist in the picker', async () => {
    await clearedBy((h) => h.player.handle({ type: 'playPlaylist', playlistId: '00001' }));
  });

  it('clears the plane at once when the disc closes', async () => {
    await clearedBy((h) => h.player.handle({ type: 'close' }));
  });

  it('clears the plane at once when BD-J fails', async () => {
    await clearedBy(async (h, w) => {
      w.emit({ type: 'failed', code: 'internal', message: 'boom' });
      expect(notices(h)).toContain('bdj-failed');
    });
  });

  // ---- keys, pointer and taps (5d Task 8) ----

  /** Timers the test fires by hand; the BD-J first-playlist timeout (20 s) is among them and never fired. */
  function manualTimers() {
    const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
    return {
      setTimer: (ms: number, fn: () => void) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return () => void (t.cancelled = true);
      },
      /** Live timers of `ms`. */
      armed: (ms: number) => timers.filter((t) => t.ms === ms && !t.cancelled),
      /** Fires the live timers of `ms`, as if that much time had passed. */
      fire(ms: number) {
        for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) {
          t.cancelled = true;
          t.fn();
        }
      },
    };
  }

  /** startedHand with the given timers. */
  async function startedHandWith(opts: HarnessOptions): Promise<{ readonly h: Harness; readonly w: ReturnType<typeof handWorker> }> {
    const w = handWorker();
    const h = await harness(bdjDisc(), { ...opts, worker: w.worker });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    return { h, w };
  }

  const ALL_FLAGS = 0xe0000000;
  const INPUT_EVENTS: ReadonlySet<number> = new Set([BdjEvent.VK_KEY, BdjEvent.MOUSE, BdjEvent.UO_MASKED]);
  /** The input events (and UO_MASKED) sent to the worker since `from`. */
  const inputSent = (w: ReturnType<typeof handWorker>, from = 0): Array<{ ev: number; param: number; coalesce?: string }> =>
    w.sent.slice(from).flatMap((m) => (m.type === 'event' && INPUT_EVENTS.has(m.ev) ? [{ ev: m.ev, param: m.param >>> 0, ...(m.coalesce ? { coalesce: m.coalesce } : {}) }] : []));
  const vkKey = (vk: number) => ({ ev: BdjEvent.VK_KEY, param: (ALL_FLAGS | vk) >>> 0 });

  it('sends arrows, OK, digits and the pop-up key to Java as bd_user_input does', async () => {
    const { h, w } = await startedHand();
    const from = w.sent.length;
    for (const key of ['up', 'down', 'left', 'right', 'ok', '0', '7', 'popup'] as const) await h.player.handle({ type: 'menuKey', key });
    expect(inputSent(w, from)).toEqual([12, 13, 14, 15, 16, 0, 7, 11].map(vkKey));
  });

  it('sends keys whatever the key interest table, and the pop-up key whatever the UO mask (libbluray filters neither for BD-J)', async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'setKeyInterest', args: [0] });
    const from = w.sent.length;
    await h.player.handle({ type: 'menuKey', key: 'popup' });
    await h.player.handle({ type: 'menuKey', key: 'ok' });
    expect(inputSent(w, from)).toEqual([vkKey(11), vkKey(16)]);
  });

  it('makes Top Menu a menu call: refused with UO_MASKED under the menu call mask, never a VK_KEY', async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'setUOMask', args: [true, false] });
    await vi.waitFor(() => expect(h.events.some((e) => e.type === 'uoMask' && e.masked.includes('menuCall'))).toBe(true));
    const from = w.sent.length;
    await h.player.handle({ type: 'menuKey', key: 'topMenu' });
    expect(inputSent(w, from)).toEqual([{ ev: BdjEvent.UO_MASKED, param: 0 }]);
    expect(notices(h)).toContain('uo-masked');
    w.emit({ type: 'call', id: 2, name: 'setUOMask', args: [false, false] });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'reply' && m.id === 2)).toBe(true));
    const before = w.sent.length;
    await h.player.handle({ type: 'menuKey', key: 'topMenu' });
    expect(inputSent(w, before)).toEqual([]);
    await vi.waitFor(() => expect(w.sent.slice(before).some((m) => m.type === 'start' && m.title === 0)).toBe(true));
  });

  it("forwards a held key's repeats in order, marked so a full queue may merge them (Review Focus 2)", async () => {
    const { h, w } = await startedHand();
    const from = w.sent.length;
    await h.player.handle({ type: 'menuKey', key: 'down' });
    for (let i = 0; i < 3; i++) await h.player.handle({ type: 'menuKey', key: 'down', repeat: true });
    await h.player.handle({ type: 'menuKey', key: 'ok' });
    const repeat = { ...vkKey(13), coalesce: 'repeat' };
    expect(inputSent(w, from)).toEqual([vkKey(13), repeat, repeat, repeat, vkKey(16)]);
  });

  it('sends a click as BDJ_EVENT_MOUSE then the activate key, and a move as a mergeable BDJ_EVENT_MOUSE', async () => {
    const { h, w } = await startedHand();
    const from = w.sent.length;
    await h.player.handle({ type: 'pointer', kind: 'move', x: 100.4, y: 50 });
    await h.player.handle({ type: 'pointer', kind: 'click', x: 232, y: 216 });
    expect(inputSent(w, from)).toEqual([
      { ev: BdjEvent.MOUSE, param: (100 << 16) | 50, coalesce: 'move' },
      { ev: BdjEvent.MOUSE, param: (232 << 16) | 216 },
      vkKey(17), // BD_VK_MOUSE_ACTIVATE
    ]);
    expect(h.events.some((e) => e.type === 'pointerTarget')).toBe(false); // HDMV's cursor feedback has no BD-J counterpart
  });

  it('times a key and a click to the frame that shows their plane change (telemetry bdj.inputLatencyMs)', async () => {
    const { h, writer } = await menuShown();
    await h.player.handle({ type: 'menuKey', key: 'down' });
    await h.play(STEP_MS * 3); // frames with the plane unchanged answer nothing
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-2), 100, 100, 299, 149);
    await h.play(STEP_MS);
    await h.player.handle({ type: 'pointer', kind: 'move', x: 5, y: 5 }); // a move is not timed
    await h.player.handle({ type: 'pointer', kind: 'click', x: 200, y: 120 });
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-3), 100, 100, 299, 149);
    await h.play(600); // a telemetry interval, with no playlist playing
    expect(lastTelemetry(h)?.bdj?.inputLatencyMs).toEqual({ last: Math.round(STEP_MS), max: Math.round(STEP_MS * 4), count: 2 });
  });

  it("times an input whose flush lands in the middle of a frame's paint, which copies and shows it (Firefox gate)", async () => {
    // Java flushes on the BD-J worker's thread: here after the frame has found nothing pending and before its copy
    let midPaint: (() => void) | null = null;
    const { h, w, writer } = await menuShown({ decodeImage: async () => ({ width: 1, height: 1, close: () => undefined }) as unknown as ImageBitmap }, (c) => ({
      ...c,
      drawVideo: (frame) => {
        c.drawVideo(frame);
        const flush = midPaint;
        midPaint = null;
        flush?.();
      },
    }));
    await h.player.handle({ type: 'menuKey', key: 'down' });
    await h.play(STEP_MS * 3);
    midPaint = () => updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-2), 100, 100, 299, 149);
    // a background still makes the next frame repaint everything, the visible plane included
    w.emit({ type: 'background', image: new Uint8Array([1]), rect: { x: 0, y: 0, width: 1920, height: 1080 } });
    await h.play(600);
    expect(midPaint).toBeNull(); // the flush did land inside a paint
    expect(lastTelemetry(h)?.bdj?.inputLatencyMs?.count).toBe(1);
  });

  it('telemetry carries the plane hash once the plane has settled for an interval, only when asked (test-only)', async () => {
    const { h, writer } = await menuShown({ planeHashTelemetry: true });
    const hashes = (): (string | null | undefined)[] => h.events.flatMap((e) => (e.type === 'telemetry' && e.telemetry.bdjPlane ? [e.telemetry.bdjPlane.hash] : []));
    await h.play(1200); // the interval that sees the plane first, then one that sees it unchanged
    const settled = new GraphicsPlaneReader(writer.buffer).hash();
    expect(hashes().at(-1)).toBe(settled);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-2), 100, 100, 299, 149);
    await h.play(600);
    expect(hashes().at(-1)).toBeNull(); // changed since the last telemetry
    await h.play(600);
    expect(hashes().at(-1)).toBe(new GraphicsPlaneReader(writer.buffer).hash());
    expect(hashes().at(-1)).not.toBe(settled);

    const plain = await menuShown();
    await plain.h.play(1200);
    expect(lastTelemetry(plain.h)?.bdjPlane).toEqual({ flushes: expect.any(Number), tapsIgnored: 0 });
  });

  it("telemetry carries BD-J's memory, from the worker's reports and the engine's buffers, only when asked (test-only)", async () => {
    const { h, w } = await menuShown({ memoryTelemetry: true });
    expect(w.sent.find((m) => m.type === 'boot')).toMatchObject({ memoryStatsMs: 5000 });
    await h.play(600);
    expect(lastTelemetry(h)?.bdjMemory).toEqual({ jvm: null, freeType: null, planeBytes: (16 + 1920 * 1080) * 4, stillBytes: 0, compositorBytes: 0 });
    const jvm = { bootJarBytes: 1, classes: 2, classFileBytes: 3, zipHandles: 4, zipBytes: 5, vfsFiles: 6, vfsBytes: 7, vfsUsedBytes: 8, jdkFileBytes: 9 };
    w.emit({ type: 'memory', jvm, freeType: { wasmBytes: 2097152, faces: 1 } });
    await h.play(600);
    expect(lastTelemetry(h)?.bdjMemory).toMatchObject({ jvm, freeType: { wasmBytes: 2097152, faces: 1 } });

    const plain = await menuShown();
    expect(plain.w.sent.find((m) => m.type === 'boot')).not.toHaveProperty('memoryStatsMs');
    await plain.h.play(600);
    expect(lastTelemetry(plain.h)).not.toHaveProperty('bdjMemory');
  });

  it('reports the BD-J menu turning visible and empty, on changes only, and empty when BD-J stops', async () => {
    const { h, writer } = await menuShown();
    const menu = (): boolean[] => h.events.flatMap((e) => (e.type === 'bdjMenu' ? [e.visible] : []));
    expect(menu()).toEqual([true]);
    await h.play(50);
    expect(menu()).toEqual([true]);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080), 100, 100, 299, 149);
    await h.play(20);
    expect(menu()).toEqual([true, false]);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 0, 0, 9, 9);
    await h.play(20);
    expect(menu()).toEqual([true, false, true]);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    expect(menu()).toEqual([true, false, true, false]);
    const order = h.events.filter((e) => e.type === 'bdjMenu' || e.type === 'bdjActive').slice(-2);
    expect(order).toEqual([{ type: 'bdjMenu', visible: false }, { type: 'bdjActive', active: false }]);
  });

  const TAP_MESSAGE = "This disc's menu doesn't respond to taps here. Use the remote.";
  const tapNotices = (h: Harness): number => h.events.filter((e) => e.type === 'notice' && e.code === 'bdj-tap-ignored').length;
  const ignoredTaps = (h: Harness): number => h.events.filter((e) => e.type === 'bdjTapIgnored').length;

  it('opens the remote on a tap the menu ignores, with the notice once per menu (desktop: 0.2 s)', async () => {
    const t = manualTimers();
    const { h, writer } = await menuShown({ setTimer: t.setTimer });
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    expect(t.armed(200)).toHaveLength(1);
    t.fire(200);
    expect(ignoredTaps(h)).toBe(1);
    expect(h.events).toContainEqual({ type: 'notice', code: 'bdj-tap-ignored', message: TAP_MESSAGE });
    // the same menu: the remote opens again, without the notice
    await h.player.handle({ type: 'pointer', kind: 'click', x: 10, y: 10 });
    t.fire(200);
    expect([ignoredTaps(h), tapNotices(h)]).toEqual([2, 1]);
    // the plane is cleared, then a menu shows again: a new menu, whose first ignored tap has the notice
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080), 100, 100, 299, 149);
    await h.play(20);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 0, 0, 9, 9);
    await h.play(20);
    await h.player.handle({ type: 'pointer', kind: 'click', x: 10, y: 10 });
    t.fire(200);
    expect([ignoredTaps(h), tapNotices(h)]).toEqual([3, 2]);
  });

  it('counts ignored taps in telemetry per disc: a new open starts again from 0', async () => {
    const t = manualTimers();
    const { h, w } = await menuShown({ setTimer: t.setTimer });
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    t.fire(200);
    await h.play(600);
    expect(lastTelemetry(h)?.bdjPlane?.tapsIgnored).toBe(1);
    const boots = w.sent.filter((m) => m.type === 'boot').length;
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(bdjDisc()) } });
    await vi.waitFor(() => expect(w.sent.filter((m) => m.type === 'boot').length).toBe(boots + 1));
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.filter((m) => m.type === 'start').length).toBe(2));
    await h.play(600);
    expect(lastTelemetry(h)?.bdjPlane?.tapsIgnored).toBe(0);
  });

  it('waits 0.5 s on the constrained memory profile', async () => {
    const t = manualTimers();
    const { h } = await menuShown({ setTimer: t.setTimer });
    await h.player.handle({ type: 'setMemoryProfile', profile: 'constrained' });
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    expect(t.armed(200)).toHaveLength(0);
    expect(t.armed(500)).toHaveLength(1);
    t.fire(500);
    expect(tapNotices(h)).toBe(1);
  });

  it('says nothing when the menu reacts within the window: a flush, a control call or a register write', async () => {
    const t = manualTimers();
    const { h, w, writer } = await menuShown({ setTimer: t.setTimer });
    // a flush
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-2), 100, 100, 299, 149);
    t.fire(200);
    // a control call
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    w.emit({ type: 'call', id: 1, name: 'selectRate', args: [1, START] });
    t.fire(200);
    // a register write
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    w.emit({ type: 'call', id: 2, name: 'writeReg', args: [0, 5, 42, 0] });
    t.fire(200);
    expect([ignoredTaps(h), tapNotices(h)]).toEqual([0, 0]);
    const boot = w.sent.find((m) => m.type === 'boot');
    if (boot?.type !== 'boot') throw new Error('no boot');
    expect(new SharedRegisterView(boot.registers).gprRead(5)).toBe(42);
  });

  it('does not count a reaction that came just before the tap', async () => {
    const t = manualTimers();
    const { h, w, writer } = await menuShown({ setTimer: t.setTimer });
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-2), 100, 100, 299, 149);
    w.emit({ type: 'call', id: 1, name: 'writeReg', args: [0, 5, 42, 0] });
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    t.fire(200);
    expect([ignoredTaps(h), tapNotices(h)]).toEqual([1, 1]);
  });

  it('a second tap within the window replaces the first: one bdjTapIgnored', async () => {
    const t = manualTimers();
    const { h } = await menuShown({ setTimer: t.setTimer });
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    await h.player.handle({ type: 'pointer', kind: 'click', x: 961, y: 540 });
    expect(t.armed(200)).toHaveLength(1);
    t.fire(200);
    expect([ignoredTaps(h), tapNotices(h)]).toEqual([1, 1]);
  });

  it('forwards a click on an empty plane without watching it: no remote, no notice (Review Focus 3)', async () => {
    const t = manualTimers();
    const { h, w } = await startedHandWith({ setTimer: t.setTimer });
    const from = w.sent.length;
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    expect(inputSent(w, from)).toHaveLength(2);
    expect(t.armed(200)).toHaveLength(0);
    expect([ignoredTaps(h), tapNotices(h)]).toEqual([0, 0]);
  });

  it('drops a tap still waiting for its reaction when BD-J stops', async () => {
    const t = manualTimers();
    const { h } = await menuShown({ setTimer: t.setTimer });
    await h.player.handle({ type: 'pointer', kind: 'click', x: 960, y: 540 });
    expect(t.armed(200)).toHaveLength(1);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    expect(t.armed(200)).toHaveLength(0);
    expect([ignoredTaps(h), tapNotices(h)]).toEqual([0, 0]);
  });

  /** Stand-in ImageBitmaps named after the bytes they were decoded from; `hold()` makes the next decodes wait for `release()`. */
  function bitmaps() {
    const made: { name: string; closed: boolean }[] = [];
    let gate: Promise<void> = Promise.resolve();
    let open: () => void = () => undefined;
    const decode: DecodeImage = async (bytes) => {
      await gate;
      const b = { name: String.fromCharCode(...bytes), width: 1920, height: 1080, closed: false, close: () => void (b.closed = true) };
      made.push(b);
      return b as unknown as ImageBitmap;
    };
    return {
      made,
      decode,
      hold: () => void (gate = new Promise((r) => (open = r))),
      release: () => open(),
    };
  }

  const still = (name: string): FromBdj => ({ type: 'background', image: new TextEncoder().encode(name), rect: { x: 0, y: 0, width: 1, height: 1 } });

  /** A menu shown by a hand-driven worker, whose Java then asked for the still 'bg' under it. */
  async function backgroundShown() {
    const img = bitmaps();
    const w = handWorker();
    const rec = recordingCompositor();
    const h = await harness(bdjDisc(), { worker: w.worker, compositor: rec.compositor, decodeImage: img.decode });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    if (boot.type !== 'boot') throw new Error('no boot');
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    const writer = new GraphicsPlaneWriter(boot.plane);
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 100, 100, 299, 149);
    await h.play(50);
    const at = rec.calls.length;
    w.emit(still('bg'));
    await vi.waitFor(() => expect(img.made).toHaveLength(1));
    await h.play(20);
    // the still goes under the video, and the picture is repainted although no playlist plays
    expect(rec.calls.slice(at)).toEqual(['setBackground:bg', 'drawVideo', 'drawBdj']);
    return { h, w, rec, writer, img };
  }

  it("shows Java's background still under the video and the plane, with no playlist playing", async () => {
    const { h, w, rec, img } = await backgroundShown();
    // a newer still replaces it; the old bitmap is closed once the compositor has the new one
    const at = rec.calls.length;
    w.emit(still('bg2'));
    await vi.waitFor(() => expect(img.made).toHaveLength(2));
    await h.play(20);
    expect(rec.calls.slice(at)).toEqual(['setBackground:bg2', 'drawVideo', 'drawBdj']);
    expect(img.made.map((b) => b.closed)).toEqual([true, false]);
    // Java's displayImage(null) takes it down
    w.emit({ type: 'background', image: null, rect: { x: 0, y: 0, width: 1, height: 1 } });
    await h.play(20);
    expect(rec.calls.slice(-3)).toEqual(['setBackground:null', 'drawVideo', 'drawBdj']);
    expect(img.made[1]!.closed).toBe(true);
  });

  /** After `leave`, the background still goes with the plane, in the same repaint, and its bitmap is closed. */
  async function backgroundClearedBy(leave: (h: Harness, w: ReturnType<typeof handWorker>) => Promise<void>): Promise<void> {
    const { h, w, rec, img } = await backgroundShown();
    const at = rec.calls.length;
    await leave(h, w);
    expect(rec.calls.slice(at, at + 3)).toEqual(['setBackground:null', 'clearBdj', 'drawVideo']);
    expect(img.made[0]!.closed).toBe(true);
    // a still the dying worker still sends is not shown
    w.emit(still('late'));
    await h.play(200);
    expect(rec.calls.slice(at).filter((c) => c.startsWith('setBackground:') && c !== 'setBackground:null')).toEqual([]);
    expect(img.made).toHaveLength(1);
  }

  it('clears the background still at once when the user picks a playlist in the picker', async () => {
    await backgroundClearedBy((h) => h.player.handle({ type: 'playPlaylist', playlistId: '00001' }));
  });

  it('clears the background still at once when the disc closes', async () => {
    await backgroundClearedBy((h) => h.player.handle({ type: 'close' }));
  });

  it('clears the background still at once when BD-J fails', async () => {
    await backgroundClearedBy(async (_h, w) => w.emit({ type: 'failed', code: 'internal', message: 'boom' }));
  });

  it('clears the background still at once when another disc opens', async () => {
    const other = buildSyntheticDisc({ clips: [syntheticClip('00009', 4, { audio: CodingType.LPCM })], playlists: [{ id: '00009', clipIds: ['00009'] }] });
    await backgroundClearedBy((h) => h.player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(other) } }));
  });

  it('closes a still whose decode finishes after BD-J stopped, without showing it', async () => {
    const img = bitmaps();
    img.hold();
    const w = handWorker();
    const rec = recordingCompositor();
    const h = await harness(bdjDisc(), { worker: w.worker, compositor: rec.compositor, decodeImage: img.decode });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    w.emit(still('slow'));
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    img.release();
    await vi.waitFor(() => expect(img.made).toHaveLength(1));
    await h.play(50);
    expect(img.made[0]!.closed).toBe(true);
    expect(rec.calls.filter((c) => c.startsWith('setBackground'))).toEqual([]);
  });

  it('a playlist Java asked for that is still loading when the disc closes never opens afterwards', async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(lastState(h)).toBe('loading');
    await h.player.handle({ type: 'close' });
    const at = h.events.length;
    await h.play(500);
    const after = h.events.slice(at).map((e) => e.type);
    expect(after).not.toContain('chapters');
    expect(after).not.toContain('tracks');
    expect(after).not.toContain('state');
    expect(lastState(h)).toBe('idle');
  });

  it('a playlist Java asked for that is still loading when another disc opens never plays on the new disc', async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(lastState(h)).toBe('loading');
    const other = buildSyntheticDisc({ clips: [syntheticClip('00009', 4, { audio: CodingType.LPCM })], playlists: [{ id: '00009', clipIds: ['00009'] }] });
    const at = h.events.length;
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(other) } });
    await h.play(500);
    expect(h.events.slice(at).some((e) => e.type === 'chapters' || e.type === 'tracks')).toBe(false);
    expect(lastState(h)).toBe('idle');
  });

  it('a second Java playlist still loading when BD-J fails during playback never starts', async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    await until(h, () => playlistsPlayed(h).length === 1 && lastState(h) === 'paused');
    w.emit({ type: 'call', id: 2, name: 'selectPlaylist', args: [1, -1, -1, '-1'] });
    w.emit({ type: 'failed', code: 'internal', message: 'boom' });
    await h.play(500);
    expect(playlistsPlayed(h)).toEqual(['00000']);
    expect(notices(h)).toContain('bdj-failed');
  });

  it("plays a playlist once loaded when Java's START came while it was still loading", async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(lastState(h)).toBe('loading');
    w.emit({ type: 'call', id: 2, name: 'selectRate', args: [1, START] });
    await until(h, () => lastState(h) === 'playing' && playlistsPlayed(h).length === 1, 10_000);
  }, 30_000);

  it('falls back to the picker with bdj-failed when BD-J cannot boot', async () => {
    const z = ZipArchive.open(CLASSES.libbluray);
    const entries = z.names.filter((n) => n !== 'org/videolan/Libbluray.class').map((n) => [n, z.read(n)!] as const);
    const h = await harness(bdjDisc(), { classes: { ...CLASSES, libbluray: storedZip(entries) } });
    await until(h, () => notices(h).includes('bdj-failed'));
    const failed = h.events.find((e) => e.type === 'notice' && e.code === 'bdj-failed');
    expect(failed).toMatchObject({ message: expect.stringMatching(/^BD-J couldn't start this disc \(class-not-found: .*org\/videolan\/Libbluray.*\)\. Choose a playlist to play\.$/) });
    expect(h.events).toContainEqual({ type: 'bdjActive', active: false });
    expect(h.terminated()).toBe(true);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await until(h, () => lastState(h) === 'playing');
    await h.play(600);
    // a playlist the user chose is not Java's first playlist
    expect(lastTelemetry(h)?.bdj).toEqual({ bootMs: null, firstPlaylistMs: null, firstFrameMs: null, inputLatencyMs: null });
  }, 90_000);

  it('falls back to the picker with bdj-failed on an unreadable libbluray jar (the browser\'s ?bdjfail=1 hook)', async () => {
    const h = await harness(bdjDisc(), { classes: { ...CLASSES, libbluray: new Uint8Array(0) } });
    await until(h, () => notices(h).includes('bdj-failed'));
    expect(h.events).toContainEqual({ type: 'bdjActive', active: false });
    expect(lastState(h)).toBe('idle');
  }, 90_000);

  it("follows Java's PSR1 write with the audio track", async () => {
    const h = await playing();
    expect(h.events.filter((e) => e.type === 'tracks').at(-1)).toMatchObject({ selectedAudio: 1 });
    h.inject({ type: 'call', id: 9001, name: 'writeReg', args: [1, 1, 2, -1] });
    await until(h, () => h.events.filter((e) => e.type === 'tracks').at(-1)?.type === 'tracks' && (h.events.filter((e) => e.type === 'tracks').at(-1) as { selectedAudio: number }).selectedAudio === 2);
    expect(bdjEvents(h, BdjEvent.AUDIO_STREAM)).toContain(2);
  }, 90_000);

  it("hands an HDMV program's BD-J title to BD-J, and a BD-J selectTitle of an HDMV title back to the navigator", async () => {
    const movieObjects = buildMovieObjects([{ cmds: [asm.jumpTitle(imm(1))] }, { cmds: [asm.playPl(imm(1))] }]);
    const files = bdjDisc({
      movieObjects,
      index: { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'bdj', name: '00001' }, { kind: 'hdmv', movieObjectId: 1 }] },
    });
    const h = await playing(files);
    expect(playlistsPlayed(h)).toEqual(['00000']); // TitleXlet's playlist
    expect(h.sent.filter((m) => m.type === 'start')).toEqual([{ type: 'start', title: 1 }]);
    h.inject({ type: 'call', id: 9001, name: 'selectTitle', args: [2] });
    await until(h, () => playlistsPlayed(h).at(-1) === '00001' && lastState(h) === 'playing');
    expect(h.terminated()).toBe(true);
    expect(h.events.filter((e) => e.type === 'bdjActive').at(-1)).toEqual({ type: 'bdjActive', active: false });
  }, 90_000);

  it('disc-bdj-mixed: First Play (BD-J) selects HDMV title 1, whose playlist ends in JumpTitle 2 (BD-J), which plays 00001', async () => {
    const h = await harness(fixtureDiscFiles('disc-bdj-mixed'));
    await until(h, () => playlistsPlayed(h).at(-1) === '00001' && lastState(h) === 'playing');
    expect(playlistsPlayed(h)).toEqual(['00000', '00001']);
    expect(h.sent.filter((m) => m.type === 'start')).toEqual([
      { type: 'start', title: 0xffff },
      { type: 'start', title: 2 },
    ]);
    expect(h.events.flatMap((e) => (e.type === 'bdjActive' ? [e.active] : []))).toEqual([true, false, true]);
    expect(notices(h)).not.toContain('bdj-failed');
  }, 90_000);
});
