// SPDX-License-Identifier: LGPL-3.0-or-later
import { encodeId } from '@seikou/nas/encode-id';
import { EpisodeInfoError, EpisodeInfoStore, type EpisodeTitle } from '../plan/episode-info';
import { parseEpisodeSpec } from '../plan/episodes';
import { errorOfBody, NasError, type NasClient } from './client';

// What an encode to the NAS needs before it starts, shared by the queue (`src/server/jobs.ts`) and the command line:
// every episode has a title and number, no two episodes share one, and the NAS takes encodes.

/** How long the check waits for the NAS's `encodes/status`. */
const STATUS_TIMEOUT_MS = 10_000;

/** Why an encode cannot go to the NAS. */
export type NasDestinationCode = 'nas-needs-title' | 'nas-duplicate-episodes' | 'nas-encodes-off' | 'nas-not-paired' | 'info-unreadable';

/** An encode that cannot go to the NAS; `episodes` (1-based) names the episodes at fault, when some are. */
export class NasDestinationError extends Error {
  constructor(
    readonly code: NasDestinationCode,
    message: string,
    readonly episodes?: readonly number[],
  ) {
    super(message);
    this.name = 'NasDestinationError';
  }
}

/** The file name the NAS gets an episode under: `<encode id>.mkv`, as `990001-2.mkv` or `tv990101s1-2.mkv`. */
export function uploadNameOf(pair: EpisodeTitle): string {
  return `${encodeId(pair.title, pair.episode)}.mkv`;
}

/**
 * Each episode's title and number, from the episode info saved for the disc's playlist (`<data>/chapters/…`)
 * and keyed by the episode's first chapter; null for an episode without one. An unreadable info file throws
 * `NasDestinationError('info-unreadable')`.
 */
export async function episodeTitles(dataDir: string, discKey: string, playlistId: string, episodeSpec: string, chapters: number): Promise<(EpisodeTitle | null)[]> {
  let info: Awaited<ReturnType<EpisodeInfoStore['read']>>;
  try {
    info = await new EpisodeInfoStore(dataDir).read(discKey, playlistId);
  } catch (e) {
    if (e instanceof EpisodeInfoError) throw new NasDestinationError('info-unreadable', e.message);
    throw e;
  }
  return parseEpisodeSpec(episodeSpec, chapters).map((spec) => {
    return info?.titles[String(spec.from)] ?? null;
  });
}

/**
 * Checks what an encode to the NAS needs and answers each episode's title and number. Throws `NasDestinationError`:
 * `nas-needs-title` (with the episodes that lack a title and number), `nas-duplicate-episodes` (with every episode
 * of a shared pair, since the NAS keeps one file per pair), `nas-encodes-off` (`encodes/status` says the NAS has no
 * encodes folder), `nas-not-paired` (no client, or the NAS no longer knows it) and `info-unreadable`. `reachable` is
 * false when the NAS did not answer `encodes/status`, which the caller decides about: the queue waits, the command
 * line stops.
 */
export async function checkNasDestination(o: {
  dataDir: string;
  client: NasClient | null;
  discKey: string;
  playlistId: string;
  episodeSpec: string;
  chapters: number;
  /** The 1-based episodes to encode, when not all: the others are not checked and not in `pairs`. */
  only?: readonly number[];
}): Promise<{ pairs: EpisodeTitle[]; reachable: boolean }> {
  const all = await episodeTitles(o.dataDir, o.discKey, o.playlistId, o.episodeSpec, o.chapters);
  const numbers = all.map((_, i) => i + 1).filter((n) => o.only === undefined || o.only.includes(n));
  const found = numbers.map((n) => all[n - 1]!);
  const missing = found.flatMap((p, i) => (p === null ? [numbers[i]!] : []));
  if (missing.length > 0) {
    const who = missing.length === 1 ? `Episode ${missing[0]!} needs` : `Episodes ${missing.join(', ')} need`;
    throw new NasDestinationError('nas-needs-title', `${who} a title and number before they can go to the NAS. Set them on the Episodes page.`, missing);
  }
  const pairs = found as EpisodeTitle[];
  const keys = pairs.map(uploadNameOf);
  const shared = keys.flatMap((k, i) => (keys.indexOf(k) !== keys.lastIndexOf(k) ? [numbers[i]!] : []));
  if (shared.length > 0) {
    throw new NasDestinationError(
      'nas-duplicate-episodes',
      `Episodes ${shared.join(', ')} share a title and number, and the NAS keeps one file for each. Fix the numbers on the Episodes page.`,
      shared,
    );
  }
  const client = o.client;
  if (client === null) throw new NasDestinationError('nas-not-paired', 'This app is not paired with a NAS. Pair it in Settings first.');
  const forgotten = (): NasDestinationError => new NasDestinationError('nas-not-paired', 'The NAS no longer knows this app. Pair it again in Settings.');
  const off = (): NasDestinationError => new NasDestinationError('nas-encodes-off', 'The NAS has no encodes folder set up, so it takes no encodes. Set ENCODES_DIR on the NAS first.');
  let res: Response;
  try {
    res = await client.request('encodes/status', { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof NasError && e.code === 'unauthorized') throw forgotten();
    if (e instanceof NasError) return { pairs, reachable: false };
    throw e;
  }
  if (res.status === 401) {
    await res.body?.cancel();
    throw forgotten();
  }
  if (res.status === 404) {
    if ((await errorOfBody(res)) === 'not-configured') throw off();
    return { pairs, reachable: true };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { pairs, reachable: true };
  }
  const status = (await res.json().catch(() => null)) as { configured?: unknown } | null;
  if (status?.configured === false) throw off();
  return { pairs, reachable: true };
}
