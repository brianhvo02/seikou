// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bwdifField, bwdifIntraField } from './bwdif-cpu';
import type { Plane } from './metrics-cpu';

const REF = fileURLToPath(new URL('../../../../fixtures/synthetic/deinterlace-ref/', import.meta.url));

interface RefEntry {
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
}

function refFrames(name: 'video' | 'videoBwdif'): Plane[] {
  const refs = JSON.parse(readFileSync(`${REF}refs.json`, 'utf8')) as Record<string, RefEntry>;
  const r = refs[name]!;
  const bytes = new Uint8Array(gunzipSync(readFileSync(REF + r.file)));
  const size = r.width * r.height;
  expect(bytes.length).toBe(r.frames * size);
  return Array.from({ length: r.frames }, (_, i) => ({
    width: r.width,
    height: r.height,
    stride: r.width,
    data: bytes.subarray(i * size, (i + 1) * size),
  }));
}

function firstMismatch(a: Plane, b: Plane): string | null {
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const p = a.data[y * a.stride + x]!;
      const q = b.data[y * b.stride + x]!;
      if (p !== q) return `row ${y}, column ${x}: ${p} where ffmpeg has ${q}`;
    }
  }
  return null;
}

describe('bwdifField', () => {
  const input = refFrames('video');
  const expected = refFrames('videoBwdif');

  // ffmpeg's send_field pictures of frames 0-4, each frame's top field then bottom.
  for (let frame = 1; frame <= 4; frame++) {
    for (const parity of [0, 1] as const) {
      it(`equals ffmpeg's bwdif byte for byte: frame ${frame}, ${parity === 0 ? 'top' : 'bottom'} field`, () => {
        const out = bwdifField(input[frame - 1]!, input[frame]!, input[frame + 1]!, parity, true);
        expect(out.width).toBe(input[frame]!.width);
        expect(out.height).toBe(input[frame]!.height);
        expect(firstMismatch(out, expected[frame * 2 + parity]!)).toBeNull();
      });
    }
  }

  it("equals ffmpeg's bwdif for the stream's first frame: its top field alone, its bottom with itself as previous", () => {
    expect(firstMismatch(bwdifIntraField(input[0]!, 0), expected[0]!)).toBeNull();
    expect(firstMismatch(bwdifField(input[0]!, input[0]!, input[1]!, 1, true), expected[1]!)).toBeNull();
  });

  it('keeps the field it is made from and fills only the other rows', () => {
    const [prev, cur, next] = [input[1]!, input[2]!, input[3]!];
    for (const parity of [0, 1] as const) {
      const out = bwdifField(prev, cur, next, parity, true);
      for (let y = parity; y < cur.height; y += 2) {
        expect(out.data.subarray(y * out.stride, y * out.stride + out.width)).toEqual(
          cur.data.subarray(y * cur.stride, y * cur.stride + cur.width),
        );
      }
    }
  });

  it('reads planes with a stride wider than the picture', () => {
    const pad = (p: Plane): Plane => {
      const stride = p.width + 32;
      const data = new Uint8Array(stride * p.height).fill(7);
      for (let y = 0; y < p.height; y++) data.set(p.data.subarray(y * p.stride, y * p.stride + p.width), y * stride);
      return { width: p.width, height: p.height, stride, data };
    };
    const out = bwdifField(pad(input[1]!), pad(input[2]!), pad(input[3]!), 1, true);
    expect(firstMismatch(out, expected[5]!)).toBeNull();
  });
});
