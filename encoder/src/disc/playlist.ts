// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseClpi, type Clpi } from '@seikou/bdmv/clpi-parser';
import { MarkType, parseMpls, type Mpls, type PlayListMark } from '@seikou/bdmv/mpls-parser';

// A Blu-ray playlist is an MPLS file: a list of play items, each cutting a range out of one clip
// (a .m2ts transport stream with a matching .clpi clip-info file), plus a table of playlist marks.
// The Blu-ray specification is not public; the field layout followed here is libbluray's parser
// (src/libbluray/bdnav/mpls_parse.c, `_parse_playitem` and `_parse_playlistmark`), which
// `@seikou/bdmv` ports.

/** One play item of a playlist: a time range of one clip, as the MPLS PlayItem structure gives it. */
export interface PlaylistItem {
  /** 0-based position in the playlist; marks refer to it as `play_item_ref`. */
  index: number;
  /** Five-digit clip name (`00001`): the `.m2ts` in STREAM/ and the `.clpi` in CLIPINF/. */
  clipId: string;
  /** Absolute path of the clip's transport stream. */
  m2tsPath: string;
  /** The clip's parsed clip-info file: its streams and entry-point maps. */
  clpi: Clpi;
  /** PlayItem `IN_time`: start of the played range, in 45 kHz ticks of clip time. */
  inTime45: number;
  /** PlayItem `OUT_time`: end of the played range (exclusive), in 45 kHz ticks of clip time. */
  outTime45: number;
  /** PID of the first main-path video stream in the item's STN table. */
  videoPid: number;
  /** PIDs of the main-path audio streams, in STN order (the order players number them). */
  audioPids: number[];
  /** ISO 639-2 language code of each of `audioPids`, in the same order, as the STN entry gives it; empty when it gives none. */
  audioLanguages: string[];
  /**
   * The STN entry's 4-bit audio format code of each of `audioPids` (1 mono, 3 stereo, 6 multi-channel, 12 stereo
   * core with a multi-channel extension), in the same order; `audioChannels` turns it into a count.
   */
  audioFormatCodes: number[];
  /** The STN entry's 4-bit audio rate code of each of `audioPids` (1 is 48 kHz), in the same order; `audioRate` turns it into Hz. */
  audioRateCodes: number[];
  /**
   * PlayItem `connection_condition`: how this item joins the one before it. 1 is a plain
   * (non-seamless) join; 5 and 6 are seamless joins, which libbluray treats alike (the item starts at the
   * clip's first packet).
   */
  connectionCondition: number;
}

/** A chapter: an ENTRY playlist mark that lies inside its play item. */
export interface Chapter {
  /** 1-based. */
  index: number;
  /** The play item the mark lies in (`play_item_ref`). */
  itemIndex: number;
  /** Clip time in 45 kHz ticks. */
  time45: number;
  /** Playlist time in 45 kHz ticks; 0 at the first item's inTime. */
  start45: number;
}

/** A loaded playlist: its play items, its chapters and its total length. */
export interface Playlist {
  /** Five-digit playlist name (`00000`), the MPLS file's name without extension. */
  id: string;
  /** The disc folder exactly as the caller gave it. */
  discDir: string;
  items: PlaylistItem[];
  /** In playlist order; the first always starts at playlist time 0. */
  chapters: Chapter[];
  /** Sum of the items' played ranges, in 45 kHz ticks. */
  duration45: number;
}

/** Accepts the disc folder or its BDMV folder and returns the BDMV folder. */
export function bdmvRoot(dir: string): string {
  return basename(dir) === 'BDMV' ? dir : join(dir, 'BDMV');
}

async function readMpls(discDir: string, playlistId: string): Promise<Mpls> {
  const bytes = await readFile(join(bdmvRoot(discDir), 'PLAYLIST', `${playlistId}.mpls`));
  return parseMpls(new Uint8Array(bytes));
}

/**
 * Lists the disc's playlists, sorted by id, each with its length (the sum of its play items'
 * ranges, in 45 kHz ticks) and the clips it plays. Rejects when PLAYLIST/ is missing or an MPLS
 * file does not parse.
 */
export async function listPlaylists(
  discDir: string,
): Promise<{ id: string; duration45: number; clipIds: string[] }[]> {
  const names = await readdir(join(bdmvRoot(discDir), 'PLAYLIST'));
  const ids = names
    .filter((n) => n.endsWith('.mpls'))
    .map((n) => n.slice(0, -'.mpls'.length))
    .sort();
  const result: { id: string; duration45: number; clipIds: string[] }[] = [];
  for (const id of ids) {
    const mpls = await readMpls(discDir, id);
    result.push({
      id,
      duration45: mpls.playItems.reduce((sum, p) => sum + (p.outTime - p.inTime), 0),
      clipIds: mpls.playItems.map((p) => p.clipId),
    });
  }
  return result;
}

/**
 * Chapters from the playlist's marks; pure. Only ENTRY marks (mark_type 1, a chapter point; the
 * other type, LINK, is a navigation hook) count, and only those whose time lies inside their play
 * item's range, because a mark outside the range can never be reached. Marks are sorted and
 * de-duplicated, and a chapter is added at playlist time 0 when the first mark is later, so every
 * minute of the playlist belongs to some chapter.
 */
export function chaptersFromMarks(
  marks: readonly PlayListMark[],
  items: readonly PlaylistItem[],
): Chapter[] {
  const itemStart45: number[] = [];
  let acc = 0;
  for (const item of items) {
    itemStart45.push(acc);
    acc += item.outTime45 - item.inTime45;
  }

  const kept = marks
    .filter((m) => {
      if (m.type !== MarkType.ENTRY) return false;
      const item = items[m.playItemRef];
      return item !== undefined && item.inTime45 <= m.time && m.time < item.outTime45;
    })
    .map((m) => ({ itemIndex: m.playItemRef, time45: m.time }))
    .sort((a, b) => a.itemIndex - b.itemIndex || a.time45 - b.time45);

  const unique = kept.filter(
    (m, i) => i === 0 || m.itemIndex !== kept[i - 1].itemIndex || m.time45 !== kept[i - 1].time45,
  );

  const chapters = unique.map((m) => ({
    itemIndex: m.itemIndex,
    time45: m.time45,
    start45: itemStart45[m.itemIndex] + (m.time45 - items[m.itemIndex].inTime45),
  }));
  if (items.length > 0 && !chapters.some((c) => c.start45 === 0)) {
    chapters.unshift({ itemIndex: 0, time45: items[0].inTime45, start45: 0 });
  }
  return chapters.map((c, i) => ({ index: i + 1, ...c }));
}

/**
 * Reads one playlist and the clip-info file of each of its play items. Only main-path streams are
 * used (sub-path streams belong to other clips). Rejects when a play item has no main-path video
 * stream, or when a file is missing or does not parse.
 */
export async function loadPlaylist(discDir: string, playlistId: string): Promise<Playlist> {
  const root = bdmvRoot(discDir);
  const mpls = await readMpls(discDir, playlistId);

  const items: PlaylistItem[] = [];
  for (const [index, p] of mpls.playItems.entries()) {
    const video = p.stn.video.find((e) => !e.subPath);
    if (video === undefined) {
      throw new Error(`Playlist ${playlistId}: play item ${index} (clip ${p.clipId}) has no main-path video stream`);
    }
    const mainAudio = p.stn.audio.filter((e) => !e.subPath);
    const clpi = parseClpi(new Uint8Array(await readFile(join(root, 'CLIPINF', `${p.clipId}.clpi`))));
    items.push({
      index,
      clipId: p.clipId,
      m2tsPath: join(root, 'STREAM', `${p.clipId}.m2ts`),
      clpi,
      inTime45: p.inTime,
      outTime45: p.outTime,
      videoPid: video.pid,
      audioPids: mainAudio.map((e) => e.pid),
      audioLanguages: mainAudio.map((e) => e.lang.replace(/\0/g, '').trim()),
      audioFormatCodes: mainAudio.map((e) => e.format),
      audioRateCodes: mainAudio.map((e) => e.rate),
      connectionCondition: p.connectionCondition,
    });
  }

  return {
    id: playlistId,
    discDir,
    items,
    chapters: chaptersFromMarks(mpls.marks, items),
    duration45: items.reduce((sum, i) => sum + (i.outTime45 - i.inTime45), 0),
  };
}
