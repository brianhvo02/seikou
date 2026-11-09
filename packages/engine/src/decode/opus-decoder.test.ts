// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blobRangeReader, openMatroska, type MkvBlock, type MkvTrack } from '@seikou/matroska';
import { UnsupportedCodecError } from './decoder';
import { CODING_OPUS, createOpusDecoder, opusTrackConfig, parseOpusHead, type AudioDataLike, type AudioDecoderApi, type AudioDecoderLike } from './opus-decoder';

const FIXTURE = readFileSync(new URL('../../../../fixtures/encodes/990001/1.mkv', import.meta.url));

async function fixtureOpus(count: number): Promise<{ track: MkvTrack; blocks: MkvBlock[] }> {
  const file = await openMatroska(blobRangeReader(new Blob([FIXTURE])));
  const track = file.tracks.find((t) => t.codecId === 'A_OPUS')!;
  const blocks: MkvBlock[] = [];
  for await (const b of file.blocksFrom(0)) {
    if (b.track !== track.number) continue;
    blocks.push({ ...b, data: new Uint8Array(b.data) });
    if (blocks.length === count) break;
  }
  return { track, blocks };
}

interface FakeAudio {
  readonly api: AudioDecoderApi;
  readonly configs: AudioDecoderConfig[];
  readonly chunks: Array<{ timestamp: number; bytes: number }>;
  /** Outputs held back (deferred mode), with the decoder that made them. */
  readonly held: Array<() => void>;
}

/** WebCodecs AudioDecoder stand-in: one AudioData of 960 frames per chunk, at once or held back until release. */
function fakeAudioApi(opts: { supported?: boolean; deferred?: boolean; channels?: number } = {}): FakeAudio {
  const configs: AudioDecoderConfig[] = [];
  const chunks: Array<{ timestamp: number; bytes: number }> = [];
  const held: Array<() => void> = [];
  const api: AudioDecoderApi = {
    create(init) {
      let channels = 2;
      const d: AudioDecoderLike = {
        state: 'unconfigured',
        decodeQueueSize: 0,
        configure(config) {
          configs.push(config);
          channels = opts.channels ?? config.numberOfChannels;
          (d as { state: CodecState }).state = 'configured';
        },
        decode(chunk) {
          const c = chunk as unknown as EncodedAudioChunkInit & { data: Uint8Array };
          chunks.push({ timestamp: c.timestamp, bytes: c.data.byteLength });
          const out = fakeAudioData(c.timestamp, 960, channels);
          if (opts.deferred) held.push(() => init.output(out));
          else init.output(out);
        },
        flush: async () => {
          for (const f of held.splice(0)) f();
        },
        reset() {
          (d as { state: CodecState }).state = 'unconfigured';
        },
        close() {
          (d as { state: CodecState }).state = 'closed';
        },
      };
      return d;
    },
    isConfigSupported: async (config) => ({ supported: opts.supported ?? true, config }),
    makeChunk: (init) => init as unknown as EncodedAudioChunk,
  };
  return { api, configs, chunks, held };
}

/** Channel c holds (c + 1) / 10 in every frame. */
function fakeAudioData(timestamp: number, frames: number, channels: number): AudioDataLike {
  return {
    timestamp,
    numberOfFrames: frames,
    numberOfChannels: channels,
    sampleRate: 48_000,
    copyTo(dest, options) {
      (dest as Float32Array).fill((options.planeIndex + 1) / 10);
    },
    close: () => undefined,
  };
}

describe('Opus through WebCodecs', () => {
  it('opus packets decode to 48 kHz PCM through the injected AudioDecoder', async () => {
    const { track, blocks } = await fixtureOpus(3);
    const fake = fakeAudioApi();
    const decoder = await createOpusDecoder(fake.api, opusTrackConfig(track));
    // the OpusHead goes as the description, with its pre-skip zeroed: the adapter drops the pre-skip itself
    const head = track.codecPrivate!;
    expect(fake.configs).toHaveLength(1);
    expect(fake.configs[0]).toMatchObject({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 });
    const description = new Uint8Array(fake.configs[0]!.description as ArrayBuffer);
    expect([...description.slice(0, 10)]).toEqual([...head.slice(0, 10)]);
    expect([description[10], description[11]]).toEqual([0, 0]);
    expect([...description.slice(12)]).toEqual([...head.slice(12)]);

    const results = blocks.map((b) => decoder.decode({ data: b.data, ptsUs: b.timeMs * 1000 }));
    expect(fake.chunks).toEqual(blocks.map((b) => ({ timestamp: b.timeMs * 1000, bytes: b.data.length })));
    const out = results.flatMap((r) => r.chunks);
    // the first packet loses its 312 samples of pre-skip (6.5 ms); the rest are 20 ms, 6.5 ms earlier than their block
    expect(out.map((c) => [c.ptsUs, c.frames, c.sampleRate])).toEqual([
      [0, 960 - 312, 48_000],
      [13_500, 960, 48_000],
      [33_500, 960, 48_000],
    ]);
    expect([...out[0]!.stereo.slice(0, 4)].map((v) => Math.round(v * 10))).toEqual([1, 2, 1, 2]); // L, R interleaved
    expect(results.every((r) => r.failedFrames === 0)).toBe(true);
  });

  it('hands on output that comes after decode() through takeOutput and flush', async () => {
    const { track, blocks } = await fixtureOpus(2);
    const fake = fakeAudioApi({ deferred: true });
    const decoder = await createOpusDecoder(fake.api, opusTrackConfig(track));
    expect(decoder.decode({ data: blocks[0]!.data, ptsUs: 0 }).chunks).toEqual([]);
    expect(decoder.decode({ data: blocks[1]!.data, ptsUs: 20_000 }).chunks).toEqual([]);
    await decoder.flush();
    expect(decoder.takeOutput().chunks.map((c) => c.ptsUs)).toEqual([0, 13_500]);
    expect(decoder.takeOutput().chunks).toEqual([]);
  });

  it('drops what the decoder held before a reset', async () => {
    const { track, blocks } = await fixtureOpus(3);
    const fake = fakeAudioApi({ deferred: true });
    const decoder = await createOpusDecoder(fake.api, opusTrackConfig(track));
    decoder.decode({ data: blocks[0]!.data, ptsUs: 0 });
    const stale = fake.held.splice(0);
    decoder.reset();
    for (const f of stale) f(); // the old decoder's output, arriving late
    decoder.decode({ data: blocks[2]!.data, ptsUs: 40_000 });
    await decoder.flush();
    expect(decoder.takeOutput().chunks.map((c) => c.ptsUs)).toEqual([33_500]);
    expect(fake.configs).toHaveLength(2); // configured again after the reset
  });

  it('mixes more than two channels down to stereo and doubles mono', async () => {
    const { track, blocks } = await fixtureOpus(2);
    const mono = await createOpusDecoder(fakeAudioApi({ channels: 1 }).api, opusTrackConfig(track));
    const m = mono.decode({ data: blocks[1]!.data, ptsUs: 20_000 }).chunks[0]!;
    expect([...m.stereo.slice(0, 2)].map((v) => Math.round(v * 10))).toEqual([1, 1]);
    const six = await createOpusDecoder(fakeAudioApi({ channels: 6 }).api, opusTrackConfig(track));
    const s = six.decode({ data: blocks[1]!.data, ptsUs: 20_000 }).chunks[0]!;
    expect(s.frames).toBe(960);
    expect(Number.isFinite(s.stereo[0]) && s.stereo[0]! > 0 && s.stereo[1]! > 0).toBe(true);
    expect(Math.max(...s.stereo)).toBeLessThanOrEqual(1);
  });

  it('refuses a configuration the browser does not support', async () => {
    const { track } = await fixtureOpus(1);
    const err = await createOpusDecoder(fakeAudioApi({ supported: false }).api, opusTrackConfig(track)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedCodecError);
    expect((err as UnsupportedCodecError).codingType).toBe(CODING_OPUS);
    const none = await createOpusDecoder(null, opusTrackConfig(track)).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(UnsupportedCodecError);
  });

  it('reads the OpusHead', async () => {
    const { track } = await fixtureOpus(1);
    expect(parseOpusHead(track.codecPrivate!)).toEqual({ channels: 2, preSkip: 312, inputRate: 48_000, mappingFamily: 0 });
    expect(parseOpusHead(new Uint8Array(4))).toBeNull();
    expect(opusTrackConfig(track)).toMatchObject({ channels: 2, codecDelayUs: 6500, seekPreRollUs: 80_000 });
  });
});
