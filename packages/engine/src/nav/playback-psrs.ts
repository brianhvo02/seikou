/*
 * Ported from libbluray src/libbluray/bluray.c (_update_playlist_psrs, _update_clip_psrs, _update_time_psr,
 * _update_chapter_psr, _is_interactive_title) and bdnav/navigation.c (nav_clip_time_search, nav_chapter_get_current)
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { IndexObject } from '@seikou/bdmv/index-parser';
import { MarkType, type Mpls } from '@seikou/bdmv/mpls-parser';
import type { DiscModel } from '../disc/open-disc';
import { PSR, type RegisterFile } from '../hdmv/registers';
import { lookupSpn, type ItemPackets } from './packets';
import { langToUint32, updateStreamPsrByLang } from './stream-psrs';

export type TitleType = 'undef' | 'hdmv' | 'bdj';

/** What the playback PSR updates read of libbluray's BLURAY: the registers, the open title and title_type. */
export interface PlaybackPsrContext {
  readonly regs: RegisterFile;
  readonly disc: DiscModel;
  readonly playlist: Mpls | null;
  /** NAV_CLIP start_pkt / end_pkt / title_pkt of the playlist's play items. */
  readonly geometry: readonly ItemPackets[];
  readonly titleType: TitleType;
}

const TITLE_FIRST_PLAY = 0xffff;
const TITLE_TOP_MENU = 0;
const INDEX_PLAYBACK_INTERACTIVE = [1, 3]; // indx_hdmv_playback_type_interactive, indx_bdj_playback_type_interactive

export function indexObjectOf(disc: DiscModel, title: number): IndexObject | undefined {
  const { index } = disc;
  if (title === TITLE_FIRST_PLAY) return index.firstPlay;
  if (title === TITLE_TOP_MENU) return index.topMenu;
  return index.titles[title - 1]?.object;
}

/** _update_playlist_psrs */
export function updatePlaylistPsrs(ctx: PlaybackPsrContext, playlistId: string, item: number, angle = 0): void {
  const regs = ctx.regs;
  regs.psrWrite(PSR.PLAYLIST, parseInt(playlistId, 10) || 0);
  regs.psrWrite(PSR.ANGLE_NUMBER, angle + 1);
  regs.psrWrite(PSR.CHAPTER, 0xffff);

  const pi = ctx.playlist?.playItems[item];
  if (pi && ctx.titleType === 'undef') {
    // Without menus, pick audio and subtitles from the language settings
    regs.psrWrite(PSR.PLAYITEM, item);
    let audioLang = 0;
    if (pi.stn.audio.length > 0) {
      audioLang = updateStreamPsrByLang(regs, PSR.AUDIO_LANG, PSR.PRIMARY_AUDIO_ID, 0, pi.stn.audio, 0);
    }
    if (pi.stn.pg.length > 0) {
      updateStreamPsrByLang(regs, PSR.PG_AND_SUB_LANG, PSR.PG_STREAM, 0x80000000, pi.stn.pg, audioLang);
    }
  }
}

/** _update_clip_psrs */
export function updateClipPsrs(ctx: PlaybackPsrContext, pl: Mpls, item: number): void {
  const regs = ctx.regs;
  const pi = pl.playItems[item]!;
  const stn = pi.stn;
  let audioLang = 0;

  regs.psrWrite(PSR.PLAYITEM, item);
  regs.psrWrite(PSR.TIME, pi.inTime);

  if (stn.audio.length > 0) {
    const v = regs.psrRead(PSR.PRIMARY_AUDIO_ID);
    if (v === 0 || v > stn.audio.length) {
      audioLang = updateStreamPsrByLang(regs, PSR.AUDIO_LANG, PSR.PRIMARY_AUDIO_ID, 0, stn.audio, 0);
    } else {
      audioLang = langToUint32(stn.audio[v - 1]!.lang);
    }
  }
  if (stn.pg.length > 0) {
    const v = regs.psrRead(PSR.PG_STREAM) & 0xfff;
    if (v === 0 || v > stn.pg.length) {
      updateStreamPsrByLang(regs, PSR.PG_AND_SUB_LANG, PSR.PG_STREAM, 0x80000000, stn.pg, audioLang);
    }
  }
  if (stn.ig.length > 0 && ctx.titleType !== 'undef') {
    const v = regs.psrRead(PSR.IG_STREAM_ID);
    if (v === 0 || v > stn.ig.length) regs.psrWrite(PSR.IG_STREAM_ID, 1);
  }
}

/** _update_time_psr: PSR8 follows the presentation position, within the play item's IN and OUT time. */
export function updateTimePsr(ctx: PlaybackPsrContext, item: number, t: number | undefined): void {
  const pi = ctx.playlist?.playItems[item];
  if (t === undefined || !pi || t < pi.inTime || t > pi.outTime) return;
  ctx.regs.psrWrite(PSR.TIME, t);
}

/** nav_clip_time_search: the clip packet for a clip time within the play item. */
export function clipTimeSearch(ctx: PlaybackPsrContext, item: number, clipTime45: number): number | undefined {
  const pi = ctx.playlist?.playItems[item];
  const geo = ctx.geometry[item];
  if (!pi || !geo) return undefined;
  if (clipTime45 >= pi.outTime) return geo.endPkt;
  return Math.max(lookupSpn(ctx.disc.clips?.get(pi.clipId), clipTime45, true), geo.startPkt);
}

/** s_pos in packets: title_pkt + clip_pkt - start_pkt. */
export function titlePkt(ctx: PlaybackPsrContext, item: number, clipPkt: number): number {
  const geo = ctx.geometry[item];
  return geo ? geo.titlePkt + clipPkt - geo.startPkt : clipPkt;
}

/** _fill_mark: the mark's title_pkt. */
export function markTitlePkt(ctx: PlaybackPsrContext, mark: Mpls['marks'][number]): number {
  const ref = mark.playItemRef >= ctx.geometry.length ? 0 : mark.playItemRef;
  const geo = ctx.geometry[ref];
  const pi = ctx.playlist?.playItems[ref];
  if (!geo || !pi) return 0;
  const clip = ctx.disc.clips?.get(pi.clipId);
  const clipPkt = clip ? lookupSpn(clip, mark.time, true) : geo.startPkt;
  return geo.titlePkt + clipPkt - geo.startPkt;
}

/** nav_chapter_get_current over the ENTRY marks; 0-based. */
function chapterAtPkt(ctx: PlaybackPsrContext, pkt: number): number {
  const chapters = (ctx.playlist?.marks ?? []).filter((m) => m.type === MarkType.ENTRY).map((m) => markTitlePkt(ctx, m));
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]! <= pkt) {
      if (i === chapters.length - 1) return i;
      if (chapters[i + 1]! > pkt) return i;
    }
  }
  return 0;
}

/** _update_chapter_psr at packet position `pkt` of the title. */
export function updateChapterPsrAtPkt(ctx: PlaybackPsrContext, pkt: number): void {
  const hasChapters = ctx.playlist?.marks.some((m) => m.type === MarkType.ENTRY) ?? false;
  if (!isInteractiveTitle(ctx) && hasChapters) ctx.regs.psrWrite(PSR.CHAPTER, chapterAtPkt(ctx, pkt) + 1);
}

/** _is_interactive_title */
export function isInteractiveTitle(ctx: PlaybackPsrContext): boolean {
  if (ctx.titleType === 'undef') return false;
  const title = ctx.regs.psrRead(PSR.TITLE_NUMBER);
  const object = title === TITLE_FIRST_PLAY || title <= ctx.disc.index.titles.length ? indexObjectOf(ctx.disc, title) : undefined;
  return object !== undefined && object.kind !== 'unknown' && INDEX_PLAYBACK_INTERACTIVE.includes(object.playbackType);
}
