import { describe, expect, it } from 'vitest';
import { endSegment, odsSegment, pdsSegment } from '../../../tests/helpers/ig-builders';
import { ByteReader } from '@seikou/bdmv/byte-reader';
import { SegmentJoiner, decodeObject, decodePalette } from './segments';

describe('decodeObject', () => {
  it('decodes every RLE form and keeps end-of-line elements', () => {
    const rows = [
      [1, 2, 2, 0, 0, 0],
      [7, 7, 7, 7, 7, 7],
    ];
    const [seg] = odsSegment(3, 5, 6, 2, rows);
    const obj = decodeObject(new ByteReader(seg!, 3));
    expect(obj).toMatchObject({ id: 3, version: 5, width: 6, height: 2 });
    expect(obj.img).toEqual([
      { len: 1, color: 1 }, { len: 2, color: 2 }, { len: 3, color: 0 }, { len: 0, color: 0 },
      { len: 6, color: 7 }, { len: 0, color: 0 },
    ]);
  });

  it('decodes 14-bit run lengths', () => {
    const [seg] = odsSegment(1, 0, 200, 1, [new Array<number>(200).fill(9)]);
    expect(decodeObject(new ByteReader(seg!, 3)).img[0]).toEqual({ len: 200, color: 9 });
  });
});

describe('decodePalette', () => {
  it('sets entries by index and leaves the rest zero', () => {
    const p = decodePalette(new ByteReader(pdsSegment(2, 4, [[5, 16, 128, 129, 255], [0, 1, 2, 3, 4]]), 3));
    expect(p).toMatchObject({ id: 2, version: 4 });
    expect(p.entries).toHaveLength(256);
    expect(p.entries[5]).toEqual({ y: 16, cr: 128, cb: 129, t: 255 });
    expect(p.entries[0]).toEqual({ y: 1, cr: 2, cb: 3, t: 4 });
    expect(p.entries[6]).toEqual({ y: 0, cr: 0, cb: 0, t: 0 });
  });

  it('keeps earlier entries when updating', () => {
    const first = decodePalette(new ByteReader(pdsSegment(2, 1, [[5, 16, 128, 129, 255]]), 3));
    const next = decodePalette(new ByteReader(pdsSegment(2, 2, [[6, 1, 1, 1, 1]]), 3), first);
    expect(next.version).toBe(2);
    expect(next.entries[5]).toEqual(first.entries[5]);
    expect(next.entries[6]).toEqual({ y: 1, cr: 1, cb: 1, t: 1 });
  });
});

describe('SegmentJoiner', () => {
  const big = (): number[][] => Array.from({ length: 60 }, (_, y) => Array.from({ length: 100 }, (_, x) => 1 + ((x + y) % 2)));

  it('joins a fragmented object and the result decodes', () => {
    const frags = odsSegment(9, 1, 100, 60, big(), 1000);
    expect(frags.length).toBeGreaterThan(2);
    const joiner = new SegmentJoiner();
    const ready = frags.flatMap((f) => joiner.push(f));
    expect(ready).toHaveLength(1);
    const obj = decodeObject(new ByteReader(ready[0]!, 3));
    expect(obj.width).toBe(100);
    expect(obj.img.reduce((n, e) => n + e.len, 0)).toBe(6000);
  });

  it('releases a stranded head when something else arrives', () => {
    const joiner = new SegmentJoiner();
    const frags = odsSegment(9, 1, 100, 60, big(), 1000);
    expect(joiner.push(frags[0]!)).toEqual([]);
    const end = endSegment();
    const out = joiner.push(end);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(end);
    expect(() => decodeObject(new ByteReader(out[0]!, 3))).toThrow('not last');
  });
});
