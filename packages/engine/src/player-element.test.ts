// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { fixtureDiscFiles } from '../../../tests/helpers/fixture-disc';
import { discEntries } from '../../../tests/helpers/synthetic-disc';
import { Control, createRing, renderQuantum, ringViews } from './audio/ring';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
import { ClockBlockReader, createClockBlock } from './element/clock-block';
import { Player } from './player';
import type { EngineEvent, PlaybackState, Telemetry } from './protocol';

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
  /** The page reports each segment's end as its buffered end (true by default), as it does after an append. */
  autoBuffered?: boolean;
  /** Instead, the page reports this buffered end after each segment, at once. */
  reportEndUs?: { value: number };
  /** Attach an audio ring (true by default); without it the clock is the wall clock. */
  audio?: boolean;
  /** The video path the page asks for ('element' by default). */
  path?: 'element' | 'canvas' | 'auto';
  /** The memory profile (desktop by default). */
  memory?: 'constrained';
}

async function harness(opts: Options = {}) {
  decoders.length = 0;
  const events: EngineEvent[] = [];
  const transfers: Transferable[][] = [];
  const clock = { ms: 1000 };
  const drawn: Array<string> = [];
  const elementStarts: Array<{ picture: boolean; element?: { width: number; height: number } }> = [];
  let player!: Player;
  const autoBuffered = opts.autoBuffered ?? true;
  /** The last videoReset's generation, which the fake page echoes. */
  const page = { generation: 0, appendedEndUs: -Infinity };
  player = new Player({
    emit: (e, transfer) => {
      events.push(e);
      if (transfer) transfers.push(transfer);
      // the fake page: answers the query and reports what it buffered after each append
      if (e.type === 'videoElementQuery' && opts.playable !== null) {
        const playable = opts.playable ?? true;
        queueMicrotask(() => void player.handle({ type: 'videoElementAnswer', codec: e.codec, playable }));
      }
      if (e.type === 'videoReset') {
        page.generation = e.generation;
        page.appendedEndUs = -Infinity;
      }
      if (e.type === 'videoSegment') page.appendedEndUs = Math.max(page.appendedEndUs, e.endUs);
      if (e.type === 'videoSegment' && opts.reportEndUs) void player.handle({ type: 'videoBuffered', endUs: opts.reportEndUs.value, generation: page.generation });
      else if (e.type === 'videoSegment' && autoBuffered) {
        const endUs = e.endUs;
        const generation = page.generation;
        queueMicrotask(() => void player.handle({ type: 'videoBuffered', endUs, generation }));
      }
    },
    videoCodecApi: fakeApi,
    nowMs: () => clock.ms,
    elementEpochMs: () => 1_700_000_000_000 + clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: noWasm,
    createCompositor: () => ({
      resize: () => undefined,
      drawVideo: (f) => drawn.push(`video:${f?.timestamp ?? null}`),
      startPlaylist: (picture, o) => elementStarts.push({ picture, ...(o?.element ? { element: o.element } : {}) }),
    }),
  });
  const ring = createRing(48_000, 2);
  const views = ringViews(ring);
  const clockBlock = createClockBlock();
  if (opts.memory) await player.handle({ type: 'setMemoryProfile', profile: opts.memory });
  if (opts.audio !== false) await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  await player.handle({ type: 'setVideoPath', path: opts.path ?? 'element' });
  await player.handle({ type: 'attachVideoElement', clock: clockBlock });
  await player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(opts.files ?? fixtureDiscFiles('disc1')) } });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    page,
    /** The page reports a buffered end under its current generation. */
    buffered: (endUs: number) => player.handle({ type: 'videoBuffered', endUs, generation: page.generation }),
    stalled: () => player.handle({ type: 'videoStalled', generation: page.generation }),
    /** What the page does on a stall (ruling R10): videoStalled, then at once its buffered report, with no append. */
    pageStall: async () => {
      await player.handle({ type: 'videoStalled', generation: page.generation });
      await player.handle({ type: 'videoBuffered', endUs: page.appendedEndUs, generation: page.generation });
    },
    events,
    transfers,
    drawn,
    elementStarts,
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

  it('reports the element path in telemetry, with the offsets and frame totals the page posts', async () => {
    const h = await harness();
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilState(h, 'playing');
    await h.player.handle({ type: 'videoSync', offsetsUs: [1000, -3000], presented: 50, dropped: 2 });
    await h.play(600);
    const t = telemetries(h).find((x) => x.avOffsetMeanUs === -1000);
    expect(t).toMatchObject({ videoPath: 'element', avOffsetMaxAbsUs: 3000, framesInWindow: 2, framesPresented: 50, framesDropped: 2 });
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
    await h.player.handle({ type: 'videoBuffered', endUs: 6_000_000, generation: oldGeneration });
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
});
