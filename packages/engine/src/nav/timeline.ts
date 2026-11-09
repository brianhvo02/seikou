/*
 * Derived from libbluray navigation code (src/libbluray/bdnav/navigation.c, time math)
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { MarkType, type PlayItem, type PlayListMark } from '@seikou/bdmv/mpls-parser';
import { pts90ToUs, ptsDelta90, ticks45ToUs, usToTicks45 } from '../util/time';

export interface TimelineItem {
  readonly index: number;
  readonly clipId: string;
  /** 45 kHz clip time. */
  readonly inTime: number;
  readonly outTime: number;
  /** 45 kHz playlist time at which this item starts. */
  readonly start: number;
  readonly connectionCondition: number;
  /** STC sequence (continuous PTS run) of the clip this item plays from. */
  readonly stcId: number;
}

export interface Chapter {
  readonly index: number;
  readonly startUs: number;
  /** The chapter's name (an encoded episode's Matroska chapters); disc chapters have none. */
  readonly name?: string;
}

export interface ItemPosition {
  readonly item: TimelineItem;
  readonly clipTime45: number;
}

/** Maps between continuous playlist time and per-clip PTS (libbluray navigation.c time math). */
export class Timeline {
  readonly items: readonly TimelineItem[];
  readonly duration45: number;
  private readonly marks: readonly PlayListMark[];

  constructor(playItems: readonly PlayItem[], marks: readonly PlayListMark[] = []) {
    this.marks = marks;
    const items: TimelineItem[] = [];
    let start = 0;
    playItems.forEach((p, index) => {
      items.push({ index, clipId: p.clipId, inTime: p.inTime, outTime: p.outTime, start, connectionCondition: p.connectionCondition, stcId: p.stcId });
      start += Math.max(0, p.outTime - p.inTime);
    });
    this.items = items;
    this.duration45 = start;
  }

  get markCount(): number {
    return this.marks.length;
  }

  get durationUs(): number {
    return ticks45ToUs(this.duration45);
  }

  itemStartUs(index: number): number {
    return ticks45ToUs(this.item(index).start);
  }

  locate(playlistUs: number): ItemPosition {
    if (this.items.length === 0) throw new Error('Timeline has no play items');
    const t = Math.min(Math.max(0, usToTicks45(playlistUs)), Math.max(0, this.duration45 - 1));
    let item = this.items[0];
    for (const candidate of this.items) {
      if (candidate.start > t) break;
      if (candidate.outTime > candidate.inTime) item = candidate;
    }
    return { item, clipTime45: item.inTime + (t - item.start) };
  }

  toPlaylistUs(itemIndex: number, pts90: number): { us: number; inRange: boolean } {
    const item = this.item(itemIndex);
    const delta90 = ptsDelta90(pts90, item.inTime * 2);
    const length90 = (item.outTime - item.inTime) * 2;
    return { us: ticks45ToUs(item.start) + pts90ToUs(delta90), inRange: delta90 >= 0 && delta90 < length90 };
  }

  /** Playlist time of mark `index` over all marks, entry and link (libbluray mark_list). */
  markTimeUs(index: number): number {
    const mark = this.marks[index];
    if (!mark) throw new RangeError(`mark ${index} is out of range 0..${this.marks.length - 1}`);
    const item = this.item(mark.playItemRef);
    const offset = Math.min(Math.max(0, mark.time - item.inTime), item.outTime - item.inTime);
    return ticks45ToUs(item.start + offset);
  }

  chapters(marks: readonly PlayListMark[]): Chapter[] {
    const starts = marks
      .filter((m) => m.type === MarkType.ENTRY && m.playItemRef < this.items.length)
      .map((m) => {
        const item = this.items[m.playItemRef];
        const offset = Math.min(Math.max(0, m.time - item.inTime), item.outTime - item.inTime); // clamp to the item
        return ticks45ToUs(item.start + offset);
      });
    return [...new Set(starts)].sort((a, b) => a - b).map((startUs, index) => ({ index, startUs }));
  }

  private item(index: number): TimelineItem {
    const item = this.items[index];
    if (!item) throw new RangeError(`play item ${index} is out of range 0..${this.items.length - 1}`);
    return item;
  }
}
