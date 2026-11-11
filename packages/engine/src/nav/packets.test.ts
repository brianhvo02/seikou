import { describe, expect, it } from 'vitest';
import type { Clpi } from '@seikou/bdmv/clpi-parser';
import type { PlayItem, PlayListMark } from '@seikou/bdmv/mpls-parser';
import { itemPackets, markTitlePkt, nextPlaymark } from './packets';

const IN = 524_280;
/** A clip whose first EP map entry is packet 4 (at the IN time), as BDJ_DISC_B's playlists 00800 and 01495 are. */
const clip: Clpi = {
  version: '0200',
  numSourcePackets: 1000,
  recordingRate: 0,
  atcSequences: [],
  programs: [],
  epMaps: [{ pid: 0x1011, epStreamType: 1, entries: [{ pts: IN, spn: 4 }, { pts: IN + 45_000, spn: 200 }, { pts: IN + 90_000, spn: 400 }] }],
};
const clips = new Map([['00001', clip]]);
const item = { clipId: '00001', inTime: IN, outTime: IN + 135_000, connectionCondition: 1 } as PlayItem;
const mark = (time: number): PlayListMark => ({ type: 1, playItemRef: 0, time, entryEsPid: 0xffff, duration: 0 });

describe('play marks in packets (_fill_mark, _find_next_playmark)', () => {
  it("puts a mark at the first item's IN time at its EP map packet, past the item's start_pkt 0", () => {
    expect(itemPackets([item], clips)[0]!.startPkt).toBe(0);
    expect(markTitlePkt(mark(IN), itemPackets([item], clips), [item], clips)).toBe(4);
  });

  it('a playlist opened at its start still has that mark ahead, so the first read reaches it (BDJ MARK 0)', () => {
    expect(nextPlaymark(0, [mark(IN), mark(IN + 45_000)], [item], clips)).toBe(0);
  });

  it('after a seek to a mark, the next mark is the one after its packet', () => {
    expect(nextPlaymark(200, [mark(IN), mark(IN + 45_000), mark(IN + 90_000)], [item], clips)).toBe(2);
    expect(nextPlaymark(400, [mark(IN), mark(IN + 45_000), mark(IN + 90_000)], [item], clips)).toBe(-1);
  });
});
