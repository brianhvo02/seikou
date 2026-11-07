/*
 * One frame of an ASS track: the events active at a time, each laid out, transformed and placed on the frame,
 * sorted by layer, collisions fixed.
 *
 * Ported from libass 0.17.5 (ass_render.c): the frame loop of ass_render_frame, cmp_event_layer, the event box of
 * ass_render_event, the device positions of render_and_combine_glyphs. libass is ISC-licensed; see
 * src/engine/NOTICE. Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { CollisionMemory, type EventBox } from './collisions';
import { d6ToDouble, doubleToD6, parseEvent, splitStyleRuns } from './events';
import type { AssFonts } from './fonts';
import { layoutEvent, type LaidOutEvent } from './layout';
import type { GlyphMeasurer } from './measure';
import { VALIGN_SUB } from './types';
import type { RenderSettings } from './state';
import { rotationParams, transformMatrix, type Mat3 } from './transform';
import type { AssTrack } from './types';

export interface FrameEvent {
  readonly index: number;
  readonly layout: LaidOutEvent;
  readonly box: EventBox;
  /** Changes with time inside its interval (\t, \move, \fad, karaoke). */
  readonly animated: boolean;
  /** Per glyph (same order as layout.text.glyphs): calc_transform_matrix, null for skipped glyphs. */
  readonly matrices: readonly (Mat3 | null)[];
  /** How far collision handling moved the event (px): its images are drawn moved by this (shift_event). */
  readonly shiftY: number;
}

export interface FrameLayout { readonly t: number; readonly events: readonly FrameEvent[] }

const ANIMATED = /\{[^}]*\\(t\(|move|fade?\(|k|K)/;

/** Events by start with a max-end segment tree: the ones active at t without scanning the track. */
class IntervalIndex {
  private readonly order: number[];
  private readonly starts: number[];
  private readonly tree: number[];
  private readonly size: number;

  constructor(track: AssTrack) {
    this.order = track.events.map((_, i) => i).sort((a, b) => track.events[a]!.start - track.events[b]!.start);
    this.starts = this.order.map((i) => track.events[i]!.start);
    this.size = 1;
    while (this.size < Math.max(1, this.order.length)) this.size *= 2;
    this.tree = new Array(2 * this.size).fill(-Infinity);
    this.order.forEach((i, k) => { this.tree[this.size + k] = track.events[i]!.start + track.events[i]!.duration; });
    for (let k = this.size - 1; k > 0; k--) this.tree[k] = Math.max(this.tree[2 * k]!, this.tree[2 * k + 1]!);
  }

  /** Indices (track order) of events with start ≤ t < end. */
  active(t: number): number[] {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    const out: number[] = [];
    const visit = (node: number, from: number, to: number): void => {
      if (from >= lo || this.tree[node]! <= t) return;
      if (node >= this.size) {
        out.push(this.order[node - this.size]!);
        return;
      }
      const mid = (from + to) >> 1;
      visit(2 * node, from, mid);
      visit(2 * node + 1, mid, to);
    };
    visit(1, 0, this.size);
    return out.sort((a, b) => a - b);
  }
}

export class FrameBuilder {
  private readonly index: IntervalIndex;
  private readonly animated = new Map<number, boolean>();
  private readonly memory = new CollisionMemory();
  private lastSettings: RenderSettings | null = null;

  constructor(private readonly track: AssTrack, private readonly fonts: AssFonts, private readonly measurer: GlyphMeasurer) {
    this.index = new IntervalIndex(track);
  }

  /** Indices (track order) of the events active at t. */
  activeIndices(t: number): number[] {
    return this.index.active(t);
  }

  /** Forget collision memory (a seek; libass forgets it when reconfigured). */
  reset(): void {
    this.memory.clear();
  }

  private isAnimated(i: number): boolean {
    let a = this.animated.get(i);
    if (a === undefined) {
      a = ANIMATED.test(this.track.events[i]!.text);
      this.animated.set(i, a);
    }
    return a;
  }

  build(t: number, settings: RenderSettings): FrameLayout {
    const last = this.lastSettings;
    if (!last || last.frameWidth !== settings.frameWidth || last.frameHeight !== settings.frameHeight
      || last.storageWidth !== settings.storageWidth || last.storageHeight !== settings.storageHeight || last.fontScale !== settings.fontScale) {
      this.memory.clear(); // ass_reconfigure bumps render_id
      this.lastSettings = settings;
    }
    const events: (Omit<FrameEvent, 'shiftY'> & { top0: number })[] = [];
    for (const i of this.index.active(t)) {
      const ev = this.track.events[i]!;
      if (ev.style >= this.track.styles.length) continue;
      const text = parseEvent(this.track, ev, settings, t - ev.start);
      if (!text) continue;
      splitStyleRuns(text);
      const l = layoutEvent(text, this.fonts, this.measurer);
      const s = text.state;
      rotationParams(s, text.glyphs, l.bbox, l.deviceX, l.deviceY);
      // render_and_combine_glyphs: device positions (26.6), then each glyph's matrix
      const dx = l.deviceX * s.parScaleX;
      const matrices = text.glyphs.map((g) => {
        if (g.skip) return null;
        g.posX = doubleToD6(dx + d6ToDouble(g.posX) * s.parScaleX);
        g.posY = doubleToD6(l.deviceY) + g.posY;
        return transformMatrix(s, g);
      });
      const valign = s.alignment & 12;
      const box: EventBox = {
        index: i,
        top: Math.trunc(l.deviceY - l.lines[0]!.asc - l.borderTop),
        height: Math.trunc(l.height + l.borderBottom + l.borderTop),
        left: Math.trunc((l.deviceX + l.bbox[0]) * s.parScaleX - l.borderX + 0.5),
        width: Math.trunc((l.bbox[2] - l.bbox[0]) * s.parScaleX + 2 * l.borderX + 0.5),
        detectCollisions: s.detectCollisions,
        shiftDirection: valign === VALIGN_SUB ? -1 : 1,
      };
      events.push({ index: i, layout: l, box, animated: this.isAnimated(i), matrices, top0: box.top });
    }
    events.sort((a, b) => this.track.events[a.index]!.layer - this.track.events[b.index]!.layer || this.track.events[a.index]!.readOrder - this.track.events[b.index]!.readOrder);
    for (let from = 0; from < events.length; ) {
      let to = from + 1;
      const layer = this.track.events[events[from]!.index]!.layer;
      while (to < events.length && this.track.events[events[to]!.index]!.layer === layer) to++;
      this.memory.fix(events.slice(from, to).map((e) => e.box));
      from = to;
    }
    return { t, events: events.map(({ top0, ...e }) => ({ ...e, shiftY: e.box.top - top0 })) };
  }
}
