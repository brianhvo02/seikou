import { describe, expect, it } from 'vitest';
import { Decimator } from './decimator';
import type { PcmChunk } from './lpcm';

function tone(rate: number, frames: number, hz: number, ptsUs = 0): PcmChunk {
  const stereo = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = hz === 0 ? 0.5 : 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
    stereo[i * 2] = v;
    stereo[i * 2 + 1] = v;
  }
  return { ptsUs, sampleRate: rate, frames, stereo };
}

function rms(samples: Float32Array, skipFrames: number): number {
  let sum = 0;
  let n = 0;
  for (let i = skipFrames * 2; i < samples.length; i += 2) {
    sum += samples[i] * samples[i];
    n++;
  }
  return Math.sqrt(sum / n);
}

describe('Decimator', () => {
  it('halves 96 kHz to 48 kHz and keeps DC', () => {
    const out = new Decimator(2).process(tone(96_000, 9600, 0));
    expect(out.sampleRate).toBe(48_000);
    expect(out.frames).toBe(4800);
    expect(out.stereo[4000 * 2]).toBeCloseTo(0.5, 3);
  });

  it('passes 1 kHz and attenuates 30 kHz by more than 40 dB', () => {
    const pass = rms(new Decimator(2).process(tone(96_000, 9600, 1000)).stereo, 200);
    expect(pass).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const stop = rms(new Decimator(2).process(tone(96_000, 9600, 30_000)).stereo, 200);
    expect(stop).toBeLessThan((0.5 / Math.SQRT2) * 0.01);
  });

  it('quarters 192 kHz', () => {
    const out = new Decimator(4).process(tone(192_000, 1920, 0));
    expect(out).toMatchObject({ sampleRate: 48_000, frames: 480 });
  });

  it('produces identical output when the input is split at arbitrary points', () => {
    const whole = new Decimator(2).process(tone(96_000, 2000, 440));
    const input = tone(96_000, 2000, 440);
    const d = new Decimator(2);
    const a = d.process({ ...input, frames: 481, stereo: input.stereo.subarray(0, 962) });
    const b = d.process({ ...input, ptsUs: 481 * (1e6 / 96_000), frames: 1519, stereo: input.stereo.subarray(962) });
    expect([...a.stereo, ...b.stereo]).toEqual([...whole.stereo]);
    expect(b.ptsUs).toBeCloseTo(482 * (1e6 / 96_000), 6);
  });

  it('rejects impossible factors and input rates', () => {
    expect(() => new Decimator(1.5)).toThrow(RangeError);
    expect(() => new Decimator(1)).toThrow(RangeError);
    expect(() => new Decimator(4).process(tone(96_000, 100, 0))).toThrow(RangeError); // 96 kHz / 4 is not 48 kHz-compatible here
  });
});
