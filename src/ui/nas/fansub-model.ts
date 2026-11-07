import type { FansubEpisodeMark, FansubTitleState, SeaDexRank, StoredSubtitle } from '@seikou/nas/nas-api';

export type MarkTone = 'ok' | 'warn' | 'bad';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RANK_LABEL: Record<SeaDexRank, string> = { best: '', web: ' WEB', other: '' };
/** An offset under this is no offset: the track is simply lined up. */
const NEGLIGIBLE_OFFSET_MS = 50;

const dayOf = (t: number): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** "today", "last night" (the evening before from 18:00, or this morning before 08:00) or "d MMM", in the device's time. */
function checkedWhen(at: number, now: number): string {
  const when = new Date(at);
  const dayDiff = Math.round((dayOf(now) - dayOf(at)) / 86_400_000);
  if (dayDiff === 0) return when.getHours() < 8 ? 'last night' : 'today';
  if (dayDiff === 1 && when.getHours() >= 18) return 'last night';
  return `${when.getDate()} ${MONTHS[when.getMonth()]}`;
}

/** The owner's line above a season's episodes, or null when there is nothing to say about the season. */
export function seasonLine(state: FansubTitleState, seasonId: string, now: number): string | null {
  if (state.running) return 'Fansubs: looking now';
  const season = state.seasons[seasonId];
  if (!season) return null;
  const parts: string[] = [];
  if (season.bestGroup !== null) parts.push(`Fansubs: ${season.bestGroup} (SeaDex best)`);
  const others = season.usedGroups.filter((g) => g.group !== season.bestGroup).map((g) => `${g.group}${RANK_LABEL[g.rank]}`);
  if (others.length > 0) parts.push(`${season.bestGroup === null ? 'Fansubs: ' : ''}subtitles from ${others.join(', ')}`);
  if (parts.length === 0) return null;
  if (state.lastRunAt !== null) parts.push(`checked ${checkedWhen(state.lastRunAt, now)}`);
  return parts.join(' · ');
}

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function trackMark(s: StoredSubtitle): { text: string; tone: MarkTone; rank: number } | null {
  const a = s.source!.alignment;
  if (a.kind === 'none') return { text: "couldn't line up · set by hand", tone: 'bad', rank: 3 };
  if (a.kind === 'split') {
    const first = a.parts.find((p) => p.fromMs > 0) ?? a.parts[0];
    return { text: `split at ${clock(first?.fromMs ?? 0)} · check`, tone: 'warn', rank: 2 };
  }
  if (s.fontsMissing === true) return { text: 'no fonts', tone: 'warn', rank: 1 };
  if (a.kind === 'original') return null; // the release's own timing says nothing worth a mark
  if (Math.abs(a.offsetMs) < NEGLIGIBLE_OFFSET_MS) return { text: 'lined up', tone: 'ok', rank: 0 };
  const sign = a.offsetMs < 0 ? '−' : '+';
  return { text: `lined up · ${sign}${(Math.abs(a.offsetMs) / 1000).toFixed(1)} s`, tone: 'ok', rank: 0 };
}

/** The one mark on an episode row: the worst of its fansub tracks, or the run's miss; null when there is nothing to show. */
export function episodeMark(subs: readonly StoredSubtitle[], mark: FansubEpisodeMark | undefined, stale: boolean): { text: string; tone: MarkTone } | null {
  const fansubs = subs.filter((s) => s.source !== undefined);
  if (fansubs.length === 0) return mark?.status === 'not-found' ? { text: 'not found', tone: 'bad' } : null;
  if (stale) return { text: 'lined up on another disc', tone: 'warn' };
  const marks = fansubs.map(trackMark).filter((m) => m !== null);
  if (marks.length === 0) return null;
  const worst = marks.reduce((a, b) => (b.rank > a.rank ? b : a));
  return { text: worst.text, tone: worst.tone };
}

/** A track's chip: its name in the release (Full, Signs, ...), the stored name for an owner upload. */
export const trackChip = (s: StoredSubtitle): string => s.source?.trackName ?? s.name;

export const runButtonLabel = (state: FansubTitleState): 'Find fansubs' | 'Find fansubs again' => (state.lastRunAt === null ? 'Find fansubs' : 'Find fansubs again');

/** The languages an owner can add to fansub runs; English is always kept. */
export const FANSUB_LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'spa', label: 'Spanish' }, { code: 'por', label: 'Portuguese' }, { code: 'fre', label: 'French' },
  { code: 'ger', label: 'German' }, { code: 'ita', label: 'Italian' }, { code: 'ara', label: 'Arabic' },
  { code: 'rus', label: 'Russian' }, { code: 'ind', label: 'Indonesian' }, { code: 'chi', label: 'Chinese' },
];

/** Titles whose fansubs the owner deleted in this browser session: only for those does "Find fansubs again" ask to bring them back. */
const deletedHere = new Set<string>();
export const rememberFansubDeletion = (titleId: string): void => void deletedHere.add(titleId);
export const forgetFansubDeletion = (titleId: string): void => void deletedHere.delete(titleId);
export const fansubsDeletedHere = (titleId: string): boolean => deletedHere.has(titleId);
