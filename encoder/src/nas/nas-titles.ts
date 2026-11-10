// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeId } from '@seikou/nas/encode-id';
import type { EncodeTitle } from '@seikou/nas/encode-title';
import type { DiscSlot, EpisodeRef, TitleDetail, TitleSummary, UnsortedItem } from '@seikou/nas/nas-api';
import { replaceAtomically } from '@seikou/titles';
import { EpisodeInfoError, EpisodeInfoStore, isChecked } from '../plan/episode-info';
import { loadPlaylist } from '../disc/playlist';
import { EpisodeSpecError, parseEpisodeSpec } from '../plan/episodes';
import { RecordError, RecordStore } from '../subs/record';
import type { AppContext } from '../server/http';
import { sessionsOf } from '../server/sessions';
import { NasError, type NasClient } from './client';
import { nasLibraryOf, type NasDisc } from './nas-library';

// The NAS's catalogue as the encoder's Library by show reads it: the shows (series and films) with their seasons,
// discs and episodes, the discs nothing filed (Unsorted), and which episodes the Encodes library already holds, each
// joined to the encoder's own disc keys. The last answer is kept in `<data>/nas-titles.json`, so a NAS that cannot be
// reached still shows what it showed last.

/**
 * The title the encodes of a NAS season are tagged with, from the season's id; null when the NAS has no title for it
 * yet (`anilist:<n>#s<n>`: a season of a chain not loaded yet).
 *
 *   anilist:N#season, anilist:N#discs   → AniList N
 *   tmdb-tv:N#s<n>                      → TMDB series N, season n
 *   tmdb-movie:N#discs                  → TMDB film N
 *   own:<uuid>#s<n>, own:<uuid>#discs   → an own title, with the season or none
 */
export function seasonTitle(seasonId: string): EncodeTitle | null {
  const n = '([1-9]\\d{0,14})';
  const uuid = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  let m = new RegExp(`^anilist:${n}#(?:season|discs)$`).exec(seasonId);
  if (m) return { source: 'anilist', anilistId: Number(m[1]) };
  m = new RegExp(`^tmdb-tv:${n}#s${n}$`).exec(seasonId);
  if (m) return { source: 'tmdb-tv', tmdbId: Number(m[1]), season: Number(m[2]) };
  m = new RegExp(`^tmdb-movie:${n}#discs$`).exec(seasonId);
  if (m) return { source: 'tmdb-movie', tmdbId: Number(m[1]) };
  m = new RegExp(`^own:${uuid}#s${n}$`).exec(seasonId);
  if (m) return { source: 'own', ownId: m[1]!, season: Number(m[2]) };
  m = new RegExp(`^own:${uuid}#discs$`).exec(seasonId);
  if (m) return { source: 'own', ownId: m[1]!, season: null };
  return null;
}

/** One show in the Library's list. */
export interface NasShow {
  /** The NAS's title id (`anilist:<n>`, `tmdb-tv:<n>`, `tmdb-movie:<n>`, `own:<uuid>`). */
  readonly titleId: string;
  readonly name: string;
  /** The backend's route of the poster (`/api/nas/art/<id>`), or null. */
  readonly poster: string | null;
  readonly kind: 'series' | 'movie';
  /** Numbered seasons. */
  readonly seasons: number;
  /** Seasons without a number: a film's or an entry's disc-only discs. */
  readonly films: number;
  /** Disc slots over all its seasons and films. */
  readonly discs: number;
  /** Episodes the NAS lists for the show that the Encodes library already holds. */
  readonly encoded: number;
  /** Episodes the NAS lists for the show that it does not hold yet. */
  readonly toEncode: number;
}

/** A disc the NAS holds that no title claims, as the encoder's mirror names it. */
export interface NasUnsorted {
  /** The encoder's disc key. */
  readonly key: string;
  readonly label: string;
  readonly relPath: string;
}

/** What `GET /api/nas/shows` answers. */
export interface ShowsAnswer {
  readonly shows: NasShow[];
  readonly unsorted: NasUnsorted[];
  /** Whether the NAS answered now; false serves the last answer kept here. */
  readonly reachable: boolean;
  /** Whether the answer is the kept one, or the NAS's encodes list could not be read now (so the counts may be old). */
  readonly stale: boolean;
}

/** One episode a NAS disc holds. */
export interface NasEpisode {
  readonly number: number;
  readonly name: string | null;
  /** Whether the Encodes library holds this episode under the season's title. */
  readonly encoded: boolean;
}

/** One disc of a season. */
export interface NasSeasonDisc {
  /** The encoder's disc key; null while the encoder mirrors none of the slot's copies (`available` is then false). */
  readonly key: string | null;
  /** The NAS's disc id (of the copy the episodes name, else the first copy). */
  readonly discId: string;
  readonly label: string;
  /** Whether the encoder mirrors a copy of this disc, so it can be checked and encoded. */
  readonly available: boolean;
  readonly playlists: { readonly id: string; readonly episodes: NasEpisode[] }[];
  /**
   * Checked: every playlist the NAS lists episodes for is checked (`isChecked` of its saved info, on the playlist's real
   * chapter count); a disc with none listed counts as checked once any playlist saved for it is. An unavailable disc
   * is never checked.
   */
  readonly checked: boolean;
  /**
   * The disc's checked playlists, each with the episode list a job of it must be queued with (the saved subtitle
   * record's, else the mark's) and, per episode of that list, the number its saved title gives it (null for none). For
   * a disc the NAS lists episodes for, only those playlists; else every checked playlist saved for it.
   */
  readonly checkedPlaylists: CheckedPlaylist[];
}

/** A checked playlist of a disc: its episode list, and the episode number each of its episodes was given. */
export interface CheckedPlaylist {
  readonly id: string;
  readonly episodeSpec: string;
  readonly episodes: (number | null)[];
}

/** One season (or, with `number: null`, a film or a disc-only group) of a show. */
export interface NasSeason {
  readonly id: string;
  readonly label: string;
  readonly number: number | null;
  /** The title this season's encodes are tagged with; null while the NAS has none for it. */
  readonly title: EncodeTitle | null;
  readonly discs: NasSeasonDisc[];
}

/** What `GET /api/nas/shows/<titleId>` answers. */
export interface ShowAnswer {
  readonly title: { readonly titleId: string; readonly name: string; readonly poster: string | null; readonly kind: 'series' | 'movie' };
  readonly seasons: NasSeason[];
  readonly reachable: boolean;
  readonly stale: boolean;
}

/** Where the NAS files a disc the encoder mirrors, and the episodes it lists on it. */
export interface DiscMatch {
  /** The NAS's id of the disc as the encoder mirrors it (what `admin/discs/<id>/choice` takes). */
  readonly discId: string;
  /** Every NAS disc id the encoder's mirror holds for this disc key (copies of one disc). */
  readonly discIds: readonly string[];
  /** The title the NAS files the disc under (its season's title); null for a disc in Unsorted, or a season whose title is not known yet. */
  readonly title: EncodeTitle | null;
  /** The NAS's id of the show the disc is filed under; null for a disc in Unsorted. */
  readonly titleId: string | null;
  /** The episodes the NAS lists on the disc, by playlist, in number order. */
  readonly episodes: readonly { readonly playlistId: string; readonly number: number; readonly name: string | null }[];
}

/** What the NAS answered, kept whole in `nas-titles.json`. */
interface Raw {
  readonly base: string;
  readonly titles: TitleSummary[];
  readonly details: Record<string, TitleDetail>;
  readonly unsorted: UnsortedItem[];
  readonly ids: string[];
  /** When each title's detail was read (ms since the epoch); a detail younger than `DETAIL_TTL_MS` is not asked for again. */
  readonly detailAt: Record<string, number>;
}

/** How long a title's detail is reused from the kept answer. */
export const DETAIL_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DETAILS_AT_ONCE = 6;
const UNSORTED_PAGE = 200;
/** The most Unsorted discs read, so a NAS answering without end cannot keep it going. */
const MAX_UNSORTED = 20_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The saved answer, or null when it is missing or not shaped as `Raw`. */
async function readSaved(file: string): Promise<Raw | null> {
  try {
    const v: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isObject(v) || typeof v.base !== 'string' || !Array.isArray(v.titles) || !isObject(v.details) || !Array.isArray(v.unsorted) || !Array.isArray(v.ids)) return null;
    return { ...(v as unknown as Raw), detailAt: isObject(v.detailAt) ? (v.detailAt as Record<string, number>) : {} };
  } catch {
    return null;
  }
}

function showName(t: TitleSummary): string {
  return t.names.display ?? t.names.english ?? t.names.romaji ?? t.names.native ?? t.id;
}

const posterRoute = (artId: string | null): string | null => (artId === null ? null : `/api/nas/art/${artId}`);

/** What one read of the NAS gave. */
interface Fetched {
  readonly raw: Raw | null;
  readonly reachable: boolean;
  readonly stale: boolean;
}

/** The NAS's catalogue for one app. */
export class NasTitles {
  private saved: Raw | null = null;
  private loaded = false;
  /** The text of `nas-titles.json` as last read or written, so an unchanged answer is not written again. */
  private written: string | null = null;
  /** Playlist chapter counts of mirrored discs, by disc key and playlist. */
  private readonly chapterCounts = new Map<string, number | null>();

  /** `now` is the clock the detail reuse reads (tests move it). */
  constructor(
    private readonly app: AppContext,
    private readonly now: () => number = Date.now,
  ) {}

  private get file(): string {
    return join(this.app.dataDir, 'nas-titles.json');
  }

  /** The kept answer of the NAS the app is paired with now, or null. */
  private async last(client: NasClient): Promise<Raw | null> {
    if (!this.loaded) {
      this.loaded = true;
      this.saved ??= await readSaved(this.file);
      if (this.saved !== null) this.written = JSON.stringify(this.saved);
    }
    return this.saved !== null && this.saved.base === client.base ? this.saved : null;
  }

  /** Forgets the kept answer held in memory (the pairing changed). */
  forget(): void {
    this.saved = null;
    this.loaded = false;
    this.written = null;
    this.chapterCounts.clear();
  }

  /** Keeps `raw`, writing `nas-titles.json` only when its content changed. */
  private store(raw: Raw): void {
    this.saved = raw;
    const text = JSON.stringify(raw);
    if (text === this.written) return;
    try {
      replaceAtomically(this.file, `${text}\n`);
      this.written = text;
    } catch {
      // kept in memory; the next answer writes it again
    }
  }

  /** `encodes/ids`: the ids, `[]` for a NAS that keeps no encodes, `undefined` when it did not answer. */
  private async encodeIds(client: NasClient): Promise<string[] | undefined> {
    try {
      const res = await client.request('encodes/ids', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 404) {
        await res.body?.cancel();
        return [];
      }
      if (!res.ok) {
        await res.body?.cancel();
        return undefined;
      }
      const body = (await res.json()) as { ids?: unknown };
      return Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === 'string') : undefined;
    } catch (e) {
      if (e instanceof NasError && e.code === 'unauthorized') throw e;
      return undefined;
    }
  }

  private async unsorted(client: NasClient): Promise<UnsortedItem[] | undefined> {
    const items: UnsortedItem[] = [];
    try {
      for (let offset = 0; offset < MAX_UNSORTED; ) {
        const page = await client.json<{ items?: UnsortedItem[]; total?: number }>(`admin/unsorted?offset=${offset}&limit=${UNSORTED_PAGE}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const got = page.items ?? [];
        items.push(...got);
        offset += got.length;
        if (got.length === 0 || offset >= (page.total ?? 0)) break;
      }
      return items;
    } catch (e) {
      if (e instanceof NasError && e.code === 'unauthorized') throw e;
      return undefined;
    }
  }

  private async detail(client: NasClient, id: string): Promise<TitleDetail | undefined> {
    try {
      return await client.json<TitleDetail>(`titles/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      if (e instanceof NasError && e.code === 'unauthorized') throw e;
      return undefined;
    }
  }

  /**
   * Asks the NAS for its title list and encoded ids every time (cheap, and the counts follow new encodes). A title's
   * detail comes from the kept answer while it is younger than `DETAIL_TTL_MS`, unless `refresh` is set; with `only`,
   * that one title's detail is always read and merged into the kept ones. The Unsorted discs are read for the list
   * only. A NAS that does not answer the title list gives the kept answer (`reachable` false); one part failing alone
   * keeps that part of the kept answer (`stale`). Rejects with `NasError` `unauthorized` when the NAS forgot this device.
   */
  private async fetch(client: NasClient, o: { only?: string | readonly string[]; refresh?: boolean; unsorted?: boolean } = {}): Promise<Fetched> {
    const only = o.only === undefined ? undefined : new Set(typeof o.only === 'string' ? [o.only] : o.only);
    const kept = await this.last(client);
    let list: TitleSummary[];
    try {
      list = (await client.json<{ titles: TitleSummary[] }>('titles', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).titles ?? [];
    } catch (e) {
      if (e instanceof NasError && e.code === 'unauthorized') throw e;
      return { raw: kept, reachable: false, stale: true };
    }
    const titles = list.filter((t) => t.kind === 'series' || t.kind === 'movie');
    let stale = false;
    const now = this.now();
    const details: Record<string, TitleDetail> = {};
    const detailAt: Record<string, number> = {};
    const toRead: TitleSummary[] = [];
    for (const t of titles) {
      const old = kept?.details[t.id];
      const at = kept?.detailAt[t.id];
      const fresh = old !== undefined && at !== undefined && now - at < DETAIL_TTL_MS && now >= at;
      const wanted = only === undefined ? o.refresh === true || !fresh : only.has(t.id);
      if (wanted) toRead.push(t);
      else if (old !== undefined) {
        details[t.id] = old;
        detailAt[t.id] = at ?? 0;
      }
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: DETAILS_AT_ONCE }, async () => {
        while (next < toRead.length) {
          const t = toRead[next++]!;
          const d = await this.detail(client, t.id);
          const old = kept?.details[t.id];
          if (d !== undefined) {
            details[t.id] = d;
            detailAt[t.id] = now;
          } else {
            stale = true;
            if (old !== undefined) {
              details[t.id] = old;
              detailAt[t.id] = kept?.detailAt[t.id] ?? 0;
            }
          }
        }
      }),
    );
    const [ids, unsorted] = await Promise.all([this.encodeIds(client), only === undefined || o.unsorted === true ? this.unsorted(client) : Promise.resolve(kept?.unsorted)]);
    if (ids === undefined || unsorted === undefined) stale = true;
    const raw: Raw = { base: client.base, titles, details, detailAt, unsorted: unsorted ?? [], ids: ids ?? kept?.ids ?? [] };
    this.store(raw);
    return { raw, reachable: true, stale };
  }

  /**
   * Where the NAS files the mirrored disc with `key`, from the kept answer (details up to ten minutes old); null when
   * the encoder mirrors no such disc. A disc no title lists is in Unsorted (`title` and `titleId` null). Rejects with
   * `NasError` when the NAS cannot be read and nothing is kept.
   */
  async discMatch(client: NasClient, key: string, o: { fresh?: boolean } = {}): Promise<DiscMatch | null> {
    const mirror = await this.mirrorDiscs();
    const mine = [...mirror.values()].filter((d) => d.key === key);
    if (mine.length === 0) return null;
    let { raw } = await this.fetch(client);
    if (raw === null) throw new NasError('unreachable', null, 'The NAS did not answer.');
    const ids = new Set(mine.map((d) => d.discId));
    const discIds = [...ids];
    const find = (r: Raw): DiscMatch => {
      let found: DiscMatch | null = null;
      for (const t of r.titles) {
        for (const s of r.details[t.id]?.seasons ?? []) {
          if (!s.discs.some((slot) => slot.copies.some((c) => ids.has(c.discId)))) continue;
          const episodes = (s.episodes ?? [])
            .filter((e) => ids.has(e.discId))
            .map((e) => ({ playlistId: e.playlistId, number: e.number, name: e.name }))
            .sort((a, b) => a.number - b.number);
          if (found === null || (found.episodes.length === 0 && episodes.length > 0)) found = { discId: mine[0]!.discId, discIds, title: seasonTitle(s.id), titleId: t.id, episodes };
        }
      }
      return found ?? { discId: mine[0]!.discId, discIds, title: null, titleId: null, episodes: [] };
    };
    let found = find(raw);
    if (o.fresh === true && found.titleId !== null) {
      // the title's own detail may be up to ten minutes old: read it now before deciding anything on it
      const again = (await this.fetch(client, { only: found.titleId })).raw;
      if (again !== null) {
        raw = again;
        found = find(raw);
      }
    }
    return found;
  }

  /** Reads the details of the NAS titles `titleIds` and Unsorted again, after the encoder changed where a disc is filed; never rejects. */
  async refreshAfterChoice(client: NasClient, titleIds: readonly string[]): Promise<void> {
    try {
      await this.fetch(client, { only: titleIds, unsorted: true });
    } catch {
      // the next read of the NAS gets them
    }
  }

  /** The discs of the NAS's library the encoder mirrors, scanned once when none is known. */
  private async mirrorDiscs(): Promise<ReadonlyMap<string, NasDisc>> {
    const library = nasLibraryOf(this.app);
    if (library.discs().length === 0) await library.scan();
    return new Map(library.discs().map((d) => [d.discId, d]));
  }

  /** The shows, with how many of their episodes are encoded, and Unsorted. `client` must be the paired one. */
  async shows(client: NasClient, o: { refresh?: boolean } = {}): Promise<ShowsAnswer> {
    const { raw, reachable, stale } = await this.fetch(client, o);
    if (raw === null) return { shows: [], unsorted: [], reachable, stale: true };
    const ids = new Set(raw.ids);
    const mirror = await this.mirrorDiscs();
    const shows = raw.titles.map((t): NasShow => {
      const seasons = raw.details[t.id]?.seasons ?? [];
      let encoded = 0;
      let toEncode = 0;
      for (const s of seasons) {
        const title = seasonTitle(s.id);
        for (const e of s.episodes ?? []) {
          if (title !== null && ids.has(encodeId(title, e.number))) encoded++;
          else toEncode++;
        }
      }
      return {
        titleId: t.id,
        name: showName(t),
        poster: posterRoute(t.poster),
        kind: t.kind === 'movie' ? 'movie' : 'series',
        seasons: seasons.filter((s) => s.number !== null).length,
        films: seasons.filter((s) => s.number === null).length,
        discs: seasons.reduce((n, s) => n + s.discs.length, 0),
        encoded,
        toEncode,
      };
    });
    const unsorted = raw.unsorted.flatMap((u): NasUnsorted[] => {
      const disc = mirror.get(u.discId);
      return disc === undefined ? [] : [{ key: disc.key, label: disc.label, relPath: disc.relPath }];
    });
    return { shows, unsorted, reachable, stale };
  }

  /** One show with its seasons, discs, playlists and episodes; null when the NAS has no such show. Always reads that show's detail. */
  async show(client: NasClient, titleId: string): Promise<ShowAnswer | null> {
    const { raw, reachable, stale } = await this.fetch(client, { only: titleId });
    const summary = raw?.titles.find((t) => t.id === titleId);
    const detail = raw?.details[titleId];
    if (raw === null || summary === undefined || detail === undefined) return null;
    const ids = new Set(raw.ids);
    const mirror = await this.mirrorDiscs();
    const infos = new EpisodeInfoStore(this.app.dataDir);
    const records = new RecordStore(this.app.dataDir);
    const seasons: NasSeason[] = [];
    for (const s of detail.seasons) {
      const title = seasonTitle(s.id);
      const discs: NasSeasonDisc[] = [];
      for (const slot of s.discs) discs.push(await this.discOf(slot, s.episodes, mirror, title, ids, infos, records));
      seasons.push({ id: s.id, label: s.label, number: s.number, title, discs });
    }
    return {
      title: { titleId, name: showName(summary), poster: posterRoute(summary.poster), kind: summary.kind === 'movie' ? 'movie' : 'series' },
      seasons,
      reachable,
      stale,
    };
  }

  /** A slot as a disc: the copy the episodes name, else the first copy the encoder mirrors, else the first copy, unavailable. */
  private async discOf(
    slot: DiscSlot,
    episodes: readonly EpisodeRef[] | null,
    mirror: ReadonlyMap<string, NasDisc>,
    title: EncodeTitle | null,
    ids: ReadonlySet<string>,
    infos: EpisodeInfoStore,
    records: RecordStore,
  ): Promise<NasSeasonDisc> {
    const copies = slot.copies.map((c) => c.discId);
    const mine = (episodes ?? []).filter((e) => copies.includes(e.discId));
    const mirrored = copies.find((id) => mine.some((e) => e.discId === id) && mirror.has(id)) ?? copies.find((id) => mirror.has(id));
    const discId = mirrored ?? copies.find((id) => mine.some((e) => e.discId === id)) ?? copies[0] ?? '';
    const disc = mirrored === undefined ? undefined : mirror.get(mirrored);
    const byPlaylist = new Map<string, NasEpisode[]>();
    for (const e of mine.filter((x) => x.discId === discId).sort((a, b) => a.number - b.number)) {
      const list = byPlaylist.get(e.playlistId) ?? [];
      list.push({ number: e.number, name: e.name, encoded: title !== null && ids.has(encodeId(title, e.number)) });
      byPlaylist.set(e.playlistId, list);
    }
    const playlists = [...byPlaylist].map(([id, eps]) => ({ id, episodes: eps }));
    if (disc === undefined) return { key: null, discId, label: slot.label, available: false, playlists, checked: false, checkedPlaylists: [] };
    const toCheck = playlists.length > 0 ? playlists.map((p) => p.id) : await this.savedPlaylists(disc.key);
    const checkedPlaylists: CheckedPlaylist[] = [];
    for (const id of toCheck) {
      const c = await this.playlistChecked(disc.key, id, infos, records);
      if (c !== null) checkedPlaylists.push(c);
    }
    // listed playlists must all be checked; a disc listing none is checked once any saved playlist of it is
    const checked = playlists.length > 0 ? checkedPlaylists.length === playlists.length : checkedPlaylists.length > 0;
    return { key: disc.key, discId, label: slot.label, available: true, playlists, checked, checkedPlaylists };
  }

  /** The chapter count of a mirrored disc's playlist, read from its playlist file; null when it cannot be read. */
  private async chaptersOf(key: string, id: string): Promise<number | null> {
    const memo = `${key}/${id}`;
    const known = this.chapterCounts.get(memo);
    if (known !== undefined) return known;
    let count: number | null = null;
    try {
      const dir = await sessionsOf(this.app).discDirOf(key);
      if (dir !== null) count = (await loadPlaylist(dir, id)).chapters.length;
    } catch {
      count = null;
    }
    if (count !== null) this.chapterCounts.set(memo, count);
    return count;
  }

  /**
   * Playlist `id` of the disc when it is checked, else null: its saved info has a mark that holds (`isChecked`) for
   * the saved subtitle record's episode list (the mark's own without a record), on the playlist's real chapter count.
   * A playlist whose chapters cannot be read is not checked. The answer carries that episode list and the number the
   * saved titles give each of its episodes.
   */
  private async playlistChecked(key: string, id: string, infos: EpisodeInfoStore, records: RecordStore): Promise<CheckedPlaylist | null> {
    try {
      const info = await infos.read(key, id);
      if (info?.checked === undefined) return null;
      let spec = info.checked.episodeSpec;
      try {
        spec = (await records.read(key, id))?.episodeSpec ?? spec;
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
      }
      const chapters = await this.chaptersOf(key, id);
      if (chapters === null || !isChecked(info, spec, chapters)) return null;
      const episodes = parseEpisodeSpec(spec, chapters).map((e) => info.titles[String(e.from)]?.episode ?? null);
      return { id, episodeSpec: spec, episodes };
    } catch (e) {
      if (e instanceof EpisodeInfoError || e instanceof EpisodeSpecError) return null;
      throw e;
    }
  }

  /** For a disc the NAS lists no episodes for: the playlists saved for it under the data folder, in order. */
  private async savedPlaylists(key: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(join(this.app.dataDir, 'chapters', key));
    } catch {
      return [];
    }
    return names.flatMap((n) => /^(\d{5})\.json$/.exec(n)?.[1] ?? []).sort();
  }
}
