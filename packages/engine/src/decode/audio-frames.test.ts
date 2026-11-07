import { describe, expect, it } from 'vitest';
import { AudioFramer } from './audio-frames';

const FRAME_US = (1536 * 1e6) / 48_000; // 32 000

/** AC-3 frame, 48 kHz; frmsizecod 8 → 128 words = 256 bytes. */
function ac3Frame(fill: number, frmsizecod = 8, fscod = 0): Uint8Array {
  const words = [64, 64, 80, 80, 96, 96, 112, 112, 128, 128][frmsizecod] ?? 128;
  const f = new Uint8Array(words * 2).fill(fill);
  f.set([0x0b, 0x77, 0, 0, (fscod << 6) | frmsizecod, 8 << 3]);
  return f;
}

/** E-AC-3 frame: strmtyp 0 independent / 1 dependent, 6 blocks, 48 kHz. */
function eac3Frame(strmtyp: number, bytes: number, fill: number, substreamid = 0, fscod = 0): Uint8Array {
  const frmsiz = bytes / 2 - 1;
  const f = new Uint8Array(bytes).fill(fill);
  f.set([0x0b, 0x77, (strmtyp << 6) | (substreamid << 3) | (frmsiz >> 8), frmsiz & 0xff, (fscod << 6) | (3 << 4), 16 << 3]);
  return f;
}

/** DTS core frame with NBLKS = 15 (512 samples). */
function dtsFrame(bytes: number, fill: number): Uint8Array {
  const f = new Uint8Array(bytes).fill(fill);
  const nblks = 15;
  const fsize = bytes - 1;
  f.set([0x7f, 0xfe, 0x80, 0x01, 0xfc | (nblks >> 6), ((nblks & 0x3f) << 2) | (fsize >> 12), (fsize >> 4) & 0xff, ((fsize & 0x0f) << 4) | 0x0f, 0x34]);
  return f;
}

/** DTS-HD extension substream, header size type 0: 8-bit header size, 16-bit fsize at bit 43. */
function exss(bytes: number): Uint8Array {
  const f = new Uint8Array(bytes);
  f.set([0x64, 0x58, 0x20, 0x25, 0x00]);
  const fsize = bytes - 1;
  // bits after byte 4: index(2)=0, type(1)=0, headerSize(8)=16, fsize(16)
  const bits = (0n << 25n) | (0n << 24n) | (16n << 16n) | BigInt(fsize);
  f[5] = Number((bits >> 19n) & 0xffn);
  f[6] = Number((bits >> 11n) & 0xffn);
  f[7] = Number((bits >> 3n) & 0xffn);
  f[8] = Number((bits & 0x7n) << 5n);
  return f;
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('AudioFramer', () => {
  it('splits several AC-3 frames in one PES and times them from the PES PTS', () => {
    const framer = new AudioFramer('ac3');
    const frames = framer.push(cat(ac3Frame(1), ac3Frame(2), ac3Frame(3)), 1_000_000);
    expect(frames.map((f) => [f.data.length, f.data[10], f.ptsUs, f.samples])).toEqual([
      [256, 1, 1_000_000, 1536],
      [256, 2, 1_000_000 + FRAME_US, 1536],
      [256, 3, 1_000_000 + 2 * FRAME_US, 1536],
    ]);
  });

  it('carries a frame split across PES packets; the next PTS goes to the first frame starting in that PES', () => {
    const framer = new AudioFramer('ac3');
    const a = ac3Frame(1);
    const b = ac3Frame(2);
    const c = ac3Frame(3);
    expect(framer.push(cat(a, b.subarray(0, 100)), 0).map((f) => f.ptsUs)).toEqual([0]);
    // b started in the previous PES (running PTS); c is the first frame starting here (PES PTS).
    const second = framer.push(cat(b.subarray(100), c), 64_500);
    expect(second.map((f) => [f.data[10], f.ptsUs])).toEqual([
      [2, FRAME_US],
      [3, 64_500],
    ]);
  });

  it('gives a frame that starts in one push and completes in the next the PTS of the push it started in', () => {
    const framer = new AudioFramer('ac3');
    const b = ac3Frame(2);
    const c = ac3Frame(3);
    expect(framer.push(b.subarray(0, 100), 1_000)).toEqual([]);
    const out = framer.push(cat(b.subarray(100), c), 2_000);
    expect(out.map((f) => [f.data[10], f.ptsUs])).toEqual([
      [2, 1_000],
      [3, 2_000],
    ]);
  });

  it('after reset(), a frame split across pushes still takes the PTS of the push it started in', () => {
    const framer = new AudioFramer('ac3');
    framer.push(ac3Frame(1), 0);
    framer.reset();
    const b = ac3Frame(2);
    const c = ac3Frame(3);
    expect(framer.push(cat(ac3Frame(7).subarray(40), b.subarray(0, 100)), 1_000_000)).toEqual([]);
    const out = framer.push(cat(b.subarray(100), c), 2_000_000);
    expect(out.map((f) => [f.data[10], f.ptsUs])).toEqual([
      [2, 1_000_000],
      [3, 2_000_000],
    ]);
  });

  it('skips garbage and resyncs when joining mid-frame after a seek', () => {
    const framer = new AudioFramer('ac3');
    const tail = ac3Frame(7).subarray(40); // the end of a frame we never saw the start of
    const frames = framer.push(cat(tail, ac3Frame(1)), 5_000_000);
    expect(frames.map((f) => [f.data[10], f.ptsUs])).toEqual([[1, 5_000_000]]);
  });

  it('treats a non-48 kHz AC-3 header as no sync', () => {
    const framer = new AudioFramer('ac3');
    expect(framer.push(cat(ac3Frame(9, 8, 1), ac3Frame(1)), 0).map((f) => f.data[10])).toEqual([1]);
  });

  it('groups an E-AC-3 independent frame with its dependent frames and emits the group when the next one starts', () => {
    const framer = new AudioFramer('eac3');
    expect(framer.push(cat(eac3Frame(0, 200, 1), eac3Frame(1, 100, 2)), 0)).toEqual([]);
    const out = framer.push(eac3Frame(0, 200, 3), 32_000);
    expect(out).toHaveLength(1);
    expect(out[0].data.length).toBe(300);
    expect([out[0].data[10], out[0].data[210], out[0].ptsUs, out[0].samples]).toEqual([1, 2, 0, 1536]);
  });

  it('drops a dependent E-AC-3 frame with no independent frame before it', () => {
    const framer = new AudioFramer('eac3');
    framer.push(cat(eac3Frame(1, 100, 2), eac3Frame(0, 200, 1)), 0);
    const out = framer.push(eac3Frame(0, 200, 3), 32_000);
    expect(out.map((f) => [f.data.length, f.data[10]])).toEqual([[200, 1]]);
  });

  it('treats a reduced-rate E-AC-3 header as no sync (a following valid frame is still emitted)', () => {
    const framer = new AudioFramer('eac3');
    framer.push(eac3Frame(0, 200, 1, 0, 1), 0);
    const out = framer.push(cat(eac3Frame(0, 200, 2), eac3Frame(0, 200, 3)), 0);
    expect(out.map((f) => f.data[10])).toEqual([2]);
  });

  it('reset() drops a half-built group and kept bytes, so the next PTS is the new PES PTS', () => {
    const framer = new AudioFramer('eac3');
    framer.push(cat(eac3Frame(0, 200, 1), eac3Frame(0, 200, 2).subarray(0, 50)), 0);
    framer.reset();
    framer.push(eac3Frame(0, 200, 5), 9_000_000);
    const out = framer.push(eac3Frame(0, 200, 6), 9_032_000);
    expect(out.map((f) => [f.data[10], f.ptsUs])).toEqual([[5, 9_000_000]]);
  });

  it('splits DTS core frames (512 samples) and drops DTS-HD extension substreams', () => {
    const framer = new AudioFramer('dts');
    const frames = framer.push(cat(dtsFrame(1006, 1), exss(300), dtsFrame(1006, 2), exss(300)), 2_000_000);
    expect(frames.map((f) => [f.data.length, f.data[20], f.ptsUs, f.samples])).toEqual([
      [1006, 1, 2_000_000, 512],
      [1006, 2, 2_000_000 + (512 * 1e6) / 48_000, 512],
    ]);
  });
});
