import { describe, expect, it } from 'vitest';
import { CollisionMemory, type EventBox } from './collisions';

const box = (index: number, top: number, height = 50, extra: Partial<EventBox> = {}): EventBox =>
  ({ index, top, height, left: 100, width: 400, detectCollisions: true, shiftDirection: -1, ...extra });

describe('CollisionMemory', () => {
  it('pushes a later bottom event above an earlier one', () => {
    const m = new CollisionMemory();
    const a = box(0, 1000);
    const b = box(1, 1000);
    m.fix([a, b]);
    expect([a.top, b.top]).toEqual([1000, 950]);
  });

  it('keeps an event that was already shown where it was when another arrives', () => {
    const m = new CollisionMemory();
    const first = box(1, 1000);
    m.fix([first]);
    const a = box(0, 1000);
    const b = box(1, 1000);
    m.fix([a, b]);
    expect([a.top, b.top]).toEqual([950, 1000]);
  });

  it('moves top events down', () => {
    const m = new CollisionMemory();
    const a = box(0, 20, 50, { shiftDirection: 1 });
    const b = box(1, 20, 50, { shiftDirection: 1 });
    m.fix([a, b]);
    expect([a.top, b.top]).toEqual([20, 70]);
  });

  it('leaves positioned events, zero-size events and non-overlapping ones alone', () => {
    const m = new CollisionMemory();
    const a = box(0, 1000);
    const b = box(1, 1000, 50, { detectCollisions: false });
    const c = box(2, 1000, 50, { left: 600 });
    const d = box(3, 1000, 0);
    m.fix([a, b, c, d]);
    expect([a.top, b.top, c.top, d.top]).toEqual([1000, 1000, 1000, 1000]);
  });

  it('forgets everything on clear', () => {
    const m = new CollisionMemory();
    m.fix([box(1, 1000)]);
    m.clear();
    const a = box(0, 1000);
    const b = box(1, 1000);
    m.fix([a, b]);
    expect([a.top, b.top]).toEqual([1000, 950]);
  });

  it('drops a memory whose height changed', () => {
    const m = new CollisionMemory();
    m.fix([box(1, 1000)]);
    const a = box(0, 1000);
    const b = box(1, 1000, 60);
    m.fix([a, b]);
    expect([a.top, b.top]).toEqual([1000, 940]);
  });
});
