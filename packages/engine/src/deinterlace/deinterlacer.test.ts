// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { LOOKAHEAD, type FrameMetrics, type PictureOp } from './cadence';
import { Deinterlacer, type DeinterlaceBackend, type Picture } from './deinterlacer';
import type { FieldFlags, FieldInput, YuvPlanes } from './field-input';

const FRAME_US = 1_001_000 / 30;
const COMBED: FrameMetrics = { combWoven: 0.2, combMatchPrev: 0.2, combMatchNext: 0.2, diffPrev: 0.1, motionTff: 0, motionBff: 0 };
const CLEAN: FrameMetrics = { combWoven: 0, combMatchPrev: 0, combMatchNext: 0, diffPrev: 0.1, motionTff: 0, motionBff: 0 };
const TFF: FieldFlags = { fieldOrder: 'tff', progressive: false, repeatFirstField: false };

interface Slots {
  readonly prev: number | null;
  readonly cur: number;
  readonly next: number | null;
}

interface Measure extends Slots {
  readonly fieldOrder: 'tff' | 'bff';
  resolve(m: FrameMetrics): void;
}

/** A backend that records every call; measurements answer `metrics` at once unless `deferred` is set. */
function fakeBackend(opts: { deferred?: boolean; metrics?: FrameMetrics } = {}) {
  const uploads: Array<{ slot: number; planes: YuvPlanes }> = [];
  const measures: Measure[] = [];
  const renders: Array<{ op: PictureOp; slots: Slots; fieldOrder: 'tff' | 'bff'; matrix: YuvPlanes['matrix'] }> = [];
  const canvas = { sentinel: 'canvas' } as unknown as OffscreenCanvas;
  let disposed = false;
  const backend: DeinterlaceBackend = {
    upload(slot, planes) {
      uploads.push({ slot, planes });
    },
    measure(prev, cur, next, fieldOrder) {
      return new Promise<FrameMetrics>((resolve) => {
        measures.push({ prev, cur, next, fieldOrder, resolve });
        if (!opts.deferred) resolve(opts.metrics ?? COMBED);
      });
    },
    render(op, slots, fieldOrder, matrix) {
      renders.push({ op, slots: { ...slots }, fieldOrder, matrix });
      return canvas;
    },
    gpuMs: 0.5,
    dispose() {
      disposed = true;
    },
  };
  return { backend, uploads, measures, renders, canvas, disposed: () => disposed };
}

function planes(tag: number): YuvPlanes {
  return { format: 'I420', width: 8, height: 8, data: new Uint8Array([tag]), layout: [], matrix: 'bt709' };
}

function input(i: number, flags: FieldFlags = TFF): FieldInput {
  return { planes: planes(i), timestampUs: i * FRAME_US, durationUs: FRAME_US, flags };
}

function setup(opts: { deferred?: boolean; metrics?: FrameMetrics; ringSize?: number } = {}) {
  const fake = fakeBackend(opts);
  const pictures: Picture[] = [];
  const d = new Deinterlacer({
    backend: fake.backend,
    ringSize: opts.ringSize ?? 12,
    frameDurationUs: FRAME_US,
    onPictures: (p) => pictures.push(...p),
  });
  return { ...fake, d, pictures };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The slots a picture reads, as its render reports them. */
function slotsOf(t: ReturnType<typeof setup>, p: Picture): Slots {
  t.d.render(p);
  return t.renders.at(-1)!.slots;
}

describe('Deinterlacer', () => {
  it('pictures come out in timestamp order, two fields a frame for video, with nominal durations', async () => {
    const t = setup({ ringSize: 30 });
    for (let i = 0; i < 12; i++) t.d.push(input(i));
    await settle();
    t.d.flush();
    await settle();
    expect(t.pictures).toHaveLength(24);
    const times = t.pictures.map((p) => p.timestamp);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(FRAME_US / 2);
    expect(t.pictures[0]!.duration).toBeCloseTo(FRAME_US / 2);
  });

  it('measures each frame once its next frame is in, against its neighbours and the detector\'s field order', async () => {
    const t = setup();
    t.d.push(input(0));
    expect(t.measures).toHaveLength(0);
    t.d.push(input(1));
    t.d.push(input(2));
    expect(t.measures.map(({ prev, cur, next, fieldOrder }) => ({ prev, cur, next, fieldOrder }))).toEqual([
      { prev: null, cur: t.uploads[0]!.slot, next: t.uploads[1]!.slot, fieldOrder: 'tff' },
      { prev: t.uploads[0]!.slot, cur: t.uploads[1]!.slot, next: t.uploads[2]!.slot, fieldOrder: 'tff' },
    ]);
    t.d.flush();
    expect(t.measures.at(-1)).toMatchObject({ prev: t.uploads[1]!.slot, cur: t.uploads[2]!.slot, next: null });
  });

  it('plans only in frame order, whatever order the measurements come back in', async () => {
    const t = setup({ deferred: true });
    for (let i = 0; i < LOOKAHEAD + 3; i++) t.d.push(input(i));
    // The later measurements come back first: nothing can be planned before the first one is in.
    for (let i = t.measures.length - 1; i >= 1; i--) t.measures[i]!.resolve(COMBED);
    await settle();
    expect(t.pictures).toHaveLength(0);
    t.measures[0]!.resolve(COMBED);
    await settle();
    expect(t.pictures.length).toBeGreaterThan(0);
    expect(t.pictures[0]!.timestamp).toBe(0);
  });

  it('render passes the picture\'s op, its frame\'s slot and its neighbours\' slots', async () => {
    const t = setup({ ringSize: 30 });
    for (let i = 0; i < 12; i++) t.d.push(input(i));
    await settle();
    const slotOf = (i: number): number => t.uploads[i]!.slot;
    const [first, second, third] = t.pictures;
    expect(t.d.render(first!)).toBe(t.canvas);
    expect(t.renders.at(-1)).toEqual({ op: { kind: 'interpolate', field: 'top' }, slots: { prev: null, cur: slotOf(0), next: slotOf(1) }, fieldOrder: 'tff', matrix: 'bt709' });
    t.d.render(second!);
    expect(t.renders.at(-1)!.op).toEqual({ kind: 'interpolate', field: 'bottom' });
    t.d.render(third!);
    expect(t.renders.at(-1)!.slots).toEqual({ prev: slotOf(0), cur: slotOf(1), next: slotOf(2) });
  });

  it('a bottom-field-first frame interpolates in its own order', async () => {
    const bff: FieldFlags = { fieldOrder: 'bff', progressive: false, repeatFirstField: false };
    const t = setup({ ringSize: 30 });
    for (let i = 0; i < 12; i++) t.d.push(input(i, bff));
    await settle();
    t.d.render(t.pictures[0]!);
    expect(t.renders.at(-1)).toMatchObject({ op: { kind: 'interpolate', field: 'bottom' }, fieldOrder: 'bff' });
  });

  it('freeSlots drops as frames arrive and recovers as pictures close', async () => {
    const t = setup({ ringSize: 12 });
    expect(t.d.freeSlots()).toBe(12);
    t.d.push(input(0));
    expect(t.d.freeSlots()).toBe(11);
    t.d.push(input(1));
    expect(t.d.freeSlots()).toBe(10);
    for (let i = 2; i < 10; i++) t.d.push(input(i));
    await settle();
    // Pictures hold their frames: nothing has been closed, so the ring keeps every frame a picture refers to.
    const held = t.d.freeSlots();
    expect(held).toBe(2);
    for (const p of t.pictures) p.close();
    // Only the frames the detector still needs (its lookahead and the previous neighbour) hold slots now.
    expect(t.d.freeSlots()).toBeGreaterThan(held);
    expect(t.d.freeSlots()).toBe(12 - (LOOKAHEAD + 2));
    t.pictures[0]!.close(); // closing twice gives nothing back twice
    expect(t.d.freeSlots()).toBe(12 - (LOOKAHEAD + 2));
  });

  it('throws on a push with no free slot', async () => {
    const t = setup({ ringSize: 3, deferred: true });
    for (let i = 0; i < 3; i++) t.d.push(input(i));
    expect(t.d.freeSlots()).toBe(0);
    expect(() => t.d.push(input(3))).toThrow(/no free ring slot/);
  });

  it('reuses a slot only once every picture and neighbour referring to it is let go', async () => {
    const t = setup({ ringSize: 10 });
    const open = new Set<Picture>();
    const users = (slot: number): Picture[] =>
      [...open].filter((p) => {
        const s = slotsOf(t, p);
        return s.prev === slot || s.cur === slot || s.next === slot;
      });
    let pushed = 0;
    for (let step = 0; step < 60; step++) {
      if (t.d.freeSlots() > 0) {
        const before = t.uploads.length;
        t.d.push(input(pushed++));
        const slot = t.uploads[before]!.slot;
        expect(users(slot)).toEqual([]);
      }
      await settle();
      for (const p of t.pictures.splice(0)) open.add(p);
      // The presenter shows pictures in order: close the oldest two each step.
      for (const p of [...open].slice(0, 2)) {
        p.close();
        open.delete(p);
      }
    }
    expect(pushed).toBeGreaterThan(20);
  });

  it('reset frees every slot, ignores measurements in flight, and old pictures close as no-ops', async () => {
    const t = setup({ ringSize: 12, deferred: true });
    for (let i = 0; i < 10; i++) t.d.push(input(i));
    for (const m of t.measures.slice(0, LOOKAHEAD + 2)) m.resolve(COMBED);
    await settle();
    expect(t.pictures.length).toBeGreaterThan(0);
    const old = t.pictures.splice(0);
    const late = t.measures.slice(LOOKAHEAD + 2);
    t.d.reset();
    expect(t.d.freeSlots()).toBe(12);
    for (const m of late) m.resolve(COMBED);
    await settle();
    expect(t.pictures).toHaveLength(0);
    for (const p of old) p.close();
    expect(t.d.freeSlots()).toBe(12);
    // The new stream starts with no previous neighbour.
    t.d.push(input(100));
    t.d.push(input(101));
    expect(t.measures.at(-1)).toMatchObject({ prev: null });
  });

  it('flush plans the frames left in lookahead and lets the ring go of them', async () => {
    const t = setup({ ringSize: 12, metrics: CLEAN });
    for (let i = 0; i < 4; i++) t.d.push(input(i));
    await settle();
    expect(t.pictures).toHaveLength(0);
    t.d.flush();
    await settle();
    expect(t.pictures.map((p) => p.timestamp)).toEqual([0, 1, 2, 3].map((i) => i * FRAME_US));
    for (const p of t.pictures) p.close();
    expect(t.d.freeSlots()).toBe(12);
  });

  it('stats report the detector, the ring and the backend', () => {
    const t = setup({ ringSize: 8 });
    expect(t.d.stats).toEqual({
      mode: 'video',
      fieldOrder: 'tff',
      fieldOrderSource: 'assumed',
      locks: 0,
      breaks: 0,
      ringSize: 8,
      gpuMs: 0.5,
      fallback: false,
    });
  });

  it('a failed measurement stops planning and is reported', async () => {
    const t = setup();
    const pictures: Picture[] = [];
    const d = new Deinterlacer({
      backend: { ...t.backend, measure: () => Promise.reject(new Error('WebGL context lost')) },
      ringSize: 12,
      frameDurationUs: FRAME_US,
      onPictures: (p) => pictures.push(...p),
    });
    for (let i = 0; i < 10; i++) d.push(input(i));
    expect(d.error).toBeNull();
    await settle();
    expect(d.error?.message).toBe('WebGL context lost');
    expect(pictures).toHaveLength(0);
  });

  it('dispose frees the backend', () => {
    const t = setup();
    t.d.dispose();
    expect(t.disposed()).toBe(true);
  });
});
