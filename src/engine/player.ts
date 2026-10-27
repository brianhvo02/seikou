import { AudioWriter } from './audio/audio-writer';
import { OUTPUT_SAMPLE_RATE, RingWriter, ringViews } from './audio/ring';
import type { Mpls, PlayItem } from './bdmv/mpls-parser';
import { BackgroundStill, type DecodeImage } from './bdj/background';
import { bdjPlaybackEvents, type BdjPlaybackEvents } from './bdj/events';
import { PlayerBdjHost } from './bdj/player-host';
import type { BdjMemoryBudgets, ClassLibrarySource } from './bdj/runtime';
import { EarlyBdjWorker } from './bdj/early-worker';
import { GraphicsPlaneReader, createGraphicsPlane } from './bdj/graphics-plane';
import { bdjUnsupportedMessage } from './bdj/requirements';
import { BDJ_EVENT_MOUSE, InputLatency, TapReactionWatch, UoRestriction, bdjMouseParam, bdjUserInput } from './bdj/input';
import { BdjSession, type BdjFailureCode, type WorkerLike } from './bdj/session';
import { REGISTER_WORDS } from './bdj/shared-registers';
import { StatusBlockWriter, createStatusBlock } from './bdj/status-block';
import { indexUsesBdj, type IndexBdmv } from './bdmv/index-parser';
import { codingName, isVideoCoding } from './bdmv/stream-types';
import { MasterClock } from './clock/master-clock';
import { Decimator } from './decode/decimator';
import { UnsupportedCodecError, type DecoderError } from './decode/decoder';
import { type AudioDecodeResult, type AudioDecoder, type AudioDecoderFactory } from './decode/audio-decoder';
import { WebCodecsVideoDecoder, hasSps, isSupportedVideoCoding, type VideoCodecApi, type VideoUnit } from './decode/video-decoder';
import { SOURCE_PACKET_SIZE, TS_PACKET_SIZE } from './demux/constants';
import { M2tsReader } from './demux/m2ts-reader';
import { DiscError } from './disc/byte-source';
import { applyDiscProfile } from './disc/disc-profile';
import { applyPlayerSettings, type PlayerSettings } from './disc/player-settings';
import { createByteSource, type DiscSpec, type RemoteDiscSpec } from './disc/disc-spec';
import { portFetch, serveFetch } from './disc/port-fetch';
import type { FileSource } from './disc/file-source';
import { RemoteDiscError, TokenRelay } from './disc/http-transport';
import { checkStreamReadable, loadClips, openDisc, peekIndex, playlistPath, readBdid, streamPath, type DiscModel } from './disc/open-disc';
import { CacheFill } from './disc/cache-fill';
import type { DiscManifest } from './disc/nas-api';
import { ReadAheadCache, SEGMENT_BYTES } from './disc/read-ahead-cache';
import { RemoteSource } from './disc/remote-source';
import { BdVk } from './graphics/graphics-controller';
import { PSR, RegisterFile, SETTING_PSRS, type PsrEvent } from './hdmv/registers';
import type { UoOp } from './hdmv/uo-mask';
import { Navigator, type IgUnit, type NavigatorEvent, type PlaybackPort, type PlayAt } from './nav/navigator';
import { itemPackets, lookupSpn, markTitlePkt, nextPlaymark } from './nav/packets';
import { PgStreamControl } from './nav/subtitles';
import { Timeline, type Chapter } from './nav/timeline';
import { PlaybackPipeline, type PipelineAudioUnit, type PipelineUnit } from './playback/pipeline';
import { bufferRanges } from './playback/buffer-ranges';
import { PLAYABLE_AUDIO, audioEntryFor, chooseStreams } from './playback/stream-selection';
import { audioTracks } from './playback/tracks';
import type { FontFile } from './ass/font-tables';
import { AssFonts, type FontLoader } from './ass/fonts';
import type { GlyphMeasurer } from './ass/measure';
import { looksLikeAss, parseAss } from './ass/parse';
import { AssRenderer } from './ass/renderer';
import { MEMORY_PROFILES, type MemoryProfile, type MemoryProfileName } from './memory-profile';
import type { Mat3 } from './ass/transform';
import type { AssTrack } from './ass/types';
import { BDJ_STORAGE_MESSAGE, NO_PICTURE_MESSAGE, type AudioTrack, type BufferRequest, type BdjMemoryTelemetry, type EngineCommand, type EngineEvent, type FileData, type MenuKey, type NoticeCode, type PlaceState, type PlaybackState, type ShaderSetData, type StartPoint, type SubtitleChoice } from './protocol';
import type { FromBdj } from './bdj/worker-protocol';
import type { CompositorLike, TextRendererLike } from './render/compositor';
import { ShaderStage } from './shaders/stage';
import { UNAVAILABLE, type ShaderBackend } from './shaders/webgl-backend';
import { decodeText, parseSrt } from './subs/srt';
import { TextSubtitleRenderer, type TextRenderOptions } from './subs/text-renderer';
import { episodeStarts, sortByName, TextSet, TextSetRenderer, type SetFile } from './subs/text-set';
import { VideoPresenter } from './render/video-presenter';
import { ParseError } from './util/byte-reader';
import { pts90ToUs, ticks45ToUs, usToTicks45 } from './util/time';

const UO_MASKED_MESSAGE = "The disc doesn't allow this here.";
const NO_SUBTITLES_MESSAGE = 'this file has no subtitles we can read';
const SOME_SUBTITLES_MESSAGE = 'Some lines of this file could not be read';
const PLACE_FILES_MESSAGE = "Place each subtitle file at its episode's start in the subtitle menu";
const NO_SHADER_BACKEND_MESSAGE = 'Shaders are unavailable here';
const BDJ_TAP_IGNORED_MESSAGE = "This disc's menu doesn't respond to taps here. Use the remote.";
const MIN_TEXT_SCALE = 0.5;
const MAX_TEXT_SCALE = 2;
/** The operation each menu key is (pop-up depends on whether the pop-up is shown). */
const MENU_KEY_UO: Partial<Record<MenuKey, UoOp>> = {
  up: 'moveUp', down: 'moveDown', left: 'moveLeft', right: 'moveRight', ok: 'activate', topMenu: 'menuCall',
};
const MENU_KEY_VK: Readonly<Record<Exclude<MenuKey, 'topMenu'>, number>> = {
  up: BdVk.UP, down: BdVk.DOWN, left: BdVk.LEFT, right: BdVk.RIGHT, ok: BdVk.ENTER, popup: BdVk.POPUP,
  '0': BdVk.D0, '1': BdVk.D1, '2': BdVk.D2, '3': BdVk.D3, '4': BdVk.D4, '5': BdVk.D5, '6': BdVk.D6, '7': BdVk.D7, '8': BdVk.D8, '9': BdVk.D9,
};

export interface PlayerDeps {
  emit(event: EngineEvent): void;
  readonly videoCodecApi: VideoCodecApi;
  nowMs(): number;
  requestFrame(callback: () => void): void;
  createCompositor(canvas: OffscreenCanvas): CompositorLike;
  readonly createAudioDecoder: AudioDecoderFactory;
  /** What ASS subtitles need from the browser (fonts, measuring, canvases); created once, when the first ASS file loads. */
  readonly createAssDeps?: () => Promise<AssDeps>;
  /** The GPU backend for video shaders, or why there is none; created once, when the first set is chosen. */
  readonly createShaderBackend?: (events: { lost(): void; restored(): void }) => ShaderBackend | string;
  /** A new BD-J worker (bdj/bdj-worker.ts) for each BD-J session. */
  readonly createBdjWorker?: () => WorkerLike;
  /**
   * What this browser lacks to run BD-J (bdj/requirements.ts bdjMissing on the engine worker's global): when any is
   * missing, BD-J discs and titles open to the picker with a notice naming it.
   */
  readonly bdjMissing?: readonly string[];
  /** The BD-J class library jars; fetched once, as soon as a BD-J disc is opened. */
  readonly loadClassLibrary?: () => Promise<ClassLibrarySource>;
  /** One-shot timer, cancelled by the returned function (the BD-J first-playlist timeout); setTimeout by default. */
  readonly setTimer?: (ms: number, fn: () => void) => () => void;
  /** The wall clock the BD-J start-up timeout counts on, through a host sleep (ruling R22); Date.now by default. */
  readonly wallMs?: () => number;
  /** The BD-J runtime's log lines (Java's System.out and uncaught exceptions). */
  readonly bdjLog?: (line: string, error: boolean) => void;
  /** The engine's own log lines (a resume that falls back); dropped by default. */
  readonly log?: (line: string) => void;
  /** bd_set_player_setting_str's languages and country, written to the program's registers when a BD-J title is entered. */
  readonly playerSettings?: PlayerSettings;
  /**
   * Test-only (E2E, ?telemetry=1): telemetry carries the BD-J plane's hash once it settles (bdjPlane.hash), so a
   * browser test can compare it with the libbluray golden's.
   */
  readonly planeHashTelemetry?: boolean;
  /** Test-only (?telemetry=1): telemetry carries BD-J's memory (bdjMemory), which the BD-J worker reports every 5 s. */
  readonly memoryTelemetry?: boolean;
  /** Decodes a BD-J background still (createImageBitmap); without it, background stills are not shown. */
  readonly decodeImage?: DecodeImage;
  /** Reads a NAS disc's files (HttpTransport); the global fetch by default. */
  readonly fetch?: typeof fetch;
  /** A NAS disc's range request size (REMOTE_CHUNK_BYTES) and read-ahead budget (the memory profile's) when set. */
  readonly remoteLimits?: { readonly chunkBytes?: number; readonly readAheadBytes?: number };
  /**
   * The origin's private file system (navigator.storage.getDirectory()), where a NAS disc's on-disk read-ahead cache
   * lives (buffer first); without it NAS discs have none and bufferAhead does nothing.
   */
  readonly readAheadCacheRoot?: () => Promise<FileSystemDirectoryHandle>;
  /** Epoch ms, for the read-ahead cache's age; Date.now by default. */
  readonly epochMs?: () => number;
  /** The read-ahead cache's segment size (SEGMENT_BYTES by default; tests use smaller). */
  readonly readAheadSegmentBytes?: number;
}

/** A bufferFirst open: it waits for its fill until the target is held, a cancelBuffer, or a close or open drops it. */
interface OpenHold {
  cancelled: boolean;
  abandoned: boolean;
  readonly released: Promise<void>;
  release(): void;
}

function openHold(): OpenHold {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { cancelled: false, abandoned: false, released, release };
}

/** While a fill follows playback, the play position is looked at again this often (freeing what playback passed). */
const FILL_KICK_MS = 1000;

const defaultSetTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export interface AssDeps {
  readonly loader: FontLoader;
  readonly defaultFont: FontFile;
  readonly measurer: GlyphMeasurer;
  readonly createCanvas: (w: number, h: number) => OffscreenCanvas;
  readonly Path2D: typeof Path2D;
  /** Whether canvases honour `ctx.filter`. */
  readonly canvasFilter: boolean;
  readonly warp?: (target: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, m: Mat3, originX: number, originY: number) => void;
}

/** The user's subtitle set: files in name order, each SRT or ASS, and the fonts its ASS files share. */
interface TextTrack {
  readonly files: readonly SetFile<TextRendererLike>[];
  readonly renderer: TextSetRenderer<TextRendererLike>;
  readonly fonts: AssFonts | null;
  readonly assTracks: readonly AssTrack[];
  /** The playlist placements were last chosen for. */
  placedFor: string | null;
}

/** Decoded frames held for presentation and chunks inside the decoder: kept small (GPU memory, decoder pools). */
const MAX_DECODE_QUEUE = 8;
/** How often the BD-J worker reports its memory in telemetry runs (its stats walk the file tree: kept coarse). */
const BDJ_MEMORY_STATS_MS = 5000;
const MENU_MEMORY_MESSAGE = "This disc's menus need more memory than this device allows.";
const NAS_WAITING_MESSAGE = 'Waiting for the NAS drive…';
/** A NAS disc starts once this much stream is read ahead (Global Constraints). */
const REMOTE_START_SECONDS = 3;
/**
 * Read-ahead budget for compressed video waiting to enter the decoder. Discs may multiplex video
 * well ahead of its audio (≥ 0.5 s seen on real discs), so reading must be able to run this far
 * ahead in video to reach the audio that is needed now.
 */
const MAX_ENCODED_VIDEO_US = 2_000_000;
const MAX_ENCODED_VIDEO_BYTES = 64 * 1024 * 1024;
const AUDIO_PREBUFFER_US = 200_000;
/**
 * Audio that has not come by the time the video read is this far past it is not in the stream (a play item without the
 * selected audio stream, or its PID missing): silence is written in its place. Well above the mux skew of video ahead of
 * audio (≥ 0.5 s seen on real discs, see MAX_ENCODED_VIDEO_US), and below the video read-ahead, so the ring stays fed.
 */
const AUDIO_ABSENT_AFTER_US = 1_500_000;
const TIME_EVENT_INTERVAL_US = 250_000;
const TELEMETRY_INTERVAL_MS = 500;
const HEARTBEAT_TIMEOUT_MS = 500;
const MAX_AUDIO_ERRORS_IN_ROW = 50;
/** Frames up to this far before a seek target are still shown (EP pts are truncated by up to ~5.7 ms). */
const SEEK_TOLERANCE_US = 1_000;
const NEXT_CHAPTER_GUARD_US = 500_000;
const PREV_CHAPTER_RESTART_US = 3_000_000;
/** A still play item is held this close to its end, so the last frame stays on screen. */
const STILL_MARGIN_US = 40_000;
/** mpls still_mode 1: a time still of still_time seconds (2 is an infinite still). */
const STILL_TIME = 1;
const SCR_PER_MS = 90;
const INDEX_ID_NONE = 0xffff;
const TITLE_FIRST_PLAY = 0xffff;
/** bd_set_rate's BLURAY_RATE_PAUSED and BLURAY_RATE_NORMAL. */
const RATE_PAUSED = 0;
const RATE_NORMAL = 90_000;
/** UO_MASK_MENU_CALL_INDEX, UO_MASK_TITLE_SEARCH_INDEX */
const UO_INDEX: Partial<Record<UoOp, number>> = { menuCall: 0, titleSearch: 1 };

/** Who opened a playlist: the user's pick, the HDMV navigator, or a BD-J title. */
type PlaylistCaller = 'user' | 'navigator' | 'bdj';

/** What a BD-J title hears of playback (PlayerBdjHost). */
export interface BdjPlaybackListener {
  /** _open_playlist: called synchronously from inside playPlaylist once the playlist is open, before anything loads. */
  playlistStarted(playlistId: string, item: number): void;
  playItemChanged(item: number): void;
  /** _playmark_reached: the marks passed since the last look, in order; the position is now packet `clipPkt` of `item`. */
  marksReached(marks: readonly number[], item: number, clipPkt: number): void;
  /** bd_set_scr: the presentation position, each tick while the playlist is presented. */
  position(item: number, clipTime45: number): void;
  /** A user seek (not one the port asked for) to `clipTime45` of play item `item`. */
  seeked(item: number, clipTime45: number): void;
  playlistEnded(): void;
}

/** How a BD-J title drives the player: the navigator's port paths plus rate, time seeks and sound effects. */
export interface BdjPlaybackPort {
  /** false if the playlist is missing or cannot play; the listener's playlistStarted runs inside, as for the navigator. Opens paused (bdj_wait_start). */
  playPlaylist(id: string, at: PlayAt): Promise<boolean>;
  seekPlayItem(item: number): void;
  seekMark(mark: number): void;
  /** _seek_time: a playlist time in 45 kHz ticks. */
  seekTime45(t: number): void;
  stopPlaylist(): void;
  /** 0 pauses, anything else plays. */
  setRate(rate: number): void;
  currentClipTime45(): number | undefined;
  playlistOpen(): boolean;
  playSound(id: number): void;
  setListener(listener: BdjPlaybackListener | null): void;
}

/** A BD-J First Play's worker started while the disc opens, with the registers and status block its boot carries. */
interface EarlyBdj {
  readonly worker: EarlyBdjWorker;
  readonly regs: RegisterFile;
  readonly status: StatusBlockWriter;
  readonly plane: GraphicsPlaneReader;
  readonly disc: BdjDisc;
}

/**
 * How one BD-J worker reads the disc. On the port route it gets a fetch port of its own in its boot message, which the
 * engine serves with its own port fetch (a worker can't use the engine's port); `stop` ends that relay.
 */
interface BdjDisc {
  readonly port: MessagePort | null;
  readonly stop: () => void;
}

/**
 * A running BD-J title: libbluray's title_type bdj. The worker lives from entering BD-J until it is left (a playlist
 * picked, an HDMV title, the disc closed) or fails; title changes inside BD-J reuse it.
 */
interface BdjTitle {
  readonly session: BdjSession;
  readonly host: PlayerBdjHost;
  readonly events: BdjPlaybackEvents;
  /** The title registers, shared with the BD-J worker (the navigator's, when HDMV handed over). */
  readonly regs: RegisterFile;
  readonly status: StatusBlockWriter;
  /** The graphics plane Java draws into (one per worker: a terminated worker can never write into the next one's). */
  readonly plane: GraphicsPlaneReader;
  /** Cuts the title off from the player: its port, events and callbacks do nothing afterwards. */
  readonly end: () => void;
  /** The title to start once the worker has booted; null once booted. */
  pendingTitle: number | null;
  booted: boolean;
  /** The plane's visible() as last reported in a bdjMenu event. */
  menuVisible: boolean;
  /** How the worker reads the disc: its fetch port and that port's relay, on the port route. */
  readonly disc: BdjDisc;
  /** Taps forwarded to Java, waiting for a reaction (the ignored-tap rule). */
  readonly taps: TapReactionWatch;
  /** The BD-J worker's last memory report (memoryTelemetry). */
  memory: Extract<FromBdj, { type: 'memory' }> | null;
}

interface Session {
  readonly playlistId: string;
  readonly owner: PlaylistCaller;
  readonly timeline: Timeline;
  readonly chapters: readonly Chapter[];
  readonly tracks: readonly AudioTrack[];
  readonly videoCodingType: number;
  /** Null when the browser can't decode the video (MPEG-2, VC-1): the playlist plays without a picture, as in libbluray. */
  readonly decoder: WebCodecsVideoDecoder | null;
  readonly pipeline: PlaybackPipeline;
  readonly playItems: readonly PlayItem[];
  /** 1-based STN audio stream number; null when the playlist has no playable audio. */
  audioStream: number | null;
  readonly audioDecoders: Map<number, AudioDecoder>;
  readonly audioDecoderLoads: Map<number, Promise<AudioDecoder>>;
  audioErrorsInRow: number;
  /** Coding types whose decoder is unusable this session (not playable, or the load failed); cleared by a seek or switch. */
  readonly failedAudioTypes: Set<number>;
  /** Audio was turned off by too many decode errors; the next seek or switch tries again. */
  audioErrorDisabled: boolean;
  audioActive: boolean;
  decimator: Decimator | null;
  videoState: 'unconfigured' | 'configuring' | 'configured' | 'failed';
  pendingVideo: VideoUnit[];
  dropBeforeUs: number;
  /** Without a picture: the latest audio PTS delivered since the last start (read-ahead is paced on it and the pipeline's position). */
  audioReadUs: number;
  /** The latest in-range video PTS delivered since the last start (missing audio is filled with silence behind it). */
  videoReadUs: number;
  /** Without a picture: the latest PTS of anything delivered (audio, PG, IG) since the last start; the playlist ends once it has played out. */
  deliveredEndUs: number;
  /** Without a picture: at EOF, the playlist time the reads delivered up to (PlaybackPipeline.doneUs). */
  readEndUs: number;
  /** Without a picture: its first frame (black, with the planes over it) has been composited. */
  blankComposited: boolean;
  eof: boolean;
  flushed: boolean;
  /** Decoder flush issued at end of input (only after the compressed backlog drains). */
  flushStarted: boolean;
  /** Worklet heartbeat when audio was disabled because the output stalled; null if not stalled. */
  audioStalledBeat: number | null;
  /** A seek that moves playback back onto a recovered output is queued. */
  audioRecoveryQueued: boolean;
}

function isMediaError(err: unknown): boolean {
  return err instanceof DiscError || err instanceof UnsupportedCodecError || err instanceof ParseError;
}

/** Owns one disc and at most one playing playlist. Runs inside the engine worker. */
export class Player {
  private source: FileSource | RemoteSource | null = null;
  private disc: DiscModel | null = null;
  private soundsPlayed = 0;
  private session: Session | null = null;
  private state: PlaybackState = 'idle';
  private wantPlaying = false;
  private ring: RingWriter | null = null;
  private audioWriter: AudioWriter | null = null;
  private compositor: CompositorLike | null = null;
  private readonly presenter = new VideoPresenter<VideoFrame>();
  /** Limits for this device; desktop (libbluray's) until the UI says otherwise. */
  private memory: MemoryProfile = MEMORY_PROFILES.desktop;
  private memoryName: MemoryProfileName = 'desktop';
  /** Coded width of the last decoded frame (0 before the first). */
  private codedWidth = 0;
  private readonly clock: MasterClock;
  private seekGeneration = 0;
  private renderLoopStarted = false;
  private lastTimeEmitted = Number.NEGATIVE_INFINITY;
  private lastTelemetryMs = Number.NEGATIVE_INFINITY;
  private lastHeartbeat = -1;
  private lastHeartbeatChangeMs = 0;
  private decoderErrors = 0;
  private offsets: number[] = [];
  private audioDecodeErrors = 0;
  private audioCodec: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** HDMV navigation (First Play, titles, menus); null for discs without MovieObject.bdmv, BD-J First Play, or after a raw pick. */
  private navigator: Navigator | null = null;
  private navRegs: RegisterFile | null = null;
  private navItem = 0;
  /** libbluray's next_mark: index of the first play mark after the presentation position, -1 when none is left. */
  private navNextMark = -1;
  /** Seeks the navigator asked for (PLAY_PI / PLAY_PM) that are queued but have not run: marks are not reported meanwhile. */
  private navSeeksPending = 0;
  /** Presentation is frozen (still image): the clock and audio output are stopped. */
  private held = false;
  /** The play item whose end was reported to the navigator; reset on an item change and on every seek. */
  private navEndReported: number | null = null;
  /**
   * A BD-J title's playlist holds at the end of a still play item (_bd_read_locked returns nothing more): for ever for an
   * infinite still, or until `untilMs` (nowMs) for a time still, after which presentation goes on as bd_read_skip_still
   * lets it. Released by a new playlist, a seek and the end of BD-J.
   */
  private bdjStill: { readonly item: number; readonly untilMs: number | null } | null = null;
  private menuActive = false;
  /** Draw operations of the last repaint of the IG plane. */
  private igDraws = 0;
  private popupAvailable = false;
  /** Bumped by every playlist open and by navigator teardown, so a superseded open stops early. */
  private openGeneration = 0;
  private bdjListener: BdjPlaybackListener | null = null;
  /** PG subtitles of the open disc, on the navigator's registers or, without a navigator, on pgRegs. */
  private pg: PgStreamControl | null = null;
  private pgRegs: RegisterFile | null = null;
  /** The disc ID BD-J's host will need (id.bdmv). */
  private bdjDiscId: string | null = null;
  /** The class library, loading from the first BD-J disc on. */
  private bdjClassLibrary: Promise<ClassLibrarySource> | null = null;
  /** The open disc as the UI gave it (with the latest NAS token, without its fetch port), for the BD-J worker's own disc model. */
  private discSpec: DiscSpec = { kind: 'files', entries: [] };
  /** The open NAS disc's fetch port (the WebRTC route) and the fetch over it, which BD-J workers' relays use too. */
  private discPort: { readonly port: MessagePort; readonly fetch: typeof fetch } | null = null;
  /** Fresh NAS tokens for the open (or opening) disc's reads, asked of the controller. */
  private tokens: TokenRelay | null = null;
  /** The opening (then open) disc's NAS source, which takes token refreshes. */
  private remote: RemoteSource | null = null;
  /** The NAS disc's on-disk read-ahead cache, opening (null: it has none). */
  private cache: Promise<ReadAheadCache | null> | null = null;
  /** The read-ahead cache's fill in progress. */
  private filling: CacheFill | null = null;
  private lastFillKickMs = Number.NEGATIVE_INFINITY;
  /**
   * The last bufferFirst open sent (queued or running): cancelBuffer lets it open at once, a close or another open drops
   * it unopened. Set when the command arrives, so commands sent after it see it before it runs.
   */
  private openHold: OpenHold | null = null;
  private readonly holds = new WeakMap<EngineCommand, OpenHold>();
  private bdj: BdjTitle | null = null;
  /** Taps on a BD-J menu that brought no reaction (telemetry). */
  private bdjTapsIgnored = 0;
  /** The page is hidden (the `visibility` command): a BD-J session's start-up timeout is paused. */
  private pageHidden = false;
  /** The open disc's no-picture notice: not sent yet, shown, or cleared by a playlist with a picture (never sent again). */
  private noPictureNotice: 'unsent' | 'shown' | 'cleared' = 'unsent';
  /** Audio streams asked for that the playing playlist's STN lacks (a quality level keeps one track), logged once per disc. */
  private missingAudioLogged = new Set<number>();
  /** A setLevel under way: resolves once the new version is in place (source, cache, disc model), before its restart. */
  private switching: Promise<void> | null = null;
  /** Bumped by every setLevel: a playlist open that began on an older version goes on, once the switch is done, on the new one. */
  private levelVersion = 0;
  /** The fill running (or starting), to start again on another version of the disc. */
  private fillArgs: { readonly req: BufferRequest; readonly follow: boolean } | null = null;
  /** The open disc's source showed the nas-waiting notice and has not cleared it. */
  private nasWaiting = false;
  /** The open disc's bdj-storage notice has been sent (ruling R32: once per disc open, whatever BD-J sessions it runs). */
  private bdjStorageNotice = false;
  /** telemetry bdjPlane.hash: the plane and its version at the last telemetry, and the hash of a settled version. */
  private planeSeen: { plane: GraphicsPlaneReader; version: number; hash: string | null } | null = null;
  /** A BD-J First Play's worker, booting while the disc opens, until enterBdj adopts it. */
  private earlyBdj: EarlyBdj | null = null;
  /**
   * Stopped BD-J workers still saving their storage scopes: a new worker's boot waits for them, so it loads what they
   * saved (the same disc reopened, or BD-J entered again).
   */
  private bdjSaving: Promise<void> = Promise.resolve();
  /** When the open command for this disc arrived (nowMs), and BD-J start-up times since then (telemetry `bdj`). */
  private openedAtMs = 0;
  private bdjStartup: { bootMs: number | null; firstPlaylistMs: number | null; firstFrameMs: number | null } | null = null;
  /** Keys and taps sent to BD-J menus, until their plane change is presented (telemetry `bdj.inputLatencyMs`). */
  private bdjLatency = new InputLatency();
  private unsubscribePg: (() => void) | null = null;
  /** The PG track list last sent in a 'subtitles' event ('' forces the next one). */
  private sentPgTracks = '';
  /** The user's subtitle set; it belongs to the open disc (kept across playlists, dropped with the disc). */
  private textTrack: TextTrack | null = null;
  private textOn = false;
  private textScale = 1;
  /** Bumped by every subtitle load and by closing the disc: a load that finds it changed is dropped. */
  private textLoadGeneration = 0;
  private assDeps: Promise<AssDeps> | null = null;
  /** A subtitle setting changed: the next paint redraws even when no frame or plane changed. */
  private subtitlesDirty = false;
  /** Video shaders; created with the first set chosen and kept for the page (across discs). */
  private shaderStage: ShaderStage | null = null;
  /** The shader set changed: the next paint redraws the current frame even when nothing else changed. */
  private shadersDirty = false;
  /** The video under the BD-J plane was redrawn without it (no playlist): the next paint draws the plane again. */
  private bdjDirty = false;
  /** The BD-J title's background still, under the video; cleared with the BD-J plane (stopBdj). */
  private readonly background: BackgroundStill;
  /** The background still changed: the next paint redraws the video over it. */
  private backgroundDirty = false;

  constructor(private readonly deps: PlayerDeps) {
    this.clock = new MasterClock(deps.nowMs);
    this.background = new BackgroundStill({
      decode: deps.decodeImage ?? (() => Promise.reject(new Error('this player has no image decoder'))),
      onChange: (still) => {
        this.compositor?.setBackground?.(still);
        this.backgroundDirty = true;
      },
      onError: (message) => this.deps.bdjLog?.(message, true),
      maxDecodedBytes: () => this.memory.bdjDecodedImageBytes,
    });
  }

  /**
   * Once, at the engine worker's start: says whether this device can keep a read-ahead cache (readAheadCache), and
   * clears the caches over 24 hours old.
   */
  async startReadAheadCache(): Promise<void> {
    const root = this.deps.readAheadCacheRoot;
    let available = false;
    if (root) {
      try {
        await root();
        available = true;
        await ReadAheadCache.clearExpired(root, (this.deps.epochMs ?? Date.now)());
      } catch {
        // no OPFS here (a private window): NAS discs read only the network
      }
    }
    this.deps.emit({ type: 'readAheadCache', available });
  }

  /** Commands run strictly one at a time, in arrival order. */
  handle(cmd: EngineCommand): Promise<void> {
    // a read waiting for a fresh token holds up the queue, so the token cannot wait in it
    if (cmd.type === 'remoteToken') {
      this.remoteToken(cmd.token);
      return Promise.resolve();
    }
    // the page is going away (pagehide): the BD-J worker saves its storage at once, not behind queued commands
    if (cmd.type === 'flushSaves') {
      this.bdj?.session.flush();
      return Promise.resolve();
    }
    // a hidden page pauses the BD-J start-up timeout at once, whatever the queue holds (ruling R22)
    if (cmd.type === 'visibility') {
      this.pageHidden = cmd.hidden;
      this.bdj?.session.setHidden(cmd.hidden);
      return Promise.resolve();
    }
    // a place is saved as the page hides: reading the registers can't wait in the queue behind an open
    if (cmd.type === 'readPlace') {
      this.deps.emit({ type: 'placeState', ...this.readPlace() });
      return Promise.resolve();
    }
    // a bufferFirst open waits for its fill: cancelling can't wait in the queue behind it
    if (cmd.type === 'cancelBuffer') {
      const hold = this.openHold;
      if (hold) {
        // play now, with pauses: the disc opens at once and its fill goes on ahead of playback
        hold.cancelled = true;
        hold.release();
      } else {
        this.stopFill();
      }
      return Promise.resolve();
    }
    // a disc opening (buffering first, reading its metadata, or queued to) is dropped unopened by what comes after it
    if ((cmd.type === 'open' || cmd.type === 'close') && this.openHold) {
      this.openHold.abandoned = true;
      this.openHold.release();
      this.openHold = null;
      this.stopFill();
    }
    if (cmd.type === 'open') {
      const hold = openHold();
      this.holds.set(cmd, hold);
      this.openHold = hold;
    }
    this.queue = this.queue.then(() => this.run(cmd));
    return this.queue;
  }

  private async run(cmd: EngineCommand): Promise<void> {
    try {
      switch (cmd.type) {
        case 'open':
          await this.open(cmd.disc, cmd.bufferFirst, this.holds.get(cmd) ?? null, cmd.start ?? null);
          break;
        case 'remoteToken':
        case 'cancelBuffer':
        case 'flushSaves':
        case 'visibility':
        case 'readPlace':
          break; // handled at once
        case 'bufferAhead':
          await this.fill(cmd, false);
          break;
        case 'attachCanvas':
          this.compositor = this.deps.createCompositor(cmd.canvas);
          if (this.shaderStage) this.compositor.setShaderStage?.(this.shaderStage);
          if (this.background.current) this.compositor.setBackground?.(this.background.current);
          this.startRenderLoop();
          break;
        case 'attachAudio':
          this.ring = new RingWriter(ringViews(cmd.ring));
          this.audioWriter = new AudioWriter(this.ring);
          break;
        case 'resize':
          this.compositor?.resize(cmd.width, cmd.height);
          this.repaint();
          break;
        case 'playPlaylist':
          this.stopBdj();
          this.stopNavigator();
          await this.playPlaylist(cmd.playlistId);
          break;
        case 'playTitle':
          if (this.bdj) this.bdjPlayTitle(this.bdj, cmd.title);
          else if (!this.refused(cmd.title === 0 ? 'menuCall' : 'titleSearch')) this.playTitle(cmd.title);
          break;
        case 'menuCall':
          if (this.bdj) this.bdjPlayTitle(this.bdj, 0);
          else if (!this.refused('menuCall')) this.playTitle(0);
          break;
        case 'menuKey':
          this.menuKey(cmd.key, cmd.repeat === true);
          break;
        case 'pointer':
          this.pointer(cmd.kind, cmd.x, cmd.y);
          break;
        case 'play':
          await this.play();
          this.bdj?.host.setRate(RATE_NORMAL);
          break;
        case 'pause':
          // under a BD-J title pause, seeks and chapter skips are never refused (UO restriction RELAXED)
          if (!this.bdj && this.refused('pauseOn')) break;
          this.pause();
          this.bdj?.host.setRate(RATE_PAUSED);
          break;
        case 'close':
          this.close();
          break;
        case 'setMemoryProfile':
          this.memory = MEMORY_PROFILES[cmd.profile];
          this.memoryName = cmd.profile;
          break;
        case 'setVideoShaders':
          this.setVideoShaders(cmd.set);
          break;
        case 'seek':
          if (!this.bdj && this.refused('timeSearch')) break;
          this.notifySeeked(cmd.timeUs);
          // ASS collision memory belongs to what was on screen before the seek
          for (const f of this.textTrack?.files ?? []) if (f.renderer instanceof AssRenderer) f.renderer.reset();
          await this.startAt(cmd.timeUs, this.wantPlaying);
          break;
        case 'selectAudio':
          await this.selectAudio(cmd.index);
          break;
        case 'setLevel':
          await this.setLevel(cmd.disc, cmd.audio);
          break;
        case 'selectSubtitle':
          this.selectSubtitle(cmd.choice);
          break;
        case 'addTextSubtitles':
          await this.addTextSubtitles(cmd.files, cmd.encoding, cmd.fonts ?? []);
          break;
        case 'addSubtitleFonts':
          await this.addSubtitleFonts(cmd.fonts);
          break;
        case 'removeTextSubtitle':
          this.dropTextTrack();
          this.textOn = false;
          this.subtitlesChanged();
          break;
        case 'setSubtitleStart':
          if (cmd.startUs === null || Number.isFinite(cmd.startUs)) this.textTrack?.renderer.set.setStart(cmd.file, cmd.startUs);
          this.subtitlesChanged();
          break;
        case 'setSubtitleOffset':
          if (Number.isFinite(cmd.ms)) this.textTrack?.renderer.set.setOffset(cmd.file, cmd.ms);
          this.subtitlesChanged();
          break;
        case 'setSubtitleScale':
          if (Number.isFinite(cmd.scale)) this.textScale = Math.max(MIN_TEXT_SCALE, Math.min(MAX_TEXT_SCALE, cmd.scale));
          this.subtitlesChanged();
          break;
        case 'nextChapter':
          if (!this.bdj && this.refused('skipToNextPoint')) break;
          await this.skipChapter(1);
          break;
        case 'prevChapter':
          if (!this.bdj && this.refused('skipBackToPreviousPoint')) break;
          await this.skipChapter(-1);
          break;
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /** One render tick (requestAnimationFrame in the worker; called directly by tests). */
  tick(): void {
    this.kickFill(false);
    this.navigator?.tick(this.clock.nowUs());
    if (this.bdj) {
      this.bdj.status.setTime45(this.titleTime45());
      this.updateBdjMenu(this.bdj);
    }
    const s = this.session;
    if (!s) {
      // a BD-J menu can show with no playlist playing
      if (this.bdj) {
        this.paint(null, this.clock.nowUs());
        this.maybeEmitTelemetry(null);
      }
      return;
    }
    this.updatePlayback(s);
    this.syncNavigator(s);
    const now = this.clock.nowUs();
    const frame = this.presenter.select(now);
    if (frame && this.state === 'playing') this.offsets.push(now - frame.timestamp);
    // without a picture the first frame is the black one with the planes over it, composited once the playlist plays
    const blank = s.decoder === null && this.state === 'playing' && !s.blankComposited;
    if (blank) {
      s.blankComposited = true;
      this.bdjDirty = true; // paint composites it now, whether or not a plane changed
    }
    const startup = this.bdjStartup;
    if ((frame || blank) && s.owner === 'bdj' && startup && startup.firstPlaylistMs !== null && startup.firstFrameMs === null) startup.firstFrameMs = this.sinceOpenMs();
    this.pg?.tick(now);
    this.paint(frame, now);
    this.feedDecoder(s); // presenting freed decoded-frame slots
    const last = this.presenter.current;
    // without a picture the playlist ends, as libbluray's does on EOF, once the reader is done and what it delivered
    // (audio, PG, IG, and the video read up to where its data ended) has played out, or at its duration if that is first
    const endUs = s.decoder ? (last?.timestamp ?? 0) + 100_000 : Math.min(s.timeline.durationUs, Math.max(s.deliveredEndUs + 100_000, s.readEndUs));
    if (this.state === 'playing' && !this.held && s.flushed && this.presenter.size === 0 && now >= endUs) {
      this.wantPlaying = false;
      this.ring?.setPlaying(false);
      this.clock.setRunning(false);
      // With a navigator or a BD-J title, its program decides what follows: the next playlist replaces the session
      if (s.owner === 'bdj') this.bdjListener?.playlistEnded();
      else this.navigator?.playlistEnded();
      if (this.session === s) this.setState('ended');
    }
    if (this.session !== s) return; // the navigator replaced the session
    this.emitTime(Math.min(now, s.timeline.durationUs), false);
    this.maybeEmitTelemetry(s);
  }

  /** Redraws the current picture at once: the video and every plane over it. */
  private repaint(): void {
    this.compositor?.drawVideo(this.presenter.current);
    if (this.pg) this.compositor?.drawPg?.(this.pg.plane);
    if (this.textOn && this.textTrack) this.compositor?.drawText?.(this.textTrack.renderer, this.clock.nowUs(), this.textOptions());
    if (this.navigator?.igPlane) this.compositor?.drawIg?.(this.navigator.igPlane);
    if (this.bdj) this.compositor?.drawBdj?.(this.bdj.plane);
  }

  /**
   * Video, then the PG plane, the text subtitles, the IG plane and the BD-J plane. A change to any of them repaints the
   * video and everything over it (an overlay replaces pixels, it does not blend with what it covered). The BD-J plane
   * changes only when Java flushes (or opens or closes it), so a half-drawn menu never shows.
   */
  private paint(frame: VideoFrame | null, nowUs: number): void {
    const nav = this.navigator;
    const pg = this.pg?.plane ?? null;
    const ig = nav?.igPlane ?? null;
    const bdj = this.bdj?.plane ?? null;
    const bdjChanged = bdj !== null && (bdj.pending() || this.bdjDirty);
    this.bdjDirty = false;
    const text = this.textOn && this.compositor?.drawText ? this.textTrack : null;
    const textOpts = this.textOptions();
    const pgChanged = pg !== null && pg.dirty() !== null;
    const igChanged = ig !== null && ig.dirty() !== null;
    const textChanged = this.subtitlesDirty || (text !== null && text.renderer.changed(nowUs, textOpts));
    this.subtitlesDirty = false;
    const changed = pgChanged || igChanged || textChanged || bdjChanged || this.shadersDirty || this.backgroundDirty;
    this.shadersDirty = false;
    this.backgroundDirty = false;
    if (frame) this.compositor?.drawVideo(frame);
    else if (changed) this.compositor?.drawVideo(this.presenter.current);
    if (!(frame || changed)) return;
    // an empty plane needs no per-frame draw
    if (pg && (pg.hasContent || pgChanged)) {
      if (this.compositor?.drawPg) this.compositor.drawPg(pg);
      else pg.takeDirty();
    }
    if (text) this.compositor?.drawText?.(text.renderer, nowUs, textOpts);
    if (ig && (ig.hasContent || igChanged)) {
      if (this.compositor?.drawIg) this.compositor.drawIg(ig);
      else ig.takeDirty();
    }
    if (igChanged && nav) this.igDraws = nav.takeDrawCount();
    if (bdj && (bdjChanged || bdj.visible())) {
      const copied = bdj.copiedVersion();
      this.compositor?.drawBdj?.(bdj);
      // this frame shows what its copy took, which may be a flush that landed after bdjChanged was computed: Java
      // flushes on the BD-J worker's thread (a copy that waited for the writer took nothing, and answers nothing)
      if (bdj.copiedVersion() !== copied) this.bdjLatency.presented(this.deps.nowMs(), bdj.copiedVersion());
    }
  }

  private setVideoShaders(set: ShaderSetData | null): void {
    if (!this.shaderStage) {
      if (!set) {
        this.deps.emit({ type: 'shaderStatus', state: 'off', set: null, error: null });
        return;
      }
      let backend: ShaderBackend | string | undefined;
      try {
        backend = this.deps.createShaderBackend?.({ lost: () => this.shaderStage?.contextLost(), restored: () => this.shaderStage?.contextRestored() });
      } catch {
        backend = UNAVAILABLE; // e.g. OffscreenCanvas or getContext throwing: report unavailable rather than failing playback
      }
      this.shaderStage = new ShaderStage(
        backend ?? NO_SHADER_BACKEND_MESSAGE,
        (status) => this.deps.emit({ type: 'shaderStatus', ...status }),
        () => {
          this.shadersDirty = true;
        },
      );
      this.compositor?.setShaderStage?.(this.shaderStage);
    }
    this.shaderStage.setSet(set);
  }

  private startRenderLoop(): void {
    if (this.renderLoopStarted) return;
    this.renderLoopStarted = true;
    const loop = (): void => {
      try {
        this.tick();
      } catch (err) {
        if (this.state !== 'error') this.fail(err); // report once; the loop keeps running so recovery stays possible
      } finally {
        this.deps.requestFrame(loop);
      }
    };
    this.deps.requestFrame(loop);
  }

  private async open(spec: DiscSpec, bufferFirst: BufferRequest | undefined, hold: OpenHold | null, start: StartPoint | null): Promise<void> {
    try {
      if (hold?.abandoned) {
        // dropped while queued: the disc that was open stays as it was until the command that dropped it
        if (spec.kind === 'remote') spec.fetchPort?.close();
        if (spec.kind === 'remote' && spec.fetchPort) this.deps.emit({ type: 'fetchPortClosed' });
        return;
      }
      await this.openDisc(spec, bufferFirst, hold, start);
    } finally {
      if (this.openHold === hold) this.openHold = null;
    }
  }

  /** `start`: the disc opens there, with no First Play and no BD-J (openAt). */
  private async openDisc(spec: DiscSpec, bufferFirst: BufferRequest | undefined, hold: OpenHold | null, start: StartPoint | null): Promise<void> {
    this.openedAtMs = this.deps.nowMs();
    this.bdjStartup = null;
    this.bdjLatency = new InputLatency();
    this.bdjTapsIgnored = 0;
    this.noPictureNotice = 'unsent';
    this.missingAudioLogged = new Set();
    this.bdjStorageNotice = false;
    this.stopBdj();
    this.dropEarlyBdj();
    this.stopNavigator();
    this.teardownSession();
    this.dropRemote();
    this.setState('loading');
    const source = this.createSource(spec);
    // spec §4.7: the class library loads, and a BD-J First Play's worker boots, while the disc opens
    // (not while it buffers first: the disc's First Play waits for that; nor when it opens at a place, with BD-J off)
    const early = this.bdjSupported && !bufferFirst && !start ? await this.startEarlyBdj(source) : null;
    let disc: DiscModel;
    try {
      disc = await openDisc(source);
    } catch (err) {
      this.dropEarlyBdj();
      this.dropRemote(); // its read-ahead would otherwise go on fetching
      if (hold?.abandoned) return; // closed meanwhile: nobody waits for this open's error
      throw err;
    }
    this.source = source;
    this.disc = disc;
    if (bufferFirst && hold && !hold.abandoned) {
      // the fill goes on ahead of playback for as long as the disc is open; the open waits for its target
      const fill = await this.fill(bufferFirst, true);
      if (fill && !hold.cancelled) await Promise.race([fill.reached, hold.released]);
    }
    if (hold?.abandoned) return this.dropUnopened();
    this.soundsPlayed = 0;
    if (disc.usesBdj) this.loadClassLibrary();
    this.bdjDiscId = disc.usesBdj ? ((await readBdid(source))?.discId ?? null) : null;
    if (hold?.abandoned) return this.dropUnopened();
    this.pgRegs = new RegisterFile();
    this.initRegs(this.pgRegs, disc.index);
    this.bindPg(this.pgRegs);
    this.resetTextSubtitles();
    this.emitSubtitles();
    this.deps.emit({ type: 'titles', playlists: disc.summaries, usesBdj: disc.usesBdj, bdjSupported: this.bdjSupported, bdjMissing: this.deps.bdjMissing ?? [], warnings: disc.warnings });
    if (disc.movieObjects) this.emitIndexTitles(disc);
    if (disc.sounds) this.deps.emit({ type: 'soundEffects', clips: disc.sounds.clips.map((c) => ({ channels: c.channels, samples: c.samples })) });
    if (disc.usesBdj && !this.bdjSupported) this.notice('bdj', this.bdjUnsupported('disc'));
    if (start) {
      await this.openAt(disc, start); // no early BD-J worker was started for it
      return;
    }
    // bdjActive goes out before 'idle', so the UI never shows the picker in between
    const bdjFirstPlay = disc.index.firstPlay.kind === 'bdj' && this.bdjSupported;
    if (bdjFirstPlay) this.enterBdj(TITLE_FIRST_PLAY, null, early);
    else this.dropEarlyBdj();
    this.setState('idle');
    if (!bdjFirstPlay && disc.movieObjects && disc.index.firstPlay.kind === 'hdmv') {
      this.navigator = this.createNavigator(disc);
      this.navigator.start();
    }
  }

  /**
   * Opens the disc at a saved place instead of its First Play. With an HDMV title and the disc's movie objects, the
   * title resumes on its saved registers at the playlist (Navigator.resumeTitle); when the title never plays that
   * playlist, or without them (BD-J discs too, with BD-J off), the playlist plays directly with PSRs 1–3 on the private
   * registers. A playlist the disc lacks plays nothing; a time at or past its end plays from the beginning.
   */
  private async openAt(disc: DiscModel, start: StartPoint): Promise<void> {
    const mpls = disc.playlists.get(start.playlistId);
    if (!mpls || mpls.playItems.length === 0 || !/^\d{5}$/.test(start.playlistId)) {
      this.deps.emit({ type: 'startFailed', reason: 'no-playlist' });
      this.setState('idle');
      return;
    }
    const timeline = new Timeline(mpls.playItems, mpls.marks);
    let timeUs = Math.max(0, start.timeUs);
    if (!(timeUs < timeline.durationUs)) {
      this.deps.emit({ type: 'startFailed', reason: 'past-end' });
      timeUs = 0;
    }
    const { item, clipTime45 } = timeline.locate(timeUs);
    const at: PlayAt = { item: item.index, clipTime45 };
    const { hdmv } = start;
    if (hdmv && disc.movieObjects) {
      // loaded before the navigator and PG subscribe, so no listener sees half-loaded registers
      // idle first, as before First Play: a program that ends without a playlist leaves the picker, not 'loading'
      this.setState('idle');
      const regs = this.newProgramRegs(disc.index, disc.usesBdj);
      regs.load({ psrs: hdmv.psrs, gprs: hdmv.gprs }, SETTING_PSRS);
      this.navigator = this.createNavigator(disc, regs);
      if (this.navigator.resumeTitle(hdmv.title, Number(start.playlistId), at)) return;
      this.stopNavigator();
      this.deps.log?.(`Title ${hdmv.title} never plays playlist ${start.playlistId}: playing the playlist directly`);
    }
    const playback = start.playback ?? (hdmv ? { psr1: hdmv.psrs[PSR.PRIMARY_AUDIO_ID] ?? 0, psr2: hdmv.psrs[PSR.PG_STREAM] ?? 0, psr3: hdmv.psrs[PSR.ANGLE_NUMBER] ?? 1 } : null);
    if (playback && this.pgRegs) {
      this.pgRegs.psrWrite(PSR.PRIMARY_AUDIO_ID, playback.psr1 >>> 0);
      this.pgRegs.psrWrite(PSR.PG_STREAM, playback.psr2 >>> 0);
      this.pgRegs.psrWrite(PSR.ANGLE_NUMBER, playback.psr3 >>> 0);
    }
    await this.playPlaylist(start.playlistId, at, 'user', playback ? playback.psr1 & 0xfff : null);
  }

  /** The registers a saved place needs: the program's (navigator first, as programRegs), else the private PG registers. */
  private readPlace(): PlaceState {
    if (this.navRegs) {
      const { psrs, gprs } = this.navRegs.snapshot();
      return { mode: 'hdmv', title: psrs[PSR.TITLE_NUMBER]!, psrs, gprs };
    }
    if (this.bdj) return { mode: 'bdj', title: null, psrs: this.bdj.regs.snapshot().psrs, gprs: null };
    return { mode: 'none', title: null, psrs: this.pgRegs?.snapshot().psrs ?? [], gprs: null };
  }

  /** A close or another open came while the disc opened (read its metadata, or filled): it is dropped unopened. */
  private dropUnopened(): void {
    this.dropEarlyBdj();
    this.dropRemote();
    this.source = null;
    this.disc = null;
  }

  /** The disc's bytes; a NAS disc's waits show a notice, and its 401s ask the controller for a fresh token. */
  private createSource(spec: DiscSpec): FileSource | RemoteSource {
    if (spec.kind === 'remote' && spec.fetchPort) {
      const { fetchPort, ...rest } = spec;
      this.discPort = { port: fetchPort, fetch: portFetch(fetchPort) };
      spec = rest;
    }
    this.discSpec = spec;
    const tokens = new TokenRelay(() => this.deps.emit({ type: 'remoteTokenNeeded' }), this.deps.setTimer ?? defaultSetTimer);
    const source: FileSource | RemoteSource = createByteSource(spec, {
      fetch: this.discPort?.fetch ?? this.deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
      readAheadBytes: this.deps.remoteLimits?.readAheadBytes ?? this.memory.remoteReadAheadBytes,
      ...(this.deps.remoteLimits?.chunkBytes ? { chunkBytes: this.deps.remoteLimits.chunkBytes } : {}),
      onWaiting: (waiting) => {
        if (this.remote !== source) return; // a disc closed meanwhile
        this.nasWaiting = waiting;
        if (waiting) this.notice('nas-waiting', NAS_WAITING_MESSAGE);
        else this.deps.emit({ type: 'noticeCleared', code: 'nas-waiting' });
      },
      refreshToken: () => tokens.request(),
    });
    if (source instanceof RemoteSource) {
      this.remote = source;
      this.tokens = tokens;
      if (spec.kind === 'remote') this.cache = this.openCache(source, spec.manifest);
    } else if (this.deps.readAheadCacheRoot) {
      void ReadAheadCache.clearAll(this.deps.readAheadCacheRoot).catch(() => undefined); // another disc opened
    }
    return source;
  }

  /**
   * The disc's on-disk read-ahead cache, which the source reads before the network; other discs' caches, and this
   * one's when over 24 hours old, are cleared first. Null when there is no cache root or it fails (no OPFS, a private
   * window): the disc then reads only the network.
   */
  private async openCache(source: RemoteSource, manifest: DiscManifest): Promise<ReadAheadCache | null> {
    const root = this.deps.readAheadCacheRoot;
    if (!root) return null;
    const sizes = new Map(manifest.files.map((f) => [f.path.toUpperCase(), f.size]));
    try {
      const cache = await ReadAheadCache.open(manifest.discId, {
        root,
        now: this.deps.epochMs ?? Date.now,
        fileSize: (path) => sizes.get(path.toUpperCase()),
        ...(this.deps.readAheadSegmentBytes ? { segmentBytes: this.deps.readAheadSegmentBytes } : {}),
      });
      await cache.clearOthers();
      if (this.remote !== source) {
        cache.close(); // the disc closed meanwhile
        return null;
      }
      source.setCache(cache);
      return cache;
    } catch {
      return null;
    }
  }

  /**
   * Starts filling the read-ahead cache with the request's playlist (the main title's without one), in playback order
   * from `fromSeconds`, reporting bufferProgress. Without `follow` it stops once `targetBytes` are held; with it (a
   * bufferFirst open) it goes on ahead of the play position to the end of the playlist, freeing what playback has
   * passed, until the disc closes. One fill runs at a time: a new one replaces it. Resolves with the fill, or null when
   * there is none (no NAS disc, or no cache: then bufferProgress says 'no-cache').
   */
  private async fill(req: BufferRequest, follow: boolean): Promise<CacheFill | null> {
    this.stopFill();
    this.fillArgs = { req, follow };
    const remote = this.remote;
    const disc = this.disc;
    if (!remote || !disc) return null;
    const noCache = (): null => {
      this.deps.emit({ type: 'bufferProgress', bytes: 0, targetBytes: req.targetBytes, mbps: 0, stopped: 'no-cache' });
      return null;
    };
    const cache = await this.cache;
    if (!cache || this.remote !== remote) return this.remote === remote ? noCache() : null;
    const playlistId = req.playlistId !== undefined && disc.playlists.has(req.playlistId) ? req.playlistId : disc.summaries[0]?.id;
    const mpls = playlistId === undefined ? undefined : disc.playlists.get(playlistId);
    if (!mpls) return null;
    let clips = disc.clips;
    const missing = [...new Set(mpls.playItems.map((p) => p.clipId))].filter((id) => !clips.has(id));
    try {
      if (missing.length > 0) clips = new Map([...clips, ...(await loadClips(remote, missing))]);
    } catch {
      this.deps.emit({ type: 'bufferProgress', bytes: 0, targetBytes: req.targetBytes, mbps: 0, stopped: 'failed' });
      return null;
    }
    if (this.remote !== remote) return null;
    // Following playback: from the play position while this playlist plays; while another one plays the fill idles
    // (null), and with none playing it keeps the last position (the request's start before playback).
    let lastUs = Math.max(0, req.fromSeconds) * 1e6;
    const position = (): number | null => {
      const s = this.session;
      if (!follow || !s) return lastUs;
      if (s.playlistId !== playlistId) return null;
      lastUs = this.clock.nowUs();
      return lastUs;
    };
    const segmentBytes = this.deps.readAheadSegmentBytes ?? SEGMENT_BYTES;
    const fill = new CacheFill({
      remote,
      cache,
      ranges: () => {
        const at = position();
        return at === null ? null : bufferRanges(mpls, clips, (path) => remote.size(path), at, remote.chunkBytes);
      },
      follow,
      targetBytes: req.targetBytes,
      leadCapBytes: req.targetBytes + segmentBytes,
      segmentBytes,
      progress: (p) => {
        if (this.filling === fill) this.deps.emit({ type: 'bufferProgress', ...p });
      },
      nowMs: () => this.deps.nowMs(),
      setTimer: this.deps.setTimer ?? defaultSetTimer,
      // a flap (nas-lost, a 5xx, a full disk that eviction may free) is retried; these are not
      permanent: (err) => err instanceof RemoteDiscError && (err.reason === 'disc-changed' || err.reason === 'nas-unpaired'),
    });
    this.filling = fill;
    remote.setWriteThrough(follow ? (path, offset, bytes) => fill.keep(path, offset, bytes) : null);
    void fill.run().finally(() => {
      if (this.filling !== fill) return;
      this.filling = null;
      this.fillArgs = null;
      remote.setWriteThrough(null);
    });
    return fill;
  }

  /** Stops the fill; what the cache holds stays. */
  private stopFill(): void {
    this.filling?.stop();
    this.filling = null;
    this.fillArgs = null;
    this.remote?.setWriteThrough(null);
  }

  /** The play position moved: a following fill looks again (now, or at most every FILL_KICK_MS while playing). */
  private kickFill(force: boolean): void {
    if (!this.filling) return;
    const now = this.deps.nowMs();
    if (!force && now - this.lastFillKickMs < FILL_KICK_MS) return;
    this.lastFillKickMs = now;
    this.filling.kick();
  }

  /** A fresh NAS token: for the reads waiting on one, the open disc's source and its BD-J worker, and later BD-J boots. */
  private remoteToken(token: string): void {
    if (this.discSpec.kind !== 'remote' || !this.remote) return;
    this.discSpec = { ...this.discSpec, token };
    this.remote.setToken(token);
    this.tokens?.deliver(token);
    this.earlyBdj?.worker.postMessage({ type: 'remoteToken', token });
    this.bdj?.session.setToken(token);
  }

  /** Forgets the NAS disc: its fetches stop and its read-ahead is freed. */
  private dropRemote(): void {
    this.stopFill();
    this.nasWaiting = false;
    this.remote?.close();
    this.remote = null;
    void this.cache?.then((cache) => cache?.close());
    this.cache = null;
    this.tokens = null;
    this.discSpec = { kind: 'files', entries: [] };
    if (this.discPort) {
      this.discPort.port.close();
      this.discPort = null;
      this.deps.emit({ type: 'fetchPortClosed' });
    }
  }

  /**
   * Another version of the open NAS disc (a quality level, or the original): the source, the read-ahead cache (its
   * segments are named with each file's size, so the versions' bytes never mix) and the disc model are the new
   * version's, the program (navigator or BD-J title) gets the new model with its state untouched, and the playing
   * playlist starts again on it through playPlaylist, at the current time and paused if it was, so its streams, picture,
   * decoder and compositor are chosen anew. A failure once the switch began leaves the disc closed, with its error.
   * `audio` (a switch to the original): the stream the viewer heard at the level, played when it is playable here, over
   * the program's PSR1, which is then set to it. The end of a still play item, once reported, is not reported again.
   */
  private async setLevel(next: RemoteDiscSpec, audio?: number): Promise<void> {
    const open = this.discSpec;
    const refuse = (message: string): void => this.deps.emit({ type: 'levelChanged', ok: false, message });
    if (next.fetchPort) {
      // never sent with one: the open disc's port goes on serving
      next.fetchPort.close();
      const { fetchPort: _fetchPort, ...rest } = next;
      next = rest;
    }
    if (open.kind !== 'remote' || !this.remote || !this.disc) return refuse('No disc from the NAS is open.');
    if (next.manifest.discId !== open.manifest.discId) return refuse('Another disc is open.');
    const s = this.session;
    const resume = s
      ? {
          playlistId: s.playlistId,
          owner: s.owner,
          timeUs: Math.min(Math.max(0, this.clock.nowUs()), Math.max(0, s.timeline.durationUs - 1)),
          autoplay: this.wantPlaying,
          // the track heard at the level, when given; else with a program its PSR1 decides (playPlaylist), and without one
          // the track that plays, when the version has it
          audio: audio ?? (this.programRegs ? null : s.audioStream),
          // the end of a still item reported stays reported; a BD-J still the switch lets go (teardownSession) is met
          // again at the same place, with no report to Java
          endReported: this.bdjStill ? null : this.navEndReported,
        }
      : null;
    const refill = this.fillArgs;
    const generation = this.openGeneration;
    this.levelVersion++;
    // A program's playlist open (navigator or BD-J, outside the command queue) that meets the switch waits for it and
    // then opens on the new version (playPlaylist): it never reads the closed source, and it is what plays afterwards.
    let switched!: () => void;
    this.switching = new Promise<void>((resolve) => (switched = resolve));
    const release = (): void => {
      this.switching = null;
      switched();
    };
    try {
      this.teardownSession();
      this.stopFill();
      const oldRemote = this.remote;
      const oldCache = this.cache;
      this.remote = null;
      this.cache = null;
      this.tokens = null;
      if (this.nasWaiting) {
        // the old source can no longer say its read landed
        this.nasWaiting = false;
        this.deps.emit({ type: 'noticeCleared', code: 'nas-waiting' });
      }
      oldRemote.close();
      (await oldCache)?.close();
      const original = next.original ?? open.original;
      const source = this.createSource({ ...next, ...(original ? { original } : {}) });
      const disc = await openDisc(source);
      this.source = source;
      this.disc = disc;
      this.navigator?.replaceDisc(disc);
      this.bdj?.host.replaceDisc(disc);
      // The program started (or stopped) a playlist meanwhile: that one plays. An open already current when the switch
      // began tore the session down, so there is nothing to resume then; a stale one (superseded before) gives up.
      const superseded = generation !== this.openGeneration;
      release(); // before the restart, which opens the playlist like any other
      if (resume && !superseded) {
        const mpls = disc.playlists.get(resume.playlistId);
        if (!mpls || mpls.playItems.length === 0) throw new DiscError('missing-file', `Playlist ${resume.playlistId} is not available.`, [playlistPath(resume.playlistId)]);
        const { item, clipTime45 } = new Timeline(mpls.playItems, mpls.marks).locate(resume.timeUs);
        const started = await this.playPlaylist(resume.playlistId, { item: item.index, clipTime45 }, resume.owner, resume.audio, {
          autoplay: resume.autoplay,
          endReported: resume.endReported,
        });
        if (!started) throw new Error(`Playlist ${resume.playlistId} could not be started on this version of the disc.`);
        // the program keeps the track the viewer heard, as an Audio menu pick would leave it
        const regs = this.programRegs;
        if (audio !== undefined && regs && this.session?.playlistId === resume.playlistId && this.session.audioStream === audio) regs.psrWrite(PSR.PRIMARY_AUDIO_ID, audio);
      }
      // failures as a bufferAhead's (the command's catch)
      if (refill && this.remote === source) this.fill(refill.req, refill.follow).catch((err: unknown) => this.fail(err));
    } catch (err) {
      release();
      this.close();
      this.reportError(err);
      this.setState('error');
      refuse(err instanceof Error ? err.message : String(err));
      return;
    }
    this.deps.emit({ type: 'levelChanged', ok: true });
  }

  /** How a new BD-J worker reads the disc: on the port route, through a fetch port relayed to the engine's own. */
  private bdjDisc(): BdjDisc {
    const route = this.discPort;
    if (!route) return { port: null, stop: () => undefined };
    const { port1, port2 } = new MessageChannel();
    const stopServing = serveFetch(port1, route.fetch);
    return {
      port: port2,
      stop: () => {
        stopServing();
        port1.close();
      },
    };
  }

  /**
   * The disc in a BD-J worker's boot message: the open disc with its latest token, and the worker's fetch port. A NAS
   * disc at a quality level boots on the original version (its manifest, no level query): Java never reads the streams,
   * and its playlists and clip info stay the disc's own.
   */
  private bootDisc(disc: BdjDisc): DiscSpec {
    const spec = this.discSpec;
    if (spec.kind !== 'remote') return spec;
    const { query: _query, original, ...rest } = spec;
    const boot: RemoteDiscSpec = { ...rest, manifest: original ?? spec.manifest };
    return disc.port ? { ...boot, fetchPort: disc.port } : boot;
  }

  private get bdjSupported(): boolean {
    return this.deps.createBdjWorker !== undefined && this.deps.loadClassLibrary !== undefined && (this.deps.bdjMissing?.length ?? 0) === 0;
  }

  /** The notice when BD-J cannot run: what the browser lacks, or (a build without BD-J) that it is not supported. */
  private bdjUnsupported(what: 'disc' | 'title'): string {
    const missing = this.deps.bdjMissing ?? [];
    if (missing.length > 0) return bdjUnsupportedMessage(missing, what);
    return what === 'disc'
      ? 'This disc uses BD-J (Java) menus, which are not supported. Choose a playlist to play.'
      : 'This title uses BD-J (Java), which is not supported. Choose a playlist to play.';
  }

  /** _fill_disc_info's profile switch (bd_open). */
  private initRegs(regs: RegisterFile, index: IndexBdmv): void {
    applyDiscProfile(regs, index);
  }

  /**
   * The player settings an application sets with bd_set_player_setting_str, written when the registers of a disc that
   * uses BD-J are made, as libbluray has them from bd_open: its HDMV First Play reads them too. Discs without BD-J keep
   * the registers' defaults (ruling R9, narrowed in 5e).
   */
  private applyBdjSettings(regs: RegisterFile): void {
    if (this.deps.playerSettings) applyPlayerSettings(regs, this.deps.playerSettings);
  }

  /** The registers of the disc's program (HDMV or BD-J), shared with a BD-J worker when the disc can run BD-J. */
  private newProgramRegs(index: IndexBdmv, usesBdj: boolean): RegisterFile {
    const shared = usesBdj && this.bdjSupported ? new SharedArrayBuffer(REGISTER_WORDS * 4) : undefined;
    const regs = new RegisterFile(shared ? { shared } : {});
    this.initRegs(regs, index);
    if (usesBdj) this.applyBdjSettings(regs);
    regs.onPsrEvent((e) => this.onPsrEvent(e, regs));
    return regs;
  }

  /**
   * Reads index.bdmv ahead of the rest of the disc: a disc that uses BD-J starts loading the class library, and one
   * whose First Play is BD-J gets its worker, registers and status block now; the worker's boot goes out once the
   * class library is in, so the JVM boots while the disc opens. enterBdj adopts it.
   */
  private async startEarlyBdj(source: FileSource | RemoteSource): Promise<EarlyBdj | null> {
    const index = await peekIndex(source);
    if (!index || !indexUsesBdj(index)) return null;
    this.loadClassLibrary();
    const library = this.bdjClassLibrary;
    const createWorker = this.deps.createBdjWorker;
    if (index.firstPlay.kind !== 'bdj' || !library || !createWorker) return null;
    const early: EarlyBdj = {
      worker: new EarlyBdjWorker(createWorker()),
      regs: this.newProgramRegs(index, true),
      status: new StatusBlockWriter(createStatusBlock()),
      plane: new GraphicsPlaneReader(createGraphicsPlane()),
      disc: this.bdjDisc(),
    };
    this.earlyBdj = early;
    void (async () => {
      try {
        const [classLibrary, bdid] = await Promise.all([library, readBdid(source), this.bdjSaving]);
        // once adopted, the session sends the same boot itself (EarlyBdjWorker passes only the first)
        if (this.earlyBdj !== early) return;
        early.worker.boot({
          type: 'boot',
          registers: early.regs.shared!,
          status: early.status.buffer,
          plane: early.plane.buffer,
          disc: this.bootDisc(early.disc),
          readAheadBytes: this.memory.bdjRemoteReadAheadBytes,
          discId: bdid?.discId ?? null,
          classLibrary,
          memory: this.bdjBudgets(),
          ...(this.deps.memoryTelemetry ? { memoryStatsMs: BDJ_MEMORY_STATS_MS } : {}),
        });
      } catch {
        // a class library that does not load fails the session (bootBdj)
      }
    })();
    return early;
  }

  /** telemetry bdjMemory: the BD-J worker's last report and the engine's own BD-J buffers. */
  private bdjMemory(): BdjMemoryTelemetry | null {
    const entry = this.bdj;
    if (!entry) return null;
    return {
      jvm: entry.memory?.jvm ?? null,
      freeType: entry.memory?.freeType ?? null,
      planeBytes: entry.plane.buffer.byteLength,
      stillBytes: this.background.decodedBytes,
      compositorBytes: this.compositor?.bdjBytes?.() ?? 0,
    };
  }

  /** The memory profile's budgets the BD-J worker applies. */
  private bdjBudgets(): BdjMemoryBudgets {
    return { classBytes: this.memory.bdjClassCacheBytes, vfsBytes: this.memory.bdjVfsCacheBytes };
  }

  /** Terminates an early BD-J worker no title adopted. */
  private dropEarlyBdj(): void {
    this.earlyBdj?.worker.terminate();
    this.earlyBdj?.disc.stop();
    this.earlyBdj = null;
  }

  /** The program's registers: the navigator's or the BD-J title's. */
  private get programRegs(): RegisterFile | null {
    return this.navRegs ?? this.bdj?.regs ?? null;
  }

  /**
   * Enters BD-J (_play_title → _play_bdj → _start_bdj): a new worker boots, then title `title` starts. `regs`: the
   * navigator's registers when an HDMV title hands over (libbluray has one register file), else new ones.
   */
  private enterBdj(title: number, regs: RegisterFile | null, early: EarlyBdj | null = null): void {
    const { disc, source } = this;
    const createWorker = this.deps.createBdjWorker;
    this.loadClassLibrary();
    const library = this.bdjClassLibrary;
    if (!disc || !source || !createWorker || !library) return;
    if (early && this.earlyBdj !== early) early = null; // dropped meanwhile
    this.earlyBdj = null;
    const programRegs = early?.regs ?? (regs?.shared ? regs : this.newProgramRegs(disc.index, disc.usesBdj));
    const status = early?.status ?? new StatusBlockWriter(createStatusBlock());
    const plane = early?.plane ?? new GraphicsPlaneReader(createGraphicsPlane());
    // an early worker's boot (sent or still to come) and the session's carry the same disc: only one reaches the worker
    const bdjDisc = early?.disc ?? this.bdjDisc();
    let entry: BdjTitle | null = null;
    let ended = false;
    const live = (): boolean => !ended;
    const sink = (ev: number, param: number): void => {
      if (live()) entry?.session.event(ev, param);
    };
    const events = bdjPlaybackEvents(sink);
    const host: PlayerBdjHost = new PlayerBdjHost({
      port: this.bdjPort(live),
      regs: programRegs,
      disc,
      events,
      psrEvents: sink,
      startTitle: (t) => {
        if (live() && entry) this.startBdjTitle(entry, t);
      },
      playHdmvTitle: (t) => live() && entry !== null && this.bdjToHdmv(entry, t),
      uoMaskChanged: (bits) => {
        status.setUoMask(bits);
        if (live()) this.emitBdjUoMask(host);
      },
    });
    const session = new BdjSession({
      worker: early?.worker ?? createWorker(),
      host,
      regs: programRegs.shared!,
      status,
      plane: plane.buffer,
      time45: () => this.titleTime45(),
      onFailed: (code, message) => {
        if (live()) this.bdjFailed(code, message);
      },
      onLog: this.deps.bdjLog,
      onBackground: (image, rect) => {
        if (!live()) return;
        if (image && this.deps.decodeImage) this.background.show(image, rect);
        else this.background.clear();
      },
      onTokenNeeded: () => {
        if (live()) this.deps.emit({ type: 'remoteTokenNeeded' });
      },
      onStorageLost: () => {
        if (!live() || this.bdjStorageNotice) return;
        this.bdjStorageNotice = true;
        this.notice('bdj-storage', BDJ_STORAGE_MESSAGE);
      },
      nowMs: () => this.deps.nowMs(),
      setTimer: this.deps.setTimer ?? defaultSetTimer,
      ...(this.deps.wallMs ? { wallMs: this.deps.wallMs } : {}),
      hidden: this.pageHidden,
      memory: this.bdjBudgets(),
      ...(this.deps.memoryTelemetry
        ? {
            memoryStatsMs: BDJ_MEMORY_STATS_MS,
            onMemory: (m: Extract<FromBdj, { type: 'memory' }>) => {
              if (live() && entry) entry.memory = m;
            },
          }
        : {}),
    });
    const taps = new TapReactionWatch({
      setTimer: this.deps.setTimer ?? defaultSetTimer,
      // a plane publication (flush, init, close) or anything Java sent: a call (playback, registers, titles) or a still
      activity: () => plane.version() + session.activity,
      ignored: (notice) => {
        if (!live()) return;
        this.bdjTapsIgnored++;
        this.deps.emit({ type: 'bdjTapIgnored' });
        if (notice) this.notice('bdj-tap-ignored', BDJ_TAP_IGNORED_MESSAGE);
      },
    });
    entry = { session, host, events, regs: programRegs, status, plane, end: () => void (ended = true), pendingTitle: null, booted: false, menuVisible: false, disc: bdjDisc, taps, memory: null };
    this.bdjStartup ??= { bootMs: null, firstPlaylistMs: null, firstFrameMs: null };
    this.bdj = entry;
    this.bindPg(programRegs);
    this.deps.emit({ type: 'bdjActive', active: true });
    this.deps.emit({ type: 'uoMask', masked: [] });
    void host.handle('selectTitle', [title]); // _play_title: PSR4, then the title's object
    void this.bootBdj(entry, library);
  }

  private async bootBdj(entry: BdjTitle, library: Promise<ClassLibrarySource>): Promise<void> {
    let classes: ClassLibrarySource;
    try {
      classes = await library;
    } catch (err) {
      if (this.bdj === entry) this.bdjFailed('internal', `the class library could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.bdj !== entry) return;
    await this.bdjSaving; // a stopped worker's saves, which this one loads
    if (this.bdj !== entry) return;
    await entry.session.boot(this.bootDisc(entry.disc), this.memory.bdjRemoteReadAheadBytes, this.bdjDiscId, classes);
    if (this.bdj !== entry) return;
    entry.booted = true;
    if (this.bdjStartup && this.bdjStartup.bootMs === null) this.bdjStartup.bootMs = this.sinceOpenMs();
    const title = entry.pendingTitle;
    entry.pendingTitle = null;
    if (title !== null) entry.session.start(title);
  }

  /** _start_bdj on a running BD-J: BDJ_EVENT_START, held until the worker has booted. */
  private startBdjTitle(entry: BdjTitle, title: number): void {
    if (entry.booted) entry.session.start(title);
    else entry.pendingTitle = title;
  }

  /**
   * bd_play_title / bd_menu_call (title 0) under a BD-J title: at UO restriction RELAXED only title search and menu call
   * are checked (_try_play_title, _try_menu_call); a refused one is BDJ_EVENT_UO_MASKED for Java.
   */
  private bdjPlayTitle(entry: BdjTitle, title: number): void {
    const op: UoOp = title === 0 ? 'menuCall' : 'titleSearch';
    if (entry.host.isUoMasked(op)) {
      entry.events.uoMasked(UO_INDEX[op]!);
      this.notice('uo-masked', UO_MASKED_MESSAGE);
      return;
    }
    void entry.host.handle('selectTitle', [title]);
  }

  /** _play_hdmv from a BD-J title (_stop_bdj): BD-J stops and the navigator runs the title on the same registers. */
  private bdjToHdmv(entry: BdjTitle, title: number): boolean {
    const disc = this.disc;
    if (!disc?.movieObjects) return false;
    this.stopBdj();
    this.stopNavigator();
    const nav = this.createNavigator(disc, entry.regs);
    this.navigator = nav;
    if (nav.startTitle(title)) return true;
    this.stopNavigator();
    return false;
  }

  /** Spec §5: BD-J stops; what is playing keeps playing, and the user chooses from the picker. */
  private bdjFailed(code: BdjFailureCode, message: string): void {
    this.stopBdj(); // also cancels a playlist Java asked for that is still loading: it does not open behind the picker
    if (!this.session) this.setState('idle');
    this.notice('bdj-failed', `BD-J couldn't start this disc (${code}: ${message}). Choose a playlist to play.`);
  }

  /** Leaves BD-J: the worker is terminated, and nothing it still sends or started reaches the player. */
  private stopBdj(): void {
    const entry = this.bdj;
    if (!entry) return;
    entry.host.dispose();
    entry.end();
    entry.taps.cancel();
    this.bdjLatency.clearPending();
    this.bdj = null;
    this.planeSeen = null;
    this.releaseBdjStill();
    this.openGeneration++; // a playlist Java asked for that is still loading never opens (as stopNavigator)
    const saved = entry.session.stop();
    this.bdjSaving = Promise.all([this.bdjSaving, saved]).then(() => undefined);
    entry.disc.stop();
    // the menu goes at once (Review Focus 2): nothing of the plane or the background still is drawn again
    this.background.clear();
    this.backgroundDirty = false; // repainted here
    this.compositor?.clearBdj?.();
    this.repaint();
    if (this.pgRegs && this.navRegs !== entry.regs) this.bindPg(this.pgRegs);
    if (entry.menuVisible) this.deps.emit({ type: 'bdjMenu', visible: false });
    this.deps.emit({ type: 'bdjActive', active: false });
    this.deps.emit({ type: 'uoMask', masked: [] });
  }

  /** The UI hears only of the operations checked under a BD-J title. */
  private emitBdjUoMask(host: PlayerBdjHost): void {
    this.deps.emit({ type: 'uoMask', masked: [...host.uoMask].filter((op) => op in UO_INDEX) });
  }

  /** bd_tell_time: the title time of the presentation position, in 45 kHz ticks. */
  private titleTime45(): bigint {
    const s = this.session;
    return s ? BigInt(usToTicks45(Math.min(Math.max(0, this.clock.nowUs()), s.timeline.durationUs))) : 0n;
  }

  /** Starts fetching the jars while the rest of the disc opens; a failed load is retried with the next BD-J disc. */
  private loadClassLibrary(): void {
    if (this.bdjClassLibrary || !this.deps.loadClassLibrary) return;
    const loading = this.deps.loadClassLibrary();
    this.bdjClassLibrary = loading;
    loading.catch(() => {
      if (this.bdjClassLibrary === loading) this.bdjClassLibrary = null;
    });
  }

  private emitIndexTitles(disc: DiscModel): void {
    const titles = disc.index.titles.flatMap((t, i) => (t.object.kind === 'hdmv' || t.object.kind === 'bdj' ? [{ number: i + 1, kind: t.object.kind }] : []));
    const top = disc.index.topMenu;
    const hasTopMenu = top.kind === 'bdj' || (top.kind === 'hdmv' && top.movieObjectId !== INDEX_ID_NONE);
    this.deps.emit({ type: 'indexTitles', titles, hasTopMenu });
  }

  private createNavigator(disc: DiscModel, regs = this.newProgramRegs(disc.index, disc.usesBdj)): Navigator {
    this.navRegs = regs;
    this.bindPg(regs);
    this.menuActive = false;
    this.popupAvailable = false;
    this.igDraws = 0;
    return new Navigator({
      disc,
      regs,
      port: this.navigationPort(),
      emit: (e) => this.onNavigatorEvent(e),
      nowScr: () => this.deps.nowMs() * SCR_PER_MS,
      preloadSubPathIg: (clipId, signal) => this.preloadSubPathIg(clipId, signal).catch((err: unknown) => {
        if (err instanceof DiscError && err.message === MENU_MEMORY_MESSAGE) this.notice('menu-memory', MENU_MEMORY_MESSAGE);
        throw err;
      }),
    });
  }

  /** _preload_m2ts for an IG sub-path: the whole clip is demuxed into the PES units of every IG PID (0x1400 to 0x141f), in stream order. */
  private async preloadSubPathIg(clipId: string, signal: AbortSignal): Promise<IgUnit[]> {
    while (this.switching) await this.switching; // read from the version a setLevel is putting in place
    const source = this.source;
    const path = streamPath(clipId);
    if (!source || !source.exists(path)) throw new DiscError('missing-file', `Missing sub-path clip ${path}`, [path]);
    if (source.size(path) > this.memory.igPreloadLimitBytes) {
      // desktop keeps libbluray's behaviour and message (PRELOAD_SIZE_LIMIT)
      throw new DiscError('unreadable-stream', this.memoryName === 'constrained' ? MENU_MEMORY_MESSAGE : `Sub-path clip ${path} is too large to preload`, [path]);
    }
    const reader = new M2tsReader({ source, path, startSpn: 0, pids: new Set(Array.from({ length: 0x20 }, (_, k) => 0x1400 + k)) });
    const cancel = (): void => reader.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const units: IgUnit[] = [];
    try {
      for (let pes = await reader.next(); pes !== null; pes = await reader.next()) {
        for (const p of pes) units.push({ pid: p.pid, data: p.payload, ptsUs: pts90ToUs(p.pts ?? 0), dtsUs: p.dts === undefined ? undefined : pts90ToUs(p.dts) });
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (signal.aborted) throw signal.reason;
    return units;
  }

  /** Drops the navigator (and with it the VM and the registers) and releases a hold. */
  private stopNavigator(): void {
    const nav = this.navigator;
    if (!nav) return;
    this.navigator = null;
    this.navRegs = null;
    this.openGeneration++;
    nav.stop();
    if (this.pgRegs) this.bindPg(this.pgRegs);
    this.setHold(false);
    this.updateMenuState(false, false);
    this.deps.emit({ type: 'uoMask', masked: [] });
  }

  /**
   * A title, or the top menu for 0 (a menu call). After a raw playlist pick stopped the program, the navigator is rebuilt
   * and starts the title directly.
   */
  private playTitle(title: number): void {
    const nav = this.navigator;
    if (nav) {
      if (title === 0) nav.menuCall();
      else nav.playTitle(title);
      return;
    }
    const disc = this.disc;
    if (!disc) return;
    const object = title === 0 ? disc.index.topMenu : disc.index.titles[title - 1]?.object;
    if (object?.kind === 'bdj' && this.bdjSupported) {
      this.enterBdj(title, null);
      return;
    }
    if (!disc.movieObjects || (disc.index.firstPlay.kind !== 'hdmv' && !this.bdjSupported)) return;
    this.navigator = this.createNavigator(disc);
    if (!this.navigator.startTitle(title)) this.stopNavigator();
  }

  private menuKey(key: MenuKey, repeat = false): void {
    if (this.bdj) {
      this.bdjUserInput(this.bdj, key === 'topMenu' ? BdVk.ROOT_MENU : MENU_KEY_VK[key], repeat);
      return;
    }
    const nav = this.navigator;
    if (!nav) return;
    const op = MENU_KEY_UO[key] ?? (key === 'popup' ? (this.menuActive && this.popupAvailable ? 'popupOff' : 'popupOn') : undefined);
    if (op && this.refused(op)) return;
    if (key === 'topMenu') this.playTitle(0);
    else nav.userInput(MENU_KEY_VK[key]);
  }

  /**
   * bd_user_input under a BD-J title: the root menu key is a menu call (bd_menu_call, checked against the menu call
   * mask), every other key goes to Java as BDJ_EVENT_VK_KEY, unfiltered by key interest and by the UO mask (libbluray
   * checks neither for BD-J titles at UO restriction RELAXED).
   */
  private bdjUserInput(entry: BdjTitle, vk: number, repeat: boolean): void {
    const input = bdjUserInput(vk, { level: UoRestriction.RELAXED, popupShown: false, isUoMasked: (op) => entry.host.isUoMasked(op) });
    // a held key's repeats are not new presses; the first answer times the press
    if (input.kind !== 'none' && !repeat) this.bdjLatency.input(this.deps.nowMs(), entry.plane.version());
    if (input.kind === 'menuCall') this.bdjPlayTitle(entry, 0);
    else if (input.kind === 'event') entry.session.event(input.ev, input.param, repeat ? 'repeat' : undefined);
  }

  /** Reports the plane turning visible or empty; a newly visible plane is a new menu for the ignored-tap rule. */
  private updateBdjMenu(entry: BdjTitle): void {
    const visible = entry.plane.visible();
    if (visible === entry.menuVisible) return;
    entry.menuVisible = visible;
    if (visible) {
      entry.taps.menuShown();
      entry.session.menuShown(); // a menu on screen is no hang, even with no playlist selected
    }
    this.deps.emit({ type: 'bdjMenu', visible });
  }

  /** A move selects the button under the pointer (bd_mouse_select) and reports it; a click also activates it. */
  private pointer(kind: 'move' | 'click', x: number, y: number): void {
    const px = Math.max(0, Math.min(0xffff, Math.round(x)));
    const py = Math.max(0, Math.min(0xffff, Math.round(y)));
    const entry = this.bdj;
    if (entry) {
      // bd_mouse_select → BDJ_EVENT_MOUSE; a click is then bd_user_input(BD_VK_MOUSE_ACTIVATE)
      entry.session.event(BDJ_EVENT_MOUSE, bdjMouseParam(px, py), kind === 'move' ? 'move' : undefined);
      if (kind === 'move') return;
      this.bdjUserInput(entry, BdVk.MOUSE_ACTIVATE, false);
      this.updateBdjMenu(entry);
      // only a tap on a shown menu can be ignored (the UI sends others only when the plane is empty)
      if (entry.menuVisible) entry.taps.tap(this.memory.bdjTapWindowMs);
      return;
    }
    const nav = this.navigator;
    if (!nav) return;
    // the button under the pointer on the page shown now, before the move or the activation can change the page
    const hit = nav.hitTest(px, py);
    nav.mouseSelect(px, py);
    if (kind === 'move') {
      this.deps.emit({ type: 'pointerTarget', button: hit });
      return;
    }
    nav.userInput(BdVk.MOUSE_ACTIVATE);
    if (hit === null && this.menuActive) this.deps.emit({ type: 'menuTapMissed' }); // the UI shows its controls for a touch that missed (ruling R13)
  }

  private onNavigatorEvent(e: NavigatorEvent): void {
    switch (e.type) {
      case 'uoMask':
        this.deps.emit({ type: 'uoMask', masked: [...e.mask] });
        break;
      case 'menu':
        this.updateMenuState(e.active, this.popupAvailable);
        break;
      case 'popup':
        this.updateMenuState(this.menuActive, e.available);
        break;
      case 'bdjTitle':
        if (this.bdjSupported) this.navigatorToBdj(e.title);
        else this.notice('bdj', this.bdjUnsupported('title'));
        break;
      case 'error':
        // The picker shows an 'error' event's message (PlayerScreen reads snapshot.error) once the session is gone.
        this.stopNavigator();
        this.teardownSession();
        this.deps.emit({ type: 'error', code: 'internal', message: e.message, paths: [] });
        this.setState('idle');
        break;
      case 'sound':
        this.soundsPlayed++;
        this.deps.emit({ type: 'soundEffect', id: e.id });
        break;
      default:
        break; // 'title' is for the menu UI
    }
  }

  /**
   * HDMV → BD-J (the navigator's _play_bdj). libbluray keeps the HDMV VM suspended under title_type bdj; here the
   * navigator is dropped once it has returned and the BD-J title runs on its registers, so GPRs and PSRs carry over. An
   * HDMV title selected later gets a new navigator on the same registers (_play_hdmv selects its movie object afresh).
   */
  private navigatorToBdj(title: number): void {
    const nav = this.navigator;
    this.enqueue(async () => {
      if (!nav || this.navigator !== nav) return;
      const regs = this.navRegs;
      this.stopNavigator();
      this.enterBdj(title, regs);
    });
  }

  private updateMenuState(active: boolean, popupAvailable: boolean): void {
    if (active === this.menuActive && popupAvailable === this.popupAvailable) return;
    this.menuActive = active;
    this.popupAvailable = popupAvailable;
    this.deps.emit({ type: 'menuActive', active, popupAvailable });
  }

  private navigationPort(): PlaybackPort {
    return {
      playPlaylist: (id, at) => this.playPlaylistFor('navigator', id, at),
      seekPlayItem: (item) => this.seekPlayItem(item),
      seekMark: (mark) => this.seekMark(mark),
      stopPlaylist: () => this.stopPlaylist(),
      hold: (on) => this.setHold(on),
      currentClipTime45: () => this.currentClipTime45(),
    };
  }

  /** The port a BD-J title (PlayerBdjHost) drives playback through; it does nothing once `live` turns false. */
  bdjPort(live: () => boolean = () => true): BdjPlaybackPort {
    return {
      playPlaylist: (id, at) => {
        if (!live()) return Promise.resolve(false);
        if (this.bdjStartup && this.bdjStartup.firstPlaylistMs === null) this.bdjStartup.firstPlaylistMs = this.sinceOpenMs();
        return this.playPlaylistFor('bdj', id, at);
      },
      seekPlayItem: (item) => {
        if (live()) this.seekPlayItem(item);
      },
      seekMark: (mark) => {
        if (live()) this.seekMark(mark);
      },
      seekTime45: (t) => {
        const s = this.session;
        if (live() && s && t >= 0 && t < s.timeline.duration45) this.enqueueNavSeek(s, ticks45ToUs(t));
      },
      stopPlaylist: () => {
        if (live()) this.stopPlaylist();
      },
      setRate: (rate) =>
        this.enqueue(async () => {
          // repeated starts are harmless: play() while playing changes nothing
          if (!live() || this.session?.owner !== 'bdj' || this.state === 'ended' || this.state === 'error') return;
          if (rate === 0) this.pause();
          else await this.play();
        }),
      currentClipTime45: () => (live() ? this.currentClipTime45() : undefined),
      playlistOpen: () => live() && this.session !== null,
      playSound: (id) => {
        if (!live()) return;
        this.soundsPlayed++;
        this.deps.emit({ type: 'soundEffect', id });
      },
      setListener: (listener) => {
        if (live()) this.bdjListener = listener;
      },
    };
  }

  /** A playlist the navigator or a BD-J title asked for. */
  private async playPlaylistFor(caller: PlaylistCaller, id: string, at: PlayAt): Promise<boolean> {
    try {
      return await this.playPlaylist(id, at, caller);
    } catch (err) {
      // A clip that cannot be opened or decoded is an invalid playlist to the program (_open_playlist returns 0)
      if (!isMediaError(err)) throw err;
      this.reportError(err);
      if (!this.session) this.setState('idle');
      return false;
    }
  }

  private seekPlayItem(item: number): void {
    const s = this.session;
    if (s && item >= 0 && item < s.timeline.items.length) this.enqueueNavSeek(s, s.timeline.itemStartUs(item));
  }

  private seekMark(mark: number): void {
    const s = this.session;
    if (!s) return;
    try {
      this.enqueueNavSeek(s, s.timeline.markTimeUs(mark));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
    }
  }

  private stopPlaylist(): void {
    this.openGeneration++; // also cancels an open that is still loading
    this.teardownSession();
    this.setState('idle');
  }

  /** _update_time_psr_from_stream: the clip time of the presentation position. */
  private currentClipTime45(): number | undefined {
    return this.session ? this.session.timeline.locate(this.clock.nowUs()).clipTime45 : undefined;
  }

  /** A seek the navigator asked for: the target is applied once the queued commands ran. */
  private enqueueNavSeek(s: Session, timeUs: number): void {
    this.navSeeksPending++;
    this.enqueue(async () => {
      try {
        if (this.session === s) await this.startAt(timeUs, this.wantPlaying);
      } finally {
        this.navSeeksPending--;
      }
    });
  }

  /** A user seek: libbluray's _seek_internal updates the chapter PSR for the packet the target time maps to. */
  private notifySeeked(targetUs: number): void {
    const s = this.session;
    const bdj = s?.owner === 'bdj' ? this.bdjListener : null;
    if (!s || (!this.navigator && !bdj)) return;
    const t = Math.min(Math.max(0, targetUs), Math.max(0, s.timeline.durationUs - 1));
    const at = s.timeline.locate(t);
    if (bdj) bdj.seeked(at.item.index, at.clipTime45);
    else this.navigator?.seeked(at.item.index, at.clipTime45);
  }

  /** Runs `work` after the queued commands, reporting a failure like a command's. */
  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      try {
        await work();
      } catch (err) {
        this.fail(err);
      }
    });
  }

  private setHold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    if (on) {
      this.ring?.setPlaying(false);
      this.clock.setRunning(false);
    } else if (this.state === 'playing') {
      const ring = this.session?.audioActive ? this.ring : null;
      if (ring) {
        ring.setPlaying(true);
        this.lastHeartbeat = ring.heartbeat();
        this.lastHeartbeatChangeMs = this.deps.nowMs();
      } else {
        this.clock.setRunning(true);
      }
    }
  }

  /** PSR1 (primary audio stream) selects the audio: the registers are the single source of the selection. */
  private onPsrEvent(e: PsrEvent, regs: RegisterFile): void {
    if (e.type !== 'change' || e.psr !== PSR.PRIMARY_AUDIO_ID || regs !== this.programRegs) return;
    const index = regs.psrRead(PSR.PRIMARY_AUDIO_ID) & 0xfff;
    this.enqueue(() => this.applyAudio(index));
  }

  /** Presentation follows the clock: tell the navigator about item and chapter changes and about the end of a still item. */
  private syncNavigator(s: Session): void {
    if (s.owner === 'bdj') {
      this.syncBdj(s);
      return;
    }
    const nav = this.navigator;
    if (!nav || (this.state !== 'playing' && this.state !== 'paused') || this.held) return;
    const now = this.clock.nowUs();
    const { item } = s.timeline.locate(now);
    if (item.index !== this.navItem) {
      this.navItem = item.index;
      this.navEndReported = null;
      nav.playItemChanged(item.index);
    }
    // _playmark_reached: every mark passed since the last look, ENTRY or LINK, is one chapter PSR update
    let marksReached = false;
    // not while a seek of the navigator is still queued: the old position would report marks the program has left behind
    while (this.navSeeksPending === 0 && this.navNextMark >= 0 && now > s.timeline.markTimeUs(this.navNextMark)) {
      marksReached = true;
      this.navNextMark = this.navNextMark + 1 < s.timeline.markCount ? this.navNextMark + 1 : -1;
    }
    if (marksReached) {
      const clipTime45 = s.timeline.locate(now).clipTime45;
      nav.markReached(item.index, lookupSpn(this.disc?.clips.get(s.playItems[item.index]!.clipId), clipTime45, true));
    }
    const stillMode = s.playItems[item.index]?.stillMode ?? 0;
    if (this.state === 'playing' && stillMode !== 0 && this.navEndReported !== item.index && now >= s.timeline.itemStartUs(item.index) + ticks45ToUs(item.outTime - item.inTime) - STILL_MARGIN_US) {
      this.navEndReported = item.index;
      nav.playItemEnded(item.index);
    }
  }

  /** syncNavigator for a BD-J title: item changes, the marks passed and the position (bd_set_scr), and play-item stills. */
  private syncBdj(s: Session): void {
    const listener = this.bdjListener;
    if (!listener || (this.state !== 'playing' && this.state !== 'paused')) return;
    const still = this.bdjStill;
    if (still) {
      // a time still ends as a player's bd_read_skip_still after BD_EVENT_STILL_TIME ends it: on into the next item
      if (still.untilMs === null || this.deps.nowMs() < still.untilMs) return;
      this.releaseBdjStill();
    }
    if (this.held) return;
    const now = this.clock.nowUs();
    const { item, clipTime45 } = s.timeline.locate(now);
    if (item.index !== this.navItem) {
      this.navItem = item.index;
      this.navEndReported = null;
      listener.playItemChanged(item.index);
    }
    const marks: number[] = [];
    while (this.navSeeksPending === 0 && this.navNextMark >= 0 && now > s.timeline.markTimeUs(this.navNextMark)) {
      marks.push(this.navNextMark);
      this.navNextMark = this.navNextMark + 1 < s.timeline.markCount ? this.navNextMark + 1 : -1;
    }
    if (marks.length > 0) listener.marksReached(marks, item.index, lookupSpn(this.disc?.clips.get(s.playItems[item.index]!.clipId), clipTime45, true));
    if (this.navSeeksPending === 0) listener.position(item.index, clipTime45); // not the old position while a seek is queued
    // _bd_read_locked: at the end of a still play item the read stops (BD_EVENT_STILL_TIME), under BD-J as under HDMV
    const pi = s.playItems[item.index];
    if (this.state === 'playing' && pi && pi.stillMode !== 0 && this.navEndReported !== item.index && now >= s.timeline.itemStartUs(item.index) + ticks45ToUs(item.outTime - item.inTime) - STILL_MARGIN_US) {
      this.navEndReported = item.index;
      // the time still's timer runs on wall time (nowMs): libbluray leaves it to the application (BD_EVENT_STILL_TIME)
      this.bdjStill = { item: item.index, untilMs: pi.stillMode === STILL_TIME ? this.deps.nowMs() + pi.stillTime * 1000 : null };
      this.setHold(true);
    }
  }

  private releaseBdjStill(): void {
    if (!this.bdjStill) return;
    this.bdjStill = null;
    this.setHold(false);
  }

  /**
   * _find_next_playmark at read position `sPos` (title packets): the first mark whose packet lies after it. Marks are
   * then reached by time (syncNavigator, syncBdj).
   */
  private nextMarkAt(mpls: Mpls, sPos: number): number {
    return nextPlaymark(sPos, mpls.marks, mpls.playItems, this.disc?.clips);
  }

  /** s_pos after _seek_internal to playlist time `timeUs`: the title packet of the EP map entry at or before it. */
  private titlePktAt(timeline: Timeline, playItems: readonly PlayItem[], timeUs: number): number {
    const clips = this.disc?.clips;
    const { item, clipTime45 } = timeline.locate(timeUs);
    const geometry = itemPackets(playItems, clips)[item.index]!;
    const clip = clips?.get(playItems[item.index]!.clipId);
    return geometry.titlePkt + (clip ? lookupSpn(clip, clipTime45, true) - geometry.startPkt : 0);
  }

  /**
   * s_pos once a playlist opened at `at` (_open_playlist, then bd_seek_playitem / bd_seek_mark / bd_seek): 0 at its
   * start, an item's title_pkt, a mark's, or the packet of a time.
   */
  private openTitlePkt(mpls: Mpls, timeline: Timeline, at: PlayAt, startUs: number): number {
    const clips = this.disc?.clips;
    if (at.item !== undefined && at.item >= 0 && at.item < timeline.items.length) {
      if (at.clipTime45 !== undefined) return this.titlePktAt(timeline, mpls.playItems, startUs);
      return itemPackets(mpls.playItems, clips)[at.item]!.titlePkt;
    }
    if (at.mark !== undefined && at.mark >= 0 && at.mark < mpls.marks.length) {
      return markTitlePkt(mpls.marks[at.mark]!, itemPackets(mpls.playItems, clips), mpls.playItems, clips);
    }
    return 0;
  }

  /**
   * `caller`: the navigator or a BD-J title asked for it. Then the result says whether the playlist exists, and the
   * program is told of the start (playlistStarted) synchronously, before the first await. A BD-J title's playlist opens
   * paused until Java starts it (bdj_wait_start). `audio`: the audio stream to play when it names a playable one (a
   * place's PSR1), over the program's PSR1. `restart`: the playlist that plays starts again on another version of the
   * disc (setLevel): the program is not told of a start, mark tracking goes on, and it plays only when it was playing.
   */
  private async playPlaylist(
    playlistId: string,
    at: PlayAt = {},
    caller: PlaylistCaller = 'user',
    audio: number | null = null,
    restart: { readonly autoplay: boolean; readonly endReported: number | null } | null = null,
  ): Promise<boolean> {
    const viaNavigator = caller !== 'user';
    let source = this.source;
    let mpls = this.disc?.playlists.get(playlistId);
    if (!source || !mpls || mpls.playItems.length === 0) {
      if (viaNavigator) return false;
      throw new DiscError('missing-file', `Playlist ${playlistId} is not available.`, [playlistPath(playlistId)]);
    }
    const generation = ++this.openGeneration;
    this.teardownSession();
    const timeline = new Timeline(mpls.playItems, mpls.marks);
    const startUs = this.startTimeUs(timeline, at);
    const chapters = timeline.chapters(mpls.marks);
    const startItem = at.item !== undefined && at.item >= 0 && at.item < timeline.items.length ? at.item : timeline.locate(startUs).item.index;
    // a restart goes on where presentation was: the end of a still item already reported is not reported again
    this.navEndReported = restart ? restart.endReported : null;
    this.releaseBdjStill();
    const openPkt = this.openTitlePkt(mpls, timeline, at, startUs);
    if (!restart) {
      this.navItem = startItem;
      this.navNextMark = this.nextMarkAt(mpls, openPkt);
      if (caller === 'navigator' && this.navigator) this.navigator.playlistStarted(playlistId, startItem);
      if (caller === 'bdj') this.bdjListener?.playlistStarted(playlistId, startItem);
    }
    this.setState('loading');
    const clipIds = [...new Set(mpls.playItems.map((p) => p.clipId))];
    let clips: Awaited<ReturnType<typeof loadClips>>;
    let version = this.levelVersion;
    for (;;) {
      let loaded: typeof clips | null = null;
      let failure: unknown = null;
      try {
        loaded = await loadClips(source, clipIds);
        await checkStreamReadable(source, clipIds[0]);
      } catch (err) {
        failure = err;
      }
      if (version === this.levelVersion && !this.switching && source === this.source) {
        if (failure !== null || !loaded) throw failure;
        clips = loaded;
        break;
      }
      // setLevel replaced the disc's version under this open: it goes on, on the new version, once that is in place
      // (a stale open, superseded meanwhile, gives up)
      while (this.switching) await this.switching;
      if (generation !== this.openGeneration) return true;
      const nextSource = this.source;
      const nextMpls = this.disc?.playlists.get(playlistId);
      if (!nextSource || !nextMpls) return true; // the switch failed: the disc closed
      source = nextSource;
      mpls = nextMpls;
      version = this.levelVersion;
    }
    if (generation !== this.openGeneration) return true; // superseded while loading

    const choice = chooseStreams(mpls.playItems[0].stn);
    if (!choice.video) {
      this.deps.emit({ type: 'error', code: 'no-video', message: 'This playlist has no video stream.', paths: [] });
      if (viaNavigator) return false;
      this.setState('error');
      return true;
    }
    if (!choice.audio && choice.unsupportedAudio.length > 0) {
      const codec = [...new Set(choice.unsupportedAudio.map((a) => codingName(a.codingType)))].join(', ');
      this.deps.emit({ type: 'unsupported', kind: 'audio', codec, message: `This playlist's audio (${codec}) can't be played yet, so video will play without sound.` });
    }
    // libbluray opens a playlist whatever its video: one the browser can't decode plays without a picture (audio,
    // subtitles, menus and the clock run), with a notice once per disc. With nothing else playable either it still plays,
    // silent black, as libbluray does (R12); UnsupportedCodecError stays for a decoder whose configuration fails.
    const picture = isSupportedVideoCoding(choice.video.codingType);
    // With a disc program (HDMV or BD-J) the audio stream register (PSR1) decides, when it names a playable stream
    let audioIndex = choice.audioIndex;
    let audioEntry = choice.audio;
    // a first item with no audio at all (a silent opening) takes the stream of the first item that has a playable one:
    // the items without it play silence on the audio clock (audioItemStarted)
    let audioItem = mpls.playItems[0];
    if (!audioEntry && choice.unsupportedAudio.length === 0) {
      for (const item of mpls.playItems) {
        const later = chooseStreams(item.stn);
        if (later.audio) {
          audioIndex = later.audioIndex;
          audioEntry = later.audio;
          audioItem = item;
          break;
        }
        if (later.unsupportedAudio.length > 0) break;
      }
    }
    const wanted = (audio ?? this.programRegs?.psrRead(PSR.PRIMARY_AUDIO_ID) ?? 0) & 0xfff;
    const wantedEntry = wanted > 0 ? audioEntryFor(mpls.playItems[startItem], wanted) : null;
    if (wantedEntry && PLAYABLE_AUDIO.has(wantedEntry.codingType)) {
      audioIndex = wanted;
      audioEntry = wantedEntry;
    }
    // without a program the private registers keep the stream that plays, which a saved place reads (readPlace)
    if (!this.programRegs && audioIndex !== null) this.pgRegs?.psrWrite(PSR.PRIMARY_AUDIO_ID, audioIndex);
    const audioActive = audioEntry !== null && this.ring !== null;
    if (audioEntry && !this.ring) this.notice('audio-disabled', 'Audio output is not available, so video will play without sound.');

    const decoder = picture ? new WebCodecsVideoDecoder(this.deps.videoCodecApi) : null;
    const ref: { current: Session | null } = { current: null };
    const delivered = (ptsUs: number): void => {
      if (ref.current && ptsUs > ref.current.deliveredEndUs) ref.current.deliveredEndUs = ptsUs;
    };
    const pipeline = new PlaybackPipeline(
      { source, timeline, clips, videoPid: choice.video.pid, readVideo: picture, playItems: mpls.playItems, audioStream: audioActive ? audioIndex : null, igStream: this.igStreamNumber() },
      {
        video: (u) => {
          if (ref.current && u.inRange && u.ptsUs > ref.current.videoReadUs) ref.current.videoReadUs = u.ptsUs;
          if (ref.current) this.onVideoUnit(ref.current, u);
        },
        audio: (u) => {
          delivered(u.ptsUs);
          if (ref.current && u.ptsUs > ref.current.audioReadUs) ref.current.audioReadUs = u.ptsUs;
          if (ref.current) this.onAudioUnit(ref.current, u);
        },
        ig: (u) => {
          delivered(u.ptsUs);
          // units of a superseded session or a torn-down navigator are dropped
          if (ref.current && ref.current === this.session) this.navigator?.pushIg(u);
        },
        pg: (u) => {
          delivered(u.ptsUs);
          // outside the play item's IN/OUT time PG is filtered out, as libbluray's m2ts_filter does
          if (ref.current && ref.current === this.session && u.inRange) this.pg?.push(u);
        },
        itemStarted: (index, startUs) => {
          if (ref.current) this.audioItemStarted(ref.current, index);
          if (ref.current) this.pgItemStarted(ref.current, index, startUs);
        },
        isFull: () => ref.current !== null && this.isFull(ref.current),
        ended: () => {
          if (ref.current) this.onPipelineEnded(ref.current);
        },
        failed: (err) => {
          if (ref.current && ref.current === this.session) this.fail(err);
        },
      },
    );
    const session: Session = {
      playlistId,
      owner: caller,
      timeline,
      chapters,
      tracks: audioTracks((mpls.playItems[startItem].stn.audio.length > 0 ? mpls.playItems[startItem] : audioItem).stn),
      videoCodingType: choice.video.codingType,
      decoder,
      pipeline,
      playItems: mpls.playItems,
      audioStream: audioIndex,
      audioDecoders: new Map(),
      audioDecoderLoads: new Map(),
      audioErrorsInRow: 0,
      failedAudioTypes: new Set(),
      audioErrorDisabled: false,
      audioActive,
      decimator: null,
      videoState: 'unconfigured',
      pendingVideo: [],
      dropBeforeUs: 0,
      audioReadUs: -Infinity,
      videoReadUs: -Infinity,
      deliveredEndUs: -Infinity,
      readEndUs: -Infinity,
      blankComposited: false,
      eof: false,
      flushed: false,
      flushStarted: false,
      audioStalledBeat: null,
      audioRecoveryQueued: false,
    };
    ref.current = session;
    if (decoder) {
      decoder.onOutput = (frame) => {
        if (this.session === session) {
          this.codedWidth = frame.codedWidth;
          this.presenter.push(frame);
        }
        else frame.close();
      };
      decoder.onError = (err) => this.onDecoderError(session, err);
    }
    this.session = session;
    this.audioDecodeErrors = 0;
    this.audioCodec = null;
    this.sentPgTracks = '';
    this.compositor?.startPlaylist?.(picture);
    // the disc's no-picture notice, only for a playlist that opened (one that failed to open does not use it up)
    if (!picture && this.noPictureNotice === 'unsent') {
      this.noPictureNotice = 'shown';
      this.deps.emit({ type: 'unsupported', kind: 'video', codec: codingName(choice.video.codingType), message: NO_PICTURE_MESSAGE, noPicture: true });
    } else if (picture && this.noPictureNotice === 'shown') {
      this.noPictureNotice = 'cleared'; // the picture is back: the notice goes, and this disc does not show it again
      this.deps.emit({ type: 'noticeCleared', code: 'no-picture' });
    }
    this.deps.emit({ type: 'chapters', playlistId, durationUs: timeline.durationUs, chapters: session.chapters });
    this.emitTracks(session);
    if (restart) await this.startAt(startUs, restart.autoplay, 'keep');
    else await this.startAt(startUs, caller !== 'bdj', openPkt);
    return true;
  }

  /** PG follows PSR2 of `regs`: the navigator's, or the disc's private registers when there is no navigator. */
  private bindPg(regs: RegisterFile): void {
    this.stopPg();
    this.pg = new PgStreamControl({
      regs,
      isMasked: (op) => this.navigator?.isMasked(op) ?? false,
      pidChanged: () => {
        // like an audio switch: re-read from now with the new PID, so the current subtitle shows without waiting for the next
        const s = this.session;
        if (s) this.enqueue(async () => {
          if (this.session === s) await this.startAt(this.clock.nowUs(), this.wantPlaying, 'keep');
        });
      },
    });
    this.unsubscribePg = regs.onPsrEvent((e) => {
      if (e.type !== 'change' || e.psr !== PSR.PG_STREAM) return;
      // one subtitle choice at a time: the disc program turning a PG stream on hides the text track
      if (this.textOn && (e.newValue & 0x80000000) !== 0) {
        this.textOn = false;
        this.subtitlesDirty = true;
      }
      this.emitSubtitles();
    });
  }

  private stopPg(): void {
    this.unsubscribePg?.();
    this.unsubscribePg = null;
    this.pg?.stop();
    this.pg = null;
  }

  /** The reader opened a play item: _init_pg_stream, the PID for this item, and the track list when it changed. */
  private pgItemStarted(s: Session, index: number, startUs: number): void {
    const pg = this.pg;
    const item = s.playItems[index];
    if (!pg || !item || this.session !== s) return;
    pg.playItemStarted(item, this.programRegs === null, startUs);
    s.pipeline.setPgStream(pg.pid);
    if (JSON.stringify(pg.tracks()) !== this.sentPgTracks) this.emitSubtitles();
  }

  /**
   * One choice at a time: a PG stream (the text track hides), the text track (PG's display flag clears, so forced captions
   * stay), or Off. A change the disc's UO mask refuses changes nothing.
   */
  private selectSubtitle(choice: SubtitleChoice): void {
    const pg = this.pg;
    if (choice.kind === 'text') {
      if (!this.textTrack) return;
      if (pg && !pg.select('off')) this.notice('uo-masked', UO_MASKED_MESSAGE);
      else this.textOn = true;
    } else if (choice.kind === 'pg') {
      if (pg?.select({ pg: choice.stream })) this.textOn = false;
      else if (pg?.tracks().some((t) => t.index === choice.stream)) this.notice('uo-masked', UO_MASKED_MESSAGE);
    } else if (!pg || pg.select('off')) {
      this.textOn = false;
    } else {
      this.notice('uo-masked', UO_MASKED_MESSAGE);
    }
    this.subtitlesChanged();
  }

  private assDepsOnce(): Promise<AssDeps> | null {
    if (!this.deps.createAssDeps) return null;
    this.assDeps ??= this.deps.createAssDeps();
    return this.assDeps;
  }

  /** Every family a script names (styles and \fn), matched so its faces load before the first frame. */
  private static resolveFamilies(fonts: AssFonts, tracks: readonly AssTrack[]): void {
    for (const t of tracks) {
      // the styles events use, by their Style field or a \r tag (libass's built-in Default is often unused)
      const used = new Set(t.events.map((e) => e.style));
      for (const e of t.events) for (const m of e.text.matchAll(/\\r([^\\}]+)/g)) t.styles.forEach((st, i) => { if (st.name === m[1]) used.add(i); });
      for (const st of t.styles.filter((_, i) => used.has(i))) {
        const family = st.fontName.replace(/^@/, '');
        fonts.resolve({ family, bold: st.bold ? 700 : 400, italic: st.italic ? 100 : 0, vertical: st.fontName.startsWith('@') });
      }
      for (const e of t.events) {
        for (const m of e.text.matchAll(/\\fn([^\\}]*)/g)) {
          const name = m[1]!.trim();
          if (name && name !== '0') fonts.resolve({ family: name.replace(/^@/, ''), bold: 400, italic: 0, vertical: name.startsWith('@') });
        }
      }
    }
  }

  /**
   * Loads a subtitle set: decodes every file (one encoding prompt for the load), parses SRT or ASS, loads the
   * fonts the ASS files name, places the files on the current playlist and selects the text track.
   */
  private async addTextSubtitles(files: readonly FileData[], encoding: string | undefined, fontFiles: readonly FileData[]): Promise<void> {
    if (!this.disc) return;
    const generation = ++this.textLoadGeneration;
    const decoded: { name: string; text: string }[] = [];
    const needsEncoding: string[] = [];
    for (const f of files) {
      const d = decodeText(new Uint8Array(f.bytes), encoding);
      if ('needsEncoding' in d) needsEncoding.push(f.name);
      else decoded.push({ name: f.name, text: d.text });
    }
    if (needsEncoding.length) {
      this.deps.emit({ type: 'subtitleEncodingNeeded', names: needsEncoding });
      return;
    }
    const parsed: ({ name: string; format: 'srt'; cues: ReturnType<typeof parseSrt>['cues'] } | { name: string; format: 'ass'; track: AssTrack })[] = [];
    for (const { name, text } of decoded) {
      if (looksLikeAss(text)) {
        const track = parseAss(text);
        if (track.trackType === 'unknown' || track.events.length === 0) {
          this.notice('subtitle-file', `${name}: ${NO_SUBTITLES_MESSAGE}`);
          continue;
        }
        if (track.skippedLines * 2 > track.eventLines) this.notice('subtitle-file', SOME_SUBTITLES_MESSAGE);
        parsed.push({ name, format: 'ass', track });
      } else {
        const srt = parseSrt(text);
        if (srt.cues.length === 0) {
          this.notice('subtitle-file', `${name}: ${NO_SUBTITLES_MESSAGE}`);
          continue;
        }
        if (srt.skipped * 2 > srt.blocks) this.notice('subtitle-file', SOME_SUBTITLES_MESSAGE);
        parsed.push({ name, format: 'srt', cues: srt.cues });
      }
    }
    if (!parsed.length) return;

    const assTracks = parsed.flatMap((p) => (p.format === 'ass' ? [p.track] : []));
    let fonts: AssFonts | null = null;
    let deps: AssDeps | null = null;
    let unreadable: readonly string[] = [];
    if (assTracks.length) {
      const pending = this.assDepsOnce();
      if (!pending) return;
      deps = await pending;
      if (generation !== this.textLoadGeneration) return;
      fonts = new AssFonts(deps.loader, deps.defaultFont);
      // libass registers a script's [Fonts] before other fonts
      await fonts.add(assTracks.flatMap((t) => t.fonts));
      unreadable = (await fonts.add(fontFiles.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) })))).unreadable;
      Player.resolveFamilies(fonts, assTracks);
      await fonts.ready();
      if (generation !== this.textLoadGeneration || !this.disc) {
        fonts.dispose();
        return;
      }
    }

    const setFiles = sortByName(parsed.map((p): SetFile<TextRendererLike> => (p.format === 'srt'
      ? { name: p.name, format: 'srt', cues: p.cues.length, renderer: new TextSubtitleRenderer(p.cues) }
      : {
        name: p.name, format: 'ass', cues: p.track.events.length,
        renderer: new AssRenderer(p.track, fonts!, {
          measurer: deps!.measurer, createCanvas: deps!.createCanvas, nowMs: () => this.deps.nowMs(), Path2D: deps!.Path2D,
          colorMatrix: 'video', limits: this.memory, canvasFilter: deps!.canvasFilter, ...(deps!.warp ? { warp: deps!.warp } : {}),
        }),
      })));
    this.dropTextTrack();
    this.textTrack = { files: setFiles, renderer: new TextSetRenderer(new TextSet(setFiles)), fonts, assTracks, placedFor: null };
    this.placeTextFiles();
    if (unreadable.length) this.notice('subtitle-fonts', `Some font files could not be read: ${unreadable.join(', ')}`);
    const missing = fonts?.missingFamilies() ?? [];
    if (missing.length) this.notice('subtitle-fonts', `Some fonts are missing and were replaced: ${missing.join(', ')}`);
    this.selectSubtitle({ kind: 'text' });
  }

  /** More fonts for the set's ASS files: matched again, loaded, and the ASS files laid out again. */
  private async addSubtitleFonts(fontFiles: readonly FileData[]): Promise<void> {
    const track = this.textTrack;
    if (!track?.fonts) return;
    const generation = this.textLoadGeneration;
    const { unreadable } = await track.fonts.add(fontFiles.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) })));
    Player.resolveFamilies(track.fonts, track.assTracks);
    await track.fonts.ready();
    if (generation !== this.textLoadGeneration || this.textTrack !== track) return;
    for (const f of track.files) if (f.renderer instanceof AssRenderer) f.renderer.fontsChanged();
    if (unreadable.length) this.notice('subtitle-fonts', `Some font files could not be read: ${unreadable.join(', ')}`);
    this.subtitlesChanged();
  }

  /** Placements for the playing playlist: remembered ones, or by its episode starts (a notice when that fails). */
  private placeTextFiles(): void {
    const track = this.textTrack;
    const s = this.session;
    if (!track || !s || track.placedFor === s.playlistId) return;
    track.placedFor = s.playlistId;
    const { placed } = track.renderer.set.usePlaylist(s.playlistId, this.episodeStartsOf(s));
    if (!placed) this.notice('subtitle-file', PLACE_FILES_MESSAGE);
  }

  private episodeStartsOf(s: Session): number[] {
    return episodeStarts(s.timeline.items.map((i) => ({ startUs: ticks45ToUs(i.start), durationUs: ticks45ToUs(i.outTime - i.inTime) })));
  }

  private dropTextTrack(): void {
    this.textTrack?.fonts?.dispose();
    this.textTrack = null;
  }

  /** Forgets the text track and its settings (the disc it belongs to is closing). */
  private resetTextSubtitles(): void {
    this.textLoadGeneration++;
    this.dropTextTrack();
    this.textOn = false;
    this.textScale = 1;
    this.subtitlesDirty = true;
  }

  /** Offsets are per file in the set, which applies them. */
  private textOptions(): TextRenderOptions {
    return { offsetUs: 0, scale: this.textScale };
  }

  private subtitlesChanged(): void {
    this.subtitlesDirty = true;
    this.emitSubtitles();
  }

  private emitSubtitles(): void {
    const pg = this.pg;
    const tracks = pg?.tracks() ?? [];
    this.sentPgTracks = JSON.stringify(tracks);
    const { stream, display } = pg?.selection ?? { stream: 0, display: false };
    this.placeTextFiles();
    const track = this.textTrack;
    const placements = track?.renderer.set.placements() ?? [];
    this.deps.emit({
      type: 'subtitles',
      pg: tracks,
      text: track
        ? {
          files: track.files.map((f, i) => ({ name: f.name, format: f.format, cues: f.cues, startUs: placements[i]?.startUs ?? null, offsetMs: placements[i]?.offsetMs ?? 0 })),
          missingFonts: track.fonts?.missingFamilies() ?? [],
          episodeStarts: this.session ? this.episodeStartsOf(this.session) : [],
        }
        : null,
      selected: this.textOn && track ? 'text' : display && stream > 0 ? { pg: stream } : 'off',
      scale: this.textScale,
    });
  }

  /** PSR0, the IG stream number, with a navigator; discs without one show no menus. */
  private igStreamNumber(): number | null {
    const n = this.navRegs?.psrRead(PSR.IG_STREAM_ID) ?? 0;
    return n > 0 ? n : null;
  }

  private startTimeUs(timeline: Timeline, at: PlayAt): number {
    if (at.item !== undefined && at.item >= 0 && at.item < timeline.items.length) {
      const item = timeline.items[at.item]!;
      if (at.clipTime45 === undefined) return timeline.itemStartUs(at.item);
      const offset = Math.min(Math.max(0, at.clipTime45 - item.inTime), item.outTime - item.inTime);
      return ticks45ToUs(item.start + offset);
    }
    if (at.mark !== undefined) {
      try {
        return timeline.markTimeUs(at.mark);
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
      }
    }
    return 0;
  }

  private teardownSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.codedWidth = 0;
    this.releaseBdjStill();
    this.deps.emit({ type: 'playlistCleared' });
    this.seekGeneration++;
    s.pipeline.stop();
    this.pg?.seek();
    s.decoder?.close();
    for (const d of s.audioDecoders.values()) d.close();
    s.audioDecoders.clear();
    this.presenter.clear();
    this.ring?.setPlaying(false);
    this.compositor?.drawVideo(null);
    this.bdjDirty = true;
    this.wantPlaying = false;
  }

  private emitTracks(s: Session): void {
    this.deps.emit({ type: 'tracks', audio: s.tracks, selectedAudio: s.audioStream });
  }

  /** Switching is a re-seek to the current time with the new stream (a brief video refill). */
  private async selectAudio(index: number): Promise<void> {
    const regs = this.programRegs;
    const s = this.session;
    if (regs) {
      // The register change selects (applyAudio); a masked primaryAudioChange refuses the user's request
      if (this.refused('primaryAudioChange') || !s?.tracks.find((t) => t.index === index)?.playable) return;
      regs.psrWrite(PSR.PRIMARY_AUDIO_ID, index);
      await this.applyAudio(index); // the register event queued the same switch behind this command: it finds nothing to do
      return;
    }
    await this.applyAudio(index);
  }

  private async applyAudio(index: number): Promise<void> {
    const s = this.session;
    if (!s || index === s.audioStream || this.state === 'error') return;
    const track = s.tracks.find((t) => t.index === index);
    if (!track && !this.missingAudioLogged.has(index)) {
      // a PSR1 the playlist's STN lacks (a quality level carries one track): ignored
      this.missingAudioLogged.add(index);
      this.deps.log?.(`Playlist ${s.playlistId} has no audio stream ${index}: ignored`);
    }
    if (!track?.playable) return;
    s.audioStream = index;
    if (!this.programRegs) this.pgRegs?.psrWrite(PSR.PRIMARY_AUDIO_ID, index);
    s.audioActive = this.ring !== null;
    s.audioErrorDisabled = false;
    s.audioStalledBeat = null;
    this.emitTracks(s);
    await this.startAt(this.clock.nowUs(), this.wantPlaying, 'keep');
  }

  /**
   * Restarts presentation at `targetUs`. `marks`: where mark tracking resumes (_find_next_playmark): by default from the
   * target's packet (a seek), from the given title packet (a playlist open), or `keep` for a re-read at the current
   * position that libbluray never makes (an audio or subtitle switch, an audio rebase).
   */
  private async startAt(targetUs: number, autoplay: boolean, marks?: number | 'keep'): Promise<void> {
    const s = this.session;
    if (!s) return;
    const gen = ++this.seekGeneration;
    if (marks !== 'keep' || this.bdjStill) {
      // a re-read at the current position (an audio or subtitle switch, a level's restart) is no seek: the end of a
      // still item reported stays reported. A BD-J still is let go (its release needs the playing state) and met again.
      this.navEndReported = null;
      this.releaseBdjStill();
    }
    const t = Math.min(Math.max(0, targetUs), Math.max(0, s.timeline.durationUs - 1));
    if (marks !== 'keep') {
      const mpls = this.disc?.playlists.get(s.playlistId);
      this.navNextMark = mpls ? this.nextMarkAt(mpls, marks ?? this.titlePktAt(s.timeline, s.playItems, t)) : -1;
    }
    s.pipeline.stop();
    this.navigator?.seekGraphics(); // queued units from the old read position are dropped; the menu stays
    this.pg?.seek(); // GC_CTRL_PG_RESET in _seek_internal: the subtitle on screen goes
    if (s.videoState === 'configured') s.decoder?.reset();
    s.pendingVideo = [];
    s.audioReadUs = -Infinity;
    s.videoReadUs = -Infinity;
    s.deliveredEndUs = -Infinity;
    s.readEndUs = -Infinity;
    s.decimator?.reset();
    s.eof = false;
    s.flushed = false;
    s.flushStarted = false;
    if (this.audioRecovered(s)) {
      s.audioActive = true;
      s.audioStalledBeat = null;
    }
    s.audioRecoveryQueued = false;
    if (s.audioErrorDisabled && this.ring) {
      s.audioActive = true;
      s.audioErrorDisabled = false;
    }
    s.audioErrorsInRow = 0;
    s.failedAudioTypes.clear();
    for (const d of s.audioDecoders.values()) d.reset();
    // at a target in an item without the stream, the decoder of the next item that has it loads now, as it would here
    const audioType = s.audioActive ? (this.audioCodingTypeAt(s, t) ?? this.nextAudioCodingType(s, t)) : null;
    if (audioType !== null) {
      // The decoder may take a while to load (first WASM compile): stop the old audio and clock and show buffering meanwhile.
      // The clock holds at the target, as libbluray's position moves at once in _seek_internal and _open_playlist: ticks
      // meanwhile (paused, as a BD-J playlist opens) must not report marks or a position of the old place or playlist.
      this.wantPlaying = false;
      this.setState(autoplay ? 'buffering' : 'paused');
      this.presenter.clear();
      this.ring?.setPlaying(false);
      this.clock.useWall(t, false);
      try {
        await this.loadAudioDecoder(s, audioType);
      } catch (err) {
        if (gen !== this.seekGeneration) return;
        this.audioUnavailable(s, audioType, err);
      }
      if (gen !== this.seekGeneration) return;
    }
    s.dropBeforeUs = t - SEEK_TOLERANCE_US;
    this.presenter.clear();
    this.offsets = [];
    this.wantPlaying = autoplay;
    this.setState(autoplay ? 'buffering' : 'paused');

    const ring = this.ring;
    if (s.audioActive && ring && this.audioWriter) {
      ring.setPlaying(false);
      this.clock.useWall(t, false); // the target meanwhile, not the ring's old position (as above)
      await ring.requestDiscard();
      if (gen !== this.seekGeneration) return;
      this.clock.useAudio(ring, t);
      this.audioWriter.start(t);
    } else {
      this.clock.useWall(t, false);
    }
    this.emitTime(t, true);
    s.pipeline.setAudioStream(s.audioActive ? s.audioStream : null);
    s.pipeline.setIgStream(this.igStreamNumber());
    s.pipeline.start(t);
    this.kickFill(true); // a seek outside what the cache holds restarts the fill there
  }

  private async play(): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (this.state === 'ended') {
      await this.startAt(0, true);
      return;
    }
    if (this.state === 'paused' && this.audioRecovered(s)) {
      await this.startAt(this.clock.nowUs(), true, 'keep'); // rebase onto the recovered audio output
      return;
    }
    this.wantPlaying = true;
    // during a still the read is stopped on purpose (_bd_read_locked returns nothing): playing, with the output held
    // until the still ends, not buffering for data that never comes
    if (this.state === 'paused') this.setState(this.held ? 'playing' : 'buffering');
  }

  /** Audio was disabled by a stalled output that has since started running again. */
  private audioRecovered(s: Session): boolean {
    return s.audioStalledBeat !== null && this.ring !== null && this.ring.heartbeat() !== s.audioStalledBeat;
  }

  private close(): void {
    this.stopBdj();
    this.dropEarlyBdj();
    this.stopNavigator();
    this.teardownSession();
    this.stopPg();
    this.pgRegs = null;
    this.resetTextSubtitles();
    this.emitSubtitles();
    this.dropRemote();
    this.source = null;
    this.disc = null;
    this.setState('idle');
  }

  private pause(): void {
    if (!this.session) return;
    this.wantPlaying = false;
    this.ring?.setPlaying(false);
    this.clock.setRunning(false);
    // the stopped clock's exact time goes out before the state, so a place saved at the pause doesn't trail it
    this.emitTime(Math.min(this.clock.nowUs(), this.session.timeline.durationUs), true);
    if (this.state === 'playing' || this.state === 'buffering') this.setState('paused');
  }

  private async skipChapter(direction: 1 | -1): Promise<void> {
    const s = this.session;
    if (!s || s.chapters.length === 0) return;
    const now = this.clock.nowUs();
    let target: number | undefined;
    if (direction > 0) {
      target = s.chapters.find((c) => c.startUs > now + NEXT_CHAPTER_GUARD_US)?.startUs;
    } else {
      target = [...s.chapters].reverse().find((c) => c.startUs < now - PREV_CHAPTER_RESTART_US)?.startUs ?? 0;
    }
    if (target !== undefined) {
      this.notifySeeked(target);
      await this.startAt(target, this.wantPlaying);
    }
  }

  private onVideoUnit(s: Session, u: PipelineUnit): void {
    const decoder = s.decoder;
    if (!decoder) return; // no picture: the pipeline does not read the video PID
    const unit: VideoUnit = { data: u.data, ptsUs: u.ptsUs, discard: !u.inRange || u.ptsUs < s.dropBeforeUs };
    switch (s.videoState) {
      case 'configured':
        s.pendingVideo.push(unit);
        this.feedDecoder(s);
        return;
      case 'failed':
        return;
      case 'configuring':
        s.pendingVideo.push(unit);
        return;
      case 'unconfigured':
        if (!hasSps(s.videoCodingType, u.data)) return;
        s.videoState = 'configuring';
        s.pendingVideo.push(unit);
        decoder.configure({ codingType: s.videoCodingType, firstUnit: u.data }).then(
          () => {
            if (this.session !== s) {
              decoder.close(); // configure() finished after teardown and opened a fresh decoder
              return;
            }
            s.videoState = 'configured';
            this.feedDecoder(s);
          },
          (err: unknown) => {
            if (this.session !== s) return;
            s.videoState = 'failed';
            // a playlist the user picked whose decoder can't be configured is gone (playlistCleared), so the picker
            // shows the reason, as for a pick that fails to open; a disc program's playlist stays, in error
            if (err instanceof UnsupportedCodecError && s.owner === 'user') this.teardownSession();
            this.fail(err);
          },
        );
    }
  }

  /** Coding type of the selected audio stream in the play item containing `timeUs`, if playable. */
  private audioCodingTypeAt(s: Session, timeUs: number): number | null {
    const entry = audioEntryFor(s.playItems[s.timeline.locate(timeUs).item.index], s.audioStream);
    return entry && PLAYABLE_AUDIO.has(entry.codingType) ? entry.codingType : null;
  }

  /** Coding type of the selected audio stream in the first item after the one containing `timeUs` that has it, if playable. */
  private nextAudioCodingType(s: Session, timeUs: number): number | null {
    for (let i = s.timeline.locate(timeUs).item.index + 1; i < s.playItems.length; i++) {
      const entry = audioEntryFor(s.playItems[i], s.audioStream);
      if (entry) return PLAYABLE_AUDIO.has(entry.codingType) ? entry.codingType : null;
    }
    return null;
  }

  /**
   * A play item without the selected audio stream gets no audio units: its span is silence in the ring, so the output and
   * the audio clock run through it and the next item's audio lands where its PTS says.
   */
  private audioItemStarted(s: Session, index: number): void {
    const item = s.playItems[index];
    if (!s.audioActive || !this.audioWriter || !item || this.session !== s || audioEntryFor(item, s.audioStream)) return;
    this.audioWriter.fillSilenceTo(s.timeline.itemStartUs(index) + ((item.outTime - item.inTime) * 1000) / 45);
  }

  /** Audio that never came while the video (or, without a picture, the read position) went well past it is silence. */
  private fillMissingAudio(s: Session): void {
    const writer = this.audioWriter;
    if (!s.audioActive || !writer) return;
    const readUs = s.decoder ? s.videoReadUs : (s.pipeline.readUs ?? -Infinity);
    writer.fillSilenceTo(readUs - AUDIO_ABSENT_AFTER_US); // drains the queued chunks first
  }

  /** One load per coding type per session; a decoder that arrives after teardown is closed. */
  private loadAudioDecoder(s: Session, codingType: number): Promise<AudioDecoder> {
    let load = s.audioDecoderLoads.get(codingType);
    if (!load) {
      const p = this.deps.createAudioDecoder(codingType);
      load = p;
      s.audioDecoderLoads.set(codingType, p);
      p.then(
        (d) => {
          if (this.session === s) s.audioDecoders.set(codingType, d);
          else d.close();
        },
        () => {
          if (s.audioDecoderLoads.get(codingType) === p) s.audioDecoderLoads.delete(codingType);
        },
      );
    }
    return load;
  }

  private audioUnavailable(s: Session, codingType: number, err: unknown): void {
    const codec = codingName(codingType);
    const reason = err instanceof Error ? err.message : String(err);
    this.deps.emit({ type: 'unsupported', kind: 'audio', codec, message: `${codec} audio can't be played (${reason}), so video will play without sound.` });
    this.disableAudio(s, '', false); // also stops the ring (it still holds the previous track or position) and moves the clock to wall time
  }

  private onAudioUnit(s: Session, u: PipelineAudioUnit): void {
    const writer = this.audioWriter;
    if (!s.audioActive || !writer) return;
    const decoder = s.audioDecoders.get(u.codingType);
    if (!decoder) {
      // A later item switched codec: load its decoder (ready for its next units); give up once if that is impossible.
      const type = u.codingType;
      if (s.failedAudioTypes.has(type)) return;
      if (!PLAYABLE_AUDIO.has(type)) {
        s.failedAudioTypes.add(type);
        this.audioUnavailable(s, type, new Error(`${codingName(type)} audio is not supported.`));
        return;
      }
      const gen = this.seekGeneration;
      this.loadAudioDecoder(s, type).catch((err: unknown) => {
        // Only the read that saw these units may give up on them: after a seek, startAt owns the outcome.
        if (this.session !== s || this.seekGeneration !== gen || !s.audioActive || s.failedAudioTypes.has(type)) return;
        s.failedAudioTypes.add(type);
        this.audioUnavailable(s, type, err);
      });
      return;
    }
    let result: AudioDecodeResult;
    try {
      result = decoder.decode(u); // out-of-range units still go in, to keep decoder state continuous
    } catch (err) {
      if (!(err instanceof UnsupportedCodecError)) throw err;
      this.deps.emit({ type: 'unsupported', kind: 'audio', codec: codingName(err.codingType), message: err.message });
      this.disableAudio(s, err.message, false);
      return;
    }
    if (result.failedFrames > 0) {
      this.audioDecodeErrors += result.failedFrames;
      s.audioErrorsInRow += result.failedFrames;
      if (s.audioErrorsInRow > MAX_AUDIO_ERRORS_IN_ROW) {
        s.audioErrorDisabled = true;
        this.disableAudio(s, `The ${codingName(u.codingType)} audio is too damaged to play, so playback continues without sound.`);
        return;
      }
    }
    if (result.chunks.length > 0) {
      s.audioErrorsInRow = 0;
      this.audioCodec = codingName(u.codingType);
    }
    if (!u.inRange) return;
    for (let chunk of result.chunks) {
      if (chunk.sampleRate !== OUTPUT_SAMPLE_RATE) {
        const factor = chunk.sampleRate / OUTPUT_SAMPLE_RATE;
        if (!s.decimator || s.decimator.factor !== factor) s.decimator = new Decimator(factor);
        chunk = s.decimator.process(chunk);
      }
      writer.enqueue(chunk);
    }
  }

  private isFull(s: Session): boolean {
    // Rendering can be throttled (background tab); drop late frames here so reading never stalls on them.
    if (this.state === 'playing') this.presenter.dropLate(this.clock.nowUs());
    this.feedDecoder(s);
    this.fillMissingAudio(s); // also drains the queued chunks
    return this.readerBlocked(s) || (s.audioActive && (this.audioWriter?.queuedChunks ?? 0) > 0);
  }

  /** Moves compressed video into the decoder while the decoded-frame and decode-queue caps allow. */
  private feedDecoder(s: Session): void {
    const decoder = s.decoder;
    if (s.videoState !== 'configured' || !decoder) return;
    let fed = 0;
    while (fed < s.pendingVideo.length && this.presenter.size < this.memory.maxQueuedFrames(this.codedWidth) && decoder.queueSize < MAX_DECODE_QUEUE) {
      decoder.decode(s.pendingVideo[fed]);
      fed++;
    }
    if (fed > 0) s.pendingVideo = s.pendingVideo.slice(fed);
    if (s.eof && s.pendingVideo.length === 0 && !s.flushStarted) this.flushDecoder(s);
  }

  /** True when the compressed-video backlog has used its read-ahead budget, so reading must wait. */
  private readerBlocked(s: Session): boolean {
    // without a picture, reading keeps the same lead over the clock as with one, on what was delivered: the audio's PTS
    // and a lower bound of the pipeline's position (EP map or byte rate), so the audio never falls behind the clock while
    // reading waits, and reading never runs faster than real time where the position is known
    if (!s.decoder) return Math.max(s.audioReadUs, s.pipeline.readUs ?? -Infinity) - this.clock.nowUs() >= MAX_ENCODED_VIDEO_US;
    const pending = s.pendingVideo;
    if (pending.length === 0) return false;
    let min = Infinity;
    let max = -Infinity;
    let bytes = 0;
    for (const u of pending) {
      if (u.ptsUs < min) min = u.ptsUs;
      if (u.ptsUs > max) max = u.ptsUs;
      bytes += u.data.length;
    }
    return max - min >= MAX_ENCODED_VIDEO_US || bytes >= MAX_ENCODED_VIDEO_BYTES;
  }

  private onPipelineEnded(s: Session): void {
    s.eof = true;
    // without a picture the video read counts as delivered too: up to the last item's OUT time when its data was all
    // there (an IG-only menu loop plays to its end), else as far as the reader knows
    if (!s.decoder) s.readEndUs = s.pipeline.doneUs ?? -Infinity;
    if (s.videoState !== 'configured') {
      s.flushed = true;
      return;
    }
    this.feedDecoder(s); // flushes once the compressed backlog has drained
  }

  private flushDecoder(s: Session): void {
    s.flushStarted = true;
    const gen = this.seekGeneration;
    if (!s.decoder) return;
    void s.decoder.flush().then(() => {
      if (this.session === s && this.seekGeneration === gen) s.flushed = true;
    });
  }

  private onDecoderError(s: Session, err: DecoderError): void {
    if (this.session !== s) return;
    this.decoderErrors++;
    if (!err.fatal) {
      this.notice('decoder-recovered', err.message);
      return;
    }
    s.videoState = 'failed';
    s.pipeline.stop();
    this.deps.emit({ type: 'error', code: 'decoder-failed', message: err.message, paths: [] });
    this.pause();
    this.setState('error');
  }

  private updatePlayback(s: Session): void {
    if (this.held) return; // a still image: the output is stopped on purpose, so neither stall detection nor start-up applies
    if (this.state === 'playing' && !s.audioRecoveryQueued && this.audioRecovered(s)) {
      // The stalled output runs again (often just a slow start while another client opened a stream):
      // move back onto it with a seek to the current time, queued like any other command.
      s.audioRecoveryQueued = true;
      void this.handle({ type: 'seek', timeUs: this.clock.nowUs() });
    }
    const ring = s.audioActive ? this.ring : null;
    if (ring) this.fillMissingAudio(s); // the reader may be waiting or done: the ring is fed here too
    if (this.state === 'buffering' && this.wantPlaying) {
      const audioReady =
        !ring ||
        s.eof ||
        this.readerBlocked(s) ||
        (this.audioWriter?.queuedChunks ?? 0) > 0 ||
        (ring.buffered() * 1e6) / ring.sampleRate >= AUDIO_PREBUFFER_US;
      const videoReady = s.decoder === null || this.presenter.size > 0 || this.presenter.current !== null || s.eof || s.videoState === 'failed';
      if (!audioReady || !videoReady || !this.remoteReadAhead(s)) return;
      if (ring) {
        ring.setPlaying(true);
        this.lastHeartbeat = ring.heartbeat();
        this.lastHeartbeatChangeMs = this.deps.nowMs();
      } else {
        this.clock.setRunning(true);
      }
      this.setState('playing');
      return;
    }
    if (this.state !== 'playing' || !ring) return;

    const beat = ring.heartbeat();
    const nowMs = this.deps.nowMs();
    if (beat !== this.lastHeartbeat) {
      this.lastHeartbeat = beat;
      this.lastHeartbeatChangeMs = nowMs;
    } else if (nowMs - this.lastHeartbeatChangeMs > HEARTBEAT_TIMEOUT_MS) {
      this.disableAudio(s, 'Audio output is not running (the browser may have blocked it), so playback continues without sound.');
      s.audioStalledBeat = beat;
      return;
    }
    if (s.eof && (this.audioWriter?.queuedChunks ?? 0) === 0) {
      // Audio is decoded as it arrives, so after EOF everything is in the ring: the video may still need a few frames
      // and the output keeps running (and the clock with it) through silence that is no underrun.
      ring.setDraining(true);
    } else if (!s.eof && ring.buffered() === 0 && !this.readerBlocked(s)) {
      ring.setPlaying(false);
      this.setState('buffering');
    }
  }

  /**
   * A NAS disc starts (and resumes) once REMOTE_START_SECONDS of stream, at the clip's TS_recording_rate, are read
   * ahead of the reader, or read-ahead can go no further (its budget is full, or the clip's file is read to its end).
   */
  private remoteReadAhead(s: Session): boolean {
    const remote = this.remote;
    const reading = s.pipeline.reading;
    if (!remote || !reading || s.eof) return true;
    const ahead = remote.bufferedAhead(reading.path);
    const needed = (REMOTE_START_SECONDS * reading.recordingRate * SOURCE_PACKET_SIZE) / TS_PACKET_SIZE;
    return ahead.bytes >= needed || ahead.toEnd || !remote.readingAhead;
  }

  private disableAudio(s: Session, message: string, notify = true): void {
    if (!s.audioActive) return;
    const now = this.clock.nowUs();
    s.audioActive = false;
    this.ring?.setPlaying(false);
    this.clock.useWall(now, this.state === 'playing');
    if (notify) this.notice('audio-disabled', message);
  }

  private emitTime(timeUs: number, force: boolean): void {
    if (!force && Math.abs(timeUs - this.lastTimeEmitted) < TIME_EVENT_INTERVAL_US) return;
    this.lastTimeEmitted = timeUs;
    this.deps.emit({ type: 'time', timeUs: Math.round(timeUs) });
  }

  /**
   * `s` is null for a BD-J menu shown with no playlist: the playback counters are then 0. The BD-J plane hash
   * (settledPlaneHash) runs on this frame path only in telemetry runs (planeHashTelemetry), once per settled plane
   * version, and may cause a one-frame hitch there.
   */
  private maybeEmitTelemetry(s: Session | null): void {
    const nowMs = this.deps.nowMs();
    if (nowMs - this.lastTelemetryMs < TELEMETRY_INTERVAL_MS) return;
    this.lastTelemetryMs = nowMs;
    const offsets = this.offsets;
    this.offsets = [];
    const ring = this.ring;
    const stats = s?.pipeline.stats ?? { corruptPackets: 0, continuityErrors: 0 };
    this.deps.emit({
      type: 'telemetry',
      telemetry: {
        clockUs: this.clock.nowUs(),
        clockMode: this.clock.mode,
        avOffsetMeanUs: offsets.length > 0 ? offsets.reduce((a, b) => a + b, 0) / offsets.length : null,
        avOffsetMaxAbsUs: offsets.length > 0 ? Math.max(...offsets.map((o) => Math.abs(o))) : null,
        framesInWindow: offsets.length,
        framesPresented: this.presenter.presented,
        framesDropped: this.presenter.dropped,
        audioBufferedMs: ring ? (ring.buffered() * 1000) / ring.sampleRate : 0,
        audioUnderruns: ring?.underruns() ?? 0,
        corruptPackets: stats.corruptPackets + this.audioDecodeErrors,
        audioCodec: this.audioCodec,
        audioDecodeErrors: this.audioDecodeErrors,
        continuityErrors: stats.continuityErrors,
        decoderErrors: this.decoderErrors,
        openGopStarts: s?.decoder?.openGop.starts ?? 0,
        leadingPicturesSkipped: s?.decoder?.openGop.leadingSkipped ?? 0,
        menu: this.menuActive && this.navRegs ? { page: this.navRegs.psrRead(PSR.MENU_PAGE_ID), selectedButton: this.navRegs.psrRead(PSR.SELECTED_BUTTON_ID), buttonsDrawn: this.igDraws } : null,
        igErrors: this.navigator?.igErrors ?? 0,
        soundsPlayed: this.soundsPlayed,
        pg: this.pg?.shown ?? null,
        pgErrors: this.pg?.errors ?? 0,
        textCue: this.textCueVisible(),
        textFile: this.textOn ? this.textTrack?.renderer.fileAt(this.clock.nowUs())?.file ?? null : null,
        ass: this.assStats(),
        shader: this.shaderStage?.stats ?? null,
        bdj: this.bdjStartup ? { ...this.bdjStartup, inputLatencyMs: this.bdjLatency.stats } : null,
        ...(this.deps.memoryTelemetry ? { bdjMemory: this.bdjMemory() } : {}),
        bdjPlane: this.bdj ? { flushes: this.bdj.plane.flushCount(), tapsIgnored: this.bdjTapsIgnored, ...(this.deps.planeHashTelemetry ? { hash: this.settledPlaneHash(this.bdj.plane) } : {}) } : null,
      },
    });
  }

  /**
   * The plane's hash once no flush, init or close has changed it since the last telemetry; null while it changes (or
   * while the writer holds it: tried again at the next telemetry). Hashed once per settled version.
   */
  private settledPlaneHash(plane: GraphicsPlaneReader): string | null {
    const version = plane.version();
    const seen = this.planeSeen;
    if (!seen || seen.plane !== plane || seen.version !== version) {
      this.planeSeen = { plane, version, hash: null };
      return null;
    }
    seen.hash ??= plane.tryHash();
    return seen.hash;
  }

  private sinceOpenMs(): number {
    return Math.round(this.deps.nowMs() - this.openedAtMs);
  }

  private textCueVisible(): boolean {
    const track = this.textTrack;
    return this.textOn && track !== null && track.renderer.visible(this.clock.nowUs(), this.textOptions());
  }

  private assStats(): { events: number; animated: number; renderMs: number; overBudget: number; renders: number } | null {
    const showing = this.textOn ? this.textTrack?.renderer.fileAt(this.clock.nowUs())?.renderer : undefined;
    return showing instanceof AssRenderer ? showing.stats() : null;
  }

  /** A user operation the disc masks here: refused with a notice. Discs without a navigator mask nothing. */
  private refused(op: UoOp): boolean {
    if (!this.navigator?.isMasked(op)) return false;
    this.notice('uo-masked', UO_MASKED_MESSAGE);
    return true;
  }

  private notice(code: NoticeCode, message: string): void {
    this.deps.emit({ type: 'notice', code, message });
  }

  private setState(state: PlaybackState): void {
    if (state === this.state) return;
    this.state = state;
    this.deps.emit({ type: 'state', state });
  }

  private fail(err: unknown): void {
    this.reportError(err);
    this.session?.pipeline.stop();
    this.wantPlaying = false;
    this.ring?.setPlaying(false);
    this.clock.setRunning(false);
    this.setState('error');
  }

  private reportError(err: unknown): void {
    if (err instanceof DiscError) {
      this.deps.emit({ type: 'error', code: err instanceof RemoteDiscError ? err.reason : err.code, message: err.message, paths: err.paths });
    } else if (err instanceof UnsupportedCodecError) {
      this.deps.emit({ type: 'unsupported', kind: isVideoCoding(err.codingType) ? 'video' : 'audio', codec: codingName(err.codingType), message: err.message });
    } else if (err instanceof ParseError) {
      this.deps.emit({ type: 'error', code: 'corrupt-disc', message: `The disc data is damaged: ${err.message}`, paths: [] });
    } else {
      this.deps.emit({ type: 'error', code: 'internal', message: err instanceof Error ? err.message : String(err), paths: [] });
    }
  }
}
