import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildSoundBdmv, type IndexSpec } from '../../tests/helpers/bdmv-builders';
import { asm, buildMovieObjects, imm } from '../../tests/helpers/hdmv-builders';
import { simpleMenuSegments } from '../../tests/helpers/ig-builders';
import { clearSegments, subtitleSegments } from '../../tests/helpers/pg-builders';
import { fakeNas, type FakeNas } from '../../tests/helpers/fake-nas';
import type { RemoteDiscSpec } from './disc/disc-spec';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { MemoryDirectory } from '../../tests/helpers/memory-fs';
import { CACHE_DIR, safeName } from './disc/read-ahead-cache';
import { CLIP_START_PTS, buildSyntheticDisc, discEntries, dummyAudioStream, lpcmStream, syntheticClip, type SyntheticAudioStream, type SyntheticDiscSpec, type SyntheticPgStream, type SyntheticPlaylistSpec, type SyntheticSubPathIg } from '../../tests/helpers/synthetic-disc';
import { readFontFile } from './ass/font-tables';
import { createFixedMeasurer } from './ass/measure';
import { Control, createRing, renderQuantum, ringViews, type RingViews } from './audio/ring';
import { findEpBefore, parseClpi, stcSpnRange } from './bdmv/clpi-parser';
import { parseMpls, type PlayItem } from './bdmv/mpls-parser';
import { CodingType } from './bdmv/stream-types';
import { createAudioDecoderFactory, type AudioDecoderFactory } from './decode/audio-decoder';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
import { OverlayPlane } from './graphics/overlay-plane';
import { RegisterFile } from './hdmv/registers';
import { Navigator } from './nav/navigator';
import { DEFAULT_CHUNK_PACKETS } from './demux/m2ts-reader';
import { SOURCE_PACKET_SIZE } from './demux/constants';
import { serveFetch } from './disc/port-fetch';
import { Player, type BdjPlaybackListener, type PlayerDeps } from './player';
import { NO_PICTURE_MESSAGE, type EngineEvent, type PlaybackState, type ShaderSetData, type Telemetry } from './protocol';
import { ShaderStage } from './shaders/stage';
import { UNAVAILABLE, type CompiledSet, type ShaderBackend } from './shaders/webgl-backend';

const decoders: FakeDecoder[] = [];
const fakeCodedWidth = { value: 320 };

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
    this.init.output({ timestamp, codedWidth: fakeCodedWidth.value, displayWidth: 320, displayHeight: 180, close: () => undefined } as unknown as VideoFrame);
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

/** 5 render quanta = 640 frames at 48 kHz. */
const STEP_MS = 640 / 48;

interface Harness {
  player: Player;
  events: EngineEvent[];
  drawn: number[];
  /** The IG planes handed to drawIg, one entry per call. */
  igDraws: OverlayPlane[];
  /** The PG planes handed to drawPg, one entry per call. */
  pgDraws: OverlayPlane[];
  /** Callbacks the engine registered with requestFrame. */
  frames: Array<() => void>;
  /** Compositor draw calls in order: `video:<timestamp|null>`, `pg`, `ig`. */
  order: string[];
  /** The shader stages handed to setShaderStage, one entry per call. */
  shaderStages: Array<ShaderStage | null>;
  /** The disc's files, to open it again. */
  entries: ReturnType<typeof discEntries>;
  /** Whether the engine has the ring in its playing state. */
  ringPlaying(): boolean;
  /** Ring frame index of the first non-silent sample of every audible quantum the fake worklet rendered. */
  audibleFrames: number[];
  /** Underruns the fake worklet counted. */
  underruns(): number;
  /** Advance simulated time; the fake worklet consumes audio unless audio: false; ticks unless render: false. */
  play(ms: number, opts?: { render?: boolean; audio?: boolean }): Promise<void>;
}

const noWasmFactory = createAudioDecoderFactory(() => Promise.reject(new Error('no wasm in unit tests')));

interface FakeAudioLog {
  decoded: number[];
  resets: number;
  failNext: number;
}

/** LPCM decodes for real; AC-3 decodes to silence 240 frames per unit, failing `failNext` units first. */
function fakeAudioFactory(log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 }, gate?: Promise<void>): AudioDecoderFactory {
  return async (codingType) => {
    if (codingType !== CodingType.AC3) return noWasmFactory(codingType);
    await gate;
    return {
      decode: (u) => {
        if (log.failNext > 0) {
          log.failNext--;
          return { chunks: [], failedFrames: 1 };
        }
        log.decoded.push(u.ptsUs);
        return { chunks: [{ ptsUs: u.ptsUs, sampleRate: 48_000, frames: 240, stereo: new Float32Array(480) }], failedFrames: 0 };
      },
      reset: () => {
        log.resets++;
      },
      close: () => undefined,
    };
  };
}

async function harness(audio: number | undefined, opts: { corruptAudioPesIndex?: number; videoCodingType?: number; throwOnDraw?: boolean; audioMuxLag90k?: number; frameBytes?: number; playlists?: SyntheticPlaylistSpec[]; audioStreams?: SyntheticAudioStream[]; secondClipAudioStreams?: SyntheticAudioStream[]; createAudioDecoder?: AudioDecoderFactory; movieObjects?: Uint8Array<ArrayBuffer>; dropFiles?: string[]; extraFiles?: Record<string, Uint8Array<ArrayBuffer>>; igUnits?: Array<{ pts: number; payload: Uint8Array }>; subPathIg?: SyntheticSubPathIg; pgStreams?: SyntheticPgStream[]; createAssDeps?: NonNullable<PlayerDeps['createAssDeps']>; createShaderBackend?: PlayerDeps['createShaderBackend']; index?: SyntheticDiscSpec['index']; playerSettings?: PlayerDeps['playerSettings']; remote?: FakeNas | ((files: Map<string, Uint8Array<ArrayBuffer>>) => FakeNas); remoteLimits?: PlayerDeps['remoteLimits']; clipSeconds?: number; noOpen?: boolean; cacheRoot?: MemoryDirectory; segmentBytes?: number; mutateFiles?: (files: Map<string, Uint8Array<ArrayBuffer>>) => void; videoCodecApi?: VideoCodecApi; log?: PlayerDeps['log'] } = {},
  memory?: 'constrained',
): Promise<Harness> {
  decoders.length = 0;
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', opts.clipSeconds ?? 4, { audio, corruptAudioPesIndex: opts.corruptAudioPesIndex, frameBytes: opts.frameBytes, audioStreams: opts.audioStreams, igUnits: opts.igUnits, pgStreams: opts.pgStreams }), syntheticClip('00002', 4, { audio, audioMuxLag90k: opts.audioMuxLag90k, frameBytes: opts.frameBytes, audioStreams: opts.secondClipAudioStreams ?? opts.audioStreams })],
    playlists: opts.playlists ?? [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2, videoCodingType: opts.videoCodingType }],
    movieObjects: opts.movieObjects,
    index: opts.index,
    subPathIg: opts.subPathIg,
  });
  for (const f of opts.dropFiles ?? []) files.delete(f);
  opts.mutateFiles?.(files);
  for (const [path, bytes] of Object.entries(opts.extraFiles ?? {})) files.set(path, bytes);
  const remote = typeof opts.remote === 'function' ? opts.remote(files) : opts.remote;
  const events: EngineEvent[] = [];
  const drawn: number[] = [];
  const igDraws: OverlayPlane[] = [];
  const pgDraws: OverlayPlane[] = [];
  const frames: Array<() => void> = [];
  const order: string[] = [];
  const shaderStages: Array<ShaderStage | null> = [];
  let stage: ShaderStage | null = null;
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: opts.videoCodecApi ?? fakeApi,
    nowMs: () => clock.ms,
    requestFrame: (cb) => frames.push(cb),
    createAudioDecoder: opts.createAudioDecoder ?? noWasmFactory,
    createAssDeps: opts.createAssDeps ?? fakeAssDeps(),
    createShaderBackend: opts.createShaderBackend,
    ...(opts.playerSettings ? { playerSettings: opts.playerSettings } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(remote ? { fetch: remote.fetch } : {}),
    ...(opts.remoteLimits ? { remoteLimits: opts.remoteLimits } : {}),
    ...(opts.cacheRoot ? { readAheadCacheRoot: async () => opts.cacheRoot!.asHandle() } : {}),
    ...(opts.segmentBytes ? { readAheadSegmentBytes: opts.segmentBytes } : {}),
    createCompositor: () => ({
      resize: () => undefined,
      drawVideo: (f) => {
        if (f && opts.throwOnDraw) throw new Error('draw exploded');
        order.push(`video:${f?.timestamp ?? null}`);
        if (f) stage?.process(f, { width: 320, height: 180 });
        if (f) drawn.push(f.timestamp);
      },
      drawIg: (plane) => {
        order.push('ig');
        igDraws.push(plane);
        plane.takeDirty();
      },
      drawPg: (plane) => {
        order.push('pg');
        pgDraws.push(plane);
        plane.takeDirty();
      },
      setShaderStage: (s) => {
        shaderStages.push(s);
        stage = s;
      },
    }),
  });
  const ring = createRing(48_000, 2);
  const views: RingViews = ringViews(ring);
  if (memory) await player.handle({ type: 'setMemoryProfile', profile: memory });
  await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  const entries = discEntries(files);
  if (!opts.noOpen) await player.handle({ type: 'open', disc: remote ? remote.spec : { kind: 'files', entries } });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  const audibleFrames: number[] = [];
  return {
    player,
    events,
    drawn,
    igDraws,
    pgDraws,
    frames,
    order,
    shaderStages,
    entries,
    ringPlaying: () => Atomics.load(views.control, Control.Playing) === 1,
    audibleFrames,
    underruns: () => Atomics.load(views.control, Control.Underruns),
    async play(ms, opts = {}) {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        if (opts.audio !== false) {
          for (let q = 0; q < 5; q++) {
            const read = Number(views.counters[1]);
            const playing = Atomics.load(views.control, Control.Playing) === 1;
            renderQuantum(views, left, right);
            const i = left.findIndex((v) => v !== 0);
            if (i >= 0 && playing) audibleFrames.push(read + i);
          }
        }
        if (opts.render !== false) player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

const states = (h: Harness): PlaybackState[] => h.events.flatMap((e) => (e.type === 'state' ? [e.state] : []));
const lastState = (h: Harness): PlaybackState | undefined => states(h).at(-1);
const lastTelemetry = (h: Harness): Telemetry | undefined => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : [])).at(-1);

async function untilPlaying(h: Harness): Promise<void> {
  await vi.waitFor(
    async () => {
      await h.play(20);
      expect(lastState(h)).toBe('playing');
    },
    { timeout: 5000 },
  );
}

describe('Player', () => {
  it('opens a disc and lists playlists', async () => {
    const h = await harness(CodingType.LPCM);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'titles', usesBdj: false, playlists: [expect.objectContaining({ id: '00000', durationUs: 8_000_000, chapterCount: 4, playable: true })] }),
    );
  });

  it('reports a render-loop exception once and keeps scheduling frames', async () => {
    const h = await harness(CodingType.LPCM, { throwOnDraw: true });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await vi.waitFor(
      async () => {
        await h.play(20, { render: false });
        expect(h.events.some((e) => e.type === 'state' && e.state === 'buffering')).toBe(true);
      },
      { timeout: 5000 },
    );
    const scheduled = h.frames.length;
    await vi.waitFor(
      () => {
        h.frames.at(-1)?.();
        expect(h.events.filter((e) => e.type === 'error' && e.code === 'internal')).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    h.frames.at(-1)?.();
    h.frames.at(-1)?.();
    expect(h.frames.length).toBeGreaterThan(scheduled);
    expect(h.events.filter((e) => e.type === 'error' && e.code === 'internal')).toHaveLength(1);
  });

  it('plays AC-3 audio on the audio clock through the decoder factory', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    expect(log.decoded.length).toBeGreaterThan(100);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'Dolby Digital (AC-3)', audioDecodeErrors: 0 });
  });

  it('falls back to the wall clock when the audio decoder cannot load', async () => {
    const h = await harness(CodingType.AC3); // noWasmFactory
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'audio', codec: 'Dolby Digital (AC-3)' }));
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(1000);
    expect(h.drawn.length).toBeGreaterThan(15);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('resets the audio decoders on seek', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const before = log.resets;
    await h.player.handle({ type: 'seek', timeUs: 3_000_000 });
    expect(log.resets).toBeGreaterThan(before);
  });

  it('disables audio after more than 50 failed frames in a row and retries on the next seek', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    log.failNext = 60;
    // the tiny synthetic clips are fully read ahead by now, so a seek is what makes the pipeline decode again
    await h.player.handle({ type: 'seek', timeUs: 500_000 });
    await h.play(1000);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'audio-disabled' }));
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    expect(lastTelemetry(h)?.audioDecodeErrors).toBeGreaterThan(50);
    await h.player.handle({ type: 'seek', timeUs: 1_000_000 });
    await untilPlaying(h);
    await h.play(1000);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
  });

  it('reports a folder without BDMV', async () => {
    const events: EngineEvent[] = [];
    const player = new Player({ emit: (e) => events.push(e), videoCodecApi: fakeApi, nowMs: () => 0, requestFrame: () => undefined, createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }), createAudioDecoder: noWasmFactory });
    await player.handle({ type: 'open', disc: { kind: 'files', entries: [['Stuff/readme.txt', new Blob(['hi'])]] } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'not-bdmv' }));
    expect(events.at(-1)).toEqual({ type: 'state', state: 'error' });
  });

  it('re-enables audio on the next seek once a stalled output is running again', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1200, { audio: false }); // output stalls → wall-clock fallback
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    await h.play(100); // the output is running again (heartbeat advances)
    await h.player.handle({ type: 'seek', timeUs: 2_000_000 });
    await untilPlaying(h);
    await h.play(1000);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
  });

  it('keeps unsupported audio off after a seek', async () => {
    const h = await harness(CodingType.EAC3_SECONDARY);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 2_000_000 });
    await untilPlaying(h);
    await h.play(1000);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('tells the UI the old playlist is gone when picking another one fails', async () => {
    const h = await harness(CodingType.LPCM, {
      playlists: [
        { id: '00000', clipIds: ['00001'] },
        { id: '00001', clipIds: ['00002'] },
      ],
      dropFiles: ['BDMV/STREAM/00002.m2ts'],
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const n = h.events.length;
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    const after = h.events.slice(n);
    expect(after).toContainEqual({ type: 'playlistCleared' });
    expect(after).toContainEqual(expect.objectContaining({ type: 'error', code: 'missing-file' }));
    expect(after.findIndex((e) => e.type === 'playlistCleared')).toBeLessThan(after.findIndex((e) => e.type === 'error'));
    expect(lastState(h)).toBe('error');
  });

  it('closes the disc: stops playback, clears the playlist and reports idle', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'close' });
    expect(h.events.at(-1)).toEqual({ type: 'state', state: 'idle' });
    expect(h.events).toContainEqual({ type: 'playlistCleared' });
    const n = h.events.length;
    await h.play(600);
    expect(h.events.slice(n)).toEqual([]);
  });

  it('keeps audio fed when the multiplex puts video 600 ms ahead of audio (regression: real-disc boundary underrun)', async () => {
    // ~200 KB/frame ≈ 38 Mbps, so each ~2 MB read covers ~0.4 s, as on a real disc.
    const h = await harness(CodingType.LPCM, { audioMuxLag90k: 54_000, frameBytes: 200_000 });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const before = lastTelemetry(h)?.audioUnderruns ?? 0;
    await h.play(6000); // crosses into the lagged second clip at 4 s
    const t = lastTelemetry(h);
    expect(t?.clockUs ?? 0).toBeGreaterThan(5_000_000);
    expect((t?.audioUnderruns ?? 0) - before).toBe(0);
  });

  it('plays on the audio clock, in order, across the play-item boundary', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual({
      type: 'chapters',
      playlistId: '00000',
      durationUs: 8_000_000,
      chapters: [0, 2_000_000, 4_000_000, 6_000_000].map((startUs, index) => ({ index, startUs })),
    });
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(5000);
    expect(h.drawn.length).toBeGreaterThan(100);
    expect(h.drawn.every((t, i) => i === 0 || t > h.drawn[i - 1])).toBe(true);
    expect(Math.max(...h.drawn)).toBeGreaterThan(4_500_000);
    const telemetry = lastTelemetry(h);
    expect(telemetry?.clockMode).toBe('audio');
    expect(Math.abs(telemetry?.avOffsetMeanUs ?? Infinity)).toBeLessThanOrEqual(20_000);
    expect(telemetry?.bdj).toBeNull(); // no BD-J title ran on this disc
  });

  it('applies only the last of several rapid seeks and never draws earlier frames', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await Promise.all([
      h.player.handle({ type: 'seek', timeUs: 1_000_000 }),
      h.player.handle({ type: 'seek', timeUs: 6_000_000 }),
      h.player.handle({ type: 'seek', timeUs: 3_000_000 }),
    ]);
    h.drawn.length = 0;
    await untilPlaying(h);
    await h.play(300);
    expect(Math.min(...h.drawn)).toBeGreaterThanOrEqual(2_999_000);
    expect(Math.min(...h.drawn)).toBeLessThan(3_100_000);
  });

  it('plays video on the wall clock when the only audio is unsupported', async () => {
    const h = await harness(CodingType.EAC3_SECONDARY);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'audio', codec: 'Dolby Digital Plus (secondary)' }));
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(1000);
    expect(h.drawn.length).toBeGreaterThan(15);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('keeps reading while rendering is throttled and catches up afterwards', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(2500, { render: false });
    h.player.tick();
    const time = h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1) ?? 0;
    expect(time).toBeGreaterThan(2_400_000);
    expect(h.drawn.at(-1) ?? 0).toBeGreaterThan(time - 100_000);
    expect(lastState(h)).toBe('playing');
  });

  it('falls back to the wall clock when the audio output stops running', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1200, { audio: false });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'audio-disabled' }));
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('goes back to the audio clock by itself once a stalled output runs again, without a seek', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1200, { audio: false }); // e.g. a slow output start while another client opens a stream
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    await vi.waitFor(
      async () => {
        await h.play(100);
        expect(lastTelemetry(h)?.clockMode).toBe('audio');
      },
      { timeout: 5000 },
    );
    expect(lastState(h)).toBe('playing');
  });

  it('seeking while paused shows the target frame and stays paused', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'pause' });
    expect(lastState(h)).toBe('paused');
    h.drawn.length = 0;
    await h.player.handle({ type: 'seek', timeUs: 5_000_000 });
    await vi.waitFor(async () => {
      await h.play(20);
      expect(h.drawn.length).toBeGreaterThan(0);
    });
    expect(h.drawn[0]).toBeGreaterThanOrEqual(4_999_000);
    expect(h.drawn[0]).toBeLessThan(5_100_000);
    await h.play(500);
    expect(lastState(h)).toBe('paused');
    expect(h.drawn).toHaveLength(1); // a paused preview: one frame, no playback
    expect(h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1)).toBe(5_000_000);
  });

  it('jumps to the next chapter', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'nextChapter' });
    expect(h.events).toContainEqual({ type: 'time', timeUs: 2_000_000 });
  });

  it('skips a chapter that starts within the guard instead of landing just ahead', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 1_800_000 });
    await untilPlaying(h);
    const mark = h.events.length;
    await h.player.handle({ type: 'nextChapter' });
    expect(h.events.slice(mark)).toContainEqual({ type: 'time', timeUs: 4_000_000 }); // 2.0 s is under 0.5 s away
  });

  it('leaves the clock running when there is no next chapter', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 6_200_000 });
    await untilPlaying(h);
    await h.play(300);
    const times = (from: number): number[] => h.events.slice(from).flatMap((e) => (e.type === 'time' ? [e.timeUs] : []));
    const before = times(0).at(-1) ?? 0;
    expect(before).toBeGreaterThan(6_300_000);
    const mark = h.events.length;
    await h.player.handle({ type: 'nextChapter' });
    await h.play(600);
    const after = h.events.slice(mark);
    expect(after.filter((e) => e.type === 'state')).toEqual([]);
    const clock = times(mark);
    expect(clock.length).toBeGreaterThan(0);
    // The clock kept advancing from where it was: no seek to a target, no pause.
    expect(clock.every((t, i) => t > (i === 0 ? before : clock[i - 1]))).toBe(true);
    expect((clock.at(-1) ?? 0) - before).toBeGreaterThan(400_000);
  });

  it('reaches the ended state at the end of the playlist', async () => {
    const h = await harness(CodingType.EAC3_SECONDARY);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(8500);
    expect(lastState(h)).toBe('ended');
  });

  it('counts no underruns when the audio runs out at the end of the playlist', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(9000);
    expect(lastState(h)).toBe('ended');
    expect(lastTelemetry(h)?.audioUnderruns).toBe(0);
  });

  describe('video the browser cannot decode', () => {
    const noPicture = (h: Harness) => h.events.filter((e) => e.type === 'unsupported' && e.kind === 'video');
    const times = (h: Harness) => h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : []));

    it.each([
      ['MPEG-2 video', CodingType.MPEG2_VIDEO],
      ['VC-1', CodingType.VC1],
    ])('plays %s without a picture, on the audio clock, with one notice', async (codec, videoCodingType) => {
      const h = await harness(CodingType.LPCM, { videoCodingType });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      const at = times(h).at(-1)!;
      await h.play(1000);
      expect(times(h).at(-1)! - at).toBeGreaterThan(500_000);
      expect(decoders).toHaveLength(0); // no VideoDecoder for that stream
      expect(h.drawn).toEqual([]);
      expect(noPicture(h)).toEqual([{ type: 'unsupported', kind: 'video', codec, message: NO_PICTURE_MESSAGE, noPicture: true }]);
      expect(lastTelemetry(h)?.clockMode).toBe('audio');
      expect(h.events.some((e) => e.type === 'error')).toBe(false);
    });

    it('runs on the wall clock when there is no audio either, and ends at its duration, its video read to the end (R11)', async () => {
      // ~1.2 MB a second of video nobody decodes and nothing else: reading is paced on the clock, and the video read to
      // its OUT time counts as delivered, so the playlist plays its 8 s (an IG-only menu loop does not end early)
      const h = await harness(undefined, { videoCodingType: CodingType.MPEG2_VIDEO, frameBytes: 50_000 });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.play(1000);
      expect(lastTelemetry(h)?.clockMode).toBe('wall');
      expect(times(h).at(-1)).toBeGreaterThan(500_000);
      expect(lastState(h)).toBe('playing');
      await vi.waitFor(async () => {
        await h.play(500);
        expect(lastState(h)).toBe('ended');
      }, { timeout: 10_000 });
      // the clock stops on the tick that ends the playlist (time events come only every 250 ms)
      const endedAt = (h.player as unknown as { clock: { nowUs(): number } }).clock.nowUs();
      expect(Math.abs(endedAt - 8_000_000)).toBeLessThanOrEqual(100_000);
    });

    it('ends a truncated clip at its end of data plus the play-out of what was delivered, not at its duration (R11)', async () => {
      // 00000 is 00001 (4 s) then 00002 (4 s), cut to its first half: the audio delivered ends near 6 s
      const h = await harness(CodingType.LPCM, {
        videoCodingType: CodingType.MPEG2_VIDEO,
        mutateFiles: (files) => {
          const clip = files.get('BDMV/STREAM/00002.m2ts')!;
          files.set('BDMV/STREAM/00002.m2ts', clip.slice(0, Math.floor(clip.length / 2 / 6144) * 6144));
        },
      });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await vi.waitFor(async () => {
        await h.play(500);
        expect(lastState(h)).toBe('ended');
      }, { timeout: 15_000 });
      expect(times(h).at(-1)).toBeGreaterThan(5_000_000);
      expect(times(h).at(-1)).toBeLessThan(7_000_000);
      expect(lastTelemetry(h)?.audioUnderruns ?? 0).toBe(0);
    });

    it('keeps the audio fed without a picture at low bitrates, on the audio clock (R10)', async () => {
      // LPCM and ~0.5 MB/s in all, the video dropped: reading paced on what was delivered never lets the audio run dry
      const h = await harness(CodingType.LPCM, { videoCodingType: CodingType.MPEG2_VIDEO, frameBytes: 12_800, clipSeconds: 16 });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      const from = h.events.length;
      await h.play(12_000);
      expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioUnderruns: 0 });
      expect(h.events.slice(from).filter((e) => e.type === 'state' && e.state === 'buffering')).toEqual([]);
    }, 30_000);

    it('clears a picked playlist whose decoder cannot be configured, so the picker shows why (UnsupportedCodecError stays)', async () => {
      const h = await harness(CodingType.LPCM, { videoCodecApi: { ...fakeApi, isConfigSupported: async (config) => ({ supported: false, config }) } });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await vi.waitFor(async () => {
        await h.play(50);
        expect(lastState(h)).toBe('error');
      }, { timeout: 5000 });
      const cleared = h.events.findIndex((e) => e.type === 'playlistCleared');
      const unsupported = h.events.findIndex((e) => e.type === 'unsupported' && e.kind === 'video');
      expect(cleared).toBeGreaterThanOrEqual(0);
      expect(cleared).toBeLessThan(unsupported);
      expect(h.events[unsupported]).toMatchObject({ codec: 'H.264/AVC' });
      expect(h.events[unsupported]).not.toHaveProperty('noPicture');
    });

    it('does not use up the disc\'s notice on a playlist that fails to open', async () => {
      const h = await harness(CodingType.LPCM, {
        playlists: [
          { id: '00000', clipIds: ['00001'], videoCodingType: CodingType.MPEG2_VIDEO },
          { id: '00001', clipIds: ['00002'], videoCodingType: CodingType.MPEG2_VIDEO },
        ],
        dropFiles: ['BDMV/STREAM/00001.m2ts'],
      });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      expect(lastState(h)).toBe('error');
      expect(noPicture(h)).toEqual([]);
      await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
      await untilPlaying(h);
      expect(noPicture(h)).toHaveLength(1);
    });

    it('seeks and skips chapters from the clip info', async () => {
      const h = await harness(CodingType.LPCM, { videoCodingType: CodingType.VC1 });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.player.handle({ type: 'seek', timeUs: 5_000_000 });
      await untilPlaying(h);
      await h.play(300);
      expect(times(h).at(-1)).toBeGreaterThanOrEqual(5_000_000);
      await h.player.handle({ type: 'prevChapter' });
      await untilPlaying(h);
      expect(times(h).at(-1)).toBeLessThan(5_000_000);
      expect(lastTelemetry(h)?.clockMode).toBe('audio');
    });

    it('notifies once per disc: not again for its next playlist, again for another disc (Review Focus 4)', async () => {
      const h = await harness(CodingType.LPCM, {
        playlists: [
          { id: '00000', clipIds: ['00001'], videoCodingType: CodingType.MPEG2_VIDEO },
          { id: '00001', clipIds: ['00002'], videoCodingType: CodingType.VC1 },
        ],
      });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
      await untilPlaying(h);
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      expect(noPicture(h)).toHaveLength(1);
      await h.player.handle({ type: 'open', disc: { kind: 'files', entries: h.entries } });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
      await untilPlaying(h);
      expect(noPicture(h)).toHaveLength(2);
      expect(noPicture(h)[1]).toMatchObject({ codec: 'VC-1', message: NO_PICTURE_MESSAGE, noPicture: true });
    });

    it('decodes the picture again for a playlist the browser can decode', async () => {
      const h = await harness(CodingType.LPCM, {
        playlists: [
          { id: '00000', clipIds: ['00001'], videoCodingType: CodingType.MPEG2_VIDEO },
          { id: '00001', clipIds: ['00002'] },
        ],
      });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
      await untilPlaying(h);
      await h.play(500);
      expect(decoders).toHaveLength(1);
      expect(h.drawn.length).toBeGreaterThan(0);
    });

    it('clears the notice when a playlist with a picture starts, and does not show it again for that disc (R9)', async () => {
      const h = await harness(CodingType.LPCM, {
        playlists: [
          { id: '00000', clipIds: ['00001'], videoCodingType: CodingType.MPEG2_VIDEO },
          { id: '00001', clipIds: ['00002'] },
        ],
      });
      const cleared = () => h.events.filter((e) => e.type === 'noticeCleared' && e.code === 'no-picture');
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      expect(cleared()).toHaveLength(0);
      const n = h.events.length;
      await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
      expect(cleared()).toHaveLength(1);
      // sent with the playlist's own notices, before its chapters
      expect(h.events.slice(n).findIndex((e) => e.type === 'noticeCleared')).toBeLessThan(h.events.slice(n).findIndex((e) => e.type === 'chapters'));
      await untilPlaying(h);
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
      await untilPlaying(h);
      expect(noPicture(h)).toHaveLength(1);
      expect(cleared()).toHaveLength(1);
      // another disc starts afresh
      await h.player.handle({ type: 'open', disc: { kind: 'files', entries: h.entries } });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      expect(noPicture(h)).toHaveLength(2);
    });

    it('draws PG subtitles over black', async () => {
      const subs = subtitleSegments({ x: 10 }).map((payload) => ({ pts: CLIP_START_PTS + 0.5 * 90_000, payload }));
      const h = await harness(CodingType.LPCM, { videoCodingType: CodingType.MPEG2_VIDEO, pgStreams: [{ pid: 0x1200, lang: 'eng', units: subs }] });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
      await vi.waitFor(async () => {
        await h.play(100);
        expect(h.pgDraws.some((p) => p.hash() !== EMPTY)).toBe(true);
      }, { timeout: 5000 });
      expect(h.order.every((o) => !o.startsWith('video:') || o === 'video:null')).toBe(true);
    });
  });

  it('serializes commands so a double playPlaylist leaves one live session', async () => {
    const h = await harness(CodingType.LPCM);
    await Promise.all([h.player.handle({ type: 'playPlaylist', playlistId: '00000' }), h.player.handle({ type: 'playPlaylist', playlistId: '00000' })]);
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(1000);
    expect(h.drawn.length).toBeGreaterThan(15);
    expect(h.drawn.every((t, i) => i === 0 || t > h.drawn[i - 1])).toBe(true);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    expect(decoders.filter((d) => d.state !== 'closed')).toHaveLength(1);
    expect(decoders.filter((d) => d.state === 'closed').length).toBe(decoders.length - 1);
  });

  it('drops a corrupt LPCM unit without disabling audio', async () => {
    const h = await harness(CodingType.LPCM, { corruptAudioPesIndex: 100 });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(2000);
    expect(h.events.some((e) => e.type === 'notice' && e.code === 'audio-disabled')).toBe(false);
    expect(h.events.some((e) => e.type === 'unsupported')).toBe(false);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
    expect(lastTelemetry(h)?.corruptPackets).toBeGreaterThanOrEqual(1);
  });

  const twoTracks = (second: number) => [lpcmStream(0x1100, 4, { lang: 'jpn' }), dummyAudioStream(0x1101, second, 4, { lang: 'eng' })];
  const tracksEvents = (h: Harness) => h.events.flatMap((e) => (e.type === 'tracks' ? [e] : []));

  it('lists the audio tracks after the chapters and selects the first playable one', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('tracks')).toBeGreaterThan(types.indexOf('chapters'));
    expect(tracksEvents(h).at(-1)).toEqual({
      type: 'tracks',
      selectedAudio: 1,
      audio: [
        { index: 1, codec: 'LPCM', language: 'jpn', channels: 'stereo', playable: true },
        { index: 2, codec: 'Dolby Digital (AC-3)', language: 'eng', channels: 'stereo', playable: true },
      ],
    });
  });

  it('switches the audio track at the current time and keeps playing', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1500);
    const at = lastTelemetry(h)?.clockUs ?? 0;
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(tracksEvents(h).at(-1)?.selectedAudio).toBe(2);
    await untilPlaying(h);
    await h.play(800);
    expect(Math.min(...log.decoded)).toBeGreaterThan(at - 1_100_000); // read from the keyframe before the switch point
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'Dolby Digital (AC-3)' });
  });

  it('a pause reports the exact time before the paused state', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1100);
    await h.player.handle({ type: 'pause' });
    const pausedAt = h.events.findLastIndex((e) => e.type === 'state' && e.state === 'paused');
    const time = h.events.slice(0, pausedAt).findLast((e) => e.type === 'time');
    await h.play(1000); // telemetry while paused reads the stopped clock
    expect(time?.type === 'time' && time.timeUs).toBe(Math.round(lastTelemetry(h)?.clockUs ?? -1));
  });

  it('switching while paused stays paused at the same time', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    await h.player.handle({ type: 'pause' });
    const pausedAt = lastTelemetry(h)?.clockUs ?? 0;
    await h.player.handle({ type: 'selectAudio', index: 2 });
    await h.play(300);
    expect(lastState(h)).toBe('paused');
    const lastTime = h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1) ?? -1;
    expect(Math.abs(lastTime - pausedAt)).toBeLessThan(300_000);
  });

  it('ignores unplayable, unknown and already-selected tracks', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.EAC3_SECONDARY), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const before = h.events.length;
    for (const index of [2, 9, 1]) await h.player.handle({ type: 'selectAudio', index });
    expect(h.events.slice(before).filter((e) => e.type === 'tracks' || (e.type === 'state' && e.state === 'buffering'))).toEqual([]);
  });

  it('applies two quick switches in order: the last one wins, with no stale decoder output (commands are serialized)', async () => {
    // Player.handle serializes commands, so the gated load of the first switch finishes before the second runs.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory(log, gate) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const toAc3 = h.player.handle({ type: 'selectAudio', index: 2 });
    const back = h.player.handle({ type: 'selectAudio', index: 1 });
    open();
    await Promise.all([toAc3, back]);
    await untilPlaying(h);
    log.decoded.length = 0;
    await h.play(800);
    expect(tracksEvents(h).at(-1)?.selectedAudio).toBe(1);
    expect(log.decoded).toEqual([]);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'LPCM' });
  });

  it('brings sound back by switching to a playable track after a decoder failed to load', async () => {
    const h = await harness(undefined, { audioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4), lpcmStream(0x1101, 4)] }); // noWasmFactory
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(500);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    await h.player.handle({ type: 'selectAudio', index: 2 });
    await untilPlaying(h);
    await h.play(800);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'LPCM' });
  });

  it('stops the ring when the decoder of the switched-to track cannot load, so no stale audio plays on', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3) }); // noWasmFactory: AC-3 fails to load
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(500);
    expect(h.ringPlaying()).toBe(true);
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
    expect(h.ringPlaying()).toBe(false);
    await untilPlaying(h);
    await h.play(800);
    expect(h.ringPlaying()).toBe(false);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('shows buffering with the old audio stopped while the new track decoder is still loading', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory(undefined, gate) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.play(20);
    await vi.waitFor(async () => {
      await h.play(20);
      expect(lastState(h)).toBe('playing');
    });
    expect(h.ringPlaying()).toBe(true);
    const switching = h.player.handle({ type: 'selectAudio', index: 2 });
    await h.play(100);
    expect(lastState(h)).toBe('buffering');
    expect(h.ringPlaying()).toBe(false);
    const frozen = lastTelemetry(h)?.clockUs;
    await h.play(100);
    expect(lastTelemetry(h)?.clockUs).toBe(frozen);
    open();
    await switching;
    await untilPlaying(h);
    await h.play(500);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'Dolby Digital (AC-3)' });
  });

  it('reports a failing decoder load for a later play item once, with a single load attempt', async () => {
    let loads = 0;
    const h = await harness(undefined, {
      audioStreams: [lpcmStream(0x1100, 4)],
      secondClipAudioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4)],
      createAudioDecoder: (codingType) => {
        if (codingType === CodingType.AC3) loads++;
        return noWasmFactory(codingType);
      },
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(5500);
    expect(loads).toBe(1);
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  /** Item 1 LPCM, item 2 AC-3 whose decoder load stays pending until `fail()` rejects it. */
  async function pendingLaterLoad(): Promise<{ h: Harness; fail: () => void }> {
    let reject: (err: Error) => void = () => undefined;
    let requested = false;
    const h = await harness(undefined, {
      audioStreams: [lpcmStream(0x1100, 4)],
      secondClipAudioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4)],
      createAudioDecoder: (codingType) => {
        if (codingType !== CodingType.AC3) return noWasmFactory(codingType);
        requested = true;
        return new Promise((_, r) => (reject = r));
      },
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    // Steps the playback directly: vi.waitFor's 50 ms polls made the ~1.5 s of playback this needs take ~3.7 s of the 5 s.
    for (let ms = 0; ms < 5000 && !requested; ms += 20) await h.play(20);
    expect(requested).toBe(true); // read-ahead reached item 2
    return { h, fail: () => reject(new Error('offline')) };
  }

  it('ignores a later item’s failed decoder load that lands after the user seeked away', async () => {
    const { h, fail } = await pendingLaterLoad();
    await h.player.handle({ type: 'seek', timeUs: 1_000_000 }); // back into the LPCM item
    await untilPlaying(h);
    fail();
    await h.play(500);
    expect(h.events.filter((e) => e.type === 'unsupported')).toEqual([]);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
  });

  it('reports a failed decoder load once when the user seeks into the item that needs it', async () => {
    const { h, fail } = await pendingLaterLoad();
    const seek = h.player.handle({ type: 'seek', timeUs: 5_000_000 }); // waits on the same pending load
    fail();
    await seek;
    await h.play(300);
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
  });

  it('reports an unplayable codec in a later play item once without trying to load it', async () => {
    let loads = 0;
    const h = await harness(undefined, {
      audioStreams: [lpcmStream(0x1100, 4)],
      secondClipAudioStreams: [dummyAudioStream(0x1100, CodingType.EAC3_SECONDARY, 4)],
      createAudioDecoder: (codingType) => {
        if (codingType === CodingType.EAC3_SECONDARY) loads++;
        return noWasmFactory(codingType);
      },
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(5500);
    expect(loads).toBe(0);
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });
});

describe('Player with HDMV navigation', () => {
  const idle = { cmds: [] };
  const shortPlaylists = [
    { id: '00000', clipIds: ['00001'], chapterEverySeconds: 1 },
    { id: '00001', clipIds: ['00002'], chapterEverySeconds: 1 },
  ];
  const nav = (objects: Array<{ cmds: Uint8Array[] }>, extra: Parameters<typeof harness>[1] = {}, memory?: 'constrained') =>
    harness(CodingType.LPCM, { playlists: shortPlaylists, movieObjects: buildMovieObjects(objects), ...extra }, memory);
  const selectedAudio = (h: Harness) => h.events.flatMap((e) => (e.type === 'tracks' ? [e.selectedAudio] : [])).at(-1);
  const chapterIds = (h: Harness) => h.events.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : []));

  it('boots First Play without a playPlaylist command', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
    await untilPlaying(h);
    expect(chapterIds(h)).toEqual(['00000']);
    expect(h.events).toContainEqual({ type: 'indexTitles', titles: [{ number: 1, kind: 'hdmv' }], hasTopMenu: true });
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('indexTitles')).toBeGreaterThan(types.indexOf('titles'));
  });

  it('plays a title at a mark', async () => {
    const h = await nav([idle, idle, { cmds: [asm.playPlPm(imm(1), imm(1))] }]);
    expect(chapterIds(h)).toEqual([]);
    await h.player.handle({ type: 'playTitle', title: 1 });
    await untilPlaying(h);
    await h.play(300);
    expect(chapterIds(h)).toEqual(['00001']);
    expect(Math.abs(h.drawn[0]! - 1_000_000)).toBeLessThanOrEqual(41_667);
  });

  it('starts the next playlist when one ends', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }, idle, idle]);
    await vi.waitFor(
      async () => {
        await h.play(100);
        expect(chapterIds(h)).toEqual(['00000', '00001']);
      },
      { timeout: 10000 },
    );
    expect(states(h)).not.toContain('ended');
  });

  it('follows a VM setStream into the audio selection', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.setStream(imm(0x80020000), imm(0)), asm.playPl(imm(0))] }], {
      audioStreams: [lpcmStream(0x1100, 4, { lang: 'jpn' }), lpcmStream(0x1101, 4, { lang: 'eng' })],
    });
    await untilPlaying(h);
    expect(selectedAudio(h)).toBe(1);
    await h.player.handle({ type: 'playTitle', title: 1 });
    await untilPlaying(h);
    expect(chapterIds(h)).toEqual(['00000', '00000']);
    expect(selectedAudio(h)).toBe(2);
  });

  it('stops the VM when a raw playlist is picked', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(0))] }, idle, idle]);
    await untilPlaying(h);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await vi.waitFor(
      async () => {
        await h.play(100);
        expect(lastState(h)).toBe('ended');
      },
      { timeout: 10000 },
    );
    await h.play(500);
    expect(chapterIds(h)).toEqual(['00000', '00001']);
  });

  it('brings the program back for a title or the top menu after a raw playlist pick', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, { cmds: [asm.playPl(imm(0))] }, { cmds: [asm.playPl(imm(1))] }]);
    await untilPlaying(h);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' }); // raw pick: the navigator stops
    await untilPlaying(h);
    await h.player.handle({ type: 'playTitle', title: 1 });
    await vi.waitFor(async () => {
      await h.play(100);
      expect(chapterIds(h)).toEqual(['00000', '00000', '00001']);
    }, { timeout: 5000 });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await untilPlaying(h);
    await h.player.handle({ type: 'menuCall' });
    await vi.waitFor(async () => {
      await h.play(100);
      expect(chapterIds(h)).toEqual(['00000', '00000', '00001', '00001', '00000']);
    }, { timeout: 5000 });
  });

  describe('menus', () => {
    const menuAt = (seconds: number) => simpleMenuSegments().map((payload) => ({ pts: CLIP_START_PTS + seconds * 90_000, payload }));
    const telemetries = (h: Harness) => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : []));
    const menuEvents = (h: Harness) => h.events.flatMap((e) => (e.type === 'menuActive' ? [e] : []));
    const bootMenu = (extra: Parameters<typeof harness>[1] = {}) => nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { igUnits: menuAt(0.2), ...extra });

    /** Buttons 1 and 2 (8x4 at (100, 100) and (100, 200)) jump to title 1, which plays 00001. */
    const inputMenu = async () => {
      const segments = simpleMenuSegments({ cmds: [asm.jumpTitle(imm(1))] }).map((payload) => ({ pts: CLIP_START_PTS + 0.2 * 90_000, payload }));
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.playPl(imm(1))] }], { igUnits: segments });
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      return h;
    };
    const untilPlaylist = async (h: Harness, id: string) =>
      vi.waitFor(
        async () => {
          await h.play(100);
          expect(chapterIds(h)).toContain(id);
        },
        { timeout: 5000 },
      );

    it('hands the disc sounds over once and plays a button sound on activation', async () => {
      const sounds = buildSoundBdmv([{ channels: 1, samples: new Int16Array(480) }, { channels: 2, samples: new Int16Array(960) }]);
      const segments = simpleMenuSegments({ cmds: [asm.jumpTitle(imm(1))], activatedSound: 1 }).map((payload) => ({ pts: CLIP_START_PTS + 0.2 * 90_000, payload }));
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.playPl(imm(1))] }], { igUnits: segments, extraFiles: { 'BDMV/AUXDATA/sound.bdmv': sounds } });
      const effects = h.events.filter((e) => e.type === 'soundEffects');
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ type: 'soundEffects', clips: [{ channels: 1 }, { channels: 2 }] });
      await untilPlaying(h);
      await vi.waitFor(async () => {
        await h.play(100);
        expect(lastTelemetry(h)?.menu).not.toBeNull();
      }, { timeout: 5000 });
      expect(lastTelemetry(h)!.soundsPlayed).toBe(0);
      await h.player.handle({ type: 'menuKey', key: 'ok' });
      expect(h.events).toContainEqual({ type: 'soundEffect', id: 1 });
      await h.play(600);
      expect(lastTelemetry(h)!.soundsPlayed).toBe(1);
    });

    it('emits no sounds for a disc without sound.bdmv', async () => {
      const h = await inputMenu();
      expect(h.events.filter((e) => e.type === 'soundEffects')).toEqual([]);
    });

    it('menu keys move the selection and activate a button', async () => {
      const h = await inputMenu();
      await h.player.handle({ type: 'menuKey', key: 'down' });
      await h.play(600); // one telemetry interval
      expect(lastTelemetry(h)!.menu!.selectedButton).toBe(2);
      await h.player.handle({ type: 'menuKey', key: 'ok' });
      await untilPlaylist(h, '00001');
    });

    it('a pointer move reports the button under it and selects it; a click activates it', async () => {
      const h = await inputMenu();
      await h.player.handle({ type: 'pointer', kind: 'move', x: 104, y: 202 });
      expect(h.events.at(-1)).toEqual({ type: 'pointerTarget', button: 2 });
      await h.play(600);
      expect(lastTelemetry(h)!.menu!.selectedButton).toBe(2);
      await h.player.handle({ type: 'pointer', kind: 'move', x: 500, y: 500 });
      expect(h.events.filter((e) => e.type === 'pointerTarget').at(-1)).toEqual({ type: 'pointerTarget', button: null });
      await h.player.handle({ type: 'pointer', kind: 'click', x: 104, y: 102 });
      await untilPlaylist(h, '00001');
    });

    it('reports a click that hits no button as missed, and not one on a button (ruling R13)', async () => {
      const h = await inputMenu();
      await h.player.handle({ type: 'pointer', kind: 'click', x: 500, y: 500 });
      expect(h.events.filter((e) => e.type === 'menuTapMissed')).toHaveLength(1);
      await h.play(600);
      expect(lastTelemetry(h)!.menu).not.toBeNull(); // the menu is still shown, nothing activated
      await h.player.handle({ type: 'pointer', kind: 'move', x: 500, y: 500 });
      expect(h.events.filter((e) => e.type === 'menuTapMissed')).toHaveLength(1); // a move is no tap
      await h.player.handle({ type: 'pointer', kind: 'click', x: 104, y: 102 });
      expect(h.events.filter((e) => e.type === 'menuTapMissed')).toHaveLength(1);
      await untilPlaylist(h, '00001');
    });

    it('ignores menu keys and pointer input without a navigator', async () => {
      const h = await harness(CodingType.LPCM);
      await h.player.handle({ type: 'menuKey', key: 'ok' });
      await h.player.handle({ type: 'pointer', kind: 'click', x: 1, y: 1 });
      expect(h.events.filter((e) => e.type === 'pointerTarget')).toEqual([]);
    });

    it('boots into a menu: telemetry carries the page and the buttons drawn, and menuActive is emitted', async () => {
      const h = await bootMenu();
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const menu = lastTelemetry(h)!.menu!;
      expect(menu.page).toBe(0);
      expect(menu.selectedButton).toBe(1);
      expect(menu.buttonsDrawn).toBeGreaterThan(0);
      expect(menuEvents(h)).toContainEqual({ type: 'menuActive', active: true, popupAvailable: false });
      expect(lastTelemetry(h)!.igErrors).toBe(0);
      expect(h.igDraws.length).toBeGreaterThan(0);
      expect(h.igDraws[0]!.width).toBe(1920);
    });

    it('shows a menu whose display set is muxed at the very start of the clip', async () => {
      const h = await bootMenu({ igUnits: menuAt(0) });
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
    });

    it('does not show the menu before the clock reaches its PTS', async () => {
      const h = await bootMenu({ igUnits: menuAt(3) });
      await untilPlaying(h);
      await h.play(500);
      expect(lastTelemetry(h)?.menu ?? null).toBeNull();
      expect(h.igDraws).toEqual([]);
    });

    it('shows a menu whose IG stream lives in a sub-path clip, decoded from the preloaded clip', async () => {
      const h = await bootMenu({ subPathIg: { clipId: '00009', units: menuAt(0.2) } });
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const menu = lastTelemetry(h)!.menu!;
      expect(menu.selectedButton).toBe(1);
      expect(menu.buttonsDrawn).toBeGreaterThan(0);
      expect(menuEvents(h)).toContainEqual({ type: 'menuActive', active: true, popupAvailable: false });
      expect(lastTelemetry(h)!.igErrors).toBe(0);
      expect(h.igDraws.length).toBeGreaterThan(0);
    });

    describe('memory profile', () => {
      const MESSAGE = "This disc's menus need more memory than this device allows.";
      const big = { 'BDMV/STREAM/00009.m2ts': new Uint8Array(65 * 1024 * 1024) };
      const memoryNotices = (h: Harness) => h.events.filter((e) => e.type === 'notice' && e.code === 'menu-memory');

      it('tells the user when constrained refuses a 65 MB sub-path clip, and keeps playing', async () => {
        const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { igUnits: menuAt(0.2), subPathIg: { clipId: '00009', units: menuAt(0.2) }, extraFiles: big }, 'constrained');
        await untilPlaying(h);
        await h.play(700);
        expect(memoryNotices(h)).toEqual([{ type: 'notice', code: 'menu-memory', message: MESSAGE }]);
        expect(lastState(h)).toBe('playing');
        expect(lastTelemetry(h)).toMatchObject({ menu: null, igErrors: 1 });
      });

      it('preloads the same clip under desktop without a notice', async () => {
        const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { igUnits: menuAt(0.2), subPathIg: { clipId: '00009', units: menuAt(0.2) }, extraFiles: big });
        await untilPlaying(h);
        await h.play(700);
        expect(memoryNotices(h)).toEqual([]);
        expect(lastTelemetry(h)?.igErrors).toBe(0);
      });

      it('caps the decoded frame queue at 4 for a 3840-wide stream under constrained', async () => {
        fakeCodedWidth.value = 3840;
        try {
          const h = await harness(undefined, {}, 'constrained');
          await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
          await h.play(1500, { render: false, audio: false });
          const size = (h.player as unknown as { presenter: { size: number } }).presenter.size;
          expect(size).toBe(4);
        } finally {
          fakeCodedWidth.value = 320;
        }
      });
    });

    it('keeps playing without a menu when the sub-path clip cannot be read', async () => {
      const h = await bootMenu({ subPathIg: { clipId: '00009', units: menuAt(0.2) }, dropFiles: ['BDMV/STREAM/00009.m2ts'] });
      await untilPlaying(h);
      await h.play(700);
      expect(lastState(h)).toBe('playing');
      expect(lastTelemetry(h)).toMatchObject({ menu: null, igErrors: 1 });
      expect(h.igDraws).toEqual([]);
    });

    it('shows the IG menu over no picture when the menu playlist is MPEG-2 video, and its buttons work', async () => {
      const segments = simpleMenuSegments({ cmds: [asm.jumpTitle(imm(1))] }).map((payload) => ({ pts: CLIP_START_PTS + 0.2 * 90_000, payload }));
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.playPl(imm(1))] }], {
        igUnits: segments,
        playlists: [{ ...shortPlaylists[0]!, videoCodingType: CodingType.MPEG2_VIDEO }, shortPlaylists[1]!],
      });
      await untilPlaying(h);
      await vi.waitFor(async () => {
        await h.play(100);
        expect(lastTelemetry(h)?.menu).not.toBeNull();
      }, { timeout: 5000 });
      expect(decoders).toHaveLength(0);
      const plane = h.igDraws.at(-1)!;
      expect(plane.hash()).not.toBe(new OverlayPlane(plane.width, plane.height).hash());
      expect(h.order.every((o) => !o.startsWith('video:') || o === 'video:null')).toBe(true);
      expect(h.events).toContainEqual({ type: 'unsupported', kind: 'video', codec: 'MPEG-2 video', message: NO_PICTURE_MESSAGE, noPicture: true });
      await h.player.handle({ type: 'menuKey', key: 'ok' });
      await untilPlaylist(h, '00001');
      await untilPlaying(h);
      expect(decoders).toHaveLength(1); // 00001 is H.264
    });

    it('reports no menu for a disc without IG', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
      await untilPlaying(h);
      await h.play(700);
      expect(lastTelemetry(h)).toMatchObject({ menu: null, igErrors: 0 });
      expect(h.igDraws).toEqual([]);
    });

    it('close while a menu is shown clears the plane and stops menu telemetry', async () => {
      const h = await bootMenu();
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const plane = h.igDraws[0]!;
      const emptyHash = new (plane.constructor as new (w: number, h: number) => OverlayPlane)(plane.width, plane.height).hash();
      expect(plane.hash()).not.toBe(emptyHash);
      await h.player.handle({ type: 'close' });
      expect(plane.hash()).toBe(emptyHash);
      expect(menuEvents(h).at(-1)).toMatchObject({ active: false });
      const seen = telemetries(h).length;
      await h.play(1200);
      expect(telemetries(h)).toHaveLength(seen);
    });

    it('a seek keeps the menu that is shown and does not draw units from the old read position', async () => {
      const h = await bootMenu({ igUnits: [...menuAt(0.2), ...simpleMenuSegments({ compositionState: 'normal' }).map((payload) => ({ pts: CLIP_START_PTS + 3 * 90_000, payload }))] });
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const activeEvents = menuEvents(h).length;
      await h.player.handle({ type: 'seek', timeUs: 1_000_000 });
      await h.play(1500);
      expect(menuEvents(h)).toHaveLength(activeEvents);
      expect(menuEvents(h).at(-1)).toMatchObject({ active: true });
      expect(lastTelemetry(h)!.menu).not.toBeNull();
    });

    it('stops drawing the IG plane every frame once it is empty', async () => {
      const h = await bootMenu();
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const plane = h.igDraws[0]!;
      plane.apply({ cmd: 'clear', pts: -1, x: 0, y: 0, w: 0, h: 0 });
      await h.play(100);
      const after = h.igDraws.length; // the clear itself was painted
      await h.play(500);
      expect(h.igDraws).toHaveLength(after);
    });
  });

  describe('disc profile', () => {
    const hdmvIndex: IndexSpec = { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'hdmv', movieObjectId: 0 }] };
    const regsOf = (h: Harness, key: 'navRegs' | 'pgRegs'): { psrRead(i: number): number } => (h.player as unknown as Record<string, { psrRead(i: number): number }>)[key];
    const profile = (r: { psrRead(i: number): number }): number[] => [29, 30, 31, 24, 25].map((i) => r.psrRead(i));
    const movieObjects = buildMovieObjects([{ cmds: [asm.playPl(imm(0))] }]);

    it('leaves an ordinary disc at the default profile', async () => {
      const plain = await harness(undefined);
      const nav = await harness(undefined, { movieObjects, index: hdmvIndex });
      expect(profile(regsOf(plain, 'pgRegs'))).toEqual(profile(new RegisterFile()));
      expect(profile(regsOf(nav, 'navRegs'))).toEqual(profile(new RegisterFile()));
    });

    it('leaves the language and country PSRs of an HDMV disc at their defaults (player settings apply under BD-J only, R9)', async () => {
      const playerSettings = { audioLanguage: 'jpn', pgLanguage: 'eng', menuLanguage: 'fre', country: 'jp' };
      const langs = (r: { psrRead(i: number): number }): number[] => [16, 17, 18, 19].map((i) => r.psrRead(i));
      const plain = await harness(undefined, { playerSettings });
      const nav = await harness(undefined, { movieObjects, index: hdmvIndex, playerSettings });
      expect(langs(regsOf(plain, 'pgRegs'))).toEqual(langs(new RegisterFile()));
      expect(langs(regsOf(nav, 'navRegs'))).toEqual(langs(new RegisterFile()));
    });

    it('applies the UHD profile to a 0300 index, with and without a navigator', async () => {
      const expected = new RegisterFile();
      expected.psrInitUhd(true);
      const index = { ...hdmvIndex, version: '0300' };
      const plain = await harness(undefined, { index });
      const nav = await harness(undefined, { movieObjects, index });
      expect(profile(regsOf(plain, 'pgRegs'))).toEqual(profile(expected));
      expect(profile(regsOf(nav, 'navRegs'))).toEqual(profile(expected));
      expect(regsOf(nav, 'navRegs').psrRead(31)).not.toBe(profile(new RegisterFile())[2]);
    });

    it('applies the 3D profile to a 0200 index with content', async () => {
      const expected = new RegisterFile();
      expected.psrInit3D(1, false);
      const index = { ...hdmvIndex, appInfo: { initialOutputModePreference: 1, contentExistFlag: true } };
      const plain = await harness(undefined, { index });
      const nav = await harness(undefined, { movieObjects, index });
      expect(profile(regsOf(plain, 'pgRegs'))).toEqual(profile(expected));
      expect(profile(regsOf(nav, 'navRegs'))).toEqual(profile(expected));
    });

    it('keeps the disc ID only for BD-J discs', async () => {
      const id = new Uint8Array(60);
      id.set([...'BDID0200'].map((c) => c.charCodeAt(0)));
      id.fill(0xab, 44, 60);
      const bdjIndex: IndexSpec = { firstPlay: { kind: 'bdj', name: '00000' }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [] };
      const discId = (h: Harness): unknown => (h.player as unknown as { bdjDiscId: unknown }).bdjDiscId;
      const extraFiles = { 'CERTIFICATE/ID.BDMV': id };
      expect(discId(await harness(undefined, { extraFiles }))).toBeNull();
      expect(discId(await harness(undefined, { index: bdjIndex, extraFiles }))).toBe('ab'.repeat(16));
      expect(discId(await harness(undefined, { index: bdjIndex }))).toBeNull();
    });
  });

  type Internals = { navRegs: { psrRead(i: number): number }; navigator: { processHdmvVmEvent(e: unknown): void }; navNextMark: number; session: unknown; syncNavigator(s: unknown): void };
  const internals = (h: Harness): Internals => h.player as unknown as Internals;

  it('updates the chapter PSR at once on a user seek, backwards too', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
    await untilPlaying(h);
    expect(internals(h).navRegs.psrRead(5)).toBe(1);
    await h.player.handle({ type: 'seek', timeUs: 3_500_000 });
    expect(internals(h).navRegs.psrRead(5)).toBe(4);
    await h.player.handle({ type: 'seek', timeUs: 1_500_000 });
    expect(internals(h).navRegs.psrRead(5)).toBe(2); // not left at the later chapter
    await h.player.handle({ type: 'prevChapter' });
    expect(internals(h).navRegs.psrRead(5)).toBe(1);
    await h.player.handle({ type: 'nextChapter' });
    expect(internals(h).navRegs.psrRead(5)).toBe(2);
  });

  it('reports no marks while a seek asked for by the program is still queued', async () => {
    const reached = vi.spyOn(Navigator.prototype, 'markReached');
    try {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
      await untilPlaying(h);
      await h.play(1300);
      const me = internals(h);
      reached.mockClear();
      me.navNextMark = 1; // as if the old position had a mark due
      me.navigator.processHdmvVmEvent({ type: 7, param: 0, param2: 0 }); // PLAY_PI 0: queues a seek to the start
      me.syncNavigator(me.session);
      expect(reached).not.toHaveBeenCalled();
      await h.play(100);
      me.navNextMark = 0; // the clock is back near 0 after the seek, mark 0 is due
      me.syncNavigator(me.session);
      expect(reached).toHaveBeenCalled(); // the seek ran, reporting is back
    } finally {
      reached.mockRestore();
    }
  });

  it('reads the new position while a seek waits for its audio decoder: no mark of the old position (_seek_internal)', async () => {
    let gate: Promise<void> = Promise.resolve();
    const reached = vi.spyOn(Navigator.prototype, 'markReached');
    try {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], {
        audioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4)],
        createAudioDecoder: (codingType) => fakeAudioFactory(undefined, gate)(codingType),
      });
      await untilPlaying(h);
      await h.play(3300);
      await h.player.handle({ type: 'pause' });
      let open: () => void = () => undefined;
      gate = new Promise<void>((r) => (open = r));
      reached.mockClear();
      const seeking = h.player.handle({ type: 'seek', timeUs: 500_000 });
      await h.play(100); // paused, its decoder still loading: the navigator is told about the new position only
      expect(reached).not.toHaveBeenCalled();
      expect((h.player as unknown as { clock: { nowUs(): number } }).clock.nowUs()).toBe(500_000);
      open();
      await seeking;
    } finally {
      reached.mockRestore();
    }
  });

  const clockOf = (h: Harness): number => (h.player as unknown as { clock: { nowUs(): number } }).clock.nowUs();

  const statesSince = (h: Harness, from: number): PlaybackState[] => h.events.slice(from).flatMap((e) => (e.type === 'state' ? [e.state] : []));
  const writerOf = (h: Harness): { frameAt(us: number): number } => (h.player as unknown as { audioWriter: { frameAt(us: number): number } }).audioWriter;

  /** Plays on from a playing state and checks the clock ran on the audio output, without buffering or underruns. */
  async function playsThrough(h: Harness, ms: number): Promise<void> {
    const from = h.events.length;
    const underruns = h.underruns();
    const startUs = clockOf(h);
    await h.play(ms);
    expect(statesSince(h, from)).not.toContain('buffering');
    expect((h.player as unknown as { clock: { mode: string } }).clock.mode).toBe('audio');
    expect(clockOf(h) - startUs).toBeGreaterThan(ms * 1000 - 100_000);
    expect(h.underruns() - underruns).toBe(0);
  }

  it('keeps the audio clock running through a play item without the selected audio stream', async () => {
    const h = await harness(CodingType.LPCM, { secondClipAudioStreams: [] });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    h.drawn.length = 0;
    await playsThrough(h, 5000);
    expect(Math.max(...h.drawn)).toBeGreaterThan(clockOf(h) - 100_000); // the second item's video kept up with the clock
    expect(Math.abs(lastTelemetry(h)?.avOffsetMeanUs ?? Infinity)).toBeLessThanOrEqual(20_000);
  });

  it('keeps the audio clock running through a play item whose audio PID never appears', async () => {
    const h = await harness(CodingType.LPCM, { secondClipAudioStreams: [{ ...lpcmStream(0x1100, 4), units: [] }] });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await playsThrough(h, 5000);
  });

  it('keeps the audio clock running without a picture through a play item without audio', async () => {
    const h = await harness(CodingType.LPCM, { secondClipAudioStreams: [], videoCodingType: CodingType.MPEG2_VIDEO });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await playsThrough(h, 5000);
  });

  it('plays a playlist whose first item has no audio on the audio clock, with the later audio in sync', async () => {
    const h = await harness(undefined, { audioStreams: [], secondClipAudioStreams: [lpcmStream(0x1100, 4)] });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await playsThrough(h, 5500);
    const first = h.audibleFrames[0];
    expect(first).toBeDefined();
    // the second item's tone starts where its PTS (4 s) maps in the ring: no earlier, and within a few frames
    expect(Math.abs(first! - writerOf(h).frameAt(4_000_000))).toBeLessThanOrEqual(4);
  });

  it('seeks into a play item without audio and back out of it on the audio clock', async () => {
    const h = await harness(CodingType.LPCM, { secondClipAudioStreams: [] });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 5_000_000 });
    await untilPlaying(h);
    await playsThrough(h, 1500);
    await h.player.handle({ type: 'seek', timeUs: 1_000_000 });
    await untilPlaying(h);
    h.audibleFrames.length = 0;
    await playsThrough(h, 1000);
    expect(h.audibleFrames.length).toBeGreaterThan(0);
  });

  it('keeps the audio clock running after an audio switch, into a play item without the new stream', async () => {
    const h = await harness(undefined, {
      audioStreams: [lpcmStream(0x1100, 4, { lang: 'jpn' }), lpcmStream(0x1101, 4, { lang: 'eng' })],
      secondClipAudioStreams: [lpcmStream(0x1100, 4, { lang: 'jpn' })],
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1500);
    await h.player.handle({ type: 'selectAudio', index: 2 });
    await untilPlaying(h);
    await playsThrough(h, 4500);
  });

  it('reads the new position while a seek waits for the ring to discard, into an item with no audio stream', async () => {
    const h = await harness(CodingType.LPCM, { secondClipAudioStreams: [] });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    await h.player.handle({ type: 'pause' });
    const seeking = h.player.handle({ type: 'seek', timeUs: 5_000_000 });
    await h.play(60, { audio: false }); // the worklet renders nothing: the discard is still pending
    expect(clockOf(h)).toBe(5_000_000);
    await h.play(300);
    await seeking;
  });

  it('opens a BD-J playlist paused at its start while its audio decoder loads: no mark or position of the old one', async () => {
    let gate: Promise<void> = Promise.resolve();
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], {
      audioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4)],
      createAudioDecoder: (codingType) => fakeAudioFactory(undefined, gate)(codingType),
    });
    await untilPlaying(h);
    await h.play(3300); // past the marks at 1, 2 and 3 s
    const marks: number[] = [];
    const positions: Array<[number, number]> = [];
    const listener: BdjPlaybackListener = {
      playlistStarted: () => undefined,
      playItemChanged: () => undefined,
      marksReached: (m) => marks.push(...m),
      position: (item, clipTime45) => positions.push([item, clipTime45]),
      seeked: () => undefined,
      playlistEnded: () => undefined,
    };
    type BdjInternals = { bdjListener: BdjPlaybackListener | null; playPlaylist(id: string, at: object, caller: 'bdj'): Promise<boolean> };
    const me = h.player as unknown as BdjInternals;
    me.bdjListener = listener;
    let open: () => void = () => undefined;
    gate = new Promise<void>((r) => (open = r));
    const opening = me.playPlaylist('00000', {}, 'bdj');
    await h.play(100); // paused (Java's START has not come), the decoder still loading
    expect(clockOf(h)).toBe(0);
    expect(marks.filter((m) => m > 0)).toEqual([]); // the marks at 1 s and later are not passed yet
    const inTime = (me as unknown as { session: { playItems: Array<{ inTime: number }> } }).session.playItems[0]!.inTime;
    expect(positions.length).toBeGreaterThan(0);
    for (const [item, clipTime45] of positions) expect([item, clipTime45]).toEqual([0, inTime]);
    open();
    await opening;
    await h.player.handle({ type: 'play' }); // as Java's selectRate(START)
    await h.play(1500);
    expect(marks.filter((m) => m > 0)).toEqual([1]); // the mark at 1 s, reported once it is reached
  });

  const twoLanguages = [lpcmStream(0x1100, 4, { lang: 'jpn' }), lpcmStream(0x1101, 4, { lang: 'eng' })];

  it('routes a user audio change through PSR1', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { audioStreams: twoLanguages });
    await untilPlaying(h);
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(selectedAudio(h)).toBe(2);
  });

  it('refuses a user audio change while primaryAudioChange is masked', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], {
      audioStreams: twoLanguages,
      playlists: [{ id: '00000', clipIds: ['00001'], uoMask: [0, 0, 0x04, 0, 0, 0, 0, 0] }],
    });
    await untilPlaying(h);
    expect(h.events).toContainEqual({ type: 'uoMask', masked: ['primaryAudioChange'] });
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(selectedAudio(h)).toBe(1);
  });

  describe('UO masks', () => {
    const masked = (h: Harness) => h.events.filter((e) => e.type === 'notice' && e.code === 'uo-masked');
    /** First Play plays 00000 with the given 8-byte playlist UO mask table. */
    const maskedPlaylist = async (uoMask: number[]) => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { playlists: [{ id: '00000', clipIds: ['00001'], uoMask, chapterEverySeconds: 1 }] });
      await untilPlaying(h);
      return h;
    };

    it('refuses a seek while timeSearch is masked: a notice, no seek, no buffering', async () => {
      const h = await maskedPlaylist([0x10, 0, 0, 0, 0, 0, 0, 0]);
      await h.play(500);
      const before = lastTelemetry(h)!.clockUs;
      const statesBefore = states(h).length;
      await h.player.handle({ type: 'seek', timeUs: 3_000_000 });
      await h.play(600);
      expect(masked(h)).toEqual([{ type: 'notice', code: 'uo-masked', message: "The disc doesn't allow this here." }]);
      expect(states(h).slice(statesBefore)).not.toContain('buffering');
      const after = lastTelemetry(h)!.clockUs;
      expect(after).toBeGreaterThan(before);
      expect(after).toBeLessThan(2_500_000);
    });

    it('refuses pause while pauseOn is masked and keeps playing', async () => {
      const h = await maskedPlaylist([0, 0x80, 0, 0, 0, 0, 0, 0]);
      await h.player.handle({ type: 'pause' });
      expect(masked(h)).toHaveLength(1);
      expect(lastState(h)).toBe('playing');
    });

    it('refuses next chapter while skipToNextPoint is masked', async () => {
      const h = await maskedPlaylist([0x08, 0, 0, 0, 0, 0, 0, 0]);
      await h.player.handle({ type: 'nextChapter' });
      expect(masked(h)).toHaveLength(1);
      expect(internals(h).navRegs.psrRead(5)).toBe(1);
    });

    it('tells the user when an audio change is refused', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], {
        audioStreams: twoLanguages,
        playlists: [{ id: '00000', clipIds: ['00001'], uoMask: [0, 0, 0x04, 0, 0, 0, 0, 0] }],
      });
      await untilPlaying(h);
      await h.player.handle({ type: 'selectAudio', index: 2 });
      expect(masked(h)).toHaveLength(1);
    });

    it('allows everything on a disc without a navigator', async () => {
      const h = await harness(CodingType.LPCM);
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.player.handle({ type: 'pause' });
      expect(masked(h)).toEqual([]);
    });
  });

  describe('review fixes', () => {
    const noticeCodes = (h: Harness) => h.events.flatMap((e) => (e.type === 'notice' ? [e.code] : []));

    it('keeps a held still frozen on the audio clock', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { playlists: [{ id: '00000', clipIds: ['00001'], stills: { 0: { mode: 2 } } }] });
      await untilPlaying(h);
      await h.play(4500);
      await h.play(1000);
      const frozen = lastTelemetry(h)?.clockUs;
      expect(frozen).toBeGreaterThan(3_900_000);
      expect(frozen).toBeLessThan(4_000_000);
      await h.play(2000, { audio: false }); // a suspended output: the worklet does not run, which is no stall while held
      expect(lastTelemetry(h)?.clockUs).toBe(frozen);
      expect(lastTelemetry(h)?.clockMode).toBe('audio');
      expect(noticeCodes(h)).not.toContain('audio-disabled');
    });

    it('reports the end of a time still once and moves on to the next item', async () => {
      const ended = vi.spyOn(Navigator.prototype, 'playItemEnded');
      const changed = vi.spyOn(Navigator.prototype, 'playItemChanged');
      try {
        const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { playlists: [{ id: '00000', clipIds: ['00001', '00002'], stills: { 0: { mode: 1, time: 1 } } }] });
        await untilPlaying(h);
        await h.play(7500);
        expect(ended.mock.calls.filter(([i]) => i === 0)).toHaveLength(1);
        expect(changed.mock.calls.map(([i]) => i)).toEqual([1]);
        expect(lastTelemetry(h)?.clockUs).toBeGreaterThan(4_500_000);
      } finally {
        ended.mockRestore();
        changed.mockRestore();
      }
    });

    it('does not start a playlist whose open was cancelled while loading', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
      await h.player.handle({ type: 'playTitle', title: 1 }); // jumping to an object stops the playlist that is still loading
      await h.play(500);
      expect(chapterIds(h)).toEqual([]);
      expect(lastState(h)).toBe('idle');
    });

    it('treats a playlist with a missing clip as invalid and lets the program continue', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(1)), asm.playPl(imm(0))] }, idle, idle], { dropFiles: ['BDMV/CLIPINF/00002.clpi'] });
      await untilPlaying(h);
      expect(chapterIds(h)).toEqual(['00000']);
      expect(h.events.some((e) => e.type === 'error' && e.code === 'internal')).toBe(false);
    });

    it('plays a program-started playlist of undecodable video without a picture, as a picked one', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(1))] }, idle, idle], {
        playlists: [
          { id: '00000', clipIds: ['00001'] },
          { id: '00001', clipIds: ['00002'], videoCodingType: CodingType.VC1 },
        ],
      });
      await untilPlaying(h);
      expect(chapterIds(h)).toEqual(['00001']);
      expect(h.events).toContainEqual({ type: 'unsupported', kind: 'video', codec: 'VC-1', message: NO_PICTURE_MESSAGE, noPicture: true });
      expect(h.events.some((e) => e.type === 'error')).toBe(false);
    });
  });
});

// ---- subtitles ----

const EMPTY = new OverlayPlane().hash();
const subtitleEvents = (h: Harness) => h.events.flatMap((e) => (e.type === 'subtitles' ? [e] : []));
const visibleAt = (h: Harness, x: number) => (h.pgDraws.at(-1)?.rgba({ x, y: 900, w: 1, h: 1 })[3] ?? 0) === 255;
/** The timestamp of the last video frame drawn: the presentation time (telemetry lags by up to 500 ms). */
const clockUs = (h: Harness) => h.drawn.at(-1) ?? 0;
/** Steps simulated time one render tick at a time (vi.waitFor would wait 50 ms between ticks) until `done`, at most 10 s. */
async function stepUntil(h: Harness, done: () => boolean): Promise<void> {
  for (let ms = 0; !done(); ms += STEP_MS) {
    if (ms > 10_000) throw new Error('condition not reached within 10 s of playback');
    await h.play(STEP_MS);
  }
}
const playUntil = (h: Harness, us: number) => stepUntil(h, () => clockUs(h) >= us);
/** Plays until a telemetry sample taken in [fromUs, toUs) arrives. */
async function telemetryBetween(h: Harness, fromUs: number, toUs: number): Promise<Telemetry> {
  await stepUntil(h, () => (lastTelemetry(h)?.clockUs ?? 0) >= fromUs);
  const t = lastTelemetry(h)!;
  expect(t.clockUs).toBeLessThan(toUs);
  return t;
}
const pgTelemetryBetween = async (h: Harness, fromUs: number, toUs: number): Promise<Telemetry['pg']> => (await telemetryBetween(h, fromUs, toUs)).pg;

describe('Player PG subtitles', () => {
  const at = (seconds: number, segs: Uint8Array[]) => segs.map((payload) => ({ pts: CLIP_START_PTS + Math.round(seconds * 90_000), payload }));
  /** Stream 1 (eng): 1.0–2.0 s at x 100, a forced caption 2.5–2.9 s at x 200, 3.0–3.5 s at x 300. Stream 2 (jpn): 1.1–3.9 s at x 500. */
  const pgStreams: SyntheticPgStream[] = [
    { pid: 0x1200, lang: 'eng', units: [
      ...at(1, subtitleSegments({ x: 100 })), ...at(2, clearSegments(1)),
      ...at(2.5, subtitleSegments({ x: 200, forced: true, compositionNumber: 2 })), ...at(2.9, clearSegments(3)),
      ...at(3, subtitleSegments({ x: 300, compositionNumber: 4 })), ...at(3.5, clearSegments(5)),
    ] },
    { pid: 0x1201, lang: 'jpn', units: [...at(1.1, subtitleSegments({ x: 500 })), ...at(3.9, clearSegments(1))] },
  ];
  async function raw(): Promise<Harness> {
    const h = await harness(CodingType.LPCM, { pgStreams });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    return h;
  }

  it('shows a picked stream at its time on a disc without a navigator, and lists the tracks', async () => {
    const h = await raw();
    expect(subtitleEvents(h).at(-1)).toEqual({ type: 'subtitles', pg: [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }], text: null, selected: 'off', scale: 1 });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 1 });
    expect(await pgTelemetryBetween(h, 1_000_000, 2_000_000)).toEqual({ objectsShown: 1, forced: 0 });
    await playUntil(h, 1_300_000);
    expect(visibleAt(h, 100)).toBe(true);
    await playUntil(h, 2_050_000);
    expect(h.pgDraws.at(-1)!.hash()).toBe(EMPTY);
    expect(await pgTelemetryBetween(h, 2_000_000, 2_500_000)).toEqual({ objectsShown: 0, forced: 0 });
    expect(lastTelemetry(h)!.pgErrors).toBe(0);
  });

  it('a seek clears the subtitle at once and the next one after the target appears', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await playUntil(h, 1_300_000);
    expect(visibleAt(h, 100)).toBe(true);
    await h.player.handle({ type: 'seek', timeUs: 2_050_000 });
    await h.play(STEP_MS);
    expect(h.pgDraws.at(-1)!.hash()).toBe(EMPTY);
    await untilPlaying(h);
    await playUntil(h, 3_100_000);
    expect(visibleAt(h, 300)).toBe(true);
    expect(visibleAt(h, 100)).toBe(false);
  });

  it('a seek into a subtitle whose display set lies before the keyframe shows it at once', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 2 } });
    // stream 2 shows 1.1–3.9 s; a seek to 2.5 s reads from the keyframe at 2 s, after the set at 1.1 s
    await h.player.handle({ type: 'seek', timeUs: 2_500_000 });
    await untilPlaying(h);
    await h.play(STEP_MS);
    expect(clockUs(h)).toBeLessThan(2_700_000);
    expect(visibleAt(h, 500)).toBe(true);
    await playUntil(h, 3_950_000);
    expect(visibleAt(h, 500)).toBe(false);
  });

  it('a paused seek past a subtitle that already ended shows nothing', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    // stream 1: 1.0–2.0 s at x 100; at 2.3 s nothing is up, though the sets at 1 s and 2 s are read again
    await h.player.handle({ type: 'pause' });
    await h.player.handle({ type: 'seek', timeUs: 2_300_000 });
    for (let i = 0; i < 20; i++) await h.play(STEP_MS);
    expect(visibleAt(h, 100)).toBe(false);
  });

  it('switching streams drops the old subtitle at once and shows the new stream\'s current one', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await playUntil(h, 1_300_000);
    expect(visibleAt(h, 100)).toBe(true);
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 2 } });
    await h.play(STEP_MS);
    expect(h.pgDraws.at(-1)!.hash()).toBe(EMPTY);
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 2 });
    const switchedAt = clockUs(h);
    await stepUntil(h, () => visibleAt(h, 500));
    expect(clockUs(h) - switchedAt).toBeLessThan(1_000_000);
  });

  it('stops drawing the PG plane every frame once its subtitle is cleared', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await playUntil(h, 1_300_000);
    const shown = h.pgDraws.length;
    await playUntil(h, 1_800_000);
    expect(h.pgDraws.length).toBeGreaterThan(shown + 10); // drawn with every frame while it is up
    await playUntil(h, 2_100_000); // the clear set at 2 s
    const cleared = h.pgDraws.length;
    await playUntil(h, 2_450_000);
    expect(h.pgDraws.length).toBe(cleared);
  });

  it('with subtitles off shows forced captions only', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'off' } });
    expect(await pgTelemetryBetween(h, 1_000_000, 2_000_000)).toEqual({ objectsShown: 0, forced: 0 });
    expect(visibleAt(h, 100)).toBe(false);
    expect(await pgTelemetryBetween(h, 2_500_000, 2_900_000)).toEqual({ objectsShown: 1, forced: 1 });
    await playUntil(h, 2_600_000);
    expect(visibleAt(h, 200)).toBe(true);
    await playUntil(h, 3_200_000);
    expect(visibleAt(h, 300)).toBe(false);
  });

  it('follows the disc program\'s registers with a navigator and refuses a masked change', async () => {
    const idle = { cmds: [] };
    const h = await harness(CodingType.LPCM, {
      pgStreams,
      movieObjects: buildMovieObjects([{ cmds: [asm.playPl(imm(0))] }, idle, idle]),
      playlists: [{ id: '00000', clipIds: ['00001'], uoMask: [0, 0, 0, 0x10, 0, 0, 0, 0] }],
    });
    await untilPlaying(h);
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 2 } });
    expect(h.events).toContainEqual({ type: 'notice', code: 'uo-masked', message: "The disc doesn't allow this here." });
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } }); // only the display flag: allowed
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 1 });
    await playUntil(h, 1_300_000);
    expect(visibleAt(h, 100)).toBe(true);
  });

  it('clears the plane and forgets the stream when the disc is closed', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await playUntil(h, 1_300_000);
    const plane = h.pgDraws.at(-1)!;
    await h.player.handle({ type: 'close' });
    expect(plane.hash()).toBe(EMPTY);
  });
});

/** ASS dependencies for Node: fonts registered by a fake loader that can be held back, glyphs measured by a fixed ratio. */
function fakeAssDeps(gate?: Promise<void>): NonNullable<PlayerDeps['createAssDeps']> {
  return async () => ({
    loader: { load: async () => { await gate; }, unload: () => undefined },
    defaultFont: await readFontFile('DejaVuSans.ttf', new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'))),
    measurer: createFixedMeasurer(0.5),
    createCanvas: () => ({}) as OffscreenCanvas,
    Path2D: class {} as unknown as typeof Path2D,
    canvasFilter: true,
  });
}

describe('Player text subtitles', () => {
  /** Cues at 1–2 s and 5–6 s of playlist time. */
  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:05,000 --> 00:00:06,000\nLater\n';
  const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
  const file = (name: string, text: string) => ({ name, bytes: bytes(text) });
  const notices = (h: Harness) => h.events.filter((e) => e.type === 'notice' && e.code === 'subtitle-file');
  const fontNotices = (h: Harness) => h.events.filter((e) => e.type === 'notice' && e.code === 'subtitle-fonts');
  const fontFile = (name: string, path = 'fixtures/ass/fonts/DejaVuSans.ttf') => ({ name, bytes: new Uint8Array(readFileSync(path)).buffer as ArrayBuffer });
  const ass = (font: string, ...events: string[]) => `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,40,40,50,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
  const dialogue = (from: string, to: string, text: string) => `Dialogue: 0,${from},${to},Default,,0,0,0,,${text}`;
  async function raw(opts: Parameters<typeof harness>[1] = {}): Promise<Harness> {
    const h = await harness(CodingType.LPCM, opts);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    return h;
  }
  const lastText = (h: Harness) => subtitleEvents(h).at(-1)!.text;

  it('loads a file, selects it, and reports a visible cue only during its time', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    expect(subtitleEvents(h).at(-1)).toEqual({ type: 'subtitles', pg: [], text: { files: [{ name: 'movie.srt', format: 'srt', cues: 2, startUs: 0, offsetMs: 0 }], missingFonts: [], episodeStarts: [0, 4_000_000] }, selected: 'text', scale: 1 });
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).textCue).toBe(true);
    expect((await telemetryBetween(h, 2_000_000, 5_000_000)).textCue).toBe(false);
  });

  it('asks once for an encoding for the files of a load that are not UTF-8, and loads them with the one given', async () => {
    const h = await raw();
    const latin = Uint8Array.from([...SRT.replace('Hello', 'Café')].map((c) => c.charCodeAt(0))).buffer as ArrayBuffer;
    await h.player.handle({ type: 'addTextSubtitles', files: [{ name: 'latin.srt', bytes: latin.slice(0) }, file('ok.srt', SRT)] });
    expect(h.events).toContainEqual({ type: 'subtitleEncodingNeeded', names: ['latin.srt'] });
    expect(lastText(h) ?? null).toBeNull();
    await h.player.handle({ type: 'addTextSubtitles', files: [{ name: 'latin.srt', bytes: latin }, file('ok.srt', SRT)], encoding: 'windows-1252' });
    expect(lastText(h)!.files.map((f) => f.name)).toEqual(['latin.srt', 'ok.srt']);
  });

  it('leaves out files without cues with a notice naming them, and keeps the old set when none is readable', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await h.player.handle({ type: 'addTextSubtitles', files: [file('empty.srt', 'not subtitles at all')] });
    expect(notices(h).at(-1)).toEqual({ type: 'notice', code: 'subtitle-file', message: 'empty.srt: this file has no subtitles we can read' });
    expect(lastText(h)!.files.map((f) => f.name)).toEqual(['movie.srt']);
    await h.player.handle({ type: 'addTextSubtitles', files: [file('bad.srt', '1\nnope\nx\n\n2\nnope\ny\n\n3\n00:00:01,000 --> 00:00:02,000\nok')] });
    expect(notices(h).at(-1)).toEqual({ type: 'notice', code: 'subtitle-file', message: 'Some lines of this file could not be read' });
    expect(lastText(h)!.files).toEqual([{ name: 'bad.srt', format: 'srt', cues: 1, startUs: 0, offsetMs: 0 }]);
  });

  it('shifts a file by its own offset and clamps offset and size', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await h.player.handle({ type: 'setSubtitleOffset', file: 0, ms: 1000 });
    expect(lastText(h)!.files[0]!.offsetMs).toBe(1000);
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).textCue).toBe(false);
    expect((await telemetryBetween(h, 2_000_000, 3_000_000)).textCue).toBe(true);
    await h.player.handle({ type: 'setSubtitleOffset', file: 0, ms: -9_999_999 });
    expect(lastText(h)!.files[0]!.offsetMs).toBe(-600_000);
    await h.player.handle({ type: 'setSubtitleScale', scale: 7 });
    expect(subtitleEvents(h).at(-1)!.scale).toBe(2);
    await h.player.handle({ type: 'setSubtitleScale', scale: 0.1 });
    expect(subtitleEvents(h).at(-1)!.scale).toBe(0.5);
  });

  it('hides the text when a PG stream or Off is picked, and removes the track', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'off' } });
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).textCue).toBe(false);
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'text' } });
    expect(subtitleEvents(h).at(-1)!.selected).toBe('text');
    await h.player.handle({ type: 'removeTextSubtitle' });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ text: null, selected: 'off' });
  });

  it('a PG pick hides the text track, and picking the text again turns PG\'s display flag off', async () => {
    const pgStreams: SyntheticPgStream[] = [{ pid: 0x1200, lang: 'eng', units: subtitleSegments({}).map((payload) => ({ pts: CLIP_START_PTS + 3 * 90_000, payload })) }];
    const h = await raw({ pgStreams });
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 1 });
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).textCue).toBe(false);
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'text' } });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ selected: 'text', pg: [{ index: 1, language: 'eng' }] });
    expect((await telemetryBetween(h, 3_000_000, 4_000_000)).pg).toEqual({ objectsShown: 0, forced: 0 }); // the PG line is not forced
  });

  it('keeps the track across the program\'s playlists and a raw pick, and drops it with the disc', async () => {
    const idle = { cmds: [] };
    const h = await harness(CodingType.LPCM, {
      playlists: [{ id: '00000', clipIds: ['00001'] }, { id: '00001', clipIds: ['00002'] }],
      movieObjects: buildMovieObjects([{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }, idle, idle]),
    });
    await untilPlaying(h);
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await stepUntil(h, () => h.events.some((e) => e.type === 'chapters' && e.playlistId === '00001'));
    const switched = h.events.length;
    const sampleAfterSwitch = () => h.events.slice(switched).flatMap((e) => (e.type === 'telemetry' && e.telemetry.clockUs >= 1_000_000 ? [e.telemetry] : []))[0];
    await stepUntil(h, () => sampleAfterSwitch() !== undefined);
    expect(sampleAfterSwitch()!.clockUs).toBeLessThan(2_000_000); // the second playlist's own time
    expect(sampleAfterSwitch()!.textCue).toBe(true);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' }); // a raw pick: same disc
    expect(lastText(h)!.files.map((f) => f.name)).toEqual(['movie.srt']);
    await h.player.handle({ type: 'close' });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ text: null, pg: [] });
    const other = buildSyntheticDisc({ clips: [syntheticClip('00009', 2)], playlists: [{ id: '00009', clipIds: ['00009'] }] });
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(other) } });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ text: null, selected: 'off' });
  });

  it('places two files on the two play items and shows each in its own item', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('ep2.srt', SRT), file('ep1.srt', SRT)] });
    expect(lastText(h)!.files.map((f) => [f.name, f.startUs])).toEqual([['ep1.srt', 0], ['ep2.srt', 4_000_000]]);
    expect(await telemetryBetween(h, 1_000_000, 2_000_000)).toMatchObject({ textCue: true, textFile: 0 });
    expect(await telemetryBetween(h, 4_000_000, 5_000_000)).toMatchObject({ textCue: false, textFile: 1 });
    expect(await telemetryBetween(h, 5_000_000, 6_000_000)).toMatchObject({ textCue: true, textFile: 1 }); // file 2's cue at 1 s
  });

  it('places only the first of more files than episodes, with a notice, and moves a file by setSubtitleStart', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('a.srt', SRT), file('b.srt', SRT), file('c.srt', SRT)] });
    expect(lastText(h)!.files.map((f) => f.startUs)).toEqual([0, null, null]);
    expect(notices(h).at(-1)).toEqual({ type: 'notice', code: 'subtitle-file', message: "Place each subtitle file at its episode's start in the subtitle menu" });
    await h.player.handle({ type: 'setSubtitleStart', file: 1, startUs: 2_000_000 });
    expect(lastText(h)!.files.map((f) => f.startUs)).toEqual([0, 2_000_000, null]);
    await h.player.handle({ type: 'setSubtitleOffset', file: 1, ms: 200 });
    expect(lastText(h)!.files.map((f) => f.offsetMs)).toEqual([0, 200, 0]);
  });

  it('loads an ASS file with its font and reports no missing family', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('sign.ass', ass('DejaVu Sans', dialogue('0:00:01.00', '0:00:02.00', 'hi')))], fonts: [fontFile('DejaVuSans.ttf')] });
    expect(lastText(h)).toEqual({ files: [{ name: 'sign.ass', format: 'ass', cues: 1, startUs: 0, offsetMs: 0 }], missingFonts: [], episodeStarts: [0, 4_000_000] });
    expect(fontNotices(h)).toEqual([]);
    const t = await telemetryBetween(h, 1_000_000, 2_000_000);
    expect(t.textCue).toBe(true);
    expect(t.ass).not.toBeNull();
  });

  it('reports a missing family once, and clears it when the font is added', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('sign.ass', ass('DejaVu Serif', dialogue('0:00:01.00', '0:00:02.00', 'hi')))] });
    expect(lastText(h)!.missingFonts).toEqual(['DejaVu Serif']);
    expect(fontNotices(h)).toEqual([{ type: 'notice', code: 'subtitle-fonts', message: 'Some fonts are missing and were replaced: DejaVu Serif' }]);
    await h.player.handle({ type: 'addSubtitleFonts', fonts: [fontFile('DejaVuSerif.ttf', 'fixtures/ass/fonts/DejaVuSerif.ttf')] });
    expect(lastText(h)!.missingFonts).toEqual([]);
    expect(fontNotices(h)).toHaveLength(1);
  });

  it('names unreadable font files', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('sign.ass', ass('DejaVu Sans', dialogue('0:00:01.00', '0:00:02.00', 'hi')))], fonts: [{ name: 'broken.ttf', bytes: new ArrayBuffer(10) }] });
    expect(fontNotices(h)).toContainEqual({ type: 'notice', code: 'subtitle-fonts', message: 'Some font files could not be read: broken.ttf' });
  });

  it('drops a load whose fonts are still loading when the disc closes or another load starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await raw({ createAssDeps: fakeAssDeps(gate) });
    const first = h.player.handle({ type: 'addTextSubtitles', files: [file('one.ass', ass('DejaVu Sans', dialogue('0:00:01.00', '0:00:02.00', 'one')))] });
    await new Promise((r) => setTimeout(r, 0));
    const second = h.player.handle({ type: 'addTextSubtitles', files: [file('two.srt', SRT)] });
    release();
    await Promise.all([first, second]);
    expect(lastText(h)!.files.map((f) => f.name)).toEqual(['two.srt']);
    const late = h.player.handle({ type: 'addTextSubtitles', files: [file('three.ass', ass('DejaVu Sans', dialogue('0:00:01.00', '0:00:02.00', 'x')))] });
    await h.player.handle({ type: 'close' });
    await late;
    expect(subtitleEvents(h).at(-1)!.text).toBeNull();
  });

  it('treats an unrecognised file as unreadable, and reports no ASS telemetry for SRT', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('x.ass', '[Script Info]\nnothing else\n')] });
    expect(notices(h).at(-1)).toEqual({ type: 'notice', code: 'subtitle-file', message: 'x.ass: this file has no subtitles we can read' });
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).ass).toBeNull();
  });
});


describe('Player video shaders', () => {
  const PASS = '//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n';
  const setA: ShaderSetData = { name: 'A', files: [{ name: 'a.glsl', source: PASS }] };

  /** Compiles when `finish()` is called; renders a sentinel image. */
  function fakeShaders() {
    const pending: Array<() => void> = [];
    const created: Array<{ lost(): void; restored(): void }> = [];
    const image = { shaded: true } as unknown as OffscreenCanvas;
    const backend: ShaderBackend = {
      compile: (passes) => new Promise<CompiledSet>((resolve) => pending.push(() => resolve({ passes, dispose: () => undefined }))),
      render: (set) => ({ image, passesRun: set.passes.length, gpuMs: null }),
    };
    return {
      created,
      createShaderBackend: (events: { lost(): void; restored(): void }) => {
        created.push(events);
        return backend;
      },
      finish: async () => {
        for (const p of pending.splice(0)) p();
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }
  const shaderStatuses = (events: EngineEvent[]) => events.flatMap((e) => (e.type === 'shaderStatus' ? [e] : []));

  it('creates the backend only when a set is chosen, and hands a set chosen before the canvas to the compositor', async () => {
    const shaders = fakeShaders();
    const events: EngineEvent[] = [];
    const stages: Array<ShaderStage | null> = [];
    const player = new Player({
      emit: (e) => events.push(e), videoCodecApi: fakeApi, nowMs: () => 0, requestFrame: () => undefined, createAudioDecoder: noWasmFactory,
      createShaderBackend: shaders.createShaderBackend,
      createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined, setShaderStage: (s) => stages.push(s) }),
    });
    await player.handle({ type: 'setVideoShaders', set: null });
    expect(shaders.created).toHaveLength(0);
    expect(shaderStatuses(events)).toEqual([{ type: 'shaderStatus', state: 'off', set: null, error: null }]);
    await player.handle({ type: 'setVideoShaders', set: setA });
    expect(shaders.created).toHaveLength(1);
    expect(shaderStatuses(events).at(-1)).toEqual({ type: 'shaderStatus', state: 'compiling', set: 'A', error: null });
    await shaders.finish();
    expect(shaderStatuses(events).at(-1)).toEqual({ type: 'shaderStatus', state: 'active', set: 'A', error: null });
    await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
    expect(stages).toHaveLength(1);
    expect(stages[0]).toBeInstanceOf(ShaderStage);
    await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
    expect(stages).toHaveLength(2);
    expect(stages[1]).toBe(stages[0]);
  });

  it('reports unavailable when the browser has no backend', async () => {
    const h = await harness(CodingType.LPCM, { createShaderBackend: () => 'no WebGL2 here' });
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    expect(shaderStatuses(h.events)).toEqual([{ type: 'shaderStatus', state: 'unavailable', set: 'A', error: 'no WebGL2 here' }]);
  });

  it('reports unavailable when the backend factory throws', async () => {
    const h = await harness(CodingType.LPCM, {
      createShaderBackend: () => {
        throw new Error('OffscreenCanvas failed');
      },
    });
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    expect(shaderStatuses(h.events)).toEqual([{ type: 'shaderStatus', state: 'unavailable', set: 'A', error: UNAVAILABLE }]);
    expect(h.events.some((e) => e.type === 'state' && e.state === 'error')).toBe(false);
  });

  it('reports unavailable without a backend factory', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    expect(shaderStatuses(h.events).at(-1)).toMatchObject({ state: 'unavailable', set: 'A' });
  });

  it('keeps the chosen set across closing and opening a disc, and reports it in telemetry', async () => {
    const shaders = fakeShaders();
    const h = await harness(CodingType.LPCM, { createShaderBackend: shaders.createShaderBackend });
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    await shaders.finish();
    expect(h.shaderStages).toHaveLength(1);
    await h.player.handle({ type: 'close' });
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: h.entries } });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(600); // a telemetry sample after frames were drawn
    expect(h.shaderStages).toEqual([expect.any(ShaderStage)]);
    expect(shaderStatuses(h.events).map((e) => e.state)).toEqual(['compiling', 'active']);
    expect(lastTelemetry(h)!.shader).toEqual({ set: 'A', passesRun: 1, gpuMs: null });
    await h.player.handle({ type: 'setVideoShaders', set: null });
    await h.play(600);
    expect(lastTelemetry(h)!.shader).toBeNull();
  });

  it('activates a set whose compile finishes after the disc closed, and shades the next disc', async () => {
    const shaders = fakeShaders();
    const h = await harness(CodingType.LPCM, { createShaderBackend: shaders.createShaderBackend });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    await h.player.handle({ type: 'close' });
    await shaders.finish(); // no session, no current frame
    expect(shaderStatuses(h.events).at(-1)).toMatchObject({ state: 'active', set: 'A' });
    h.order.length = 0;
    expect(() => h.player.tick()).not.toThrow();
    expect(h.order).toEqual([]);
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: h.entries } });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(600);
    expect(h.order.some((o) => o !== 'video:null')).toBe(true);
    expect(lastTelemetry(h)!.shader).toEqual({ set: 'A', passesRun: 1, gpuMs: null });
  });

  it('repaints the paused frame and its overlays once the set is ready', async () => {
    const shaders = fakeShaders();
    const at = (seconds: number, segs: Uint8Array[]) => segs.map((payload) => ({ pts: CLIP_START_PTS + Math.round(seconds * 90_000), payload }));
    const h = await harness(CodingType.LPCM, { createShaderBackend: shaders.createShaderBackend, pgStreams: [{ pid: 0x1200, lang: 'eng', units: at(1, subtitleSegments({ x: 100 })) }] });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await untilPlaying(h);
    await stepUntil(h, () => clockUs(h) >= 1_300_000);
    await h.player.handle({ type: 'pause' });
    await h.play(200);
    const current = h.drawn.at(-1);
    h.order.length = 0;
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    h.player.tick();
    expect(h.order).toEqual([]); // compiling: nothing to repaint yet
    await shaders.finish();
    h.player.tick();
    expect(h.order).toEqual([`video:${current}`, 'pg']);
    h.order.length = 0;
    h.player.tick();
    expect(h.order).toEqual([]);
  });
});

describe('Player with a disc on the NAS', () => {
  const titlesOf = (h: Harness) => h.events.find((e) => e.type === 'titles');

  it('opens disc1 by HTTP range reads and plays it; the small files come from the manifest', async () => {
    const nas = fakeNas(fixtureDiscFiles('disc1'));
    const h = await harness(undefined, { remote: nas });
    expect(titlesOf(h)).toMatchObject({ playlists: [expect.objectContaining({ id: '00000' }), expect.objectContaining({ id: '00001' })] });
    expect(nas.requested.every((p) => p.startsWith('BDMV/STREAM/'))).toBe(true); // index, playlists and clip info are inlined
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(500);
    expect(h.drawn.length).toBeGreaterThan(5);
    expect(nas.requested).toContain('BDMV/STREAM/00001.M2TS');
  });

  it('reads a disc through its fetch port (the WebRTC route), not its own fetch: it plays and seeks', async () => {
    const nas = fakeNas(fixtureDiscFiles('disc1'));
    const { port1, port2 } = new MessageChannel();
    const stop = serveFetch(port1, nas.fetch);
    const ownFetch = vi.fn(async () => {
      throw new TypeError('the engine fetched directly');
    });
    const remote: FakeNas = { ...nas, spec: { ...nas.spec, fetchPort: port2 }, fetch: ownFetch as unknown as typeof fetch };
    try {
      const h = await harness(undefined, { remote });
      expect(titlesOf(h)).toMatchObject({ playlists: [expect.objectContaining({ id: '00000' }), expect.objectContaining({ id: '00001' })] });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.play(300);
      expect(nas.requested).toContain('BDMV/STREAM/00001.M2TS');
      await h.player.handle({ type: 'seek', timeUs: 5_000_000 });
      await untilPlaying(h);
      await h.play(300);
      expect(nas.requested).toContain('BDMV/STREAM/00002.M2TS');
      expect(h.drawn.length).toBeGreaterThan(5);
      expect(ownFetch).not.toHaveBeenCalled();
    } finally {
      stop();
      port1.close();
    }
  });

  it('drops a port disc whose read is held when another disc opens: its port closes first, and no error follows', async () => {
    const nas = fakeNas(fixtureDiscFiles('disc1'));
    const { port1, port2 } = new MessageChannel();
    const held: AbortSignal[] = [];
    // the main thread's serving: stream reads past the first chunk hang until the engine aborts them
    const stop = serveFetch(port1, (async (input: string | URL | Request, init?: RequestInit) => {
      const from = Number(/^bytes=(\d+)-/.exec(new Headers(init?.headers).get('Range') ?? '')?.[1] ?? 0);
      if (!String(input).includes('/STREAM/') || from === 0) return nas.fetch(input, init);
      held.push(init!.signal!);
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    }) as typeof fetch);
    const remote: FakeNas = { ...nas, spec: { ...nas.spec, fetchPort: port2 } };
    const h = await harness(undefined, { remote, remoteLimits: { chunkBytes: 64 * 1024 } });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    const before = h.events.length;
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: h.entries } });
    const after = h.events.slice(before);
    expect(after.filter((e) => e.type === 'fetchPortClosed')).toHaveLength(1);
    // as the controller does: what serves the port stops only once the engine has closed it
    stop();
    port1.close();
    await h.play(200);
    expect(h.events.slice(before).filter((e) => e.type === 'error')).toEqual([]);
    expect(held.every((s) => s.aborted)).toBe(true);
    expect(h.events.slice(before)).toContainEqual(expect.objectContaining({ type: 'titles' }));
  });

  it('closes the fetch port of a disc that fails to open', async () => {
    const nas = fakeNas(fixtureDiscFiles('disc1'));
    const { port1, port2 } = new MessageChannel();
    const stop = serveFetch(port1, nas.fetch);
    const manifest = { ...nas.spec.manifest, inline: {} }; // index.bdmv must be read, and the NAS has none at that path
    const broken: FakeNas = { ...nas, spec: { ...nas.spec, manifest: { ...manifest, files: manifest.files.filter((f) => !f.path.endsWith('INDEX.BDMV')) }, fetchPort: port2 } };
    try {
      const h = await harness(undefined, { remote: broken, noOpen: true });
      await h.player.handle({ type: 'open', disc: broken.spec });
      expect(h.events.some((e) => e.type === 'error')).toBe(true);
      expect(h.events.filter((e) => e.type === 'fetchPortClosed')).toHaveLength(1);
    } finally {
      stop();
      port1.close();
    }
  });

  it('asks for a fresh token on a 401 while a command waits on the read, and carries on with it', async () => {
    const nas = fakeNas(fixtureDiscFiles('disc1'), 'fresh');
    const remote = { ...nas, spec: { ...nas.spec, token: 'expired' } };
    const h = await harness(undefined, { remote, noOpen: true });
    const opening = h.player.handle({ type: 'open', disc: remote.spec });
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: 'remoteTokenNeeded' }));
    await h.player.handle({ type: 'remoteToken', token: 'fresh' }); // not queued behind the open
    await opening;
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    expect(h.events.filter((e) => e.type === 'remoteTokenNeeded')).toHaveLength(1);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('stops the read-ahead of a disc whose open fails', async () => {
    const files = fixtureDiscFiles('disc1');
    const clip = files.get('BDMV/STREAM/00001.m2ts') ?? files.get('BDMV/STREAM/00001.M2TS')!;
    for (let k = 0; k < 32; k++) clip[k * 192 + 4] = 0; // no sync bytes: the open fails as unreadable
    const nas = fakeNas(files);
    const ahead: AbortSignal[] = [];
    const held: FakeNas = {
      ...nas,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const from = Number(/^bytes=(\d+)-/.exec(new Headers(init?.headers).get('Range') ?? '')?.[1] ?? 0);
        if (from === 0) return nas.fetch(input, init);
        ahead.push(init!.signal!); // read-ahead: held until aborted
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
      }) as typeof fetch,
    };
    const h = await harness(undefined, { remote: held, remoteLimits: { chunkBytes: 64 * 1024 }, noOpen: true });
    await h.player.handle({ type: 'open', disc: held.spec });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'unreadable-stream' }));
    expect(ahead.length).toBeGreaterThan(0);
    expect(ahead.every((signal) => signal.aborted)).toBe(true);
  });

  it('reports a disc that changed on the NAS with its own code and the copy', async () => {
    const nas = fakeNas(fixtureDiscFiles('disc1'));
    const changed: FakeNas = { ...nas, fetch: (async () => Response.json({ error: 'disc-changed' }, { status: 404 })) as typeof fetch };
    const h = await harness(undefined, { remote: changed });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual({ type: 'error', code: 'disc-changed', message: 'This disc changed on the NAS. Open its folder again.', paths: ['BDMV/STREAM/00001.M2TS'] });
  });

  const CHUNK = 64 * 1024;
  /** TS_recording_rate of the 3 s tests, bytes per second: 3 s is 24 chunks of 64 KiB, in 192-byte source packets. */
  const RATE = 500_000;
  const NEEDED_CHUNKS = Math.ceil((3 * RATE * 192) / 188 / CHUNK);
  const READ = DEFAULT_CHUNK_PACKETS * SOURCE_PACKET_SIZE;
  /**
   * The offset that holds read-ahead one chunk short of 3 s when the reader has read up to `reads` reads from the
   * clip's start (the last of them its prefetch, whose chunk it holds; read-ahead is counted after it).
   */
  const gateAfter = (reads: number): number => Math.ceil((reads * READ) / CHUNK) * CHUNK + (NEEDED_CHUNKS - 1) * CHUNK;

  /** A fake NAS whose clips have TS_recording_rate `rate`; reads of a clip at or past its limit wait until it is raised. */
  function gatedNas(files: Map<string, Uint8Array<ArrayBuffer>>, rate: number, limits: Record<string, number>) {
    for (const id of ['00001', '00002']) {
      const clpi = files.get(`BDMV/CLIPINF/${id}.clpi`)!;
      new DataView(clpi.buffer, clpi.byteOffset).setUint32(52, rate);
    }
    const nas = fakeNas(files);
    let waiting: Array<() => void> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const from = Number(/^bytes=(\d+)-/.exec(new Headers(init?.headers).get('Range') ?? '')?.[1] ?? 0);
      const clip = /(\d{5})\.M2TS/.exec(String(input))?.[1];
      while (clip !== undefined && from >= (limits[clip] ?? Infinity)) await new Promise<void>((r) => waiting.push(r));
      return nas.fetch(input, init);
    }) as typeof globalThis.fetch;
    const raise = (clip: string, limit: number): void => {
      limits[clip] = limit;
      const woken = waiting;
      waiting = [];
      for (const wake of woken) wake();
    };
    return { nas: { ...nas, fetch }, raise };
  }

  it("starts the clock only once 3 s of stream at the clip's TS_recording_rate are read ahead", async () => {
    let gate!: ReturnType<typeof gatedNas>;
    const h = await harness(undefined, {
      frameBytes: 70_000, // clips of about 7 MB, well past the gate
      remoteLimits: { chunkBytes: CHUNK },
      remote: (files) => (gate = gatedNas(files, RATE, { '00001': gateAfter(2) })).nas,
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await vi.waitFor(
      async () => {
        await h.play(20);
        expect(lastTelemetry(h)?.framesPresented ?? 0).toBeGreaterThan(0); // the first picture is up: video is ready
      },
      { timeout: 10_000 }, // the 1 s default is too short for the first frame on a loaded CI runner
    );
    await h.play(1000);
    expect(lastState(h)).toBe('buffering');
    expect(states(h)).not.toContain('playing');
    gate.raise('00001', Infinity);
    await untilPlaying(h);
  });

  it('starts short of 3 s once the read-ahead budget is full', async () => {
    // 3 s at 10 MB/s is far more than the 1 MiB budget can hold, and the clip (12 s, about 21 MB) is not read to its
    // end: the reader stops a few seconds in (backpressure) and read-ahead stops 1 MiB after it.
    const h = await harness(undefined, {
      frameBytes: 70_000,
      clipSeconds: 12,
      remoteLimits: { chunkBytes: CHUNK, readAheadBytes: 1024 * 1024 },
      remote: (files) => gatedNas(files, 10_000_000, {}).nas,
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
  });

  it('starts short of 3 s once the clip is read to its end', async () => {
    // 3 s at 10 MB/s is more than the whole clip (about 50 kB).
    const h = await harness(undefined, { remoteLimits: { chunkBytes: CHUNK }, remote: (files) => gatedNas(files, 10_000_000, {}).nas });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
  });

  it('resumes after an underrun only once 3 s are read ahead again', async () => {
    // The second clip (about 12 MB with LPCM audio) gets the reader's first two reads; once they are played out the
    // output runs dry. Its next two reads then arrive, with read-ahead one chunk short of 3 s after them.
    let gate!: ReturnType<typeof gatedNas>;
    const h = await harness(CodingType.LPCM, {
      frameBytes: 110_000,
      remoteLimits: { chunkBytes: CHUNK },
      remote: (files) => (gate = gatedNas(files, RATE, { '00002': Math.ceil((2 * READ) / CHUNK) * CHUNK })).nas,
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await vi.waitFor(
      async () => {
        await h.play(100);
        expect(lastState(h)).toBe('buffering');
      },
      { timeout: 10_000 },
    );
    const before = states(h).length;
    gate.raise('00002', gateAfter(4));
    await h.play(1500);
    expect(lastState(h)).toBe('buffering');
    expect(states(h).slice(before)).not.toContain('playing');
    expect(h.ringPlaying()).toBe(false);
    gate.raise('00002', Infinity);
    await untilPlaying(h);
  }, 30_000); // its waits allow 10 s; vitest's 5 s default would cut the test off first on a loaded runner

  it('shows "Waiting for the NAS drive…" while a read takes over 3 s, and clears it when the read lands', async () => {
    const nas = fakeNas(fixtureDiscFiles('disc1'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: FakeNas = { ...nas, fetch: (async (input: string | URL | Request, init?: RequestInit) => (await gate, nas.fetch(input, init))) as typeof fetch };
    const h = await harness(undefined, { remote: slow, noOpen: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const picking = h.player.handle({ type: 'open', disc: slow.spec });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.events).toContainEqual({ type: 'notice', code: 'nas-waiting', message: 'Waiting for the NAS drive…' });
      expect(h.events).not.toContainEqual({ type: 'noticeCleared', code: 'nas-waiting' });
      release();
      await vi.advanceTimersByTimeAsync(0);
      await picking;
      expect(h.events).toContainEqual({ type: 'noticeCleared', code: 'nas-waiting' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Player buffering a NAS disc ahead (buffer first)', () => {
  const CHUNK = 64 * 1024;
  const P1 = 'BDMV/STREAM/00001.M2TS';
  const P2 = 'BDMV/STREAM/00002.M2TS';

  /**
   * A fake NAS that logs each range read (path, first byte, and whether it was aborted). Reads of a clip at or past its
   * limit wait until the limit is raised; gate(true) limits every clip to its first chunk (so the open, which reads the
   * main clip's first unit, gets through). `failFrom` makes stream reads at or past it answer that the disc changed.
   */
  function loggedNas(files: Map<string, Uint8Array<ArrayBuffer>>) {
    const nas = fakeNas(files);
    const reads: Array<{ path: string; from: number; aborted?: boolean }> = [];
    const limits = new Map<string, number>();
    let failFrom = Infinity;
    let waiting: Array<() => void> = [];
    const wakeAll = (): void => {
      const woken = waiting;
      waiting = [];
      for (const wake of woken) wake();
    };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = /files\/(.+?)(\?|$)/.exec(String(input))?.[1]?.split('/').map(decodeURIComponent).join('/') ?? '';
      const from = Number(/^bytes=(\d+)-/.exec(new Headers(init?.headers).get('Range') ?? '')?.[1] ?? 0);
      const read: { path: string; from: number; aborted?: boolean } = { path, from };
      reads.push(read);
      init?.signal?.addEventListener('abort', () => (read.aborted = true));
      while (from >= (limits.get(path) ?? limits.get('*') ?? Infinity) && !init?.signal?.aborted) await new Promise<void>((r) => waiting.push(r));
      init?.signal?.throwIfAborted();
      if (path.includes('/STREAM/') && from >= failFrom) return Response.json({ error: 'disc-changed' }, { status: 404 });
      return nas.fetch(input, init);
    }) as typeof globalThis.fetch;
    return {
      nas: { ...nas, fetch },
      reads,
      gate: (on: boolean) => {
        limits.clear();
        if (on) limits.set('*', CHUNK);
        wakeAll();
      },
      limit: (path: string, from: number) => {
        limits.set(path, from);
        wakeAll();
      },
      failFrom: (from: number) => (failFrom = from),
      /** Wakes waiting reads so an aborted one can give up. */
      poke: wakeAll,
    };
  }

  const progress = (h: Harness) => h.events.filter((e): e is Extract<EngineEvent, { type: 'bufferProgress' }> => e.type === 'bufferProgress');
  /** The fill reached its target. */
  const filled = (h: Harness) =>
    vi.waitFor(
      () => {
        const last = progress(h).at(-1);
        expect(last).toBeDefined();
        expect(last!.bytes).toBeGreaterThanOrEqual(last!.targetBytes);
      },
      { timeout: 10_000 },
    );

  async function setup(extra: { noOpen?: boolean; segmentBytes?: number; playlists?: SyntheticPlaylistSpec[]; noCache?: boolean } = {}) {
    let log!: ReturnType<typeof loggedNas>;
    let files!: Map<string, Uint8Array<ArrayBuffer>>;
    const cacheRoot = new MemoryDirectory();
    const h = await harness(undefined, {
      frameBytes: 20_000, // clips of about 2 MB: many chunks, and several keyframes in each EP map
      remoteLimits: { chunkBytes: CHUNK, readAheadBytes: 2 * CHUNK }, // the open's own read-ahead stops at once
      ...(extra.noCache ? {} : { cacheRoot }),
      remote: (f) => ((files = f), (log = loggedNas(f)).nas),
      ...(extra.noOpen ? { noOpen: true } : {}),
      ...(extra.segmentBytes ? { segmentBytes: extra.segmentBytes } : {}),
      ...(extra.playlists ? { playlists: extra.playlists } : {}),
    });
    if (!extra.noOpen) await h.play(50); // the open's reads (the first clip's first unit, and read-ahead) land
    const streamSize = (id: string) => files.get(`BDMV/STREAM/${id}.m2ts`)!.length;
    const spec = (log.nas as FakeNas).spec;
    /** The cache files of `path` on disk (segment files only). */
    const cachedFiles = async (path: string) => {
      const disc = await (await cacheRoot.getDirectoryHandle(CACHE_DIR)).getDirectoryHandle(safeName('d1'));
      return [...disc.entries.keys()].filter((n) => n.startsWith(`${safeName(path)}.`) && n.endsWith('.bin'));
    };
    /** The EP-map chunk a play from `seconds` (in the second clip, of 4 s each) starts reading at. */
    const startChunkAt = (seconds: number) => {
      const [first, item] = parseMpls(files.get('BDMV/PLAYLIST/00000.mpls')!).playItems as [PlayItem, PlayItem];
      const clipTime45 = item.inTime + seconds * 45_000 - (first.outTime - first.inTime);
      const clpi = parseClpi(files.get('BDMV/CLIPINF/00002.clpi')!);
      const spn = findEpBefore(clpi.epMaps[0]!, clipTime45, stcSpnRange(clpi, item.stcId))!.spn;
      expect(spn).toBeGreaterThan(0);
      return Math.floor((spn * SOURCE_PACKET_SIZE) / CHUNK) * CHUNK;
    };
    return { h, log, files, cacheRoot, streamSize, spec, cachedFiles, startChunkAt };
  }

  it('fills the cache from the EP map entry for fromSeconds, reporting progress', async () => {
    const { h, log, streamSize, startChunkAt } = await setup();
    log.reads.length = 0;
    // 5 s is 1 s into the second play item (clips of 4 s)
    await h.player.handle({ type: 'bufferAhead', fromSeconds: 5, targetBytes: Number.MAX_SAFE_INTEGER });
    await filled(h);
    const start = startChunkAt(5);
    const streamReads = log.reads.filter((r) => r.path.includes('/STREAM/'));
    expect(streamReads.every((r) => r.path === P2)).toBe(true);
    expect(Math.min(...streamReads.map((r) => r.from))).toBe(start); // two are in flight at once, so they may log out of order
    const last = progress(h).at(-1)!;
    expect(last.targetBytes).toBe(streamSize('00002') - start); // all there is from there on
    expect(last.stopped).toBeUndefined();
    expect(progress(h).length).toBeGreaterThan(5);
    expect(progress(h).map((p) => p.bytes)).toEqual([...progress(h).map((p) => p.bytes)].sort((a, b) => a - b));
  });

  it('a fill running when setLevel switches the version starts again on the new one, reporting progress', async () => {
    const { h, log, spec } = await setup();
    log.gate(true); // the fill holds at each clip's first chunk
    await h.player.handle({ type: 'bufferAhead', fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER });
    await vi.waitFor(() => expect(log.reads.some((r) => r.path.includes('/STREAM/') && r.from >= CHUNK)).toBe(true));
    await h.player.handle({ type: 'setLevel', disc: { ...spec, query: 'level=h264-1080&audio=1' } });
    expect(h.events).toContainEqual({ type: 'levelChanged', ok: true });
    const before = progress(h).length;
    log.reads.length = 0;
    log.gate(false);
    await filled(h);
    expect(progress(h).length).toBeGreaterThan(before);
    expect(progress(h).at(-1)!.stopped).toBeUndefined();
    expect(log.reads.some((r) => r.path.includes('/STREAM/') && r.from === 0)).toBe(true); // from the start, on the new version
  });

  it('then plays from the cache without reading the network', async () => {
    const { h, log } = await setup();
    await h.player.handle({ type: 'bufferAhead', fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER });
    await filled(h);
    log.reads.length = 0;
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(500);
    expect(h.drawn.length).toBeGreaterThan(5);
    expect(log.reads).toEqual([]);
  });

  it('stops at targetBytes', async () => {
    const { h, log } = await setup();
    log.reads.length = 0;
    await h.player.handle({ type: 'bufferAhead', fromSeconds: 0, targetBytes: 3 * CHUNK });
    await filled(h);
    await h.play(100);
    expect(log.reads.length).toBeLessThanOrEqual(3 + 2); // the target, and what was in flight
    expect(progress(h).at(-1)?.targetBytes).toBe(3 * CHUNK);
  });

  it("fills the request's playlist (an episode's), not the main title's", async () => {
    const { h, log, streamSize } = await setup({
      playlists: [
        { id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2 },
        { id: '00003', clipIds: ['00002'], chapterEverySeconds: 2 },
      ],
    });
    log.reads.length = 0;
    await h.player.handle({ type: 'bufferAhead', fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER, playlistId: '00003' });
    await filled(h);
    const streamReads = log.reads.filter((r) => r.path.includes('/STREAM/'));
    expect(streamReads.every((r) => r.path === P2)).toBe(true);
    expect(Math.min(...streamReads.map((r) => r.from))).toBe(0);
    expect(progress(h).at(-1)!.targetBytes).toBe(streamSize('00002'));
  });

  it('cancelBuffer stops it', async () => {
    const { h, log } = await setup();
    log.reads.length = 0;
    log.gate(true);
    await h.player.handle({ type: 'bufferAhead', fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER });
    await vi.waitFor(() => expect(log.reads.length).toBeGreaterThan(0));
    await h.player.handle({ type: 'cancelBuffer' });
    const readsAtCancel = log.reads.length;
    const progressAtCancel = progress(h).length;
    log.gate(false);
    await h.play(200);
    expect(log.reads.length).toBe(readsAtCancel);
    expect(progress(h).length).toBe(progressAtCancel);
  });

  it('says so when this device has no cache, and a bufferFirst open opens at once', async () => {
    const { h, spec } = await setup({ noOpen: true, noCache: true });
    await h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: 4 * CHUNK } });
    expect(progress(h).at(-1)).toMatchObject({ stopped: 'no-cache' });
    expect(h.events.some((e) => e.type === 'titles')).toBe(true);
    await h.player.handle({ type: 'bufferAhead', fromSeconds: 0, targetBytes: 4 * CHUNK });
    expect(progress(h).filter((p) => p.stopped === 'no-cache')).toHaveLength(2);
  });

  it('says so when a read fails for good (the disc changed), and a bufferFirst open then opens', async () => {
    const { h, log, spec } = await setup({ noOpen: true });
    log.failFrom(2 * CHUNK);
    await h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER } });
    expect(progress(h).at(-1)).toMatchObject({ stopped: 'failed' });
    expect(h.events.some((e) => e.type === 'titles')).toBe(true);
  });

  it('tells at its start whether this device can keep a cache', async () => {
    const withCache = await setup({ noOpen: true });
    await withCache.h.player.startReadAheadCache();
    expect(withCache.h.events).toContainEqual({ type: 'readAheadCache', available: true });
    const without = await setup({ noOpen: true, noCache: true });
    await without.h.player.startReadAheadCache();
    expect(without.h.events).toContainEqual({ type: 'readAheadCache', available: false });
  });

  it('opened with bufferFirst, starts the disc only once the cache holds the target', async () => {
    const { h, log, spec } = await setup({ noOpen: true });
    log.gate(true);
    const opening = h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: 4 * CHUNK } });
    await vi.waitFor(() => expect(progress(h).length).toBeGreaterThan(0)); // the fill began
    await h.play(50);
    expect(h.events.some((e) => e.type === 'titles')).toBe(false);
    log.gate(false);
    await opening;
    const titles = h.events.findIndex((e) => e.type === 'titles');
    const reached = h.events.findIndex((e) => e.type === 'bufferProgress' && e.bytes >= 4 * CHUNK);
    expect(reached).toBeGreaterThanOrEqual(0);
    expect(titles).toBeGreaterThan(reached);
  });

  it('opened with bufferFirst, opens at once on cancelBuffer (play now with pauses), and the fill goes on', async () => {
    const { h, log, spec } = await setup({ noOpen: true });
    log.gate(true);
    const opening = h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER } });
    await vi.waitFor(() => expect(progress(h).length).toBeGreaterThan(0)); // the fill began
    await h.player.handle({ type: 'cancelBuffer' }); // not queued behind the open
    await opening;
    expect(h.events.some((e) => e.type === 'titles')).toBe(true);
    const before = log.reads.length;
    log.gate(false);
    await vi.waitFor(() => expect(log.reads.length).toBeGreaterThan(before + 4)); // still filling after the open
  });

  it('opened with bufferFirst, a close while it fills drops the disc without opening it', async () => {
    const { h, log, spec } = await setup({ noOpen: true });
    log.gate(true);
    const opening = h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER } });
    await vi.waitFor(() => expect(progress(h).length).toBeGreaterThan(0)); // the fill began
    const closing = h.player.handle({ type: 'close' });
    log.gate(false);
    await opening;
    await closing;
    expect(h.events.some((e) => e.type === 'titles')).toBe(false);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    expect(lastState(h)).toBe('idle');
  });

  it('a close while a plain open still reads the disc drops the disc without opening it', async () => {
    const { h, log, spec } = await setup({ noOpen: true });
    log.limit('*', 0); // every read waits: the open is stuck in the disc's metadata
    const opening = h.player.handle({ type: 'open', disc: spec });
    await vi.waitFor(() => expect(log.reads.length).toBeGreaterThan(0));
    const closing = h.player.handle({ type: 'close' });
    log.gate(false);
    await opening;
    await closing;
    expect(h.events.some((e) => e.type === 'titles')).toBe(false);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    expect(lastState(h)).toBe('idle');
  });

  it('a plain remote open superseded by a second open drops the first: only the second disc emits titles', async () => {
    const { h, log, spec } = await setup({ noOpen: true });
    log.limit('*', 0); // the first open is stuck in its disc's metadata
    const first = h.player.handle({ type: 'open', disc: spec });
    await vi.waitFor(() => expect(log.reads.length).toBeGreaterThan(0));
    const second = fakeNas(fixtureDiscFiles('disc1'));
    const secondOpen = h.player.handle({ type: 'open', disc: second.spec });
    log.gate(false); // the first disc's reads go on, too late
    await first;
    await secondOpen;
    expect(h.events.filter((e) => e.type === 'titles')).toHaveLength(1);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('a close while a local files open still reads drops the disc without titles or an error', async () => {
    const h = await harness(undefined, { noOpen: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reading = false;
    /** A blob whose reads wait for the gate. */
    const slow = (blob: Blob): Blob =>
      ({
        size: blob.size,
        type: blob.type,
        slice: (a?: number, b?: number) => {
          const part = blob.slice(a, b);
          return {
            size: part.size,
            arrayBuffer: async () => ((reading = true), await gate, part.arrayBuffer()),
            stream: () => {
              reading = true;
              return new ReadableStream<Uint8Array>({
                async pull(c) {
                  await gate;
                  c.enqueue(new Uint8Array(await part.arrayBuffer()));
                  c.close();
                },
              });
            },
          };
        },
        arrayBuffer: async () => ((reading = true), await gate, blob.arrayBuffer()),
        text: async () => ((reading = true), await gate, blob.text()),
        stream: () => blob.stream(),
      }) as unknown as Blob;
    const entries = h.entries.map(([p, b]) => [p, slow(b)] as [string, Blob]);
    const opening = h.player.handle({ type: 'open', disc: { kind: 'files', entries } });
    await vi.waitFor(() => expect(reading).toBe(true));
    const closing = h.player.handle({ type: 'close' });
    release();
    await opening;
    await closing;
    expect(h.events.some((e) => e.type === 'titles')).toBe(false);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    expect(lastState(h)).toBe('idle');
  });

  it('opened with bufferFirst, a close sent while the open is still queued drops it, and a queued cancel opens it', async () => {
    const dropped = await setup({ noOpen: true });
    const opening = dropped.h.player.handle({ type: 'open', disc: dropped.spec, bufferFirst: { fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER } });
    const closing = dropped.h.player.handle({ type: 'close' });
    await opening;
    await closing;
    expect(dropped.h.events.some((e) => e.type === 'titles')).toBe(false);

    const cancelled = await setup({ noOpen: true });
    cancelled.log.gate(true);
    const opened = cancelled.h.player.handle({ type: 'open', disc: cancelled.spec, bufferFirst: { fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER } });
    await cancelled.h.player.handle({ type: 'cancelBuffer' });
    await opened;
    expect(cancelled.h.events.some((e) => e.type === 'titles')).toBe(true);
    cancelled.log.gate(false);
  });

  it('after a bufferFirst open, keeps fetching past the cache while playback reads inside it, and frees what playback passed', async () => {
    const SEGMENT = 4 * CHUNK;
    const { h, log, spec, cachedFiles } = await setup({ noOpen: true, segmentBytes: SEGMENT });
    log.limit(P1, 6 * CHUNK); // reads of the first clip from its seventh chunk on wait
    await h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: 4 * CHUNK } });
    // the target (4 chunks) is held and the disc is open; the fill went on to the network beyond what the cache holds
    await vi.waitFor(() => expect(log.reads.some((r) => r.path === P1 && r.from === 6 * CHUNK)).toBe(true));
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.play(100);
    expect(log.reads.some((r) => r.path === P1 && r.from === 6 * CHUNK)).toBe(true);
    expect((await cachedFiles(P1)).length).toBeGreaterThan(0);
    log.limit(P1, Infinity);
    await untilPlaying(h);
    await playUntil(h, 4_600_000); // into the second clip
    await h.play(1100); // the fill looks again once a second, and frees what is behind
    await vi.waitFor(async () => expect(await cachedFiles(P1)).toEqual([]), { timeout: 10_000 });
    expect((await cachedFiles(P2)).length).toBeGreaterThan(0);
  }, 30_000);

  it('after a bufferFirst open, holds at most the target plus a segment ahead of a paused player', async () => {
    const SEGMENT = 4 * CHUNK;
    const { h, spec } = await setup({ noOpen: true, segmentBytes: SEGMENT });
    await h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: 4 * CHUNK } });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.player.handle({ type: 'pause' });
    await h.play(2_000); // the fill looks again every second; a fast link would fill the whole disc meanwhile
    const cap = 4 * CHUNK + SEGMENT;
    expect(Math.max(...progress(h).map((p) => p.bytes))).toBeLessThanOrEqual(cap + CHUNK);
  });

  it('after a bufferFirst open on a link faster than the disc, keeps the lead capped as playback uses it', async () => {
    const SEGMENT = 4 * CHUNK;
    const { h, log, spec } = await setup({ noOpen: true, segmentBytes: SEGMENT });
    await h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: 4 * CHUNK } });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await playUntil(h, 6_000_000); // into the second clip
    const cap = 4 * CHUNK + SEGMENT;
    expect(Math.max(...progress(h).map((p) => p.bytes))).toBeLessThanOrEqual(cap + CHUNK);
    expect(log.reads.some((r) => r.path === P2)).toBe(true); // it went on fetching as playback went on
  }, 30_000);

  it('after a bufferFirst open, idles while another playlist plays and follows again when the buffered one plays', async () => {
    const { h, log, spec } = await setup({
      noOpen: true,
      playlists: [
        { id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2 },
        { id: '00003', clipIds: ['00002'], chapterEverySeconds: 2 },
      ],
    });
    log.limit(P1, 6 * CHUNK); // the fill sticks at the first clip's seventh chunk
    const opening = h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: Number.MAX_SAFE_INTEGER } });
    await vi.waitFor(() => expect(log.reads.some((r) => r.path === P1 && r.from === 6 * CHUNK)).toBe(true));
    await h.player.handle({ type: 'cancelBuffer' });
    await opening;
    await h.player.handle({ type: 'playPlaylist', playlistId: '00003' });
    log.limit(P1, Infinity); // its stuck reads land; nothing more of the first clip is fetched while 00003 plays
    await h.play(1_500);
    expect(log.reads.some((r) => r.path === P1 && r.from >= 8 * CHUNK)).toBe(false);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    // following again: it runs ahead through the first clip, well past what playback has read
    await vi.waitFor(() => expect(log.reads.some((r) => r.path === P1 && r.from >= 20 * CHUNK)).toBe(true), { timeout: 10_000 });
  }, 30_000);

  it('after a bufferFirst open, a seek outside what the cache holds restarts the fill at the seek point', async () => {
    const { h, log, spec, startChunkAt, streamSize } = await setup({ noOpen: true });
    log.limit(P1, 6 * CHUNK); // the fill sticks at the first clip's seventh chunk
    await h.player.handle({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: 4 * CHUNK } });
    await vi.waitFor(() => expect(log.reads.some((r) => r.path === P1 && r.from === 6 * CHUNK)).toBe(true));
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.player.handle({ type: 'pause' });
    await h.player.handle({ type: 'seek', timeUs: 5_000_000 });
    log.poke();
    const start = startChunkAt(5);
    // the fill gives up its stuck fetches of the first clip and runs through the second clip from the seek point
    await vi.waitFor(() => expect(log.reads.some((r) => r.path === P2 && r.from >= start + 8 * CHUNK)).toBe(true), { timeout: 10_000 });
    expect(log.reads.filter((r) => r.path === P2).every((r) => r.from >= start)).toBe(true);
    expect(log.reads.some((r) => r.path === P2 && r.from + CHUNK >= streamSize('00002'))).toBe(true);
  }, 30_000);
});

describe("Player without a picture: reading at the clock's pace (R8)", () => {
  /** A NAS that records the byte ranges asked of the feature clip (00001), with that clip's size. */
  function rangeNas(files: Map<string, Uint8Array<ArrayBuffer>>) {
    const nas = fakeNas(files);
    const ranges: Array<{ start: number; end: number }> = [];
    const size = files.get('BDMV/STREAM/00001.m2ts')!.length;
    const recording: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
      if (range && decodeURIComponent(String(input)).toUpperCase().includes('/FILES/BDMV/STREAM/00001.M2TS')) ranges.push({ start: Number(range[1]), end: Number(range[2]) + 1 });
      return nas.fetch(input, init);
    }) as typeof globalThis.fetch;
    return { nas: { ...nas, fetch: recording }, ranges, size };
  }
  const furthest = (ranges: ReadonlyArray<{ end: number }>) => Math.max(0, ...ranges.map((r) => r.end));
  const opts = { videoCodingType: CodingType.MPEG2_VIDEO, frameBytes: 50_000, clipSeconds: 20, remoteLimits: { chunkBytes: 64 * 1024, readAheadBytes: 256 * 1024 } };

  it('reads a playlist with no audio and no graphics only the read-ahead window ahead of the clock, through the NAS read-ahead too', async () => {
    let rec!: ReturnType<typeof rangeNas>;
    const h = await harness(undefined, { ...opts, remote: (files) => (rec = rangeNas(files)).nas });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    // about 1.2 MB a second: the clock at ~1 s, 2 s of read-ahead, one reader chunk (~2 MB) and the NAS budget, of 20 s
    expect(furthest(rec.ranges)).toBeLessThan(rec.size * 0.4);
    await h.play(6000);
    expect(furthest(rec.ranges)).toBeGreaterThan(rec.size * 0.3); // it goes on, at the clock's pace
    expect(furthest(rec.ranges)).toBeLessThan(rec.size * 0.65);
  }, 30_000);

  it('paces the re-read of a menu loop the same way', async () => {
    let rec!: ReturnType<typeof rangeNas>;
    const h = await harness(undefined, {
      ...opts,
      clipSeconds: 6,
      frameBytes: 150_000, // about 3.6 MB a second
      playlists: [{ id: '00000', clipIds: ['00001'], videoCodingType: CodingType.MPEG2_VIDEO }],
      movieObjects: buildMovieObjects([{ cmds: [asm.playPl(imm(0)), asm.goto(0)] }, { cmds: [] }, { cmds: [] }]),
      remote: (files) => (rec = rangeNas(files)).nas,
    });
    const starts = () => h.events.filter((e) => e.type === 'chapters').length;
    await vi.waitFor(async () => {
      await h.play(200);
      expect(starts()).toBe(2); // the program played the loop again
    }, { timeout: 20_000 });
    await h.play(500);
    // the loop's second read, from the clip's start
    const again = rec.ranges.slice(rec.ranges.map((r) => r.start).lastIndexOf(0));
    expect(again.length).toBeLessThan(rec.ranges.length);
    // under a second in: 2 s of read-ahead, a reader chunk and the NAS budget, of 6 s; unpaced it would be the whole clip
    expect(furthest(again)).toBeLessThan(rec.size * 0.8);
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
  }, 30_000);
});

describe('Player opening at a place (resume)', () => {
  const fixture = (name: string): Array<[string, File]> => discEntries(fixtureDiscFiles(name));
  const chapterIds = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : []));
  const times = (h: Harness): number[] => h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : []));
  const startFailures = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'startFailed' ? [e.reason] : []));
  async function readPlace(h: Harness): Promise<Extract<EngineEvent, { type: 'placeState' }>> {
    await h.player.handle({ type: 'readPlace' });
    const place = h.events.filter((e) => e.type === 'placeState').at(-1);
    if (place?.type !== 'placeState') throw new Error('no placeState');
    return place;
  }
  const NAV_EVENTS = new Set(['menuActive', 'uoMask', 'indexTitles']);

  it('opens straight into a playlist at a time, without First Play', async () => {
    const h = await harness(undefined, { noOpen: true });
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc1') }, start: { playlistId: '00000', timeUs: 5e6, hdmv: null, playback: { psr1: 1, psr2: 0, psr3: 1 } } });
    await untilPlaying(h);
    expect(chapterIds(h)[0]).toBe('00000');
    expect(times(h)[0]).toBeGreaterThanOrEqual(4.9e6);
    expect(h.events.some((e) => NAV_EVENTS.has(e.type))).toBe(false);
    expect(startFailures(h)).toEqual([]);
    const place = await readPlace(h);
    expect(place).toMatchObject({ mode: 'none', title: null, gprs: null });
    expect(place.psrs).toHaveLength(128);
    expect(place.psrs[3]).toBe(1);
  });

  it('resumes an HDMV title with its registers', async () => {
    const h = await harness(undefined, { noOpen: true });
    const psrs = new RegisterFile().snapshot().psrs;
    psrs[4] = 3;
    psrs[16] = 0x123; // a player setting: never restored
    await h.player.handle({
      type: 'open',
      disc: { kind: 'files', entries: fixture('disc-vm') },
      start: { playlistId: '00003', timeUs: 2.5e6, hdmv: { title: 3, psrs, gprs: { 100: 42, 4095: 7 } }, playback: null },
    });
    await untilPlaying(h);
    expect(chapterIds(h)).toEqual(['00003']); // title 3's object plays 00003 first, at the saved time
    // (a tick while the open waits for the audio ring can report the clock's old 0 first)
    expect(times(h).at(-1)).toBeGreaterThanOrEqual(2.4e6);
    const place = await readPlace(h);
    expect(place.mode).toBe('hdmv');
    expect(place.title).toBe(3);
    expect(place.gprs).toEqual({ 100: 42, 4095: 7 }); // First Play (which sets r0 to 7 and more) never ran
    expect(place.psrs[16]).not.toBe(0x123);
    expect(startFailures(h)).toEqual([]);
  });

  it('plays directly when the title never plays that playlist', async () => {
    const h = await harness(undefined, { noOpen: true });
    const psrs = new RegisterFile().snapshot().psrs;
    await h.player.handle({
      type: 'open',
      disc: { kind: 'files', entries: fixture('disc-vm') },
      start: { playlistId: '00001', timeUs: 1e6, hdmv: { title: 3, psrs, gprs: { 100: 42 } }, playback: null },
    });
    await h.play(500);
    await untilPlaying(h);
    expect(chapterIds(h)).toEqual(['00001']);
    expect(times(h)[0]).toBeGreaterThanOrEqual(0.9e6);
    expect(await readPlace(h)).toMatchObject({ mode: 'none', title: null, gprs: null }); // no navigator: the playlist plays on its own
    expect(startFailures(h)).toEqual([]);
  });

  it('reports a start playlist the disc lacks, and a time past the end', async () => {
    const h = await harness(undefined, { noOpen: true });
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc1') }, start: { playlistId: '00042', timeUs: 0, hdmv: null, playback: null } });
    expect(startFailures(h)).toEqual(['no-playlist']);
    expect(chapterIds(h)).toEqual([]);
    expect(lastState(h)).toBe('idle');

    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc1') }, start: { playlistId: '00000', timeUs: 1e12, hdmv: null, playback: null } });
    expect(startFailures(h)).toEqual(['no-playlist', 'past-end']);
    await untilPlaying(h);
    expect(chapterIds(h)).toEqual(['00000']);
    expect(times(h)[0]).toBeLessThan(1e6); // from the beginning
  });

  it('reads the place: mode, title, registers', async () => {
    const h = await harness(undefined, { noOpen: true });
    expect(await readPlace(h)).toEqual({ type: 'placeState', mode: 'none', title: null, psrs: [], gprs: null }); // no disc
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc1') } });
    const none = await readPlace(h);
    expect(none).toMatchObject({ mode: 'none', title: null, gprs: null });
    expect(none.psrs).toHaveLength(128);
    // disc-vm's First Play sets registers, then plays 00000 and jumps to title 1
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc-vm') } });
    await vi.waitFor(async () => {
      await h.play(20);
      expect((await readPlace(h)).title).toBe(1);
    }, { timeout: 5000 });
    const hdmv = await readPlace(h);
    expect(hdmv.mode).toBe('hdmv');
    expect(hdmv.gprs).toMatchObject({ 0: 7, 1: 2 });
    expect(hdmv.psrs[4]).toBe(1);
    // the BD-J case is in player-bdj.test.ts (it needs a BD-J worker)
  });

  it('plays directly with the saved audio stream (PSR1) and PG stream (PSR2)', async () => {
    const audioStreams = [lpcmStream(0x1100, 4, { lang: 'jpn' }), lpcmStream(0x1101, 4, { lang: 'eng' })];
    const h = await harness(undefined, { audioStreams, pgStreams: [{ pid: 0x1200, lang: 'eng', units: [] }, { pid: 0x1201, lang: 'jpn', units: [] }], noOpen: true });
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: h.entries }, start: { playlistId: '00000', timeUs: 1e6, hdmv: null, playback: { psr1: 2, psr2: 0x80000002, psr3: 1 } } });
    await untilPlaying(h);
    expect(h.events.flatMap((e) => (e.type === 'tracks' ? [e.selectedAudio] : []))).toEqual([2]);
    const subtitles = h.events.filter((e) => e.type === 'subtitles').at(-1);
    expect(subtitles?.type === 'subtitles' && subtitles.selected).toEqual({ pg: 2 });
    const place = await readPlace(h);
    expect(place.psrs.slice(1, 4)).toEqual([2, 0x80000002, 1]);
  });

  it('an HDMV resume whose playlist fails to open, and whose program then ends, leaves the player idle', async () => {
    const h = await harness(CodingType.LPCM, {
      playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 1 }, { id: '00001', clipIds: ['00002'], chapterEverySeconds: 1 }],
      movieObjects: buildMovieObjects([{ cmds: [] }, { cmds: [] }, { cmds: [asm.playPl(imm(1))] }]),
      dropFiles: ['BDMV/STREAM/00002.m2ts'],
      noOpen: true,
    });
    const psrs = new RegisterFile().snapshot().psrs;
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: h.entries }, start: { playlistId: '00001', timeUs: 0, hdmv: { title: 1, psrs, gprs: {} }, playback: null } });
    await vi.waitFor(async () => {
      await h.play(20);
      expect(h.events.some((e) => e.type === 'error')).toBe(true); // the missing clip
      expect(lastState(h)).toBe('idle');
    }, { timeout: 5000 });
    expect(chapterIds(h)).toEqual([]);
  });

  it('a later open drops an open at a place: only the second disc emits titles, and nothing plays', async () => {
    const h = await harness(undefined, { noOpen: true });
    const first = h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc1') }, start: { playlistId: '00001', timeUs: 1e6, hdmv: null, playback: null } });
    const second = h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc3') } });
    await first;
    await second;
    const titles = h.events.flatMap((e) => (e.type === 'titles' ? [e.playlists.map((p) => p.id)] : []));
    expect(titles).toEqual([['00000']]);
    expect(chapterIds(h)).toEqual([]);
    expect(startFailures(h)).toEqual([]);
  });

  it('drops a superseded open: only the second disc emits titles', async () => {
    const h = await harness(undefined, { noOpen: true });
    const first = h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc1') } });
    const second = h.player.handle({ type: 'open', disc: { kind: 'files', entries: fixture('disc3') } });
    await first;
    await second;
    const titles = h.events.flatMap((e) => (e.type === 'titles' ? [e.playlists.map((p) => p.id)] : []));
    expect(titles).toEqual([['00000']]); // disc3's only playlist; disc1 has 00000 and 00001
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe("Player switching a NAS disc's quality level (setLevel)", () => {
  const LEVEL_QUERY = 'level=h264-1080&audio=1';
  /** Two versions of disc d1 behind one NAS: the original, and a level's (files requests carrying `level=`). */
  function levelNas(original: Map<string, Uint8Array<ArrayBuffer>>, level: Map<string, Uint8Array<ArrayBuffer>>) {
    const a = fakeNas(original);
    const b = fakeNas(level);
    const urls: string[] = [];
    const routed = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return (new URL(String(input)).searchParams.has('level') ? b : a).fetch(input, init);
    }) as typeof globalThis.fetch;
    const levelSpec: RemoteDiscSpec = { ...b.spec, query: LEVEL_QUERY, original: a.spec.manifest };
    return { nas: { ...a, fetch: routed }, urls, levelSpec };
  }
  function disc(o: { videoCodingType?: number; audioStreams?: SyntheticAudioStream[]; clipSeconds?: number } = {}) {
    const clip = (id: string, seconds: number) => ({ ...syntheticClip(id, seconds, { audioStreams: o.audioStreams }), ...(o.videoCodingType ? { videoCodingType: o.videoCodingType } : {}) });
    return buildSyntheticDisc({
      clips: [clip('00001', o.clipSeconds ?? 10), clip('00002', 4)],
      playlists: [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2, videoCodingType: o.videoCodingType }],
    });
  }
  const times = (events: readonly EngineEvent[]) => events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : []));

  it('setLevel reads the new version and restarts the playlist at the current time', async () => {
    const files = disc();
    const lv = levelNas(files, disc());
    const h = await harness(undefined, { remote: () => lv.nas });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(3000);
    const at = times(h.events).at(-1)!;
    expect(at).toBeGreaterThan(2_000_000);
    const before = h.events.length;
    await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
    const after = h.events.slice(before);
    expect(after).toContainEqual({ type: 'levelChanged', ok: true });
    expect(after).toContainEqual(expect.objectContaining({ type: 'chapters', playlistId: '00000' }));
    expect(Math.abs(times(after)[0]! - at)).toBeLessThan(300_000);
    await untilPlaying(h);
    await h.play(500);
    expect(lv.urls.at(-1)).toContain(LEVEL_QUERY);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
  }, 30_000);

  it('setLevel keeps a paused disc paused at its time', async () => {
    const lv = levelNas(disc(), disc());
    const h = await harness(undefined, { remote: () => lv.nas });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(2000);
    await h.player.handle({ type: 'pause' });
    const at = times(h.events).at(-1)!;
    await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
    await h.play(300);
    expect(h.events).toContainEqual({ type: 'levelChanged', ok: true });
    expect(lastState(h)).toBe('paused');
    expect(Math.abs(times(h.events).at(-1)! - at)).toBeLessThan(300_000);
  }, 30_000);

  it('setLevel on a no-picture playlist starts the picture on the new version', async () => {
    const lv = levelNas(disc({ videoCodingType: CodingType.MPEG2_VIDEO }), disc());
    const h = await harness(undefined, { remote: () => lv.nas });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'video', noPicture: true }));
    expect(h.drawn).toEqual([]);
    await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
    expect(h.events).toContainEqual({ type: 'noticeCleared', code: 'no-picture' });
    await untilPlaying(h);
    await h.play(500);
    expect(decoders.at(-1)?.state).toBe('configured');
    expect(h.drawn.length).toBeGreaterThan(3);
  }, 30_000);

  it("setLevel under an HDMV program: the program's playlist goes on at its time, and the program is not restarted", async () => {
    const program = buildMovieObjects([{ cmds: [asm.playPl(imm(0))] }, { cmds: [] }, { cmds: [] }]);
    const withProgram = (files: Map<string, Uint8Array<ArrayBuffer>>) => files.set('BDMV/MovieObject.bdmv', program);
    const lv = levelNas(withProgram(disc()), withProgram(disc()));
    const h = await harness(undefined, { remote: () => lv.nas });
    await untilPlaying(h);
    await h.play(2000);
    const at = times(h.events).at(-1)!;
    const before = h.events.length;
    await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
    await untilPlaying(h);
    await h.play(300);
    const after = h.events.slice(before);
    expect(after).toContainEqual({ type: 'levelChanged', ok: true });
    expect(after.filter((e) => e.type === 'chapters').map((e) => e.type === 'chapters' && e.playlistId)).toEqual(['00000']);
    expect(Math.abs(times(after)[0]! - at)).toBeLessThan(300_000);
    expect(times(after).at(-1)!).toBeGreaterThan(at);
  }, 30_000);

  for (const order of ['during the switch', 'before the switch, still loading'] as const) {
    it(`a program's playlist started ${order} plays on the new version, with no error`, async () => {
      const two = () =>
        buildSyntheticDisc({
          clips: [syntheticClip('00001', 6), syntheticClip('00002', 4)],
          playlists: [
            { id: '00000', clipIds: ['00001'], chapterEverySeconds: 2 },
            { id: '00001', clipIds: ['00002'], chapterEverySeconds: 2 },
          ],
        });
      const lv = levelNas(two(), two());
      const h = await harness(undefined, { remote: () => lv.nas });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      const port = h.player.bdjPort();
      const before = h.events.length;
      let started: Promise<boolean>;
      let switching: Promise<void>;
      if (order === 'during the switch') {
        switching = h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
        await Promise.resolve();
        started = port.playPlaylist('00001', {});
      } else {
        started = port.playPlaylist('00001', {});
        switching = h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
      }
      await switching;
      expect(await started).toBe(true);
      await h.play(300);
      const after = h.events.slice(before);
      expect(after.filter((e) => e.type === 'error')).toEqual([]);
      expect(after).toContainEqual({ type: 'levelChanged', ok: true });
      expect(after.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : [])).at(-1)).toBe('00001');
      expect(lastState(h)).toBe('paused'); // a BD-J playlist opens paused until Java starts it
      expect(lv.urls.some((u) => u.includes('/STREAM/00002.M2TS') && u.includes(LEVEL_QUERY))).toBe(true);
    }, 30_000);
  }

  it('a stale program open still loading does not stop the restart of the playlist that took over', async () => {
    const two = () =>
      buildSyntheticDisc({
        clips: [syntheticClip('00001', 6), syntheticClip('00002', 4)],
        playlists: [
          { id: '00000', clipIds: ['00001'], chapterEverySeconds: 2 },
          { id: '00001', clipIds: ['00002'], chapterEverySeconds: 2 },
        ],
      });
    const lv = levelNas(two(), two());
    // the old version's reads of X's clip stall (a NAS stall) until they are aborted
    const stalls: string[] = [];
    const stalled = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/STREAM/00002.M2TS') && !String(input).includes('level=')) {
        stalls.push(String(input));
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
      }
      return lv.nas.fetch(input, init);
    }) as typeof fetch;
    const h = await harness(undefined, { remote: () => ({ ...lv.nas, fetch: stalled }) });
    const port = h.player.bdjPort();
    const x = port.playPlaylist('00001', {}); // X: stale once Y starts, its read in flight
    await vi.waitFor(() => expect(stalls.length).toBeGreaterThan(0));
    expect(await port.playPlaylist('00000', {})).toBe(true); // Y
    port.setRate(1);
    await untilPlaying(h);
    await h.play(500);
    const before = h.events.length;
    await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
    expect(await x).toBe(true);
    const after = h.events.slice(before);
    expect(after).toContainEqual({ type: 'levelChanged', ok: true });
    expect(after.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : []))).toEqual(['00000']);
    await untilPlaying(h);
    const drawn = h.drawn.length;
    await h.play(500);
    expect(h.drawn.length).toBeGreaterThan(drawn + 3);
    expect(h.events.slice(before).filter((e) => e.type === 'error')).toEqual([]);
    expect(lv.urls.at(-1)).toContain(LEVEL_QUERY);
  }, 30_000);

  it('setLevel over the WebRTC route keeps reading through the open disc\'s port', async () => {
    const lv = levelNas(disc(), disc());
    const { port1, port2 } = new MessageChannel();
    const stop = serveFetch(port1, lv.nas.fetch);
    const ownFetch = vi.fn(async () => {
      throw new TypeError('the engine fetched directly');
    });
    try {
      const h = await harness(undefined, { remote: () => ({ ...lv.nas, spec: { ...lv.nas.spec, fetchPort: port2 }, fetch: ownFetch as unknown as typeof fetch }) });
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
      expect(h.events).toContainEqual({ type: 'levelChanged', ok: true });
      await untilPlaying(h);
      await h.play(300);
      expect(lv.urls.at(-1)).toContain(LEVEL_QUERY);
      expect(ownFetch).not.toHaveBeenCalled();
      expect(h.events.filter((e) => e.type === 'fetchPortClosed')).toEqual([]);
    } finally {
      stop();
      port1.close();
    }
  }, 30_000);

  it('a version that fails to open leaves the disc closed with its error, and answers levelChanged ok: false', async () => {
    const lv = levelNas(disc(), disc());
    const h = await harness(undefined, { remote: () => lv.nas });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const manifest = { ...lv.levelSpec.manifest, inline: {}, files: lv.levelSpec.manifest.files.filter((f) => !f.path.endsWith('INDEX.BDMV')) };
    const before = h.events.length;
    await h.player.handle({ type: 'setLevel', disc: { ...lv.levelSpec, manifest } });
    const after = h.events.slice(before);
    expect(after.filter((e) => e.type === 'levelChanged')).toEqual([{ type: 'levelChanged', ok: false, message: expect.any(String) }]);
    expect(after).toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(lastState(h)).toBe('error');
  }, 30_000);

  it('clears the old version\'s "Waiting for the NAS drive…" notice', async () => {
    const lv = levelNas(disc(), disc());
    let hold = false;
    const held = (async (input: string | URL | Request, init?: RequestInit) => {
      if (hold && String(input).includes('/STREAM/') && !String(input).includes('level=')) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
      }
      return lv.nas.fetch(input, init);
    }) as typeof fetch;
    const h = await harness(undefined, { remote: () => ({ ...lv.nas, fetch: held }), remoteLimits: { chunkBytes: 64 * 1024, readAheadBytes: 128 * 1024 } });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    hold = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await h.player.handle({ type: 'seek', timeUs: 9_000_000 });
      await vi.advanceTimersByTimeAsync(3_500);
      expect(h.events).toContainEqual({ type: 'notice', code: 'nas-waiting', message: 'Waiting for the NAS drive…' });
      const before = h.events.length;
      await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
      expect(h.events.slice(before)).toContainEqual({ type: 'noticeCleared', code: 'nas-waiting' });
      expect(h.events.slice(before)).toContainEqual({ type: 'levelChanged', ok: true });
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('setLevel refuses another disc', async () => {
    const lv = levelNas(disc(), disc());
    const h = await harness(undefined, { remote: () => lv.nas });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const other: RemoteDiscSpec = { ...lv.levelSpec, manifest: { ...lv.levelSpec.manifest, discId: 'd2' } };
    await h.player.handle({ type: 'setLevel', disc: other });
    expect(h.events).toContainEqual({ type: 'levelChanged', ok: false, message: 'Another disc is open.' });
    await h.play(300);
    expect(lastState(h)).toBe('playing');
    expect(lv.urls.some((u) => u.includes('level='))).toBe(false);
  }, 30_000);

  it("a switch back to the original under an HDMV program keeps the audio heard at the level, and sets PSR1 to it", async () => {
    const program = buildMovieObjects([{ cmds: [asm.playPl(imm(0))] }, { cmds: [] }, { cmds: [] }]);
    const three = [lpcmStream(0x1100, 10), lpcmStream(0x1101, 10), lpcmStream(0x1102, 10)];
    const lv = levelNas(disc({ audioStreams: three }).set('BDMV/MovieObject.bdmv', program), disc({ audioStreams: [lpcmStream(0x1100, 10)] }).set('BDMV/MovieObject.bdmv', program));
    const h = await harness(undefined, { remote: () => lv.nas });
    await untilPlaying(h);
    // at the level with the original's track 2 (the level's only track)
    await h.player.handle({ type: 'setLevel', disc: { ...lv.levelSpec, query: 'level=h264-1080&audio=2' } });
    await untilPlaying(h);
    const before = h.events.length;
    await h.player.handle({ type: 'setLevel', disc: { ...lv.nas.spec, original: lv.nas.spec.manifest }, audio: 2 });
    await untilPlaying(h);
    await h.play(300);
    const after = h.events.slice(before);
    expect(after).toContainEqual({ type: 'levelChanged', ok: true });
    expect(after.flatMap((e) => (e.type === 'tracks' ? [e.selectedAudio] : [])).at(-1)).toBe(2);
    await h.player.handle({ type: 'readPlace' });
    const place = h.events.filter((e) => e.type === 'placeState').at(-1);
    expect(place?.type === 'placeState' && place.psrs[1]! & 0xfff).toBe(2);
    expect(h.events.slice(before).filter((e) => e.type === 'error')).toEqual([]);
  }, 30_000);

  it('a switch during a time still at the end of a play item reports the end to the HDMV program once', async () => {
    const program = buildMovieObjects([{ cmds: [asm.playPl(imm(0))] }, { cmds: [] }, { cmds: [] }]);
    const stillDisc = () =>
      buildSyntheticDisc({
        clips: [syntheticClip('00001', 3), syntheticClip('00002', 4)],
        playlists: [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2, stills: { 0: { mode: 1, time: 2 } } }],
      }).set('BDMV/MovieObject.bdmv', program);
    const lv = levelNas(stillDisc(), stillDisc());
    const ended = vi.spyOn(Navigator.prototype, 'playItemEnded');
    try {
      const h = await harness(undefined, { remote: () => lv.nas });
      await untilPlaying(h);
      await h.play(3500); // into the still at the end of item 0
      expect(ended.mock.calls.filter(([i]) => i === 0)).toHaveLength(1);
      await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
      expect(h.events).toContainEqual({ type: 'levelChanged', ok: true });
      await h.play(5000); // the still's 2 s run out, on into item 1
      expect(ended.mock.calls.filter(([i]) => i === 0)).toHaveLength(1);
      expect(lastTelemetry(h)?.clockUs).toBeGreaterThan(3_500_000);
    } finally {
      ended.mockRestore();
    }
  }, 30_000);

  it('ignores a PSR1 change to a track the level does not carry', async () => {
    const three = [lpcmStream(0x1100, 10), lpcmStream(0x1101, 10), lpcmStream(0x1102, 10)];
    const lv = levelNas(disc({ audioStreams: three }), disc({ audioStreams: [lpcmStream(0x1100, 10)] }));
    const lines: string[] = [];
    const h = await harness(undefined, { remote: () => lv.nas, log: (l) => lines.push(l) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'setLevel', disc: lv.levelSpec });
    await untilPlaying(h);
    const tracks = h.events.flatMap((e) => (e.type === 'tracks' ? [e] : [])).at(-1)!;
    expect(tracks.audio.map((t) => t.index)).toEqual([1]);
    const before = h.events.length;
    await h.player.handle({ type: 'selectAudio', index: 3 });
    await h.player.handle({ type: 'selectAudio', index: 3 });
    await h.play(200);
    expect(h.events.slice(before).filter((e) => e.type === 'tracks' || e.type === 'error')).toEqual([]);
    expect(lastState(h)).toBe('playing');
    expect(lines.filter((l) => l.includes('audio stream 3'))).toHaveLength(1);
  }, 30_000);
});
