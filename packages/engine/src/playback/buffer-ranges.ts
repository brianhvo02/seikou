/*
 * Derived from libbluray navigation code (src/libbluray/bdnav/navigation.c: _fill_clip start packet), as
 * playback/pipeline.ts chooses a play item's start and end packets.
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026: the byte ranges a playlist plays from a time on (buffer first).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { findEpAfter, findEpBefore, stcSpnRange, type Clpi } from '@seikou/bdmv/clpi-parser';
import type { Mpls } from '@seikou/bdmv/mpls-parser';
import { ALIGNED_UNIT_SIZE, SOURCE_PACKET_SIZE } from '@seikou/bdmv/demux/constants';
import { streamPath } from '../disc/open-disc';
import { Timeline } from '../nav/timeline';

/** A half-open range of bytes in one stream file. */
export interface ByteRange {
  /** The stream file's disc path (such as `BDMV/STREAM/00000.M2TS`). */
  readonly path: string;
  /** First byte, inclusive. */
  readonly start: number;
  /** One past the last byte. */
  readonly end: number;
}

/**
 * The stream files' byte ranges `mpls` reads from `fromUs` (playlist time) to its end, in playback order: each play
 * item from the EP map entry at or before its start (the first item's at `fromUs`) to the entry after its out time,
 * widened to whole `chunkBytes` (RemoteSource's chunks; the end also by an aligned unit, which the reader reads whole)
 * and clipped to the file. Consecutive ranges in one file that meet are merged. Items whose clip info is missing are
 * left out.
 */
export function bufferRanges(mpls: Mpls, clips: ReadonlyMap<string, Clpi>, fileSize: (path: string) => number, fromUs: number, chunkBytes: number): ByteRange[] {
  if (mpls.playItems.length === 0) return [];
  const timeline = new Timeline(mpls.playItems, mpls.marks);
  const from = timeline.locate(fromUs);
  const out: ByteRange[] = [];
  for (let i = from.item.index; i < timeline.items.length; i++) {
    const item = timeline.items[i]!;
    const playItem = mpls.playItems[i]!;
    const clip = clips.get(item.clipId);
    if (item.outTime <= item.inTime || !clip) continue;
    const videoPid = playItem.stn.video[0]?.pid;
    const ep = clip.epMaps.find((m) => m.pid === videoPid) ?? clip.epMaps[0];
    const target = i === from.item.index ? from.clipTime45 : item.inTime;
    const range = stcSpnRange(clip, item.stcId);
    const cc = playItem.connectionCondition;
    const fromClipStart = target <= item.inTime && (i === 0 || cc === 5 || cc === 6);
    const startSpn = fromClipStart || !ep ? range.startSpn : (findEpBefore(ep, target, range)?.spn ?? range.startSpn);
    const endSpn = ep ? (findEpAfter(ep, item.outTime, range)?.spn ?? range.endSpn) : range.endSpn;
    const path = streamPath(item.clipId);
    const size = fileSize(path);
    const start = Math.floor((startSpn * SOURCE_PACKET_SIZE) / chunkBytes) * chunkBytes;
    const end = Number.isFinite(endSpn) ? Math.min(size, Math.ceil((endSpn * SOURCE_PACKET_SIZE + ALIGNED_UNIT_SIZE) / chunkBytes) * chunkBytes) : size;
    if (end <= start) continue;
    const prev = out.at(-1);
    if (prev && prev.path === path && start <= prev.end && end >= prev.start) out[out.length - 1] = { path, start: Math.min(prev.start, start), end: Math.max(prev.end, end) };
    else out.push({ path, start, end });
  }
  return out;
}
