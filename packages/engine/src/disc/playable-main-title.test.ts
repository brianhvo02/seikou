// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { buildMpls } from '../../../../tests/helpers/bdmv-builders';
import { playableMainTitle } from './playable-main-title';

const video = [{ pid: 0x1011, codingType: CodingType.HEVC, format: 8 }];
const pl = (id: string, clips: string[], minutes: number, withVideo = true) => ({
  id,
  mpls: parseMpls(buildMpls({ playItems: clips.map((clipId) => ({ clipId, inTime: 0, outTime: 45_000 * 60 * minutes, ...(withVideo ? { video } : {}) })) })),
});
const files = (...clips: string[]): ((path: string) => boolean) => {
  const present = new Set(clips.flatMap((c) => [`BDMV/CLIPINF/${c}.CLPI`, `BDMV/STREAM/${c}.M2TS`]));
  return (path) => present.has(path);
};

describe('playableMainTitle', () => {
  it('is the main title among playlists whose clips are all on the disc', () => {
    // 00001 is the longest, but its second clip was left out of a main-movie-only copy
    const main = playableMainTitle([pl('00001', ['00001', '00002'], 120), pl('00002', ['00001'], 100)], files('00001'));
    expect(main?.id).toBe('00002');
  });

  it('leaves out playlists without video and names that are not five digits', () => {
    const main = playableMainTitle([pl('00001', ['00001'], 120, false), pl('99', ['00001'], 130), pl('00003', ['00001'], 90)], files('00001'));
    expect(main?.id).toBe('00003');
  });

  it('is null when no playlist can play', () => {
    expect(playableMainTitle([pl('00001', ['00009'], 120)], files('00001'))).toBeNull();
  });
});
