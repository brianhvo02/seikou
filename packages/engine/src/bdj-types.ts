/*
 * Original code for bluray-web: the shapes the engine and BD-J share. BD-J (the app's src/bdj) is an optional provider of
 * the engine (bdj-provider.ts); these are the types its modules implement and the engine is written against, declared
 * here so the engine never imports BD-J. The BD-J modules import (and re-export) them from here.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { DiscSpec } from './disc/disc-spec';
import type { DiscModel } from './disc/open-disc';
import type { RegisterFile } from './hdmv/registers';
import type { UoMask, UoOp } from './hdmv/uo-mask';
import type { PlayAt } from './nav/navigator';

// ---- playback as a BD-J title drives and hears it (player.ts Player.bdjPort) ----

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

// ---- background stills (bdj/background.ts) ----

/** An HScreenRectangle: part of the screen in normalised coordinates (0 to 1). */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A still that is shown: the decoded image and where on the screen it goes. */
export interface ShownStill {
  readonly image: ImageBitmap;
  readonly rect: ScreenRect;
}

/** Decodes an encoded image (PNG, JPEG, GIF); createImageBitmap in production. */
export type DecodeImage = (bytes: Uint8Array) => Promise<ImageBitmap>;

export interface BackgroundStillDeps {
  readonly decode: DecodeImage;
  /** The still to draw from now on (null: none); called before the previous one is closed. */
  readonly onChange: (still: ShownStill | null) => void;
  readonly onError?: (message: string) => void;
  /**
   * Bytes the decoded stills may take (the memory profile's bdjDecodedImageBytes; default none): a larger still is not
   * shown, and the shown one goes before a replacement decodes if both would not fit.
   */
  readonly maxDecodedBytes?: () => number;
}

/** What the player uses of a BD-J title's background still (bdj/background.ts BackgroundStill). */
export interface BackgroundStillLike {
  readonly current: ShownStill | null;
  readonly decodedBytes: number;
  show(bytes: Uint8Array, rect: ScreenRect): void;
  clear(): void;
}

// ---- the runtime's inputs (bdj/runtime.ts, bdj/jvm/jvm.ts, bdj/errors.ts, bdj/store/bdj-store.ts) ----

export interface ClassLibrarySource {
  readonly rt: Uint8Array;
  readonly libbluray: Uint8Array;
  readonly libblurayAwt: Uint8Array;
}

/** The memory profile's budgets the BD-J worker applies (memory-profile.ts, bdjClassCacheBytes and bdjVfsCacheBytes). */
export interface BdjMemoryBudgets {
  /** Class-file bytes the classes keep: going over is logged once. */
  readonly classBytes: number;
  /** The memory mounts' capacity: a write beyond it fails as on a full disk. */
  readonly vfsBytes: number;
}

/** What the JVM keeps outside its Java heap, in bytes (memory budgets, 5d spec §4.5). */
export interface JvmMemoryStats {
  /** The boot class path's jars. */
  readonly bootJarBytes: number;
  /** Classes defined from class files. */
  readonly classes: number;
  /** Bytes of their class files the classes keep (code, annotations). */
  readonly classFileBytes: number;
  /** Zips Java has open (ZipFile objects of one unchanged file share one), and the archive bytes only they keep. */
  readonly zipHandles: number;
  readonly zipBytes: number;
  /** Files on the memory mounts (/tmp/, /persistent/, /buda/), their allocations and their lengths (what the limit counts). */
  readonly vfsFiles: number;
  readonly vfsBytes: number;
  readonly vfsUsedBytes: number;
  /** /jdk/lib/ files read from rt-bdj.jar. */
  readonly jdkFileBytes: number;
}

export type BdjErrorCode = 'class-not-found' | 'unsatisfied-link' | 'verify' | 'internal';

/**
 * Why a BD-J session's saved data won't last (the viewer's `bdj-storage` notice, ruling R32): a scope kept in memory
 * only, with no copy anywhere (`memory-only`); a write refused for room, by a scope's 16 MB, the NAS's 507 or the VFS's
 * memory cap (`full`); or a NAS put that failed for good, not one still being tried again (`put-failed`).
 */
export type StorageLoss = 'memory-only' | 'full' | 'put-failed';

// ---- the messages between the engine worker and the BD-J worker (bdj/worker-protocol.ts) ----

/**
 * How a queued event may merge with an earlier one once the queue is full: a held key's auto-repeat (`repeat`) or a
 * pointer move (`move`). Other events are never merged or dropped.
 */
export type Coalesce = 'repeat' | 'move';

/** A call argument or reply value; a Java long crosses as a decimal string. */
export type BdjWireValue = number | string | boolean | null;

/** The natives the engine answers; getPlaylistInfoN is answered in the BD-J worker from its own disc model. */
export type BdjCallName =
  | 'selectTitle'
  | 'selectPlaylist'
  | 'seek'
  | 'selectAngle'
  | 'selectRate'
  | 'writeReg'
  | 'soundEffect'
  | 'setVirtualPackage'
  | 'setUOMask'
  | 'setKeyInterest';

export type BdjFailureCode = BdjErrorCode | 'halted' | 'timeout';

export type ToBdj =
  | {
      readonly type: 'boot';
      readonly registers: SharedArrayBuffer;
      readonly status: SharedArrayBuffer;
      /** The graphics plane (graphics-plane.ts) Java's updateGraphicN draws into. */
      readonly plane: SharedArrayBuffer;
      /** Picked files, or a disc on the NAS (or the dev disc server), which the BD-J worker reads with its own RemoteSource. */
      readonly disc: DiscSpec;
      /** The BD-J worker's read-ahead budget for a NAS disc (the memory profile's bdjRemoteReadAheadBytes). */
      readonly readAheadBytes: number;
      readonly discId: string | null;
      readonly classLibrary: ClassLibrarySource;
      /** The memory profile's budgets (none: no limits). */
      readonly memory?: BdjMemoryBudgets;
      /** Report the memory stats (a `memory` message) at once and every this many ms (telemetry runs only). */
      readonly memoryStatsMs?: number;
    }
  /** A fresh session token for a NAS disc; may arrive before the boot. */
  | { readonly type: 'remoteToken'; readonly token: string }
  | { readonly type: 'start'; readonly title: number }
  /** `coalesce`: a key repeat or pointer move, which may merge with the one before it in a full queue (input.ts). */
  | { readonly type: 'event'; readonly ev: number; readonly param: number; readonly coalesce?: Coalesce }
  | { readonly type: 'reply'; readonly id: number; readonly value: number | string }
  /** Log a thread dump (diagnostics), then answer `dumped`. */
  | { readonly type: 'dump'; readonly reason: string }
  /** Save the storage scopes' changes now (the page is going away: pagehide). */
  | { readonly type: 'flush' }
  /** BD-J stops: Java is halted, the storage scopes' changes are saved, then the worker answers `stopped`. */
  | { readonly type: 'stop' };

/** The BD-J worker's boot message. */
export type BdjBootMessage = Extract<ToBdj, { type: 'boot' }>;

export type FromBdj =
  | { readonly type: 'booted'; readonly bootMs: number }
  | { readonly type: 'call'; readonly id: number; readonly name: BdjCallName; readonly args: readonly BdjWireValue[] }
  | { readonly type: 'log'; readonly line: string; readonly error: boolean }
  /** HStillImageBackgroundConfiguration.displayImage: the still's encoded bytes (null: none) and where it goes. */
  | { readonly type: 'background'; readonly image: Uint8Array | null; readonly rect: ScreenRect }
  | { readonly type: 'failed'; readonly code: BdjFailureCode; readonly message: string }
  | { readonly type: 'memory'; readonly jvm: JvmMemoryStats; readonly freeType: { readonly wasmBytes: number; readonly faces: number } | null }
  /** The NAS answered 401: the engine asks the controller for a fresh token and sends it as remoteToken. */
  | { readonly type: 'remoteTokenNeeded' }
  /** The thread dump asked for has been logged. */
  | { readonly type: 'dumped' }
  /** The storage scopes are loaded (sent once, false) and, after that, whether they have changes not saved yet: a stop then waits for `stopped`. */
  | { readonly type: 'unsaved'; readonly unsaved: boolean }
  /**
   * Whether the worker is waiting on its own I/O (a disc read, the storage scopes, FreeType or the fallback font): sent
   * on each change. The start-up timeout does not count that time (Task 7g): a slow link is not a hang.
   */
  | { readonly type: 'io'; readonly pending: boolean }
  /**
   * What the disc saves won't last (ruling R32): sent once per session, at the first loss, and never after a stop or a
   * failure. The engine shows the viewer its `bdj-storage` notice.
   */
  | { readonly type: 'storageLost'; readonly reason: StorageLoss }
  /** The answer to `stop`: the worker can be terminated. */
  | { readonly type: 'stopped' };

/** The BD-J worker as the engine talks to it (a Worker in production). */
export interface WorkerLike {
  /** `transfer`: a boot message's fetch port (bootTransfer). */
  postMessage(message: ToBdj, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<FromBdj>) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/** A BD-J worker started while the disc opens, which a session adopts later (bdj/early-worker.ts EarlyBdjWorker). */
export interface EarlyBdjWorkerLike extends WorkerLike {
  /** The early boot message; false when a boot has already gone out. */
  boot(message: BdjBootMessage): boolean;
}

// ---- the shared memory (bdj/graphics-plane.ts, bdj/status-block.ts) ----

export interface PlaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The engine worker's side of the BD-J graphics plane (bdj/graphics-plane.ts GraphicsPlaneReader). */
export interface GraphicsPlaneReaderLike {
  readonly buffer: SharedArrayBuffer;
  /** The version the last copyDirtyInto that copied anything took; -1 before the first. */
  copiedVersion(): number;
  flushCount(): number;
  version(): number;
  /** A publication not copied yet. */
  pending(): boolean;
  visible(): boolean;
  size(): { readonly width: number; readonly height: number };
  copyDirtyInto(image: ImageData, all?: boolean): PlaneRect | null;
  /** The plane's hash, or null while the writer holds it. */
  tryHash(): string | null;
}

/** The playback state the engine publishes for the BD-J worker (bdj/status-block.ts StatusBlockWriter). */
export interface StatusBlockWriterLike {
  readonly buffer: SharedArrayBuffer;
  setTime45(t: bigint): void;
  setUoMask(bits: bigint): void;
}

// ---- playback events and the host (bdj/events.ts, bdj/player-host.ts) ----

export type BdjEventSink = (ev: number, param: number) => void;

/** The playback events libbluray's player core queues for Java (bdj/events.ts). */
export interface BdjPlaybackEvents {
  /** bd_read_ext: BDJ_EVENT_END_OF_PLAYLIST with PSR_PLAYLIST. */
  readonly endOfPlaylist: (playlist: number) => void;
  /** _playmark_reached: BDJ_EVENT_MARK with the mark index. */
  readonly markReached: (mark: number) => void;
  /** _seek_internal: BDJ_EVENT_SEEK with the media time (45 kHz, playlist-relative). */
  readonly seeked: (mediaTime45: number) => void;
  /** bd_set_rate: BDJ_EVENT_RATE (BLURAY_RATE_PAUSED 0, BLURAY_RATE_NORMAL 90000). */
  readonly rate: (rate: number) => void;
  /** BDJ_EVENT_UO_MASKED with the UO mask index. */
  readonly uoMasked: (uoIndex: number) => void;
}

export interface PlayerBdjHostDeps {
  readonly port: BdjPlaybackPort;
  readonly regs: RegisterFile;
  readonly disc: DiscModel;
  readonly events: BdjPlaybackEvents;
  /** When given, the PSR events of `regs` (bindBdjPsrEvents) go here until dispose(). */
  readonly psrEvents?: BdjEventSink;
  startTitle(title: number): void;
  playHdmvTitle(title: number): boolean;
  /** bd->uo_mask changed (bdpriv_get_uo_mask's bits); called before the call that changed it returns. */
  uoMaskChanged(bits: bigint): void;
}

/** What the player uses of the BD-J title's host (bdj/player-host.ts PlayerBdjHost). */
export interface PlayerBdjHostLike {
  replaceDisc(disc: DiscModel): void;
  dispose(): void;
  readonly uoMask: UoMask;
  isUoMasked(op: UoOp): boolean;
  handle(name: BdjCallName, args: readonly BdjWireValue[]): Promise<number | string>;
  setRate(rate: number): number;
}

// ---- the session (bdj/session.ts) ----

export interface BdjSessionDeps {
  readonly worker: WorkerLike;
  readonly host: Pick<PlayerBdjHostLike, 'handle'>;
  /** The register file's shared buffer (RegisterFile({ shared })). */
  readonly regs: SharedArrayBuffer;
  readonly status: StatusBlockWriterLike;
  /** The graphics plane's shared buffer (createGraphicsPlane). */
  readonly plane: SharedArrayBuffer;
  /** bd_tell_time's position in 45 kHz ticks, published before selectPlaylist and seek reply. */
  readonly time45: () => bigint;
  readonly onFailed: (code: BdjFailureCode, message: string) => void;
  readonly onLog?: (line: string, error: boolean) => void;
  /** A background still Java asked to show (null: none). */
  readonly onBackground?: (image: Uint8Array | null, rect: ScreenRect) => void;
  /**
   * What the disc saves won't last (the worker's `storageLost`, ruling R32): the player shows the `bdj-storage` notice.
   * Never called once the session has stopped.
   */
  readonly onStorageLost?: (reason: StorageLoss) => void;
  /** The worker's NAS reads got a 401: a fresh token is wanted (setToken delivers it). */
  readonly onTokenNeeded?: () => void;
  readonly nowMs: () => number;
  /**
   * The wall clock the start-up timeout is counted on (default Date.now): it goes on while the host sleeps, which is
   * how a sleep shows (ruling R22).
   */
  readonly wallMs?: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /** How long after boot (or the first start) Java has to select a playlist, show a menu or show a background still. */
  readonly selectTimeoutMs?: number;
  /** The page is hidden as the session starts (setHidden changes it): the start-up timeout waits for it to be shown. */
  readonly hidden?: boolean;
  /** The memory profile's BD-J budgets, for the boot message. */
  readonly memory?: BdjMemoryBudgets;
  /** Asks the worker for its memory stats every this many ms (telemetry), which arrive here. */
  readonly memoryStatsMs?: number;
  readonly onMemory?: (stats: Extract<FromBdj, { type: 'memory' }>) => void;
}

/** What the player uses of a BD-J worker's session (bdj/session.ts BdjSession). */
export interface BdjSessionLike {
  boot(disc: DiscSpec, readAheadBytes: number, discId: string | null, classLibrary: ClassLibrarySource): Promise<void>;
  setToken(token: string): void;
  start(title: number): void;
  setHidden(hidden: boolean): void;
  event(ev: number, param: number, coalesce?: Coalesce): void;
  /** A count that changes whenever Java does something (a call, a still). */
  readonly activity: number;
  flush(): void;
  stop(): Promise<void>;
  menuShown(): void;
}

// ---- user input (bdj/input.ts) ----

export interface KeyUoContext {
  /** bd->uo_restriction_level (UoRestriction). */
  readonly level: number;
  /** bd->gc_status & GC_STATUS_POPUP. */
  readonly popupShown: boolean;
}

export type BdjInput =
  /** bd_menu_call: the root menu key, typed. */
  | { readonly kind: 'menuCall' }
  /** The root menu key pressed or released only: nothing happens. */
  | { readonly kind: 'none' }
  /**
   * BDJ_EVENT_VK_KEY with `param`. `uoMasked` is what bd_user_input computes from _get_key_uo_index and _is_uo_masked;
   * under a BD-J title libbluray does not act on it (only its HDMV branch refuses masked keys), and neither does the
   * player.
   */
  | { readonly kind: 'event'; readonly ev: number; readonly param: number; readonly uoMasked: boolean };

export interface TapReactionDeps {
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /**
   * A count that changes whenever the disc reacts: a plane publication (flush, init, close), a control call or register
   * write from Java, a background still. Only its changes matter.
   */
  readonly activity: () => number;
  /** A tap got no reaction within the window; `notice` is true for the first such tap of the current menu. */
  readonly ignored: (notice: boolean) => void;
}

/** The ignored-tap rule (bdj/input.ts TapReactionWatch). */
export interface TapReactionWatchLike {
  menuShown(): void;
  tap(windowMs: number): void;
  cancel(): void;
}

/** Input latency so far: the last and the largest, in ms, and how many inputs were answered. */
export interface InputLatencyStats {
  readonly last: number;
  readonly max: number;
  readonly count: number;
}

/** The responsiveness measure (bdj/input.ts InputLatency). */
export interface InputLatencyLike {
  input(atMs: number, version: number): void;
  presented(atMs: number, version: number): void;
  clearPending(): void;
  readonly stats: InputLatencyStats | null;
}
