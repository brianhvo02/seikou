// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The metadata panel's draft: per episode, the MKV title, the video, audio and subtitle tracks' names, languages, order
 * and ticks, and the chapter names, with the defaults the page fills in before the user edits anything. Chapter names
 * are not the record's: they come from the disc playlist's episode info (`EpisodeInfo.chapterNames`, keyed by playlist
 * chapter) and the panel saves them there, so the draft only shows them.
 */
import type { RecordAudio, TrackKind } from '../api-types';

/** One subtitle track as the metadata panel shows it. List order is the MKV track order. */
export interface TrackDraft {
  /** The track's file relative to the data directory (`CachedTrack.path`); identifies the track across releases. */
  readonly key: string;
  /** Whether the track holds the whole dialogue or only signs and songs. */
  readonly kind: TrackKind;
  /** Name shown in players. */
  readonly name: string;
  /** ISO 639-2 three-letter code. */
  readonly language: string;
  /** False when the user unticked the track to leave it out. */
  readonly included: boolean;
}

/** One episode's metadata: the saved record's fields plus the subtitle tracks' panel state. */
export interface EpisodeDraft {
  /** 1-based position in the run's episode list. */
  readonly index: number;
  /** The episode's own title from AniList; empty when AniList has none. */
  readonly episodeTitle: string;
  /** Title of the MKV. */
  readonly title: string;
  /** Name and three-letter language of the video track. */
  readonly video: { readonly name: string; readonly language: string };
  /** Audio streams in MKV order; the panel marks the first ticked one as the default. */
  readonly audio: readonly RecordAudio[];
  /** Chapter names in chapter order, from the episode info (`Chapter n` for a chapter it does not name). */
  readonly chapters: readonly string[];
  /** Subtitle tracks in MKV order; the panel marks the first ticked one as the default. */
  readonly tracks: readonly TrackDraft[];
}

/**
 * The whole panel. `edited` holds the paths of fields the user set, such as `episodes.1.title` or
 * `episodes.2.tracks`, so that refilling the defaults (when the show or the release changes) leaves them alone.
 */
export interface MetadataDraft {
  /** Each episode's draft, keyed by its 1-based index. */
  readonly episodes: Readonly<Record<number, EpisodeDraft>>;
  /** Paths of the fields the user typed, reordered or ticked. */
  readonly edited: ReadonlySet<string>;
}

/** A track as `defaultMetadata` needs it. */
export interface DefaultTrackInput {
  /** The track's name in the release; not used for the default name, which follows the group and kind. */
  readonly name: string;
  /** Whether it holds the whole dialogue or only signs and songs. */
  readonly kind: TrackKind;
  /** The release's language code for it; anything but three letters becomes `und`. */
  readonly language: string;
  /** The group of the release the track comes from (each episode's own); empty for the user's own files. */
  readonly group: string;
  /** The track's `CachedTrack.path`, which becomes `TrackDraft.key`; without it the key is the track's position. */
  readonly key?: string;
}

/** What `defaultMetadata` builds the draft from. */
export interface DefaultMetadataInput {
  /** The show's name as picked on AniList; null before a show is picked. */
  readonly show: string | null;
  /**
   * The run's episodes: `index` is the position in the run, `number` the episode number the title's `nn` shows (the
   * release's and AniList's numbering: the index plus the episode offset; the index when absent), `title` AniList's
   * episode title or null, `firstChapter` the playlist chapter the episode starts at (for `chapterNames`).
   */
  readonly episodes: readonly {
    readonly index: number;
    readonly number?: number;
    readonly title: string | null;
    readonly chapterCount: number;
    readonly firstChapter?: number;
  }[];
  /** The saved chapter names, keyed by playlist chapter (`EpisodeInfo.chapterNames`); none when absent. */
  readonly chapterNames?: Readonly<Record<string, string>>;
  /** The playlist's audio streams with their stream-table language (empty when the disc names none). */
  readonly audio: readonly { readonly pid: number; readonly language: string }[];
  /** The chosen subtitle tracks of each episode, keyed by episode index, in the order to offer them. */
  readonly tracks: Readonly<Record<number, readonly DefaultTrackInput[]>>;
}

/** An ISO 639-2 code as the record stores it: three lowercase letters, else `und` (undetermined). */
export function languageCode(raw: string): string {
  const code = raw.trim().toLowerCase();
  return /^[a-z]{3}$/.test(code) ? code : 'und';
}

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
  } catch {
    return null;
  }
})();

/**
 * A language's English name for a three-letter code (`jpn` gives `Japanese`), or an empty string for `und`, `mul`,
 * `zxx` and codes the browser cannot name.
 */
export function languageName(code: string): string {
  if (code === 'und' || code === 'mul' || code === 'zxx' || displayNames === null) return '';
  try {
    return displayNames.of(code) ?? '';
  } catch {
    return '';
  }
}

/** The default name of a subtitle track: the release group and the kind, such as `GroupA signs`, or the kind alone. */
export function defaultTrackName(group: string, kind: TrackKind): string {
  return group === '' ? kind : `${group} ${kind}`;
}

/** The name a chapter field shows when the episode info names no chapter: `Chapter n`, n counted within the episode. */
export function defaultChapterName(position: number): string {
  return `Chapter ${position + 1}`;
}

/** The first playlist chapter of each range of an episode list (`1-3,4-` gives `[1, 4]`), in order; a token that names none is skipped. */
export function firstChapters(episodeSpec: string): number[] {
  return episodeSpec.split(',').flatMap((t) => {
    const m = /^\s*(\d+)/.exec(t);
    return m ? [Number(m[1])] : [];
  });
}

/**
 * The names of one episode's chapters as the panel shows them: field `i` is playlist chapter `firstChapter + i`,
 * named from `chapterNames`, or `Chapter <i + 1>` when it has no name there.
 */
export function episodeChapterNames(chapterNames: Readonly<Record<string, string>>, firstChapter: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => chapterNames[String(firstChapter + i)] ?? defaultChapterName(i));
}

/**
 * `chapterNames` with one episode's fields put back by playlist chapter: field `i` is chapter `firstChapter + i`. A
 * field left empty or at the encoder's own `Chapter <n>` removes that chapter's name; the others are kept trimmed.
 * `chapterNames` is never changed.
 */
export function withChapterNames(chapterNames: Readonly<Record<string, string>>, firstChapter: number, fields: readonly string[]): Record<string, string> {
  const next: Record<string, string> = { ...chapterNames };
  fields.forEach((field, i) => {
    const key = String(firstChapter + i);
    const name = field.trim();
    if (name === '' || /^Chapter \d+$/.test(name)) delete next[key];
    else next[key] = name;
  });
  return next;
}

/** Whether two chapter name maps hold the same names for the same chapters. */
export function sameChapterNames(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** The default MKV title: `<Show> - <nn> - <episode title>`, leaving out the show or the episode title when unknown. */
export function defaultTitle(show: string | null, index: number, episodeTitle: string | null): string {
  const parts = [show, String(index).padStart(2, '0'), episodeTitle].filter((p): p is string => p !== null && p !== '');
  return parts.join(' - ');
}

/** The default draft of one subtitle track at position `position` of its episode. */
export function defaultTrack(track: DefaultTrackInput, position: number): TrackDraft {
  return {
    key: track.key ?? String(position),
    kind: track.kind,
    name: defaultTrackName(track.group, track.kind),
    language: languageCode(track.language),
    included: true,
  };
}

/**
 * The metadata the page proposes before the user edits anything: the MKV title from the show and AniList's episode
 * title, an unnamed video track in `und`, each audio stream named after its stream-table language (`und` and unnamed
 * when the disc gives none), each subtitle track named after its group and kind in the release's language, and
 * chapters named from `chapterNames` by the episode's `firstChapter`, else `Chapter n`. Every track is ticked; nothing
 * is marked edited.
 */
export function defaultMetadata(input: DefaultMetadataInput): MetadataDraft {
  const episodes: Record<number, EpisodeDraft> = {};
  for (const e of input.episodes) {
    episodes[e.index] = {
      index: e.index,
      episodeTitle: e.title ?? '',
      title: defaultTitle(input.show, e.number ?? e.index, e.title),
      video: { name: '', language: 'und' },
      audio: input.audio.map((a) => {
        const language = languageCode(a.language);
        return { pid: a.pid, name: languageName(language), language, included: true };
      }),
      chapters: episodeChapterNames(e.firstChapter === undefined ? {} : (input.chapterNames ?? {}), e.firstChapter ?? 1, e.chapterCount),
      tracks: (input.tracks[e.index] ?? []).map(defaultTrack),
    };
  }
  return { episodes, edited: new Set() };
}

/**
 * A copy of `list` with the item at `from` moved to `to`, the items between shifting by one. `to` is kept inside the
 * list; a `from` outside it moves nothing. `list` is never changed.
 */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list];
  if (!Number.isInteger(from) || from < 0 || from >= copy.length) return copy;
  const target = Math.min(Math.max(Math.trunc(to), 0), copy.length - 1);
  const [item] = copy.splice(from, 1);
  copy.splice(target, 0, item as T);
  return copy;
}

/**
 * The fields of an episode draft that a path can name, each tracked as one unit in `MetadataDraft.edited`. Chapters
 * are not among them: the panel saves their names to the episode info, and the draft takes them from there.
 */
const EDITABLE_FIELDS = new Set(['title', 'video', 'audio', 'tracks']);

/** `target` with `value` at `keys`, copying every object and array on the way; `target` is never changed. */
function setIn(target: unknown, keys: readonly string[], value: unknown): unknown {
  if (keys.length === 0) return value;
  const [key, ...rest] = keys as [string, ...string[]];
  if (Array.isArray(target)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= target.length) throw new Error(`no item ${key} in the list`);
    const copy = [...target];
    copy[index] = setIn(copy[index], rest, value);
    return copy;
  }
  if (typeof target !== 'object' || target === null || !(key in target)) throw new Error(`no field ${key}`);
  const record = target as Record<string, unknown>;
  return { ...record, [key]: setIn(record[key], rest, value) };
}

/**
 * The draft with `value` set at `path` by the user, such as `episodes.1.title`, `episodes.1.video.name` or
 * `episodes.2.tracks` (a whole list, for a reorder or a tick). The episode's field the path falls in
 * (`episodes.<n>.<field>`, one of title, video, audio, tracks) is marked edited, so `mergeDefaults` keeps
 * it from then on. Throws for a path that names no field of the draft; `draft` is never changed.
 */
export function withUserEdit(draft: MetadataDraft, path: string, value: unknown): MetadataDraft {
  const keys = path.split('.');
  const [root, index, field] = keys;
  if (root !== 'episodes' || index === undefined || field === undefined || !EDITABLE_FIELDS.has(field)) {
    throw new Error(`not an editable metadata path: ${path}`);
  }
  const episode = draft.episodes[Number(index)];
  if (episode === undefined) throw new Error(`no episode ${index} in the draft`);
  const changed = setIn(episode, keys.slice(2), value) as EpisodeDraft;
  const edited = new Set(draft.edited);
  edited.add(`episodes.${episode.index}.${field}`);
  return { episodes: { ...draft.episodes, [episode.index]: changed }, edited };
}

/** `edited` reconciled with `defaults` by `keyOf`: edited items still in the defaults, in their order, then new ones. */
function reconcile<T>(edited: readonly T[], defaults: readonly T[], keyOf: (item: T) => string | number): T[] {
  const wanted = new Set(defaults.map(keyOf));
  const kept = edited.filter((item) => wanted.has(keyOf(item)));
  const seen = new Set(kept.map(keyOf));
  return [...kept, ...defaults.filter((item) => !seen.has(keyOf(item)))];
}

/** Whether two values are the same; drafts hold only plain data. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One episode's draft after `mergeDefaults`. */
function mergeEpisode(draft: EpisodeDraft | undefined, defaults: EpisodeDraft, edited: ReadonlySet<string>): EpisodeDraft {
  if (draft === undefined) return defaults;
  const isEdited = (field: string) => edited.has(`episodes.${defaults.index}.${field}`);
  return {
    index: defaults.index,
    episodeTitle: defaults.episodeTitle,
    title: isEdited('title') ? draft.title : defaults.title,
    video: isEdited('video') ? draft.video : defaults.video,
    audio: isEdited('audio') ? reconcile(draft.audio, defaults.audio, (a) => a.pid) : defaults.audio,
    chapters: defaults.chapters,
    tracks: isEdited('tracks') ? reconcile(draft.tracks, defaults.tracks, (t) => t.key) : defaults.tracks,
  };
}

/**
 * The draft with fresh defaults (from `defaultMetadata`, built again whenever the show, the release, the chosen
 * tracks or the episode titles change) put into every field the user has not edited. An edited title or video is
 * kept as it is; edited audio and track lists keep their order, names and ticks for the streams and tracks the
 * defaults still list, drop the others and add new ones at the end. The episode titles, the chapter names (the
 * episode info's) and the set of episodes always follow the defaults. Answers
 * `draft` itself when nothing changes, so a caller can tell that nothing did.
 */
export function mergeDefaults(draft: MetadataDraft, defaults: MetadataDraft): MetadataDraft {
  const episodes: Record<number, EpisodeDraft> = {};
  for (const d of Object.values(defaults.episodes)) episodes[d.index] = mergeEpisode(draft.episodes[d.index], d, draft.edited);
  return same(episodes, draft.episodes) ? draft : { episodes, edited: draft.edited };
}
