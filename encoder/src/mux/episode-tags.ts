// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Matroska tags each episode MKV carries, which Seikou's NAS reads to list and place it
 * (`server/src/encodes/index-store.ts`): where on the disc the episode came from, and, when the user chose one, its
 * title and episode number.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { titleTags } from '@seikou/nas/encode-title';
import type { EpisodeTitle } from '../plan/episode-info';

/** The encoder has no package.json of its own; it carries the repo's version. */
const version = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

/** The `ENCODER` tag's value: `seikou-encode <version>`. */
export const ENCODER_TAG = `seikou-encode ${version}`;

/**
 * An episode's tags: always `SEIKOU_DISC_KEY`, `SEIKOU_PLAYLIST`, `SEIKOU_EPISODE_START_MS` (the playlist time of the
 * episode's first frame, whole milliseconds) and `ENCODER`; with `title`, the title's tags (`titleTags`: `ANILIST_ID`
 * for AniList, else `SEIKOU_TITLE` and `SEASON` when it has one), `EPISODE`, `EPISODE_TITLE` when the episode has a
 * non-empty name, and for a title that is not AniList `TITLE_NAME`, the show's name, when the choice has one.
 */
export function episodeTags(o: { discKey: string; playlistId: string; startMs: number; title: EpisodeTitle | null }): Record<string, string> {
  const tags: Record<string, string> = {
    SEIKOU_DISC_KEY: o.discKey,
    SEIKOU_PLAYLIST: o.playlistId,
    SEIKOU_EPISODE_START_MS: String(o.startMs),
    ENCODER: ENCODER_TAG,
  };
  if (o.title !== null) {
    Object.assign(tags, titleTags(o.title.title));
    tags.EPISODE = String(o.title.episode);
    if (o.title.name) tags.EPISODE_TITLE = o.title.name;
    if (o.title.title.source !== 'anilist' && o.title.showName) tags.TITLE_NAME = o.title.showName;
  }
  return tags;
}
