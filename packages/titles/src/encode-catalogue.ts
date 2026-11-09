// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The encodes catalogue: the NAS's encoded episodes, known by AniList id and episode, grouped into shows with seasons
 * and films the way the disc catalogue groups AniList entries (it uses that catalogue's series and story-link rules).
 * Pure: no network, no clock. Original code.
 */
import { anilistSeries, artIdOf, isAnilistTv, storyParent } from './catalogue';
import type { Series } from './catalogue';
import type { Entry } from './sources';
import { nextInShow } from './encode-next';
import type { EncodeEpisode, EncodeSeason, EncodeShow } from '@seikou/nas/nas-api';

/** What the catalogue needs of an indexed encode (the server's `EncodeEntry` has all of it). */
export interface EncodeEntryLike {
  readonly id: string;
  readonly anilistId: number;
  readonly episode: number;
  readonly episodeTitle: string | null;
  readonly durationMs: number;
}

export type { EncodeEpisode, EncodeSeason, EncodeShow } from '@seikou/nas/nas-api';

/** The built catalogue. */
export interface EncodeCatalogue {
  /** Shows by name. */
  readonly shows: readonly EncodeShow[];
  /** A show by id, or null. */
  show(id: string): EncodeShow | null;
  /** The source URLs of each poster, by the art id the shows carry. */
  readonly art: ReadonlyMap<string, { readonly small: string; readonly large: string }>;
}

const anilistKey = (n: number): string => `anilist:${n}`;
const entryName = (en: Entry): string => en.names.english ?? en.names.romaji ?? en.names.native ?? en.id;
const numberOf = (id: string): number => Number(id.slice('anilist:'.length));

/** When an entry started, as YYYYMMDD; the year when the day is unknown; last when unknown. */
function startOf(en: Entry, others: ReadonlyMap<string, Entry>): number {
  if (en.startDate != null) return en.startDate;
  for (const o of others.values()) for (const r of o.relations) if (r.id === en.id && r.startDate !== null) return r.startDate;
  return en.year !== null ? en.year * 10000 : Number.MAX_SAFE_INTEGER;
}

/**
 * Groups encodes into shows. A TV entry linked by PREQUEL/SEQUEL to others is a season of their series, in chain order,
 * and the show is the series' root entry; a film or OVA attaches to the series its story relations name and follows the
 * seasons, by start date; one that names none is a show of its own. An AniList id missing from `anilist` is a show
 * named `AniList <id>` until the metadata arrives. Only entries with encodes are listed.
 */
export function buildEncodeCatalogue(encodes: readonly EncodeEntryLike[], anilist: ReadonlyMap<number, Entry>): EncodeCatalogue {
  const byEntry = new Map<number, EncodeEntryLike[]>();
  for (const e of encodes) byEntry.set(e.anilistId, [...(byEntry.get(e.anilistId) ?? []), e]);
  const entries = new Map<string, Entry>();
  for (const [n, en] of anilist) entries.set(anilistKey(n), en);
  const seriesOf = anilistSeries(entries);

  const art = new Map<string, { small: string; large: string }>();
  const posterOf = (en: Entry | undefined): string | null => {
    if (!en?.poster) return null;
    const id = artIdOf(en.poster);
    art.set(id, { small: en.poster.small, large: en.poster.large });
    return id;
  };
  const episodesOf = (n: number): EncodeEpisode[] =>
    (byEntry.get(n) ?? []).map((e) => ({ episode: e.episode, id: e.id, title: e.episodeTitle, durationMs: e.durationMs })).sort((a, b) => a.episode - b.episode);

  // a build per series, found by the series id; films attach to these
  interface Build { readonly series: Series | null; readonly rows: Entry[] }
  const builds = new Map<string, Build>();
  for (const s of seriesOf.values()) if (!builds.has(s.id)) builds.set(s.id, { series: s, rows: [] });
  const lone: Entry[] = [];
  const missing: number[] = [];
  for (const n of [...byEntry.keys()].sort((a, b) => a - b)) {
    const en = entries.get(anilistKey(n));
    if (!en) missing.push(n);
    else if (isAnilistTv(en) && seriesOf.has(en.id)) continue; // a season of its series
    else {
      const parent = storyParent(en, seriesOf, builds, [...builds.values()]);
      if (parent) parent.rows.push(en);
      else lone.push(en);
    }
  }

  const rowSeason = (en: Entry): EncodeSeason => ({
    anilistId: numberOf(en.id), name: entryName(en), kind: en.format === 'MOVIE' ? 'film' : 'other', number: null, episodes: episodesOf(numberOf(en.id)),
  });
  const shows: EncodeShow[] = [];
  for (const b of builds.values()) {
    const series = b.series!;
    const seasons: EncodeSeason[] = [];
    series.members.forEach((m, i) => {
      const n = numberOf(m.id);
      if (!byEntry.has(n)) return;
      const number = series.number.get(m.id) ?? null;
      seasons.push({ anilistId: n, name: number !== null ? `Season ${number}` : entryName(m), kind: 'season', number: number ?? (series.provisional ? null : i + 1), episodes: episodesOf(n) });
    });
    const rows = [...b.rows].sort((x, y) => startOf(x, entries) - startOf(y, entries) || numberOf(x.id) - numberOf(y.id));
    seasons.push(...rows.map(rowSeason));
    if (seasons.length === 0) continue;
    const head = series.members[0]!;
    shows.push({ id: String(numberOf(series.id)), name: entryName(head), poster: posterOf(series.members.find((m) => m.poster !== null)), seasons });
  }
  for (const en of lone) shows.push({ id: String(numberOf(en.id)), name: entryName(en), poster: posterOf(en), seasons: [rowSeason(en)] });
  for (const n of missing) {
    shows.push({ id: String(n), name: `AniList ${n}`, poster: null, seasons: [{ anilistId: n, name: `AniList ${n}`, kind: 'season', number: 1, episodes: episodesOf(n) }] });
  }
  shows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const byId = new Map(shows.map((s) => [s.id, s]));
  return { shows, show: (id) => byId.get(id) ?? null, art };
}

/** The encode that follows `encodeId` in the show holding it, by `nextInShow`'s rule; null for none. */
export function nextEncodeEpisode(catalogue: EncodeCatalogue, encodeId: string): string | null {
  const show = catalogue.shows.find((s) => s.seasons.some((x) => x.episodes.some((e) => e.id === encodeId)));
  return show ? (nextInShow(show, encodeId)?.id ?? null) : null;
}
