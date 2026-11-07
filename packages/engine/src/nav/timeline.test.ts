import { describe, expect, it } from 'vitest';
import type { PlayItem } from '@seikou/bdmv/mpls-parser';
import { MarkType } from '@seikou/bdmv/mpls-parser';
import { PTS_WRAP } from '../util/time';
import { Timeline } from './timeline';

function item(clipId: string, inTime: number, outTime: number): PlayItem {
  return {
    clipId,
    codecId: 'M2TS',
    connectionCondition: 1,
    stcId: 0,
    inTime,
    outTime,
    uoMask: new Uint8Array(8),
    stillMode: 0,
    stillTime: 0,
    isMultiAngle: false,
    angleCount: 1,
    angleClipIds: [],
    stn: { video: [], audio: [], pg: [], ig: [], pipPg: [], secondaryAudio: [], secondaryVideo: [] },
  };
}

// Item A: 10 s starting at clip time 20 s. Item B: 5 s starting at clip time 10 s.
const timeline = new Timeline([item('A', 900_000, 1_350_000), item('B', 450_000, 675_000)]);

describe('Timeline', () => {
  it('rejects out-of-range play item indexes with a clear error', () => {
    expect(() => timeline.itemStartUs(2)).toThrow(RangeError);
    expect(() => timeline.toPlaylistUs(-1, 0)).toThrow(/play item -1/);
  });

  it('clamps chapter marks to their play item', () => {
    const marks = [
      { type: MarkType.ENTRY, playItemRef: 0, time: 900_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 0, time: 1_400_000, entryEsPid: 0, duration: 0 }, // past item A's out time
    ];
    expect(timeline.chapters(marks)).toEqual([
      { index: 0, startUs: 0 },
      { index: 1, startUs: 10_000_000 },
    ]);
  });

  it('lays play items end to end', () => {
    expect(timeline.durationUs).toBe(15_000_000);
    expect(timeline.items.map((i) => i.start)).toEqual([0, 450_000]);
    expect(timeline.itemStartUs(1)).toBe(10_000_000);
  });

  it('locates playlist times, resolving boundaries to the later item and clamping', () => {
    expect(timeline.locate(0)).toMatchObject({ item: { clipId: 'A' }, clipTime45: 900_000 });
    expect(timeline.locate(9_999_000)).toMatchObject({ item: { clipId: 'A' } });
    expect(timeline.locate(10_000_000)).toMatchObject({ item: { clipId: 'B' }, clipTime45: 450_000 });
    expect(timeline.locate(-5)).toMatchObject({ item: { clipId: 'A' }, clipTime45: 900_000 });
    expect(timeline.locate(99_000_000)).toMatchObject({ item: { clipId: 'B' }, clipTime45: 674_999 });
  });

  it('maps clip PTS to playlist time and flags out-of-range PTS', () => {
    expect(timeline.toPlaylistUs(0, 1_800_000)).toEqual({ us: 0, inRange: true });
    expect(timeline.toPlaylistUs(0, 1_890_000)).toEqual({ us: 1_000_000, inRange: true });
    expect(timeline.toPlaylistUs(0, 2_700_000)).toEqual({ us: 10_000_000, inRange: false });
    expect(timeline.toPlaylistUs(0, 1_710_000)).toEqual({ us: -1_000_000, inRange: false });
    expect(timeline.toPlaylistUs(1, 900_000)).toEqual({ us: 10_000_000, inRange: true });
  });

  it('handles the 33-bit PTS wrap inside a play item', () => {
    const inTime = 0xfffff000; // 45 kHz, so in90 is just below 2^33
    const wrapped = new Timeline([item('W', inTime, inTime + 450_000)]);
    const pts90 = inTime * 2 + 90_000 - PTS_WRAP;
    expect(wrapped.toPlaylistUs(0, pts90)).toEqual({ us: 1_000_000, inRange: true });
  });

  it('derives chapters from entry marks only', () => {
    const marks = [
      { type: MarkType.ENTRY, playItemRef: 0, time: 900_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 0, time: 1_125_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.LINK, playItemRef: 1, time: 500_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 1, time: 450_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 7, time: 0, entryEsPid: 0, duration: 0 },
    ];
    expect(timeline.chapters(marks)).toEqual([
      { index: 0, startUs: 0 },
      { index: 1, startUs: 5_000_000 },
      { index: 2, startUs: 10_000_000 },
    ]);
  });

  it('indexes marks over all marks, entry and link', () => {
    const marks = [
      { type: MarkType.ENTRY, playItemRef: 0, time: 900_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.LINK, playItemRef: 1, time: 540_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 1, time: 450_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 0, time: 0, entryEsPid: 0, duration: 0 },
    ];
    const t = new Timeline([item('A', 900_000, 1_350_000), item('B', 450_000, 675_000)], marks);
    expect(t.markTimeUs(0)).toBe(0);
    expect(t.markTimeUs(1)).toBe(12_000_000); // the link mark counts: index 1, 2 s into item B
    expect(t.markTimeUs(2)).toBe(10_000_000);
    expect(t.markTimeUs(3)).toBe(0); // before the item's IN time: clamped
    expect(() => t.markTimeUs(4)).toThrow(RangeError);
  });
});
