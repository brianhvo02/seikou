import { describe, expect, it } from 'vitest';
import { SURROUND_51, SURROUND_71, STEREO, applyMix, layoutName, mixMatrix, outputChannelsFor, speakerFromAvChannel, type ChannelLayout } from './channel-map';

const K = Math.SQRT1_2;

/** The gain from source speaker `from` into output speaker `to`. */
function gain(source: ChannelLayout, output: ChannelLayout, from: string, to: string): number {
  const m = mixMatrix(source, output);
  return m[output.indexOf(to as never) * source.length + source.indexOf(from as never)];
}

describe('mixMatrix', () => {
  it('passes a layout the output has straight through', () => {
    for (const l of [STEREO, SURROUND_51, SURROUND_71]) {
      const m = mixMatrix(l, l);
      l.forEach((_, i) => l.forEach((__, j) => expect(m[i * l.length + j]).toBe(i === j ? 1 : 0)));
    }
  });

  it('folds 5.1 to stereo as the old shim did (centre and surrounds -3 dB, LFE dropped, one normaliser)', () => {
    const norm = 1 / (1 + K + K);
    expect(gain(SURROUND_51, STEREO, 'FL', 'FL')).toBeCloseTo(norm, 12);
    expect(gain(SURROUND_51, STEREO, 'FC', 'FR')).toBeCloseTo(K * norm, 12);
    expect(gain(SURROUND_51, STEREO, 'SL', 'FL')).toBeCloseTo(K * norm, 12);
    expect(gain(SURROUND_51, STEREO, 'SL', 'FR')).toBe(0);
    expect(gain(SURROUND_51, STEREO, 'LFE', 'FL')).toBe(0);
  });

  it('folds LPCM 3/1 (single surround as back centre) as the old LPCM table did', () => {
    const l: ChannelLayout = ['FL', 'FR', 'BC'];
    expect(gain(l, STEREO, 'FL', 'FL')).toBeCloseTo(1 / 1.5, 12);
    expect(gain(l, STEREO, 'BC', 'FR')).toBeCloseTo(0.5 / 1.5, 12);
  });

  it('plays mono on both sides of stereo at full level and in the centre of 5.1', () => {
    expect([...mixMatrix(['FC'], STEREO)]).toEqual([1, 1]);
    expect(gain(['FC'], SURROUND_51, 'FC', 'FC')).toBe(1);
  });

  it('puts 5.1 back surrounds on the side pair of 5.1 and of 7.1 outputs', () => {
    const back51: ChannelLayout = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'];
    expect(gain(back51, SURROUND_51, 'BL', 'SL')).toBe(1);
    expect(gain(back51, SURROUND_71, 'BL', 'SL')).toBe(1);
    expect(gain(back51, SURROUND_71, 'BL', 'BL')).toBe(0);
  });

  it('folds 7.1 into 5.1 with the backs -3 dB into the sides, normalising only the side rows', () => {
    const norm = 1 / (1 + K);
    expect(gain(SURROUND_71, SURROUND_51, 'BL', 'SL')).toBeCloseTo(K * norm, 12);
    expect(gain(SURROUND_71, SURROUND_51, 'SL', 'SL')).toBeCloseTo(norm, 12);
    // fronts, centre (dialogue) and LFE keep their level
    for (const s of ['FL', 'FR', 'FC', 'LFE']) expect(gain(SURROUND_71, SURROUND_51, s, s)).toBe(1);
  });

  it('keeps the fronts at full level when 7.1 (wide) folds its front-of-centre pair on 7.1', () => {
    const wide: ChannelLayout = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'];
    expect(gain(wide, SURROUND_71, 'LFE', 'LFE')).toBe(1);
    expect(gain(wide, SURROUND_71, 'FL', 'FL')).toBeCloseTo(1 / (1 + K), 12);
    expect(gain(wide, SURROUND_71, 'FC', 'FC')).toBeCloseTo(1 / (1 + 2 * K), 12);
  });

  it('folds 7.1 (wide) front-of-centre channels into the front and centre on 7.1', () => {
    const wide: ChannelLayout = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'];
    const m = mixMatrix(wide, SURROUND_71);
    const flRow = SURROUND_71.indexOf('FL');
    expect(m[flRow * 8 + wide.indexOf('FLC')]).toBeGreaterThan(0);
    // backs stay backs: the stream has no sides
    expect(gain(wide, SURROUND_71, 'BL', 'SL')).toBeGreaterThan(0);
  });

  it('never drops a channel of 6.1 (back centre) on 7.1', () => {
    const l: ChannelLayout = ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'];
    expect(gain(l, SURROUND_71, 'BC', 'BL')).toBeGreaterThan(0);
    expect(gain(l, SURROUND_71, 'BC', 'BR')).toBeGreaterThan(0);
  });
});

describe('applyMix', () => {
  it('mixes interleaved frames through the matrix', () => {
    const out = applyMix(new Float32Array([0.5, 0.25, 1, 0, 0, 0]), 1, 6, mixMatrix(SURROUND_51, STEREO), 2);
    const norm = 1 / (1 + K + K);
    expect(out[0]).toBeCloseTo((0.5 + K) * norm, 6);
    expect(out[1]).toBeCloseTo((0.25 + K) * norm, 6);
  });
});

describe('helpers', () => {
  it('chooses 8, 6 or 2 output channels from a device maximum', () => {
    expect([1, 2, 4, 6, 7, 8, 32].map(outputChannelsFor)).toEqual([2, 2, 2, 6, 6, 8, 8]);
  });
  it('names FFmpeg channels and layouts', () => {
    expect([0, 3, 9, 10, 31, 35, 999].map(speakerFromAvChannel)).toEqual(['FL', 'LFE', 'SL', 'SR', 'WL', 'LFE2', 'UNKNOWN']);
    expect([['FC'], STEREO, SURROUND_51, SURROUND_71, ['FL', 'FR', 'FC']].map((l) => layoutName(l as ChannelLayout))).toEqual(['mono', 'stereo', '5.1', '7.1', '3.0']);
  });
});
