/*
 * The disc information BD-J reads: ported from libbluray src/libbluray/bluray.c (_fill_disc_info, bd_get_playlist_info,
 * _get_mpls_info, _fill_title_info, _copy_streams) and bdnav/navigation.c (nav_title_open, _extrapolate_title,
 * _fill_mark, nav_clip_lookup_aspect).
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Clpi } from '@seikou/bdmv/clpi-parser';
import type { IndexObject } from '@seikou/bdmv/index-parser';
import type { StreamEntry } from '@seikou/bdmv/mpls-parser';
import type { DiscModel } from '@seikou/engine/disc/open-disc';
import type { PlaylistInfo, StreamInfo, TitleInfo } from './host';

/** The title number libbluray gives First Play (BLURAY_TITLE_FIRST_PLAY in bluray.h). */
export const TITLE_FIRST_PLAY = 0xffff;
const HDMV_INTERACTIVE = 1;
const BDJ_INTERACTIVE = 3;

/** _fill_disc_info's BLURAY_TITLE for an index object; a zeroed struct for objects of no known type. */
export function titleOf(number: number, o: IndexObject): TitleInfo {
  if (o.kind === 'bdj') return { number, objectType: 'bdj', playbackType: (o.playbackType === BDJ_INTERACTIVE ? 1 : 0) + 2, bdjoName: o.name, hdmvObjectId: null };
  if (o.kind === 'hdmv' && o.movieObjectId !== 0xffff) {
    return { number, objectType: 'hdmv', playbackType: o.playbackType === HDMV_INTERACTIVE ? 1 : 0, bdjoName: null, hdmvObjectId: o.movieObjectId };
  }
  return { number, objectType: 'hdmv', playbackType: 0, bdjoName: null, hdmvObjectId: 0 };
}

/** disc_info.first_play: present when First Play is a BD-J object or an HDMV object other than 0xffff. */
export function firstPlayInfo(disc: DiscModel): TitleInfo | null {
  const fp = disc.index.firstPlay;
  return fp.kind === 'bdj' || (fp.kind === 'hdmv' && fp.movieObjectId !== 0xffff) ? titleOf(TITLE_FIRST_PLAY, fp) : null;
}

/** libbluray's title list: the top menu, the index titles, then First Play (num_titles + 2 entries). */
export function titleInfos(disc: DiscModel): (TitleInfo | null)[] {
  const index = disc.index;
  return [titleOf(0, index.topMenu), ...index.titles.map((t, i) => titleOf(i + 1, t.object)), firstPlayInfo(disc)];
}

/** _copy_streams: subpath_id follows the first entry's stream type, as libbluray reads `si->`. */
function copyStreams(entries: readonly StreamEntry[], clip: Clpi | undefined): StreamInfo[] {
  const first = entries[0];
  const subpathId = first && first.streamType >= 2 && first.streamType <= 4 ? first.subPathId : -1;
  return entries.map((s) => ({
    codingType: s.codingType,
    format: s.format,
    rate: s.rate,
    charCode: s.charCode,
    lang: s.lang,
    pid: s.pid,
    aspect: lookupAspect(clip, s.pid),
    subpathId,
  }));
}

/** nav_clip_lookup_aspect: the aspect ratio the clip's program info gives the stream with `pid`, 0 when none does. */
function lookupAspect(clip: Clpi | undefined, pid: number): number {
  for (const prog of clip?.programs ?? []) for (const ps of prog.streams) if (ps.pid === pid) return ps.aspect;
  return 0;
}

/** bd_get_playlist_info: _get_mpls_info and _fill_title_info for angle 0. */
export function playlistInfo(disc: DiscModel, clips: ReadonlyMap<string, Clpi>, playlist: number): PlaylistInfo | null {
  if (playlist < 0 || playlist > 99999) return null;
  const mpls = disc.playlists.get(String(playlist).padStart(5, '0'));
  if (!mpls) return null;
  const items = mpls.playItems;
  const titleTimes: number[] = [];
  let duration = 0;
  let angleCount = 0;
  for (const pi of items) {
    angleCount = Math.max(angleCount, pi.angleCount);
    titleTimes.push(duration);
    duration = (duration + ((pi.outTime - pi.inTime) >>> 0)) >>> 0;
  }
  const marks = mpls.marks.map((m) => {
    const ref = m.playItemRef < items.length ? m.playItemRef : 0;
    const pi = items[m.playItemRef];
    const titleTime = pi ? (titleTimes[m.playItemRef]! + m.time - pi.inTime) >>> 0 : 0;
    return { type: m.type, playItem: ref, startTicks: BigInt(titleTime) * 2n };
  });
  const clipInfos = items.map((pi) => {
    const clpi = clips.get(pi.clipId);
    return {
      clipId: pi.clipId,
      inTicks: BigInt(pi.inTime) * 2n,
      outTicks: BigInt(pi.outTime) * 2n,
      videoStreams: copyStreams(pi.stn.video, clpi),
      audioStreams: copyStreams(pi.stn.audio, clpi),
      pgStreams: copyStreams([...pi.stn.pg, ...pi.stn.pipPg], clpi),
      igStreams: copyStreams(pi.stn.ig, clpi),
      secondaryAudioStreams: copyStreams(pi.stn.secondaryAudio, clpi),
      secondaryVideoStreams: copyStreams(pi.stn.secondaryVideo, clpi),
    };
  });
  return { playlist, durationTicks: BigInt(duration) * 2n, angleCount, marks, clips: clipInfos };
}
