import type { OwnerChoice, TitleSummary, UnsortedReason, UnsortedSuggestion } from '@seikou/nas/nas-api';
import { NasHttpError, type SkippedDisc } from './nas-client';

/** The owner screens' words and choices: Unsorted, its search, and filing a disc. Original code. */

export const REASON_TEXT: Readonly<Record<UnsortedReason, string>> = {
  'no-title': 'No title found',
  'several-fit': 'More than one title fits',
  'no-season': 'No season number',
  'episode-past-season': "Episode number is past the season's last",
  'no-disc-number': 'No disc number',
  'sources-disagree': 'The sources disagree',
  'source-unreachable': "AniList or TMDB couldn't be reached; it will try again",
};

/** Why the NAS left a disc in Unsorted, as the "Why unsure" line says it. */
export function reasonText(reason: UnsortedReason): string {
  return REASON_TEXT[reason];
}

/** Blu-ray.com's search for a catalogue number, opened in a new tab. */
export function blurayComSearchUrl(catalogueNumber: string): string {
  return `https://www.blu-ray.com/search/?quicksearch=1&quicksearch_keyword=${encodeURIComponent(catalogueNumber)}&section=bluraymovies`;
}

/** A disc's folder name, and the path of the folder holding it ('' at a root's top). */
export function discPlace(path: string): { name: string; parent: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { name: path, parent: '' } : { name: path.slice(cut + 1), parent: path.slice(0, cut) };
}

const KIND_LABEL = { series: 'Series', movie: 'Movie', music: 'Music' } as const;

function sourceLabel(t: TitleSummary): string {
  if (t.own) return 'Own title';
  if (t.id.startsWith('anilist:')) return 'AniList';
  if (t.id.startsWith('tmdb-')) return 'TMDB';
  return KIND_LABEL[t.kind];
}

/** A suggestion's muted line: native name · year · source; the kind stands in when there is neither name nor year. */
export function suggestionLine(t: TitleSummary): string {
  const parts = [t.names.native, t.year === null ? null : String(t.year)].filter((p): p is string => p !== null && p !== '');
  if (parts.length === 0) parts.push(KIND_LABEL[t.kind]);
  const source = sourceLabel(t);
  if (!parts.includes(source)) parts.push(source);
  return parts.join(' · ');
}

/** A season or disc field: null when blank, the number when it is a whole number from 1 to 1000, else undefined. */
export function parseNumber(text: string): number | null | undefined {
  const t = text.normalize('NFKC').trim();
  if (t === '') return null;
  if (!/^\d{1,4}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 1000 ? n : undefined;
}

/** Filing a disc under `title`: the season counts for a series only. */
export function titleChoice(title: TitleSummary, season: number | null, disc: number | null): OwnerChoice {
  return { kind: 'title', titleId: title.id, season: title.kind === 'series' ? season : null, disc };
}

/** Filing a bonus disc with `title`'s extras: a series' season's when one is given, else the title's own. */
export function extrasChoice(title: TitleSummary, season: number | null): OwnerChoice {
  return { kind: 'extras', titleId: title.id, season: title.kind === 'series' ? season : null };
}

/** Search results from several sources as one list, each title once, in the order found. */
export function mergeResults(lists: readonly (readonly TitleSummary[])[]): TitleSummary[] {
  const seen = new Set<string>();
  const out: TitleSummary[] = [];
  for (const list of lists) {
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** What a failed search shows: refusals and unreachable sources gently, inline. */
export function lookupFailure(err: unknown): string {
  if (err instanceof NasHttpError) {
    if (err.status === 429) return `Searching too fast, try again in ${err.detail.retryAfter ?? 1} s`;
    if (err.status === 503) return "AniList or TMDB couldn't be reached";
  }
  return err instanceof Error ? err.message : String(err);
}

/** Why "Apply to the other discs" left a disc as it was. */
export function skippedText(reason: SkippedDisc['reason']): string {
  switch (reason) {
    case 'direct': return 'filed separately';
    case 'copy': return 'follows its copy';
    case 'conflict': return "its number clashes with this disc's";
    case 'no-number': return 'no disc number in its name';
  }
}

/** The apply offer's disc number: a positive number, else null (Apply waits for one). */
export function applyNumber(text: string): number | null {
  return parseNumber(text) ?? null;
}

/**
 * The Season field for a picked title: a series suggestion's season hint, else blank, so the owner must
 * give one. Search results carry no hint.
 */
export function seasonPrefill(t: TitleSummary | UnsortedSuggestion): string {
  const hint = 'seasonHint' in t ? t.seasonHint : null;
  return t.kind === 'series' && hint !== null ? String(hint) : '';
}

/** The Season field and whether it holds a suggestion's hint rather than the owner's typing. */
export interface SeasonField {
  readonly season: string;
  readonly hinted: boolean;
}

/**
 * The Season field once a title is picked: a season the owner typed stays; otherwise it takes the
 * pick's hint, and a pick without one clears an earlier hint.
 */
export function seasonOnPick(t: TitleSummary | UnsortedSuggestion, field: SeasonField): SeasonField {
  if (field.season !== '' && !field.hinted) return field;
  const prefill = seasonPrefill(t);
  if (prefill !== '') return { season: prefill, hinted: true };
  return field.hinted ? { season: '', hinted: false } : field;
}
