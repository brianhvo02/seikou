// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Downsampler16k } from '../../src/audio/downsample';

function sine(rate: number, hz: number, seconds: number, amplitude: number): Float32Array {
  const out = new Float32Array(rate * seconds);
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Runs `planar` through a downsampler in uneven pieces, then flushes. */
function run(rate: number, planar: Float32Array[]): Int16Array {
  const d = new Downsampler16k(rate);
  const parts: Int16Array[] = [];
  const n = planar[0].length;
  let step = 1;
  for (let at = 0; at < n; at += step, step = ((step * 7 + 3) % 4001) + 1) {
    parts.push(d.push(planar.map((p) => p.subarray(at, Math.min(n, at + step)))));
  }
  parts.push(d.flush());
  const out = new Int16Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function rms(x: Int16Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (to - from));
}

const target = (0.5 / Math.SQRT2) * 32767;

describe('Downsampler16k', () => {
  it('turns a 48 kHz stereo 1 kHz sine into 16 kHz mono at the same level', () => {
    const s = sine(48000, 1000, 2, 0.5);
    const out = run(48000, [s, s]);
    expect(Math.abs(out.length - s.length / 3)).toBeLessThanOrEqual(64);
    const level = rms(out, 1000, out.length - 1000);
    expect(Math.abs(level - target) / target).toBeLessThan(0.05);
  });

  it('averages the channels', () => {
    const s = sine(48000, 1000, 1, 0.5);
    const out = run(48000, [s, new Float32Array(s.length)]);
    expect(Math.abs(rms(out, 1000, out.length - 1000) - target / 2) / (target / 2)).toBeLessThan(0.05);
  });

  it('keeps time: output sample n is input sample 3n', () => {
    const s = sine(48000, 250, 1, 0.5);
    const out = run(48000, [s]);
    expect(out).toHaveLength(16000);
    for (const n of [2000, 5000, 9001]) expect(Math.abs(out[n] / 32767 - s[3 * n])).toBeLessThan(0.01);
  });

  it('removes a 10 kHz sine (above 8 kHz it would alias)', () => {
    const s = sine(48000, 10000, 2, 0.5);
    const out = run(48000, [s, s]);
    expect(rms(out, 1000, out.length - 1000)).toBeLessThan(0.05 * target);
  });

  it('takes 96 and 192 kHz and refuses rates that are not a multiple of 16 kHz', () => {
    for (const rate of [96000, 192000]) {
      const s = sine(rate, 1000, 1, 0.5);
      const out = run(rate, [s]);
      expect(out).toHaveLength(16000);
      expect(Math.abs(rms(out, 1000, out.length - 1000) - target) / target).toBeLessThan(0.05);
    }
    expect(() => new Downsampler16k(44100)).toThrow(RangeError);
  });
});
