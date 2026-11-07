// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The metadata panel's draft: per episode, the MKV title, the video, audio and subtitle tracks' names, languages, order
 * and ticks, and the chapter names, with the defaults the page fills in before the user edits anything.
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
  /** Audio streams in MKV order; the first carries the default flag. */
  readonly audio: readonly RecordAudio[];
  /** Chapter names in chapter order. */
  readonly chapters: readonly string[];
  /** Subtitle tracks in MKV order; the first of each kind carries the default flag. */
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
  /** The release group; empty for the user's own files. */
  readonly group: string;
  /** The track's `CachedTrack.path`, which becomes `TrackDraft.key`; without it the key is the track's position. */
  readonly key?: string;
}

/** What `defaultMetadata` builds the draft from. */
export interface DefaultMetadataInput {
  /** The show's name as picked on AniList; null before a show is picked. */
  readonly show: string | null;
  /** The run's episodes: `index` gives the `nn` of the title, `title` is AniList's episode title or null. */
  readonly episodes: readonly { readonly index: number; readonly title: string | null; readonly chapterCount: number }[];
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
 * chapters named `Chapter n`. Every track is ticked; nothing is marked edited.
 */
export function defaultMetadata(input: DefaultMetadataInput): MetadataDraft {
  const episodes: Record<number, EpisodeDraft> = {};
  for (const e of input.episodes) {
    episodes[e.index] = {
      index: e.index,
      episodeTitle: e.title ?? '',
      title: defaultTitle(input.show, e.index, e.title),
      video: { name: '', language: 'und' },
      audio: input.audio.map((a) => {
        const language = languageCode(a.language);
        return { pid: a.pid, name: languageName(language), language, included: true };
      }),
      chapters: Array.from({ length: e.chapterCount }, (_, i) => `Chapter ${i + 1}`),
      tracks: (input.tracks[e.index] ?? []).map(defaultTrack),
    };
  }
  return { episodes, edited: new Set() };
}
