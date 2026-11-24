import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadNodeAudioWasm } from '../../../../tests/helpers/audio-wasm';
import { lpcmPayload } from '../../../../tests/helpers/synthetic-disc';
import { CodingType } from '@seikou/bdmv/stream-types';
import { AudioFramer } from './audio-frames';
import { FramedWasmDecoder, LosslessDecoder, dtsHdPart, createAudioDecoderFactory, type AudioDecodeResult, type AudioDecoder, type AudioUnit } from './audio-decoder';
import type { DecodedFrame } from './wasm-audio';
import { UnsupportedCodecError } from './decoder';

const AC3 = readFileSync(fileURLToPath(new URL('../../../../fixtures/synthetic/audio/tone-ac3-stereo.ac3', import.meta.url)));

describe('createAudioDecoderFactory', () => {
  it('decodes LPCM without loading the WASM and counts a corrupt unit as one failed frame', async () => {
    let loads = 0;
    const factory = createAudioDecoderFactory(() => {
      loads++;
      return loadNodeAudioWasm();
    });
    const d = await factory(CodingType.LPCM);
    const ok = d.decode({ data: lpcmPayload(240, 0), ptsUs: 5_000 });
    expect(ok.failedFrames).toBe(0);
    expect(ok.chunks.map((c) => [c.ptsUs, c.frames, c.sampleRate])).toEqual([[5_000, 240, 48_000]]);
    const bad = lpcmPayload(240, 0);
    bad[2] = 0x30; // reserved sample-rate code
    expect(d.decode({ data: bad, ptsUs: 0 })).toEqual({ chunks: [], failedFrames: 1 });
    expect(loads).toBe(0);
  });

  it('decodes AC-3 through the WASM and loads it once for several decoders', async () => {
    let loads = 0;
    const factory = createAudioDecoderFactory(() => {
      loads++;
      return loadNodeAudioWasm();
    });
    const d = await factory(CodingType.AC3);
    await factory(CodingType.DTS);
    const r = d.decode({ data: AC3.subarray(0, 3 * 768), ptsUs: 1_000_000 }); // 192 kb/s → 768-byte frames
    expect(r.failedFrames).toBe(0);
    expect(r.chunks.map((c) => [c.ptsUs, c.frames])).toEqual([
      [1_000_000, 1536],
      [1_032_000, 1536],
      [1_064_000, 1536],
    ]);
    expect(loads).toBe(1);
    d.close();
  });

  it('plays only the AC-3 core of a TrueHD stream', async () => {
    const d = await createAudioDecoderFactory(loadNodeAudioWasm)(CodingType.TRUEHD);
    expect(d.decode({ data: new Uint8Array(400).fill(0xf8), ptsUs: 0, streamIdExtension: 0x72 })).toEqual({ chunks: [], failedFrames: 0 });
    const r = d.decode({ data: AC3.subarray(0, 768), ptsUs: 0, streamIdExtension: 0x76 });
    expect(r.chunks).toHaveLength(1);
    d.close();
  });

  it('retries a failed WASM load on the next request', async () => {
    let calls = 0;
    const factory = createAudioDecoderFactory(() => (++calls === 1 ? Promise.reject(new Error('offline')) : loadNodeAudioWasm()));
    await expect(factory(CodingType.AC3)).rejects.toThrow('offline');
    await expect(factory(CodingType.AC3)).resolves.toBeDefined();
  });

  it('rejects secondary audio as unsupported', async () => {
    await expect(createAudioDecoderFactory(loadNodeAudioWasm)(CodingType.EAC3_SECONDARY)).rejects.toBeInstanceOf(UnsupportedCodecError);
  });
});

describe('FramedWasmDecoder sample-rate check', () => {
  // A 256-byte AC-3 frame (frmsizecod 8) per unit.
  const unit = (n: number): { data: Uint8Array; ptsUs: number } => {
    const f = new Uint8Array(256).fill(n);
    f.set([0x0b, 0x77, 0, 0, 8, 8 << 3]);
    return { data: f, ptsUs: n * 32_000 };
  };
  const fakeFrames = (rates: number[]): { decode: () => DecodedFrame; reset: () => void; close: () => void } => ({
    decode: () => ({ sampleRate: rates.shift() ?? 48_000, channels: ['FL', 'FR'], samples: new Float32Array(2 * 1536) }),
    reset: () => undefined,
    close: () => undefined,
  });

  it('rejects a stream whose first frame is not 48 kHz', () => {
    const d = new FramedWasmDecoder(CodingType.AC3, new AudioFramer('ac3'), fakeFrames([44_100]), null);
    expect(() => d.decode(unit(1))).toThrow(UnsupportedCodecError);
  });

  it('skips and counts an odd-rate frame once 48 kHz output exists, also after reset()', () => {
    const d = new FramedWasmDecoder(CodingType.AC3, new AudioFramer('ac3'), fakeFrames([48_000, 44_100, 48_000, 44_100]), null);
    expect(d.decode(unit(1)).chunks).toHaveLength(1);
    expect(d.decode(unit(2))).toMatchObject({ chunks: [], failedFrames: 1 });
    expect(d.decode(unit(3)).chunks).toHaveLength(1);
    d.reset();
    expect(d.decode(unit(4))).toMatchObject({ chunks: [], failedFrames: 1 });
  });
});

describe('LosslessDecoder', () => {
  const chunk = (ptsUs: number) => ({ ptsUs, sampleRate: 48_000, frames: 4800, channels: ['FL', 'FR'] as const, samples: new Float32Array(9600) });
  /** A decoder that answers each unit from a script: output, a failed frame, nothing, or a stream-level error. */
  function scripted(script: Array<'out' | 'fail' | 'none' | 'throw'>, closed: string[], name: string): AudioDecoder {
    return {
      decode(u: AudioUnit): AudioDecodeResult {
        const step = script.shift() ?? 'out';
        if (step === 'throw') throw new UnsupportedCodecError(CodingType.TRUEHD, 'odd rate');
        if (step === 'fail') return { chunks: [], failedFrames: 1 };
        return { chunks: step === 'out' ? [chunk(u.ptsUs)] : [], failedFrames: 0 };
      },
      reset: () => undefined,
      close: () => closed.push(name),
      decoding: () => ({ part: name === 'whole' ? 'full' : 'core', channels: ['FL', 'FR'] }),
    };
  }
  const u = (ptsUs: number): AudioUnit => ({ data: new Uint8Array(4), ptsUs });

  it('plays the whole stream while it decodes', () => {
    const closed: string[] = [];
    const d = new LosslessDecoder(CodingType.TRUEHD, scripted([], closed, 'whole'), () => scripted([], closed, 'core'), () => 0);
    expect(d.decode(u(0)).chunks).toHaveLength(1);
    expect(d.decoding()?.part).toBe('full');
    expect(d.fallbackReason).toBeNull();
  });

  it('falls back to the core on a stream-level error, decoding the same unit there', () => {
    const closed: string[] = [];
    const d = new LosslessDecoder(CodingType.TRUEHD, scripted(['throw'], closed, 'whole'), () => scripted([], closed, 'core'), () => 0);
    expect(d.decode(u(0)).chunks).toHaveLength(1);
    expect(d.decoding()?.part).toBe('core');
    expect(closed).toEqual(['whole']);
  });

  it('falls back when nothing has come out for 2 s of stream time', () => {
    const d = new LosslessDecoder(CodingType.TRUEHD, scripted(['none', 'none', 'none'], [], 'whole'), () => scripted([], [], 'core'), () => 0);
    expect(d.decode(u(0)).chunks).toHaveLength(0);
    expect(d.decode(u(1_000_000)).chunks).toHaveLength(0);
    expect(d.decode(u(2_000_000)).chunks).toHaveLength(1);
    expect(d.fallbackReason).toMatch(/nothing came out/);
  });

  it('falls back after 8 rejected frames in a row, and not after fewer with output between', () => {
    const fails = (n: number): Array<'fail'> => Array.from({ length: n }, () => 'fail' as const);
    const ok = new LosslessDecoder(CodingType.DTSHD_MASTER, scripted(['out', ...fails(7), 'out', ...fails(7)], [], 'whole'), () => scripted([], [], 'core'), () => 0);
    for (let i = 0; i < 16; i++) ok.decode(u(i * 1000));
    expect(ok.fallbackReason).toBeNull();
    const bad = new LosslessDecoder(CodingType.DTSHD_MASTER, scripted(['out', ...fails(8)], [], 'whole'), () => scripted([], [], 'core'), () => 0);
    for (let i = 0; i < 9; i++) bad.decode(u(i * 1000));
    expect(bad.fallbackReason).toMatch(/8 frames/);
    expect(bad.decoding()?.part).toBe('core');
  });

  it('falls back when decoding costs more than a quarter of real time over 5 s of audio', () => {
    let now = 0;
    const slow: AudioDecoder = { ...scripted([], [], 'whole'), decode(x) { now += 30; return { chunks: [chunk(x.ptsUs)], failedFrames: 0 }; } }; // 30 ms per 100 ms
    const d = new LosslessDecoder(CodingType.TRUEHD, slow, () => scripted([], [], 'core'), () => now);
    for (let i = 0; i < 60; i++) d.decode(u(i * 100_000));
    expect(d.fallbackReason).toMatch(/30% of real time/);
    let fastNow = 0;
    const fast: AudioDecoder = { ...scripted([], [], 'whole'), decode(x) { fastNow += 5; return { chunks: [chunk(x.ptsUs)], failedFrames: 0 }; } };
    const f = new LosslessDecoder(CodingType.TRUEHD, fast, () => scripted([], [], 'core'), () => fastNow);
    for (let i = 0; i < 100; i++) f.decode(u(i * 100_000));
    expect(f.fallbackReason).toBeNull();
  });
});

describe('end of input', () => {
  /** DTS core frame with NBLKS = 15 (512 samples) and an extension substream after it. */
  function dtsHdPacket(fill: number): Uint8Array {
    const core = new Uint8Array(1008).fill(fill);
    const fsize = core.length - 1;
    core.set([0x7f, 0xfe, 0x80, 0x01, 0xfc, (15 << 2) | (fsize >> 12), (fsize >> 4) & 0xff, ((fsize & 0x0f) << 4) | 0x0f]);
    const ext = new Uint8Array(300);
    ext.set([0x64, 0x58, 0x20, 0x25, 0x00]);
    const bits = (16n << 16n) | BigInt(ext.length - 1);
    ext[5] = Number((bits >> 19n) & 0xffn);
    ext[6] = Number((bits >> 11n) & 0xffn);
    ext[7] = Number((bits >> 3n) & 0xffn);
    ext[8] = Number((bits & 0x7n) << 5n);
    const out = new Uint8Array(core.length + ext.length);
    out.set(core);
    out.set(ext, core.length);
    return out;
  }
  const frames = (seen: number[]): { decode: (f: Uint8Array) => DecodedFrame; reset: () => void; close: () => void } => ({
    decode: (f) => {
      seen.push(f[20]!);
      return { sampleRate: 48_000, channels: ['FL', 'FR'], samples: new Float32Array(2 * 512) };
    },
    reset: () => undefined,
    close: () => undefined,
  });

  it('plays the DTS-HD packet held for the next one when the input ends', () => {
    const seen: number[] = [];
    const d = new FramedWasmDecoder(CodingType.DTSHD_MASTER, new AudioFramer('dtshd'), frames(seen), null);
    expect(d.decode({ data: dtsHdPacket(1), ptsUs: 0 }).chunks).toHaveLength(0); // held: its extension could follow
    expect(d.decode({ data: dtsHdPacket(2), ptsUs: 10_667 }).chunks).toHaveLength(1);
    const last = d.end();
    expect(last.chunks.map((c) => c.ptsUs)).toEqual([10_667]);
    expect(seen).toEqual([1, 2]);
    expect(d.end().chunks).toHaveLength(0);
  });

  it('LosslessDecoder hands end() to the decoder in use', () => {
    const seen: number[] = [];
    const whole = new FramedWasmDecoder(CodingType.DTSHD_MASTER, new AudioFramer('dtshd'), frames(seen), null);
    const d = new LosslessDecoder(CodingType.DTSHD_MASTER, whole, () => whole, () => 0);
    d.decode({ data: dtsHdPacket(5), ptsUs: 0 });
    expect(d.end().chunks).toHaveLength(1);
  });
});

describe('DTS-HD: what was decoded, from the profile', () => {
  it('calls Master Audio whole only with XLL decoded, and High Resolution whole with its extensions', () => {
    const ma = dtsHdPart(CodingType.DTSHD_MASTER);
    expect([60, 61, 62, 50, 20].map(ma)).toEqual(['full', 'full', 'full', 'core', 'core']);
    const hra = dtsHdPart(CodingType.DTSHD);
    expect([50, 30, 20].map(hra)).toEqual(['full', 'core', 'core']);
  });

  it('turns the label to core when dcadec falls back quietly, and back when XLL returns', () => {
    const profiles = [60, 50, 60];
    const frames = { decode: (): DecodedFrame => ({ sampleRate: 48_000, channels: ['FL', 'FR'], samples: new Float32Array(1024), profile: profiles.shift() }), reset: () => undefined, close: () => undefined };
    const d = new FramedWasmDecoder(CodingType.DTSHD_MASTER, new AudioFramer('dts'), frames, null, new Set([48_000]), 'full', dtsHdPart(CodingType.DTSHD_MASTER));
    const core = (fill: number): Uint8Array => {
      const f = new Uint8Array(1008).fill(fill);
      const fsize = f.length - 1;
      f.set([0x7f, 0xfe, 0x80, 0x01, 0xfc, (15 << 2) | (fsize >> 12), (fsize >> 4) & 0xff, ((fsize & 0x0f) << 4) | 0x0f]);
      return f;
    };
    const parts: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) {
      d.decode({ data: core(i + 1), ptsUs: i * 10_667 });
      parts.push(d.decoding()?.part);
    }
    expect(parts).toEqual(['full', 'core', 'full']);
  });
});
