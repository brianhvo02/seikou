/**
 * The episode guess from playlists: episode-length playlists, numbered in disc order. It answers null,
 * meaning no Episodes tab, whenever it is unsure. Original code.
 */
import type { EpisodeRef } from '@seikou/nas/nas-api';
import type { DiscEvidence } from './disc-evidence';

type Playlist = DiscEvidence['playlists'][number];

/** Playlists within this share of the season's episode runtime are episodes. */
const RUNTIME_TOLERANCE = 0.25;
/**
 * Playlists between the episode window and these shares of the runtime may or may not be episodes (a special, a long
 * finale), so a disc holding one, other than a play-all, isn't guessed.
 */
const UNCERTAIN_BELOW = 0.6;
const UNCERTAIN_ABOVE = 1.6;

const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/**
 * The episodes of a season's discs, given in disc order, numbered from `firstNumber` and continuing from disc to disc;
 * null when the runtime or episode count is unknown, when a disc's episodes can't be ordered, or when the total isn't
 * the season's episode count.
 * @example ../examples/guess-episodes.ts
 */
export function guessEpisodes(
  season: { episodes: number | null; runtimeMin: number | null },
  discs: readonly { discId: string; playlists: DiscEvidence['playlists'] }[],
  firstNumber: number,
): EpisodeRef[] | null {
  const { episodes, runtimeMin } = season;
  if (episodes === null || runtimeMin === null || runtimeMin <= 0) return null;
  const out: EpisodeRef[] = [];
  for (const d of discs) {
    const found = discEpisodes(d.playlists, runtimeMin * 60);
    if (found === null) return null;
    for (const p of found) {
      out.push({ number: firstNumber + out.length, name: null, runtimeMin: Math.round(p.durationS / 60), discId: d.discId, playlistId: p.id });
    }
  }
  return out.length === episodes ? out : null;
}

/**
 * One disc's episode playlists in order, or null when they can't be ordered or a runtime is uncertain. Play-all playlists (at least two
 * episodes long) and short ones (openings, endings, previews) fall outside the runtime window. Playlists with the same
 * clip list count once. Clips shared by several episodes (an opening, an ending) are allowed, but each episode needs a
 * clip of its own, and those clips must run in playlist order.
 */
function discEpisodes(playlists: readonly Playlist[], runtimeS: number): Playlist[] | null {
  const lo = runtimeS * (1 - RUNTIME_TOLERANCE);
  const hi = runtimeS * (1 + RUNTIME_TOLERANCE);
  const key = (p: Playlist): string => p.clips.join('/');
  // a play-all holds every clip of two or more other playlists that aren't short
  const playAll = (p: Playlist): boolean =>
    new Set(playlists
      .filter((q) => q.clips.length > 0 && key(q) !== key(p) && q.durationS >= runtimeS * UNCERTAIN_BELOW && q.clips.every((c) => p.clips.includes(c)))
      .map(key)).size >= 2;
  const uncertain = (p: Playlist): boolean =>
    (p.durationS >= runtimeS * UNCERTAIN_BELOW && p.durationS < lo) || (p.durationS > hi && p.durationS <= runtimeS * UNCERTAIN_ABOVE);
  if (playlists.some((p) => uncertain(p) && !playAll(p))) return null;
  const seen = new Set<string>();
  const candidates: Playlist[] = [];
  for (const p of [...playlists].sort((a, b) => naturalOrder(a.id, b.id))) {
    if (p.clips.length === 0 || p.durationS < lo || p.durationS > hi || seen.has(key(p))) continue;
    seen.add(key(p));
    candidates.push(p);
  }
  const uses = new Map<string, number>();
  for (const p of candidates) for (const c of new Set(p.clips)) uses.set(c, (uses.get(c) ?? 0) + 1);
  let previous: string | null = null;
  for (const p of candidates) {
    const own = p.clips.find((c) => uses.get(c) === 1);
    if (own === undefined) return null;
    if (previous !== null && naturalOrder(previous, own) >= 0) return null;
    previous = own;
  }
  return candidates;
}
