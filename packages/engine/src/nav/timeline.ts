/*
 * Derived from libbluray navigation code (src/libbluray/bdnav/navigation.c, time math)
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { MarkType, type PlayItem, type PlayListMark } from '@seikou/bdmv/mpls-parser';
import { pts90ToUs, ptsDelta90, ticks45ToUs, usToTicks45 } from '../util/time';

/** One play item placed on the playlist's continuous timeline. */
export interface TimelineItem {
  /** The item's position in the playlist, 0-based. */
  readonly index: number;
  /** The clip the item plays (its file name without extension, such as `00000`). */
  readonly clipId: string;
  /** 45 kHz clip time. */
  readonly inTime: number;
  /** 45 kHz clip time where the item stops (OUT time). */
  readonly outTime: number;
  /** 45 kHz playlist time at which this item starts. */
  readonly start: number;
  /** How the item joins the previous one (`connection_condition`; 5 and 6 are the seamless joins). */
  readonly connectionCondition: number;
  /** STC sequence (continuous PTS run) of the clip this item plays from. */
  readonly stcId: number;
}

/** A chapter of the playlist being played. */
export interface Chapter {
  /** The chapter's number, 0-based. */
  readonly index: number;
  /** Where the chapter starts, in playlist microseconds. */
  readonly startUs: number;
  /** The chapter's name (an encoded episode's Matroska chapters); disc chapters have none. */
  readonly name?: string;
}

/** A place in the playlist expressed as an item and a time within its clip. */
export interface ItemPosition {
  /** The play item containing the position. */
  readonly item: TimelineItem;
  /** The 45 kHz clip time (the clip's own PTS clock) of the position. */
  readonly clipTime45: number;
}

/**
 * Maps between continuous playlist time and per-clip PTS, after libbluray's time math in `navigation.c`. Play items are
 * laid end to end; an item's length is OUT minus IN. Pure: no I/O and no thread affinity.
 */
export class Timeline {
  /** The play items laid end to end. */
  readonly items: readonly TimelineItem[];
  /** The playlist's length in 45 kHz ticks. */
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

  /** How many playlist marks there are (entry and link marks both). */
  get markCount(): number {
    return this.marks.length;
  }

  /** The playlist's total length in microseconds. */
  get durationUs(): number {
    return ticks45ToUs(this.duration45);
  }

  /** Playlist time, in microseconds, at which play item `index` starts; throws `RangeError` for an unknown item. */
  itemStartUs(index: number): number {
    return ticks45ToUs(this.item(index).start);
  }

  /**
   * The play item and clip time at a playlist time in microseconds, clamped to the playlist's last tick. Items of zero
   * length are skipped. Throws when the playlist has no play items.
   */
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

  /**
   * The playlist time in microseconds of a clip PTS (90 kHz, 33 bits) within play item `itemIndex`, wrap-aware, and
   * whether the PTS lies inside the item's IN to OUT range.
   */
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

  /** The chapters from the ENTRY marks of `marks`, in time order with duplicates removed; each mark's time is clamped to its item. */
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
