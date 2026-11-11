import type { EncodingNow, NasDrive, StoredSubtitle, TitleSummary } from '@seikou/nas/nas-api';
import { LANGUAGES } from './subtitle-model';
import { displayName } from './title-model';
import { NasHttpError, type NasClient, type NasCode, type NasTitleStatus } from './nas-client';
import { codeTarget, lastSeen } from './people-model';

/**
 * The NAS settings screen's decisions, pure: how long a pairing code has left, how often that countdown redraws and
 * when to stop polling for it to be redeemed, whether the gate switch shows on, what "Encoding now", the matching
 * status, the own titles and the drives say, and each upload's row, all from the NAS's status objects and a clock
 * passed in.
 */

export { lastSeen };

/** The admin calls the NAS settings screen makes. */
export type AdminApi = Pick<NasClient['admin'], 'createCode'>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const units = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * Time left on a pairing code: `Expires in m:ss` (seconds rounded up) up to an hour, then days and hours (rounded up
 * to the hour) for an invite, or `Expired`.
 */
export function countdown(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return 'Expired';
  if (left > HOUR) {
    const hours = Math.ceil(left / HOUR);
    const days = Math.floor(hours / 24);
    const parts = [days > 0 ? units(days, 'day') : '', hours % 24 > 0 ? units(hours % 24, 'hour') : ''];
    return `Expires in ${parts.filter(Boolean).join(' ')}`;
  }
  const seconds = Math.ceil(left / 1000);
  return `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** While a code is shown, the people list is polled until this time: the code's expiry, or 10 minutes after minting. */
export function codePollEnd(expiresAt: number, mintedAt: number): number {
  return Math.min(expiresAt, mintedAt + 10 * MINUTE);
}

/** Whether `GET admin/codes` still lists the code shown (its person and expiry): a redeemed code is gone. */
export function codeListed(codes: readonly NasCode[], shown: { readonly personId: string; readonly expiresAt: number }): boolean {
  return codes.some((c) => c.personId === shown.personId && c.expiresAt === shown.expiresAt);
}

/** How often the countdown redraws: once a minute while more than an hour is left, else every second. */
export function countdownTickMs(expiresAt: number, now: number): number {
  return expiresAt - now > HOUR ? MINUTE : 1_000;
}

/**
 * "New pairing code": for the person picked, or for a new person (`NEW_PERSON`) with the name and Owner box given; an
 * invite lasts 3 days. A new person without a usable name is refused here, without asking the NAS.
 */
export async function newCode(api: AdminApi, picked: string, name: string, owner: boolean, invite: boolean): ReturnType<AdminApi['createCode']> {
  const target = codeTarget(picked, name, owner);
  if ('error' in target) throw new Error(target.error);
  return api.createCode(target.target, invite);
}

/** Whether the gate switch shows on: the NAS's gate is `everyone`, or turning it on is waiting for confirmation. */
export function gateSwitchOn(status: NasTitleStatus | null, confirming: boolean): boolean {
  return confirming || status?.gate === 'everyone';
}

/** The status after the owner's PUT of the gate succeeded, so the switch shows what the NAS now has. */
export function withGate(status: NasTitleStatus | null, gate: NasTitleStatus['gate']): NasTitleStatus | null {
  return status === null ? null : { ...status, gate };
}

/** One line of "Encoding now": who watches what, at which level, and the share of the GPU it takes. */
export function encodingLine(e: EncodingNow): string {
  return `${e.personName} · ${e.deviceName} — ${e.discName}, ${e.label} (${e.gpuPercent}% of the GPU)`;
}

/**
 * The status line of "Encoding now" over its rows: loading, a first load that failed (polling goes on), nothing being
 * re-encoded, or null when there are rows (a later failed refresh keeps the last list).
 */
export function encodingStatus(s: { readonly list: readonly EncodingNow[] | null; readonly failed: boolean }): string | null {
  if (s.list === null) return s.failed ? "Couldn't load what's encoding." : 'Loading…';
  return s.list.length === 0 ? 'Nothing is being re-encoded.' : null;
}

/** The notice TMDB's terms require wherever its data is used, shown with its logo in NAS settings. */
export const TMDB_ATTRIBUTION = 'This product uses the TMDB API but is not endorsed or certified by TMDB';

const discs = (n: number): string => `${n} ${n === 1 ? 'disc' : 'discs'}`;

/** The title library's matching status in NAS settings: the run's progress, the counts, and a note without TMDB. */
export function matchingStatus(s: NasTitleStatus, now: number): { progress: string; counts: string; tmdb: string | null } {
  const progress = s.running
    ? `Matching… ${s.groupsDone} of ${s.groupsTotal} folders`
    : s.lastRunAt === null
      ? 'Not matched yet'
      : `Last matched ${lastSeen(s.lastRunAt, now)}`;
  return {
    progress,
    counts: `${discs(s.filed)} filed · ${s.unsorted} unsorted · ${s.music} music`,
    tmdb: s.tmdb ? null : 'No TMDB key: discs that aren’t anime go to Unsorted.',
  };
}

/** The owner's own titles, A–Z, for NAS settings' "Own titles" list. */
export function ownTitles(titles: readonly TitleSummary[]): TitleSummary[] {
  return titles.filter((t) => t.own).sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: 'base' }));
}

/** An own title's kind: `Series · N seasons`, `Movie` or `Music`. */
export function ownTitleKind(t: TitleSummary): string {
  if (t.kind === 'movie') return 'Movie';
  if (t.kind === 'music') return 'Music';
  return `Series · ${t.seasons} ${t.seasons === 1 ? 'season' : 'seasons'}`;
}

/** The confirm step before deleting an own title. */
export function deleteTitleQuestion(name: string): string {
  return `Delete ${name}? Its discs go back to Unsorted.`;
}

const discCount = (n: number): string => `${n} disc${n === 1 ? '' : 's'}`;

/** A drive's row in NAS settings: what it holds, and whether its kept discs can be forgotten (missing, with discs). */
export function driveLine(d: NasDrive): { name: string; status: string; canForget: boolean } {
  if (!d.missing) return { name: d.name, status: discCount(d.discs), canForget: false };
  return { name: d.name, status: d.discs > 0 ? `Not found at the last scan · ${discCount(d.discs)} kept` : 'Not found at the last scan', canForget: d.discs > 0 };
}

/** The confirm step before forgetting a missing drive's kept discs: how many leave the library, and that a later scan lists them again if the drive returns. */
export function forgetDriveQuestion(d: NasDrive): string {
  return `Forget the ${discCount(d.discs)} kept from ${d.name}? They leave the library now. If the drive comes back, the next scan lists them again.`;
}

/** An upload's row in the owners' list of every subtitle upload; `titleNames` by title id. */
export function uploadLine(s: StoredSubtitle, titleNames: ReadonlyMap<string, string>): { name: string; language: string; where: string; attached: boolean } {
  const a = s.attachment;
  const title = (id: string | undefined): string | null => (id === undefined ? null : (titleNames.get(id) ?? null));
  const place = a.kind === 'episode'
    ? `${title(a.titleId) ?? 'A title no longer on the NAS'} · episode ${a.episode}`
    : `${title(a.titleId) ?? 'A disc'} · playlist ${a.playlistId} · chapter ${a.chapter + 1}`;
  const attached = s.attached !== false;
  const language = LANGUAGES.find((l) => l.code.toLowerCase() === s.language.toLowerCase())?.label ?? s.language;
  return { name: s.name, language, where: attached ? place : `Not attached: its disc or playlist is gone · was ${place}`, attached };
}

/** Why forgetting a drive's discs was refused, in the owner's words. */
export function forgetDriveError(err: unknown): string {
  const code = err instanceof NasHttpError ? err.code : null;
  if (code === 'drive-present') return 'This drive was found at the last scan, so its discs stay.';
  if (code === 'scanning') return 'The library is being scanned. Try again when the scan has finished.';
  return `Couldn't forget the drive's discs: ${err instanceof Error ? err.message : String(err)}`;
}
