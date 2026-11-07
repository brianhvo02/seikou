/**
 * TMDB v3 client (https://developer.themoviedb.org). Pace it with `new Pacer(20, 1_000)`.
 * The key goes in the `api_key` parameter and nowhere else: errors never carry the URL, the response or a cause.
 */
import { RateLimited } from './pacer';
import type { PacedOptions, Pacer } from './pacer';
import { retryAfterMs, SourceUnavailable } from './sources';
import type { Entry, MetadataSource } from './sources';

const API = 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p';

interface Show {
  readonly id: number;
  readonly media_type?: string;
  readonly name?: string | null;
  readonly original_name?: string | null;
  readonly title?: string | null;
  readonly original_title?: string | null;
  readonly first_air_date?: string | null;
  readonly release_date?: string | null;
  readonly poster_path?: string | null;
  readonly backdrop_path?: string | null;
  readonly number_of_episodes?: number | null;
  readonly episode_run_time?: readonly number[] | null;
  readonly runtime?: number | null;
  readonly last_episode_to_air?: { readonly runtime?: number | null } | null;
  readonly seasons?: readonly { readonly season_number: number; readonly episode_count: number }[] | null;
  readonly genre_ids?: readonly number[] | null; // search results
  readonly genres?: readonly { readonly id: number }[] | null; // entries
}

/** TMDB's Animation genre. */
const ANIMATION = 16;

const yearOf = (date: string | null | undefined): number | null => {
  const m = /^(\d{4})-/.exec(date ?? '');
  return m ? Number(m[1]) : null;
};

/** A `YYYY-MM-DD` date as YYYYMMDD, or null. */
const dateOf = (date: string | null | undefined): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? '');
  return m ? Number(`${m[1]}${m[2]}${m[3]}`) : null;
};

function toEntry(s: Show, kind: 'series' | 'movie'): Entry {
  const tv = kind === 'series';
  // TV: `episode_run_time` is empty for many newer series; the last aired episode's runtime stands in.
  const runtimeMin = tv ? (s.episode_run_time?.[0] || s.last_episode_to_air?.runtime || null) : (s.runtime ?? null);
  return {
    source: 'tmdb',
    id: `${tv ? 'tmdb-tv' : 'tmdb-movie'}:${s.id}`,
    kind,
    format: null,
    names: { english: (tv ? s.name : s.title) ?? null, romaji: null, native: (tv ? s.original_name : s.original_title) ?? null, synonyms: [] },
    animation: s.genre_ids ? s.genre_ids.includes(ANIMATION) : s.genres ? s.genres.some((g) => g.id === ANIMATION) : null,
    year: yearOf(tv ? s.first_air_date : s.release_date),
    startDate: dateOf(tv ? s.first_air_date : s.release_date),
    episodes: tv ? (s.number_of_episodes ?? null) : null,
    runtimeMin: runtimeMin || null,
    seasons: (s.seasons ?? []).filter((season) => season.season_number > 0).map((season) => ({ number: season.season_number, episodes: season.episode_count, runtimeMin: runtimeMin || null })),
    relations: [],
    poster: s.poster_path ? { small: `${IMAGES}/w342${s.poster_path}`, large: `${IMAGES}/w780${s.poster_path}` } : null,
    banner: s.backdrop_path ? `${IMAGES}/w1280${s.backdrop_path}` : null,
  };
}

export function createTmdb(fetch: typeof globalThis.fetch, pacer: Pacer, apiKey: string): MetadataSource {
  /** GETs one path (logged as the path only); null on 404. */
  const get = (path: string, params: Record<string, string> = {}, paced: PacedOptions = {}): Promise<unknown> =>
    pacer.run(async () => {
      const url = new URL(`${API}${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      url.searchParams.set('api_key', apiKey);
      let res: Response;
      try {
        res = await fetch(url, { headers: { Accept: 'application/json' }, signal: paced.signal });
      } catch {
        throw new SourceUnavailable(`tmdb: network error on ${path}`);
      }
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 429) throw new RateLimited(retryAfterMs(res.headers.get('Retry-After')));
        if (res.status === 404) return null;
        throw new SourceUnavailable(`tmdb: HTTP ${res.status} on ${path}`);
      }
      try {
        return await res.json();
      } catch {
        throw new SourceUnavailable(`tmdb: unreadable response on ${path}`);
      }
    }, paced);

  return {
    async search(query, opts = {}) {
      const params: Record<string, string> = { query, include_adult: 'false' };
      const paced: PacedOptions = { urgent: opts.urgent, signal: opts.signal };
      if (opts.kind === 'series') {
        if (opts.year !== undefined) params.first_air_date_year = String(opts.year);
        const data = (await get('/search/tv', params, paced)) as { results?: readonly Show[] } | null;
        return (data?.results ?? []).map((s) => toEntry(s, 'series'));
      }
      if (opts.kind === 'movie') {
        if (opts.year !== undefined) params.year = String(opts.year);
        const data = (await get('/search/movie', params, paced)) as { results?: readonly Show[] } | null;
        return (data?.results ?? []).map((s) => toEntry(s, 'movie'));
      }
      // search/multi takes no year; the matcher weighs `year` itself.
      const data = (await get('/search/multi', params, paced)) as { results?: readonly Show[] } | null;
      return (data?.results ?? []).flatMap((s) => (s.media_type === 'tv' ? [toEntry(s, 'series')] : s.media_type === 'movie' ? [toEntry(s, 'movie')] : []));
    },
    async entry(id) {
      const m = /^tmdb-(tv|movie):(\d+)$/.exec(id);
      if (!m) return null;
      const data = (await get(`/${m[1]}/${m[2]}`)) as Show | null;
      return data && typeof data.id === 'number' ? toEntry(data, m[1] === 'tv' ? 'series' : 'movie') : null;
    },
  };
}
