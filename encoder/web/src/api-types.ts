// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The helper backend's answers as the page receives them. The backend's own types live in `encoder/src`, which needs
 * Node, so the page declares the wire shapes here; `encoder/src/server/README.md` is the reference for each route.
 * All times are milliseconds unless the name says otherwise.
 */
import type { FansubAlignment } from '@seikou/nas/nas-api';

export type { FansubAlignment };

/** What a subtitle track holds: the whole dialogue, or only signs, songs and forced lines. */
export type TrackKind = 'full' | 'signs';

/** `GET /api/sessions/<id>`: which disc and episode list the helper session is about. */
export interface SessionInfo {
  /** The disc's key, the `<discKey>` of the disc routes and the name of the saved record. */
  readonly discKey: string;
  /** The disc folder's name. */
  readonly label: string;
  /** The playlist's five-digit id, such as `00000`. */
  readonly playlistId: string;
  /** The episode spec as typed, such as `1-3,4-5`: one comma-separated chapter range per episode. */
  readonly episodeSpec: string;
  /** Whether VapourSynth with BestSource was found, so lining up can run. */
  readonly toolsReady: boolean;
}

/** One episode in playlist time. */
export interface EpisodeTimes {
  /** 1-based position in the episode list. */
  readonly index: number;
  /** Microseconds of playlist time of the episode's first frame, where its encode, alignment and retimed track count from. */
  readonly startUs: number;
  /** The episode's length in microseconds. */
  readonly durationUs: number;
  /** Chapter starts in microseconds of playlist time; the first equals `startUs`. */
  readonly chapters: readonly { readonly startUs: number }[];
}

/** An audio stream of the playlist's first play item. */
export interface AudioStreamInfo {
  /** The stream's PID, which keys it in the saved record. */
  readonly pid: number;
  /** The stream table's coding type (0x80 LPCM, 0x81 AC-3, 0x83 TrueHD, ...). */
  readonly codingType: number;
  /** ISO 639-2 code as the playlist gives it; empty when the disc names none. */
  readonly language: string;
}

/** `GET /api/sessions/<id>/episodes`. */
export interface EpisodesAnswer {
  /** The session's episodes, in order. */
  readonly episodes: readonly EpisodeTimes[];
  /** Audio streams in the order players number them. */
  readonly audio: readonly AudioStreamInfo[];
  /** How many PG (picture subtitle) streams the playlist has. */
  readonly pgCount: number;
}

/** One AniList search result. */
export interface TitleHit {
  /** The AniList id. */
  readonly alId: number;
  /** The English name, else the romaji one, else the native one. */
  readonly title: string;
  /** The native name; null when AniList has none. */
  readonly nativeTitle: string | null;
  /** Year the show started; null when unknown. */
  readonly year: number | null;
  /** AniList's format (`TV`, `MOVIE`, `OVA`, ...); null when unknown. */
  readonly format: string | null;
  /** The episode count; null while airing or unknown. */
  readonly episodes: number | null;
  /**
   * URL of the cover image, served by the backend from its own origin (the page is cross-origin isolated, and
   * AniList's image host does not allow that); null when there is none.
   */
  readonly poster: string | null;
}

/** One release SeaDex lists for a show. */
export interface SeaDexRelease {
  /** The release group. */
  readonly group: string;
  /** Where SeaDex found it, such as `Nyaa`. */
  readonly tracker: string;
  /** Whether SeaDex marks it as the best release. */
  readonly isBest: boolean;
  /** Whether it carries more than one audio language. */
  readonly dualAudio: boolean;
  /** SeaDex's tags for it. */
  readonly tags: readonly string[];
  /** The Anime Tosho id to fetch it by; null when it cannot be fetched. */
  readonly toshoId: number | null;
  /** Why it cannot be fetched, or null when it can. */
  readonly unavailable: null | 'private-tracker' | 'not-on-tosho';
}

/** `GET /api/sessions/<id>/fansubs/seadex`: SeaDex's entry for a show, best releases first. */
export interface SeaDexAnswer {
  /** SeaDex's notes as plain text; empty when none. */
  readonly notes: string;
  /** SeaDex's comparison links as text; empty when none. */
  readonly comparison: string;
  /** The show's page on SeaDex. */
  readonly url: string;
  /** Fetchable releases in rank order, then the private-tracker ones. */
  readonly releases: readonly SeaDexRelease[];
}

/** One Anime Tosho search result. */
export interface ToshoHit {
  /** The Anime Tosho id to fetch it by. */
  readonly toshoId: number;
  /** The release's title. */
  readonly title: string;
  /** When it was posted, in seconds since the Unix epoch. */
  readonly date: number;
}

/** One cached subtitle track of a release file. */
export interface CachedTrack {
  /** The track's id within its file; ids repeat between files. */
  readonly id: string;
  /** The track's name in the release. */
  readonly name: string;
  /** The track's language as the release names it, usually ISO 639-2. */
  readonly language: string;
  /** The track's ASS file, relative to the data directory; unique across releases, so it identifies the track. */
  readonly path: string;
  /** Whether the track holds the whole dialogue or only signs and songs. */
  readonly kind: TrackKind;
  /** How many dialogue lines the track has. */
  readonly dialogueLines: number;
}

/** A release file and its cached tracks. */
export interface CachedReleaseFile {
  /** The file's id within its release. */
  readonly id: string;
  /** The file's name, which carries its episode number. */
  readonly name: string;
  /** The file's subtitle tracks. */
  readonly tracks: readonly CachedTrack[];
}

/** A track the backend did not keep, and why. */
export interface SkippedTrack {
  /** The release file it belongs to. */
  readonly fileId: string;
  /** The track's name. */
  readonly name: string;
  /** Its format as the source names it. */
  readonly format: string;
  /** A short reason, such as an unsupported format. */
  readonly reason: string;
}

/** A release the backend holds: a fetched Anime Tosho release or the user's own files. */
export interface CachedRelease {
  /** `tosho-<id>` or `local-<16 hex>`; names the release in later requests. */
  readonly key: string;
  /** Where the files came from. */
  readonly source: 'tosho' | 'local';
  /** A name to show. */
  readonly label: string;
  /** The release group; empty for the user's own files. */
  readonly group: string;
  /** The release's files with their tracks. */
  readonly files: readonly CachedReleaseFile[];
  /** Fonts by their original names; fetch one with `HelperApi.fontUrl`. */
  readonly fonts: readonly { readonly name: string; readonly path: string }[];
  /** Tracks left out; absent when none were. */
  readonly skipped?: readonly SkippedTrack[];
}

/** One disc episode's match against a release. */
export interface MatchRow {
  /** The disc's episode number, from 1. */
  readonly episode: number;
  /** The chosen file's id, or null when no file fits. */
  readonly fileId: string | null;
  /** Every file id numbered for this episode, newest version first. */
  readonly candidates: readonly string[];
}

/** A release's files matched to the session's episodes. */
export interface ReleaseMatch {
  /** One row per episode of the session, in order. */
  readonly rows: readonly MatchRow[];
  /** Extras, unnumbered files and numbers outside the session. */
  readonly unmatched: readonly CachedReleaseFile[];
}

/** The answer of fetch, upload and release: the release plus its match at the requested episode offset. */
export type ReleaseAnswer = CachedRelease & { readonly match: ReleaseMatch };

/** A stretch of episode time in milliseconds from the episode's first frame. */
export interface Span {
  /** Start, in milliseconds. */
  readonly fromMs: number;
  /** End, in milliseconds. */
  readonly toMs: number;
}

/** `POST /api/sessions/<id>/episodes/<n>/align`. */
export interface AlignAnswer {
  /** The timing found for the episode's tracks, or why there is none. */
  readonly alignment: FansubAlignment;
  /** The track it was found on; the file's other tracks share its timing. */
  readonly trackId: string;
  /** Where the disc's audio holds speech. */
  readonly speech: readonly Span[];
  /** The track's dialogue lines at its own timing. */
  readonly dialogue: readonly Span[];
}

/** One subtitle track of an episode in the saved record. Array order is the MKV track order. */
export interface RecordTrack {
  /** The track's ASS file, relative to the data directory. */
  readonly file: string;
  /** The id of the track's release in `SubtitleRecord.releases`. */
  readonly release: string;
  /** Whether the track holds all dialogue or only signs and songs. */
  readonly kind: TrackKind;
  /** ISO 639-2 three-letter code. */
  readonly language: string;
  /** Name shown in players. */
  readonly name: string;
  /** Shift found by lining up, in milliseconds; 0 for a split, which `split` carries. */
  readonly shiftMs: number;
  /** The user's adjustment on top of the shift, in milliseconds. */
  readonly nudgeMs: number;
  /** Per-part offsets: from `fromMs` on, use `offsetMs`. Null when the track was not split. */
  readonly split: readonly { readonly fromMs: number; readonly offsetMs: number }[] | null;
  /** False when the user left the track out. */
  readonly included: boolean;
}

/** A release the record's tracks came from. */
export interface RecordRelease {
  /** Where the release came from: SeaDex's list, an Anime Tosho search, or the user's own files. */
  readonly source: 'seadex' | 'tosho' | 'local';
  /** The backend's release key, such as `tosho-7`; a track's `release` names it. */
  readonly id: string;
  /** The release group; empty for the user's own files. */
  readonly group: string;
  /** A name to show. */
  readonly label: string;
}

/** One audio stream's settings in the saved record. */
export interface RecordAudio {
  /** The playlist's PID for the stream. */
  readonly pid: number;
  /** Name shown in players. */
  readonly name: string;
  /** ISO 639-2 three-letter code. */
  readonly language: string;
  /** False when the user left the stream out. */
  readonly included: boolean;
}

/** The container metadata of one episode in the saved record. */
export interface RecordMetadata {
  /** Title of the MKV. */
  readonly title: string;
  /** Name and three-letter language of the video track. */
  readonly video: { readonly name: string; readonly language: string };
  /** Audio streams in MKV order; the first carries the default flag. */
  readonly audio: readonly RecordAudio[];
  /** Chapter names in chapter order. */
  readonly chapters: readonly string[];
}

/** One episode in the saved record. */
export interface RecordEpisode {
  /** 1-based position in the session's episode list. */
  readonly index: number;
  /** The episode's own title (AniList's, or `Episode n`). */
  readonly title: string;
  /** Subtitle tracks in MKV order; the first of each kind is the default. */
  readonly tracks: readonly RecordTrack[];
  /** The metadata panel's values. */
  readonly metadata: RecordMetadata;
}

/** Everything saved for one disc and playlist; the encode reads it. All paths are relative to the data directory. */
export interface SubtitleRecord {
  /** The disc's key and folder name. */
  readonly disc: { readonly key: string; readonly label: string };
  /** The five-digit playlist id. */
  readonly playlist: string;
  /** The episode spec the record was made for; the encode refuses another. */
  readonly episodeSpec: string;
  /** The show picked on AniList, and how many episodes the release numbers ahead of the disc. */
  readonly anilist: { readonly id: number; readonly title: string; readonly episodeOffset: number } | null;
  /** Every release a saved track came from, in the order they were added; empty when no track is saved. */
  readonly releases: readonly RecordRelease[];
  /** Font files the tracks use: the fonts of every release in `releases`, each once. */
  readonly fonts: readonly string[];
  /** The session's episodes in index order. */
  readonly episodes: readonly RecordEpisode[];
  /** When it was saved (ISO 8601 UTC). The server sets it; the page sends an empty string. */
  readonly savedAt: string;
}

/**
 * A record in the form saved before a record could hold several releases: one `release` (null when none was picked)
 * and tracks that do not name theirs. The backend answers every record in the current form, so the page meets this
 * one only from an older source; `fromRecord` reads it as a one-release record.
 */
export interface SingleReleaseRecord extends Omit<SubtitleRecord, 'releases' | 'episodes'> {
  /** The one release every track came from; null when none was picked. */
  readonly release: RecordRelease | null;
  /** The episodes, whose tracks all belong to `release`. */
  readonly episodes: readonly (Omit<RecordEpisode, 'tracks'> & { readonly tracks: readonly Omit<RecordTrack, 'release'>[] })[];
}

/** `GET /api/sessions/<id>/record`. */
export interface RecordAnswer {
  /** The saved record (a single-release one from an older backend is read through `currentForm`), or null when none was saved or the file was unreadable. */
  readonly record: SubtitleRecord | SingleReleaseRecord | null;
  /** Cached files the record names that are gone, by release: its id (null for a record with no release), its label and the paths. */
  readonly missing: readonly { readonly id: string | null; readonly release: string; readonly files: readonly string[] }[];
  /** Set when a record file exists but could not be read; the page then starts fresh. */
  readonly error?: { readonly code: 'record-unreadable'; readonly message: string };
  /** Set when the disc and playlist have a saved record for another episode list (its spec); `record` is then null. */
  readonly otherEpisodeSpec?: string;
}

/** One disc in `GET /api/library`. */
export interface LibraryDiscInfo {
  /** The disc's key, the `<discKey>` of the disc routes. */
  readonly key: string;
  /** The disc folder's name. */
  readonly label: string;
  /** The folder's path under its library folder, with `/` separators. */
  readonly relPath: string;
  /** The library folder the disc was found under. */
  readonly root: string;
  /** How many playlists the disc has. */
  readonly playlistCount: number;
  /** The playlists (five digits) that have a saved subtitle record. */
  readonly recordPlaylists: readonly string[];
  /** Other folders holding a disc with the same key (copies of it); the disc is listed once, at its first folder. */
  readonly otherPaths: readonly { readonly relPath: string; readonly root: string }[];
}

/** `GET /api/library`: the library folders and the discs found under them. */
export interface LibraryAnswer {
  /** The library folders, saved ones first, then those the run was given. */
  readonly roots: readonly string[];
  /** The roots saved in the settings, the ones the page edits. */
  readonly savedRoots: readonly string[];
  /** The roots only this run's command line gave: scanned, never saved, not removable from the page. */
  readonly runRoots: readonly string[];
  /** The folders the last scan could not read; their discs from the scan before stay in `discs`. */
  readonly unreadableRoots: readonly string[];
  /** Whether a scan is running; `discs` is then the last complete scan. */
  readonly scanning: boolean;
  /** The discs, sorted by path. */
  readonly discs: readonly LibraryDiscInfo[];
}

/** One playlist in `GET /api/discs/<key>/playlists`. */
export interface PlaylistSummary {
  /** Five-digit playlist name. */
  readonly id: string;
  /** Length in milliseconds. */
  readonly durationMs: number;
  /** How many play items the playlist has. */
  readonly clips: number;
  /** How many chapters the playlist has. */
  readonly chapters: number;
  /** At least 20 minutes and at least 4 chapters, or the longest playlist of the disc. */
  readonly likelyMain: boolean;
}
