// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { fixtureDiscFiles } from '../../../tests/helpers/fixture-disc';
import { discEntries } from '../../../tests/helpers/synthetic-disc';
import { Control, createRing, renderQuantum, ringViews } from './audio/ring';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
import { ClockBlockReader, createClockBlock } from './element/clock-block';
import { Player } from './player';
import { UNAVAILABLE, type CompiledSet, type ShaderBackend } from './shaders/webgl-backend';
import type { ElementCheck, EngineEvent, PlaybackState, Telemetry } from './protocol';

/** WebCodecs decoders the engine created (the canvas path). */
const decoders: VideoDecoderLike[] = [];

class FakeDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  constructor(private readonly init: VideoDecoderInit) {
    decoders.push(this);
  }
  configure(): void {
    this.state = 'configured';
  }
  decode(chunk: EncodedVideoChunk): void {
    const { timestamp } = chunk as unknown as EncodedVideoChunkInit;
    this.init.output({ timestamp, codedWidth: 320, displayWidth: 320, displayHeight: 180, close: () => undefined } as unknown as VideoFrame);
  }
  async flush(): Promise<void> {}
  reset(): void {
    this.state = 'unconfigured';
  }
  close(): void {
    this.state = 'closed';
  }
}

const fakeApi: VideoCodecApi = {
  create: (init) => new FakeDecoder(init),
  isConfigSupported: async (config) => ({ supported: true, config }),
  makeChunk: (init) => init as unknown as EncodedVideoChunk,
};

const noWasm = createAudioDecoderFactory(() => Promise.reject(new Error('no wasm in unit tests')));

/** 5 render quanta = 640 frames at 48 kHz. */
const STEP_MS = 640 / 48;

interface Options {
  /** The disc's files: disc1 by default (real H.264 with LPCM audio). */
  files?: Map<string, Uint8Array<ArrayBuffer>>;
  /** The page's answer to videoElementQuery; null never answers. */
  playable?: boolean | null;
  /** What the page says it found when it asked the browser, sent with its answer. */
  check?: ElementCheck;
  /** The page reports each segment's end as its buffered end (true by default), as it does after an append. */
  autoBuffered?: boolean;
  /** Instead, the page reports this buffered end after each segment, at once. */
  reportEndUs?: { value: number };
  /** Attach an audio ring (true by default); without it the clock is the wall clock. */
  audio?: boolean;
  /** The video path the page asks for ('element' by default); null sends no setVideoPath (the engine's default). */
  path?: 'element' | 'canvas' | 'auto' | null;
  /** The memory profile (desktop by default). */
  memory?: 'constrained';
  /** The page attaches its element only when the test does (attach()), as a page that mounts its player late does. */
  attachLate?: boolean;
  /** Whether WebCodecs can configure an HEVC decoder (true by default). */
  webcodecsHevc?: boolean;
  /** A shader set is on before the disc opens. */
  shaders?: boolean;
  /** Whether shaders can run here: a backend (the default), or none (WebGL2 or float targets missing). */
  shaderBackend?: 'available' | 'unavailable';
}

/** A shader backend that compiles nothing (a set stays compiling): enough for the stage to count as available. */
const fakeShaderBackend: ShaderBackend = { compile: () => new Promise<CompiledSet>(() => undefined), render: () => { throw new Error('unused'); } };

/** A shader set to turn on. */
const SHADER_SET = { name: 'Test set', files: [] };

async function harness(opts: Options = {}) {
  decoders.length = 0;
  const events: EngineEvent[] = [];
  const transfers: Transferable[][] = [];
  const clock = { ms: 1000 };
  const drawn: Array<string> = [];
  const elementStarts: Array<{ picture: boolean; element?: { width: number; height: number } }> = [];
  /** How many times the compositor was told an element frame shows. */
  const framesShown = { count: 0 };
  let player!: Player;
  const autoBuffered = opts.autoBuffered ?? true;
  /** The last videoReset's generation, which the fake page echoes. */
  const page = { generation: 0, appendedEndUs: -Infinity, segments: 0, attached: !opts.attachLate };
  player = new Player({
    emit: (e, transfer) => {
      events.push(e);
      if (transfer) transfers.push(transfer);
      // the fake page: answers the query and reports what it buffered after each append
      // (as the real page: only an attached element's output answers)
      if (e.type === 'videoElementQuery' && opts.playable !== null && page.attached) {
        const playable = opts.playable ?? true;
        const { type: _type, ...query } = e;
        queueMicrotask(() => void player.handle({ type: 'videoElementAnswer', ...query, playable, ...(opts.check ? { check: opts.check } : {}) }));
      }
      if (e.type === 'videoReset') {
        page.generation = e.generation;
        page.appendedEndUs = -Infinity;
        page.segments = 0;
      }
      if (e.type === 'videoSegment') {
        page.appendedEndUs = Math.max(page.appendedEndUs, e.endUs);
        page.segments++;
      }
      if (e.type === 'videoSegment' && opts.reportEndUs) void player.handle({ type: 'videoBuffered', endUs: opts.reportEndUs.value, segments: page.segments, generation: page.generation });
      else if (e.type === 'videoSegment' && autoBuffered) {
        const endUs = e.endUs;
        const generation = page.generation;
        const segments = page.segments;
        queueMicrotask(() => void player.handle({ type: 'videoBuffered', endUs, segments, generation }));
      }
    },
    videoCodecApi: opts.webcodecsHevc === false
      ? { ...fakeApi, isConfigSupported: async (config) => ({ supported: !/^hev1|^hvc1/.test(config.codec), config }) }
      : fakeApi,
    nowMs: () => clock.ms,
    elementEpochMs: () => 1_700_000_000_000 + clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: noWasm,
    createShaderBackend: () => ((opts.shaderBackend ?? 'available') === 'available' ? fakeShaderBackend : UNAVAILABLE),
    createCompositor: () => ({
      resize: () => undefined,
      drawVideo: (f) => drawn.push(`video:${(f as VideoFrame | null)?.timestamp ?? null}`),
      startPlaylist: (picture, o) => elementStarts.push({ picture, ...(o?.element ? { element: o.element } : {}) }),
      elementFrameShown: () => framesShown.count++,
    }),
  });
  const ring = createRing(48_000, 2);
  const views = ringViews(ring);
  const clockBlock = createClockBlock();
  if (opts.memory) await player.handle({ type: 'setMemoryProfile', profile: opts.memory });
  if (opts.audio !== false) await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  if (opts.path !== null) await player.handle({ type: 'setVideoPath', path: opts.path ?? 'element' });
  if (opts.shaders) await player.handle({ type: 'setVideoShaders', set: SHADER_SET });
  if (!opts.attachLate) await player.handle({ type: 'attachVideoElement', clock: clockBlock });
  await player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(opts.files ?? fixtureDiscFiles('disc1')) } });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    page,
    attach: async () => {
      page.attached = true;
      await player.handle({ type: 'attachVideoElement', clock: clockBlock });
    },
    /** The page reports a buffered end under its current generation. */
    buffered: (endUs: number) => player.handle({ type: 'videoBuffered', endUs, segments: page.segments, generation: page.generation }),
    stalled: () => player.handle({ type: 'videoStalled', generation: page.generation }),
    /** What the page does on a stall (ruling R10): videoStalled, then at once its buffered report, with no append. */
    pageStall: async () => {
      await player.handle({ type: 'videoStalled', generation: page.generation });
      await player.handle({ type: 'videoBuffered', endUs: page.appendedEndUs, segments: page.segments, generation: page.generation });
    },
    events,
    transfers,
    drawn,
    elementStarts,
    framesShown,
    clock,
    clockReader: new ClockBlockReader(clockBlock),
    epochMs: () => 1_700_000_000_000 + clock.ms,
    ringPlaying: () => Atomics.load(views.control, Control.Playing) === 1,
    async play(ms: number): Promise<void> {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
        player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const states = (h: Harness): PlaybackState[] => h.events.flatMap((e) => (e.type === 'state' ? [e.state] : []));
const lastState = (h: Harness): PlaybackState | undefined => states(h).at(-1);
const telemetries = (h: Harness): Telemetry[] => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : []));
const ofType = <T extends EngineEvent['type']>(h: Harness, type: T): Array<Extract<EngineEvent, { type: T }>> =>
  h.events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
const clockNow = (h: Harness): number => h.clockReader.clockAt(h.epochMs()) ?? 0;

async function untilState(h: Harness, state: PlaybackState, timeout = 5000): Promise<void> {
  await vi.waitFor(
    async () => {
      await h.play(100);
      expect(lastState(h)).toBe(state);
    },
    { timeout },
  );
}

describe('Player on the element path', () => {
  it('plays disc1 through the video element: a query, a reset, an init and segments covering the playlist, no decoder', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await untilState(h, 'ended', 25_000);
    const types = h.events.map((e) => e.type);
    const query = types.indexOf('videoElementQuery');
    const reset = types.indexOf('videoReset');
    const init = types.indexOf('videoInit');
    expect(query).toBeGreaterThanOrEqual(0);
    expect(query).toBeLessThan(reset);
    expect(reset).toBeLessThan(init);
    expect(ofType(h, 'videoElementQuery')[0]!.codec).toMatch(/^avc1\./);
    expect(ofType(h, 'videoReset')[0]).toEqual({ type: 'videoReset', startUs: 0, paused: false, generation: expect.any(Number) });
    expect(ofType(h, 'videoInit')[0]).toMatchObject({ codec: expect.stringMatching(/^avc1\./), width: expect.any(Number), height: expect.any(Number) });
    const segments = ofType(h, 'videoSegment');
    expect(segments.length).toBeGreaterThan(2);
    expect(segments[0]!.startUs).toBeLessThan(50_000);
    expect(segments.at(-1)!.endUs).toBeGreaterThan(7_900_000);
    expect(types).toContain('videoEnded');
    expect(decoders).toHaveLength(0);
    // the segment bytes are transferred to the page
    expect(h.transfers.some((t) => t[0] === segments[0]!.bytes.buffer)).toBe(true);
    // the compositor goes transparent at the stream's size
    expect(h.elementStarts.at(-1)).toMatchObject({ picture: true, element: { width: expect.any(Number), height: expect.any(Number) } });
  }, 30_000);

  it('plays on the canvas path when the page says the element cannot play the codec', async () => {
    const h = await harness({ playable: false });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(500);
    expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
    expect(ofType(h, 'videoInit')).toHaveLength(0);
    expect(ofType(h, 'videoReset')).toHaveLength(0);
    expect(decoders.length).toBeGreaterThan(0);
    expect(h.drawn.some((d) => d !== 'video:null')).toBe(true);
    expect(telemetries(h).at(-1)?.videoPath).toBe('canvas');
  });

  it('plays on the canvas path when the page does not answer within 2 s', async () => {
    const h = await harness({ playable: null });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing', 6000);
    expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
    expect(ofType(h, 'videoInit')).toHaveLength(0);
    expect(decoders.length).toBeGreaterThan(0);
  }, 10_000);

  it('takes the element path when the page attaches its element after the playlist started (a disc that plays on open)', async () => {
    const h = await harness({ attachLate: true });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.play(300); // the first unit comes and the question goes out, to a page with no element yet
    expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
    expect(ofType(h, 'videoInit')).toHaveLength(0);
    await h.attach(); // the question is asked again of the element now attached
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(2);
    expect(ofType(h, 'videoInit')).toHaveLength(1);
    expect(decoders.every((d) => d.state !== 'configured')).toBe(true);
    await h.play(600); // a telemetry window from the element session
    expect(telemetries(h).at(-1)?.videoPath).toBe('element');
  });

  it('plays on the canvas path with the canvas video path, asking nothing', async () => {
    const h = await harness({ path: 'canvas' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(0);
    expect(decoders.length).toBeGreaterThan(0);
  });

  it('asks once per codec: a second playlist uses the cached answer', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
    expect(ofType(h, 'videoElementStop').length).toBeGreaterThanOrEqual(1);
    expect(ofType(h, 'videoReset').length).toBeGreaterThanOrEqual(2);
  });

  it('paused seek shows the target frame', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.player.handle({ type: 'pause' });
    const before = h.events.length;
    await h.player.handle({ type: 'seek', timeUs: 5_000_000 });
    await h.play(100);
    const after = h.events.slice(before);
    expect(after).toContainEqual({ type: 'videoReset', startUs: 5_000_000, paused: true, generation: expect.any(Number) });
    // the reset comes before the new init and the segments from the target's entry
    const reset = after.findIndex((e) => e.type === 'videoReset');
    const init = after.findIndex((e) => e.type === 'videoInit');
    expect(init).toBeGreaterThan(reset);
    const seg = after.find((e) => e.type === 'videoSegment');
    expect(seg && seg.type === 'videoSegment' ? seg.startUs : -1).toBeLessThanOrEqual(5_000_000);
    expect(lastState(h)).toBe('paused');
  });

  it('holds on a stall: buffering with the ring stopped, until the element has half a second ahead again', async () => {
    const h = await harness({ autoBuffered: false });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.play(100);
    expect(lastState(h)).toBe('buffering'); // nothing buffered yet: the start-up waits for the element
    await h.buffered(3_000_000);
    await untilState(h, 'playing');
    expect(h.ringPlaying()).toBe(true);
    await h.play(300);
    await h.stalled();
    expect(lastState(h)).toBe('buffering');
    expect(h.ringPlaying()).toBe(false);
    const now = clockNow(h);
    await h.buffered(now + 200_000);
    await h.play(200);
    expect(lastState(h)).toBe('buffering'); // less than half a second ahead
    await h.player.handle({ type: 'videoResumed' });
    await h.buffered(now + 1_000_000);
    await untilState(h, 'playing');
    expect(h.ringPlaying()).toBe(true);
  });

  it('drops a stall hold on a seek', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.stalled();
    expect(lastState(h)).toBe('buffering');
    await h.player.handle({ type: 'seek', timeUs: 2_000_000 });
    await untilState(h, 'playing');
  });

  it('stops reading once the element holds the lead (10 s on desktop) past the clock', async () => {
    // paused at 0 with no audio: only the element's lead holds the reader back
    const report = { value: 10_000_000 };
    const h = await harness({ audio: false, reportEndUs: report });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.player.handle({ type: 'pause' });
    await h.play(300);
    const held = ofType(h, 'videoSegment');
    expect(held.length).toBeGreaterThan(0);
    expect(Math.max(...held.map((x) => x.endUs))).toBeLessThan(6_000_000);
    expect(ofType(h, 'videoEnded')).toHaveLength(0);
    // a lead under 10 s lets it read on, to the end
    report.value = 9_900_000;
    await h.buffered(report.value);
    await vi.waitFor(
      async () => {
        await h.play(200);
        expect(ofType(h, 'videoEnded')).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
  });

  it('reports the element path in telemetry, with the offsets, frame totals and catch-ups the page posts', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.player.handle({ type: 'videoSync', offsetsUs: [1000, -3000], presented: 50, dropped: 2, catchUps: 1 });
    await h.play(600);
    const t = telemetries(h).find((x) => x.avOffsetMeanUs === -1000);
    expect(t).toMatchObject({ videoPath: 'element', avOffsetMaxAbsUs: 3000, framesInWindow: 2, framesPresented: 50, framesDropped: 2, elementCatchUps: 1 });
  });

  it('publishes the wall clock in the clock block when the playlist has no audio: running while playing', async () => {
    const h = await harness({ audio: false });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(200);
    const r = h.clockReader.read();
    expect(r?.running).toBe(true);
    expect(r?.atEpochMs).toBe(h.epochMs());
    expect(telemetries(h).at(-1)?.clockMode).toBe('wall');
    const a = r!.clockUs;
    await h.play(200);
    expect(h.clockReader.read()!.clockUs).toBeGreaterThan(a + 150_000);
    await h.player.handle({ type: 'pause' });
    await h.play(50);
    expect(h.clockReader.read()?.running).toBe(false);
  });

  it('restarts the video at the clock when an element is attached again during an element session', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(500);
    const before = h.events.length;
    await h.player.handle({ type: 'attachVideoElement', clock: createClockBlock() });
    await h.play(100);
    const after = h.events.slice(before);
    const reset = after.find((e) => e.type === 'videoReset');
    expect(reset).toMatchObject({ type: 'videoReset', paused: false });
    expect(reset && reset.type === 'videoReset' ? reset.startUs : 0).toBeGreaterThan(300_000);
    expect(after.some((e) => e.type === 'videoInit')).toBe(true);
  });

  it('tells the page to release the element when the session ends', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.player.handle({ type: 'close' });
    expect(ofType(h, 'videoElementStop')).toHaveLength(1);
  });
  it('ignores a videoBuffered from before the latest reset (a backward seek inside the old lead)', async () => {
    const h = await harness({ autoBuffered: false, audio: false, memory: 'constrained' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.play(100);
    const oldGeneration = h.page.generation;
    await h.buffered(6_000_000);
    await untilState(h, 'playing');
    await h.play(500);
    const before = h.events.length;
    await h.player.handle({ type: 'seek', timeUs: 1_000_000 });
    expect(h.page.generation).toBeGreaterThan(oldGeneration);
    // posted by the page before it handled the reset: 5 s ahead of the clock, more than the 4 s lead
    await h.player.handle({ type: 'videoBuffered', endUs: 6_000_000, segments: 0, generation: oldGeneration });
    await h.play(300);
    expect(lastState(h)).toBe('buffering'); // nothing of the new generation is buffered yet
    const after = h.events.slice(before).flatMap((e) => (e.type === 'videoSegment' ? [e.endUs] : []));
    expect(Math.max(...after)).toBeGreaterThanOrEqual(4_000_000); // the reader went on
  });

  it('bounds reading by what was sent while the page reports nothing (no audio)', async () => {
    const h = await harness({ autoBuffered: false, audio: false, memory: 'constrained' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.play(300);
    const end = Math.max(...ofType(h, 'videoSegment').map((x) => x.endUs));
    expect(end).toBeGreaterThanOrEqual(4_000_000);
    expect(end).toBeLessThan(7_500_000); // the lead, give or take the chunk read and the GOP held when it stopped
    expect(ofType(h, 'videoEnded')).toHaveLength(0);
    expect(lastState(h)).toBe('buffering');
  });

  it('at the end of reading, starts only once the page has buffered up to the last segment', async () => {
    const h = await harness({ autoBuffered: false, audio: false }); // the audio ring would hold the reader 2 s ahead
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' }); // 4 s, shorter than the lead
    await vi.waitFor(
      async () => {
        await h.play(200);
        expect(ofType(h, 'videoEnded')).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
    await h.play(200);
    expect(lastState(h)).toBe('buffering'); // segments still on their way to the page
    await h.buffered(300_000);
    await h.play(200);
    expect(lastState(h)).toBe('buffering');
    const last = Math.max(...ofType(h, 'videoSegment').map((x) => x.endUs));
    await h.buffered(last - 10_000);
    await untilState(h, 'playing');
  }, 20_000);

  it('holds a stall after the end of reading until a fresh videoBuffered, which the page posts with the stall', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await vi.waitFor(
      async () => {
        await h.play(200);
        expect(ofType(h, 'videoEnded')).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
    await h.play(100); // every segment appended and reported; none follows
    const segments = ofType(h, 'videoSegment').length;
    // a stall alone holds the clock: the earlier reports don't count
    await h.stalled();
    expect(lastState(h)).toBe('buffering');
    await h.play(300);
    expect(lastState(h)).toBe('buffering');
    expect(h.ringPlaying()).toBe(false);
    // the page's report right after its stall: what it holds, which covers the remuxer's end
    await h.buffered(h.page.appendedEndUs);
    await untilState(h, 'playing');
    expect(ofType(h, 'videoSegment')).toHaveLength(segments);
  }, 20_000);

  it("resumes a stall after the end of reading from the page's immediate report", async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await vi.waitFor(
      async () => {
        await h.play(200);
        expect(ofType(h, 'videoEnded')).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
    await h.play(100);
    await h.pageStall();
    expect(lastState(h)).toBe('buffering');
    await untilState(h, 'playing');
  }, 20_000);

  it("resumes a stall mid-playlist, with the reader held at the lead, from the page's immediate report", async () => {
    const h = await harness({ audio: false, memory: 'constrained' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(300);
    expect(ofType(h, 'videoEnded')).toHaveLength(0); // held at the 4 s lead
    const segments = ofType(h, 'videoSegment').length;
    await h.pageStall();
    expect(lastState(h)).toBe('buffering');
    await untilState(h, 'playing');
    expect(ofType(h, 'videoSegment')).toHaveLength(segments); // nothing was appended meanwhile
  });

  it('reads again at the clock when, after a stall, the page holds nothing ahead though it appended every segment sent (an eviction)', async () => {
    const h = await harness({ audio: false, memory: 'constrained' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(300);
    expect(ofType(h, 'videoEnded')).toHaveLength(0); // the reader is held at the 4 s lead
    const generation = h.page.generation;
    const resets = ofType(h, 'videoReset').length;
    const before = h.events.length;
    const playhead = Math.round(clockNow(h));
    // the element ran dry: the browser evicted what held the playhead, so the page reports the playhead as its end
    await h.stalled();
    await h.player.handle({ type: 'videoBuffered', endUs: playhead, segments: h.page.segments, generation });
    expect(ofType(h, 'videoReset')).toHaveLength(resets + 1);
    expect(ofType(h, 'videoReset').at(-1)!.startUs).toBeGreaterThanOrEqual(playhead - 50_000);
    expect(ofType(h, 'videoReset').at(-1)!.startUs).toBeLessThanOrEqual(playhead + 50_000);
    await untilState(h, 'playing');
    // the reader went on: the video from the playhead was sent again
    const resent = h.events.slice(before).flatMap((e) => (e.type === 'videoSegment' ? [e] : []));
    expect(resent.length).toBeGreaterThan(0);
    expect(resent[0]!.startUs).toBeLessThanOrEqual(playhead + 50_000);
  });

  it('does not read again after a stall while segments sent are still on their way to the page', async () => {
    const h = await harness({ audio: false, memory: 'constrained' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(300);
    const resets = ofType(h, 'videoReset').length;
    await h.stalled();
    await h.player.handle({ type: 'videoBuffered', endUs: Math.round(clockNow(h)), segments: h.page.segments - 1, generation: h.page.generation });
    expect(ofType(h, 'videoReset')).toHaveLength(resets);
  });

  it('reopens at the same time on the canvas path when the element fails mid-play, says so, and keeps the canvas for the disc', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(1000);
    const at = clockNow(h);
    expect(decoders).toHaveLength(0);
    const drawnBefore = h.drawn.length;
    await h.player.handle({ type: 'videoElementFailed', message: 'the browser refused to play the video element (NotAllowedError: no)', generation: h.page.generation });
    expect(ofType(h, 'videoElementStop')).toHaveLength(1);
    expect(h.elementStarts.at(-1)).toEqual({ picture: true }); // the canvas is opaque again
    expect(ofType(h, 'notice').filter((n) => n.code === 'element-failed')).toHaveLength(1);
    await untilState(h, 'playing');
    await h.play(600);
    expect(decoders).toHaveLength(1);
    const frames = h.drawn.slice(drawnBefore).flatMap((d) => (d.startsWith('video:') && d !== 'video:null' ? [Number(d.slice(6))] : []));
    expect(frames.length).toBeGreaterThan(0);
    expect(Math.min(...frames)).toBeGreaterThanOrEqual(at - 600_000); // from where it was, not the playlist's start
    const t = telemetries(h).at(-1)!;
    expect(t.videoPath).toBe('canvas');
    expect(t.elementFailure).toMatch(/refused to play/);
    // the disc's next playlist takes the canvas path without asking the page
    const queries = ofType(h, 'videoElementQuery').length;
    const resets = ofType(h, 'videoReset').length;
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(queries);
    expect(ofType(h, 'videoReset')).toHaveLength(resets);
    expect(decoders).toHaveLength(2);
  }, 20_000);

  it('a failure while the element session starts up falls back too, instead of buffering for good', async () => {
    const h = await harness({ autoBuffered: false });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.play(300);
    expect(lastState(h)).toBe('buffering'); // the page has reported nothing
    await h.player.handle({ type: 'videoElementFailed', message: 'the media source did not open within 5 s', generation: h.page.generation });
    await untilState(h, 'playing');
    expect(decoders).toHaveLength(1);
  });

  it("tells the compositor when the page shows the session's first element frame, and repaints; an earlier session's report is ignored", async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    const old = h.page.generation;
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await untilState(h, 'playing');
    await h.player.handle({ type: 'videoFrameShown', generation: old });
    expect(h.framesShown.count).toBe(0);
    const drawn = h.drawn.length;
    await h.player.handle({ type: 'videoFrameShown', generation: h.page.generation });
    expect(h.framesShown.count).toBe(1);
    await h.play(100);
    expect(h.drawn.length).toBeGreaterThan(drawn);
  }, 20_000);

  it("ignores a failure the page reported for an earlier session's element, and a new disc clears the failure", async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    const old = h.page.generation;
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await untilState(h, 'playing');
    expect(h.page.generation).toBeGreaterThan(old);
    await h.player.handle({ type: 'videoElementFailed', message: 'late', generation: old });
    await h.play(600);
    expect(ofType(h, 'notice').filter((n) => n.code === 'element-failed')).toHaveLength(0);
    expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'element', elementFailure: null });
    // a failure of this session falls back; opening a disc again forgets it
    await h.player.handle({ type: 'videoElementFailed', message: 'an append failed', generation: h.page.generation });
    await untilState(h, 'playing');
    await h.play(600);
    expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'canvas', elementFailure: 'an append failed' });
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(fixtureDiscFiles('disc1')) } });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(600);
    expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'element', elementFailure: null });
  }, 20_000);
});

describe('Player choosing the path', () => {
  const hdrDisc = (): Map<string, Uint8Array<ArrayBuffer>> => fixtureDiscFiles('disc-hdr');
  const elementSessions = (h: Harness): number => ofType(h, 'videoReset').length;
  const timeAfter = (h: Harness, index: number): number | undefined => h.events.slice(index).find((e): e is Extract<EngineEvent, { type: 'time' }> => e.type === 'time')?.timeUs;

  it('auto: an HDR disc takes the element path, asking with its HDR facts, coded size and frame rate', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    const queries = ofType(h, 'videoElementQuery');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ codec: expect.stringMatching(/^hvc1\./), hdr: { transfer: 'pq', mastering: true }, width: 1920, height: 1080 });
    expect(queries[0]!.frameRate).toBeGreaterThan(23);
    expect(ofType(h, 'videoInit').length).toBeGreaterThan(0);
    expect(decoders.every((d) => d.state !== 'configured')).toBe(true);
    await h.play(600);
    expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'element', videoHdr: true });
  });

  describe('telemetry of the element question', () => {
    /** The disc-hdr fixture's SPS: BT.2020 primaries, PQ, BT.2020 non-constant luminance. */
    const hdrColour = { primaries: 9, transfer: 16, matrix: 9 };

    it("a refusal shows the question, the page's checks, the answer and the SPS colour", async () => {
      const h = await harness({ path: 'auto', files: hdrDisc(), playable: false, check: { mse: true, decodingInfo: false } });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      await h.play(600);
      expect(telemetries(h).at(-1)?.elementQuery).toEqual({
        codec: expect.stringMatching(/^hvc1\./),
        hdr: { transfer: 'pq', mastering: true },
        size: { width: 1920, height: 1080, frameRate: expect.any(Number) },
        mse: true,
        decodingInfo: false,
        answer: false,
        colour: hdrColour,
      });
    });

    it('a decodingInfo that threw shows, with the answer isTypeSupported gave', async () => {
      const h = await harness({ path: 'auto', files: hdrDisc(), playable: true, check: { mse: true, decodingInfo: 'threw' } });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      await h.play(600);
      expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'element', elementQuery: { mse: true, decodingInfo: 'threw', answer: true, colour: hdrColour } });
    });

    it('a page that does not answer in time shows as a timeout', async () => {
      const h = await harness({ path: 'auto', files: hdrDisc(), playable: null });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing', 6000);
      await h.play(600);
      expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'canvas', elementQuery: { hdr: { transfer: 'pq', mastering: true }, mse: null, decodingInfo: null, answer: 'timeout', colour: hdrColour } });
    }, 10_000);

    it('a yes shows answer true, and a cached answer for the next session shows again', async () => {
      const h = await harness({ path: 'auto', files: hdrDisc(), check: { mse: true, decodingInfo: true } });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      await h.play(600);
      expect(telemetries(h).at(-1)?.elementQuery).toMatchObject({ mse: true, decodingInfo: true, answer: true });
      await h.player.handle({ type: 'close' });
      await h.player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(hdrDisc()) } });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      await h.play(600);
      expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
      expect(telemetries(h).at(-1)?.elementQuery).toMatchObject({ mse: true, decodingInfo: true, answer: true });
    });

    it('is null on a playlist that asked nothing', async () => {
      const h = await harness({ path: 'auto' });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      await h.play(600);
      expect(telemetries(h).at(-1)?.elementQuery).toBeNull();
    });
  });

  it('auto: disc1 (SDR) takes the canvas path and asks nothing', async () => {
    const h = await harness({ path: 'auto' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(0);
    expect(elementSessions(h)).toBe(0);
    expect(decoders.length).toBeGreaterThan(0);
    expect(ofType(h, 'videoHdr')).toHaveLength(0);
  });

  describe('auto with an SDR HEVC stream', () => {
    const sdrHevc = (): Map<string, Uint8Array<ArrayBuffer>> => fixtureDiscFiles('disc-hevc-sdr');

    it('takes the element path when WebCodecs cannot decode it and the page can play it', async () => {
      const h = await harness({ path: 'auto', files: sdrHevc(), webcodecsHevc: false, playable: true });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      const queries = ofType(h, 'videoElementQuery');
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatchObject({ codec: expect.stringMatching(/^hvc1\./), hdr: null, width: 640, height: 360 });
      expect(elementSessions(h)).toBe(1);
      expect(ofType(h, 'videoHdr')).toHaveLength(0);
      expect(decoders.every((d) => d.state !== 'configured')).toBe(true);
    });

    it('keeps the canvas path when the page cannot play it either', async () => {
      const h = await harness({ path: 'auto', files: sdrHevc(), webcodecsHevc: false, playable: false });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await vi.waitFor(() => expect(ofType(h, 'unsupported').length + ofType(h, 'error').length).toBeGreaterThan(0));
      expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
      expect(elementSessions(h)).toBe(0);
    });

    it('takes the canvas path, asking nothing, when WebCodecs decodes it', async () => {
      const h = await harness({ path: 'auto', files: sdrHevc(), playable: true });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      expect(ofType(h, 'videoElementQuery')).toHaveLength(0);
      expect(elementSessions(h)).toBe(0);
      expect(decoders.length).toBeGreaterThan(0);
    });

    it('with a shader set on, takes the element path when WebCodecs cannot decode it and the page can play it', async () => {
      const h = await harness({ path: 'auto', files: sdrHevc(), webcodecsHevc: false, playable: true, shaders: true });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
      expect(elementSessions(h)).toBe(1);
      expect(ofType(h, 'error')).toHaveLength(0);
      expect(decoders.every((d) => d.state !== 'configured')).toBe(true);
    });

    it('with a shader set on, a stream WebCodecs decodes stays on the canvas, asking nothing, and turning the set off reopens nothing', async () => {
      const h = await harness({ path: 'auto', files: sdrHevc(), playable: true, shaders: true });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilState(h, 'playing');
      expect(ofType(h, 'videoElementQuery')).toHaveLength(0);
      expect(elementSessions(h)).toBe(0);
      expect(decoders.some((d) => d.state === 'configured')).toBe(true);
      const before = h.events.length;
      await h.player.handle({ type: 'setVideoShaders', set: null });
      await h.play(300);
      expect(h.events.slice(before).filter((e) => e.type === 'playlistCleared')).toHaveLength(0);
    });
  });

  it('auto: H.264 that WebCodecs decodes takes the canvas path and asks nothing, even when the page could play it', async () => {
    const h = await harness({ path: 'auto', playable: true });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(0);
    expect(elementSessions(h)).toBe(0);
  });

  it('element: disc1 asks without HDR facts and takes the element path', async () => {
    const h = await harness({ path: 'element' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')[0]).toMatchObject({ hdr: null, width: expect.any(Number), height: expect.any(Number) });
    expect(elementSessions(h)).toBe(1);
    expect(ofType(h, 'videoHdr')).toHaveLength(0);
  });

  it('canvas: the HDR disc takes the canvas path and asks nothing', async () => {
    const h = await harness({ path: 'canvas', files: hdrDisc() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(0);
    expect(elementSessions(h)).toBe(0);
  });

  it('auto: a page that says no plays the HDR disc on the canvas path, with no notice', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc(), playable: false });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
    expect(elementSessions(h)).toBe(0);
    expect(ofType(h, 'notice')).toHaveLength(0);
    expect(ofType(h, 'videoHdr')).toHaveLength(0);
  });

  it('says videoHdr true while the HDR element session plays, and false when it ends', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoHdr')).toEqual([{ type: 'videoHdr', hdr: true }]);
    await h.player.handle({ type: 'close' });
    expect(ofType(h, 'videoHdr')).toEqual([
      { type: 'videoHdr', hdr: true },
      { type: 'videoHdr', hdr: false },
    ]);
  });

  it('says videoHdr false when the HDR element session falls back to the canvas', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.player.handle({ type: 'videoElementFailed', message: 'an append failed', generation: h.page.generation });
    expect(ofType(h, 'videoHdr').map((e) => e.hdr)).toEqual([true, false]);
    await untilState(h, 'playing');
    await h.play(600);
    expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'canvas', videoHdr: false });
  });

  it("an HDR session's failure says so in the spec's words, and an SDR session's keeps its own", async () => {
    const hdr = await harness({ path: 'auto', files: hdrDisc() });
    await hdr.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(hdr, 'playing');
    await hdr.player.handle({ type: 'videoElementFailed', message: 'an append failed', generation: hdr.page.generation });
    expect(ofType(hdr, 'notice').filter((n) => n.code === 'element-failed').map((n) => n.message)).toEqual([
      "HDR video couldn't play in this browser, so it shows without HDR and its colours may look flat",
    ]);
    const sdr = await harness();
    await sdr.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(sdr, 'playing');
    await sdr.player.handle({ type: 'videoElementFailed', message: 'an append failed', generation: sdr.page.generation });
    expect(ofType(sdr, 'notice').filter((n) => n.code === 'element-failed').map((n) => n.message)).toEqual([
      'The video couldn’t play through the browser’s video player (an append failed), so it plays on the canvas.',
    ]);
  });

  it('with a shader set on at the start, the HDR disc takes the canvas path and asks nothing', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc(), shaders: true });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(0);
    expect(elementSessions(h)).toBe(0);
    expect(decoders.length).toBeGreaterThan(0);
  });

  it('with a shader set on, the HDR disc WebCodecs cannot decode takes the element path when the page can play it', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc(), shaders: true, webcodecsHevc: false });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(ofType(h, 'videoElementQuery')).toHaveLength(1);
    expect(elementSessions(h)).toBe(1);
    expect(ofType(h, 'videoHdr').map((e) => e.hdr)).toEqual([true]);
  });

  it('a shader set turned on reopens nothing while the element plays a stream WebCodecs cannot decode', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc(), webcodecsHevc: false });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    const before = h.events.length;
    await h.player.handle({ type: 'setVideoShaders', set: SHADER_SET });
    await h.play(600);
    expect(h.events.slice(before).filter((e) => e.type === 'playlistCleared')).toHaveLength(0);
    expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'element', videoHdr: true });
  });

  it('a shader set turned on during an element session reopens the playlist at the same time on the canvas path, once, with no notice', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(1500);
    const at = clockNow(h);
    const before = h.events.length;
    await h.player.handle({ type: 'setVideoShaders', set: SHADER_SET });
    await untilState(h, 'playing');
    await h.play(600);
    const after = h.events.slice(before);
    expect(after.filter((e) => e.type === 'playlistCleared')).toHaveLength(1);
    expect(after.filter((e) => e.type === 'videoElementStop')).toHaveLength(1);
    expect(after.filter((e) => e.type === 'videoReset')).toHaveLength(0);
    expect(after.filter((e) => e.type === 'notice')).toHaveLength(0);
    expect(timeAfter(h, before)).toBeGreaterThan(at - 300_000);
    expect(ofType(h, 'videoHdr').map((e) => e.hdr)).toEqual([true, false]);
    expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'canvas', videoHdr: false });
  });

  it('turning the shader set off reopens the playlist at the same time on the element path', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc(), shaders: true });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.play(1500);
    const at = clockNow(h);
    const before = h.events.length;
    await h.player.handle({ type: 'setVideoShaders', set: null });
    await untilState(h, 'playing');
    const after = h.events.slice(before);
    expect(after.filter((e) => e.type === 'playlistCleared')).toHaveLength(1);
    const reset = after.find((e): e is Extract<EngineEvent, { type: 'videoReset' }> => e.type === 'videoReset');
    expect(reset?.startUs).toBeGreaterThan(at - 300_000);
    expect(after.filter((e) => e.type === 'notice')).toHaveLength(0);
    expect(ofType(h, 'videoHdr').map((e) => e.hdr)).toEqual([true]);
  });

  it('a shader set turned on while the page is still asked keeps the HDR disc on the canvas, and turning it off reopens on the element path', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc(), attachLate: true });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await vi.waitFor(() => expect(ofType(h, 'videoElementQuery')).toHaveLength(1));
    await h.player.handle({ type: 'setVideoShaders', set: SHADER_SET });
    await h.attach();
    await untilState(h, 'playing');
    expect(elementSessions(h)).toBe(0);
    const before = h.events.length;
    await h.player.handle({ type: 'setVideoShaders', set: null });
    await untilState(h, 'playing');
    const after = h.events.slice(before);
    expect(after.filter((e) => e.type === 'playlistCleared')).toHaveLength(1);
    expect(after.filter((e) => e.type === 'videoReset')).toHaveLength(1);
    expect(ofType(h, 'videoHdr').map((e) => e.hdr)).toEqual([true]);
  });

  it('with no setVideoPath (a host without a video element) the HDR disc takes the canvas path at once, asking nothing', async () => {
    const h = await harness({ path: null, files: hdrDisc() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing', 1500);
    expect(ofType(h, 'videoElementQuery')).toHaveLength(0);
    expect(elementSessions(h)).toBe(0);
    expect(decoders.some((d) => d.state === 'configured')).toBe(true);
  });

  it('where shaders cannot run, a set turned on keeps the HDR element session, with no reopen', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc(), shaderBackend: 'unavailable' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    const before = h.events.length;
    await h.player.handle({ type: 'setVideoShaders', set: SHADER_SET });
    await h.play(600);
    const after = h.events.slice(before);
    expect(after.filter((e) => e.type === 'playlistCleared')).toHaveLength(0);
    expect(after.filter((e) => e.type === 'videoElementStop')).toHaveLength(0);
    expect(ofType(h, 'shaderStatus').at(-1)?.state).toBe('unavailable');
    expect(telemetries(h).at(-1)).toMatchObject({ videoPath: 'element', videoHdr: true });
  });

  it('where shaders cannot run, a set on at the start leaves the HDR disc on the element path', async () => {
    const h = await harness({ path: 'auto', files: hdrDisc(), shaders: true, shaderBackend: 'unavailable' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    expect(elementSessions(h)).toBe(1);
  });

  it('a shader set changed on the canvas path of an SDR disc reopens nothing', async () => {
    const h = await harness({ path: 'auto' });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    const before = h.events.length;
    await h.player.handle({ type: 'setVideoShaders', set: SHADER_SET });
    await h.player.handle({ type: 'setVideoShaders', set: null });
    await h.play(300);
    expect(h.events.slice(before).filter((e) => e.type === 'playlistCleared')).toHaveLength(0);
  });
});
