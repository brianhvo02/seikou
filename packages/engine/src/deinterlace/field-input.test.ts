// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { analyzeAvc, avcPicStruct, avcTiming } from '@seikou/bdmv/codecs/h264';
import { CodingType } from '@seikou/bdmv/stream-types';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { WebCodecsVideoDecoder, type VideoCodecApi, type VideoDecoderLike } from '../decode/video-decoder';
import { flagsFromPicStruct, framePlanes, i420Size, rgbToI420, type FieldInput } from './field-input';

interface FakeOptions {
  timestamp: number;
  format?: string;
  matrix?: string;
  width?: number;
  height?: number;
}

class FakeFrame {
  closed = false;
  readonly timestamp: number;
  readonly duration = 33367;
  readonly format: string;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: { width: number; height: number };
  readonly colorSpace: { matrix?: string };
  constructor(o: FakeOptions) {
    this.timestamp = o.timestamp;
    this.format = o.format ?? 'I420';
    this.codedWidth = o.width ?? 4;
    this.codedHeight = o.height ?? 4;
    this.visibleRect = { width: this.codedWidth, height: this.codedHeight };
    this.colorSpace = o.matrix ? { matrix: o.matrix } : {};
  }
  allocationSize(): number {
    return (this.codedWidth * this.codedHeight * 3) / 2;
  }
  async copyTo(dest: Uint8Array): Promise<PlaneLayout[]> {
    dest.fill(this.timestamp % 251, 0, this.allocationSize());
    const w = this.codedWidth;
    const h = this.codedHeight;
    return this.format === 'NV12'
      ? [{ offset: 0, stride: w }, { offset: w * h, stride: w }]
      : [{ offset: 0, stride: w }, { offset: w * h, stride: w / 2 }, { offset: w * h + (w * h) / 4, stride: w / 2 }];
  }
  close(): void {
    this.closed = true;
  }
}

describe('flagsFromPicStruct', () => {
  it('maps Table D-1', () => {
    expect(flagsFromPicStruct(0)).toEqual({ fieldOrder: null, progressive: true, repeatFirstField: false });
    expect(flagsFromPicStruct(3)).toEqual({ fieldOrder: 'tff', progressive: false, repeatFirstField: false });
    expect(flagsFromPicStruct(4)).toEqual({ fieldOrder: 'bff', progressive: false, repeatFirstField: false });
    expect(flagsFromPicStruct(5)).toEqual({ fieldOrder: 'tff', progressive: false, repeatFirstField: true });
    expect(flagsFromPicStruct(6)).toEqual({ fieldOrder: 'bff', progressive: false, repeatFirstField: true });
    expect(flagsFromPicStruct(7)).toEqual({ fieldOrder: null, progressive: true, repeatFirstField: true });
    expect(flagsFromPicStruct(null)).toEqual({ fieldOrder: null, progressive: null, repeatFirstField: false });
  });
});

describe('framePlanes', () => {
  it('copies I420 and NV12 planes with the layout copyTo gave, and picks the matrix', async () => {
    const i420 = new FakeFrame({ timestamp: 7, width: 4, height: 4 });
    const planes = await framePlanes(i420 as unknown as VideoFrame);
    expect(planes.format).toBe('I420');
    expect(planes.layout).toHaveLength(3);
    expect(planes.data.byteLength).toBe(24);
    expect(planes.matrix).toBe('smpte170m');
    const nv12 = await framePlanes(new FakeFrame({ timestamp: 1, format: 'NV12', height: 576, matrix: 'bt709' }) as unknown as VideoFrame);
    expect(nv12.layout).toHaveLength(2);
    expect(nv12.matrix).toBe('bt709');
    expect((await framePlanes(new FakeFrame({ timestamp: 1, height: 576 }) as unknown as VideoFrame)).matrix).toBe('bt470bg');
    expect((await framePlanes(new FakeFrame({ timestamp: 1, height: 1080 }) as unknown as VideoFrame)).matrix).toBe('bt709');
    expect((await framePlanes(new FakeFrame({ timestamp: 1, height: 1080 }) as unknown as VideoFrame, 6)).matrix).toBe('smpte170m');
  });

  it('rejects other pixel formats', async () => {
    await expect(framePlanes(new FakeFrame({ timestamp: 1, format: 'RGBP' }) as unknown as VideoFrame)).rejects.toThrow(/format/);
    await expect(framePlanes(new FakeFrame({ timestamp: 1, format: 'I444' }) as unknown as VideoFrame)).rejects.toThrow(/format/);
  });

  it('converts an RGB frame (BGRX, as Firefox on macOS decodes) to I420 with the matrix', async () => {
    const w = 4;
    const h = 4;
    // pure red, R 255 G 0 B 0: BT.709's limited Y 63, U 102, V 240
    const frame = {
      timestamp: 0,
      format: 'BGRX',
      codedWidth: w,
      codedHeight: h,
      visibleRect: { width: w, height: h },
      colorSpace: { matrix: 'rgb' },
      allocationSize: () => w * h * 4,
      copyTo: async (dest: Uint8Array): Promise<PlaneLayout[]> => {
        for (let i = 0; i < w * h; i++) dest.set([0, 0, 255, 255], i * 4); // B, G, R, X
        return [{ offset: 0, stride: w * 4 }];
      },
    };
    const planes = await framePlanes(frame as unknown as VideoFrame, 1);
    expect(planes.format).toBe('I420');
    expect(planes.matrix).toBe('bt709');
    expect(planes.layout).toEqual([{ offset: 0, stride: 4 }, { offset: 16, stride: 2 }, { offset: 20, stride: 2 }]);
    expect([...planes.data.subarray(0, 24)]).toEqual([...Array(16).fill(63), ...Array(4).fill(102), ...Array(4).fill(240)]);
  });
});

describe('rgbToI420', () => {
  /** Full-range RGB of a limited-range YUV triple with `matrix`'s weights (the decoder's own conversion). */
  function toRgb(y: number, u: number, v: number, kr: number, kb: number): [number, number, number] {
    const yy = ((y - 16) * 255) / 219;
    const pb = ((u - 128) * 255) / 224;
    const pr = ((v - 128) * 255) / 224;
    const r = yy + 2 * (1 - kr) * pr;
    const b = yy + 2 * (1 - kb) * pb;
    const g = (yy - kr * r - kb * b) / (1 - kr - kb);
    const c = (x: number) => Math.min(255, Math.max(0, Math.round(x)));
    return [c(r), c(g), c(b)];
  }

  it('gives back the YUV a decoder turned into RGB, within a step, for both matrices and byte orders', () => {
    // black, white, grey, and each matrix's red, green and blue
    const cases = {
      bt709: [0.2126, 0.0722, [[63, 102, 240], [173, 42, 26], [32, 240, 118]]],
      smpte170m: [0.299, 0.114, [[81, 90, 240], [145, 54, 34], [41, 240, 110]]],
    } as const;
    for (const [matrix, [kr, kb, primaries]] of Object.entries(cases) as [keyof typeof cases, (typeof cases)[keyof typeof cases]][]) {
      for (const [y, u, v] of [[16, 128, 128], [235, 128, 128], [126, 128, 128], ...primaries]) {
        const [r, g, b] = toRgb(y, u, v, kr, kb);
        for (const order of [[0, 1, 2], [2, 1, 0]] as const) {
          const px = [0, 0, 0, 255];
          px[order[0]] = r;
          px[order[1]] = g;
          px[order[2]] = b;
          const rgb = new Uint8Array(16).map((_, i) => px[i % 4]!);
          const out = new Uint8Array(i420Size(2, 2));
          rgbToI420(rgb, { offset: 0, stride: 8 }, order, 2, 2, matrix, out);
          expect(Math.abs(out[0]! - y), `${matrix} Y of ${[y, u, v]}`).toBeLessThanOrEqual(1);
          expect(Math.abs(out[4]! - u), `${matrix} U of ${[y, u, v]}`).toBeLessThanOrEqual(1);
          expect(Math.abs(out[5]! - v), `${matrix} V of ${[y, u, v]}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps each chroma row within one field, and handles odd sizes and the layout's offset and stride", () => {
    // 2×8, top field rows red, bottom field rows blue: chroma rows alternate red and blue, never their average
    const w = 2;
    const h = 8;
    const stride = 12; // padded rows
    const rgb = new Uint8Array(4 + h * stride);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set(y % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255], 4 + y * stride + x * 4);
    const out = new Uint8Array(i420Size(w, h));
    rgbToI420(rgb, { offset: 4, stride }, [0, 1, 2], w, h, 'bt709', out);
    const v = [...out.subarray(w * h + 4, w * h + 8)];
    expect(v).toEqual([240, 118, 240, 118]); // red's V, blue's V
    // 3×3: chroma 2×2 from the edge pixels repeated; no read past the picture
    const odd = new Uint8Array(3 * 3 * 4).fill(200);
    const small = new Uint8Array(i420Size(3, 3)).fill(1);
    expect(i420Size(3, 3)).toBe(9 + 8);
    rgbToI420(odd, { offset: 0, stride: 12 }, [0, 1, 2], 3, 3, 'bt709', small);
    expect(new Set(small.subarray(9, 13))).toEqual(new Set([128]));
  });
});

/** The access units of one clip of the committed interlaced disc. */
function clipUnits(clip: string): Uint8Array[] {
  const file = fixtureDiscFiles('disc-interlaced').get(`BDMV/STREAM/${clip}.m2ts`) as Uint8Array;
  const aus: Uint8Array[] = [];
  const assembler = new PesAssembler((pes) => {
    if (pes.streamId === 0xe0) aus.push(pes.payload);
  });
  for (let o = 0; o + 192 <= file.length; o += 192) {
    const packet = parseSourcePacket(file, o);
    if (packet) assembler.push(packet);
  }
  assembler.flush();
  return aus;
}

describe('WebCodecsVideoDecoder field input', () => {
  /** A decoder that holds its frames and gives them back in reverse order, like a stream with reordering. */
  function setup(): { api: VideoCodecApi; frames: FakeFrame[]; flushOut: () => void } {
    const frames: FakeFrame[] = [];
    let init: VideoDecoderInit | null = null;
    const api: VideoCodecApi = {
      create: (i) => {
        init = i;
        const d: VideoDecoderLike = {
          state: 'unconfigured',
          decodeQueueSize: 0,
          configure() {
            (d as { state: CodecState }).state = 'configured';
          },
          decode(chunk) {
            frames.push(new FakeFrame({ timestamp: (chunk as unknown as EncodedVideoChunkInit).timestamp, height: 1080, width: 8 }));
          },
          async flush() {},
          reset() {},
          close() {},
        };
        return d;
      },
      isConfigSupported: async (config) => ({ supported: true, config }),
      makeChunk: (c) => c as unknown as EncodedVideoChunk,
    };
    return { api, frames, flushOut: () => [...frames].reverse().forEach((f) => init?.output(f as unknown as VideoFrame)) };
  }

  it('pairs each frame with its own unit flags by timestamp, whatever the output order, and closes the frames', async () => {
    const units = clipUnits('00003').slice(0, 40);
    const { api, frames, flushOut } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    const got: FieldInput[] = [];
    const plain: unknown[] = [];
    dec.onFieldInput = (i) => got.push({ ...i, planes: { ...i.planes, data: i.planes.data.slice() } });
    dec.onOutput = (f) => plain.push(f);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: units[0] });
    units.forEach((data, i) => dec.decode({ data, ptsUs: (i + 1) * 1000, discard: false }));
    flushOut();
    await dec.flush();
    expect(plain).toEqual([]);
    expect(got.map((g) => g.timestampUs)).toEqual(units.map((_, i) => (units.length - i) * 1000));
    const timing = avcTiming(analyzeAvc(units[0]).sps as Uint8Array);
    const byTs = new Map(got.map((g) => [g.timestampUs, g.flags]));
    units.forEach((data, i) => expect(byTs.get((i + 1) * 1000)).toEqual(flagsFromPicStruct(avcPicStruct(data, timing))));
    expect(new Set(got.map((g) => g.flags.fieldOrder))).toEqual(new Set(['tff', 'bff']));
    expect(got.every((g) => g.flags.progressive === false)).toBe(true);
    expect(got[0].planes.format).toBe('I420');
    expect(got[0].planes.data[0]).toBe(got[0].timestampUs % 251);
    expect(got[0].durationUs).toBe(33367);
    expect(frames.every((f) => f.closed)).toBe(true);
  });

  it('drops and closes frames still waiting for delivery when reset() runs', async () => {
    const units = clipUnits('00003').slice(0, 3);
    const { api, frames, flushOut } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    const got: FieldInput[] = [];
    dec.onFieldInput = (i) => got.push(i);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: units[0] });
    units.forEach((data, i) => dec.decode({ data, ptsUs: (i + 1) * 1000, discard: false }));
    flushOut(); // outputs are in the chain, not yet delivered
    dec.reset();
    await dec.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([]);
    expect(frames.every((f) => f.closed)).toBe(true);
  });

  it('keeps onOutput for a stream with no field sink', async () => {
    const units = clipUnits('00003').slice(0, 2);
    const { api, flushOut } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    const plain: VideoFrame[] = [];
    dec.onOutput = (f) => plain.push(f);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: units[0] });
    units.forEach((data, i) => dec.decode({ data, ptsUs: (i + 1) * 1000, discard: false }));
    flushOut();
    expect(plain).toHaveLength(2);
  });
});
