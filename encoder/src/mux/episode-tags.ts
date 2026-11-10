// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Matroska tags each episode MKV carries, which Seikou's NAS reads to list and place it
 * (`server/src/encodes/index-store.ts`): where on the disc the episode came from, and, when the user chose one, its
 * AniList entry and episode number.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EpisodeAniList } from '../plan/episode-info';

/** The encoder has no package.json of its own; it carries the repo's version. */
const version = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

/** The `ENCODER` tag's value: `seikou-encode <version>`. */
export const ENCODER_TAG = `seikou-encode ${version}`;

/**
 * An episode's tags: always `SEIKOU_DISC_KEY`, `SEIKOU_PLAYLIST`, `SEIKOU_EPISODE_START_MS` (the playlist time of the
 * episode's first frame, whole milliseconds) and `ENCODER`; with `anilist`, `ANILIST_ID` and `EPISODE`, and
 * `EPISODE_TITLE` when the entry has a non-empty title.
 */
export function episodeTags(o: { discKey: string; playlistId: string; startMs: number; anilist: EpisodeAniList | null }): Record<string, string> {
  const tags: Record<string, string> = {
    SEIKOU_DISC_KEY: o.discKey,
    SEIKOU_PLAYLIST: o.playlistId,
    SEIKOU_EPISODE_START_MS: String(o.startMs),
    ENCODER: ENCODER_TAG,
  };
  if (o.anilist !== null) {
    tags.ANILIST_ID = String(o.anilist.anilistId);
    tags.EPISODE = String(o.anilist.episode);
    if (o.anilist.title) tags.EPISODE_TITLE = o.anilist.title;
  }
  return tags;
}
