/** AniList GraphQL client (https://docs.anilist.co). Pace it with `new Pacer(30, 60_000)`. */
import { RateLimited } from './pacer';
import type { PacedOptions, Pacer } from './pacer';
import { retryAfterMs, SourceUnavailable } from './sources';
import type { Entry, MetadataSource } from './sources';

const ENDPOINT = 'https://graphql.anilist.co';

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  synonyms
  format
  episodes
  duration
  startDate { year month day }
  coverImage { large extraLarge }
  bannerImage
  relations { edges { relationType node { id format startDate { year month day } } } }
`;

const SEARCH = `query ($search: String, $type: MediaType, $format_in: [MediaFormat], $startDate_greater: FuzzyDateInt, $startDate_lesser: FuzzyDateInt) {
  Page(page: 1, perPage: 10) {
    media(search: $search, type: $type, format_in: $format_in, startDate_greater: $startDate_greater, startDate_lesser: $startDate_lesser) {${MEDIA_FIELDS}}
  }
}`;

const ENTRY = `query ($id: Int, $type: MediaType) {
  Media(id: $id, type: $type) {${MEDIA_FIELDS}}
}`;

const SERIES_FORMATS = ['TV', 'TV_SHORT', 'OVA', 'ONA', 'SPECIAL'];

interface FuzzyDate {
  readonly year?: number | null;
  readonly month?: number | null;
  readonly day?: number | null;
}
interface Media {
  readonly id: number;
  readonly title?: { readonly romaji?: string | null; readonly english?: string | null; readonly native?: string | null } | null;
  readonly synonyms?: readonly string[] | null;
  readonly format?: string | null;
  readonly episodes?: number | null;
  readonly duration?: number | null;
  readonly startDate?: FuzzyDate | null;
  readonly coverImage?: { readonly large?: string | null; readonly extraLarge?: string | null } | null;
  readonly bannerImage?: string | null;
  readonly relations?: { readonly edges?: readonly { readonly relationType?: string | null; readonly node?: { readonly id: number; readonly format?: string | null; readonly startDate?: FuzzyDate | null } | null }[] | null } | null;
}

/** AniList's FuzzyDateInt: YYYYMMDD, 00 for an unknown month or day, null without a year. */
const fuzzyDateInt = (d: FuzzyDate | null | undefined): number | null => (d?.year ? d.year * 10_000 + (d.month ?? 0) * 100 + (d.day ?? 0) : null);

function toEntry(m: Media): Entry {
  const cover = m.coverImage;
  return {
    source: 'anilist',
    id: `anilist:${m.id}`,
    kind: m.format === 'MOVIE' ? 'movie' : 'series',
    format: m.format ?? null,
    names: { english: m.title?.english ?? null, romaji: m.title?.romaji ?? null, native: m.title?.native ?? null, synonyms: m.synonyms ?? [] },
    animation: true,
    year: m.startDate?.year ?? null,
    startDate: fuzzyDateInt(m.startDate),
    episodes: m.episodes ?? null,
    runtimeMin: m.duration ?? null,
    seasons: [],
    relations: (m.relations?.edges ?? []).flatMap((e) =>
      e.node && e.relationType ? [{ type: e.relationType, id: `anilist:${e.node.id}`, format: e.node.format ?? null, startDate: fuzzyDateInt(e.node.startDate) }] : [],
    ),
    poster: cover?.large && cover.extraLarge ? { small: cover.large, large: cover.extraLarge } : null,
    banner: m.bannerImage ?? null,
  };
}

type QueryFn = (q: string, variables: Record<string, unknown>, paced?: PacedOptions) => Promise<unknown>;

/**
 * Builds the paced GraphQL request both AniList clients share. The returned
 * function resolves to the response's `data` member, or null on a 404 or an
 * empty answer; it throws `RateLimited` on 429 and `SourceUnavailable` on a
 * network error, another HTTP failure, an unreadable body or a GraphQL error
 * with no data.
 */
function anilistQuery(fetch: typeof globalThis.fetch, pacer: Pacer): QueryFn {
  return (q, variables, paced = {}) =>
    pacer.run(async () => {
      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query: q, variables }),
          signal: paced.signal,
        });
      } catch {
        throw new SourceUnavailable('anilist: network error');
      }
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 429) throw new RateLimited(retryAfterMs(res.headers.get('Retry-After')));
        if (res.status === 404) return null;
        throw new SourceUnavailable(`anilist: HTTP ${res.status}`);
      }
      let body: { data?: unknown; errors?: unknown };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new SourceUnavailable('anilist: unreadable response');
      }
      // A GraphQL error with no data is a failed query, not an empty answer.
      if ((body.data === null || body.data === undefined) && body.errors !== undefined) throw new SourceUnavailable('anilist: query failed');
      return body.data ?? null;
    }, paced);
}

/**
 * AniList as a `MetadataSource` (search and entry by `anilist:<id>`), paced by `pacer`.
 * @example ../examples/create-anilist.ts
 */
export function createAniList(fetch: typeof globalThis.fetch, pacer: Pacer): MetadataSource {
  const query = anilistQuery(fetch, pacer);
  return {
    async search(search, opts = {}) {
      const variables: Record<string, unknown> = { search, type: 'ANIME' };
      if (opts.kind) variables.format_in = opts.kind === 'movie' ? ['MOVIE'] : SERIES_FORMATS;
      if (opts.year !== undefined) {
        variables.startDate_greater = opts.year * 10_000 - 1; // exclusive: YYYY0000 (year only) is in
        variables.startDate_lesser = (opts.year + 1) * 10_000;
      }
      const data = (await query(SEARCH, variables, { urgent: opts.urgent, signal: opts.signal })) as { Page?: { media?: readonly Media[] | null } | null } | null;
      return (data?.Page?.media ?? []).map(toEntry);
    },
    async entry(id, opts = {}) {
      const m = /^anilist:(\d+)$/.exec(id);
      if (!m) return null;
      const data = (await query(ENTRY, { id: Number(m[1]), type: 'ANIME' }, { urgent: opts.urgent, signal: opts.signal })) as { Media?: Media | null } | null;
      return data?.Media ? toEntry(data.Media) : null;
    },
  };
}

const EPISODES = `query ($id: Int, $type: MediaType) {
  Media(id: $id, type: $type) { streamingEpisodes { title } }
}`;

/** A streaming episode title such as "Episode 3 - The Lighthouse": number, separator, name. */
const EPISODE_TITLE = /^Episode (\d+)\s*[-–:]\s*(.+)$/;

/**
 * Episode titles of one AniList show. AniList's ordinary Media data has none,
 * so this reads the streaming service's episode list instead.
 * @internal
 */
export interface AniListEpisodes {
  /**
   * Titles by episode number for the AniList media `alId`. Entries that don't
   * look like "Episode <n> - <name>" are skipped. The map is empty for an
   * unknown id or a show with no streaming episodes (older shows), and the
   * caller then names episodes itself. Throws `RateLimited` or
   * `SourceUnavailable` as the entry client does.
   */
  titles(alId: number, opts?: PacedOptions): Promise<ReadonlyMap<number, string>>;
}

/**
 * Builds the episode-title client; share `pacer` with other AniList clients so one rate limit holds.
 * @internal
 */
export function createAniListEpisodes(fetch: typeof globalThis.fetch, pacer: Pacer): AniListEpisodes {
  const query = anilistQuery(fetch, pacer);
  return {
    async titles(alId, opts = {}) {
      const data = (await query(EPISODES, { id: alId, type: 'ANIME' }, opts)) as { Media?: { streamingEpisodes?: readonly { title?: string | null }[] | null } | null } | null;
      const found = new Map<number, string>();
      for (const e of data?.Media?.streamingEpisodes ?? []) {
        const m = e.title ? EPISODE_TITLE.exec(e.title) : null;
        if (m) found.set(Number(m[1]), m[2]!.trim());
      }
      return new Map([...found].sort((a, b) => a[0] - b[0]));
    },
  };
}
