// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseClpi, type Clpi } from 'seikou/engine/bdmv/clpi-parser';
import { MarkType, parseMpls, type Mpls, type PlayListMark } from 'seikou/engine/bdmv/mpls-parser';

export interface PlaylistItem {
  index: number;
  clipId: string;
  m2tsPath: string;
  clpi: Clpi;
  inTime45: number;
  outTime45: number;
  videoPid: number;
  audioPids: number[];
  connectionCondition: number;
}

export interface Chapter {
  /** 1-based. */
  index: number;
  itemIndex: number;
  /** Clip time in 45 kHz ticks. */
  time45: number;
  /** Playlist time in 45 kHz ticks; 0 at the first item's inTime. */
  start45: number;
}

export interface Playlist {
  id: string;
  discDir: string;
  items: PlaylistItem[];
  chapters: Chapter[];
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

/** Chapters from ENTRY marks that fall inside their play item; pure. */
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

export async function loadPlaylist(discDir: string, playlistId: string): Promise<Playlist> {
  const root = bdmvRoot(discDir);
  const mpls = await readMpls(discDir, playlistId);

  const items: PlaylistItem[] = [];
  for (const [index, p] of mpls.playItems.entries()) {
    const video = p.stn.video.find((e) => !e.subPath);
    if (video === undefined) {
      throw new Error(`Playlist ${playlistId}: play item ${index} (clip ${p.clipId}) has no main-path video stream`);
    }
    const clpi = parseClpi(new Uint8Array(await readFile(join(root, 'CLIPINF', `${p.clipId}.clpi`))));
    items.push({
      index,
      clipId: p.clipId,
      m2tsPath: join(root, 'STREAM', `${p.clipId}.m2ts`),
      clpi,
      inTime45: p.inTime,
      outTime45: p.outTime,
      videoPid: video.pid,
      audioPids: p.stn.audio.filter((e) => !e.subPath).map((e) => e.pid),
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
