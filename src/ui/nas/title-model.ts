import type { DiscSlot, EpisodeRef, SeasonDetail, TitleDetail, TitleKind, TitleSummary } from '@seikou/nas/nas-api';
import { normalizeTitle, titleMatches } from '@seikou/nas/title-text';

/** The library's view of the NAS's titles: search, shelves and the labels the title screens show. Original code. */

const byName = (a: TitleSummary, b: TitleSummary): number => displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: 'base' });

/**
 * Every name a title is found by: the display name, English, romaji, native and synonyms, and for a music release its
 * title, concert name and artist names, as the cards show them.
 */
function searchNames(t: TitleSummary): string[] {
  const { display, english, romaji, native, synonyms } = t.names;
  const m = t.music;
  const music = m ? [m.title, m.concertName, m.artist.name, m.artist.otherName] : [];
  return [display, english, romaji, native, ...synonyms, ...music].filter((n): n is string => n !== null && n !== undefined && n !== '');
}

/**
 * The titles matching `query` on any name, best first: titles with a name that starts with the query, then those with
 * the query inside a name, each A–Z. A blank query matches nothing; the library shows its shelves then.
 */
export function searchTitles(titles: readonly TitleSummary[], query: string): TitleSummary[] {
  const q = normalizeTitle(query);
  const ranked: { t: TitleSummary; rank: number }[] = [];
  for (const t of titles) {
    const names = searchNames(t);
    if (!titleMatches(query, names)) continue;
    ranked.push({ t, rank: names.some((n) => normalizeTitle(n).startsWith(q)) ? 0 : 1 });
  }
  return ranked.sort((a, b) => a.rank - b.rank || byName(a.t, b.t)).map((r) => r.t);
}

/** One shelf's titles, A–Z by the displayed name. */
export function shelf(titles: readonly TitleSummary[], kind: TitleKind): TitleSummary[] {
  return titles.filter((t) => t.kind === kind).sort(byName);
}

/** The `n` titles added last, newest first. */
export function recentlyAdded(titles: readonly TitleSummary[], n = 9): TitleSummary[] {
  return [...titles].sort((a, b) => b.addedAt - a.addedAt || byName(a, b)).slice(0, n);
}

/** The name a title is shown by: the owner's display name, then a music release's title, then English, romaji, native. */
export function displayName(t: TitleSummary): string {
  const { display, english, romaji, native } = t.names;
  return display ?? (t.music?.title || null) ?? english ?? romaji ?? native ?? '';
}

/** The native name, shown under the displayed one when it differs. */
export function secondaryName(t: TitleSummary): string | null {
  const { native } = t.names;
  return native !== null && native !== displayName(t) ? native : null;
}

/** A poster placeholder's text: the first letters of the first two words (one character for a name without spaces). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join('');
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A season's row label: 'Season 2', or the source's label when the season has no number. */
export function seasonLabel(s: SeasonDetail): string {
  return s.number !== null ? `Season ${s.number}` : s.label;
}

/** '12 episodes · 6 discs', or just the discs when the episodes aren't known. */
export function seasonCounts(s: SeasonDetail): string {
  const discs = plural(s.discs.length, 'disc');
  return s.episodes ? `${plural(s.episodes.length, 'episode')} · ${discs}` : discs;
}

/** The series screen's meta line: 'TV · 2016–2023 · 5 seasons, 1 movie'. */
export function titleMeta(d: TitleDetail): string {
  const kind = d.title.kind === 'series' ? 'TV' : d.title.kind === 'movie' ? 'Movie' : 'Music';
  const years = [d.title.year, ...d.related.map((r) => r.year)].filter((y): y is number => y !== null);
  const parts = [kind];
  if (years.length > 0) {
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    parts.push(lo === hi ? String(lo) : `${lo}–${hi}`);
  }
  if (d.title.kind === 'series') {
    const counts = [plural(d.seasons.filter((s) => s.number !== null).length, 'season')];
    const movies = d.related.filter((r) => r.kind === 'movie').length;
    if (movies > 0) counts.push(plural(movies, 'movie'));
    parts.push(counts.join(', '));
  }
  return parts.join(' · ');
}

/** The disc slot an episode plays from: the one holding its disc among its copies. */
export function episodeDisc(s: SeasonDetail, e: EpisodeRef): DiscSlot | null {
  return s.discs.find((d) => d.copies.some((c) => c.discId === e.discId)) ?? null;
}

/** An episode row's detail: '24 min · Disc 1', leaving out what isn't known. */
export function episodeMeta(s: SeasonDetail, e: EpisodeRef): string {
  const parts: string[] = [];
  if (e.runtimeMin !== null && e.runtimeMin > 0) parts.push(`${e.runtimeMin} min`);
  const disc = episodeDisc(s, e);
  if (disc) parts.push(disc.label);
  return parts.join(' · ');
}

/** A disc card's title: 'Disc 1 · Episodes 1–3', 'Disc 4 · Episode 10', or the label alone. */
export function discHeading(s: SeasonDetail, d: DiscSlot): string {
  const ids = new Set(d.copies.map((c) => c.discId));
  const numbers = (s.episodes ?? []).filter((e) => ids.has(e.discId)).map((e) => e.number);
  if (numbers.length === 0) return d.label;
  const lo = Math.min(...numbers);
  const hi = Math.max(...numbers);
  return `${d.label} · ${lo === hi ? `Episode ${lo}` : `Episodes ${lo}–${hi}`}`;
}

/** A disc's copies: '2 copies', or null for one. */
export function copiesLabel(d: DiscSlot): string | null {
  return d.copies.length > 1 ? plural(d.copies.length, 'copy', 'copies') : null;
}

/**
 * What an empty library says: to an owner, how far the matching run is, from `admin/metadata/status`; to a
 * guest, who sees the library only once the gate is open, that it is being prepared.
 */
export function emptyLibraryText(owner: boolean, status: { readonly running: boolean; readonly groupsDone: number; readonly groupsTotal: number } | null): string {
  if (!owner) return 'The library is being prepared';
  if (status?.running && status.groupsTotal > 0) return `Matching your library… ${status.groupsDone} of ${status.groupsTotal} folders`;
  return 'No titles yet. The NAS files discs under titles after each scan.';
}
