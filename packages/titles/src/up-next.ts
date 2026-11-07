/**
 * Continue watching and per-title progress, worked out from a person's places and the live catalogue (resume spec
 * §6.4 and §6.6). Pure: the catalogue, the places and the disc lookups come in as arguments. Original code.
 */
import type { ContinueItem, EpisodeRef, PlaybackPlace, PlaylistProgress, TitleDetail, TitleSummary } from '@seikou/nas/nas-api';
import { isShortPlace } from '@seikou/nas/place-rules';
import type { Catalogue } from './catalogue';

export type { ContinueItem, PlaylistProgress };

/** At most this many cards. */
export const CONTINUE_LIMIT = 50;

/** The disc ids a place's key stands for: every copy sharing the fingerprint of an `f.` key, the one id of a `d.` key. */
export type DiscsOf = (discKey: string) => readonly string[];

const NO_CATALOGUE = { titleId: null, titleName: null, poster: null, seasonId: null, seasonNumber: null, episode: null, kindOfTitle: null } as const;

/** The name a title is shown by: the owner's display name, then English, romaji, native. */
function nameOf(t: TitleSummary): string | null {
  const { display, english, romaji, native } = t.names;
  return display ?? english ?? romaji ?? native;
}

/** Where an episode sits: its title, its season's index in the title and its own index in the season. */
interface EpisodeSlot { readonly detail: TitleDetail; readonly seasonIndex: number; readonly index: number }

const slotKey = (discId: string, playlistId: string): string => `${discId}\n${playlistId}`;

/** Every episode of the catalogue by (disc, playlist). The first title to hold a pair keeps it. */
function indexEpisodes(catalogue: Catalogue): Map<string, EpisodeSlot> {
  const index = new Map<string, EpisodeSlot>();
  for (const summary of catalogue.titles) {
    const detail = catalogue.detail(summary.id);
    if (!detail) continue;
    detail.seasons.forEach((season, seasonIndex) => {
      season.episodes?.forEach((ep, i) => {
        const key = slotKey(ep.discId, ep.playlistId);
        if (!index.has(key)) index.set(key, { detail, seasonIndex, index: i });
      });
    });
  }
  return index;
}

const candidates = (place: PlaybackPlace, discsOf: DiscsOf): readonly string[] => [...new Set([place.discId, ...discsOf(place.discKey)])];

function slotOf(place: PlaybackPlace, index: ReadonlyMap<string, EpisodeSlot>, discsOf: DiscsOf): EpisodeSlot | null {
  for (const id of candidates(place, discsOf)) {
    const slot = index.get(slotKey(id, place.playlistId));
    if (slot) return slot;
  }
  return null;
}

function episodeAt(slot: EpisodeSlot): EpisodeRef {
  return slot.detail.seasons[slot.seasonIndex]!.episodes![slot.index]!;
}

/** The episode after `slot`: the season's next one, else the next season's first; null when unknown or none. */
function nextEpisode(slot: EpisodeSlot): EpisodeSlot | null {
  const { seasons } = slot.detail;
  if (slot.index + 1 < seasons[slot.seasonIndex]!.episodes!.length) return { ...slot, index: slot.index + 1 };
  const next = seasons[slot.seasonIndex + 1];
  return next?.episodes && next.episodes.length > 0 ? { detail: slot.detail, seasonIndex: slot.seasonIndex + 1, index: 0 } : null;
}

function catalogueFields(slot: EpisodeSlot): Pick<ContinueItem, 'titleId' | 'titleName' | 'poster' | 'seasonId' | 'seasonNumber' | 'episode' | 'kindOfTitle'> {
  const { title } = slot.detail;
  const season = slot.detail.seasons[slot.seasonIndex]!;
  return {
    titleId: title.id, titleName: nameOf(title), poster: title.poster, seasonId: season.id, seasonNumber: season.number,
    episode: episodeAt(slot).number, kindOfTitle: title.kind,
  };
}

/**
 * The Continue watching row: an unfinished place (past its first moments, isShortPlace) is a `resume` card; a finished series episode is an `up-next` card
 * for the following episode (on whichever disc), unless the series has a newer place or the next episode has one of
 * its own; movies, music and a series' last episode drop off. Newest first, at most 50. `discKeyOf` names the disc an
 * Up next episode is on (default `d.<id>`).
 */
export function continueWatching(
  places: readonly PlaybackPlace[], catalogue: Catalogue, discsOf: DiscsOf, discKeyOf: (discId: string) => string = (id) => `d.${id}`,
): ContinueItem[] {
  // an unfinished place near its start is none to resume (spec §6.5): it makes no card and holds back no Up next card
  places = places.filter((p) => p.finished || !isShortPlace(p.timeUs, p.durationUs));
  if (places.length === 0) return [];
  const index = indexEpisodes(catalogue);
  const slots = new Map(places.map((p) => [p, slotOf(p, index, discsOf)] as const));
  const items: ContinueItem[] = [];
  const upNextDone = new Set<string>();

  const newestFirst = [...places].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const place of newestFirst) {
    const slot = slots.get(place)!;
    if (!place.finished) {
      items.push({
        kind: 'resume', discKey: place.discKey, discId: place.discId, playlistId: place.playlistId, timeUs: place.timeUs, durationUs: place.durationUs,
        ...(slot ? catalogueFields(slot) : NO_CATALOGUE), updatedAt: place.updatedAt, deviceName: place.deviceName, settings: null,
      });
      continue;
    }
    if (!slot || slot.detail.title.kind !== 'series' || upNextDone.has(slot.detail.title.id)) continue;
    upNextDone.add(slot.detail.title.id); // only the series' newest finished episode can lead on
    const titleId = slot.detail.title.id;
    const newer = places.some((q) => q !== place && q.updatedAt > place.updatedAt && slots.get(q)?.detail.title.id === titleId);
    const next = newer ? null : nextEpisode(slot);
    if (!next) continue;
    const ep = episodeAt(next);
    const hasPlace = places.some((q) => {
      const s = slots.get(q);
      return s !== null && s !== undefined && s.detail.title.id === titleId && s.seasonIndex === next.seasonIndex && s.index === next.index;
    });
    if (hasPlace) continue;
    items.push({
      kind: 'up-next', discKey: discKeyOf(ep.discId), discId: ep.discId, playlistId: ep.playlistId, timeUs: 0, durationUs: (ep.runtimeMin ?? 0) * 60_000_000,
      ...catalogueFields(next), updatedAt: place.updatedAt, deviceName: place.deviceName, settings: place.settings,
    });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CONTINUE_LIMIT);
}

/** Where the person is in each playlist of a title's discs, by disc id (every copy of a disc) and playlist id. */
export function titleProgress(places: readonly PlaybackPlace[], detail: TitleDetail, discsOf: DiscsOf): Record<string, Record<string, PlaylistProgress>> {
  const ids = new Set<string>();
  const slots = (list: readonly { readonly copies: readonly { readonly discId: string }[] }[]): void => {
    for (const slot of list) for (const copy of slot.copies) ids.add(copy.discId);
  };
  slots(detail.extras);
  for (const season of detail.seasons) {
    slots(season.discs);
    slots(season.extras);
    for (const ep of season.episodes ?? []) ids.add(ep.discId);
  }
  const out: Record<string, Record<string, PlaylistProgress>> = {};
  for (const place of places) {
    for (const id of candidates(place, discsOf)) {
      if (!ids.has(id)) continue;
      (out[id] ??= {})[place.playlistId] = { timeUs: place.timeUs, durationUs: place.durationUs, finished: place.finished };
    }
  }
  return out;
}
