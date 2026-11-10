// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The helper backend's answers as the page receives them. The backend's own types live in `encoder/src`, which needs
 * Node, so the page declares the wire shapes here; `encoder/src/server/README.md` is the reference for each route.
 * All times are milliseconds unless the name says otherwise.
 */
import type { EncodeTitle } from '@seikou/nas/encode-title';
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

/** One AniList entry with its next season (`GET /api/anilist/<id>`). */
export interface AniListEntry extends TitleHit {
  /** The next season: the entry's `SEQUEL` in a series format (`TV`, `TV_SHORT`, `ONA`), the earliest to start; null when none. */
  readonly sequel: TitleHit | null;
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

/** What a line-up is fetching from the NAS now (`GET /api/sessions/<id>/episodes/<n>/fetch`): bytes fetched of those it needs. */
export interface FetchProgress {
  readonly bytesDone: number;
  readonly bytes: number;
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
  /** Chapter names in chapter order, as older pages saved them; the page now sends `[]` and the backend saves `[]` (names live in `EpisodeInfo`). */
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
  /** With `otherEpisodeSpec`: how many queued or interrupted encodes use that record, and stop with a mismatch once it is replaced. */
  readonly queuedJobs?: number;
}

/** One disc in `GET /api/library`. */
export interface LibraryDiscInfo {
  /** The disc's key, the `<discKey>` of the disc routes. */
  readonly key: string;
  /** The disc folder's name. */
  readonly label: string;
  /** The folder's path under its library folder, with `/` separators; for a disc on the NAS, its path there. */
  readonly relPath: string;
  /** The library folder the disc was found under, or `NAS` for a disc on the NAS. */
  readonly root: string;
  /** Where the disc is: on this machine, or on the NAS (fetched as it is worked on). A disc in both is listed as the local copy. */
  readonly source: 'local' | 'nas';
  /** How many playlists the disc has. */
  readonly playlistCount: number;
  /** The playlists (five digits) that have a saved subtitle record. */
  readonly recordPlaylists: readonly string[];
  /** Other folders holding a disc with the same key (copies of it), root `NAS` for copies on the NAS; the disc is listed once, at its first folder. */
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
  /** The discs, sorted by path: those on this machine, then the NAS's. */
  readonly discs: readonly LibraryDiscInfo[];
  /** The NAS: whether the encoder is paired, whether its listing is being read, and whether the last read reached it (null before the first). */
  readonly nas: { readonly paired: boolean; readonly scanning: boolean; readonly reachable: boolean | null };
}

/** The settings of an encode that a profile holds. */
export interface EncodeSettings {
  /** SVT-AV1 constant rate factor, an integer 0 to 63; lower is better quality and bigger files. */
  readonly crf: number;
  /** SVT-AV1 preset, an integer -1 to 13; lower is slower and better. */
  readonly preset: number;
  /** Film-grain synthesis level, an integer 0 to 50. */
  readonly filmGrain: number;
  /** More SVT-AV1 arguments, one item per argument. */
  readonly extraSvtArgs: readonly string[];
  /** Opus bitrate in kb/s (an integer 6 to 512), or null for opusenc's own default. */
  readonly opusBitrate: number | null;
  /** Whether the disc's PGS subtitle tracks go into the MKV. */
  readonly pgs: boolean;
  /** Whether each episode is also packaged for the web player. */
  readonly web: boolean;
  /** The episode file name without its extension; contains `{n}`, the episode number. */
  readonly namePattern: string;
  /** Where the episodes go: a folder on this machine, or the paired NAS's Encodes library (`web` is then off). */
  readonly destination: EncodeDestination;
}

/** Where a job's episodes go. */
export type EncodeDestination = 'folder' | 'nas';

/** A named set of encode settings (`GET /api/profiles`). */
export interface Profile {
  /** `default` for the built-in profile, else a short URL-safe id. */
  readonly id: string;
  /** The profile's name, unique in any letter case. */
  readonly name: string;
  /** True for the built-in profile, which cannot be changed or deleted. */
  readonly builtIn: boolean;
  /** The settings. */
  readonly settings: EncodeSettings;
}

/** One chapter of a playlist: its 1-based number, where it starts and how long it is. */
export interface ChapterInfo {
  /** Chapter number, from 1. */
  readonly index: number;
  /** Start in milliseconds of playlist time. */
  readonly startMs: number;
  /** Length in milliseconds. */
  readonly lengthMs: number;
}

/** A playlist in full, as `GET /api/discs/<key>/playlists/<id>` answers. */
export interface PlaylistDetail {
  /** Five-digit playlist name. */
  readonly id: string;
  /** Length in milliseconds. */
  readonly durationMs: number;
  /** The chapters in order. */
  readonly chapters: readonly ChapterInfo[];
  /**
   * The episode list and AniList show of the playlist's saved subtitle record, or null when none is saved. The show
   * carries no episode offset: that is the release's numbering, never AniList's.
   */
  readonly record: { readonly episodeSpec: string; readonly anilist: { readonly id: number; readonly title: string } | null } | null;
}

/** One episode's title and number, keyed in `EpisodeInfo.titles` by the playlist chapter the episode starts at. */
export interface EpisodeTitle {
  /** The title the episode belongs to: an AniList entry, a TMDB season or film, or an own title. */
  readonly title: EncodeTitle;
  /** The episode's number in that title, from 1. */
  readonly episode: number;
  /** The episode's own name, or null. */
  readonly name: string | null;
  /** The show's name, kept for a title the NAS may not know (the `TITLE_NAME` tag). */
  readonly showName?: string | null;
}

/**
 * Chapter names and episode titles for one disc and playlist, keyed by playlist chapter so that regrouping keeps
 * them, as `GET /api/discs/<key>/playlists/<id>/info` answers.
 */
export interface EpisodeInfo {
  /** Playlist chapter number (1-based, as a string key) → name; a chapter with no entry keeps the encoder's naming. */
  readonly chapterNames: Readonly<Record<string, string>>;
  /** First playlist chapter of an episode (as a string key) → its title and number. */
  readonly titles: Readonly<Record<string, EpisodeTitle>>;
  /** Set when the user marked the playlist checked: the episode list confirmed and the signature of `titles` at that moment. */
  readonly checked?: { readonly episodeSpec: string; readonly signature: string; readonly at: string };
  /** When it was saved (ISO 8601), set by the backend. */
  readonly savedAt: string;
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

/** What a job does: encode a playlist's episodes, or encode short samples to compare settings. */
export type JobKind = 'encode' | 'test';

/** Where a job is. */
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';

/**
 * Where one episode of a job is; `packaging-failed` means the MKV is complete but its web package is not,
 * `upload-failed` that the MKV is complete and kept but the NAS has not taken it (a retry uploads it again), and
 * `upload-waiting` that the MKV is complete and its upload waits for the NAS while the job goes on encoding.
 */
export type JobEpisodeState = 'queued' | 'running' | 'done' | 'packaging-failed' | 'upload-failed' | 'upload-waiting' | 'failed';

/** What a running episode is doing. */
export type JobEpisodeStep = 'fetching' | 'encoding' | 'uploading';

/**
 * Where an episode's upload to the NAS is: the NAS's upload id, the file's hash and size, the bytes the NAS holds, and
 * `completing` while its completion was sent with no answer yet.
 */
export interface JobUploadState {
  readonly id: string | null;
  readonly sha256: string | null;
  readonly size: number;
  readonly sent: number;
  readonly completing?: true;
}

/** One episode of a job. */
export interface JobEpisode {
  /** 1-based position in the job's episode list. */
  readonly index: number;
  /** Where it is. */
  readonly state: JobEpisodeState;
  /** Video frames written so far in the current or last attempt. */
  readonly framesDone: number;
  /** The episode's video frames in all; 0 until the encoder has said. */
  readonly frames: number;
  /** Whether the episode's MKV was seen complete. */
  readonly encoded: boolean;
  /** The episode's MKV, once known. */
  readonly path?: string;
  /** Why the episode failed. */
  readonly error?: string;
  /** What the running episode is doing; null otherwise. */
  readonly step: JobEpisodeStep | null;
  /** Bytes fetched or uploaded so far in the current step. */
  readonly stepDone: number;
  /** Bytes the current fetch or upload moves in all; 0 until known, and while encoding. */
  readonly stepTotal: number;
  /** A NAS episode's upload, until the NAS has filed it. */
  readonly upload?: JobUploadState;
  /** The NAS's id of the uploaded episode (`<anilistId>-<episode>`). */
  readonly encodeId?: string;
}

/** A queued encode or test, as `GET /api/jobs` answers it. */
export interface Job {
  /** 16 lower-case hex digits. */
  readonly id: string;
  /** What the job does. */
  readonly kind: JobKind;
  /** The disc: its key, its folder's name and the folder holding BDMV. */
  readonly disc: { readonly key: string; readonly label: string; readonly dir: string };
  /** Five-digit playlist name. */
  readonly playlist: string;
  /** The episode list as it was given. */
  readonly episodeSpec: string;
  /** The settings the job was queued with. */
  readonly settings: EncodeSettings;
  /** The absolute folder the episodes are written to. */
  readonly outDir: string;
  /** Whether the encode leaves the saved subtitle choices out. */
  readonly noSubtitles: boolean;
  /** Where the job is. */
  readonly state: JobState;
  /** `Waiting for the NAS` while a step waits for the NAS to answer again; null otherwise. */
  readonly waiting: string | null;
  /** True while a test encode runs ahead of this queued job between two of its episodes. */
  readonly paused: boolean;
  /** ISO 8601 time the job was queued. */
  readonly createdAt: string;
  /** ISO 8601 time the job first ran. */
  readonly startedAt?: string;
  /** ISO 8601 time the job last finished, failed or stopped. */
  readonly finishedAt?: string;
  /** The episodes in order; for a test, one entry per sample encode (stretch by stretch, each with every profile). */
  readonly episodes: readonly JobEpisode[];
  /** Why the job failed. */
  readonly error?: string;
  /** When the subtitle choices the job encodes with were saved; null with none. */
  readonly recordSavedAt: string | null;
  /** The equivalent `seikou-encode encode …` command, quoted for a shell; empty for a test. */
  readonly cli: string;
  /** A test job's profiles, stretches and measurements; absent on an encode. */
  readonly test?: TestPlan;
}

/**
 * What `POST /api/jobs` answers for an encode: the Job, with `warning: 'replaces-files'` when it re-encodes the same
 * disc, playlist and episodes into a folder where an earlier job's files have the same names, so its files replace them.
 */
export type QueuedJob = Job & { readonly warning?: 'replaces-files' };

/** One profile a test encodes with. */
export interface TestProfile {
  /** The profile's id; the samples' folder name. */
  readonly id: string;
  /** The profile's name. */
  readonly name: string;
  /** The settings the samples were encoded with. */
  readonly settings: EncodeSettings;
}

/** What one profile's samples measured. */
export interface TestProfileResult {
  /** The profile's id. */
  readonly id: string;
  /** Video bytes per second of the profile's samples. */
  readonly videoBytesPerSecond: number;
  /** Bytes per second of the shared audio sample (one stream). */
  readonly audioBytesPerSecond: number;
}

/** What a test job holds besides what every job has. */
export interface TestPlan {
  /** The profiles compared, in order. */
  readonly profiles: readonly TestProfile[];
  /** The stretches of playlist time sampled, in milliseconds; sample `n` (from 1) is stretch `n`. */
  readonly stretches: readonly { readonly startMs: number; readonly endMs: number }[];
  /** Each episode's length in seconds. */
  readonly episodeSeconds: readonly number[];
  /** How many audio streams an encode of the episodes writes; null until the test has run. */
  readonly audioStreams: number | null;
  /** Each profile's measurements in profile order; null until the test is done. */
  readonly results: readonly TestProfileResult[] | null;
}

/** What `POST /api/jobs` takes for a test encode. */
export interface NewTest {
  /** The disc's key. */
  readonly discKey: string;
  /** Five-digit playlist name. */
  readonly playlistId: string;
  /** The episode list. */
  readonly episodeSpec: string;
  /** One to three profiles to compare. */
  readonly profiles: readonly TestProfile[];
  /** Whether the encode the test prepares would leave the saved subtitle choices out (it changes how many audio streams it writes). */
  readonly noSubtitles: boolean;
}

/** A progress report for one episode of a running job, sent at most once a second. */
export interface JobProgress {
  /** The job. */
  readonly jobId: string;
  /** 1-based episode number. */
  readonly episode: number;
  /** Video frames written so far. */
  readonly framesDone: number;
  /** The episode's video frames in all. */
  readonly frames: number;
  /** Frames per second so far; null before any time has passed. */
  readonly fps: number | null;
  /** Seconds left for this episode; null when the speed is unknown. */
  readonly etaSeconds: number | null;
}

/** What `POST /api/jobs` takes. */
export interface NewJob {
  /** The disc's key. */
  readonly discKey: string;
  /** Five-digit playlist name. */
  readonly playlistId: string;
  /** The episode list. */
  readonly episodeSpec: string;
  /** The settings: a copy of a profile's. */
  readonly settings: EncodeSettings;
  /** The absolute output folder. */
  readonly outDir: string;
  /** Leave the saved subtitle choices out. */
  readonly noSubtitles: boolean;
}

/**
 * What `GET /api/nas` answers: not paired, or paired with the NAS at `host` as `personName`; `reachable` says whether
 * the NAS answered just now, and `encodes` whether it keeps encodes (`not-configured`: its `ENCODES_MOUNT` is not set;
 * `unknown` while it does not answer).
 */
export type NasStatus =
  | { readonly paired: false }
  | {
      readonly paired: true;
      readonly host: string;
      readonly personName: string;
      readonly reachable: boolean;
      readonly encodes: 'ready' | 'not-configured' | 'unknown';
    };

/** What `POST /api/nas/pair` takes: a pairing code with the NAS's API address, or a pairing link. */
export type NasPairingRequest = { readonly code: string; readonly base: string } | { readonly link: string };

/** One show in `GET /api/nas/shows`. */
export interface NasShow {
  /** The NAS's title id (`anilist:<n>`, `tmdb-tv:<n>`, `tmdb-movie:<n>`, `own:<uuid>`). */
  readonly titleId: string;
  readonly name: string;
  /** The poster's route on the backend; `createAppApi` makes it a URL with the token. Null when there is none. */
  readonly poster: string | null;
  readonly kind: 'series' | 'movie';
  /** Numbered seasons. */
  readonly seasons: number;
  /** Seasons without a number (a film's or an entry's disc-only discs). */
  readonly films: number;
  /** Episodes of the show the Encodes library already holds. */
  readonly encoded: number;
  /** Episodes of the show it does not hold yet. */
  readonly toEncode: number;
}

/** A disc the NAS holds that no title claims. */
export interface NasUnsortedDisc {
  /** The encoder's disc key. */
  readonly key: string;
  readonly label: string;
  readonly relPath: string;
}

/** What `GET /api/nas/shows` answers. */
export interface NasShowsAnswer {
  readonly shows: NasShow[];
  readonly unsorted: NasUnsortedDisc[];
  /** False while the NAS does not answer; the shows are then the last answer. */
  readonly reachable: boolean;
  /** The answer is the kept one, or its encodes list could not be read now. */
  readonly stale: boolean;
}

/** The title an encode is tagged with, as `EpisodeTitle` holds it. */
export type NasEncodeTitle = EpisodeTitle['title'];

/** One disc of a season in `GET /api/nas/shows/<titleId>`. */
export interface NasSeasonDisc {
  /** The encoder's disc key. */
  readonly key: string;
  readonly discId: string;
  readonly label: string;
  readonly playlists: { readonly id: string; readonly episodes: { readonly number: number; readonly name: string | null; readonly encoded: boolean }[] }[];
  /** Every playlist with episodes is checked (a disc listing none: any saved playlist of it is). */
  readonly checked: boolean;
}

/** One season, or with `number: null` a film or disc-only group. */
export interface NasSeason {
  readonly id: string;
  readonly label: string;
  readonly number: number | null;
  /** The title its encodes are tagged with; null while the NAS has none for it. */
  readonly title: NasEncodeTitle | null;
  readonly discs: NasSeasonDisc[];
}

/** What `GET /api/nas/shows/<titleId>` answers. */
export interface NasShowAnswer {
  readonly title: { readonly titleId: string; readonly name: string; readonly poster: string | null; readonly kind: 'series' | 'movie' };
  readonly seasons: NasSeason[];
  readonly reachable: boolean;
  readonly stale: boolean;
}
