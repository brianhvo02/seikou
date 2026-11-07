import { describe, expect, it } from 'vitest';
import { buildMpls, type MarkSpec, type PlayItemSpec, type StreamSpec } from '../../../../tests/helpers/bdmv-builders';
import { parseMpls, type Mpls } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { chooseMainTitle, hasRepeatedSegments, samePlaylist } from './main-title';

const MIN = 60 * 45_000; // one minute in 45 kHz ticks
const AVC_1080P: StreamSpec = { pid: 0x1011, codingType: CodingType.AVC, format: 6 };
const HEVC_2160P: StreamSpec = { pid: 0x1011, codingType: CodingType.HEVC, format: 8 };
const AC3: StreamSpec = { pid: 0x1100, codingType: CodingType.AC3 };
const TRUEHD: StreamSpec = { pid: 0x1100, codingType: CodingType.TRUEHD };

interface Spec {
  minutes: number;
  chapters?: number;
  video?: StreamSpec;
  audio?: StreamSpec[];
  pg?: number;
  clipId?: string;
}

/** One play item of `minutes`, `chapters` entry marks. */
function pl({ minutes, chapters = 0, video = AVC_1080P, audio = [AC3], pg = 0, clipId = '00001' }: Spec): Mpls {
  const item: PlayItemSpec = {
    clipId,
    inTime: 0,
    outTime: minutes * MIN,
    video: [video],
    audio: audio.map((a, i) => ({ ...a, pid: 0x1100 + i })),
    pg: Array.from({ length: pg }, (_, i) => ({ pid: 0x1200 + i, codingType: CodingType.PG })),
  };
  const marks: MarkSpec[] = Array.from({ length: chapters }, (_, i) => ({ playItemRef: 0, time: Math.floor((i * minutes * MIN) / Math.max(1, chapters)) }));
  return parseMpls(buildMpls({ playItems: [item], marks }));
}

/** A maze playlist: the same few-second segment played `times` times. */
function loop(times: number, clipId = '00009'): Mpls {
  const playItems = Array.from({ length: times }, () => ({ clipId, inTime: 0, outTime: 2 * 45_000, video: [AVC_1080P], audio: [AC3] }));
  return parseMpls(buildMpls({ playItems }));
}

const pick = (entries: Record<string, Mpls>): string | null => chooseMainTitle(Object.entries(entries).map(([id, mpls]) => ({ id, mpls })));

describe('hasRepeatedSegments (libbluray _filter_repeats)', () => {
  it('flags a playlist that plays the same segment more than twice', () => {
    expect(hasRepeatedSegments(loop(3))).toBe(true);
    expect(hasRepeatedSegments(loop(2))).toBe(false);
    expect(hasRepeatedSegments(pl({ minutes: 120 }))).toBe(false);
  });
});

describe('samePlaylist (libbluray _pl_cmp)', () => {
  it('matches identical playlists and tells apart ones with different streams or times', () => {
    expect(samePlaylist(pl({ minutes: 100, chapters: 10 }), pl({ minutes: 100, chapters: 10 }))).toBe(true);
    expect(samePlaylist(pl({ minutes: 100 }), pl({ minutes: 100, audio: [AC3, AC3] }))).toBe(false);
    expect(samePlaylist(pl({ minutes: 100 }), pl({ minutes: 101 }))).toBe(false);
  });
});

describe('chooseMainTitle (libbluray _pl_guess_main_title)', () => {
  it('ignores a long maze playlist and picks the real feature', () => {
    expect(pick({ '00149': loop(300), '00800': pl({ minutes: 110, chapters: 25 }) })).toBe('00800');
  });

  it('prefers chapters over none when both are over 30 minutes and the counts differ by more than 5', () => {
    expect(pick({ '00001': pl({ minutes: 120, chapters: 0 }), '00002': pl({ minutes: 100, chapters: 20 }) })).toBe('00002');
    // a small difference falls through to duration
    expect(pick({ '00001': pl({ minutes: 120, chapters: 1 }), '00002': pl({ minutes: 100, chapters: 5 }) })).toBe('00001');
  });

  it('prefers UHD over FHD, then HEVC over AVC, when both are over 30 minutes', () => {
    expect(pick({ '00001': pl({ minutes: 120 }), '00002': pl({ minutes: 100, video: HEVC_2160P }) })).toBe('00002');
    expect(pick({ '00001': pl({ minutes: 120 }), '00002': pl({ minutes: 100, video: { ...AVC_1080P, codingType: CodingType.HEVC } }) })).toBe('00002');
  });

  it('prefers HD audio (judged by coding type) when both are over 30 minutes', () => {
    expect(pick({ '00001': pl({ minutes: 120, audio: [AC3] }), '00002': pl({ minutes: 100, audio: [TRUEHD] }) })).toBe('00002');
  });

  it('decides by duration below 30 minutes, ignoring chapters and video', () => {
    expect(pick({ '00001': pl({ minutes: 20 }), '00002': pl({ minutes: 10, chapters: 20, video: HEVC_2160P }) })).toBe('00001');
  });

  it('breaks a duration tie by stream count (audio × 2 + PG), then by the lower playlist number', () => {
    expect(pick({ '00800': pl({ minutes: 110, audio: [AC3] }), '00805': pl({ minutes: 110, audio: [AC3], pg: 3 }) })).toBe('00805');
    expect(pick({ '00800': pl({ minutes: 110, clipId: '00001' }), '01491': pl({ minutes: 110, clipId: '00002' }) })).toBe('00800');
  });

  it('keeps the first of exact duplicates', () => {
    expect(pick({ '00040': pl({ minutes: 124 }), '00801': pl({ minutes: 124 }) })).toBe('00040');
  });

  it('falls back to the longest playlist when every candidate loops, and returns null for none', () => {
    expect(pick({ '00001': loop(10), '00002': loop(40, '00008') })).toBe('00002');
    expect(pick({})).toBeNull();
  });
});
