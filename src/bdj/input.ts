/*
 * User input for BD-J titles.
 *
 * bdjUserInput, getKeyUoOp, bdjKeyEvent and bdjMouseParam are ported from libbluray src/libbluray/bluray.c
 * (bd_user_input's BD-J branch, _get_key_uo_index, bd_mouse_select's BD-J branch) and src/libbluray/keys.h.
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * enqueueBdjEvent (the bounded event queue), TapReactionWatch (the ignored-tap rule: a tap a BD-J menu does not react
 * to opens the on-screen remote) and InputLatency (how long a menu takes to answer a key or tap) are original code for
 * Seikou: libbluray has none. The BD-J menus spec, docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md, sets
 * both rules. The event queue runs in the BD-J worker (runtime.ts); everything else runs in the engine worker.
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { BdVk } from '@seikou/engine/graphics/graphics-controller';
import type { UoOp } from '@seikou/engine/hdmv/uo-mask';
import type { InputLatencyLike, KeyUoContext, BdjInput, Coalesce, TapReactionDeps, InputLatencyStats, TapReactionWatchLike } from '@seikou/engine/bdj-types';
export type { KeyUoContext, BdjInput, Coalesce, TapReactionDeps, InputLatencyStats } from '@seikou/engine/bdj-types';

/** bdj.h BDJ_EVENT_VK_KEY: a key event for Java, its param a key code with flags (runtime.ts BdjEvent, not imported: runtime.ts uses this module). */
export const BDJ_EVENT_VK_KEY = 16;
/** bdj.h BDJ_EVENT_MOUSE: a pointer position for Java, its param from bdjMouseParam. */
export const BDJ_EVENT_MOUSE = 18;

/** keys.h BD_VK_KEY_PRESSED: a flag OR'd with the key code, the key went down. */
export const BD_VK_KEY_PRESSED = 0x80000000;
/** keys.h BD_VK_KEY_TYPED: a flag OR'd with the key code, the key was typed. */
export const BD_VK_KEY_TYPED = 0x40000000;
/** keys.h BD_VK_KEY_RELEASED: a flag OR'd with the key code, the key came up. */
export const BD_VK_KEY_RELEASED = 0x20000000;
const BD_VK_FLAGS_MASK = BD_VK_KEY_PRESSED | BD_VK_KEY_TYPED | BD_VK_KEY_RELEASED;

/** BD_VK_KEY(k) */
const vkKey = (k: number): number => (k & ~BD_VK_FLAGS_MASK) >>> 0;
/** BD_VK_FLAGS(k) */
const vkFlags = (k: number): number => (k & BD_VK_FLAGS_MASK) >>> 0;
/** BD_KEY_TYPED(k): the HDMV "pressed down" test, which bd_user_input also applies to the root menu key. */
const keyTyped = (k: number): boolean => (k & (BD_VK_KEY_TYPED | BD_VK_KEY_RELEASED)) === 0;

/**
 * How strictly user operations are checked against the UO mask, from not at all (DISABLED) to as the disc demands
 * (COMPLIANT): bd_player_setting_uo_restriction_level (player_settings.h).
 */
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

/** An event waiting for Java: a libbluray BDJ_EVENT_* number and its param. */
export interface QueuedBdjEvent {
  readonly ev: number;
  /** Mutable: a merged pointer move overwrites it with the newest position. */
  param: number;
  /** How this event may merge with an earlier one once the queue is full; absent, it never merges. */
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
 * The ignored-tap rule: a tap forwarded to a BD-J menu that brings no reaction within the window (no change in
 * `activity`: a plane publication or anything Java sends) is reported, so the player shows its controls instead.
 * The notice, with which the on-screen remote opens, goes with the first such tap of a menu only (a menu lasts from
 * the plane turning visible), so a remote the user closed stays closed until the next menu. Runs in the engine worker.
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

  /** A tap is waiting out its window. */
  get pending(): boolean {
    return this.cancelTimer !== null;
  }
}

// ---- the responsiveness measure (original code) ----

/** An input whose plane change has not been presented after this long changed nothing: it is dropped, uncounted. */
export const INPUT_LATENCY_EXPIRY_MS = 5_000;
const MAX_PENDING_INPUTS = 32;

/**
 * How long a BD-J menu takes to answer: from a key press or a tap reaching the engine to the next presented frame that
 * contains a plane change published after it (telemetry's bdj.inputLatencyMs, held to a 0.2 s bar). BD-J has no notion of which flush answers which input, so the first
 * plane publication presented after an input answers it (and every input before it). Runs in the engine worker.
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

  /** The last and longest answer in milliseconds and how many were counted; null before the first. */
  get stats(): InputLatencyStats | null {
    return this.count > 0 ? { last: Math.round(this.last), max: Math.round(this.max), count: this.count } : null;
  }
}
