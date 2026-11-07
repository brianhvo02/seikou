/** Discogs client (https://www.discogs.com/developers), used only when a token is set. Pace it with `new Pacer(50, 60_000)`. Original code. */
import { chooseRelease, normalizeCatalogue } from './music-sources';
import type { MusicRelease, MusicSource, ReleaseCandidate } from './music-sources';
import { RateLimited } from './pacer';
import type { Pacer } from './pacer';
import { lookupUserAgent, retryAfterMs, SourceUnavailable } from './sources';

const BASE = 'https://api.discogs.com';

interface DgHit {
  readonly id: number;
  readonly title?: string | null;
  readonly catno?: string | null;
  readonly country?: string | null;
  readonly year?: string | number | null;
  readonly format?: readonly string[] | null;
}
interface DgRelease {
  readonly id: number;
  readonly title: string;
  readonly released?: string | null;
  readonly artists?: readonly { readonly id: number; readonly name: string }[] | null;
  readonly formats?: readonly { readonly name?: string | null; readonly descriptions?: readonly string[] | null }[] | null;
  readonly images?: readonly { readonly type?: string | null; readonly uri?: string | null; readonly uri150?: string | null }[] | null;
}

/** Discogs tells artists of the same name apart with a " (2)" suffix. */
const stripSuffix = (name: string): string => name.replace(/ \(\d+\)$/, '').trim();

/** `2021-00-00` is a year, `2021-03-00` a month. */
function toDate(released: string | null | undefined): string | null {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(released ?? '');
  if (!m) return null;
  if (!m[2] || m[2] === '00') return m[1]!;
  if (!m[3] || m[3] === '00') return `${m[1]}-${m[2]}`;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function createDiscogs(fetch: typeof globalThis.fetch, pacer: Pacer, token: string, contact: string | null = null): MusicSource {
  const userAgent = lookupUserAgent(contact);
  /** One paced GET; null on 404. Errors never carry the token or the request's headers. */
  const get = (url: string): Promise<unknown> =>
    pacer.run(async () => {
      let res: Response;
      try {
        res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json', Authorization: `Discogs token=${token}` } });
      } catch {
        throw new SourceUnavailable('discogs: network error');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 429) throw new RateLimited(retryAfterMs(res.headers.get('Retry-After')));
        if (res.status === 404) return null;
        throw new SourceUnavailable(`discogs: HTTP ${res.status}`);
      }
      try {
        return await res.json();
      } catch {
        throw new SourceUnavailable('discogs: unreadable response');
      }
    });

  const toRelease = (r: DgRelease): MusicRelease => {
    const image = (r.images ?? []).find((i) => i.type === 'primary' && i.uri && i.uri150);
    return {
      source: 'discogs',
      id: `discogs:${r.id}`,
      title: r.title,
      date: toDate(r.released),
      artists: (r.artists ?? []).map((a) => ({ id: `discogs-artist:${a.id}`, name: stripSuffix(a.name), sortName: null, aliases: [] })),
      primaryType: null,
      secondaryTypes: [],
      live: (r.formats ?? []).some((f) => (f.descriptions ?? []).includes('Live')),
      cover: image ? { small: image.uri150!, large: image.uri! } : null,
    };
  };

  return {
    async byCatalogue(catalogueNumber) {
      const wanted = normalizeCatalogue(catalogueNumber);
      if (wanted === '') return null;
      const found = (await get(`${BASE}/database/search?catno=${encodeURIComponent(catalogueNumber)}&type=release&per_page=25`)) as { results?: readonly DgHit[] | null } | null;
      const candidates: ReleaseCandidate<DgHit>[] = (found?.results ?? [])
        .filter((h) => normalizeCatalogue(h.catno ?? '') === wanted)
        .map((h) => {
          // A search title reads "Artist - Title"; the artist is the first credit's name.
          const dash = (h.title ?? '').indexOf(' - ');
          return {
            item: h,
            bluray: (h.format ?? []).some((f) => /blu-?ray/i.test(f)),
            japan: h.country === 'Japan',
            date: toDate(h.year === undefined || h.year === null ? null : String(h.year)),
            artistKey: dash > 0 ? stripSuffix(h.title!.slice(0, dash)).toLowerCase() : null,
          };
        });
      const chosen = chooseRelease(candidates);
      if (!chosen) return null;
      const detail = (await get(`${BASE}/releases/${chosen.id}`)) as DgRelease | null;
      return detail ? toRelease(detail) : null;
    },
  };
}
