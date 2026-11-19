import { describe, expect, it } from 'vitest';
import { BdVk } from '@seikou/engine/graphics/graphics-controller';
import type { UoOp } from '@seikou/engine/hdmv/uo-mask';
import {
  BDJ_EVENT_MOUSE,
  BDJ_EVENT_VK_KEY,
  BD_VK_KEY_PRESSED,
  BD_VK_KEY_RELEASED,
  BD_VK_KEY_TYPED,
  INPUT_LATENCY_EXPIRY_MS,
  InputLatency,
  TapReactionWatch,
  UoRestriction,
  bdjKeyEvent,
  bdjMouseParam,
  bdjUserInput,
  enqueueBdjEvent,
  getKeyUoOp,
  type QueuedBdjEvent,
} from './input';
import { BdjEvent } from './runtime';

const ALL = (BD_VK_KEY_PRESSED | BD_VK_KEY_TYPED | BD_VK_KEY_RELEASED) >>> 0;
const relaxed = { level: UoRestriction.RELAXED, popupShown: false, isUoMasked: () => true };

describe('bdjKeyEvent and bdjMouseParam (bd_user_input, bd_mouse_select)', () => {
  it('makes a key with no flags pressed, typed and released at once', () => {
    expect(bdjKeyEvent(BdVk.UP)).toBe((0xe0000000 | 12) >>> 0);
    expect(bdjKeyEvent(BdVk.D0)).toBe(0xe0000000);
    expect(bdjKeyEvent(BdVk.POPUP)).toBe((ALL | 11) >>> 0);
  });

  it('keeps the flags it is given', () => {
    expect(bdjKeyEvent(BdVk.ENTER, BD_VK_KEY_PRESSED)).toBe((0x80000000 | 16) >>> 0);
    expect(bdjKeyEvent(BdVk.ENTER, BD_VK_KEY_RELEASED)).toBe((0x20000000 | 16) >>> 0);
  });

  it('packs the position as (x << 16) | y', () => {
    expect(bdjMouseParam(232, 216)).toBe((232 << 16) | 216);
    expect(bdjMouseParam(1919, 1079)).toBe(0x077f0437);
    expect(bdjMouseParam(0xffff, 0xffff)).toBe(0xffffffff);
  });

  it('matches the event ids of bdj.h', () => {
    expect(BDJ_EVENT_VK_KEY).toBe(BdjEvent.VK_KEY);
    expect(BDJ_EVENT_MOUSE).toBe(BdjEvent.MOUSE);
  });
});

describe('bdjUserInput (bd_user_input under a BD-J title)', () => {
  it('sends arrows, Enter, digits and the pop-up key as VK_KEY, unfiltered by the UO mask at RELAXED', () => {
    const keys = [BdVk.UP, BdVk.DOWN, BdVk.LEFT, BdVk.RIGHT, BdVk.ENTER, BdVk.POPUP, BdVk.MOUSE_ACTIVATE, ...Array.from({ length: 10 }, (_, d) => d)];
    for (const k of keys) {
      expect(bdjUserInput(k, relaxed)).toEqual({ kind: 'event', ev: BdjEvent.VK_KEY, param: (ALL | k) >>> 0, uoMasked: false });
    }
  });

  it('makes the root menu key a menu call when typed, and nothing when only pressed or released', () => {
    expect(bdjUserInput(BdVk.ROOT_MENU, relaxed)).toEqual({ kind: 'menuCall' });
    expect(bdjUserInput((BdVk.ROOT_MENU | BD_VK_KEY_PRESSED) >>> 0, relaxed)).toEqual({ kind: 'menuCall' });
    expect(bdjUserInput((BdVk.ROOT_MENU | BD_VK_KEY_TYPED) >>> 0, relaxed)).toEqual({ kind: 'none' });
    expect(bdjUserInput((BdVk.ROOT_MENU | BD_VK_KEY_RELEASED) >>> 0, relaxed)).toEqual({ kind: 'none' });
  });

  it('notes a masked key at COMPLIANT but still sends it, as libbluray does for BD-J titles', () => {
    const masked = new Set<UoOp>(['moveUp', 'popupOn']);
    const ctx = { level: UoRestriction.COMPLIANT, popupShown: false, isUoMasked: (op: UoOp) => masked.has(op) };
    expect(bdjUserInput(BdVk.UP, ctx)).toMatchObject({ kind: 'event', uoMasked: true });
    expect(bdjUserInput(BdVk.POPUP, ctx)).toMatchObject({ kind: 'event', uoMasked: true });
    expect(bdjUserInput(BdVk.DOWN, ctx)).toMatchObject({ kind: 'event', uoMasked: false });
  });
});

describe('getKeyUoOp (_get_key_uo_index)', () => {
  it('enforces nothing for the menu keys at RELAXED', () => {
    for (const k of [BdVk.ROOT_MENU, BdVk.POPUP, BdVk.UP, BdVk.ENTER, BdVk.D5]) expect(getKeyUoOp(k, { level: UoRestriction.RELAXED, popupShown: false })).toBeNull();
  });

  it('enforces the menu call from SAFE and the pop-up above SAFE', () => {
    expect(getKeyUoOp(BdVk.ROOT_MENU, { level: UoRestriction.SAFE, popupShown: false })).toBe('menuCall');
    expect(getKeyUoOp(BdVk.POPUP, { level: UoRestriction.SAFE, popupShown: false })).toBeNull();
    expect(getKeyUoOp(BdVk.UP, { level: UoRestriction.SAFE, popupShown: false })).toBeNull();
  });

  it('enforces arrows and Enter at COMPLIANT; the pop-up key is Pop-up Off while the pop-up is shown', () => {
    const c = { level: UoRestriction.COMPLIANT, popupShown: false };
    expect([BdVk.UP, BdVk.DOWN, BdVk.LEFT, BdVk.RIGHT, BdVk.ENTER].map((k) => getKeyUoOp(k, c))).toEqual(['moveUp', 'moveDown', 'moveLeft', 'moveRight', 'activate']);
    expect(getKeyUoOp(BdVk.POPUP, c)).toBe('popupOn');
    expect(getKeyUoOp(BdVk.POPUP, { ...c, popupShown: true })).toBe('popupOff');
    expect(getKeyUoOp(BdVk.D1, c)).toBeNull();
    expect(getKeyUoOp(BdVk.MOUSE_ACTIVATE, c)).toBeNull();
  });
});

describe('enqueueBdjEvent (bounded queue, Review Focus 2)', () => {
  const key = (vk: number, repeat = false): QueuedBdjEvent => ({ ev: BdjEvent.VK_KEY, param: bdjKeyEvent(vk), ...(repeat ? { coalesce: 'repeat' as const } : {}) });
  const fill = (events: QueuedBdjEvent[]): QueuedBdjEvent[] => {
    const q: QueuedBdjEvent[] = [];
    for (const e of events) enqueueBdjEvent(q, e);
    return q;
  };
  const vks = (q: QueuedBdjEvent[]): number[] => q.map((e) => e.param & 0xffff);

  it('queues every event, repeats included, in order below 8 pending', () => {
    const held = [key(BdVk.DOWN), ...Array.from({ length: 7 }, () => key(BdVk.DOWN, true))];
    expect(fill(held)).toHaveLength(8);
  });

  it('merges further repeats of the same key once 8 are pending', () => {
    const q = fill([key(BdVk.DOWN), ...Array.from({ length: 50 }, () => key(BdVk.DOWN, true))]);
    expect(q).toHaveLength(8);
    expect(vks(q)).toEqual(Array(8).fill(BdVk.DOWN));
  });

  it('never drops a key that is not a repeat, and keeps the order of different keys', () => {
    const q = fill([
      ...Array.from({ length: 8 }, () => key(BdVk.DOWN, true)),
      key(BdVk.ENTER),
      key(BdVk.ENTER),
      key(BdVk.RIGHT, true), // a repeat of a key not pending last: kept
      key(BdVk.RIGHT, true), // merged into the one before
      key(BdVk.DOWN, true), // the latest pending input is RIGHT: kept
    ]);
    expect(vks(q)).toEqual([...Array(8).fill(BdVk.DOWN), BdVk.ENTER, BdVk.ENTER, BdVk.RIGHT, BdVk.DOWN]);
  });

  it('merges a repeat across playback events queued after the same key', () => {
    const q = fill([...Array.from({ length: 8 }, () => key(BdVk.UP, true)), { ev: BdjEvent.PTS, param: 1 }, key(BdVk.UP, true)]);
    expect(q.map((e) => e.ev)).toEqual([...Array(8).fill(BdjEvent.VK_KEY), BdjEvent.PTS]);
  });

  it('never drops playback events', () => {
    const q = fill(Array.from({ length: 20 }, (_, i) => ({ ev: BdjEvent.PTS, param: i })));
    expect(q).toHaveLength(20);
  });

  it('keeps only the newest position of moves beyond 8 pending, never a click', () => {
    const move = (x: number): QueuedBdjEvent => ({ ev: BdjEvent.MOUSE, param: bdjMouseParam(x, 0), coalesce: 'move' });
    const click = (x: number): QueuedBdjEvent => ({ ev: BdjEvent.MOUSE, param: bdjMouseParam(x, 0) });
    const q = fill([...Array.from({ length: 8 }, (_, i) => move(i)), move(100), move(101), click(102), move(103), move(104)]);
    expect(q.map((e) => e.param >>> 16)).toEqual([0, 1, 2, 3, 4, 5, 6, 101, 102, 104]);
  });
});

describe('TapReactionWatch (the ignored-tap rule)', () => {
  function rig() {
    let activity = 0;
    const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
    const ignored: boolean[] = [];
    const watch = new TapReactionWatch({
      setTimer: (ms, fn) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return () => void (t.cancelled = true);
      },
      activity: () => activity,
      ignored: (notice) => void ignored.push(notice),
    });
    const fire = (): void => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    };
    return { watch, timers, ignored, fire, react: () => void activity++ };
  }

  it('reports a tap with no reaction within the window, with the notice once per menu', () => {
    const r = rig();
    r.watch.menuShown();
    r.watch.tap(200);
    expect(r.timers[0]!.ms).toBe(200);
    r.fire();
    r.watch.tap(200);
    r.fire();
    expect(r.ignored).toEqual([true, false]);
    r.watch.menuShown(); // the plane went empty and visible again: a new menu
    r.watch.tap(500);
    r.fire();
    expect(r.ignored).toEqual([true, false, true]);
  });

  it('says nothing when the disc reacts within the window', () => {
    const r = rig();
    r.watch.tap(200);
    r.react();
    r.fire();
    expect(r.ignored).toEqual([]);
    expect(r.watch.pending).toBe(false);
  });

  it('a later tap replaces a pending one; cancel drops it', () => {
    const r = rig();
    r.watch.tap(200);
    r.watch.tap(200);
    expect(r.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    r.watch.cancel();
    r.fire();
    expect(r.ignored).toEqual([]);
  });
});

describe('InputLatency (the responsiveness measure, 5d spec §4.2)', () => {
  it('times an input to the first presented frame with a plane published after it', () => {
    const l = new InputLatency();
    l.input(1000, 7);
    l.presented(1050, 7); // the plane as it was before the input: no answer
    expect(l.stats).toBeNull();
    l.presented(1120, 8);
    expect(l.stats).toEqual({ last: 120, max: 120, count: 1 });
  });

  it('answers every waiting input with one change, and keeps the largest', () => {
    const l = new InputLatency();
    l.input(0, 1);
    l.input(30, 1);
    l.presented(200, 2);
    expect(l.stats).toEqual({ last: 170, max: 200, count: 2 });
    l.input(300, 2);
    l.input(320, 3); // after a flush: only a later publication answers it
    l.presented(340, 3);
    expect(l.stats).toEqual({ last: 40, max: 200, count: 3 });
    l.presented(400, 4);
    expect(l.stats).toEqual({ last: 80, max: 200, count: 4 });
  });

  it('drops an input that changed nothing within the expiry, and inputs still waiting when cleared', () => {
    const l = new InputLatency();
    l.input(0, 1);
    l.presented(INPUT_LATENCY_EXPIRY_MS + 1, 2);
    expect(l.stats).toBeNull();
    l.input(10_000, 2);
    l.clearPending();
    l.presented(10_050, 3);
    expect(l.stats).toBeNull();
  });
});
