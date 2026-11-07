import type { DiscPlaces } from '@seikou/nas/nas-api';
import { discKeyOf } from '@seikou/nas/disc-key';
import { normalizeDiscPaths } from '@seikou/engine/disc/paths';
import { promptLines } from './place-model';
import { resumeOffer, within, type ResumeOffer } from './nas/resume-model';

/** A place on this device is read for at most this long before a local disc opens without asking. */
export const LOCAL_PLACES_TIMEOUT_MS = 3000;

/** `discKeyOf` of a folder's files; null when they aren't a disc, or have no fingerprint (so nothing is remembered). */
export function localKeyOf(entries: ReadonlyArray<readonly [string, { readonly size: number }]>): string | null {
  try {
    const key = discKeyOf('local', [...normalizeDiscPaths(entries)].map(([path, file]) => ({ path, size: file.size })));
    return key.startsWith('d.') ? null : key;
  } catch {
    return null; // not a disc: the engine says why
  }
}

export type AskOffer = Extract<ResumeOffer, { readonly kind: 'ask' | 'changed' }>;

/**
 * What to do for a local disc: ask (the device holds an unfinished place) or open at once. `isCurrent` is false once a
 * later pick has superseded this call: it then does nothing, so a slow read never prompts or opens over a newer disc.
 */
export async function askOrOpen(opts: {
  readonly discKey: string | null;
  readonly playlists: readonly { readonly id: string; readonly durationUs?: number }[] | null;
  readonly readPlaces: (discKey: string) => Promise<DiscPlaces>;
  readonly isCurrent: () => boolean;
  readonly ask: (offer: AskOffer) => void;
  readonly open: () => void;
}): Promise<void> {
  const stored = opts.discKey === null ? null : await within(opts.readPlaces(opts.discKey), LOCAL_PLACES_TIMEOUT_MS, null);
  if (!opts.isCurrent()) return;
  const offer = resumeOffer(stored, null, opts.playlists);
  if (offer.kind === 'ask' || offer.kind === 'changed') opts.ask(offer);
  else opts.open();
}

/** A Recent discs row's "Resume at m:ss", or null when this device holds no unfinished place for it. */
export async function recentResumeLabel(discKey: string | null, readPlaces: (discKey: string) => Promise<DiscPlaces>, nowMs: number): Promise<string | null> {
  if (discKey === null || discKey.startsWith('d.')) return null;
  const offer = resumeOffer(await within(readPlaces(discKey), LOCAL_PLACES_TIMEOUT_MS, null), null, null);
  return offer.kind === 'ask' ? promptLines(offer.place, nowMs).resumeLabel : null;
}
