// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the user said about a playlist's episodes beyond the subtitle record: each chapter's name and each episode's
 * title (an AniList entry, a TMDB season or film, or an own title) and number. Both are keyed by playlist chapter number, not by episode, so regrouping the chapters into
 * other episodes keeps them. One file per disc and playlist, `<data>/chapters/<disc key>/<playlist>.json`.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDiscKey } from '@seikou/nas/disc-key';
import type { EncodeTitle } from '@seikou/nas/encode-title';
import { replaceAtomically } from '@seikou/titles';
import type { SubtitleRecord } from '../subs/record';
import { parseEpisodeSpec, sameEpisodeList, type EpisodeSpec } from './episodes';

/** The names the Episodes page offers for a chapter, besides a custom one. */
export const CHAPTER_NAMES = ['Avant', 'Opening', 'Part A', 'Part B', 'Ending', 'Part C', 'Preview'] as const;

/** One episode's title and number, keyed in the file by the playlist chapter the episode starts at. */
export interface EpisodeTitle {
  readonly title: EncodeTitle;
  readonly episode: number;
  /** The episode's own name, when known. */
  readonly name: string | null;
  /** The show's name, kept for a title the NAS may not know (written as the `TITLE_NAME` tag unless the title is AniList). */
  readonly showName?: string | null;
}

/**
 * The mark that a disc's playlist was checked on the Library's season page: the episode list the user confirmed, the
 * `titlesSignature` of the titles map at that moment, and when (ISO 8601).
 */
export interface CheckedMark {
  readonly episodeSpec: string;
  readonly signature: string;
  readonly at: string;
}

/** Chapter names and AniList choices of one disc playlist, as the file holds them. */
export interface EpisodeInfo {
  /** Playlist chapter number (1-based, as a string key) → name; a chapter with no entry keeps the encoder's naming. */
  readonly chapterNames: Readonly<Record<string, string>>;
  /** First playlist chapter of an episode (as a string key) → its title and number. */
  readonly titles: Readonly<Record<string, EpisodeTitle>>;
  /** Set when the user marked the playlist checked; it holds only while `isChecked` says so. */
  readonly checked?: CheckedMark;
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
/** Longest episode name, in characters. */
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseTitle(value: unknown, what: string): EncodeTitle {
  const t = plainObject(value, what);
  switch (t.source) {
    case 'anilist':
      return { source: 'anilist', anilistId: positiveInteger(t.anilistId, `${what}.anilistId`) };
    case 'tmdb-tv':
      return { source: 'tmdb-tv', tmdbId: positiveInteger(t.tmdbId, `${what}.tmdbId`), season: positiveInteger(t.season, `${what}.season`) };
    case 'tmdb-movie':
      return { source: 'tmdb-movie', tmdbId: positiveInteger(t.tmdbId, `${what}.tmdbId`) };
    case 'own': {
      if (typeof t.ownId !== 'string' || !UUID.test(t.ownId)) return bad(`${what}.ownId: expected a lower-case uuid`);
      return { source: 'own', ownId: t.ownId, season: t.season === null ? null : positiveInteger(t.season, `${what}.season`) };
    }
    default:
      return bad(`${what}.source: expected anilist, tmdb-tv, tmdb-movie or own`);
  }
}

/** A chapter name trimmed, or null when it is not one the file may hold (empty, too long, control characters). */
function cleanName(value: string): string | null {
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_NAME && !CONTROL.test(name) ? name : null;
}

/** Validates `{ chapterNames, titles }` and answers a clean copy with names trimmed; throws `EpisodeInfoError('bad-info')`. */
export function parseEpisodeInfo(value: unknown): Omit<EpisodeInfo, 'savedAt'> {
  const o = plainObject(value, '$');
  const chapterNames: Record<string, string> = {};
  for (const [key, name] of chapterKeys(plainObject(o.chapterNames, 'chapterNames'), 'chapterNames')) {
    if (typeof name !== 'string') bad(`chapterNames.${key}: expected a string`);
    const clean = cleanName(name);
    if (clean === null) bad(`chapterNames.${key}: a name is 1 to ${MAX_NAME} characters, without control characters`);
    chapterNames[key] = clean;
  }
  const titles: Record<string, EpisodeTitle> = {};
  for (const [key, entry] of chapterKeys(plainObject(o.titles, 'titles'), 'titles')) {
    const e = plainObject(entry, `titles.${key}`);
    const name = e.name;
    if (name !== null && (typeof name !== 'string' || name.length > MAX_TITLE)) bad(`titles.${key}.name: expected null or at most ${MAX_TITLE} characters`);
    const showName = e.showName ?? null;
    if (showName !== null && (typeof showName !== 'string' || showName.length > MAX_TITLE)) bad(`titles.${key}.showName: expected null or at most ${MAX_TITLE} characters`);
    titles[key] = {
      title: parseTitle(e.title, `titles.${key}.title`),
      episode: positiveInteger(e.episode, `titles.${key}.episode`),
      name,
      ...(showName === null ? {} : { showName }),
    };
  }
  const checked = o.checked === undefined ? undefined : parseChecked(o.checked);
  return { chapterNames, titles, ...(checked === undefined ? {} : { checked }) };
}

function parseChecked(value: unknown): CheckedMark {
  const c = plainObject(value, 'checked');
  const { episodeSpec, signature, at } = c;
  if (typeof episodeSpec !== 'string' || episodeSpec === '' || episodeSpec.length > MAX_TITLE) bad('checked.episodeSpec: expected a non-empty string');
  if (typeof signature !== 'string' || signature.length > 200_000) bad('checked.signature: expected a string');
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) bad('checked.at: expected an ISO 8601 date');
  return { episodeSpec, signature, at };
}

/** `value` as JSON with every object's keys in order, so equal data gives equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The signature a `CheckedMark` holds: the titles map as canonical JSON (keys sorted at every level). */
export function titlesSignature(titles: Readonly<Record<string, EpisodeTitle>>): string {
  return canonical(titles);
}

/**
 * Whether a playlist counts as checked: its saved info has a mark for this episode list (`sameEpisodeList` on a
 * playlist of `chapters` chapters, so `1-3,4-` and `1-3,4-12` agree) and the signature of the titles map it holds now.
 * Changing the grouping or any episode's title or number clears it. False without info or a mark.
 */
export function isChecked(info: EpisodeInfo | null, episodeSpec: string, chapters: number): boolean {
  const mark = info?.checked;
  if (info === null || mark === undefined) return false;
  return mark.signature === titlesSignature(info.titles) && sameEpisodeList(mark.episodeSpec, episodeSpec, chapters);
}

/** A file the previous version wrote (`anilist: { chapter: { anilistId, episode, title } }`) in the current form. */
function upgraded(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  const o = json as Record<string, unknown>;
  if (o.titles !== undefined || typeof o.anilist !== 'object' || o.anilist === null || Array.isArray(o.anilist)) return json;
  const { anilist, ...rest } = o;
  const titles = Object.fromEntries(
    Object.entries(anilist as Record<string, unknown>).map(([key, entry]) => {
      const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      return [key, { title: { source: 'anilist', anilistId: e.anilistId }, episode: e.episode, name: e.title ?? null }];
    }),
  );
  return { ...rest, titles };
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
      return { ...parseEpisodeInfo(upgraded(json)), savedAt };
    } catch (e) {
      throw new EpisodeInfoError('info-unreadable', `The saved chapter names and episode titles could not be read: ${e instanceof Error ? e.message : String(e)}`);
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
  return moved ? { chapterNames, titles: { ...info?.titles }, ...(info?.checked === undefined ? {} : { checked: info.checked }) } : null;
}
