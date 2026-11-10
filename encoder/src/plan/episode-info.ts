// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the user said about a playlist's episodes beyond the subtitle record: each chapter's name and each episode's
 * AniList entry and number. Both are keyed by playlist chapter number, not by episode, so regrouping the chapters into
 * other episodes keeps them. One file per disc and playlist, `<data>/chapters/<disc key>/<playlist>.json`.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDiscKey } from '@seikou/nas/disc-key';
import { replaceAtomically } from '@seikou/titles';
import type { SubtitleRecord } from '../subs/record';
import { parseEpisodeSpec, type EpisodeSpec } from './episodes';

/** The names the Episodes page offers for a chapter, besides a custom one. */
export const CHAPTER_NAMES = ['Avant', 'Opening', 'Part A', 'Part B', 'Ending', 'Part C', 'Preview'] as const;

/** AniList's place for one episode, keyed in the file by the playlist chapter the episode starts at. */
export interface EpisodeAniList {
  readonly anilistId: number;
  readonly episode: number;
  readonly title: string | null;
}

/** Chapter names and AniList choices of one disc playlist, as the file holds them. */
export interface EpisodeInfo {
  /** Playlist chapter number (1-based, as a string key) → name; a chapter with no entry keeps the encoder's naming. */
  readonly chapterNames: Readonly<Record<string, string>>;
  /** First playlist chapter of an episode (as a string key) → its AniList entry and number. */
  readonly anilist: Readonly<Record<string, EpisodeAniList>>;
  /** ISO 8601, set by the store on save. */
  readonly savedAt: string;
}

/** `bad-info`: a value that fails validation; `info-unreadable`: a saved file that is not valid JSON or not valid info. */
export class EpisodeInfoError extends Error {
  constructor(
    readonly code: 'bad-info' | 'info-unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'EpisodeInfoError';
  }
}

/** Most entries in either map. */
const MAX_ENTRIES = 999;
/** Longest chapter name, in characters, after trimming. */
const MAX_NAME = 100;
/** Longest AniList episode title, in characters. */
const MAX_TITLE = 300;
/** C0 and C1 control characters and DEL. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The encoder's own chapter name, which counts as no name. */
const DEFAULT_NAME = /^Chapter \d+$/;

function bad(message: string): never {
  throw new EpisodeInfoError('bad-info', message);
}

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad(`${what}: expected an object`);
  return value as Record<string, unknown>;
}

function chapterKeys(map: Record<string, unknown>, what: string): [string, unknown][] {
  const entries = Object.entries(map);
  if (entries.length > MAX_ENTRIES) bad(`${what}: at most ${MAX_ENTRIES} entries`);
  for (const [key] of entries) if (!/^[1-9]\d*$/.test(key)) bad(`${what}.${key}: expected a chapter number from 1, without leading zeros`);
  return entries;
}

function positiveInteger(value: unknown, what: string): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : bad(`${what}: expected a whole number from 1`);
}

/** A chapter name trimmed, or null when it is not one the file may hold (empty, too long, control characters). */
function cleanName(value: string): string | null {
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_NAME && !CONTROL.test(name) ? name : null;
}

/** Validates `{ chapterNames, anilist }` and answers a clean copy with names trimmed; throws `EpisodeInfoError('bad-info')`. */
export function parseEpisodeInfo(value: unknown): Omit<EpisodeInfo, 'savedAt'> {
  const o = plainObject(value, '$');
  const chapterNames: Record<string, string> = {};
  for (const [key, name] of chapterKeys(plainObject(o.chapterNames, 'chapterNames'), 'chapterNames')) {
    if (typeof name !== 'string') bad(`chapterNames.${key}: expected a string`);
    const clean = cleanName(name);
    if (clean === null) bad(`chapterNames.${key}: a name is 1 to ${MAX_NAME} characters, without control characters`);
    chapterNames[key] = clean;
  }
  const anilist: Record<string, EpisodeAniList> = {};
  for (const [key, entry] of chapterKeys(plainObject(o.anilist, 'anilist'), 'anilist')) {
    const e = plainObject(entry, `anilist.${key}`);
    const title = e.title;
    if (title !== null && (typeof title !== 'string' || title.length > MAX_TITLE)) bad(`anilist.${key}.title: expected null or at most ${MAX_TITLE} characters`);
    anilist[key] = {
      anilistId: positiveInteger(e.anilistId, `anilist.${key}.anilistId`),
      episode: positiveInteger(e.episode, `anilist.${key}.episode`),
      title,
    };
  }
  return { chapterNames, anilist };
}

/** Reads and saves episode info under `<dataDir>/chapters/<discKey>/<playlist>.json`. */
export class EpisodeInfoStore {
  constructor(private readonly dataDir: string) {}

  /** The file of a disc's playlist; throws `bad-info` unless the key is a disc key and the playlist five digits, so no segment can leave `chapters/`. */
  private path(discKey: string, playlistId: string): string {
    if (!parseDiscKey(discKey)) bad('expected a disc key');
    if (!/^\d{5}$/.test(playlistId)) bad('expected a five-digit playlist id');
    return join(this.dataDir, 'chapters', discKey, `${playlistId}.json`);
  }

  /** The saved info, or null when none was saved; a file that is not valid rejects with `info-unreadable`. */
  async read(discKey: string, playlistId: string): Promise<EpisodeInfo | null> {
    let text: string;
    try {
      text = await readFile(this.path(discKey, playlistId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const json: unknown = JSON.parse(text);
      const savedAt = (json as { savedAt?: unknown }).savedAt;
      if (typeof savedAt !== 'string') bad('savedAt: expected a string');
      return { ...parseEpisodeInfo(json), savedAt };
    } catch (e) {
      throw new EpisodeInfoError('info-unreadable', `The saved chapter names and AniList choices could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Validates `info`, stamps `savedAt` and replaces the file atomically; answers what was stored. */
  async save(discKey: string, playlistId: string, info: Omit<EpisodeInfo, 'savedAt'>): Promise<EpisodeInfo> {
    const file = this.path(discKey, playlistId);
    const stored: EpisodeInfo = { ...parseEpisodeInfo(info), savedAt: new Date().toISOString() };
    await mkdir(dirname(file), { recursive: true });
    replaceAtomically(file, `${JSON.stringify(stored, null, 2)}\n`);
    return stored;
  }
}

/** The name chapter `n` (1-based, playlist numbering) gets, or null for the encoder's own. */
export function chapterName(info: EpisodeInfo | null, n: number): string | null {
  return info?.chapterNames[String(n)] ?? null;
}

/** A name the record holds that counts as one: not empty, not the encoder's own `Chapter <n>`, and one the file may hold. */
function realName(raw: string): string | null {
  const name = cleanName(raw);
  return name === null || DEFAULT_NAME.test(name) ? null : name;
}

/** Whether any episode of `record` names a chapter (an empty name and `Chapter <n>` do not). */
export function hasChapterNames(record: SubtitleRecord): boolean {
  return record.episodes.some((e) => e.metadata.chapters.some((c) => realName(c) !== null));
}

/**
 * Moves a record's per-episode chapter names into `info` (first time only: names already in `info` win). Episode
 * `index` of the record is range `index` of `episodeSpec` on a playlist of `chapters` chapters, and its name `i` is
 * playlist chapter `from + i`. Empty names, the encoder's own `Chapter <n>`, names a chapter file may not hold and
 * names past the episode's last chapter are not moved. Answers null when nothing is moved, also for a spec that does
 * not parse.
 */
export function migrateRecordChapters(
  info: EpisodeInfo | null,
  record: SubtitleRecord,
  episodeSpec: string,
  chapters: number,
): Omit<EpisodeInfo, 'savedAt'> | null {
  let specs: EpisodeSpec[];
  try {
    specs = parseEpisodeSpec(episodeSpec, chapters);
  } catch {
    return null;
  }
  const chapterNames: Record<string, string> = { ...info?.chapterNames };
  let moved = false;
  for (const episode of record.episodes) {
    const spec = specs[episode.index - 1];
    if (spec === undefined) continue;
    const last = spec.to ?? chapters;
    episode.metadata.chapters.forEach((raw, i) => {
      const n = spec.from + i;
      const name = realName(raw);
      if (n > last || name === null || String(n) in chapterNames) return;
      chapterNames[String(n)] = name;
      moved = true;
    });
  }
  return moved ? { chapterNames, anilist: { ...info?.anilist } } : null;
}
