import { describe, expect, it } from 'vitest';
import { Decimator } from './decimator';
import type { PcmChunk } from './lpcm';
import { STEREO, applyMix, mixMatrix } from '../audio/channel-map';

function tone(rate: number, frames: number, hz: number, ptsUs = 0): PcmChunk {
  const stereo = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = hz === 0 ? 0.5 : 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
    stereo[i * 2] = v;
    stereo[i * 2 + 1] = v;
  }
  return { ptsUs, sampleRate: rate, frames, channels: ['FL', 'FR'], samples: stereo };
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
    expect(out.samples[4000 * 2]).toBeCloseTo(0.5, 3);
  });

  it('passes 1 kHz and attenuates 30 kHz by more than 40 dB', () => {
    const pass = rms(new Decimator(2).process(tone(96_000, 9600, 1000)).samples, 200);
    expect(pass).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const stop = rms(new Decimator(2).process(tone(96_000, 9600, 30_000)).samples, 200);
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
    const a = d.process({ ...input, frames: 481, samples: input.samples.subarray(0, 962) });
    const b = d.process({ ...input, ptsUs: 481 * (1e6 / 96_000), frames: 1519, samples: input.samples.subarray(962) });
    expect([...a.samples, ...b.samples]).toEqual([...whole.samples]);
    expect(b.ptsUs).toBeCloseTo(482 * (1e6 / 96_000), 6);
  });

  it('filters every channel of 5.1 on its own', () => {
    const frames = 9600;
    const samples = new Float32Array(frames * 6);
    for (let i = 0; i < frames; i++) for (let c = 0; c < 6; c++) samples[i * 6 + c] = c / 10;
    const out = new Decimator(2).process({ ptsUs: 0, sampleRate: 96_000, frames, channels: ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'], samples });
    expect(out.channels).toHaveLength(6);
    expect(out.samples.length).toBe(out.frames * 6);
    for (let c = 0; c < 6; c++) expect(out.samples[4000 * 6 + c]).toBeCloseTo(c / 10, 3);
  });

  it('reuses its scratch buffers from chunk to chunk', () => {
    const d = new Decimator(4);
    d.process(tone(192_000, 160, 440));
    const first = d.scratch;
    d.process(tone(192_000, 160, 440, 1000));
    d.process(tone(192_000, 100, 440, 2000));
    expect(d.scratch.work).toBe(first.work);
    expect(d.scratch.history).toBe(first.history);
    expect(d.scratch.acc).toBe(first.acc);
  });

  it('gives the same stereo when 7.1 is folded before decimating as after (both are linear)', () => {
    const layout = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'] as const;
    const frames = 1920;
    const samples = new Float32Array(frames * 8);
    for (let i = 0; i < frames; i++) for (let c = 0; c < 8; c++) samples[i * 8 + c] = 0.1 * Math.sin((2 * Math.PI * 220 * (c + 1) * i) / 96_000);
    const chunk = { ptsUs: 0, sampleRate: 96_000, frames, channels: layout, samples };
    const m = mixMatrix(layout, STEREO);
    const fold = (c: PcmChunk): PcmChunk => ({ ...c, channels: STEREO, samples: applyMix(c.samples, c.frames, c.channels.length, m, 2) });
    const after = fold(new Decimator(2).process(chunk));
    const before = new Decimator(2).process(fold(chunk));
    expect(before.frames).toBe(after.frames);
    for (let i = 0; i < before.samples.length; i++) expect(before.samples[i]).toBeCloseTo(after.samples[i], 5);
  });

  it('rejects impossible factors and input rates', () => {
    expect(() => new Decimator(1.5)).toThrow(RangeError);
    expect(() => new Decimator(1)).toThrow(RangeError);
    expect(() => new Decimator(4).process(tone(96_000, 100, 0))).toThrow(RangeError); // 96 kHz / 4 is not 48 kHz-compatible here
  });
});
