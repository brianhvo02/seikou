/** Types shared by the NAS server and the app. No runtime code. */
import type { EncodeTitle } from './encode-title';

/**
 * One disc of the NAS library, as `GET discs` lists it (server to app).
 * @internal
 */
export interface DiscEntry {
  /** The disc's id on this NAS, derived from its path, size and modification time, so a changed disc gets a new id. */
  readonly id: string;
  /** The folder's or ISO file's name. */
  readonly name: string;
  /** Root-relative, e.g. 'media5/[250226] Starfall Wanderer'. This is the key: names can repeat across roots. */
  readonly path: string;
  /** A BDMV folder, or a `.iso` file read through the UDF reader. */
  readonly kind: 'folder' | 'iso';
  /** For a folder, the sum of its stream files' sizes; for an ISO, the file's size. In bytes. */
  readonly sizeBytes: number;
}

/**
 * A folder of the library listing, which holds discs or other folders (server to app).
 * @internal
 */
export interface FolderEntry {
  /** The folder's own name. */
  readonly name: string;
  /** Root-relative, like `DiscEntry.path`. */
  readonly path: string;
  /** Discs below it. */
  readonly discs: number;
}

/**
 * A library root, as `GET admin/drives` lists it: its discs now, and whether the last scan found it missing or empty.
 * @internal
 */
export interface NasDrive {
  /** The root's name, the first segment of its discs' paths. */
  readonly name: string;
  /** How many discs the root holds now, kept from the last scan that found it when it is missing. */
  readonly discs: number;
  /** True when the last scan found the root's folder missing or empty. */
  readonly missing: boolean;
}

/**
 * The answer to `GET library`: one folder's subfolders and discs (server to app).
 * @internal
 */
export interface LibraryListing {
  /** The subfolders. */
  readonly folders: FolderEntry[];
  /** The discs directly in the folder. */
  readonly discs: DiscEntry[];
  /** True while a scan runs, so the listing may still grow. */
  readonly scanning: boolean;
}

/**
 * The routes a pairing code leads to: the NAS's HTTPS API base and its WebRTC signalling id.
 * @internal
 */
export interface CodeRoutes {
  /** The NAS's HTTPS API base URL; absent when the NAS has no public HTTPS address. */
  readonly https?: string;
  /** The NAS's signalling id on the rendezvous Worker (`/signal/device?nasId=`); the Worker adds it to every lookup. */
  readonly webrtc?: { readonly nasId: string };
}

/**
 * The rendezvous service's answer to `POST /codes/lookup { code }`.
 * @internal
 */
export interface CodeLookup {
  /** The NAS's id: the thumbprint of its registered key. */
  readonly nasId: string;
  /** Where the app can reach that NAS. */
  readonly routes: CodeRoutes;
}

/**
 * `POST /nas`: a NAS registers its P-256 ECDSA public key once and gets its id.
 * @internal
 */
export interface NasRegistration {
  /** The key the NAS signs its code registrations with. */
  readonly publicKeyJwk: EcPublicJwk;
}

/**
 * A P-256 public key as a JWK.
 * @internal
 */
export interface EcPublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  /** The point's x coordinate, base64url. */
  readonly x: string;
  /** The point's y coordinate, base64url. */
  readonly y: string;
}

/**
 * `POST /codes`: a NAS registers a code by its hash. `signature` is the NAS key's ECDSA P-256 / SHA-256
 * signature (IEEE P1363, base64url) over the canonical JSON of the other fields.
 * @internal
 */
export interface CodeRegistration {
  /** The registering NAS's id. */
  readonly nasId: string;
  /** Hex SHA-256 of the normalized code. */
  readonly codeHash: string;
  /** Where the code leads; the WebRTC route is added by the Worker from `nasId`. */
  readonly routes: { readonly https?: string };
  /** Epoch ms; the Worker refuses one in the past or more than 3 days and an hour ahead (`MAX_CODE_AHEAD_MS` in `rendezvous/src/protocol.ts`: invites live 3 days). */
  readonly expiresAt: number;
  /** Base64url signature, as described above. */
  readonly signature: string;
}

/**
 * One viewing the NAS GPU is encoding, from `GET admin/encoding` (owners only).
 * @internal
 */
export interface EncodingNow {
  /** The person watching. */
  readonly personName: string;
  /** The device the viewing belongs to. */
  readonly deviceName: string;
  /** The disc's name. */
  readonly discName: string;
  readonly level: LevelId;
  /** The level's display label. */
  readonly label: string;
  /** The share of the GPU's capacity this viewing's lease holds, in percent. */
  readonly gpuPercent: number;
}

/** `GET /api/discs/<id>/manifest`: a folder disc's files, with the small ones the engine reads whole inlined. */
export interface DiscManifest {
  readonly discId: string;
  /** The disc's display name. */
  readonly name: string;
  /** Paths upper-case and relative to the disc folder, like `normalizeDiscPaths`: 'BDMV/STREAM/00001.M2TS'. */
  readonly files: readonly { readonly path: string; readonly size: number }[];
  /** The small files (metadata, not streams), by the same paths, each as the base64 of the whole file. */
  readonly inline: Readonly<Record<string, string>>;
}

/** Why the NAS's title matcher left a disc in Unsorted, shown to the owner. */
export type UnsortedReason = 'no-title' | 'several-fit' | 'no-season' | 'episode-past-season' | 'no-disc-number' | 'sources-disagree' | 'source-unreachable';

/** What a title in the library is: a series, a movie or a music release. */
export type TitleKind = 'series' | 'movie' | 'music';
/** A title's names in each form the sources give; any may be absent. */
export interface TitleNames {
  readonly english: string | null;
  /** The Japanese name in Latin letters. */
  readonly romaji: string | null;
  /** The name in the title's own language and script. */
  readonly native: string | null;
  /** Other names the title is known by; the library search matches them too. */
  readonly synonyms: readonly string[];
  /** A name the owner set for a music title, shown before the others. */
  readonly display: string | null;
}
/** What a music release is. */
export type MusicKind = 'concert' | 'album' | 'single' | 'other';
/** What the Music shelf knows about a release: its artist (grouping id, headline and native name), kind and names. */
export interface TitleMusic {
  /** The artist: `id` groups releases on one tile, `name` is the headline and `otherName` the same name in the other script, if known. */
  readonly artist: { readonly id: string; readonly name: string; readonly otherName: string | null };
  readonly kind: MusicKind;
  /** The release date as the lookup or the folder name gave it, else null. */
  readonly date: string | null;
  /** A concert's own name, else null. */
  readonly concertName: string | null;
  /** The release's title. */
  readonly title: string;
  /** True when a MusicBrainz or Discogs release backs the info. */
  readonly matched: boolean;
  /** True when the owner rejected the lookup's match, so the info comes from the folder name alone. */
  readonly rejected: boolean;
}
/** A title as a card of the library: no seasons or discs, only counts (server to app). */
export interface TitleSummary {
  /** The catalogue's id for the title; stable between runs except as `docs/known-issues.md` describes for an AniList series. */
  readonly id: string;
  readonly kind: TitleKind;
  readonly names: TitleNames;
  /** An art id for `GET art/<id>`, never a URL; null when there is no poster. */
  readonly poster: string | null;
  /** The year the title started, else null. */
  readonly year: number | null;
  /** How many seasons a series has; 0 for a movie or music title. */
  readonly seasons: number;
  /** How many disc slots (discs and extras) the title holds; copies of a disc count once. */
  readonly discs: number;
  /** Epoch ms when the NAS first saw the newest of the title's discs. */
  readonly addedAt: number;
  /** True for a title the owner added by hand. */
  readonly own: boolean;
  /** Present on a music title only. */
  readonly music?: TitleMusic;
}
/** One copy of a disc in a title (server to app). */
export interface DiscRef {
  readonly discId: string;
  /** The library root the disc is under: the first segment of its path. */
  readonly root: string;
  /** The rest of the path below that root; empty when the disc is the root's own folder. */
  readonly folder: string;
  /** A name the owner gave the disc, else null. */
  readonly displayName: string | null;
}
/** One disc of a season: the copies of it the library holds. */
export interface DiscSlot {
  /** The disc's number in the season, null when it has none. */
  readonly number: number | null;
  /** Shown for the slot: `Disc N`, or for a disc with no number the first copy's display name, else the last segment of its folder. */
  readonly label: string;
  /** Every copy of the disc, the preferred one first. */
  readonly copies: readonly DiscRef[];
}
/** One episode of a season and where it plays (server to app). */
export interface EpisodeRef {
  readonly number: number;
  /** The episode's name from the metadata, else null. */
  readonly name: string | null;
  /** The runtime in minutes, else null. */
  readonly runtimeMin: number | null;
  /** The disc holding the episode (its first copy), and the playlist on that disc that plays it. */
  readonly discId: string;
  readonly playlistId: string;
}
/** A movie's or music title's discs are one season with `number: null` and label ''. */
export interface SeasonDetail {
  /** The season's id within the title, used in routes and subtitle attachments. */
  readonly id: string;
  readonly label: string;
  /** The season's number, null for a movie or music title's single season. */
  readonly number: number | null;
  /** The season's discs, in disc order. */
  readonly discs: readonly DiscSlot[];
  /** The episode list, or null when the NAS can't tell which playlists are episodes (no Episodes tab then). */
  readonly episodes: readonly EpisodeRef[] | null;
  /** Discs filed as extras of this season. */
  readonly extras: readonly DiscSlot[];
}
/** `poster` and `banner` are art ids for `GET art/<id>`, never source URLs. */
export interface TitleDetail {
  readonly title: TitleSummary;
  /** An art id, else null. */
  readonly banner: string | null;
  readonly seasons: readonly SeasonDetail[];
  /** Other titles of the same story (sequels, films) the library holds. */
  readonly related: readonly TitleSummary[];
  /** Discs filed as extras of the title as a whole. */
  readonly extras: readonly DiscSlot[];
}

/** What the owner decided for one disc. */
export type OwnerChoice =
  /** File the disc under a title, in a season (null when the title has none) and as a disc number (null to leave it to the matcher). */
  | { readonly kind: 'title'; readonly titleId: string; readonly season: number | null; readonly disc: number | null }
  /** File the disc as music; `name` is a display name, `artist` the artist's name, `rejectMatch` drops the lookup's release. */
  | { readonly kind: 'music'; readonly name: string | null; readonly artist?: string | null; readonly rejectMatch?: boolean }
  /** File the disc as an extra of a title, or of one season of it. */
  | { readonly kind: 'extras'; readonly titleId: string; readonly season: number | null }
  /** Keep the disc out of the library listings. */
  | { readonly kind: 'hidden' };
/**
 * `GET admin/anilist-place/<anilistId>`: where an owner's choice files a disc under that AniList entry, whether or not
 * the NAS holds a disc of it. A TV entry in a chain is its series (`titleId`, as the catalogue keys it) and its season
 * number in the chain; a film, OVA or other non-TV entry is a title of its own (`anilist:<id>`) with no season. `name`
 * is what that season or title shows.
 * @internal
 */
export interface AnilistPlace { readonly titleId: string; readonly season: number | null; readonly name: string }
/** A title the owner added by hand, for discs the sources don't know. */
export interface OwnTitle {
  /** `own:<uuid>`. */
  readonly id: string;
  readonly kind: TitleKind;
  readonly name: string;
  /** How many seasons a series has; null for a movie or when not set. */
  readonly seasons: number | null;
}
/**
 * A title suggested for an Unsorted disc, with the season the owner's Season field starts at: the matcher's
 * season for it, else the season the disc's names give, else the entry's place in its chain; null when none is known
 * or the title has no seasons.
 */
export interface UnsortedSuggestion extends TitleSummary { readonly seasonHint: number | null }
/** A disc in Unsorted with what the owner needs to file it (server to app, owners only). */
export interface UnsortedItem {
  readonly discId: string;
  /** Root-relative path of the disc. */
  readonly path: string;
  /** The disc's own titles from `bdmt` metadata, by language code. */
  readonly discTitles: readonly { readonly lang: string; readonly name: string }[];
  readonly reason: UnsortedReason;
  readonly suggestions: readonly UnsortedSuggestion[];
  /** The first catalogue-number-like token in the disc's names, else null. */
  readonly catalogueNumber: string | null;
  /** The disc's parent folder (its path without the last segment); discs of one folder are filed together with "apply to the group". */
  readonly group: string;
  /** How many discs the group holds. */
  readonly groupSize: number;
}

/** A text subtitle file of a place: identified by name and size (its bytes stay on the device). */
export interface PlaceTextFile {
  /** The file's name and size in bytes. */
  readonly name: string; readonly size: number;
  /** Where in the playlist the file starts, in microseconds of playlist time; null for the whole playlist. */
  readonly startUs: number | null;
  /** The viewer's timing offset, in milliseconds. */
  readonly offsetMs: number;
  /** A subtitle stored on the NAS (piece 3): its id, fetched again on a resume, and its language, which Up next carries. */
  readonly subtitleId?: string; readonly language?: string;
  /** A viewer's own Anime Tosho pick: picked again from the NAS on a resume (its release listed first), carried by track name to Up next. */
  readonly fansub?: PlaceFansub;
  /**
   * On an encoded episode: the source disc and playlist the NAS subtitle belongs to (a stored subtitle's attachment, or
   * where an Anime Tosho pick was lined up), since the encode's own key is not one the subtitle store knows.
   */
  readonly source?: PlaceSubtitleSource;
}
/** The disc and playlist a NAS subtitle shown on an encoded episode was made for. */
export interface PlaceSubtitleSource {
  /** The source disc's key. */
  readonly discKey: string;
  /** The playlist on that disc. */
  readonly playlistId: string;
}
/** The Anime Tosho release, file and track of a viewer's own pick. */
export interface PlaceFansub {
  /** Anime Tosho's release id and file id. */
  readonly releaseId: number; readonly fileId: number;
  /** The subtitle track's number in that file, and its name. */
  readonly track: number; readonly trackName: string;
}
/** The player settings a place carries, so resuming on another device sounds and looks the same (app to server and back). */
export interface PlaceSettings {
  /** The language of the chosen audio and PG tracks as the disc's stream attributes give it, which Up next picks again in the next episode; null when unknown. */
  readonly audioLanguage: string | null; readonly pgLanguage: string | null;
  readonly textFiles: readonly PlaceTextFile[];
  /** Player status registers 1 to 3: the audio stream number, the PG/text subtitle stream number with its display flag, and the angle. Used on resume. */
  readonly psr1: number; readonly psr2: number; readonly psr3: number;
  /** Whether text subtitles are on, and their scale (1 is normal). */
  readonly textOn: boolean; readonly textScale: number;
  /** The shader set's name; the resume ignores it on another device, where shaders start off. */
  readonly shaderSet: string | null;
  /** Volume from 0 to 1, and whether the player was muted. */
  readonly volume: number; readonly muted: boolean;
}
/** Where one person stopped in one playlist of a disc (see `docs/superpowers/specs/2026-10-20-permalinks-resume-design.md`). `finished` places stay for Up next, and go first when the store is full. */
export interface PlaybackPlace {
  /** The disc's key (`disc-key.ts`), and the id of the copy the place was saved on. */
  readonly discKey: string; readonly discId: string;
  /** The playlist's id, such as `00800`. */
  readonly playlistId: string;
  /** Position and playlist length, in microseconds of playlist time. */
  readonly timeUs: number; readonly durationUs: number;
  /** True once the playlist counts as watched; a finished place resumes nothing. */
  readonly finished: boolean;
  /** The program running: an HDMV one, a BD-J one, or none (a playlist picked directly). */
  readonly mode: 'hdmv' | 'bdj' | 'none';
  /** The title number the program was in (PSR4); null when none. */
  readonly title: number | null;
  /** All 128 player status registers, in order. */
  readonly psrs: readonly number[];
  /** The general purpose registers that are not zero, by number; null when none was saved. */
  readonly gprs: Readonly<Record<number, number>> | null;
  readonly settings: PlaceSettings;
  /** Epoch ms of the save; the server clamps one more than five minutes ahead of its clock. */
  readonly updatedAt: number;
  /** The name of the device that saved it. */
  readonly deviceName: string;
}
/**
 * One person's places in one disc: by playlist id, with the settings of the latest put as `defaults`.
 * @internal
 */
export interface DiscPlaces {
  /** The settings of the latest put on this disc, for a playlist that has no place of its own; null when none. */
  readonly defaults: PlaceSettings | null;
  /** The places by playlist id. */
  readonly places: Readonly<Record<string, PlaybackPlace>>;
}

/**
 * One card of the Continue watching row. `up-next` is the episode after a finished one, to start from the beginning.
 * A card of the encodes list carries `encodeId`, with `discKey` and `discId` empty and `playlistId` `mkv`; there the
 * title is the encodes show, the season its AniList entry.
 */
export interface ContinueItem {
  readonly kind: 'resume' | 'up-next';
  /** The disc's key, the disc's id and the playlist to open; as in `PlaybackPlace`. */
  readonly discKey: string; readonly discId: string; readonly playlistId: string;
  /** The encoded episode, `<titlePart>-<episode>`; only on a card of the encodes list. */
  readonly encodeId?: string;
  /** Where to resume and the playlist's length, in microseconds. */
  readonly timeUs: number; readonly durationUs: number;
  /** The catalogue title the place belongs to and its display name and poster art id; null when the disc isn't in the catalogue (or a guest may not see it). */
  readonly titleId: string | null; readonly titleName: string | null; readonly poster: string | null;
  /** The season and episode it is, when it is an episode; null otherwise. */
  readonly seasonId: string | null; readonly seasonNumber: number | null; readonly episode: number | null;
  readonly kindOfTitle: TitleKind | null;
  /** Epoch ms of the save the card comes from, and the device that made it. */
  readonly updatedAt: number; readonly deviceName: string;
  /** An Up next card's: the finished episode's settings, which carry on to the next (picked again by language); null on a resume card. */
  readonly settings: PlaceSettings | null;
}

/** How far one person is in a playlist, for the progress mark on an episode. */
export interface PlaylistProgress {
  /** Position and playlist length in microseconds. */
  readonly timeUs: number; readonly durationUs: number;
  readonly finished: boolean;
}

/** What a stored subtitle is for: one episode's playlist, or the start of a chapter of a disc's playlist. */
export type SubtitleAttachment =
  | { readonly kind: 'episode'; readonly discKey: string; readonly playlistId: string; readonly titleId: string; readonly seasonId: string; readonly episode: number }
  /** `titleId`: the title it was uploaded from, so its owners still find it there when the disc is gone (listing only). */
  | { readonly kind: 'chapter'; readonly discKey: string; readonly playlistId: string; readonly chapter: number; readonly titleId?: string };
/**
 * What a subtitle is for when it is registered or moved: an episode of a title's season, or a chapter of a disc's
 * playlist (with the title it is uploaded from, which the app always sends).
 * @internal
 */
export type SubtitleFor =
  | { readonly kind: 'episode'; readonly titleId: string; readonly seasonId: string; readonly episode: number }
  | { readonly kind: 'chapter'; readonly discId: string; readonly playlistId: string; readonly chapter: number; readonly titleId?: string };
/**
 * The body of `POST /api/subtitles`.
 * @internal
 */
export interface SubtitleCreate {
  /** The file's name, as the viewer sees it. */
  readonly name: string;
  readonly language: string;
  /** The default timing offset in milliseconds; 0 when absent. */
  readonly offsetMs?: number;
  /** What the subtitle is for. */
  readonly for: SubtitleFor;
}
/**
 * The body of `PATCH /api/subtitles/<id>`: any of these.
 * @internal
 */
export type SubtitlePatch = Partial<SubtitleCreate>;
/** A subtitle file (SRT or ASS) an owner uploaded to the NAS, with its fonts. */
export interface StoredSubtitle {
  readonly id: string;
  /** The name shown in menus. */
  readonly name: string; readonly language: string;
  /** The default timing offset, in milliseconds, applied when the subtitle is picked. */
  readonly offsetMs: number;
  /** The stored file's name and size in bytes. */
  readonly fileName: string; readonly fileSize: number;
  /** The fonts uploaded with the file, by name and size in bytes. */
  readonly fonts: readonly { readonly name: string; readonly size: number; /** sha256 hex of a pooled font (fansubs); owner uploads have none. */ readonly hash?: string }[];
  readonly attachment: SubtitleAttachment;
  /** Epoch ms of the upload. */
  readonly uploadedAt: number;
  /** Who uploaded it; in answers to owners only. */
  readonly uploaderPersonId?: string;
  /** Set by the route: false when the attachment's disc or playlist no longer resolves (owners only see these). */
  readonly attached?: boolean;
  /** Set by the route for owners: a fansub lined up on a disc or playlist the episode no longer resolves to. */
  readonly stale?: boolean;
  /** Where a fansub came from; absent for an owner upload. */
  readonly source?: FansubSource;
  /** A fansub whose script names fonts its archive didn't carry. */
  readonly fontsMissing?: boolean;
  /** Set only by the picks route: a viewer's own Anime Tosho pick, served from `fansubs/picks/<id>/`, not the store. */
  readonly pick?: true;
}

/** How SeaDex rates a release: its best pick, a web release, or any other. */
export type SeaDexRank = 'best' | 'web' | 'other';

/**
 * One line of a season's summary: the group that fits best and the groups whose tracks were used.
 * @internal
 */
export interface FansubSeasonLine {
  /** The release group SeaDex ranks best for the season, else null. */
  readonly bestGroup: string | null;
  /** The groups the attached tracks came from, with SeaDex's rank for each. */
  readonly usedGroups: readonly { readonly group: string; readonly rank: SeaDexRank }[];
}

/**
 * What the fansub run found for one episode.
 * @internal
 */
export interface FansubEpisodeMark {
  readonly status: 'attached' | 'not-found';
  /** Why nothing was attached, when `status` is `not-found`. */
  readonly reason?: 'no-release' | 'no-tracks' | 'service-unavailable' | 'too-large';
}

/**
 * The fansub run's state for one title; `seasons` is keyed by season id, `episodes` by `"<seasonId>#<episode>"`.
 * @internal
 */
export interface FansubTitleState {
  readonly titleId: string;
  /** Epoch ms when the last run finished; null when none has. */
  readonly lastRunAt: number | null;
  /** True while a run is in progress. */
  readonly running: boolean;
  /** True when the last run attached no track to any episode (no release found, or none gave a usable track). */
  readonly nothingFound: boolean;
  readonly seasons: Readonly<Record<string, FansubSeasonLine>>;
  readonly episodes: Readonly<Record<string, FansubEpisodeMark>>;
}

/**
 * A release in `GET fansubs/search`; `seadex` is its rank in the SeaDex entry of the title the search named, else null.
 * @internal
 */
export interface ToshoSearchResult {
  /** Anime Tosho's release id. */
  readonly id: number;
  readonly title: string;
  /** Seconds since the epoch when the release was posted, as the Anime Tosho feed gives it. */
  readonly date: number;
  readonly seadex: SeaDexRank | null;
}

/**
 * `GET fansubs/releases/<id>`: its files with their ASS/SSA tracks, and the file of the episode the disc and playlist are.
 * @internal
 */
export interface ToshoReleaseFiles {
  readonly release: ToshoSearchResult;
  readonly files: readonly {
    /** Anime Tosho's file id, the file's name, and the episode its name gives (null when it names none). */
    readonly id: number; readonly name: string; readonly episode: number | null;
    /** The file's ASS/SSA subtitle tracks: the track's number in the file, its language and its name. */
    readonly tracks: readonly { readonly track: number; readonly language: string; readonly name: string }[];
  }[];
  /** The file for the episode the request's disc and playlist are, else null. */
  readonly matchedFileId: number | null;
}

/**
 * The body of `POST fansubs/picks`: a track of an Anime Tosho file, lined up on this disc's playlist.
 * @internal
 */
export interface FansubPickRequest {
  /** Anime Tosho's file id and the track's number in it. */
  readonly fileId: number; readonly track: number;
  /** The disc and playlist the track is lined up on. */
  readonly discKey: string; readonly playlistId: string;
}

/** A viewer's pick: shaped as a stored subtitle, its files under `fansubs/picks/<id>/`. */
export type FansubPick = StoredSubtitle & { readonly pick: true; readonly source: FansubSource };

/** How a fansub's timing was lined up with the disc's audio. */
export type FansubAlignment =
  /** One offset for the whole track, in milliseconds, with the aligner's confidence. */
  | { readonly kind: 'offset'; readonly offsetMs: number; readonly confidence: number }
  /** A different offset from each `fromMs` (milliseconds in the subtitle track's own time, before any offset) on, for a stretch where the disc and the release differ. */
  | { readonly kind: 'split'; readonly parts: readonly { readonly fromMs: number; readonly offsetMs: number }[]; readonly confidence: number }
  /** No line-up found; the track keeps its own timing. */
  | { readonly kind: 'none'; readonly reason: 'no-speech' | 'low-confidence' }
  /** The owner chose the release's own timing. */
  | { readonly kind: 'original' };

/** A subtitle track fetched from Anime Tosho, and the disc and playlist it was lined up on. */
export interface FansubSource {
  readonly kind: 'fansub';
  /** The release group. */
  readonly group: string;
  /** The tracker the release came from, as SeaDex names it. */
  readonly tracker: string;
  readonly rank: SeaDexRank;
  /** Anime Tosho's file id, the track's number in it and its name. */
  readonly toshoFileId: number;
  readonly track: number;
  readonly trackName: string;
  readonly alignment: FansubAlignment;
  /** The disc and playlist the timing was worked out against. */
  readonly linedUpOn: { readonly discKey: string; readonly playlistId: string };
}

/**
 * The quality levels a disc can be served at; `original` is the disc's own bytes.
 * @internal
 */
export type LevelId = 'original' | 'h264-1080' | 'phone-720' | 'hevc-1080' | 'hevc-1080-hdr' | 'h264-1080-sdr';

/**
 * Why a level isn't available: `no-encoder` when the NAS's encoder for its codec failed its self-test (or has none).
 * @internal
 */
export type LevelReason = 'unplayable' | 'no-encoder' | 'no-hevc' | 'no-hevc10' | 'no-hdr-display' | 'busy';

/**
 * One entry of `GET discs/<id>/levels`.
 * @internal
 */
export interface LevelInfo {
  readonly level: LevelId;
  readonly label: string;
  /** The rate the level travels at (its byte budget over the main clip's film, padding included), Mbps to 0.1. */
  readonly budgetMbps: number;
  readonly available: boolean;
  readonly reason?: LevelReason;
}

/**
 * A version of a disc: a level with the audio stream it keeps (`audio` is 1-based, as PSR1).
 * @internal
 */
export interface LevelAt {
  /** The level; `original` is the disc's own bytes. */
  readonly level: LevelId;
  readonly audio: number;
}

/* The encodes library (`/api/encodes/…`): the NAS's encoded episodes, grouped by show (AniList, TMDB or the owner's own titles). */

/** One episode of a season. */
export interface EncodeEpisode {
  readonly episode: number;
  /** The encode's id, `<titlePart>-<episode>` (`990001-3`, `tv990101s1-2`, …). */
  readonly id: string;
  /** The episode's title from its tags, else null. */
  readonly title: string | null;
  /** The episode's length in milliseconds. */
  readonly durationMs: number;
}

/**
 * One row of a show with encodes: an AniList entry (a TV season, a film, or another row such as an OVA), a TMDB
 * series' season, a TMDB film, or an own title (by season, or one row). Only rows with encodes exist.
 */
export interface EncodeSeason {
  /** The title the row's encodes are tagged with. */
  readonly title: EncodeTitle;
  /** The AniList entry's id, else null. */
  readonly anilistId: number | null;
  /** The row's display name. */
  readonly name: string;
  readonly kind: 'season' | 'film' | 'other';
  /** The season's number (its place in an AniList series' chain, a TMDB or own title's season number), else null. */
  readonly number: number | null;
  /** The row's episodes, by number. */
  readonly episodes: readonly EncodeEpisode[];
}

/** A show: a series' seasons then its films and others, or one film. `poster` is an art id, never a URL. */
export interface EncodeShow {
  /**
   * An AniList show's root entry id, as a string; `tv<tmdbId>` for a TMDB series, `mv<tmdbId>` for a TMDB film,
   * `own<32 hex>` for an own title.
   */
  readonly id: string;
  readonly name: string;
  /** An art id for `GET art/<id>`; null when there is none. */
  readonly poster: string | null;
  readonly seasons: readonly EncodeSeason[];
}

/**
 * `GET encodes/status`. `scanning` while the first scan runs; `rootMissing`, `rootEmpty` and `scanError` are the index's state.
 * @internal
 */
export interface EncodesStatus {
  /** False when the NAS has no encodes folder (`ENCODES_DIR`); `count` is then 0 and the other fields are absent. */
  readonly configured: boolean;
  /** How many encodes the index lists. */
  readonly count?: number;
  readonly scanning?: boolean;
  readonly rootMissing?: boolean;
  readonly rootEmpty?: boolean;
  readonly scanError?: string;
}

/**
 * A show of `GET encodes/shows`.
 * @internal
 */
export interface EncodeShowSummary {
  readonly id: string;
  readonly name: string;
  readonly poster: string | null;
  /** How many episodes the show has in all. */
  readonly episodeCount: number;
  /** The AniList ids of the show's seasons, films and other entries: where an episode's show is found in one request. */
  readonly anilistIds: readonly number[];
  /** The title parts (`titlePart`) of the show's rows, AniList's included. */
  readonly titles: readonly string[];
}

/**
 * `GET encodes/shows`: the shows by name, and for owners the files the index could not file (paths under the encodes folder).
 * @internal
 */
export interface EncodeShowList {
  readonly shows: readonly EncodeShowSummary[];
  readonly unfiled?: readonly { readonly path: string; readonly size: number }[];
}

/**
 * An encoded episode's track, as `GET encodes/<id>` lists it (`codec` is the Matroska codec id, such as `V_AV1`).
 * @internal
 */
export interface EncodeTrackInfo {
  readonly kind: 'video' | 'audio' | 'subtitle';
  readonly codec: string;
  /** The track's language as the file gives it (ISO 639-2). */
  readonly language: string;
  readonly name: string;
  /** The file's default and forced flags for the track. */
  readonly isDefault: boolean;
  readonly isForced: boolean;
}

/**
 * `GET encodes/<id>`: an encoded episode as the NAS indexed it. Times are in milliseconds.
 * @internal
 */
export interface EncodeDetail {
  /** `<titlePart>-<episode>` (`encode-id.ts`): `990001-3` for an AniList entry, `tv990101s1-2`, `mv990102-1`, `own<hex>-4`. */
  readonly id: string;
  /** The title the episode's tags name; absent from a NAS from before titles beyond AniList (an AniList title then). */
  readonly title?: EncodeTitle;
  /** The `TITLE_NAME` tag, the title's name when the NAS has no metadata for it; absent from an older NAS. */
  readonly titleName?: string | null;
  /** The title's AniList id, else null; kept for clients from before titles beyond AniList. */
  readonly anilistId: number | null;
  readonly episode: number;
  readonly episodeTitle: string | null;
  /** The source disc's key and playlist, from the `SEIKOU_DISC_KEY` and `SEIKOU_PLAYLIST` tags; null when the file has none. */
  readonly discKey: string | null;
  readonly playlistId: string | null;
  /** Where the episode starts in that playlist, in milliseconds (`SEIKOU_EPISODE_START_MS`); null when not tagged. */
  readonly episodeStartMs: number | null;
  /** The file's size in bytes and its modification time in epoch ms. */
  readonly size: number;
  readonly mtimeMs: number;
  readonly durationMs: number;
  /** The chapters by start and end in milliseconds (end null when the file gives none), and their names. */
  readonly chapters: readonly { readonly startMs: number; readonly endMs: number | null; readonly name: string | null }[];
  readonly tracks: readonly EncodeTrackInfo[];
}

/**
 * `GET`/`PUT me/player-settings`: one person's player settings, the same on each of their devices.
 * @internal
 */
export interface PlayerSettings {
  /** The next episode starts by itself after a 10 s countdown. */
  readonly nextEpisodeCountdown: boolean;
}
