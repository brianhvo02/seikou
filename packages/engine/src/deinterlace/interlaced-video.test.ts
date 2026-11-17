// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { FrameMetrics, PictureOp } from './cadence';
import type { DeinterlaceBackend, Picture } from './deinterlacer';
import type { FieldInput } from './field-input';
import { InterlacedVideo } from './interlaced-video';

const FRAME_US = 1_001_000 / 30;
const COMBED: FrameMetrics = { combWoven: 0.2, combMatchPrev: 0.2, combMatchNext: 0.2, diffPrev: 0.1, motionTff: 0, motionBff: 0 };

function setup(opts: { ringSize?: number; noBackend?: boolean } = {}) {
  const made: Array<[number, number]> = [];
  const uploads: number[] = [];
  const ops: PictureOp[] = [];
  let disposed = 0;
  const bitmaps: Array<{ closed: boolean }> = [];
  const canvas = {
    width: 8,
    height: 8,
    transferToImageBitmap: () => {
      const b = { width: 8, height: 8, closed: false, close: () => void (b.closed = true) };
      bitmaps.push(b);
      return b;
    },
  } as unknown as OffscreenCanvas;
  const backend: DeinterlaceBackend = {
    upload: (_slot, planes) => {
      uploads.push(planes.data[0]!);
    },
    measure: async () => COMBED,
    render: (op) => {
      ops.push(op);
      return canvas;
    },
    gpuMs: null,
    dispose: () => {
      disposed++;
    },
  };
  const pictures: Picture[] = [];
  const video = new InterlacedVideo({
    createBackend: (w, h) => {
      made.push([w, h]);
      return opts.noBackend ? null : backend;
    },
    ringSize: opts.ringSize ?? 12,
    onPictures: (p) => pictures.push(...p),
  });
  return { video, made, uploads, ops, pictures, bitmaps, disposed: () => disposed };
}

/** A frame whose planes buffer is shared, as the decoder's is: the video must copy what it keeps. */
const shared = new Uint8Array(1);
function input(i: number): FieldInput {
  shared[0] = i;
  return {
    planes: { format: 'I420', width: 8, height: 8, data: shared, layout: [], matrix: 'bt709' },
    timestampUs: i * FRAME_US,
    durationUs: FRAME_US,
    flags: { fieldOrder: 'tff', progressive: false, repeatFirstField: false },
    displayWidth: 16,
    displayHeight: 9,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('InterlacedVideo', () => {
  it('keeps the backend for a session of the same size, and makes a new one for another size', () => {
    const t = setup();
    expect(t.video.start(8, 8, FRAME_US)).toBe(true);
    expect(t.video.start(8, 8, FRAME_US)).toBe(true);
    expect(t.made).toEqual([[8, 8]]);
    expect(t.video.start(16, 8, FRAME_US)).toBe(true);
    expect(t.made).toEqual([[8, 8], [16, 8]]);
    expect(t.disposed()).toBe(1);
  });

  it('says false without a backend (no WebGL2)', () => {
    const t = setup({ noBackend: true });
    expect(t.video.start(8, 8, FRAME_US)).toBe(false);
    expect(t.video.freeSlots()).toBe(0);
    expect(t.video.push(input(0))).toBe(false);
  });

  it('parks a frame with no free slot, and a flush asked after it waits for it (a seek drops both)', async () => {
    const t = setup({ ringSize: 2 });
    t.video.start(8, 8, FRAME_US);
    t.video.push(input(0));
    t.video.push(input(1));
    expect(t.video.push(input(2))).toBe(true); // parked
    expect(t.video.freeSlots()).toBe(0);
    let flushed = false;
    void t.video.flush().then(() => {
      flushed = true;
    });
    t.video.pump();
    await settle();
    expect(t.uploads).toEqual([0, 1]);
    expect(flushed).toBe(false);
    t.video.reset();
    await settle();
    expect(flushed).toBe(true);
    expect(t.video.freeSlots()).toBe(2);
    t.video.pump();
    expect(t.uploads).toEqual([0, 1]);
  });

  it('pushes a parked frame with the bytes it had when it was parked', async () => {
    const t = setup({ ringSize: 1 });
    t.video.start(8, 8, FRAME_US);
    t.video.push(input(7));
    await t.video.flush();
    // the flush planned frame 7: its pictures hold its slot until they close
    expect(t.pictures.length).toBeGreaterThan(0);
    t.video.push(input(8)); // parked
    shared[0] = 99;
    t.video.pump();
    expect(t.uploads).toEqual([7]);
    for (const p of t.pictures) p.close();
    t.video.pump();
    expect(t.uploads).toEqual([7, 8]);
  });

  it('draws a still as a whole frame and reuses the image for the same picture', async () => {
    const t = setup();
    t.video.start(8, 8, FRAME_US);
    for (let i = 0; i < 4; i++) t.video.push(input(i));
    await t.video.flush();
    const p = t.pictures.find((x) => t.video.owns(x))!;
    const moving = t.video.render(p, false)!;
    expect(t.ops.at(-1)!.kind).toBe('interpolate');
    expect(moving).toMatchObject({ displayWidth: 16, displayHeight: 9 });
    expect(t.video.render(p, false)).toBe(moving);
    expect(t.ops).toHaveLength(1);
    const still = t.video.render(p, true)!;
    expect(t.ops.at(-1)!.kind).toBe('weave');
    expect(still.key).not.toBe(moving.key);
  });

  it('hands the compositor each drawn picture as an ImageBitmap, closing the one before when the next is drawn', async () => {
    // WebKit copies a WebGL canvas drawn into a 2D canvas at ~15 ms a 1080 picture (iPhone 17 Pro); a bitmap avoids it
    const t = setup();
    t.video.start(8, 8, FRAME_US);
    for (let i = 0; i < 4; i++) t.video.push(input(i));
    await t.video.flush();
    const [a, b] = t.pictures.filter((x) => t.video.owns(x));
    const first = t.video.render(a!, false)!;
    expect(first.image).toBe(t.bitmaps[0]);
    expect(t.video.render(a!, false)!.image).toBe(t.bitmaps[0]);
    expect(t.bitmaps).toHaveLength(1);
    const second = t.video.render(b!, false)!;
    expect(second.image).toBe(t.bitmaps[1]);
    expect(t.bitmaps.map((x) => x.closed)).toEqual([true, false]);
    t.video.dispose();
    expect(t.bitmaps.map((x) => x.closed)).toEqual([true, true]);
  });
});
