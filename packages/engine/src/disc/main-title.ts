/*
 * Ported from libbluray src/libbluray/bdnav/navigation.c
 * (_filter_repeats, _pl_cmp, _pl_guess_main_title and helpers)
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { MarkType, type Mpls, type StnTable, type StreamEntry } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';

export interface MainTitleCandidate {
  readonly id: string;
  readonly mpls: Mpls;
}

const THIRTY_MINUTES_45K = 30 * 60 * 45_000;
/** STN video_format values (libbluray mpls_data.h). */
const VIDEO_FORMAT_1080I = 4;
const VIDEO_FORMAT_1080P = 6;
const VIDEO_FORMAT_2160P = 8;

function duration45(pl: Mpls): number {
  return pl.playItems.reduce((sum, pi) => sum + (pi.outTime - pi.inTime), 0);
}

function chapterCount(pl: Mpls): number {
  return pl.marks.filter((m) => m.type === MarkType.ENTRY).length;
}

function streamsScore(pl: Mpls): number {
  let audio = 0;
  let pg = 0;
  for (const pi of pl.playItems) {
    audio = Math.max(audio, pi.stn.audio.length);
    pg = Math.max(pg, pi.stn.pg.length);
  }
  return audio * 2 + pg;
}

/** True when one segment (same clip, in and out time) is played more than `repeats` times: a maze or loop playlist. */
export function hasRepeatedSegments(pl: Mpls, repeats = 2): boolean {
  const counts = new Map<string, number>();
  for (const pi of pl.playItems) {
    const key = `${pi.clipId}:${pi.inTime}:${pi.outTime}`;
    const n = (counts.get(key) ?? 0) + 1;
    if (n > repeats) return true;
    counts.set(key, n);
  }
  return false;
}

function sameStreams(a: readonly StreamEntry[], b: readonly StreamEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.pid === b[i].pid && s.codingType === b[i].codingType && s.format === b[i].format && s.rate === b[i].rate && s.lang === b[i].lang && s.subPath === b[i].subPath)
  );
}

function sameStn(a: StnTable, b: StnTable): boolean {
  return sameStreams(a.video, b.video) && sameStreams(a.audio, b.audio) && sameStreams(a.pg, b.pg) && sameStreams(a.ig, b.ig);
}

/** Same play items, marks and streams. (libbluray also compares sub-paths and secondary streams, which this model does not keep.) */
export function samePlaylist(a: Mpls, b: Mpls): boolean {
  if (a.playItems.length !== b.playItems.length || a.marks.length !== b.marks.length) return false;
  const marksMatch = a.marks.every((m, i) => {
    const n = b.marks[i];
    return m.type === n.type && m.playItemRef === n.playItemRef && m.time === n.time && m.entryEsPid === n.entryEsPid && m.duration === n.duration;
  });
  return (
    marksMatch &&
    a.playItems.every((pi, i) => {
      const pj = b.playItems[i];
      return pi.clipId === pj.clipId && pi.inTime === pj.inTime && pi.outTime === pj.outTime && sameStn(pi.stn, pj.stn);
    })
  );
}

function videoProps(stn: StnTable): { format: number; codec: number } {
  let format = 0;
  let codec = 0;
  for (const v of stn.video) {
    if (v.codingType > 4 && codec < 1) codec = 1; // anything newer than MPEG-1/2 video, as in libbluray
    if (v.codingType === CodingType.HEVC) codec = 2;
    if ((v.format === VIDEO_FORMAT_1080I || v.format === VIDEO_FORMAT_1080P) && format < 1) format = 1;
    if (v.format === VIDEO_FORMAT_2160P) format = 2;
  }
  return { format, codec };
}

/**
 * libbluray compares the audio *format* field (channel layout) with coding-type constants here, which never
 * matches; this port compares the coding type, as intended: LPCM, TrueHD and newer count as HD audio.
 */
function hasHdAudio(stn: StnTable): boolean {
  return stn.audio.some((a) => a.codingType === CodingType.LPCM || a.codingType >= CodingType.TRUEHD);
}

/** Negative when `p1` is the better main title, positive when `p2` is, 0 when they tie. */
export function compareMainTitle(p1: Mpls, p2: Mpls): number {
  const d1 = duration45(p1);
  const d2 = duration45(p2);
  if (d1 > THIRTY_MINUTES_45K && d2 > THIRTY_MINUTES_45K) {
    const chap1 = chapterCount(p1);
    const chap2 = chapterCount(p2);
    const chapDiff = chap2 - chap1;
    if ((chap1 < 2 || chap2 < 2) && (chapDiff < -5 || chapDiff > 5)) return chapDiff;

    const v1 = videoProps(p1.playItems[0].stn);
    const v2 = videoProps(p2.playItems[0].stn);
    if (v1.format !== v2.format) return v2.format - v1.format;
    if (v1.codec !== v2.codec) return v2.codec - v1.codec;

    const audioDiff = Number(hasHdAudio(p2.playItems[0].stn)) - Number(hasHdAudio(p1.playItems[0].stn));
    if (audioDiff !== 0) return audioDiff;
    // libbluray next prefers playlists named in BD-J disc properties; there is no BD-J here.
  }
  if (d1 !== d2) return d1 < d2 ? 1 : -1;
  return streamsScore(p2) - streamsScore(p1);
}

/**
 * The main feature among playable playlists, as libbluray's title list picks it: loops and exact duplicates
 * are not candidates. Unlike libbluray (whose tie winner depends on directory order), a full tie goes to the
 * lower playlist number. When every playlist loops, the longest one is used.
 */
export function chooseMainTitle(candidates: readonly MainTitleCandidate[]): string | null {
  const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const relevant: MainTitleCandidate[] = [];
  for (const c of ordered) {
    if (c.mpls.playItems.length === 0 || hasRepeatedSegments(c.mpls)) continue;
    if (relevant.some((r) => samePlaylist(r.mpls, c.mpls))) continue;
    relevant.push(c);
  }
  if (relevant.length === 0) {
    let longest: MainTitleCandidate | null = null;
    for (const c of ordered) if (!longest || duration45(c.mpls) > duration45(longest.mpls)) longest = c;
    return longest?.id ?? null;
  }
  let main = relevant[0];
  for (const c of relevant.slice(1)) if (compareMainTitle(c.mpls, main.mpls) < 0) main = c;
  return main.id;
}
