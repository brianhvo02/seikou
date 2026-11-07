/** What a title's SeaDex entries cover on the owner's discs: its AniList seasons and its movie. Pure; original code. */
import type { Catalogue } from '@seikou/titles/catalogue';

/** One episode of a unit: a season's episode, or a movie's one. */
export interface UnitEpisode {
  readonly number: number;
  readonly discId: string;
  readonly playlistId: string;
}

/** What one SeaDex entry covers: an AniList season of a series, or a movie. */
export interface Unit {
  readonly seasonId: string;
  readonly alId: number;
  /** Null for a movie. */
  readonly season: { readonly count: number; readonly before: number } | null;
  readonly episodes: readonly UnitEpisode[];
}

/**
 * A title's units: each AniList season with episodes (`before` counts the episodes of the seasons ahead of it, for
 * absolute numbers), and a movie's first disc copy, its playlist left empty for the caller to find.
 */
export function titleUnits(catalogue: Catalogue, titleId: string): Unit[] {
  const detail = catalogue.detail(titleId);
  if (!detail) return [];
  const out: Unit[] = [];
  let before = 0;
  for (const s of detail.seasons) {
    const m = /^anilist:(\d+)#season$/.exec(s.id);
    if (!m) continue;
    const count = Math.max(0, ...(s.episodes ?? []).map((e) => e.number));
    if (s.episodes?.length) {
      out.push({ seasonId: s.id, alId: Number(m[1]), season: { count, before }, episodes: s.episodes.map(({ number, discId, playlistId }) => ({ number, discId, playlistId })) });
    }
    before += count;
  }
  const movie = /^anilist:(\d+)$/.exec(titleId);
  if (movie && detail.title.kind === 'movie') {
    const discs = detail.seasons.find((s) => s.id === `${titleId}#discs`)?.discs ?? [];
    const discId = discs[0]?.copies[0]?.discId;
    if (discId !== undefined) out.push({ seasonId: `${titleId}#discs`, alId: Number(movie[1]), season: null, episodes: [{ number: 1, discId, playlistId: '' }] });
  }
  return out;
}
