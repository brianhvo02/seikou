/** MusicBrainz client (https://musicbrainz.org/doc/MusicBrainz_API). Pace it with `new Pacer(1, 1_100)`. Original code. */
import { chooseRelease, normalizeCatalogue } from './music-sources';
import type { MusicArtist, MusicRelease, MusicSource, ReleaseCandidate } from './music-sources';
import { RateLimited } from './pacer';
import type { Pacer } from './pacer';
import { lookupUserAgent, retryAfterMs, SourceUnavailable } from './sources';

const BASE = 'https://musicbrainz.org/ws/2/release';

interface MbArtist {
  readonly id: string;
  readonly name: string;
  readonly 'sort-name'?: string | null;
  readonly aliases?: readonly { readonly name: string; readonly locale?: string | null; readonly primary?: boolean | null }[] | null;
}
interface MbRelease {
  readonly id: string;
  readonly title: string;
  readonly date?: string | null;
  readonly country?: string | null;
  readonly media?: readonly { readonly format?: string | null }[] | null;
  readonly 'label-info'?: readonly { readonly 'catalog-number'?: string | null }[] | null;
  readonly 'artist-credit'?: readonly { readonly artist?: MbArtist | null }[] | null;
  readonly 'release-group'?: { readonly 'primary-type'?: string | null; readonly 'secondary-types'?: readonly string[] | null } | null;
  readonly 'cover-art-archive'?: { readonly front?: boolean | null } | null;
}

export function createMusicBrainz(fetch: typeof globalThis.fetch, pacer: Pacer, contact: string | null = null): MusicSource {
  const userAgent = lookupUserAgent(contact);
  /** One paced GET; null on 404. */
  const get = (url: string): Promise<unknown> =>
    pacer.run(async () => {
      let res: Response;
      try {
        res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
      } catch {
        throw new SourceUnavailable('musicbrainz: network error');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 429 || res.status === 503) throw new RateLimited(retryAfterMs(res.headers.get('Retry-After')));
        if (res.status === 404) return null;
        throw new SourceUnavailable(`musicbrainz: HTTP ${res.status}`);
      }
      try {
        return await res.json();
      } catch {
        throw new SourceUnavailable('musicbrainz: unreadable response');
      }
    });

  const toArtist = (a: MbArtist): MusicArtist => ({
    id: a.id,
    name: a.name,
    sortName: a['sort-name'] ?? null,
    aliases: (a.aliases ?? []).map((x) => ({ name: x.name, locale: x.locale ?? null, primary: x.primary === true })),
  });

  const toRelease = (r: MbRelease): MusicRelease => {
    const secondaryTypes = r['release-group']?.['secondary-types'] ?? [];
    return {
      source: 'musicbrainz',
      id: r.id,
      title: r.title,
      date: r.date ? r.date : null,
      artists: (r['artist-credit'] ?? []).flatMap((c) => (c.artist ? [toArtist(c.artist)] : [])),
      primaryType: r['release-group']?.['primary-type'] ?? null,
      secondaryTypes,
      live: secondaryTypes.includes('Live'),
      cover:
        r['cover-art-archive']?.front === true
          ? { small: `https://coverartarchive.org/release/${r.id}/front-250`, large: `https://coverartarchive.org/release/${r.id}/front-500` }
          : null,
    };
  };

  return {
    async byCatalogue(catalogueNumber) {
      const wanted = normalizeCatalogue(catalogueNumber);
      if (wanted === '') return null;
      const found = (await get(`${BASE}?query=catno:%22${encodeURIComponent(catalogueNumber)}%22&fmt=json&limit=25`)) as { releases?: readonly MbRelease[] | null } | null;
      const candidates: ReleaseCandidate<MbRelease>[] = (found?.releases ?? [])
        .filter((r) => (r['label-info'] ?? []).some((l) => normalizeCatalogue(l['catalog-number'] ?? '') === wanted))
        .map((r) => ({
          item: r,
          bluray: (r.media ?? []).some((m) => /blu-?ray/i.test(m.format ?? '')),
          japan: r.country === 'JP',
          date: r.date ? r.date : null,
          artistKey: r['artist-credit']?.[0]?.artist?.id ?? null,
        }));
      const chosen = chooseRelease(candidates);
      if (!chosen) return null;
      const detail = (await get(`${BASE}/${encodeURIComponent(chosen.id)}?inc=artist-credits+release-groups+media+aliases&fmt=json`)) as MbRelease | null;
      return detail ? toRelease(detail) : null;
    },
  };
}
