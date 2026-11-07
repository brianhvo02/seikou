import { describe, expect, it } from 'vitest';
import { endSegment, odsSegment, pcsSegment, pdsSegment, subtitleSegments, clearSegments, wdsSegment } from '../test/pg-builders';
import { compositionObjectOp } from './composition';
import { OverlayPlane, type OverlayOp } from './overlay-plane';
import { PgSegmentDecoder, type PgDisplaySet } from './pg-decoder';
import { PgRenderer } from './pg-renderer';

function setup(display: boolean) {
  const flag = display;
  const ops: OverlayOp[] = [];
  const plane = new OverlayPlane(1920, 1080, { buffered: true });
  const r = new PgRenderer({ displayFlag: () => flag, onOverlay: (op) => { ops.push(op); plane.apply(op); } });
  const empty = new OverlayPlane(1920, 1080).hash();
  return { ops, plane, r, empty };
}

const decoder = new PgSegmentDecoder();
function set(segs: Uint8Array[], pts = 90_000, d = decoder): PgDisplaySet {
  let out: PgDisplaySet | null = null;
  for (const s of segs) out = d.push(s, pts, null) ?? out;
  return out!;
}

describe('PgRenderer', () => {
  it('draws a display set, flushes at the PCS PTS and queues the clear', () => {
    const { ops, plane, r, empty } = setup(true);
    expect(r.render(set(subtitleSegments({ x: 100, y: 900, w: 16, h: 8 }), 450_000))).toBe(1);
    expect(ops.map((o) => o.cmd)).toEqual(['init', 'draw', 'flush', 'wipe', 'hide']);
    expect(ops[1]).toMatchObject({ x: 100, y: 900, w: 16, h: 8, pts: 450_000 });
    expect(ops[2]!.pts).toBe(450_000);
    expect(ops[3]).toMatchObject({ pts: -1, x: 100, y: 900, w: 16, h: 8 });
    expect(plane.hash()).not.toBe(empty);
    expect(plane.rgba({ x: 100, y: 900, w: 1, h: 1 })[3]).toBe(255);

    ops.length = 0;
    r.render(set(subtitleSegments({ x: 200, y: 800 }), 500_000));
    expect(ops.map((o) => o.cmd)).toEqual(['draw', 'flush', 'wipe', 'hide']); // init only the first time
  });

  it('with the display flag off draws only forced objects, and an empty set clears them', () => {
    const { plane, r, empty } = setup(false);
    const d = new PgSegmentDecoder();
    const ds = set([
      pcsSegment({ compositionState: 'epochStart', paletteId: 0, objects: [
        { objectId: 1, windowId: 0, x: 10, y: 10, forced: true },
        { objectId: 2, windowId: 0, x: 100, y: 10 },
      ] }),
      wdsSegment([[0, 0, 0, 200, 40]]),
      pdsSegment(0, 0, [[1, 235, 128, 128, 255]]),
      ...odsSegment(1, 0, 8, 4, Array.from({ length: 4 }, () => new Array<number>(8).fill(1))),
      ...odsSegment(2, 0, 8, 4, Array.from({ length: 4 }, () => new Array<number>(8).fill(1))),
      endSegment(),
    ], 90_000, d);
    expect(r.render(ds)).toBe(1);
    expect(r.lastForced).toBe(1);
    expect(plane.rgba({ x: 10, y: 10, w: 1, h: 1 })[3]).toBe(255);
    expect(plane.rgba({ x: 100, y: 10, w: 1, h: 1 })[3]).toBe(0);

    expect(r.render(set(clearSegments(1), 180_000, d))).toBe(0);
    expect(plane.hash()).toBe(empty);
  });

  it('draws only the crop rectangle of a cropped object', () => {
    const { ops, r } = setup(true);
    const d = new PgSegmentDecoder();
    const rows = Array.from({ length: 4 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x < 4 ? 1 : 2) + (y >= 2 ? 2 : 0)));
    const ds = set([
      pcsSegment({ compositionState: 'epochStart', paletteId: 0, objects: [
        { objectId: 1, windowId: 0, x: 50, y: 60, crop: { x: 4, y: 2, w: 4, h: 2 } },
      ] }),
      wdsSegment([[0, 50, 60, 8, 4]]),
      pdsSegment(0, 0, [[1, 235, 128, 128, 255], [2, 16, 128, 128, 255], [3, 100, 128, 128, 255], [4, 50, 128, 128, 255]]),
      ...odsSegment(1, 0, 8, 4, rows),
      endSegment(),
    ], 90_000, d);
    r.render(ds);
    const draw = ops.find((o) => o.cmd === 'draw')!;
    const cobj = ds.composition.compositionObjects[0]!;
    expect(draw).toEqual(compositionObjectOp(90_000, cobj, ds.objects.get(1)!, ds.palettes.get(0)!, false));
    expect(draw).toMatchObject({ x: 50, y: 60, w: 4, h: 2 });
  });

  it('draws nothing for an unknown palette and skips an unknown object', () => {
    const { ops, r } = setup(true);
    const d = new PgSegmentDecoder();
    const noPalette = set([
      pcsSegment({ compositionState: 'epochStart', paletteId: 7, objects: [{ objectId: 0, windowId: 0, x: 0, y: 0 }] }),
      ...odsSegment(0, 0, 4, 4, Array.from({ length: 4 }, () => new Array<number>(4).fill(1))),
      endSegment(),
    ], 90_000, d);
    expect(() => r.render(noPalette)).not.toThrow();
    expect(ops).toEqual([]);

    const missing = set([
      pcsSegment({ compositionState: 'acquisition', paletteId: 0, objects: [
        { objectId: 9, windowId: 0, x: 0, y: 0 },
        { objectId: 0, windowId: 0, x: 20, y: 20 },
      ] }),
      pdsSegment(0, 0, [[1, 235, 128, 128, 255]]),
      endSegment(),
    ], 180_000, d);
    expect(r.render(missing)).toBe(1);
    expect(ops.filter((o) => o.cmd === 'draw')).toHaveLength(1);
    expect(ops.filter((o) => o.cmd === 'wipe')).toHaveLength(1);
  });

  it('reset closes the overlay and empties the plane', () => {
    const { ops, plane, r, empty } = setup(true);
    r.render(set(subtitleSegments({})));
    ops.length = 0;
    r.reset();
    expect(ops.map((o) => o.cmd)).toEqual(['close']);
    expect(plane.hash()).toBe(empty);
    r.reset();
    expect(ops).toHaveLength(1); // closed already
  });
});
