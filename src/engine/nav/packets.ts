/*
 * Derived from libbluray navigation code (src/libbluray/bdnav/navigation.c: _fill_clip, _fill_mark; clpi_parse.c: clpi_lookup_spn;
 * src/libbluray/bluray.c: _find_next_playmark)
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Clpi } from '@seikou/bdmv/clpi-parser';
import type { PlayItem, PlayListMark } from '@seikou/bdmv/mpls-parser';

/**
 * clpi_lookup_spn without the STC refinement: `before` gives the packet of the last EP map entry at or before the time
 * (0 if there is none), otherwise the first entry after it (the packet count past the last entry).
 */
export function lookupSpn(clip: Clpi | undefined, time45: number, before: boolean): number {
  const entries = clip?.epMaps[0]?.entries ?? [];
  if (!clip || entries.length === 0) return before ? 0 : (clip?.numSourcePackets ?? 0);
  if (before) {
    let spn = 0;
    for (const e of entries) if (e.pts <= time45) spn = e.spn;
    return spn;
  }
  for (const e of entries) if (e.pts > time45) return e.spn;
  return clip.numSourcePackets;
}

/** NAV_CLIP's packet geometry of one play item. */
export interface ItemPackets {
  /** start_pkt */
  readonly startPkt: number;
  /** end_pkt */
  readonly endPkt: number;
  /** title_pkt: packets in the playlist before this item */
  readonly titlePkt: number;
}

/** _fill_clip: start_pkt is 0 for the first item and for seamless connections (condition 5 and 6). */
export function itemPackets(playItems: readonly PlayItem[], clips: ReadonlyMap<string, Clpi> | undefined): ItemPackets[] {
  const out: ItemPackets[] = [];
  let pos = 0;
  playItems.forEach((pi, ref) => {
    const clip = clips?.get(pi.clipId);
    let startPkt = 0;
    let endPkt = 0;
    if (clip) {
      startPkt = pi.connectionCondition === 5 || pi.connectionCondition === 6 || ref === 0 ? 0 : lookupSpn(clip, pi.inTime, true);
      endPkt = lookupSpn(clip, pi.outTime, false);
    }
    out.push({ startPkt, endPkt, titlePkt: pos });
    pos += endPkt - startPkt;
  });
  return out;
}

/** _fill_mark: a play mark's title_pkt (an invalid play_item_ref counts as item 0). */
export function markTitlePkt(mark: PlayListMark, items: readonly ItemPackets[], playItems: readonly PlayItem[], clips: ReadonlyMap<string, Clpi> | undefined): number {
  const ref = mark.playItemRef < items.length ? mark.playItemRef : 0;
  const item = items[ref];
  const pi = playItems[ref];
  if (!item || !pi) return 0;
  const clip = clips?.get(pi.clipId);
  const clipPkt = clip ? lookupSpn(clip, mark.time, true) : item.startPkt;
  return item.titlePkt + clipPkt - item.startPkt;
}

/**
 * _find_next_playmark: the first mark whose title packet lies after the read position `sPos` (title packets), -1 when
 * none does. A playlist opened at its start reads from packet 0 (the first item's start_pkt), so a mark at the first
 * item's IN time, at the packet of its EP map entry, is still ahead and the first read reaches it.
 */
export function nextPlaymark(sPos: number, marks: readonly PlayListMark[], playItems: readonly PlayItem[], clips: ReadonlyMap<string, Clpi> | undefined): number {
  const items = itemPackets(playItems, clips);
  for (let i = 0; i < marks.length; i++) if (markTitlePkt(marks[i]!, items, playItems, clips) > sPos) return i;
  return -1;
}
