// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The one rule for the encode after another, shared by the NAS's Up next and the player's Next episode. Pure, and
 * free of the rest of the catalogue, so the app can import it. Original code.
 */
import type { EncodeEpisode, EncodeShow } from '@seikou/nas/nas-api';

/**
 * The episode after `encodeId` in `show`: the next episode number its row holds (a season's, or an OVA's or another
 * non-film row's), else, for a TV season, the first episode of the next season with episodes (in the show's order).
 * Nothing follows a film, a non-season row's last episode or the last season's. Null when the show doesn't hold it.
 */
export function nextInShow(show: EncodeShow, encodeId: string): EncodeEpisode | null {
  const at = show.seasons.findIndex((s) => s.episodes.some((e) => e.id === encodeId));
  if (at < 0) return null;
  const row = show.seasons[at]!;
  if (row.kind === 'film') return null;
  const current = row.episodes.find((e) => e.id === encodeId)!.episode;
  const later = row.episodes.filter((e) => e.episode > current).sort((a, b) => a.episode - b.episode)[0];
  if (later) return later;
  if (row.kind !== 'season') return null;
  const nextSeason = show.seasons.slice(at + 1).find((s) => s.kind === 'season' && s.episodes.length > 0);
  return nextSeason ? ([...nextSeason.episodes].sort((a, b) => a.episode - b.episode)[0] ?? null) : null;
}
