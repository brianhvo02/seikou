// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import { audioChannels, audioRate, videoFormat, videoRate } from '../../src/disc/stream-codes';

it('maps Blu-ray rate and format codes', () => {
  expect(videoRate(1)).toEqual({ fpsNum: 24000, fpsDen: 1001 });
  expect(videoFormat(6)).toEqual({ width: 1920, height: 1080, interlaced: false });
  expect(audioRate(1)).toBe(48000);
  expect(audioChannels(3)).toBe(2);
  expect(() => videoRate(5)).toThrow();
});

it('flags interlaced formats and rejects unknown codes', () => {
  expect(videoFormat(4)).toEqual({ width: 1920, height: 1080, interlaced: true });
  expect(videoFormat(1).interlaced).toBe(true);
  expect(videoFormat(2).interlaced).toBe(true);
  expect(videoFormat(8)).toEqual({ width: 3840, height: 2160, interlaced: false });
  expect(() => videoFormat(0)).toThrow();
  expect(() => audioRate(2)).toThrow();
  expect(() => audioChannels(2)).toThrow();
});
