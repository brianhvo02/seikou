/*
 * Collision handling between events of one layer: events already on screen keep their place, new ones are moved
 * up (bottom-aligned) or down until they no longer overlap.
 *
 * Ported from libass 0.17.5 (ass_render.c): get_render_priv, overlap, cmp_rect_y0, shift_event (its top only),
 * fit_rect, fix_collisions. libass is ISC-licensed; see src/engine/NOTICE. Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

/** EventImages' placement fields. */
export interface EventBox {
  /** Index of the event in the track. */
  readonly index: number;
  top: number;
  readonly height: number;
  readonly left: number;
  readonly width: number;
  readonly detectCollisions: boolean;
  /** -1 moves up (bottom-aligned), 1 down. */
  readonly shiftDirection: number;
}

interface Rect { y0: number; y1: number; x0: number; x1: number }
interface Placed { top: number; height: number; left: number; width: number }

const overlap = (a: Rect, b: Rect): boolean => !(a.y0 >= b.y1 || b.y0 >= a.y1 || a.x0 >= b.x1 || b.x0 >= a.x1);
const byY0 = (a: Rect, b: Rect): number => a.y0 - b.y0;

/** fit_rect: the shift that moves `s` clear of `fixed`, which then gains it. */
function fitRect(s: Rect, fixed: Rect[], dir: number): number {
  let shift = 0;
  const clear = (f: Rect): boolean => s.y1 + shift <= f.y0 || s.y0 + shift >= f.y1 || s.x1 <= f.x0 || s.x0 >= f.x1;
  if (dir === 1) {
    for (const f of fixed) if (!clear(f)) shift = f.y1 - s.y0;
  } else {
    for (let i = fixed.length - 1; i >= 0; i--) if (!clear(fixed[i]!)) shift = fixed[i]!.y0 - s.y1;
  }
  fixed.push({ y0: s.y0 + shift, y1: s.y1 + shift, x0: s.x0, x1: s.x1 });
  fixed.sort(byY0);
  return shift;
}

/** The per-event ASS_RenderPriv placements libass keeps until the renderer is reconfigured. */
export class CollisionMemory {
  private readonly placed = new Map<number, Placed>();

  clear(): void {
    this.placed.clear();
  }

  private priv(index: number): Placed {
    let p = this.placed.get(index);
    if (!p) {
      p = { top: 0, height: 0, left: 0, width: 0 };
      this.placed.set(index, p);
    }
    return p;
  }

  /** fix_collisions over one layer's events, in render order; moves `top`. */
  fix(events: EventBox[]): void {
    const used: Rect[] = [];
    const counts = (e: EventBox): boolean => e.detectCollisions && e.height !== 0 && e.width !== 0;
    for (const e of events) {
      if (!counts(e)) continue;
      const p = this.priv(e.index);
      if (p.height > 0) {
        const s: Rect = { y0: p.top, y1: p.top + p.height, x0: p.left, x1: p.left + p.width };
        if (p.height !== e.height) Object.assign(p, { top: 0, height: 0, left: 0, width: 0 });
        for (const u of used) if (overlap(s, u)) Object.assign(p, { top: 0, height: 0, left: 0, width: 0 });
        if (p.height > 0) {
          used.push({ y0: p.top, y1: p.top + p.height, x0: p.left, x1: p.left + p.width });
          e.top = p.top;
        }
      }
    }
    used.sort(byY0);
    for (const e of events) {
      if (!counts(e)) continue;
      const p = this.priv(e.index);
      if (p.height !== 0) continue;
      const shift = fitRect({ y0: e.top, y1: e.top + e.height, x0: e.left, x1: e.left + e.width }, used, e.shiftDirection);
      if (shift) e.top += shift;
      Object.assign(p, { top: e.top, height: e.height, left: e.left, width: e.width });
    }
  }
}
