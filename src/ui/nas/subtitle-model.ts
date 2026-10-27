import type { DiscManifest, DiscSlot, EpisodeRef, SeasonDetail, StoredSubtitle, SubtitleCreate, SubtitleFor, SubtitlePatch } from '../../engine/disc/nas-api';
import { Timeline, type Chapter } from '../../engine/nav/timeline';
import { mainPlaylistId, playlistOf } from './library-model';
import { NasHttpError, type NasClient } from './nas-client';
import { discHeading } from './title-model';

/** The server's limits (`server/src/subtitle-store.ts`), shown here so a pick is refused before it uploads. */
export const SUBTITLE_LIMIT_BYTES = 5 * 1024 * 1024;
export const FONTS_LIMIT_BYTES = 50 * 1024 * 1024;

/** The languages the upload form offers; any other BCP 47 tag may be typed. */
export const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh-Hans', label: 'Chinese (Simplified)' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)' },
  { code: 'ko', label: 'Korean' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
];

const SUBTITLE_EXT = /\.(?:srt|ass|ssa)$/i;
const FONT_EXT = /\.(?:ttf|otf|ttc|woff)$/i;
const WOFF2_EXT = /\.woff2$/i;

/** One subtitle file with its fonts, or why the pick can't be uploaded. */
export function validateUpload(files: readonly File[]): { subtitle: File; fonts: File[] } | { error: string } {
  const subtitles = files.filter((f) => SUBTITLE_EXT.test(f.name));
  const fonts = files.filter((f) => FONT_EXT.test(f.name));
  const woff2 = files.find((f) => WOFF2_EXT.test(f.name));
  if (woff2) return { error: `${woff2.name} is a WOFF2 font, which subtitles can't use. Convert it to TTF or OTF.` };
  const other = files.find((f) => !SUBTITLE_EXT.test(f.name) && !FONT_EXT.test(f.name));
  if (other) return { error: `${other.name} is neither a subtitle file nor a font.` };
  if (subtitles.length === 0) return { error: 'Pick a subtitle file (SRT, ASS or SSA).' };
  if (subtitles.length > 1) return { error: 'Pick one subtitle file (SRT or ASS) at a time.' };
  const subtitle = subtitles[0];
  if (subtitle.size === 0) return { error: `${subtitle.name} is empty.` };
  if (subtitle.size > SUBTITLE_LIMIT_BYTES) return { error: `${subtitle.name} is over 5 MB.` };
  if (fonts.reduce((n, f) => n + f.size, 0) > FONTS_LIMIT_BYTES) return { error: 'The fonts are over 50 MB together.' };
  return { subtitle, fonts };
}

/** Episode number to the languages stored for it in a season, sorted and without repeats. */
export function tagsByEpisode(subs: readonly StoredSubtitle[], seasonId: string): Map<number, string[]> {
  const sets = new Map<number, Set<string>>();
  for (const s of subs) {
    if (s.attachment.kind !== 'episode' || s.attachment.seasonId !== seasonId) continue;
    const set = sets.get(s.attachment.episode) ?? new Set<string>();
    set.add(s.language);
    sets.set(s.attachment.episode, set);
  }
  return new Map([...sets].map(([episode, set]) => [episode, [...set].sort()]));
}

/** How long the player waits for the NAS's list of a disc's stored subtitles. */
export const STORED_LIST_TIMEOUT_MS = 3000;

/** The subtitles stored for one playlist of a disc. */
export function forPlaylist(subs: readonly StoredSubtitle[], discKey: string, playlistId: string): StoredSubtitle[] {
  return subs.filter((s) => s.attachment.discKey === discKey && s.attachment.playlistId === playlistId);
}

/** Where a stored subtitle is placed, in playlist microseconds: an episode's at 0, a chapter's at its start; null when that chapter doesn't exist. */
export function startFor(s: StoredSubtitle, chapters: readonly { readonly startUs: number }[]): number | null {
  if (s.attachment.kind === 'episode') return 0;
  return chapters[s.attachment.chapter]?.startUs ?? null;
}

/** The first subtitle in a language (compared without case), or null. */
export function sameLanguage(subs: readonly StoredSubtitle[], language: string): StoredSubtitle | null {
  const wanted = language.toLowerCase();
  return subs.find((s) => s.language.toLowerCase() === wanted) ?? null;
}

/** A language's tag on an episode row: its primary subtag, upper-case ('zh-Hans' → 'ZH'). */
export function languageTag(language: string): string {
  return language.split('-')[0]!.toUpperCase();
}

/** The largest default offset the NAS takes, in milliseconds (`server/src/routes/subtitles.ts`). */
export const MAX_OFFSET_MS = 600_000;

/** A default offset typed in seconds, to whole milliseconds at one decimal; null when it isn't a number or is past ±600 s. */
export function parseOffset(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) return null;
  const ms = Math.round(seconds * 10) * 100;
  return Math.abs(ms) <= MAX_OFFSET_MS ? ms : null;
}

/** A default offset as the list shows it: '+0.4 s', '−1.5 s'; null for none. */
export function formatOffset(ms: number): string | null {
  if (ms === 0) return null;
  return `${ms > 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(1)} s`;
}

/** The shortest playlist the upload form offers for a disc and chapter. */
export const MIN_PLAYLIST_US = 60_000_000;

export interface PlaylistChoice {
  readonly id: string;
  readonly durationUs: number;
  readonly chapters: readonly Chapter[];
}

/**
 * The playlists a subtitle can be attached to, from a disc's manifest: those of a minute or more, the main title first,
 * then by id, each with its chapters; `keep` (the playlist an upload is attached to) is offered whatever its length.
 */
export function playlistChoices(manifest: DiscManifest, keep?: string): PlaylistChoice[] {
  const choices: PlaylistChoice[] = [];
  for (const { path } of manifest.files) {
    const m = /^BDMV\/PLAYLIST\/(\d{5})\.MPLS$/.exec(path);
    const mpls = m ? playlistOf(manifest, m[1]!) : null;
    if (!m || !mpls || mpls.playItems.length === 0) continue;
    const timeline = new Timeline(mpls.playItems, mpls.marks);
    if (timeline.durationUs < MIN_PLAYLIST_US && m[1] !== keep) continue;
    choices.push({ id: m[1]!, durationUs: timeline.durationUs, chapters: timeline.chapters(mpls.marks) });
  }
  const main = mainPlaylistId(manifest);
  return choices.sort((a, b) => Number(b.id === main) - Number(a.id === main) || a.id.localeCompare(b.id));
}

/** The subtitles a season's screen lists: its episodes', and those of a chapter of one of its discs (by disc key). */
export function forSeason(subs: readonly StoredSubtitle[], seasonId: string, discKeys: ReadonlySet<string>): StoredSubtitle[] {
  return subs.filter((s) => (s.attachment.kind === 'episode' ? s.attachment.seasonId === seasonId : discKeys.has(s.attachment.discKey)));
}

/**
 * The owner's list on a screen of a title, from the title's uploads: the attached ones of this season (`season`; all of
 * them on a movie's screen, `season` null), and every upload of the title that is not attached, on each of its screens,
 * so one whose disc, playlist or season went can always be re-attached or deleted. An episode upload whose season is
 * not one of the title's (`seasonIds`; a rescan gave the season another id) counts as not attached here, though its
 * disc and playlist still resolve and viewers still get it in the player; it is marked so, so Edit re-attaches it.
 */
export function ownerListing(
  subs: readonly StoredSubtitle[],
  season: { readonly id: string; readonly discKeys: ReadonlySet<string> } | null,
  seasonIds: ReadonlySet<string>,
): { readonly attached: StoredSubtitle[]; readonly notAttached: StoredSubtitle[] } {
  const lost = (s: StoredSubtitle): boolean => s.attachment.kind === 'episode' && !seasonIds.has(s.attachment.seasonId);
  const live = subs.filter((s) => s.attached !== false && !lost(s));
  return {
    attached: season ? forSeason(live, season.id, season.discKeys) : live,
    notAttached: subs.filter((s) => s.attached === false || lost(s)).map((s) => (s.attached === false ? s : { ...s, attached: false })),
  };
}

/** The default offset of the form's number field: null when the browser couldn't read it as a number (`badInput`). */
export function offsetFrom(text: string, badInput: boolean): number | null {
  return badInput ? null : parseOffset(text);
}

/**
 * An edit's PATCH body. A `for` is sent when the owner changed what the upload is for (and must then be complete), or
 * when the upload is not attached and the form names a complete place (re-attaching it); never otherwise, so a rename
 * works while the attachment can't be shown. `f` is the form's place, or why it is incomplete.
 */
export function editPatch(
  fields: { readonly name: string; readonly language: string; readonly offsetMs: number },
  f: SubtitleFor | string,
  opts: { readonly touched: boolean; readonly attached: boolean },
): SubtitlePatch | { readonly error: string } {
  if (opts.touched) return typeof f === 'string' ? { error: f } : { ...fields, for: f };
  if (!opts.attached && typeof f !== 'string') return { ...fields, for: f };
  return { ...fields };
}

/** What an upload sends: the client's subtitle writes. */
export type SubtitleWriter = Pick<NasClient, 'createSubtitle' | 'uploadSubtitleFile' | 'uploadSubtitleFont' | 'deleteSubtitle'>;

/**
 * Registers a subtitle, then sends its file, then each font (one request each). `onProgress` is told the bytes sent of
 * the total as they go. A failure after the subtitle was registered deletes it, so no half upload is left; the failure is thrown.
 */
export async function uploadSubtitle(
  nas: SubtitleWriter,
  body: SubtitleCreate,
  files: { readonly subtitle: File; readonly fonts: readonly File[] },
  onProgress?: (sent: number, total: number) => void,
): Promise<StoredSubtitle> {
  const total = files.subtitle.size + files.fonts.reduce((n, f) => n + f.size, 0);
  const created = await nas.createSubtitle(body);
  try {
    let sent = 0;
    // each file's bytes as they go, never going back (a retried request starts its count again)
    const tell = (n: number): void => {
      if (n > sent) onProgress?.((sent = n), total);
    };
    let stored = await nas.uploadSubtitleFile(created.id, files.subtitle, tell);
    let done = files.subtitle.size;
    tell(done);
    for (const font of files.fonts) {
      const before = done;
      stored = await nas.uploadSubtitleFont(created.id, font, (n) => tell(before + n));
      done += font.size;
      tell(done);
    }
    return stored;
  } catch (err) {
    await nas.deleteSubtitle(created.id).catch(() => {});
    throw err;
  }
}

/** What the owner is told when the NAS refuses a subtitle write. */
export function subtitleErrorMessage(err: unknown): string {
  if (err instanceof NasHttpError) {
    if (err.status === 413) return 'The NAS refused a file as too large (5 MB a subtitle file, 50 MB of fonts).';
    if (err.status === 400 && err.code === 'not-found') return "That episode or chapter isn't on the NAS any more.";
    if (err.status === 400 && err.code === 'bad-name') return 'The NAS refused a file name. Rename the file and try again.';
    if (err.status === 400 && err.code === 'empty') return 'The NAS refused an empty file.';
    if (err.status === 403) return 'Only owners can change subtitles on the NAS.';
    if (err.status === 404) return 'This subtitle is no longer on the NAS.';
    if (err.status === 503) return 'The NAS is busy. Try again in a moment.';
  }
  return err instanceof Error ? err.message : String(err);
}

/** A disc copy the upload form offers for a disc and chapter. */
export interface SubtitleDisc {
  readonly discId: string;
  readonly label: string;
}

/** What a screen's subtitles can be for: a season's episodes (none on a movie's screen) and the discs it shows. */
export interface SubtitleTarget {
  readonly titleId: string;
  readonly season: { readonly id: string; readonly episodes: readonly EpisodeRef[] } | null;
  readonly discs: readonly SubtitleDisc[];
}

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * A screen's target: `seasons`' discs and extras (and a title's own `extras`), each copy labelled with its disc and its
 * name; with `episodes`, the first season's episodes when it has them.
 */
export function subtitleTarget(titleId: string, seasons: readonly SeasonDetail[], opts: { readonly episodes: boolean; readonly extras?: readonly DiscSlot[] }): SubtitleTarget {
  const discs: SubtitleDisc[] = [];
  const add = (heading: string, slot: DiscSlot): void => {
    for (const c of slot.copies) {
      if (discs.some((d) => d.discId === c.discId)) continue;
      discs.push({ discId: c.discId, label: [heading, c.displayName ?? lastSegment(c.folder)].filter((x) => x !== '').join(' · ') });
    }
  };
  for (const s of seasons) {
    for (const slot of s.discs) add(discHeading(s, slot), slot);
    for (const slot of s.extras) add(slot.label, slot);
  }
  for (const slot of opts.extras ?? []) add(slot.label, slot);
  const first = seasons[0];
  return { titleId, season: opts.episodes && first?.episodes ? { id: first.id, episodes: first.episodes } : null, discs };
}
