// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { createAudioDecoderFactory } from '../decode/audio-decoder';
import type { VideoCodecApi, VideoDecoderLike } from '../decode/video-decoder';
import { Player } from '../player';
import type { EncodeSpec, EngineEvent, PlaybackState } from '../protocol';

const FIXTURE = readFileSync(new URL('../../../../fixtures/encodes/990001/1.mkv', import.meta.url));
const BASE = 'https://nas.example/bluray/api/encodes/e1/';
const PATH = 'EPISODE.MKV';

/** A fetch serving the fixture the way the server's encode files route does: 206 for a single range. */
function encodeFetch(bytes: Uint8Array, reads: Array<{ start: number; end: number }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(`${BASE}files/${PATH}`)) return new Response(null, { status: 404 });
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
    if (!range) return new Response(null, { status: 400 });
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), bytes.length - 1);
    reads.push({ start, end });
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

const players: Player[] = [];
afterEach(async () => {
  for (const p of players.splice(0)) await p.handle({ type: 'close' });
});

async function harness(supported = true) {
  const events: EngineEvent[] = [];
  const drawn: number[] = [];
  const clock = { ms: 1000 };
  const reads: Array<{ start: number; end: number }> = [];
  const codec = recordingCodecApi(supported);
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: codec.api,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
    createCompositor: () => ({ resize: () => undefined, drawVideo: (f) => f && drawn.push(f.timestamp) }),
    setTimer: () => () => undefined,
    fetch: encodeFetch(FIXTURE, reads),
    remoteLimits: { chunkBytes: 64 * 1024, readAheadBytes: 256 * 1024 },
  });
  players.push(player);
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  const manifest: DiscManifest = { discId: 'e1', name: 'The Lantern Road', files: [{ path: PATH, size: FIXTURE.length }], inline: {} };
  const spec: EncodeSpec = { base: BASE, token: 'tok', manifest, encodeId: 'e1' };
  return {
    player,
    events,
    drawn,
    reads,
    codec,
    spec,
    async play(ms: number): Promise<void> {
      for (let elapsed = 0; elapsed < ms; elapsed += 16) {
        clock.ms += 16;
        player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

const lastState = (events: readonly EngineEvent[]): PlaybackState | undefined => events.flatMap((e) => (e.type === 'state' ? [e.state] : [])).at(-1);

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
    const h = await harness(false);
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
});
