import { pickedSubtitles, splitPick } from './drop-files';
import type { RemoteDiscSpec } from '../disc/disc-spec';
import type { PlaylistSummary } from '../disc/open-disc';
import type { UoOp } from '../hdmv/uo-mask';
import type { Chapter } from '../nav/timeline';
import type { MemoryProfileName } from '../memory-profile';
import type { AudioTrack, BufferRequest, EncodeSpec, EngineCommand, EngineEvent, ErrorCode, MenuKey, PlaceState, PlaybackState, ShaderSetData, ShaderState, StartPoint, SubtitleChoice, Telemetry } from '../protocol';
import { trackLabel } from './language';
import { DROP_WARN_RATE, DropMeter } from './drop-meter';

/** A message for the user. Notices are kept by `code`: a new one replaces the one with the same code. */
export interface Notice {
  /** Stable identifier (such as `audio-track` or `uo-masked`), used to replace or dismiss the notice. */
  readonly code: string;
  /** The text to show. */
  readonly message: string;
}

/**
 * Everything the UI shows about the player, held by `PlayerController` and replaced (never mutated) on each change, so
 * it can back `useSyncExternalStore`. Nearly all of it is built from engine events by `reduceEvent`; the controller's own
 * methods set the few fields that change at once on the main thread (volume, mute, notices, the level switch).
 */
export interface PlayerSnapshot {
  /** The engine's playback state; `loading` from a disc open until the engine reports a state, `error` once the worker failed. */
  readonly engineState: PlaybackState;
  /** The disc's playlists for the title picker; empty until the engine has read the disc. */
  readonly playlists: readonly PlaylistSummary[];
  /** The disc's index names BD-J objects, so its titles run Java programs. */
  readonly usesBdj: boolean;
  /** The engine runs BD-J titles. */
  readonly bdjSupported: boolean;
  /** What this browser lacks to run BD-J (named in the picker); empty when nothing is missing. */
  readonly bdjMissing: readonly string[];
  /** A BD-J title drives playback: no playlist yet is no reason to show the picker. */
  readonly bdjActive: boolean;
  /** The BD-J graphics plane shows something: taps, clicks, arrows, Enter and digits go to the disc. */
  readonly bdjMenuVisible: boolean;
  /** Taps on a BD-J menu the disc ignored, counted since the page loaded. */
  readonly bdjTapsIgnored: number;
  /**
   * Times the on-screen remote was opened for an ignored tap, counted since the page loaded: once per menu (from the
   * BD-J plane turning visible), with the notice; a remote the user then closes stays closed until the next menu.
   */
  readonly bdjRemoteRequests: number;
  /** The current BD-J menu has already opened the remote for an ignored tap. */
  readonly bdjRemoteOpenedInMenu: boolean;
  /** The open disc is on the NAS (opened with openRemote). */
  readonly remoteDisc: boolean;
  /** The open NAS disc is read over WebRTC (its base is `rtc://`), so its connection may be relayed. */
  readonly rtcDisc: boolean;
  /** The id of the encoded episode open (openEncode); null while a disc is open, or nothing. */
  readonly encodeId: string | null;
  /** Clicks on an HDMV menu that hit no button, counted since the page loaded (a touch that missed shows the controls). */
  readonly menuTapMisses: number;
  /** Problems the engine found while opening the disc that did not stop it (for example an unreadable playlist). */
  readonly warnings: readonly string[];
  /** The playlist playing now (its id is the MPLS file name without extension, such as `00001`); `mkv` for an encoded episode; null for none. */
  readonly currentPlaylistId: string | null;
  /** Length of the current playlist in microseconds; 0 when none plays. */
  readonly durationUs: number;
  /** Playback position in the current playlist, microseconds from its start, as the last `time` event said. */
  readonly timeUs: number;
  /** Chapters of the current playlist, in time order. */
  readonly chapters: readonly Chapter[];
  /** Messages to show, at most one per code. */
  readonly notices: readonly Notice[];
  /** The disc could not be opened or played (or the worker failed); `paths` lists the disc files involved. */
  readonly error: { readonly code: ErrorCode; readonly message: string; readonly paths: readonly string[] } | null;
  /** The engine's latest telemetry sample; null until one arrives. */
  readonly telemetry: Telemetry | null;
  /** Output volume, 0 to 1. Kept across discs. */
  readonly volume: number;
  /** The output is muted. Kept across discs. */
  readonly muted: boolean;
  /** The current playlist's audio tracks, with whether each can be decoded. */
  readonly audioTracks: readonly AudioTrack[];
  /** The `index` of the audio track playing; null when there is none. */
  readonly selectedAudio: number | null;
  /** A disc menu is shown (arrows, Enter, digits and the pointer go to it). */
  readonly menuActive: boolean;
  /** The disc has a pop-up menu that the user can open. */
  readonly popupAvailable: boolean;
  /** The menu button under the pointer, after the last pointer move. */
  readonly pointerButton: number | null;
  /** User operations the disc does not allow at this point (UO mask). */
  readonly uoMask: readonly UoOp[];
  /** HDMV discs: the index titles (for the picker) and whether there is a top menu; null otherwise. */
  readonly indexTitles: IndexTitles | null;
  /** The engine's last 'subtitles' event; null until a disc reports one. */
  readonly subtitles: SubtitlesState | null;
  /** Subtitle files that are not UTF-8 wait for the user to pick their encoding. */
  readonly encodingPrompt: { readonly names: readonly string[] } | null;
  /** The video shader set: its state, name and the error that explains 'error' and 'unavailable'. */
  readonly shaders: { readonly state: ShaderState; readonly set: string | null; readonly error: string | null };
  /** Drop rate while a set is active and the rate is above DROP_WARN_RATE; else null. */
  readonly shaderDropWarning: number | null;
  /** The open NAS disc's read-ahead cache fill (buffer first), as its last bufferProgress said; null before any. */
  readonly buffer: { readonly bytes: number; readonly targetBytes: number; readonly mbps: number; readonly stopped?: 'failed' | 'no-cache' } | null;
  /** Whether this device can keep a read-ahead cache (the engine says at its start; null until then). Kept across discs. */
  readonly readAheadCache: boolean | null;
  /** Why the open's start point could not be used (startFailed); null otherwise, and again on every open. */
  readonly startFailed: 'no-playlist' | 'past-end' | null;
  /** A quality level switch (setLevel): 'switching' until the engine's levelChanged, then 'idle' or its error. */
  readonly levelSwitch: 'idle' | 'switching' | { readonly error: string };
}

export type { PlaceState, StartPoint };

/** The engine's last 'subtitles' event. */
export type SubtitlesState = Omit<Extract<EngineEvent, { type: 'subtitles' }>, 'type'>;

/** The largest subtitle offset the controller sends, in milliseconds either way (ten minutes). */
export const MAX_SUBTITLE_OFFSET_MS = 600_000;
/** Far beyond any subtitle file (a feature's SRT is well under 1 MB); larger picks are refused before reading them. */
export const MAX_SUBTITLE_FILE_BYTES = 32 * 1024 * 1024;
/** The most subtitle files one pick loads; the rest are dropped with a notice. */
export const MAX_SUBTITLE_FILES = 64;
/** One font file above this size is skipped. */
const MAX_FONT_BYTES = 64 * 1024 * 1024;
/** The fonts of one pick are kept only up to this total. */
const MAX_FONTS_BYTES = 256 * 1024 * 1024;
/** The smallest text subtitle scale (a multiplier of the default size). */
export const MIN_SUBTITLE_SCALE = 0.5;
/** The largest text subtitle scale. */
export const MAX_SUBTITLE_SCALE = 2;

/** "+0.3 s", "−1.2 s", "0.0 s". */
export function formatSubtitleOffset(ms: number): string {
  const s = (Math.abs(ms) / 1000).toFixed(1);
  return ms > 0 ? `+${s} s` : ms < 0 ? `\u2212${s} s` : `${s} s`;
}

/** The titles in an HDMV disc's `index.bdmv`, for the picker. */
export interface IndexTitles {
  /** Each title by its number in the index and the kind of object that runs it. */
  readonly titles: ReadonlyArray<{ readonly number: number; readonly kind: 'hdmv' | 'bdj' }>;
  /** The index defines a Top Menu title, so `menuCall` has somewhere to go. */
  readonly hasTopMenu: boolean;
}

/** The notice text shown when the disc masks an operation the user tried. */
export const UO_MASKED_MESSAGE = "The disc doesn't allow this here.";

/**
 * The snapshot before any disc opens; opening or closing a disc restarts from it, keeping volume, mute and the cache flag.
 * @internal
 */
export const INITIAL_SNAPSHOT: PlayerSnapshot = {
  engineState: 'idle',
  playlists: [],
  usesBdj: false,
  bdjSupported: false,
  bdjMissing: [],
  bdjActive: false,
  bdjMenuVisible: false,
  bdjTapsIgnored: 0,
  bdjRemoteRequests: 0,
  bdjRemoteOpenedInMenu: false,
  remoteDisc: false,
  rtcDisc: false,
  encodeId: null,
  menuTapMisses: 0,
  warnings: [],
  currentPlaylistId: null,
  durationUs: 0,
  timeUs: 0,
  chapters: [],
  notices: [],
  error: null,
  telemetry: null,
  volume: 1,
  muted: false,
  audioTracks: [],
  selectedAudio: null,
  menuActive: false,
  popupAvailable: false,
  pointerButton: null,
  uoMask: [],
  indexTitles: null,
  subtitles: null,
  encodingPrompt: null,
  shaders: { state: 'off', set: null, error: null },
  shaderDropWarning: null,
  buffer: null,
  readAheadCache: null,
  startFailed: null,
  levelSwitch: 'idle',
};

function withNotice(s: PlayerSnapshot, notice: Notice): PlayerSnapshot {
  return { ...s, notices: [...s.notices.filter((n) => n.code !== notice.code), notice] };
}

/**
 * The snapshot after one engine event. Pure, so it is tested without a worker. Events the controller answers itself
 * (token requests, sound effects, port closing, `placeState`) return the snapshot unchanged. A `titles` event resets
 * everything about the previous playlist. A `levelChanged` counts only while a switch is pending.
 */
export function reduceEvent(s: PlayerSnapshot, e: EngineEvent): PlayerSnapshot {
  switch (e.type) {
    case 'titles':
      return { ...s, playlists: e.playlists, usesBdj: e.usesBdj, bdjSupported: e.bdjSupported, bdjMissing: e.bdjMissing ?? [], bdjActive: false, bdjMenuVisible: false, bdjRemoteOpenedInMenu: false, warnings: e.warnings, error: null, currentPlaylistId: null, chapters: [], durationUs: 0, timeUs: 0, audioTracks: [], selectedAudio: null, indexTitles: null, subtitles: null, encodingPrompt: null };
    case 'chapters':
      // Notices are not cleared here: the engine emits a playlist's own notices before this event.
      return { ...s, currentPlaylistId: e.playlistId, durationUs: e.durationUs, chapters: e.chapters, timeUs: 0, error: null };
    case 'tracks':
      return { ...s, audioTracks: e.audio, selectedAudio: e.selectedAudio };
    case 'state':
      return { ...s, engineState: e.state };
    case 'time':
      return { ...s, timeUs: e.timeUs };
    case 'notice':
      return withNotice(s, { code: e.code, message: e.message });
    case 'noticeCleared':
      return { ...s, notices: s.notices.filter((n) => n.code !== e.code) };
    case 'remoteTokenNeeded':
    case 'fetchPortClosed':
      return s; // handled by the controller
    case 'unsupported':
      return withNotice(s, { code: e.noPicture ? 'no-picture' : e.reason === 'av1' ? 'unsupported-av1' : `unsupported-${e.kind}`, message: e.message });
    case 'error':
      return { ...s, error: { code: e.code, message: e.message, paths: e.paths } };
    case 'telemetry':
      return { ...s, telemetry: e.telemetry };
    case 'menuActive':
      return { ...s, menuActive: e.active, popupAvailable: e.popupAvailable, pointerButton: e.active ? s.pointerButton : null };
    case 'pointerTarget':
      return { ...s, pointerButton: e.button };
    case 'menuTapMissed':
      return { ...s, menuTapMisses: s.menuTapMisses + 1 };
    case 'soundEffects':
    case 'soundEffect':
      return s; // handed to the audio output by the controller
    case 'subtitles':
      return { ...s, subtitles: { pg: e.pg, text: e.text, selected: e.selected, scale: e.scale } };
    case 'subtitleEncodingNeeded':
      return { ...s, encodingPrompt: { names: e.names } };
    case 'uoMask':
      return { ...s, uoMask: e.masked };
    case 'bdjActive':
      // once BD-J stops, its menu and the notice about it go
      return e.active ? { ...s, bdjActive: true } : { ...s, bdjActive: false, bdjMenuVisible: false, bdjRemoteOpenedInMenu: false, notices: s.notices.filter((n) => n.code !== 'bdj-tap-ignored') };
    case 'bdjMenu':
      // a plane turning visible is a new menu: its first ignored tap opens the remote again
      return { ...s, bdjMenuVisible: e.visible, bdjRemoteOpenedInMenu: e.visible && !s.bdjMenuVisible ? false : s.bdjRemoteOpenedInMenu };
    case 'bdjTapIgnored':
      return s.bdjRemoteOpenedInMenu
        ? { ...s, bdjTapsIgnored: s.bdjTapsIgnored + 1 }
        : { ...s, bdjTapsIgnored: s.bdjTapsIgnored + 1, bdjRemoteRequests: s.bdjRemoteRequests + 1, bdjRemoteOpenedInMenu: true };
    case 'indexTitles':
      return { ...s, indexTitles: { titles: e.titles, hasTopMenu: e.hasTopMenu } };
    case 'playlistCleared':
      return { ...s, currentPlaylistId: null, durationUs: 0, chapters: [], timeUs: 0, audioTracks: [], selectedAudio: null };
    case 'bufferProgress':
      return { ...s, buffer: { bytes: e.bytes, targetBytes: e.targetBytes, mbps: e.mbps, ...(e.stopped ? { stopped: e.stopped } : {}) } };
    case 'readAheadCache':
      return { ...s, readAheadCache: e.available };
    case 'startFailed':
      return { ...s, startFailed: e.reason };
    case 'levelChanged':
      // only the switch this disc is waiting on: a late answer for a disc closed since is no answer for the new one
      return s.levelSwitch !== 'switching' ? s : { ...s, levelSwitch: e.ok ? 'idle' : { error: e.message } };
    case 'placeState':
      return s; // answers readPlace
    case 'shaderStatus':
      return { ...s, shaders: { state: e.state, set: e.set, error: e.error }, shaderDropWarning: e.state === 'active' ? s.shaderDropWarning : null };
  }
}

/** The backstop for releasing a replaced NAS disc's fetch port serving, should the engine never report the port closed. */
export const FETCH_PORT_RELEASE_MS = 5_000;

function releaseServing(entry: { release: (() => void) | null; timer: ReturnType<typeof setTimeout> | null }): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  const release = entry.release;
  entry.release = null;
  release?.();
}

/** The part of `Worker` the controller uses, so tests can substitute a fake. The controller owns `onmessage` and the error handlers. */
export interface WorkerLike {
  /** Sends a command; `transfer` lists the objects moved rather than copied (the canvas, byte buffers, a fetch port). */
  postMessage(message: unknown, transfer: Transferable[]): void;
  /** Receives each `EngineEvent`. */
  onmessage: ((event: MessageEvent) => void) | null;
  /** Called when the worker throws or fails to load; the controller then reports an internal error. */
  onerror?: ((event: ErrorEvent) => void) | null;
  /** Called when the worker sent something that could not be deserialised. */
  onmessageerror?: ((event: MessageEvent) => void) | null;
}

/** The part of `AudioOutput` the controller uses; the main-thread audio output. */
export interface AudioOutputLike {
  /** Starts audio (needs a user gesture) and resolves with the shared PCM ring; rejects when it cannot start. */
  ensureStarted(): Promise<SharedArrayBuffer>;
  /** Sets the output gain, 0 to 1. */
  setVolume(volume: number): void;
  /** Mutes or unmutes, keeping the volume. */
  setMuted(muted: boolean): void;
  /** The disc's menu sounds (48 kHz, interleaved 16-bit), replacing earlier ones. */
  loadEffects(clips: ReadonlyArray<{ readonly channels: 1 | 2; readonly samples: Int16Array }>): void;
  /** Plays a loaded sound through the volume and mute; an unknown id is ignored. */
  playEffect(id: number): void;
  /** Reports every change of the audio context's state; 'interrupted' is WebKit's (phone call, Siri). */
  onStateChange(cb: (state: AudioContextState | 'interrupted') => void): void;
}

/** Page visibility, injectable so Node tests need no `document`. */
export interface VisibilityLike {
  /** Whether the page is hidden now. */
  hidden(): boolean;
  /** Calls `cb` whenever visibility changes. */
  onChange(cb: () => void): void;
}

const BACKGROUND_PAUSE_MESSAGE = 'Playback paused while the app was in the background.';

function documentVisibility(): VisibilityLike {
  return {
    hidden: () => typeof document !== 'undefined' && document.hidden,
    onChange: (cb) => {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', cb);
    },
  };
}

/**
 * The main-thread side of the player: it posts `EngineCommand`s to the engine worker and folds the worker's
 * `EngineEvent`s into a `PlayerSnapshot`. It is an external store (`subscribe` and `getSnapshot`) for
 * `useSyncExternalStore`. Call it only from the main thread; the engine runs the playback in the worker and the
 * controller never waits on it, so a method returns at once and its effect shows in a later snapshot. It owns the audio
 * output (volume, mute, menu sounds), starts audio from user gestures, pauses when the platform suspends audio in the
 * background, and keeps each NAS disc's fetch port serving until the engine has closed it.
 */
export class PlayerController {
  private snapshot: PlayerSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private audioAttached = false;
  private readonly transferredCanvases = new WeakSet<HTMLCanvasElement>();
  /** The load whose encoding prompt is open: read again when the user picks one (its bytes were transferred). */
  private pendingSubtitleLoad: readonly File[] | null = null;

  private readonly dropMeter = new DropMeter();
  private readonly visibility: VisibilityLike;
  /** The platform suspended audio while the page was hidden and we paused; the notice waits for the page to return. */
  private backgroundPaused = false;
  /** The open NAS disc's token source, asked when the engine's reads get a 401. */
  private refreshToken: (() => Promise<string>) | null = null;
  /**
   * What serves the fetch port of each NAS disc the engine may still read, oldest first. One is released when the
   * engine reports that port closed (fetchPortClosed, after it dropped the disc and aborted its reads), or, as a
   * backstop, FETCH_PORT_RELEASE_MS after its disc was replaced or closed. A released entry stays until its event, so
   * the events and the entries stay in step.
   */
  private readonly servings: Array<{ release: (() => void) | null; timer: ReturnType<typeof setTimeout> | null }> = [];
  private opens = 0;
  private cancels = 0;
  /** readPlace calls waiting for the engine's next placeState. */
  private placeWaiters: Array<{ resolve: (place: PlaceState) => void; reject: (err: Error) => void }> = [];
  /** The worker failed (reportInternalError): it will answer nothing more. */
  private engineFailed: Error | null = null;

  constructor(
    private readonly worker: WorkerLike,
    private readonly audio: AudioOutputLike,
    private readonly options: { readonly nowMs?: () => number; readonly visibility?: VisibilityLike } = {},
  ) {
    this.visibility = options.visibility ?? documentVisibility();
    audio.onStateChange((state) => this.onAudioState(state));
    this.visibility.onChange(() => {
      if (this.backgroundPaused && !this.visibility.hidden()) this.showBackgroundPause();
    });
    worker.onmessage = (event: MessageEvent<EngineEvent>) => {
      const e = event.data;
      if (e.type === 'soundEffects') audio.loadEffects(e.clips);
      else if (e.type === 'soundEffect') audio.playEffect(e.id);
      else if (e.type === 'remoteTokenNeeded') this.answerTokenRequest();
      else if (e.type === 'fetchPortClosed') this.fetchPortClosed();
      else if (e.type === 'placeState') this.placeState(e);
      else this.update(this.withDropWarning(reduceEvent(this.snapshot, e), e));
    };
    worker.onerror = (event) => this.reportInternalError(`The player engine stopped unexpectedly: ${event.message || 'unknown error'}`);
    worker.onmessageerror = () => this.reportInternalError('The player engine sent a message that could not be read.');
  }

  /**
   * Nothing here ever suspends the audio context, so any suspension is the platform's. The player pauses (never
   * resumes by itself) when it was playing and audio is suspended while hidden, or interrupted at any time.
   * A running context while hidden (desktop Chrome) keeps playing.
   */
  private onAudioState(state: AudioContextState | 'interrupted'): void {
    const playing = this.snapshot.engineState === 'playing' || this.snapshot.engineState === 'buffering';
    if (!playing) return;
    const hidden = this.visibility.hidden();
    if (state === 'interrupted' || (state === 'suspended' && hidden)) {
      this.pause();
      this.backgroundPaused = true;
      if (!hidden) this.showBackgroundPause();
    }
  }

  private showBackgroundPause(): void {
    this.backgroundPaused = false;
    this.update(withNotice(this.snapshot, { code: 'background-pause', message: BACKGROUND_PAUSE_MESSAGE }));
  }

  /** Feeds the drop meter from telemetry while a shader set is active; any shader status change starts a new window. */
  private withDropWarning(s: PlayerSnapshot, e: EngineEvent): PlayerSnapshot {
    if (e.type === 'shaderStatus') {
      this.dropMeter.reset();
      return s;
    }
    if (e.type !== 'telemetry') return s;
    if (s.shaders.state !== 'active') {
      this.dropMeter.reset();
      return s;
    }
    this.dropMeter.push((this.options.nowMs ?? (() => performance.now()))(), e.telemetry.framesPresented, e.telemetry.framesDropped);
    const rate = this.dropMeter.rate();
    const warning = rate !== null && rate > DROP_WARN_RATE ? rate : null;
    return warning === s.shaderDropWarning ? s : { ...s, shaderDropWarning: warning };
  }

  /**
   * Surfaces a failure of the engine worker itself (it can no longer report through events): the snapshot gets an
   * `internal` error and state `error`, and pending `readPlace` calls reject.
   */
  reportInternalError(message: string): void {
    this.engineFailed = new Error(message);
    const waiters = this.placeWaiters;
    this.placeWaiters = [];
    for (const w of waiters) w.reject(this.engineFailed);
    const s = reduceEvent(this.snapshot, { type: 'error', code: 'internal', message, paths: [] });
    this.update({ ...s, engineState: 'error' }); // the engine can't report its own state any more
  }

  /** Registers a listener called after every snapshot change; returns the function that removes it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current snapshot; the same object until something changes. */
  readonly getSnapshot = (): PlayerSnapshot => this.snapshot;

  /**
   * Hands the video canvas to the engine as an `OffscreenCanvas`, after which the worker draws on it and the page can no
   * longer. A canvas is transferred once (React StrictMode runs effects twice, so a second call with it is ignored);
   * a remounted screen brings a new canvas.
   */
  attachCanvas(canvas: HTMLCanvasElement): void {
    if (this.transferredCanvases.has(canvas)) return;
    this.transferredCanvases.add(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    this.post({ type: 'attachCanvas', canvas: offscreen }, [offscreen]);
  }

  /** Sets the canvas's drawing size in pixels (sends `resize`); the engine repaints at that size. */
  resize(width: number, height: number): void {
    this.post({ type: 'resize', width, height });
  }

  /**
   * Call from user-gesture handlers so the AudioContext is allowed to start. Resolves once the audio ring has been
   * posted to the engine (or at once when it already was), and also when audio could not start (a notice says why);
   * it never rejects. A host that opens a disc right after should wait for it: a playlist that starts before the ring
   * arrives plays without sound until the next playlist.
   */
  startAudio(): Promise<void> {
    return this.audio.ensureStarted().then(
      (ring) => {
        if (this.audioAttached) return;
        this.audioAttached = true;
        this.post({ type: 'attachAudio', ring });
      },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.update(withNotice(this.snapshot, { code: 'audio-output', message: `Audio output could not start: ${reason}` }));
      },
    );
  }

  /** How many times a disc was opened or closed: what was waiting on one open can tell that another came since. */
  get discOpens(): number {
    return this.opens;
  }

  /**
   * The registers a saved place needs, as the engine reads them now (its next placeState). The engine answers at once,
   * in command order, so a read made before an open or a close describes the disc that was open when it was made (a
   * save just before switching discs), and resolves; it rejects only once the engine worker has failed.
   */
  readPlace(): Promise<PlaceState> {
    if (this.engineFailed) return Promise.reject(this.engineFailed);
    return new Promise((resolve, reject) => {
      this.placeWaiters.push({ resolve, reject });
      this.post({ type: 'readPlace' });
    });
  }

  private placeState(e: Extract<EngineEvent, { type: 'placeState' }>): void {
    const { type: _type, ...place } = e;
    const waiters = this.placeWaiters;
    this.placeWaiters = [];
    for (const w of waiters) w.resolve(place);
  }

  /** A notice from the UI itself (the engine's arrive as events), replacing any with the same code. */
  showNotice(code: string, message: string): void {
    this.update(withNotice(this.snapshot, { code, message }));
  }

  /**
   * Opens a disc from picked files (`[path, file]` pairs, paths like `BDMV/index.bdmv`). Sends `open`; the snapshot
   * restarts from `INITIAL_SNAPSHOT` (keeping volume and mute) with state `loading`, then `titles` or `error` follows.
   * `start`: open at that place instead of running the disc's First Play (`startFailed` says when it can't).
   */
  open(entries: ReadonlyArray<readonly [string, File]>, start?: StartPoint): void {
    this.opens++;
    this.refreshToken = null;
    this.supersedeServings();
    this.startAudio();
    this.update({ ...INITIAL_SNAPSHOT, volume: this.snapshot.volume, muted: this.snapshot.muted, readAheadCache: this.snapshot.readAheadCache, engineState: 'loading' });
    this.post({ type: 'open', disc: { kind: 'files', entries }, ...(start ? { start } : {}) });
  }

  /**
   * A disc on the NAS. `refreshToken` gives a fresh session token when the NAS refuses the current one; a token
   * refreshed on schedule goes to the engine through setRemoteToken. A spec's fetch port (the WebRTC route) is
   * transferred to the engine, and `release` (what serves it) runs once the engine has closed that port, after another disc
   * opened or this one closed (or failed to open), so no read of it fails early. With `bufferFirst` the engine fills the
   * disc's read-ahead cache (bufferProgress) before it opens the disc; cancelBuffer opens it at once. `start`: as open's.
   */
  openRemote(spec: RemoteDiscSpec, refreshToken?: () => Promise<string>, release?: () => void, bufferFirst?: BufferRequest, start?: StartPoint): void {
    this.opens++;
    this.supersedeServings();
    this.refreshToken = refreshToken ?? null;
    if (spec.fetchPort) this.servings.push({ release: release ?? null, timer: null });
    else release?.(); // nothing crosses to the engine to serve
    this.startAudio();
    this.update({ ...INITIAL_SNAPSHOT, volume: this.snapshot.volume, muted: this.snapshot.muted, readAheadCache: this.snapshot.readAheadCache, engineState: 'loading', remoteDisc: true, rtcDisc: spec.base.startsWith('rtc://') });
    this.post({ type: 'open', disc: spec, ...(bufferFirst ? { bufferFirst } : {}), ...(start ? { start } : {}) }, spec.fetchPort ? [spec.fetchPort] : []);
  }

  /**
   * An encoded episode on the NAS, played from `startUs` (from the start without it). It is read as a NAS disc is:
   * `refreshToken` answers the engine's token requests, and a spec's fetch port (the WebRTC route) is transferred, with
   * `release` run once the engine has closed it. encodeId is set until another disc opens or this one closes.
   */
  openEncode(spec: EncodeSpec, refreshToken?: () => Promise<string>, startUs?: number, release?: () => void): void {
    this.opens++;
    this.supersedeServings();
    this.refreshToken = refreshToken ?? null;
    if (spec.fetchPort) this.servings.push({ release: release ?? null, timer: null });
    else release?.();
    this.startAudio();
    this.update({ ...INITIAL_SNAPSHOT, volume: this.snapshot.volume, muted: this.snapshot.muted, readAheadCache: this.snapshot.readAheadCache, engineState: 'loading', remoteDisc: true, rtcDisc: spec.base.startsWith('rtc://'), encodeId: spec.encodeId });
    this.post({ type: 'openEncode', encode: spec, ...(startUs !== undefined ? { startUs } : {}) }, spec.fetchPort ? [spec.fetchPort] : []);
  }

  /**
   * Switches the open NAS disc to another version (a quality level, or the original): same disc id, never with a fetch
   * port (over WebRTC the open disc's port goes on serving). levelSwitch is 'switching' until the engine answers.
   * `audio`: with a switch to the original, the audio stream (original numbering) to keep playing.
   */
  setLevel(spec: RemoteDiscSpec, audio?: number): void {
    this.update({ ...this.snapshot, levelSwitch: 'switching' });
    this.post({ type: 'setLevel', disc: spec, ...(audio !== undefined ? { audio } : {}) });
  }

  /** Fetches the open NAS disc's main playlist from `fromSeconds` on into its read-ahead cache, `targetBytes` of it. */
  bufferAhead(fromSeconds: number, targetBytes: number): void {
    this.post({ type: 'bufferAhead', fromSeconds, targetBytes });
  }

  /** Stops the fill; a disc opened with bufferFirst opens at once (it plays now, with pauses). */
  cancelBuffer(): void {
    this.post({ type: 'cancelBuffer' });
  }

  /** The open disc is being replaced or closed: its serving goes once the engine has closed its port, or after the backstop. */
  private supersedeServings(): void {
    for (const entry of this.servings) {
      if (entry.release && !entry.timer) entry.timer = setTimeout(() => releaseServing(entry), FETCH_PORT_RELEASE_MS);
    }
  }

  /** The engine closed the oldest fetch port it held. */
  private fetchPortClosed(): void {
    const entry = this.servings.shift();
    if (entry) releaseServing(entry);
  }

  /** A fresh session token for the open NAS disc. */
  setRemoteToken(token: string): void {
    this.post({ type: 'remoteToken', token });
  }

  /** The engine got a 401; without an answer within 10 s it fails the disc as unpaired. */
  private answerTokenRequest(): void {
    this.refreshToken?.().then(
      (token) => this.setRemoteToken(token),
      () => undefined,
    );
  }

  /** Plays a playlist by id, from its start. Sends `playPlaylist` and first drops the previous playlist's notices. */
  playPlaylist(playlistId: string): void {
    this.startAudio();
    // Drop the previous playlist's notices now; the engine handles commands in order, so every notice
    // it emits for the new playlist arrives after this. Disc-level (bdj, the no-picture notice the engine sends once per
    // disc) and device-level (audio-output) notices stay; the picked playlist stops a BD-J title, so its ignored-tap
    // notice goes. Opening a disc clears them all.
    const playlistScoped = (code: string): boolean =>
      code.startsWith('unsupported-') || code === 'audio-disabled' || code === 'decoder-recovered' || code === 'audio-track' || code === 'bdj-tap-ignored';
    this.update({ ...this.snapshot, notices: this.snapshot.notices.filter((n) => !playlistScoped(n.code)) });
    this.post({ type: 'playPlaylist', playlistId });
  }

  /** Starts or resumes playback (sends `play`, and starts audio if it is not running). */
  play(): void {
    this.startAudio();
    this.post({ type: 'play' });
  }

  /** Pauses playback (sends `pause`). */
  pause(): void {
    this.post({ type: 'pause' });
  }

  /** Pauses when the state is `playing` or `buffering`, plays otherwise. */
  togglePlay(): void {
    const state = this.snapshot.engineState;
    if (state === 'playing' || state === 'buffering') this.pause();
    else this.play();
  }

  /** Seeks the current playlist to `timeUs` microseconds, clamped to 0 and its duration. The snapshot's `timeUs` follows from the engine. */
  seek(timeUs: number): void {
    this.post({ type: 'seek', timeUs: Math.min(Math.max(0, timeUs), this.snapshot.durationUs) });
  }

  /** Seeks relative to the last known position, `deltaUs` microseconds (negative goes back). */
  seekBy(deltaUs: number): void {
    this.seek(this.snapshot.timeUs + deltaUs);
  }

  /** Seeks to the next chapter (sends `nextChapter`; the engine refuses it where an HDMV or plain-playlist disc's UO mask forbids skipping; a running BD-J title is not checked). */
  nextChapter(): void {
    this.post({ type: 'nextChapter' });
  }

  /** Seeks to the previous chapter (sends `prevChapter`; refused like `nextChapter`). */
  prevChapter(): void {
    this.post({ type: 'prevChapter' });
  }

  /** Sets the volume, clamped to 0 to 1. Applied on the main thread's audio output; the engine is not told. */
  setVolume(volume: number): void {
    const v = Math.min(Math.max(0, volume), 1);
    this.audio.setVolume(v);
    this.update({ ...this.snapshot, volume: v });
  }

  /** Volume keys: change the level and unmute, so the change is audible. */
  adjustVolume(delta: number): void {
    if (this.snapshot.muted) this.toggleMute();
    this.setVolume(this.snapshot.volume + delta);
  }

  /** Flips mute on the audio output; the volume is kept. */
  toggleMute(): void {
    const muted = !this.snapshot.muted;
    this.audio.setMuted(muted);
    this.update({ ...this.snapshot, muted });
  }

  /**
   * Switches to the audio track with that `index`. Ignored for an unknown or undecodable track or the one already
   * playing. The snapshot's `selectedAudio` changes at once and an `audio-track` notice names the track; the engine's
   * `tracks` event corrects it if the switch is refused.
   */
  selectAudio(index: number): void {
    const track = this.snapshot.audioTracks.find((t) => t.index === index);
    if (!track?.playable || index === this.snapshot.selectedAudio) return;
    this.post({ type: 'selectAudio', index });
    // Shown at once so the next A press moves on; the engine's `tracks` event corrects it if the switch is refused.
    const selected = { ...this.snapshot, selectedAudio: index };
    this.update(withNotice(selected, { code: 'audio-track', message: `Audio: ${trackLabel(track)}` }));
  }

  /** The A key: the next playable track, wrapping around. */
  cycleAudio(): void {
    const playable = this.snapshot.audioTracks.filter((t) => t.playable);
    if (playable.length < 2) return;
    const at = playable.findIndex((t) => t.index === this.snapshot.selectedAudio);
    this.selectAudio(playable[(at + 1) % playable.length].index);
  }

  /**
   * One subtitle choice. Checked against the UO mask like the keys: a change of PG stream is pgChange, turning PG's
   * display on or off is pgEnableDisable (the engine checks the exact register change itself).
   */
  selectSubtitle(choice: SubtitleChoice): void {
    const subs = this.snapshot.subtitles;
    const current = subs?.selected ?? 'off';
    const currentPg = typeof current === 'object' ? current.pg : null;
    if (choice.kind === 'pg' && choice.stream === currentPg) return;
    if (choice.kind !== 'pg' && current === (choice.kind === 'text' ? 'text' : 'off')) return;
    const op: UoOp = choice.kind === 'pg' && currentPg !== null ? 'pgChange' : 'pgEnableDisable';
    const touchesPg = choice.kind === 'pg' || currentPg !== null;
    if (touchesPg && !this.allow(op)) return;
    this.post({ type: 'selectSubtitle', choice });
    // shown at once so the next S press moves on; the engine's `subtitles` event corrects it if the change is refused
    if (subs) {
      const selected = choice.kind === 'pg' ? { pg: choice.stream } : choice.kind === 'text' ? ('text' as const) : ('off' as const);
      this.update({ ...this.snapshot, subtitles: { ...subs, selected } });
    }
  }

  /** The S key: Off → each PG track → the subtitle file → Off. */
  cycleSubtitles(): void {
    const subs = this.snapshot.subtitles;
    if (!subs) return;
    const order: SubtitleChoice[] = [{ kind: 'off' }, ...subs.pg.map((t): SubtitleChoice => ({ kind: 'pg', stream: t.index })), ...(subs.text ? [{ kind: 'text' } as const] : [])];
    if (order.length < 2) return;
    const sel = subs.selected;
    const at = order.findIndex((c) => (c.kind === 'pg' ? typeof sel === 'object' && sel.pg === c.stream : c.kind === sel));
    this.selectSubtitle(order[(at + 1) % order.length]!);
  }

  /** Loads one subtitle file as the text set; see `loadSubtitleFiles`. */
  async loadSubtitleFile(file: File, encoding?: string): Promise<void> {
    await this.loadSubtitleFiles([file], encoding);
  }

  /**
   * A pick or drop: its subtitle files become the set (sent with its fonts, every buffer transferred); a pick of
   * fonts alone adds them to an ASS set. `encoding` answers an encoding prompt.
   */
  async loadSubtitleFiles(files: readonly File[], encoding?: string): Promise<void> {
    const fonts = splitPick(files).fonts;
    const subtitles = pickedSubtitles(files);
    if (!subtitles.length) {
      if (fonts.length && this.snapshot.subtitles?.text?.files.some((f) => f.format === 'ass')) await this.addSubtitleFonts(fonts);
      return;
    }
    if (subtitles.some((f) => f.size > MAX_SUBTITLE_FILE_BYTES)) {
      this.update(withNotice(this.snapshot, { code: 'subtitle-file', message: 'This file is too large to be a subtitle file' }));
      return;
    }
    let picked = subtitles;
    if (picked.length > MAX_SUBTITLE_FILES) {
      picked = picked.slice(0, MAX_SUBTITLE_FILES);
      this.update(withNotice(this.snapshot, { code: 'subtitle-file', message: `Only the first ${MAX_SUBTITLE_FILES} subtitle files were loaded` }));
    }
    const fontData = await this.readFonts(fonts);
    this.pendingSubtitleLoad = [...picked, ...fonts];
    const fileData = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
    const transfer = [...fileData, ...fontData].map((d) => d.bytes);
    this.post({ type: 'addTextSubtitles', files: fileData, ...(fontData.length ? { fonts: fontData } : {}), ...(encoding !== undefined ? { encoding } : {}) }, transfer);
  }

  /** More fonts for the set's ASS files. */
  async addSubtitleFonts(files: readonly File[]): Promise<void> {
    const fonts = await this.readFonts(splitPick(files).fonts);
    if (fonts.length) this.post({ type: 'addSubtitleFonts', fonts }, fonts.map((f) => f.bytes));
  }

  /** Font files within the size limits; the rest are skipped with a notice naming them. */
  private async readFonts(files: readonly File[]): Promise<{ name: string; bytes: ArrayBuffer }[]> {
    const kept: File[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const f of files) {
      if (f.size > MAX_FONT_BYTES || total + f.size > MAX_FONTS_BYTES) skipped.push(f.name);
      else {
        kept.push(f);
        total += f.size;
      }
    }
    if (skipped.length) this.update(withNotice(this.snapshot, { code: 'subtitle-fonts', message: `Fonts over the size limit were skipped: ${skipped.join(', ')}` }));
    return Promise.all(kept.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
  }

  /** Places a file of the text set at a playlist time in microseconds (null: not placed, so the file shows nowhere). */
  setSubtitleStart(file: number, startUs: number | null): void {
    this.post({ type: 'setSubtitleStart', file, startUs });
  }

  /** How many times the encoding prompt was cancelled: a load waiting on its answer can tell it won't come. */
  get encodingCancels(): number {
    return this.cancels;
  }

  /** The encoding prompt's answer; null cancels. */
  async answerEncoding(encoding: string | null): Promise<void> {
    const load = this.pendingSubtitleLoad;
    this.pendingSubtitleLoad = null;
    if (encoding === null) this.cancels++;
    this.update({ ...this.snapshot, encodingPrompt: null });
    if (encoding !== null && load) await this.loadSubtitleFiles(load, encoding);
  }

  /** Removes the whole text subtitle set (sends `removeTextSubtitle`). */
  removeSubtitleFile(): void {
    this.post({ type: 'removeTextSubtitle' });
  }

  /** The `[` and `]` keys move the showing subtitle file's cues by `deltaMs`, with a short notice of the new offset. */
  shiftSubtitles(deltaMs: number): void {
    const subs = this.snapshot.subtitles;
    const text = subs?.text;
    if (!subs || !text) return;
    const file = this.snapshot.telemetry?.textFile ?? (text.files.length === 1 ? 0 : null);
    if (file !== null) this.shiftSubtitleFile(file, deltaMs);
  }

  /** Moves one file of the set by `deltaMs`, with a short notice of its new offset. */
  shiftSubtitleFile(file: number, deltaMs: number): void {
    const subs = this.snapshot.subtitles;
    const text = subs?.text;
    const current = text?.files[file];
    if (!subs || !text || !current) return;
    const offsetMs = Math.max(-MAX_SUBTITLE_OFFSET_MS, Math.min(MAX_SUBTITLE_OFFSET_MS, current.offsetMs + deltaMs));
    this.post({ type: 'setSubtitleOffset', file, ms: offsetMs });
    const files = text.files.map((f, i) => (i === file ? { ...f, offsetMs } : f));
    this.update(withNotice({ ...this.snapshot, subtitles: { ...subs, text: { ...text, files } } }, { code: 'subtitle-offset', message: `Subtitles ${formatSubtitleOffset(offsetMs)}` }));
  }

  /** Changes the text subtitle scale by `delta`, clamped to the scale limits and rounded to one decimal; ignored without a text set. */
  scaleSubtitles(delta: number): void {
    const subs = this.snapshot.subtitles;
    if (!subs?.text) return;
    const scale = Math.round(Math.max(MIN_SUBTITLE_SCALE, Math.min(MAX_SUBTITLE_SCALE, subs.scale + delta)) * 10) / 10;
    this.post({ type: 'setSubtitleScale', scale });
    this.update({ ...this.snapshot, subtitles: { ...subs, scale } });
  }

  /** The page is going away: a BD-J disc's saved data is stored now rather than after its debounce. */
  flushSaves(): void {
    this.post({ type: 'flushSaves' });
  }

  /** The page was hidden or shown (document.hidden): a BD-J title's start-up timeout counts only visible time. */
  setVisibility(hidden: boolean): void {
    this.post({ type: 'visibility', hidden });
  }

  /** Tells the engine which memory limits to use (sent once, before a disc opens). */
  setMemoryProfile(profile: MemoryProfileName): void {
    this.post({ type: 'setMemoryProfile', profile });
  }

  /** Applies a shader set to the video; null turns shaders off. */
  setShaderSet(set: ShaderSetData | null): void {
    this.post({ type: 'setVideoShaders', set });
  }

  /** An index title of an HDMV disc (its movie object decides what plays). */
  playTitle(title: number): void {
    this.startAudio();
    this.post({ type: 'playTitle', title });
  }

  /** Top Menu. */
  menuCall(): void {
    this.startAudio();
    this.post({ type: 'menuCall' });
  }

  /** Whether the disc's current UO mask forbids `op`. */
  isMasked(op: UoOp): boolean {
    return this.snapshot.uoMask.includes(op);
  }

  /** False (with the engine's notice, shown at once) if the disc masks `op`; the engine still checks every command itself. */
  allow(op: UoOp): boolean {
    if (!this.isMasked(op)) return true;
    this.update(withNotice(this.snapshot, { code: 'uo-masked', message: UO_MASKED_MESSAGE }));
    return false;
  }

  /** `repeat`: a held key's auto-repeat. */
  menuKey(key: MenuKey, repeat = false): void {
    this.post(repeat ? { type: 'menuKey', key, repeat } : { type: 'menuKey', key });
  }

  /** (x, y) in the 1920×1080 menu space. */
  pointer(kind: 'move' | 'click', x: number, y: number): void {
    this.post({ type: 'pointer', kind, x, y });
  }

  /** Removes the notice with that code. */
  dismissNotice(code: string): void {
    this.update({ ...this.snapshot, notices: this.snapshot.notices.filter((n) => n.code !== code) });
  }

  /** Closes the open disc (sends `close`) and resets the snapshot, keeping volume, mute and the cache flag. */
  closeDisc(): void {
    this.opens++;
    this.refreshToken = null;
    this.supersedeServings();
    this.post({ type: 'close' });
    this.update({ ...INITIAL_SNAPSHOT, volume: this.snapshot.volume, muted: this.snapshot.muted, readAheadCache: this.snapshot.readAheadCache });
  }

  private post(cmd: EngineCommand, transfer: Transferable[] = []): void {
    this.worker.postMessage(cmd, transfer);
  }

  private update(next: PlayerSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
