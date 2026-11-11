/*
 * User input for BD-J titles.
 *
 * bdjUserInput, getKeyUoOp, bdjKeyEvent and bdjMouseParam are ported from libbluray src/libbluray/bluray.c
 * (bd_user_input's BD-J branch, _get_key_uo_index, bd_mouse_select's BD-J branch) and src/libbluray/keys.h.
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * enqueueBdjEvent (the bounded event queue), TapReactionWatch (the ignored-tap rule of the 5d spec, §4.2) and
 * InputLatency (the responsiveness measure of the same section) are original code for Seikou: libbluray has none.
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { BdVk } from '@seikou/engine/graphics/graphics-controller';
import type { UoOp } from '@seikou/engine/hdmv/uo-mask';
import type { InputLatencyLike, KeyUoContext, BdjInput, Coalesce, TapReactionDeps, InputLatencyStats, TapReactionWatchLike } from '@seikou/engine/bdj-types';
export type { KeyUoContext, BdjInput, Coalesce, TapReactionDeps, InputLatencyStats } from '@seikou/engine/bdj-types';

/** bdj.h BDJ_EVENT_VK_KEY and BDJ_EVENT_MOUSE (runtime.ts BdjEvent, not imported: runtime.ts uses this module). */
export const BDJ_EVENT_VK_KEY = 16;
export const BDJ_EVENT_MOUSE = 18;

/** keys.h: flags OR'd with the key code. */
export const BD_VK_KEY_PRESSED = 0x80000000;
export const BD_VK_KEY_TYPED = 0x40000000;
export const BD_VK_KEY_RELEASED = 0x20000000;
const BD_VK_FLAGS_MASK = BD_VK_KEY_PRESSED | BD_VK_KEY_TYPED | BD_VK_KEY_RELEASED;

/** BD_VK_KEY(k) */
const vkKey = (k: number): number => (k & ~BD_VK_FLAGS_MASK) >>> 0;
/** BD_VK_FLAGS(k) */
const vkFlags = (k: number): number => (k & BD_VK_FLAGS_MASK) >>> 0;
/** BD_KEY_TYPED(k): the HDMV "pressed down" test, which bd_user_input also applies to the root menu key. */
const keyTyped = (k: number): boolean => (k & (BD_VK_KEY_TYPED | BD_VK_KEY_RELEASED)) === 0;

/** bd_player_setting_uo_restriction_level (player_settings.h). */
export const UoRestriction = { DISABLED: 0, RELAXED: 5, SAFE: 10, COMPLIANT: 20 } as const;

/**
 * BDJ_EVENT_VK_KEY's param for key `vk` (a BD_VK_* code) with `flags`: bd_user_input's "no flags → single key press
 * event" rule makes a key with none pressed, typed and released at once.
 */
export function bdjKeyEvent(vk: number, flags = 0): number {
  let key = (vk | flags) >>> 0;
  if (!vkFlags(key)) key = (key | BD_VK_KEY_PRESSED | BD_VK_KEY_TYPED | BD_VK_KEY_RELEASED) >>> 0;
  return key;
}

/** bd_mouse_select: BDJ_EVENT_MOUSE's param, `(x << 16) | y` of the uint16 position. */
export function bdjMouseParam(x: number, y: number): number {
  return (((x & 0xffff) << 16) | (y & 0xffff)) >>> 0;
}

/** _get_key_uo_index's key_uo_map: the operation and the lowest level that enforces it. */
const KEY_UO: ReadonlyMap<number, { readonly op: UoOp; readonly minLevel: number }> = new Map([
  [BdVk.ROOT_MENU, { op: 'menuCall', minLevel: UoRestriction.SAFE }],
  // BD_VK_POPUP handled specifically
  [BdVk.UP, { op: 'moveUp', minLevel: UoRestriction.COMPLIANT }],
  [BdVk.DOWN, { op: 'moveDown', minLevel: UoRestriction.COMPLIANT }],
  [BdVk.LEFT, { op: 'moveLeft', minLevel: UoRestriction.COMPLIANT }],
  [BdVk.RIGHT, { op: 'moveRight', minLevel: UoRestriction.COMPLIANT }],
  [BdVk.ENTER, { op: 'activate', minLevel: UoRestriction.COMPLIANT }],
]);

/**
 * _get_key_uo_index: the user operation a key is checked against, or null when none is enforced at this level. Returns
 * the operation rather than its UO mask index. For the pop-up key libbluray returns the index as its "found" result and
 * leaves *uo_index unset; the operation it means is returned here.
 */
export function getKeyUoOp(keyId: number, ctx: KeyUoContext): UoOp | null {
  if (keyId === BdVk.POPUP) {
    // check if pop-up menu is on, if so key is treated as Pop-up Off UO
    if (ctx.level <= UoRestriction.SAFE) return null; // Not enforced
    return ctx.popupShown ? 'popupOff' : 'popupOn';
  }
  const entry = KEY_UO.get(keyId);
  if (!entry || ctx.level < entry.minLevel) return null; // Not enforced
  return entry.op;
}

/** bd_user_input under title_type bdj, for `key` (a BD_VK_* code, optionally OR'd with BD_VK_KEY_* flags). */
export function bdjUserInput(key: number, ctx: KeyUoContext & { readonly isUoMasked: (op: UoOp) => boolean }): BdjInput {
  if (vkKey(key) === BdVk.ROOT_MENU) return keyTyped(key) ? { kind: 'menuCall' } : { kind: 'none' };
  const op = getKeyUoOp(vkKey(key), ctx);
  const uoMasked = op !== null && ctx.isUoMasked(op);
  return { kind: 'event', ev: BDJ_EVENT_VK_KEY, param: bdjKeyEvent(vkKey(key), vkFlags(key)), uoMasked };
}

// ---- the bounded event queue (original code) ----

export interface QueuedBdjEvent {
  readonly ev: number;
  param: number;
  readonly coalesce?: Coalesce;
}

/** Below this many pending events nothing is merged. */
export const BDJ_EVENT_QUEUE_CAP = 8;

const isInput = (ev: number): boolean => ev === BDJ_EVENT_VK_KEY || ev === BDJ_EVENT_MOUSE;

/**
 * Appends `e` to the events waiting for Java, in order. libbluray's bd_user_input blocks its caller until Java has taken
 * the event; here the caller does not wait, so a held key could pile up repeats behind a slow menu. With fewer than
 * `cap` pending, every event is queued. Beyond that, an auto-repeat is dropped when the latest pending input event is
 * the same key (it already stands for it), and a pointer move updates the latest pending input event when that is a
 * move (the newest position wins); anything else, and every event that is not a repeat or a move, is queued.
 */
export function enqueueBdjEvent(queue: QueuedBdjEvent[], e: QueuedBdjEvent, cap = BDJ_EVENT_QUEUE_CAP): void {
  if (queue.length >= cap && e.coalesce) {
    let last: QueuedBdjEvent | undefined;
    for (let i = queue.length - 1; i >= 0 && !last; i--) if (isInput(queue[i]!.ev)) last = queue[i];
    if (last && last.ev === e.ev) {
      if (e.coalesce === 'repeat' && last.param === e.param) return;
      if (e.coalesce === 'move' && last.coalesce === 'move') {
        last.param = e.param;
        return;
      }
    }
  }
  queue.push({ ...e });
}

// ---- the ignored-tap rule (original code) ----

/**
 * The 5d spec's ignored-tap rule (§4.2): a tap forwarded to a BD-J menu that brings no reaction within the window is
 * reported; the notice goes with the first such tap of a menu only (a menu lasts from the plane turning visible).
 */
export class TapReactionWatch implements TapReactionWatchLike {
  private noticed = false;
  private cancelTimer: (() => void) | null = null;

  constructor(private readonly deps: TapReactionDeps) {}

  /** The plane turned visible: a new menu, whose first ignored tap gets the notice again. */
  menuShown(): void {
    this.noticed = false;
  }

  /** A tap went to Java now; a later tap replaces a pending one. */
  tap(windowMs: number): void {
    this.cancel();
    const before = this.deps.activity();
    this.cancelTimer = this.deps.setTimer(windowMs, () => {
      this.cancelTimer = null;
      if (this.deps.activity() !== before) return;
      const notice = !this.noticed;
      this.noticed = true;
      this.deps.ignored(notice);
    });
  }

  /** Drops a pending tap (BD-J stopped). */
  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  get pending(): boolean {
    return this.cancelTimer !== null;
  }
}

// ---- the responsiveness measure (original code) ----

/** An input whose plane change has not been presented after this long changed nothing: it is dropped, uncounted. */
export const INPUT_LATENCY_EXPIRY_MS = 5_000;
const MAX_PENDING_INPUTS = 32;

/**
 * The 5d spec's responsiveness (§4.2): from a key press or a tap reaching the engine to the next presented frame that
 * contains a plane change published after it. BD-J has no notion of which flush answers which input, so the first
 * plane publication presented after an input answers it (and every input before it).
 */
export class InputLatency implements InputLatencyLike {
  private readonly pending: Array<{ readonly atMs: number; readonly version: number }> = [];
  private last = 0;
  private max = 0;
  private count = 0;

  /** A key or tap went to Java at `atMs`, with the plane at `version` (GraphicsPlaneReader.version). */
  input(atMs: number, version: number): void {
    if (this.pending.length >= MAX_PENDING_INPUTS) this.pending.shift();
    this.pending.push({ atMs, version });
  }

  /** A frame was presented at `atMs` with the plane as published at `version` or later. */
  presented(atMs: number, version: number): void {
    while (this.pending.length > 0) {
      const p = this.pending[0]!;
      if (atMs - p.atMs > INPUT_LATENCY_EXPIRY_MS) {
        this.pending.shift();
        continue;
      }
      if (version === p.version) break; // published before this input (the version only grows; === survives a wrap)
      this.pending.shift();
      this.last = atMs - p.atMs;
      this.max = Math.max(this.max, this.last);
      this.count++;
    }
  }

  /** BD-J stopped: inputs still waiting are dropped. */
  clearPending(): void {
    this.pending.length = 0;
  }

  get stats(): InputLatencyStats | null {
    return this.count > 0 ? { last: Math.round(this.last), max: Math.round(this.max), count: this.count } : null;
  }
}
