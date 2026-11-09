import type { MemoryProfileName } from './memory-profile';
import type { JvmMemoryStats } from './bdj-types';
import type { ClockMode } from './clock/master-clock';
import type { DiscErrorCode } from '@seikou/bdmv/byte-source';
import type { DiscManifest } from '@seikou/nas/nas-api';
import type { DiscSpec, RemoteDiscSpec } from './disc/disc-spec';
import type { RemoteFailure } from './disc/http-transport';
import type { PlaylistSummary } from './disc/open-disc';
import type { UoOp } from './hdmv/uo-mask';
import type { Chapter } from './nav/timeline';

export type PlaybackState = 'idle' | 'loading' | 'paused' | 'buffering' | 'playing' | 'ended' | 'error';
export type NoticeCode = 'no-picture' | 'bdj' | 'bdj-tap-ignored' | 'bdj-failed' | 'bdj-storage' | 'audio-disabled' | 'decoder-recovered' | 'uo-masked' | 'subtitle-file' | 'subtitle-fonts' | 'menu-memory' | 'nas-waiting';
/** RemoteFailure: a NAS disc changed, the NAS cannot be reached, or this device is no longer paired. */
export type ErrorCode = DiscErrorCode | RemoteFailure | 'corrupt-disc' | 'decoder-failed' | 'no-video' | 'internal';

export interface Telemetry {
  readonly clockUs: number;
  readonly clockMode: ClockMode;
  /** Mean of (clock − frame timestamp) for frames first drawn in this window while playing. */
  readonly avOffsetMeanUs: number | null;
  readonly avOffsetMaxAbsUs: number | null;
  readonly framesInWindow: number;
  /** Decoded frames presented; stays 0 for a playlist without a picture (whose bdj.firstFrameMs is its first black frame). */
  readonly framesPresented: number;
  readonly framesDropped: number;
  readonly audioBufferedMs: number;
  readonly audioUnderruns: number;
  readonly corruptPackets: number;
  /** Coding name of the stream whose decoder last produced PCM, or null before any. */
  readonly audioCodec: string | null;
  readonly audioDecodeErrors: number;
  readonly continuityErrors: number;
  readonly decoderErrors: number;
  /** Decoding restarts on an open-GOP (non-IDR) keyframe in this session, and leading pictures skipped after them. */
  readonly openGopStarts: number;
  readonly leadingPicturesSkipped: number;
  /** Interactive menu state (PSR11, PSR10, draw operations in the last repaint of the IG plane), or null while no menu is open. */
  readonly menu: { readonly page: number; readonly selectedButton: number; readonly buttonsDrawn: number } | null;
  /** Corrupt IG segments dropped. */
  readonly igErrors: number;
  /** Menu sound effects asked for since the disc opened. */
  readonly soundsPlayed: number;
  /** The last PG display set shown: composition objects drawn and how many of them were forced; null before any (and after a reset). */
  readonly pg: { readonly objectsShown: number; readonly forced: number } | null;
  /** Corrupt PG segments dropped. */
  readonly pgErrors: number;
  /** A text subtitle cue is on screen. */
  readonly textCue: boolean;
  /** Index (name order) of the subtitle set's file showing now, or null. */
  readonly textFile: number | null;
  /** The showing ASS file's last draw (events drawn, how many animate, its time), its draws so far and those over 8 ms; null otherwise. */
  readonly ass: { readonly events: number; readonly animated: number; readonly renderMs: number; readonly overBudget: number; readonly renders: number } | null;
  /** The shader set that shaded the last frame drawn: passes run and GPU time (null without a timer query); null when unshaded. */
  readonly shader: { readonly set: string; readonly passesRun: number; readonly gpuMs: number | null } | null;
  /**
   * BD-J start-up (spec §4.7), in ms since the disc's open command: the worker booted, Java selected its first playlist,
   * the first frame of that playlist was presented. Each is null until it happens; the whole is null when no BD-J title
   * has run since the disc opened.
   */
  readonly bdj: BdjTelemetry | null;
  /**
   * While a BD-J title runs: its graphics plane's flushes and the taps on its menu that brought no reaction. `hash` is
   * the plane's hash (tools/bdj-trace's) once it has stayed unchanged for a telemetry interval, else null; only with
   * PlayerDeps.planeHashTelemetry (test-only, ?telemetry=1), as it costs a pass over the whole plane.
   */
  readonly bdjPlane: { readonly flushes: number; readonly tapsIgnored: number; readonly hash?: string | null } | null;
  /** While a BD-J title runs, what it holds in memory; only with PlayerDeps.memoryTelemetry (?telemetry=1). */
  readonly bdjMemory?: BdjMemoryTelemetry | null;
}

/** BD-J's memory (5d spec §4.5), for the device measurements; sizes in bytes. */
export interface BdjMemoryTelemetry {
  /** The JVM's own accounting, as the BD-J worker last reported it (every BDJ_MEMORY_STATS_MS); null before. */
  readonly jvm: JvmMemoryStats | null;
  /** FreeType's WASM memory and open faces in the BD-J worker; null until FreeType is loaded. */
  readonly freeType: { readonly wasmBytes: number; readonly faces: number } | null;
  /** The graphics plane's shared buffer. */
  readonly planeBytes: number;
  /** Decoded background stills, shown and being decoded. */
  readonly stillBytes: number;
  /** The compositor's copy of the plane (canvas and ImageData); 0 while it has none. */
  readonly compositorBytes: number;
}

export interface BdjStartup {
  readonly bootMs: number | null;
  readonly firstPlaylistMs: number | null;
  /** For a playlist without a picture: its first black frame with the planes (framesPresented stays 0). */
  readonly firstFrameMs: number | null;
}

export interface BdjTelemetry extends BdjStartup {
  /**
   * Menu responsiveness (5d spec §4.2) since the disc opened: from a key press or a click/tap reaching the engine to
   * the next presented frame containing a BD-J plane change published after it, in ms (last, largest, and how many
   * inputs were answered); null before any. Pointer moves are not counted.
   */
  readonly inputLatencyMs: { readonly last: number; readonly max: number; readonly count: number } | null;
}

/** A set of mpv user shaders, in the order they run. */
export interface ShaderSetData { readonly name: string; readonly files: readonly { readonly name: string; readonly source: string }[] }

export type ShaderState = 'off' | 'compiling' | 'active' | 'error' | 'unavailable';

/** A file's name and bytes, transferred with the command. */
export interface FileData { readonly name: string; readonly bytes: ArrayBuffer }

/** One file of the subtitle set, in name order. */
export interface TextFileInfo {
  readonly name: string;
  readonly format: 'srt' | 'ass';
  /** Cues (SRT) or Dialogue events (ASS). */
  readonly cues: number;
  /** Playlist time where the file starts, or null when not placed. */
  readonly startUs: number | null;
  readonly offsetMs: number;
}

export interface PgTrack {
  /** PG stream number (PSR2), 1-based; for an encoded episode, the 1-based position among its subtitle tracks (ASS and PGS). */
  readonly index: number;
  /** ISO 639-2 code from the STN (an encode's: the track's Language), or ''. */
  readonly language: string;
  /** An encoded episode's track Name, when it has one; discs have none. */
  readonly name?: string;
}

export type SubtitleChoice = { readonly kind: 'pg'; readonly stream: number } | { readonly kind: 'text' } | { readonly kind: 'off' };

export type ChannelsLabel = 'mono' | 'stereo' | 'multichannel' | '';

export interface AudioTrack {
  /** 1-based position in the STN audio list; for an encoded episode, the 1-based position among its audio tracks. */
  readonly index: number;
  readonly codec: string;
  /** ISO 639-2 code from the STN (an encode's: the track's Language), or '' if absent. */
  readonly language: string;
  readonly channels: ChannelsLabel;
  readonly playable: boolean;
  /** An encoded episode's track Name, when it has one; discs have none. */
  readonly name?: string;
}

/** Remote-control keys for disc menus (BD_VK_*); topMenu is a menu call. */
export type MenuKey = 'up' | 'down' | 'left' | 'right' | 'ok' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'topMenu' | 'popup';

/** What to hold in a NAS disc's read-ahead cache: a playlist from `fromSeconds` on, `targetBytes` of it. */
export interface BufferRequest {
  readonly fromSeconds: number;
  readonly targetBytes: number;
  /** The playlist to buffer (an episode's); the disc's main title when absent or not on the disc. */
  readonly playlistId?: string;
}

/**
 * Where a disc opens instead of its First Play (resume where you left off): a playlist and a time in it. A BD-J disc
 * opens there directly too, with BD-J off (Menu boots it fresh).
 */
export interface StartPoint {
  readonly playlistId: string;
  readonly timeUs: number;
  /** Resume an HDMV title with its registers; null plays the playlist directly. */
  readonly hdmv: { readonly title: number; readonly psrs: readonly number[]; readonly gprs: Readonly<Record<number, number>> } | null;
  /** PSRs 1–3 (audio, PG, angle) for direct playback; ignored when hdmv is set. */
  readonly playback: { readonly psr1: number; readonly psr2: number; readonly psr3: number } | null;
}

/** The registers a saved place needs: the program's (HDMV or BD-J), or the private PG registers with no program. */
export interface PlaceState {
  readonly mode: 'hdmv' | 'bdj' | 'none';
  /** PSR4 under an HDMV title, else null. */
  readonly title: number | null;
  /** All 128 PSRs (empty with no disc open). */
  readonly psrs: number[];
  /** The non-zero GPRs, only under an HDMV title. */
  readonly gprs: Record<number, number> | null;
}

/**
 * An encoded episode on the NAS (a Matroska file of AV1 video): read like a NAS disc, through the same transport, token
 * refresh and fetch port, from its API base. Structured-cloneable (a fetch port is transferred).
 */
export interface EncodeSpec {
  /** The encode's API base, ending with '/': `https://…/bluray/api/encodes/<id>/`, or `rtc://<nasId>/api/encodes/<id>/`. */
  readonly base: string;
  readonly token: string;
  /** The encode's manifest: one file, `EPISODE.MKV`, with its size. */
  readonly manifest: DiscManifest;
  /** Extra query parameters for every files request (without the '?'). */
  readonly query?: string;
  /** As RemoteDiscSpec's: the WebRTC route's port, in the message's transfer list. */
  readonly fetchPort?: MessagePort;
  /** The encode's id on the NAS. */
  readonly encodeId: string;
}

/** The path of an encode's Matroska file in its manifest. */
export const ENCODE_FILE = 'EPISODE.MKV';

/** The playlist id an encode's chapters and time are reported under (it has no playlists). */
export const ENCODE_PLAYLIST_ID = 'mkv';

export type EngineCommand =
  /**
   * `bufferFirst` (a NAS disc, buffer first): the disc's playlists are read, then the playlist is fetched into the
   * read-ahead cache until it holds `targetBytes`, and only then is the disc opened ('titles', First Play). The fill
   * then goes on ahead of the play position to the playlist's end while the disc is open (a seek moves it), freeing
   * what playback has passed. cancelBuffer opens the disc at once (the fill goes on); a close or another open drops it
   * unopened, even while it is still queued. Every other command sent after it waits for it, as the queue does.
   * `start`: the disc opens at that place instead of running First Play (or BD-J); startFailed says when it can't.
   */
  | { readonly type: 'open'; readonly disc: DiscSpec; readonly bufferFirst?: BufferRequest; readonly start?: StartPoint }
  /**
   * Opens an encoded episode in place of the open disc and plays it from `startUs` (from the start without it; a time at
   * or past its end plays from the start, with startFailed 'past-end'). Its chapters are reported under the playlist id
   * 'mkv'. A close or another open replaces it.
   */
  | { readonly type: 'openEncode'; readonly encode: EncodeSpec; readonly startUs?: number }
  /** Answered at once (not queued) with placeState. */
  | { readonly type: 'readPlace' }
  /**
   * Fetch the open NAS disc's playlist (`playlistId`, else its main title) from `fromSeconds` on into its read-ahead
   * cache until it holds `targetBytes` of it, reporting bufferProgress, then stop; it doesn't follow playback (a
   * bufferFirst open's fill does). It replaces any fill running.
   */
  | ({ readonly type: 'bufferAhead' } & BufferRequest)
  /**
   * Handled at once, not queued: a bufferFirst open waiting for its fill opens now (its fill goes on); otherwise the
   * fill stops (what the cache holds stays).
   */
  | { readonly type: 'cancelBuffer' }
  /**
   * Another version (a quality level, or the original) of the open NAS disc: same disc id, another manifest and files
   * query. The engine reads it from then on (source, read-ahead cache, disc model) and starts the playing playlist again
   * on it at the current time, paused if it was; the HDMV program and a BD-J title go on untouched (BD-J keeps reading
   * the original). Never with a fetchPort: over WebRTC the open disc's port goes on serving. Answered by levelChanged.
   * `audio`: the audio stream (the original's numbering) the viewer heard at a level, sent with a switch to the
   * original: the restart plays it when it is playable there, and a disc program's PSR1 is set to it.
   */
  | { readonly type: 'setLevel'; readonly disc: RemoteDiscSpec; readonly audio?: number }
  /** A fresh session token for the open NAS disc (a scheduled refresh, or the answer to remoteTokenNeeded). Handled at once, not queued. */
  | { readonly type: 'remoteToken'; readonly token: string }
  | { readonly type: 'attachCanvas'; readonly canvas: OffscreenCanvas }
  | { readonly type: 'attachAudio'; readonly ring: SharedArrayBuffer }
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | { readonly type: 'playPlaylist'; readonly playlistId: string }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'seek'; readonly timeUs: number }
  /** An AudioTrack's index: a disc's STN stream, or an encoded episode's audio track; playback goes on at the same time. */
  | { readonly type: 'selectAudio'; readonly index: number }
  /**
   * One subtitle choice at a time. For an encoded episode `{ kind: 'pg', stream }` picks its subtitle track `stream` (the
   * index of the PgTrack the subtitles event lists, ASS or PGS alike), and `text` the added files.
   */
  | { readonly type: 'selectSubtitle'; readonly choice: SubtitleChoice }
  /** An .srt file; `encoding` (a TextDecoder label) is used when the bytes are neither BOM-marked nor UTF-8. */
  /** A subtitle set (SRT and/or ASS files, placed at episode starts) with fonts for its ASS files; replaces the old set. */
  | { readonly type: 'addTextSubtitles'; readonly files: readonly FileData[]; readonly encoding?: string; readonly fonts?: readonly FileData[] }
  /** More fonts for the set's ASS files. */
  | { readonly type: 'addSubtitleFonts'; readonly fonts: readonly FileData[] }
  | { readonly type: 'removeTextSubtitle' }
  /** Places a file of the set (index in name order) at a playlist time, or unplaces it. */
  | { readonly type: 'setSubtitleStart'; readonly file: number; readonly startUs: number | null }
  /** A file's timing shift, clamped to ±10 minutes. */
  | { readonly type: 'setSubtitleOffset'; readonly file: number; readonly ms: number }
  /** Text subtitle size factor, clamped to 0.5–2. */
  | { readonly type: 'setSubtitleScale'; readonly scale: number }
  | { readonly type: 'nextChapter' }
  | { readonly type: 'prevChapter' }
  /** 0 = top menu. */
  | { readonly type: 'playTitle'; readonly title: number }
  | { readonly type: 'menuCall' }
  /** `repeat`: a held key's auto-repeat (KeyboardEvent.repeat), which a BD-J title's full input queue may merge. */
  | { readonly type: 'menuKey'; readonly key: MenuKey; readonly repeat?: boolean }
  /** In the 1920×1080 menu space. Under a BD-J title a move is BDJ_EVENT_MOUSE, a click also the activate key. */
  | { readonly type: 'pointer'; readonly kind: 'move' | 'click'; readonly x: number; readonly y: number }
  /** Forget the open disc ("Open another disc"). */
  | { readonly type: 'close' }
  /** Shade the video with this set (compiled in the background), or draw it unshaded (null). Kept across discs. */
  | { readonly type: 'setVideoShaders'; readonly set: ShaderSetData | null }
  | { readonly type: 'setMemoryProfile'; readonly profile: MemoryProfileName }
  /**
   * The page is going away (pagehide, or hidden): a BD-J title saves what its disc wrote under /persistent/ and /buda/
   * now rather than at the end of its 2 s debounce. Handled at once, not queued.
   */
  | { readonly type: 'flushSaves' }
  /**
   * The page was hidden or shown again (document.hidden; sent at start and on every visibilitychange). A BD-J title's
   * start-up timeout counts only visible time (ruling R22). Handled at once, not queued.
   */
  | { readonly type: 'visibility'; readonly hidden: boolean };

export type EngineEvent =
  /** `bdjSupported`: this engine runs BD-J titles. */
  | { readonly type: 'titles'; readonly playlists: readonly PlaylistSummary[]; readonly usesBdj: boolean; readonly bdjSupported: boolean; readonly bdjMissing?: readonly string[]; readonly warnings: readonly string[] }
  /** A BD-J title started (the disc's Java code drives playback and draws its menus) or BD-J stopped. */
  | { readonly type: 'bdjActive'; readonly active: boolean }
  /**
   * The BD-J graphics plane turned visible (any pixel with non-zero alpha) or empty; on changes only, and false when
   * BD-J stops. While it is visible, taps and clicks on the video go to the disc.
   */
  | { readonly type: 'bdjMenu'; readonly visible: boolean }
  /** A tap on a BD-J menu brought no reaction within the window: the UI opens the on-screen remote. */
  | { readonly type: 'bdjTapIgnored' }
  /** After 'titles', for discs whose First Play is an HDMV object. */
  | { readonly type: 'indexTitles'; readonly titles: ReadonlyArray<{ readonly number: number; readonly kind: 'hdmv' | 'bdj' }>; readonly hasTopMenu: boolean }
  | { readonly type: 'uoMask'; readonly masked: readonly UoOp[] }
  | { readonly type: 'menuActive'; readonly active: boolean; readonly popupAvailable: boolean }
  /** Once after 'titles', for a disc with BDMV/AUXDATA/sound.bdmv: the menu sound clips (48 kHz, interleaved 16-bit). */
  | { readonly type: 'soundEffects'; readonly clips: ReadonlyArray<{ readonly channels: 1 | 2; readonly samples: Int16Array }> }
  /** A menu button asked for a sound clip (an index into soundEffects). */
  | { readonly type: 'soundEffect'; readonly id: number }
  /** After a pointer move: the menu button under the pointer, for the cursor. */
  | { readonly type: 'pointerTarget'; readonly button: number | null }
  /** A pointer click on an HDMV menu hit no button of the shown page (the graphics controller's hit test): the disc took no action. */
  | { readonly type: 'menuTapMissed' }
  | { readonly type: 'chapters'; readonly playlistId: string; readonly durationUs: number; readonly chapters: readonly Chapter[] }
  | { readonly type: 'tracks'; readonly audio: readonly AudioTrack[]; readonly selectedAudio: number | null }
  /** Files of a load are not UTF-8 and no encoding was given: ask the user, then send addTextSubtitles again with one. */
  | { readonly type: 'subtitleEncodingNeeded'; readonly names: readonly string[] }
  /** On disc open and close, playlist start, a play item whose PG tracks differ, every PSR2 change and every subtitle command. */
  | {
    readonly type: 'subtitles';
    readonly pg: readonly PgTrack[];
    readonly text: { readonly files: readonly TextFileInfo[]; readonly missingFonts: readonly string[]; readonly episodeStarts: readonly number[] } | null;
    readonly selected: 'off' | 'text' | { readonly pg: number };
    readonly scale: number;
  }
  | { readonly type: 'state'; readonly state: PlaybackState }
  | { readonly type: 'time'; readonly timeUs: number }
  | { readonly type: 'notice'; readonly code: NoticeCode; readonly message: string }
  /**
   * The condition behind a notice of that code is over: 'nas-waiting' once the read landed, 'no-picture' once a
   * playlist with a picture starts.
   */
  | { readonly type: 'noticeCleared'; readonly code: NoticeCode }
  /**
   * The read-ahead cache's fill: bytes held from the start position on, out of `targetBytes` (the request's, or all
   * there is when that is less), and the connection's rate over the fill so far (Mbps). It is over when bytes reach
   * targetBytes (a bufferFirst disc's fill goes on), and with `stopped` when it ended early: a read or a cache write
   * failed, or this device has no cache ('no-cache'). A bufferFirst open then opens the disc without the lead.
   */
  | { readonly type: 'bufferProgress'; readonly bytes: number; readonly targetBytes: number; readonly mbps: number; readonly stopped?: 'failed' | 'no-cache' }
  /** Once, at the engine's start: whether this device can keep a read-ahead cache (OPFS with sync access handles). */
  | { readonly type: 'readAheadCache'; readonly available: boolean }
  /**
   * The answer to setLevel. A failure after the switch began leaves the disc closed, with the usual error event; one
   * before it (another disc is open) changes nothing.
   */
  | { readonly type: 'levelChanged'; readonly ok: true }
  | { readonly type: 'levelChanged'; readonly ok: false; readonly message: string }
  /** The NAS answered 401: send remoteToken with a fresh token within 10 s, or the disc fails as unpaired. */
  | { readonly type: 'remoteTokenNeeded' }
  /**
   * The engine closed a NAS disc's fetch port (the disc was replaced, closed or failed to open), one event per port, in
   * the order the discs were opened: what serves that port on the main thread can stop now without failing its reads.
   */
  | { readonly type: 'fetchPortClosed' }
  /**
   * A stream the browser can't decode. With `noPicture` (kind 'video', NO_PICTURE_MESSAGE): the playlist plays without a
   * picture; sent once per disc, it is the disc-level notice 'no-picture'. Otherwise it is the playlist's notice
   * 'unsupported-<kind>'. With `reason` 'av1' (kind 'video', codec 'AV1'): an encoded episode's AV1 video can't be decoded
   * here, so nothing plays.
   */
  | { readonly type: 'unsupported'; readonly kind: 'video' | 'audio'; readonly codec: string; readonly message: string; readonly noPicture?: true; readonly reason?: 'av1' }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string; readonly paths: readonly string[] }
  | { readonly type: 'telemetry'; readonly telemetry: Telemetry }
  /** The current playlist was torn down (a new pick, a failed pick, or close). */
  | { readonly type: 'playlistCleared' }
  /** On every shader set change and compile result; `error` explains 'error' and 'unavailable'. */
  | { readonly type: 'shaderStatus'; readonly state: ShaderState; readonly set: string | null; readonly error: string | null }
  /** The answer to readPlace. */
  | ({ readonly type: 'placeState' } & PlaceState)
  /**
   * An open's start point could not be used: its playlist is not on the disc (nothing plays, the state is idle), or its
   * time is at or past the playlist's end (it plays from the beginning).
   */
  | { readonly type: 'startFailed'; readonly reason: 'no-playlist' | 'past-end' };

/**
 * The notice of a playlist whose video (MPEG-2, VC-1) the browser can't decode: it plays without a picture. Sent once per
 * disc (unsupported with noPicture, the notice 'no-picture'), and cleared (noticeCleared 'no-picture') when a playlist with
 * a picture starts; that disc never sends it again.
 */
export const NO_PICTURE_MESSAGE = "This disc's video can't be played here yet, so it will play without a picture.";

/**
 * The notice 'bdj-storage' (ruling R32): what a BD-J disc saves won't last. A scope kept in memory only with no copy
 * anywhere, a write refused for room (16 MB per scope, the NAS's quota, the VFS's memory cap), or a NAS put that failed
 * for good. Sent at most once per disc open; it stays until dismissed or another disc opens.
 */
export const BDJ_STORAGE_MESSAGE = "This disc's saved data can't be kept right now, so progress you make may be lost.";
