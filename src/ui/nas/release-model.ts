// SPDX-License-Identifier: LGPL-3.0-or-later
import type { MkvTextExtract } from '@seikou/engine/subs/mkv-extract';
import { episodeOfFile, seasonEpisode } from '@seikou/fansubs/episode-files';

/**
 * The owner's release-upload form, pure: one row for each MKV picked, the episode guessed from its name, the text
 * tracks ticked by language, and whether Upload may go.
 */

/** One picked release file and where its reading and ticking stand. */
export interface ReleaseRow {
  readonly file: File;
  readonly state: 'reading' | 'read' | 'failed';
  /** Share of the file read, 0 to 1. */
  readonly progress: number;
  readonly error: string | null;
  /** The text tracks and fonts found; null until the file has been read. */
  readonly extract: MkvTextExtract | null;
  /** The season's episode number this file is for; null while unknown (the owner sets it). */
  readonly episode: number | null;
  /** The track numbers to upload. */
  readonly ticked: ReadonlySet<number>;
}

/** ISO 639-2 codes (what Matroska holds) for the languages fansubs come in, as the BCP 47 codes the store keeps. */
const ISO_639_2: Readonly<Record<string, string>> = {
  eng: 'en', jpn: 'ja', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', rus: 'ru',
  chi: 'zh', zho: 'zh', kor: 'ko', ara: 'ar', pol: 'pl', tur: 'tr', ind: 'id', vie: 'vi', tha: 'th', dut: 'nl', nld: 'nl',
};

/** A track's language as the store's code: `eng` is `en`; a code with no short form is kept, none at all is `und`. */
export function releaseLanguage(language: string | null): string {
  const code = (language ?? '').trim().toLowerCase();
  return code === '' ? 'und' : (ISO_639_2[code] ?? code);
}

/** A row for a file just picked: reading, with the episode guessed from its name and mapped onto the season. */
export function releaseRow(file: File, season: { readonly count: number; readonly before: number }): ReleaseRow {
  const fileEpisode = episodeOfFile(file.name);
  return {
    file,
    state: 'reading',
    progress: 0,
    error: null,
    extract: null,
    episode: fileEpisode === null ? null : seasonEpisode(fileEpisode, season),
    ticked: new Set(),
  };
}

/** The row once its file has been read: the ASS tracks in `languages` are ticked, English always. */
export function withExtract(row: ReleaseRow, extract: MkvTextExtract, languages: readonly string[]): ReleaseRow {
  const wanted = new Set(['en', ...languages]);
  const ticked = new Set(extract.tracks.filter((t) => t.kind === 'ass' && wanted.has(releaseLanguage(t.language))).map((t) => t.number));
  return { ...row, state: 'read', progress: 1, error: null, extract, ticked };
}

/** The release group a file name starts with in brackets (`[Group] Show - 01.mkv`), or null. */
export function releaseGroup(fileName: string): string | null {
  const m = /^\s*\[([^\]]+)\]/.exec(fileName);
  const group = m?.[1]?.trim() ?? '';
  return group === '' ? null : group;
}

/**
 * True when Upload may go: no file is still being read, none lacks an episode while it has a ticked track, and at
 * least one file has a track ticked. A failed file and a file with nothing to upload don't block the others.
 */
export function canUpload(rows: readonly ReleaseRow[]): boolean {
  if (rows.some((r) => r.state === 'reading')) return false;
  const going = rows.filter((r) => r.state === 'read' && r.ticked.size > 0);
  return going.length > 0 && going.every((r) => r.episode !== null);
}

/**
 * The episodes in the seasons ahead of `seasonId`, for numbering that runs on across seasons: over the seasons in order,
 * each AniList season (`anilist:<id>#season`) counts its highest episode number, as the NAS counts it for Find fansubs.
 */
export function seasonBefore(seasons: readonly { readonly id: string; readonly episodes: readonly { readonly number: number }[] | null }[], seasonId: string): number {
  let before = 0;
  for (const s of seasons) {
    if (s.id === seasonId) return before;
    if (/^anilist:\d+#season$/.test(s.id)) before += Math.max(0, ...(s.episodes ?? []).map((e) => e.number));
  }
  return before;
}
