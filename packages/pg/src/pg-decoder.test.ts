import { describe, expect, it } from 'vitest';
import {
  clearSegments, endSegment, odsSegment, pcsSegment, pdsSegment, subtitleSegments, wdsSegment,
} from '../test/pg-builders';
import { PgSegmentDecoder, type PgDisplaySet } from './pg-decoder';

function feed(d: PgSegmentDecoder, segs: Uint8Array[], pts = 1000, dts: number | null = null): PgDisplaySet[] {
  const out: PgDisplaySet[] = [];
  for (const s of segs) {
    const set = d.push(s, pts, dts);
    if (set) out.push(set);
  }
  return out;
}

const rows = (w: number, h: number, c = 1): number[][] => Array.from({ length: h }, () => new Array<number>(w).fill(c));

describe('PgSegmentDecoder', () => {
  it('round-trips a composition, windows, a palette and objects', () => {
    const d = new PgSegmentDecoder();
    const segs = [
      pcsSegment({
        width: 1280, height: 720, frameRateCode: 3, compositionNumber: 9, compositionState: 'epochStart',
        paletteUpdate: true, paletteId: 2,
        objects: [
          { objectId: 1, windowId: 0, x: 10, y: 20, forced: true },
          { objectId: 2, windowId: 1, x: 30, y: 40, crop: { x: 1, y: 2, w: 3, h: 4 } },
        ],
      }),
      wdsSegment([[0, 10, 20, 8, 4], [1, 30, 40, 6, 6]]),
      pdsSegment(2, 5, [[1, 100, 110, 120, 130]]),
      ...odsSegment(1, 0, 8, 4, rows(8, 4)),
      ...odsSegment(2, 1, 6, 6, rows(6, 6, 1)),
      endSegment(),
    ];
    const sets = feed(d, segs, 4242, 4000);
    expect(sets).toHaveLength(1);
    const s = sets[0]!;
    expect(s).toMatchObject({ pts: 4242, dts: 4000, epochStart: true });
    expect(s.composition).toMatchObject({
      videoDescriptor: { width: 1280, height: 720, frameRate: 3 },
      compositionDescriptor: { number: 9, state: 2 },
      paletteUpdateFlag: true,
      paletteIdRef: 2,
      pts: 4242,
    });
    expect(s.composition.compositionObjects).toEqual([
      { objectId: 1, windowId: 0, cropFlag: false, forcedOnFlag: true, x: 10, y: 20, cropX: 0, cropY: 0, cropW: 0, cropH: 0 },
      { objectId: 2, windowId: 1, cropFlag: true, forcedOnFlag: false, x: 30, y: 40, cropX: 1, cropY: 2, cropW: 3, cropH: 4 },
    ]);
    expect(s.windows).toEqual([{ id: 0, x: 10, y: 20, width: 8, height: 4 }, { id: 1, x: 30, y: 40, width: 6, height: 6 }]);
    expect(s.palettes.get(2)).toMatchObject({ id: 2, version: 5 });
    expect(s.palettes.get(2)!.entries[1]).toEqual({ y: 100, cr: 110, cb: 120, t: 130 });
    expect([...s.objects.keys()].sort()).toEqual([1, 2]);
    expect(s.objects.get(2)).toMatchObject({ id: 2, version: 1, width: 6, height: 6 });
  });

  it('completes a display set only at END; later segments start a new set', () => {
    const d = new PgSegmentDecoder();
    const segs = subtitleSegments({});
    for (const seg of segs.slice(0, -1)) expect(d.push(seg, 1000, null)).toBeNull();
    expect(d.push(segs.at(-1)!, 1000, null)).not.toBeNull();
    const next = clearSegments(1);
    expect(d.push(next[0]!, 2000, null)).toBeNull();
    expect(d.push(next[1]!, 2000, null)).toBeNull();
    const set = d.push(next[2]!, 2000, null)!;
    expect(set.pts).toBe(2000);
    expect(set.composition.compositionObjects).toEqual([]);
  });

  it('drops the epoch at an epoch start, keeps it at an acquisition point, and flags normal sets as not epoch starts', () => {
    const d = new PgSegmentDecoder();
    const first = feed(d, subtitleSegments({ objectId: 1 }))[0]!;
    expect(first.epochStart).toBe(true);

    const acq = feed(d, [
      pcsSegment({ compositionState: 'acquisition', paletteId: 0, objects: [{ objectId: 2, windowId: 0, x: 0, y: 0 }] }),
      pdsSegment(0, 1, [[2, 1, 2, 3, 4]]),
      ...odsSegment(2, 0, 4, 4, rows(4, 4)),
      endSegment(),
    ])[0]!;
    expect(acq.epochStart).toBe(false);
    expect([...acq.objects.keys()].sort()).toEqual([1, 2]);
    expect(acq.palettes.get(0)!.version).toBe(1);

    const epoch = feed(d, subtitleSegments({ objectId: 3 }))[0]!;
    expect([...epoch.objects.keys()]).toEqual([3]);

    const fresh = new PgSegmentDecoder();
    const normal = feed(fresh, [pcsSegment({ compositionState: 'normal', paletteId: 0, objects: [] }), endSegment()])[0]!;
    expect(normal.epochStart).toBe(false);
  });

  it('joins an ODS split over three segments', () => {
    const d = new PgSegmentDecoder();
    const ods = odsSegment(1, 0, 20, 4, [[1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2], ...rows(20, 3, 3)], 24);
    expect(ods.length).toBe(3);
    const set = feed(d, [
      pcsSegment({ compositionState: 'epochStart', paletteId: 0, objects: [{ objectId: 1, windowId: 0, x: 0, y: 0 }] }),
      pdsSegment(0, 0, []),
      ...ods,
      endSegment(),
    ])[0]!;
    expect(set.objects.get(1)).toMatchObject({ width: 20, height: 4 });
    expect(d.errors).toBe(0);
  });

  it('counts a truncated PCS as an error and decodes the next good set', () => {
    const d = new PgSegmentDecoder();
    const bad = subtitleSegments({});
    bad[0] = bad[0]!.subarray(0, bad[0]!.length - 3);
    expect(feed(d, bad)).toEqual([]);
    expect(d.errors).toBeGreaterThanOrEqual(1);
    expect(feed(d, subtitleSegments({}))).toHaveLength(1);
  });

  it('discardPartial drops a half-received set; reset forgets the epoch', () => {
    const d = new PgSegmentDecoder();
    feed(d, subtitleSegments({ objectId: 1 }));
    const partial = subtitleSegments({ objectId: 2, state: 'acquisition' });
    feed(d, partial.slice(0, 1));
    d.discardPartial();
    expect(feed(d, partial.slice(1))).toEqual([]);
    const next = feed(d, [pcsSegment({ compositionState: 'normal', paletteId: 0, objects: [] }), endSegment()])[0]!;
    expect([...next.objects.keys()]).toEqual([1]);

    d.reset();
    const after = feed(d, [pcsSegment({ compositionState: 'normal', paletteId: 0, objects: [] }), endSegment()])[0]!;
    expect(after.objects.size).toBe(0);
  });
});
