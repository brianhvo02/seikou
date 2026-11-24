// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BOB_DROP_SHARE, BOB_SETTLE_PICTURES, BOB_WINDOW, copyPlane, FieldBob } from './cpu-bob';
import type { FieldFlags, FieldInput } from './field-input';

interface Made {
  readonly data: Uint8Array;
  readonly init: VideoFrameBufferInit;
}

/** A 4×4 picture whose luma row r is 10·(r+1), chroma rows 100 + j (I420) or the same pairs (NV12). */
function input(flags: Partial<FieldFlags>, format: 'I420' | 'NV12' = 'I420'): FieldInput {
  const w = 4;
  const h = 4;
  const data = new Uint8Array(w * h + 8);
  for (let r = 0; r < h; r++) data.fill(10 * (r + 1), r * w, (r + 1) * w);
  const layout =
    format === 'I420'
      ? [{ offset: 0, stride: w }, { offset: 16, stride: 2 }, { offset: 20, stride: 2 }]
      : [{ offset: 0, stride: w }, { offset: 16, stride: 4 }];
  if (format === 'I420') data.set([100, 100, 102, 102, 200, 200, 204, 204], 16);
  else data.set([100, 200, 100, 200, 102, 204, 102, 204], 16);
  return {
    planes: { format, width: w, height: h, data, layout, matrix: 'bt709' },
    timestampUs: 1_000_000,
    durationUs: 33_367,
    flags: { fieldOrder: null, progressive: false, repeatFirstField: false, ...flags },
    displayWidth: 4,
    displayHeight: 4,
  };
}

function bob(): { bob: FieldBob; made: Made[] } {
  const made: Made[] = [];
  const b = new FieldBob(16_683, (data, init) => {
    made.push({ data: data.slice(), init });
    return { timestamp: init.timestamp } as unknown as VideoFrame;
  });
  return { bob: b, made };
}

const luma = (m: Made): number[] => [0, 4, 8, 12].map((i) => m.data[i]!);

describe('FieldBob', () => {
  it('makes each field of a top-field-first frame whole, a field apart, the other lines interpolated', () => {
    const { bob: b, made } = bob();
    const out = b.pictures(input({ fieldOrder: 'tff' }));
    expect(out).toHaveLength(2);
    expect(made.map((m) => m.init.timestamp)).toEqual([1_000_000, 1_016_683]);
    expect(made.map((m) => m.init.duration)).toEqual([16_683, 16_683]);
    // top field: rows 0 and 2 kept (10, 30); row 1 is their average, row 3 (the edge) its neighbour above
    expect(luma(made[0]!)).toEqual([10, 20, 30, 30]);
    // bottom field: rows 1 and 3 kept (20, 40); row 0 (the edge) the row below, row 2 their average
    expect(luma(made[1]!)).toEqual([20, 20, 30, 40]);
    // chroma rows are per field too: top field keeps row 0 (100), and row 1 takes it
    expect([...made[0]!.data.subarray(16, 20)]).toEqual([100, 100, 100, 100]);
    expect([...made[1]!.data.subarray(16, 20)]).toEqual([102, 102, 102, 102]);
    expect(made[0]!.init).toMatchObject({ format: 'I420', codedWidth: 4, codedHeight: 4, colorSpace: { matrix: 'bt709', fullRange: false } });
  });

  it('shows the bottom field first when the stream says so, and the first field again after a repeat', () => {
    const { bob: b, made } = bob();
    b.pictures(input({ fieldOrder: 'bff' }));
    expect(luma(made[0]!)).toEqual([20, 20, 30, 40]);
    made.length = 0;
    b.pictures(input({ fieldOrder: 'tff', repeatFirstField: true }));
    expect(made.map((m) => m.init.timestamp)).toEqual([1_000_000, 1_016_683, 1_033_366]);
    expect(luma(made[2]!)).toEqual(luma(made[0]!));
  });

  it('shows a frame flagged progressive whole, for its two fields', () => {
    const { bob: b, made } = bob();
    expect(b.pictures(input({ progressive: true }))).toHaveLength(1);
    expect(luma(made[0]!)).toEqual([10, 20, 30, 40]);
    expect(made[0]!.init.duration).toBe(2 * 16_683);
  });

  it('keeps NV12 as NV12, its interleaved chroma rows per field', () => {
    const { bob: b, made } = bob();
    b.pictures(input({ fieldOrder: 'tff' }, 'NV12'));
    expect(made[0]!.init.format).toBe('NV12');
    expect([...made[0]!.data.subarray(16, 24)]).toEqual([100, 200, 100, 200, 100, 200, 100, 200]);
  });
});

/** Pictures the step-down needs to decide: the settling pictures and one full window. */
const DECIDE = BOB_SETTLE_PICTURES + BOB_WINDOW;

/** Reports `n` pictures, each presented or (with probability by pattern) dropped: `dropEvery` drops one in that many. */
function outcomes(b: FieldBob, n: number, dropEvery: number): void {
  for (let i = 0; i < n; i++) {
    if (i % dropEvery === 0) b.notePresentation(0, 1);
    else b.notePresentation(1, 0);
  }
}

describe('FieldBob pacing', () => {
  it('stays at field rate while few of its pictures are dropped (a 50 Hz display drops a sixth of 59.94)', () => {
    const { bob: b } = bob();
    outcomes(b, 4 * DECIDE, 6);
    expect(b.step).toBe('field');
  });

  it('ignores what happens while it settles: the start, and again after settle() (a pause, a seek, the page hidden)', () => {
    const { bob: b } = bob();
    outcomes(b, BOB_SETTLE_PICTURES, 1); // every one dropped while settling
    outcomes(b, BOB_WINDOW, 10);
    expect(b.step).toBe('field');
    outcomes(b, BOB_WINDOW - 1, 1);
    b.settle();
    outcomes(b, BOB_SETTLE_PICTURES, 1);
    outcomes(b, BOB_WINDOW, 10);
    expect(b.step).toBe('field');
  });

  it('steps down to one picture a frame when a window drops more than its share, then to woven frames if that still does', () => {
    const { bob: b, made } = bob();
    expect(BOB_DROP_SHARE).toBeLessThan(1 / 2);
    outcomes(b, DECIDE - 1, 2);
    expect(b.step).toBe('field');
    outcomes(b, 1, 2);
    expect(b.step).toBe('frame');

    // one picture a frame: the first field made whole, shown for the frame's two fields
    expect(b.pictures(input({ fieldOrder: 'bff' }))).toHaveLength(1);
    expect(luma(made[0]!)).toEqual([20, 20, 30, 40]);
    expect(made[0]!.init).toMatchObject({ timestamp: 1_000_000, duration: 2 * 16_683 });
    made.length = 0;
    b.pictures(input({ fieldOrder: 'tff', repeatFirstField: true }));
    expect(made.map((m) => m.init.duration)).toEqual([3 * 16_683]);

    // the pictures queued before the step settle first, then a window at the new step that still drops goes woven
    outcomes(b, DECIDE, 2);
    expect(b.step).toBe('woven');
    made.length = 0;
    b.pictures(input({ fieldOrder: 'tff' }));
    expect(luma(made[0]!)).toEqual([10, 20, 30, 40]);
    expect(made[0]!.init).toMatchObject({ timestamp: 1_000_000, duration: 2 * 16_683 });
  });

  it('stays at one picture a frame when that keeps up', () => {
    const { bob: b } = bob();
    outcomes(b, DECIDE, 2);
    expect(b.step).toBe('frame');
    outcomes(b, 4 * DECIDE, 20);
    expect(b.step).toBe('frame');
  });
});

describe('copyPlane', () => {
  it('rounds the average up at a half, and copies a one-row plane as it is', () => {
    const src = Uint8Array.from([1, 2, 3, 3, 4, 6]); // 3 rows of 2
    const dst = new Uint8Array(6);
    copyPlane(src, 0, 2, dst, 0, 2, 2, 3, 0);
    expect([...dst]).toEqual([1, 2, 3, 4, 4, 6]);
    const one = new Uint8Array(2);
    copyPlane(Uint8Array.from([7, 8]), 0, 2, one, 0, 2, 2, 1, 1);
    expect([...one]).toEqual([7, 8]);
  });
});
