// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { readFontFile } from '@seikou/ass/font-tables';
import { createFixedMeasurer } from '@seikou/ass/measure';
import { readMatroska, writeMatroska, type AudioPacket, type MkvAudioTrack, type MkvSubtitleTrack, type MkvVideoPacket } from '@seikou/matroska';
import { memoryReader, memorySink } from '@seikou/matroska/test-io';
import type { OverlayPlane } from '@seikou/pg';
import { Control, createRing, renderQuantum, ringViews } from '../audio/ring';
import { createAudioDecoderFactory } from '../decode/audio-decoder';
import type { AudioDataLike, AudioDecoderApi, AudioDecoderLike } from '../decode/opus-decoder';
import type { VideoCodecApi, VideoDecoderLike } from '../decode/video-decoder';
import { serveFetch } from '../disc/port-fetch';
import { Player, type PlayerDeps } from '../player';
import type { EncodeSpec, EngineEvent, PlaybackState, Telemetry } from '../protocol';

const FIXTURE = new Uint8Array(readFileSync(new URL('../../../../fixtures/encodes/990001/1.mkv', import.meta.url)));
const BASE = 'https://nas.example/bluray/api/encodes/e1/';
const PATH = 'EPISODE.MKV';
/** One render step: five quanta of the ring at 48 kHz. */
const STEP_MS = 640 / 48;

/** A fetch serving files the way the server's encode files route does: 206 for a single range. `gate` holds a base's reads back. */
function encodeFetch(files: ReadonlyMap<string, Uint8Array>, reads: Array<{ base: string; start: number; end: number }>, gates: ReadonlyMap<string, Promise<void>> = new Map()): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const base = [...files.keys()].find((b) => url.href.startsWith(`${b}files/${PATH}`));
    if (base === undefined) return new Response(null, { status: 404 });
    const bytes = files.get(base)!;
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
    if (!range) return new Response(null, { status: 400 });
    await gates.get(base);
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), bytes.length - 1);
    reads.push({ base, start, end });
    return new Response(bytes.slice(start, end + 1), { status: 206 });
  }) as typeof fetch;
}

interface Chunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
}

/** A WebCodecs stand-in that outputs one frame per chunk at once and records what it was given. */
function recordingCodecApi(supported: boolean): { api: VideoCodecApi; chunks: Chunk[]; configs: VideoDecoderConfig[] } {
  const chunks: Chunk[] = [];
  const configs: VideoDecoderConfig[] = [];
  const api: VideoCodecApi = {
    create: (init) => {
      const d: VideoDecoderLike = {
        state: 'unconfigured',
        decodeQueueSize: 0,
        configure(config) {
          configs.push(config);
          (d as { state: CodecState }).state = 'configured';
        },
        decode(chunk) {
          const c = chunk as unknown as EncodedVideoChunkInit;
          chunks.push({ type: c.type, timestamp: c.timestamp });
          init.output({ timestamp: c.timestamp, codedWidth: 1920, displayWidth: 1920, displayHeight: 1080, close: () => undefined } as unknown as VideoFrame);
        },
        flush: async () => undefined,
        reset() {
          (d as { state: CodecState }).state = 'unconfigured';
        },
        close() {
          (d as { state: CodecState }).state = 'closed';
        },
      };
      return d;
    },
    isConfigSupported: async (config) => ({ supported, config }),
    makeChunk: (init) => init as unknown as EncodedVideoChunk,
  };
  return { api, chunks, configs };
}

/** A WebCodecs AudioDecoder stand-in: 960 frames of 0.25 per packet, given at once; `decoders` lists each decoder's packet times. */
function recordingAudioApi(): { api: AudioDecoderApi; decoders: number[][] } {
  const decoders: number[][] = [];
  const api: AudioDecoderApi = {
    create(init) {
      const times: number[] = [];
      decoders.push(times);
      const d: AudioDecoderLike = {
        state: 'unconfigured',
        decodeQueueSize: 0,
        configure: () => {
          (d as { state: CodecState }).state = 'configured';
        },
        decode(chunk) {
          const c = chunk as unknown as EncodedAudioChunkInit;
          times.push(c.timestamp);
          const data: AudioDataLike = {
            timestamp: c.timestamp,
            numberOfFrames: 960,
            numberOfChannels: 2,
            sampleRate: 48_000,
            copyTo: (dest) => (dest as Float32Array).fill(0.25),
            close: () => undefined,
          };
          init.output(data);
        },
        flush: async () => undefined,
        reset: () => {
          (d as { state: CodecState }).state = 'unconfigured';
        },
        close: () => {
          (d as { state: CodecState }).state = 'closed';
        },
      };
      return d;
    },
    isConfigSupported: async (config) => ({ supported: true, config }),
    makeChunk: (init) => init as unknown as EncodedAudioChunk,
  };
  return { api, decoders };
}

/** ASS dependencies for Node: fonts registered by a fake loader, glyphs measured by a fixed ratio. */
function fakeAssDeps(): NonNullable<PlayerDeps['createAssDeps']> {
  return async () => ({
    loader: { load: async () => undefined, unload: () => undefined },
    defaultFont: await readFontFile('DejaVuSans.ttf', new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'))),
    measurer: createFixedMeasurer(0.5),
    createCanvas: () => ({}) as OffscreenCanvas,
    Path2D: class {} as unknown as typeof Path2D,
    canvasFilter: true,
  });
}

interface RemuxOptions {
  /** A second audio track: the same Opus packets under another label. */
  readonly secondAudio?: { readonly name: string; readonly language: string };
  readonly ass?: { readonly isDefault?: boolean; readonly isForced?: boolean; readonly language?: string };
  readonly pgs?: { readonly isDefault?: boolean; readonly isForced?: boolean; readonly language?: string };
}

/** The fixture written again through @seikou/matroska with other tracks or flags (no re-encode). */
async function remux(opts: RemuxOptions): Promise<Uint8Array> {
  const mkv = await readMatroska(memoryReader(FIXTURE));
  const blocks = new Map<number, { timeMs: number; keyframe: boolean; durationMs?: number; data: Uint8Array }[]>();
  for await (const b of mkv.blocks()) {
    const list = blocks.get(b.track) ?? [];
    list.push({ timeMs: b.timeMs, keyframe: b.keyframe, ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}), data: new Uint8Array(b.data) });
    blocks.set(b.track, list);
  }
  const [video, opus, ass, pgs] = mkv.tracks;
  async function* videoPackets(): AsyncGenerator<MkvVideoPacket> {
    let index = 0;
    for (const b of blocks.get(video!.number)!) yield { index: index++, data: b.data, keyframe: b.keyframe, timeMs: Math.round(b.timeMs) };
  }
  const audioTrack = (name: string, language: string, isDefault: boolean): MkvAudioTrack => {
    async function* packets(): AsyncGenerator<AudioPacket> {
      for (const b of blocks.get(opus!.number)!) yield { data: b.data, pts48: Math.round(b.timeMs) * 48, durationSamples: 960 };
    }
    return {
      channels: 2, sampleRate: 48_000, codecPrivate: opus!.codecPrivate!, codecDelayNs: opus!.codecDelayNs, seekPreRollNs: opus!.seekPreRollNs,
      name, language, isDefault, packets: packets(), end: Promise.resolve({ discardPadding48: 0 }),
    };
  };
  const audio = [audioTrack(opus!.name, opus!.language, true), ...(opts.secondAudio ? [audioTrack(opts.secondAudio.name, opts.secondAudio.language, false)] : [])];
  const subtitles: MkvSubtitleTrack[] = [
    {
      codecId: 'S_TEXT/ASS', name: ass!.name, language: opts.ass?.language ?? ass!.language, isDefault: opts.ass?.isDefault ?? true, isForced: opts.ass?.isForced ?? false,
      codecPrivate: ass!.codecPrivate!, blocks: blocks.get(ass!.number)!.map((b) => ({ timeMs: b.timeMs, ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}), data: b.data })),
    },
    {
      codecId: 'S_HDMV/PGS', name: pgs!.name, language: opts.pgs?.language ?? pgs!.language, isDefault: opts.pgs?.isDefault ?? false, isForced: opts.pgs?.isForced ?? false,
      blocks: blocks.get(pgs!.number)!.map((b) => ({ timeMs: b.timeMs, data: b.data })),
    },
  ];
  const sink = memorySink();
  await writeMatroska(sink, {
    video: { width: 1920, height: 1080, fpsNum: 1_000_000_000, fpsDen: Number(video!.defaultDurationNs), codecPrivate: video!.codecPrivate!, name: '', language: 'und', isDefault: true },
    videoPackets: videoPackets(),
    audio,
    subtitles,
    attachments: mkv.attachments,
    chapters: mkv.chapters,
  });
  return sink.bytes();
}

const players: Player[] = [];
afterEach(async () => {
  for (const p of players.splice(0)) await p.handle({ type: 'close' });
});

interface HarnessOptions {
  readonly supported?: boolean;
  /** The episode's bytes (the fixture by default). */
  readonly bytes?: Uint8Array;
  /** Attach an audio ring and play it as the worklet would. */
  readonly audio?: boolean;
  /** Further encodes at other bases, and reads held back per base. */
  readonly more?: ReadonlyMap<string, Uint8Array>;
  readonly gates?: ReadonlyMap<string, Promise<void>>;
}

async function harness(opts: HarnessOptions = {}) {
  const events: EngineEvent[] = [];
  const drawn: number[] = [];
  /** Whether the PG plane held anything, at each draw. */
  const pgDraws: boolean[] = [];
  const clock = { ms: 1000 };
  const reads: Array<{ base: string; start: number; end: number }> = [];
  const codec = recordingCodecApi(opts.supported ?? true);
  const audioApi = recordingAudioApi();
  const bytes = opts.bytes ?? FIXTURE;
  const files = new Map([[BASE, bytes], ...(opts.more ?? new Map())]);
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: codec.api,
    audioDecoderApi: audioApi.api,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
    createAssDeps: fakeAssDeps(),
    createCompositor: () => ({
      resize: () => undefined,
      drawVideo: (f) => f && drawn.push(f.timestamp),
      drawPg: (plane: OverlayPlane) => {
        pgDraws.push(plane.hasContent);
        plane.takeDirty();
      },
      drawText: () => undefined,
    }),
    setTimer: () => () => undefined,
    fetch: encodeFetch(files, reads, opts.gates),
    remoteLimits: { chunkBytes: 64 * 1024, readAheadBytes: 256 * 1024 },
  });
  players.push(player);
  const ring = createRing(48_000, 2);
  const views = ringViews(ring);
  if (opts.audio) await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  const specFor = (base: string, size: number, encodeId = 'e1'): EncodeSpec => {
    const manifest: DiscManifest = { discId: encodeId, name: 'The Lantern Road', files: [{ path: PATH, size }], inline: {} };
    return { base, token: 'tok', manifest, encodeId };
  };
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  const audible = { frames: 0 };
  return {
    player,
    events,
    drawn,
    pgDraws,
    reads,
    codec,
    audioApi,
    spec: specFor(BASE, bytes.length),
    specFor,
    audible,
    async play(ms: number): Promise<void> {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        if (opts.audio) {
          for (let q = 0; q < 5; q++) {
            const playing = Atomics.load(views.control, Control.Playing) === 1;
            renderQuantum(views, left, right);
            if (playing && left.some((v) => v !== 0)) audible.frames += 128;
          }
        }
        player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const states = (events: readonly EngineEvent[]): PlaybackState[] => events.flatMap((e) => (e.type === 'state' ? [e.state] : []));
const lastState = (events: readonly EngineEvent[]): PlaybackState | undefined => states(events).at(-1);
const telemetry = (h: Harness): Telemetry[] => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : []));
const times = (h: Harness, from = 0): number[] => h.events.slice(from).flatMap((e) => (e.type === 'time' ? [e.timeUs] : []));
const subtitleEvents = (h: Harness) => h.events.flatMap((e) => (e.type === 'subtitles' ? [e] : []));

/** Plays until the clock (in telemetry) reaches `us`, and returns the first telemetry at or after it. */
async function playTo(h: Harness, us: number, timeout = 20_000): Promise<Telemetry> {
  const from = telemetry(h).length;
  await vi.waitFor(
    async () => {
      await h.play(STEP_MS * 8);
      expect(telemetry(h).slice(from).some((t) => t.clockUs >= us)).toBe(true);
    },
    { timeout, interval: 1 },
  );
  return telemetry(h).slice(from).find((t) => t.clockUs >= us)!;
}

/** Telemetry samples taken while the clock is in [from, to). */
async function telemetryBetween(h: Harness, from: number, to: number): Promise<Telemetry[]> {
  const start = telemetry(h).length;
  await playTo(h, to);
  return telemetry(h).slice(start).filter((t) => t.clockUs >= from && t.clockUs < to);
}

async function untilPlaying(h: Harness): Promise<void> {
  await vi.waitFor(
    async () => {
      await h.play(32);
      expect(lastState(h.events)).toBe('playing');
    },
    { timeout: 10_000, interval: 1 },
  );
}

describe('Player with an encoded episode', () => {
  it('opens an encode and presents its first frame', async () => {
    const h = await harness();
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    await vi.waitFor(
      async () => {
        await h.play(32);
        expect(lastState(h.events)).toBe('playing');
        expect(h.drawn.length).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 1 },
    );
    expect(h.drawn[0]).toBe(0);
    expect(h.codec.configs[0]?.codec).toBe('av01.0.01M.10');
    expect(h.codec.chunks[0]).toEqual({ type: 'key', timestamp: 0 });
    expect(h.codec.chunks[1]).toEqual({ type: 'delta', timestamp: 42_000 });
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('seeking starts decoding at the key frame before the time', async () => {
    const h = await harness();
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    await vi.waitFor(
      async () => {
        await h.play(16);
        expect(h.drawn.length).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 1 },
    );
    const before = h.codec.chunks.length;
    const drawnBefore = h.drawn.length;
    await h.player.handle({ type: 'seek', timeUs: 25_000_000 });
    await vi.waitFor(
      async () => {
        await h.play(16);
        expect(h.drawn.length).toBeGreaterThan(drawnBefore);
      },
      { timeout: 10_000, interval: 1 },
    );
    // the key frame at 20.145 s (the last before 25 s) is where decoding starts again; nothing before 25 s is shown
    expect(h.codec.chunks[before]).toEqual({ type: 'key', timestamp: 20_145_000 });
    expect(h.drawn.slice(drawnBefore).every((t) => t >= 25_000_000 - 1_000)).toBe(true);
    expect(h.drawn.slice(drawnBefore)[0]).toBeLessThan(25_100_000);
  });

  it('reports chapters with their names', async () => {
    const h = await harness();
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    const chapters = h.events.find((e) => e.type === 'chapters');
    expect(chapters).toEqual({
      type: 'chapters',
      playlistId: 'mkv',
      durationUs: expect.closeTo(60_018_708, -2) as unknown as number,
      chapters: [
        { index: 0, startUs: 0, name: 'Avant' },
        { index: 1, startUs: 10_000_000, name: 'Opening' },
        { index: 2, startUs: 20_000_000, name: 'Part A' },
        { index: 3, startUs: 40_000_000, name: 'Ending' },
        { index: 4, startUs: 50_000_000, name: 'Preview' },
      ],
    });
    await h.player.handle({ type: 'nextChapter' });
    await vi.waitFor(
      async () => {
        await h.play(16);
        expect(h.drawn.some((t) => t >= 10_000_000)).toBe(true);
      },
      { timeout: 10_000, interval: 1 },
    );
  });

  it('reports unsupported av1 when the decoder config is not supported', async () => {
    const h = await harness({ supported: false });
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    await vi.waitFor(
      async () => {
        await h.play(16);
        expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', reason: 'av1' }));
      },
      { timeout: 10_000, interval: 1 },
    );
    await h.play(100);
    expect(h.drawn).toEqual([]);
    expect(h.codec.chunks).toEqual([]);
    expect(lastState(h.events)).not.toBe('playing');
  });

  it('stops reading once the encode is closed', async () => {
    const h = await harness();
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    await h.play(32);
    await h.player.handle({ type: 'close' });
    expect(h.events).toContainEqual({ type: 'playlistCleared' });
    expect(lastState(h.events)).toBe('idle');
    const reads = h.reads.length;
    await h.play(100);
    expect(h.reads.length).toBe(reads);
  });

  it('ends once, at the true end, with the last frame drawn', async () => {
    const h = await harness({ audio: true });
    const mkv = await readMatroska(memoryReader(FIXTURE));
    let lastVideoUs = 0;
    for await (const b of mkv.blocks()) if (b.track === 1) lastVideoUs = Math.max(lastVideoUs, b.timeMs * 1000);
    await h.player.handle({ type: 'openEncode', encode: h.spec, startUs: 57_000_000 });
    await vi.waitFor(
      async () => {
        await h.play(64);
        expect(lastState(h.events)).toBe('ended');
      },
      { timeout: 20_000, interval: 1 },
    );
    await h.play(500);
    expect(states(h.events).filter((s) => s === 'ended')).toHaveLength(1);
    expect(h.drawn.at(-1)).toBe(lastVideoUs); // the last frame is the last drawn
    expect(Math.max(...times(h))).toBeLessThanOrEqual(60_018_708);
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('a seek at or past the end ends the episode once', async () => {
    const h = await harness({ audio: true });
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 70_000_000 });
    await vi.waitFor(
      async () => {
        await h.play(64);
        expect(lastState(h.events)).toBe('ended');
      },
      { timeout: 20_000, interval: 1 },
    );
    await h.play(300);
    expect(states(h.events).filter((s) => s === 'ended')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('a start past the end says so and plays from the beginning', async () => {
    const h = await harness();
    await h.player.handle({ type: 'openEncode', encode: h.spec, startUs: 61_000_000 });
    expect(h.events).toContainEqual({ type: 'startFailed', reason: 'past-end' });
    await untilPlaying(h);
    expect(h.drawn[0]).toBe(0);
  });

  it('reports a damaged file as corrupt-disc', async () => {
    for (const bytes of [Uint8Array.from(FIXTURE, (b, i) => (i < 4 ? 0 : b)), FIXTURE.slice(0, 3000)]) {
      const h = await harness({ bytes });
      await h.player.handle({ type: 'openEncode', encode: h.spec });
      expect(h.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'corrupt-disc' }));
      expect(lastState(h.events)).toBe('error');
    }
  });

  it('drops the source and its fetch port when the episode has no video', async () => {
    const at = Buffer.from(FIXTURE).indexOf('V_AV1');
    const bytes = Uint8Array.from(FIXTURE, (b, i) => (i === at + 4 ? 'X'.charCodeAt(0) : b));
    const h = await harness({ bytes });
    const { port1, port2 } = new MessageChannel();
    const reads: Array<{ base: string; start: number; end: number }> = [];
    const stop = serveFetch(port1, encodeFetch(new Map([[BASE, bytes]]), reads));
    try {
      await h.player.handle({ type: 'openEncode', encode: { ...h.spec, fetchPort: port2 } });
      expect(h.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'no-video' }));
      expect(h.events.filter((e) => e.type === 'fetchPortClosed')).toHaveLength(1);
      expect(reads.length).toBeGreaterThan(0);
    } finally {
      stop();
      port1.close();
    }
  });

  it('skips an openEncode that was superseded while a slow one opened', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const second = 'https://nas.example/bluray/api/encodes/e2/';
    const third = 'https://nas.example/bluray/api/encodes/e3/';
    const h = await harness({ more: new Map([[second, FIXTURE], [third, FIXTURE]]), gates: new Map([[BASE, gate]]) });
    const first = h.player.handle({ type: 'openEncode', encode: h.spec });
    void h.player.handle({ type: 'openEncode', encode: h.specFor(second, FIXTURE.length, 'e2') });
    const last = h.player.handle({ type: 'openEncode', encode: h.specFor(third, FIXTURE.length, 'e3') });
    release();
    await first;
    await last;
    expect(h.reads.filter((r) => r.base === second)).toEqual([]);
    expect(h.events.filter((e) => e.type === 'chapters')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
    await untilPlaying(h);
    const firstReads = h.reads.filter((r) => r.base === BASE).length;
    await h.play(200);
    expect(h.reads.filter((r) => r.base === BASE).length).toBe(firstReads); // the superseded file is not read on
  });
});

describe('an encoded episode\'s audio', () => {
  it('plays the default Opus track on the audio clock', async () => {
    const h = await harness({ audio: true });
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    expect(h.events).toContainEqual({ type: 'tracks', audio: [{ index: 1, codec: 'Opus', language: 'jpn', channels: 'stereo', playable: true, name: 'Japanese' }], selectedAudio: 1 });
    await untilPlaying(h);
    const t = await playTo(h, 1_000_000);
    expect(t.clockMode).toBe('audio');
    expect(t.audioCodec).toBe('Opus');
    expect(h.audible.frames).toBeGreaterThan(0);
    expect(h.audioApi.decoders[0]![0]).toBe(0);
    expect(h.events.filter((e) => e.type === 'notice' && e.code === 'audio-disabled')).toEqual([]);
  });

  it('switching audio track continues at the same time', async () => {
    const bytes = await remux({ secondAudio: { name: 'English', language: 'eng' } });
    const h = await harness({ audio: true, bytes });
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    expect(h.events.filter((e) => e.type === 'tracks').at(-1)).toMatchObject({ audio: [{ index: 1, language: 'jpn' }, { index: 2, language: 'eng', name: 'English' }], selectedAudio: 1 });
    await untilPlaying(h);
    await playTo(h, 2_000_000);
    const at = Math.max(...times(h));
    const decodersBefore = h.audioApi.decoders.length;
    const mark = h.events.length;
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(h.events.slice(mark)).toContainEqual(expect.objectContaining({ type: 'tracks', selectedAudio: 2 }));
    const t = await playTo(h, at + 500_000);
    expect(t.clockMode).toBe('audio');
    // the new track's decoder starts its SeekPreRoll before where playback was, and time never went back
    const fresh = h.audioApi.decoders.slice(decodersBefore).find((d) => d.length > 0)!;
    expect(fresh[0]!).toBeGreaterThanOrEqual(at - 80_000 - 40_000);
    expect(fresh[0]!).toBeLessThanOrEqual(at);
    expect(Math.min(...times(h, mark))).toBeGreaterThanOrEqual(at - 20_000);
    expect(lastState(h.events)).toBe('playing');
  });
});

describe('an encoded episode\'s subtitles', () => {
  it('lists the tracks and shows the default ASS track at open', async () => {
    const h = await harness({ audio: true });
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    expect(subtitleEvents(h).at(-1)).toMatchObject({
      pg: [{ index: 1, language: 'eng', name: 'English' }, { index: 2, language: 'eng', name: 'English (disc)' }],
      text: null,
      selected: { pg: 1 },
    });
    await untilPlaying(h);
    const on = await telemetryBetween(h, 1_100_000, 2_900_000);
    expect(on.length).toBeGreaterThan(0);
    expect(on.every((t) => t.textCue)).toBe(true);
    expect(on.some((t) => t.ass !== null)).toBe(true);
    const off = await telemetryBetween(h, 3_100_000, 4_000_000);
    expect(off.every((t) => !t.textCue)).toBe(true);
  });

  it('a subtitle on screen at the seek time shows after the seek', async () => {
    const h = await harness({ audio: true });
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 21_000_000 });
    // the line from 19 s to 23 s started before the seek time: its block is read again from the cluster before it
    const after = await telemetryBetween(h, 21_000_000, 22_000_000);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((t) => t.textCue)).toBe(true);
  });

  it('a PGS display set shows at its time', async () => {
    const h = await harness({ audio: true });
    await h.player.handle({ type: 'openEncode', encode: h.spec, startUs: 4_000_000 });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 2 } });
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 2 });
    const before = await telemetryBetween(h, 4_200_000, 4_900_000);
    expect(before.every((t) => t.pg === null || t.pg.objectsShown === 0)).toBe(true);
    const shown = await telemetryBetween(h, 5_100_000, 6_900_000);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((t) => t.pg?.objectsShown === 1 && !t.textCue)).toBe(true);
    expect(h.pgDraws.some((content) => content)).toBe(true);
  });

  it('shows a forced track in the audio language with subtitles off, and not once the audio is in another', async () => {
    const bytes = await remux({ secondAudio: { name: 'English', language: 'eng' }, ass: { isDefault: false }, pgs: { isForced: true, language: 'jpn' } });
    const h = await harness({ audio: true, bytes });
    await h.player.handle({ type: 'openEncode', encode: h.spec, startUs: 4_000_000 });
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
    const forced = await telemetryBetween(h, 5_100_000, 6_900_000);
    expect(forced.length).toBeGreaterThan(0);
    expect(forced.every((t) => t.pg?.objectsShown === 1)).toBe(true);
    await h.player.handle({ type: 'selectAudio', index: 2 });
    const english = await telemetryBetween(h, 8_100_000, 9_900_000); // the 8 s caption, not shown
    expect(english.every((t) => t.pg === null)).toBe(true);
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
  });

  it('turns the track off and on, and an added file sits at time 0 of the episode', async () => {
    const h = await harness({ audio: true });
    await h.player.handle({ type: 'openEncode', encode: h.spec });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'off' } });
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
    await untilPlaying(h);
    const off = await telemetryBetween(h, 1_100_000, 2_000_000);
    expect(off.every((t) => !t.textCue)).toBe(true);
    const srt = '1\n00:00:02,500 --> 00:00:04,000\nHello\n';
    await h.player.handle({ type: 'addTextSubtitles', files: [{ name: 'ep1.srt', bytes: new TextEncoder().encode(srt).buffer as ArrayBuffer }] });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ selected: 'text', text: { files: [{ name: 'ep1.srt', startUs: 0, offsetMs: 0 }], episodeStarts: [0] } });
    const added = await telemetryBetween(h, 2_600_000, 3_900_000);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((t) => t.textCue && t.textFile === 0)).toBe(true);
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ selected: { pg: 1 }, text: { files: [{ name: 'ep1.srt' }] } });
    const own = await telemetryBetween(h, 12_100_000, 13_900_000); // the ASS track's 12 s line
    expect(own.every((t) => t.textCue && t.textFile === null)).toBe(true);
  });
});
