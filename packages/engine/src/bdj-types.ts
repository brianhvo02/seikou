/*
 * Original code for Seikou: the shapes the engine and BD-J share. BD-J (the app's src/bdj) is an optional provider of
 * the engine (bdj-provider.ts); these are the types its modules implement and the engine is written against, declared
 * here so the engine never imports BD-J. The BD-J modules import (and re-export) them from here.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
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

/** What a background still needs from its host. */
export interface BackgroundStillDeps {
  /** Decodes the still's encoded bytes. */
  readonly decode: DecodeImage;
  /** The still to draw from now on (null: none); called before the previous one is closed. */
  readonly onChange: (still: ShownStill | null) => void;
  /** Called with a message when a still cannot be decoded or does not fit. */
  readonly onError?: (message: string) => void;
  /**
   * Bytes the decoded stills may take (the memory profile's bdjDecodedImageBytes; default none): a larger still is not
   * shown, and the shown one goes before a replacement decodes if both would not fit.
   */
  readonly maxDecodedBytes?: () => number;
}

/**
 * What the player uses of a BD-J title's background still (bdj/background.ts BackgroundStill).
 * @internal
 */
export interface BackgroundStillLike {
  readonly current: ShownStill | null;
  readonly decodedBytes: number;
  show(bytes: Uint8Array, rect: ScreenRect): void;
  clear(): void;
}

// ---- the runtime's inputs (bdj/runtime.ts, bdj/jvm/jvm.ts, bdj/errors.ts, bdj/store/bdj-store.ts) ----

/** The three jars of the class library the JVM boots from, as bytes: the Java runtime classes (rt-bdj.jar) and libbluray's own Java code and its AWT layer. */
export interface ClassLibrarySource {
  /** rt-bdj.jar: the Java runtime classes the BD-J stack needs. */
  readonly rt: Uint8Array;
  /** libbluray-j2se.jar: libbluray's Java side of BD-J (the `org.videolan`, `org.bluray`, `org.dvb`, `org.havi` and `javax.tv` classes). */
  readonly libbluray: Uint8Array;
  /** libbluray-awt-j2se.jar: libbluray's `java.awt`, `sun.awt` and `sun.font` classes, which draw into the BD-J plane. */
  readonly libblurayAwt: Uint8Array;
}

/** The memory profile's budgets the BD-J worker applies (memory-profile.ts, bdjClassCacheBytes and bdjVfsCacheBytes). */
export interface BdjMemoryBudgets {
  /** Class-file bytes the classes keep: going over is logged once. */
  readonly classBytes: number;
  /** The memory mounts' capacity: a write beyond it fails as on a full disk. */
  readonly vfsBytes: number;
}

/**
 * What the JVM keeps outside its Java heap, in bytes, as the BD-J worker accounts it. The constrained memory profile's
 * BD-J budgets (bdjClassCacheBytes, bdjVfsCacheBytes) were set from these numbers measured on a desktop and then on
 * phones and tablets.
 */
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

/** What went wrong when BD-J failed: a class the library lacks, a native method missing, a class that failed verification, or an error in the JVM itself. */
export type BdjErrorCode = 'class-not-found' | 'unsatisfied-link' | 'verify' | 'internal';

/**
 * Why a BD-J session's saved data won't last (the viewer gets the `bdj-storage` notice, once per disc open): a scope kept in memory
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

/** Why a BD-J session was given up: a BdjErrorCode, `halted` (the JVM exited, as Java's `System.exit` does), or `timeout` (Java did not select a playlist, show a menu or show a still within the start-up timeout). */
export type BdjFailureCode = BdjErrorCode | 'halted' | 'timeout';

/**
 * Messages from the engine worker to the BD-J worker. The BD-J worker is started once per BD-J title run; `boot` goes
 * first, and it answers with `booted`.
 */
export type ToBdj =
  /** Starts the JVM from the class library with the shared memory and the disc. */
  | {
      readonly type: 'boot';
      /** The register file (PSRs and GPRs) shared with the engine, read and written by Java synchronously. */
      readonly registers: SharedArrayBuffer;
      /** The playback status block: the playback time in 45 kHz ticks and the UO mask, written by the engine. */
      readonly status: SharedArrayBuffer;
      /** The graphics plane (graphics-plane.ts) Java's updateGraphicN draws into. */
      readonly plane: SharedArrayBuffer;
      /** Picked files, or a disc on the NAS (or the dev disc server), which the BD-J worker reads with its own RemoteSource. */
      readonly disc: DiscSpec;
      /** The BD-J worker's read-ahead budget for a NAS disc (the memory profile's bdjRemoteReadAheadBytes). */
      readonly readAheadBytes: number;
      /** The 32-hex disc id from `id.bdmv`, or null for a disc without one (its saved data is then kept under a fingerprint of its files). */
      readonly discId: string | null;
      readonly classLibrary: ClassLibrarySource;
      /** The memory profile's budgets (none: no limits). */
      readonly memory?: BdjMemoryBudgets;
      /** Report the memory stats (a `memory` message) at once and every this many ms (telemetry runs only). */
      readonly memoryStatsMs?: number;
    }
  /** A fresh session token for a NAS disc; may arrive before the boot. */
  | { readonly type: 'remoteToken'; readonly token: string }
  /** Starts a BD-J title (an index title number) once booted: libbluray's BDJ_EVENT_START. */
  | { readonly type: 'start'; readonly title: number }
  /** `coalesce`: a key repeat or pointer move, which may merge with the one before it in a full queue (input.ts). */
  | { readonly type: 'event'; readonly ev: number; readonly param: number; readonly coalesce?: Coalesce }
  /** The engine's answer to a `call` of that id (a Java long as a decimal string). */
  | { readonly type: 'reply'; readonly id: number; readonly value: number | string }
  /** Log a thread dump (diagnostics), then answer `dumped`. */
  | { readonly type: 'dump'; readonly reason: string }
  /** Save the storage scopes' changes now (the page is going away: pagehide). */
  | { readonly type: 'flush' }
  /** BD-J stops: Java is halted, the storage scopes' changes are saved, then the worker answers `stopped`. */
  | { readonly type: 'stop' };

/** The BD-J worker's boot message. */
export type BdjBootMessage = Extract<ToBdj, { type: 'boot' }>;

/** Messages from the BD-J worker to the engine worker. */
export type FromBdj =
  /** The JVM booted; `bootMs` is the time it took in the worker. */
  | { readonly type: 'booted'; readonly bootMs: number }
  /** Java called a native the engine answers (libbluray's `bdj_*` host calls); the engine replies with a `reply` of the same `id`. */
  | { readonly type: 'call'; readonly id: number; readonly name: BdjCallName; readonly args: readonly BdjWireValue[] }
  /** A line of Java's output (System.out, or `error` for System.err and uncaught exceptions). */
  | { readonly type: 'log'; readonly line: string; readonly error: boolean }
  /** HStillImageBackgroundConfiguration.displayImage: the still's encoded bytes (null: none) and where it goes. */
  | { readonly type: 'background'; readonly image: Uint8Array | null; readonly rect: ScreenRect }
  /** The boot or the JVM failed; the session is over. */
  | { readonly type: 'failed'; readonly code: BdjFailureCode; readonly message: string }
  /** The memory stats asked for in the boot message (`memoryStatsMs`). */
  | { readonly type: 'memory'; readonly jvm: JvmMemoryStats; readonly freeType: { readonly wasmBytes: number; readonly faces: number } | null }
  /** The NAS answered 401: the engine asks the controller for a fresh token and sends it as remoteToken. */
  | { readonly type: 'remoteTokenNeeded' }
  /** The thread dump asked for has been logged. */
  | { readonly type: 'dumped' }
  /** The storage scopes are loaded (sent once, false) and, after that, whether they have changes not saved yet: a stop then waits for `stopped`. */
  | { readonly type: 'unsaved'; readonly unsaved: boolean }
  /**
   * Whether the worker is waiting on its own I/O (a disc read, the storage scopes, FreeType or the fallback font): sent
   * on each change. The start-up timeout does not count that time (up to 120 s in all per boot), because on a slow
   * link a disc's first reads can take longer than the 20 s limit without the disc being hung.
   */
  | { readonly type: 'io'; readonly pending: boolean }
  /**
   * What the disc saves won't last: sent once per session, at the first loss, and never after a stop or a failure. The
   * engine shows the viewer its `bdj-storage` notice.
   */
  | { readonly type: 'storageLost'; readonly reason: StorageLoss }
  /** The answer to `stop`: the worker can be terminated. */
  | { readonly type: 'stopped' };

/**
 * The BD-J worker as the engine talks to it (a Worker in production).
 * @internal
 */
export interface WorkerLike {
  /** `transfer`: a boot message's fetch port (bootTransfer). */
  postMessage(message: ToBdj, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<FromBdj>) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/**
 * A BD-J worker started while the disc opens, which a session adopts later (bdj/early-worker.ts EarlyBdjWorker).
 * @internal
 */
export interface EarlyBdjWorkerLike extends WorkerLike {
  /** The early boot message; false when a boot has already gone out. */
  boot(message: BdjBootMessage): boolean;
}

// ---- the shared memory (bdj/graphics-plane.ts, bdj/status-block.ts) ----

/** A rectangle of the BD-J graphics plane in plane pixels (the plane is 1920×1080), origin at its top left. */
export interface PlaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The engine worker's side of the BD-J graphics plane (bdj/graphics-plane.ts GraphicsPlaneReader).
 * @internal
 */
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

/**
 * The playback state the engine publishes for the BD-J worker (bdj/status-block.ts StatusBlockWriter).
 * @internal
 */
export interface StatusBlockWriterLike {
  readonly buffer: SharedArrayBuffer;
  setTime45(t: bigint): void;
  setUoMask(bits: bigint): void;
}

// ---- playback events and the host (bdj/events.ts, bdj/player-host.ts) ----

/** Delivers an event to Java's event queue: `ev` is a libbluray `BDJ_EVENT_*` number, `param` its argument. */
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

/** What the BD-J host (the object answering Java's calls) needs from the player. */
export interface PlayerBdjHostDeps {
  /** How the title drives playback. */
  readonly port: BdjPlaybackPort;
  /** The title's register file, shared with the BD-J worker. */
  readonly regs: RegisterFile;
  /** The disc's parsed model (playlists, index). */
  readonly disc: DiscModel;
  /** Where playback events for Java go. */
  readonly events: BdjPlaybackEvents;
  /** When given, the PSR events of `regs` (bindBdjPsrEvents) go here until dispose(). */
  readonly psrEvents?: BdjEventSink;
  /** Java selected a BD-J title: the player sends the worker `start` for it (held until the worker has booted). */
  startTitle(title: number): void;
  /** Java selected an HDMV title: BD-J stops and the HDMV navigator runs it on the same registers. Returns false when the disc has no HDMV objects or the title cannot start. */
  playHdmvTitle(title: number): boolean;
  /** bd->uo_mask changed (bdpriv_get_uo_mask's bits); called before the call that changed it returns. */
  uoMaskChanged(bits: bigint): void;
}

/**
 * What the player uses of the BD-J title's host (bdj/player-host.ts PlayerBdjHost).
 * @internal
 */
export interface PlayerBdjHostLike {
  replaceDisc(disc: DiscModel): void;
  dispose(): void;
  readonly uoMask: UoMask;
  isUoMasked(op: UoOp): boolean;
  handle(name: BdjCallName, args: readonly BdjWireValue[]): Promise<number | string>;
  setRate(rate: number): number;
}

// ---- the session (bdj/session.ts) ----

/** What a BD-J session (the engine's side of one BD-J worker) is built from. */
export interface BdjSessionDeps {
  /** The BD-J worker. */
  readonly worker: WorkerLike;
  /** Answers the worker's calls. */
  readonly host: Pick<PlayerBdjHostLike, 'handle'>;
  /** The register file's shared buffer (RegisterFile({ shared })). */
  readonly regs: SharedArrayBuffer;
  /** Writes the playback time and UO mask for the worker. */
  readonly status: StatusBlockWriterLike;
  /** The graphics plane's shared buffer (createGraphicsPlane). */
  readonly plane: SharedArrayBuffer;
  /** bd_tell_time's position in 45 kHz ticks, published before selectPlaylist and seek reply. */
  readonly time45: () => bigint;
  /** The session is over because boot or the JVM failed, or the start-up timeout ran out (the player then falls back to the playlist picker). */
  readonly onFailed: (code: BdjFailureCode, message: string) => void;
  /** Receives each line Java logs. */
  readonly onLog?: (line: string, error: boolean) => void;
  /** A background still Java asked to show (null: none). */
  readonly onBackground?: (image: Uint8Array | null, rect: ScreenRect) => void;
  /**
   * What the disc saves won't last (the worker's `storageLost`): the player shows the `bdj-storage` notice. Never
   * called once the session has stopped.
   */
  readonly onStorageLost?: (reason: StorageLoss) => void;
  /** The worker's NAS reads got a 401: a fresh token is wanted (setToken delivers it). */
  readonly onTokenNeeded?: () => void;
  /** A monotonic clock in milliseconds (performance.now), for durations. */
  readonly nowMs: () => number;
  /**
   * The wall clock the start-up timeout is counted on (default Date.now). It goes on while the host sleeps, which is
   * how a sleep shows: a timer tick that arrives 5 s or more late means the host slept, and the 20 s start over
   * instead of running out for time Java never had.
   */
  readonly wallMs?: () => number;
  /** A one-shot timer; the returned function cancels it. */
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

/**
 * What the player uses of a BD-J worker's session (the app's `BdjSession`, in `src/bdj/session.ts`).
 * @internal
 */
export interface BdjSessionLike {
  /** Boots the worker: sends the boot message with the disc, the read-ahead size, the disc id and the class library. */
  boot(disc: DiscSpec, readAheadBytes: number, discId: string | null, classLibrary: ClassLibrarySource): Promise<void>;
  /** Passes a fresh session token for a NAS disc to the worker. */
  setToken(token: string): void;
  /** Starts a BD-J title. */
  start(title: number): void;
  /** The page was hidden or shown; hidden time does not count against the start-up timeout. */
  setHidden(hidden: boolean): void;
  /** Queues a key, mouse or other event for Java (`coalesce` lets a full queue merge a key repeat or pointer move into the previous one). */
  event(ev: number, param: number, coalesce?: Coalesce): void;
  /** A count that changes whenever Java does something (a call, a still). */
  readonly activity: number;
  /** Asks the worker to save its storage scopes now (the page is going away). */
  flush(): void;
  /** Stops Java, waits for the storage scopes to be saved (up to a short limit), then terminates the worker. */
  stop(): Promise<void>;
  /** A menu is on screen: the disc is alive, so the start-up timeout stops counting. */
  menuShown(): void;
}

// ---- user input (bdj/input.ts) ----

/** What deciding a key's user operation needs of the player's state. */
export interface KeyUoContext {
  /** bd->uo_restriction_level (UoRestriction). */
  readonly level: number;
  /** bd->gc_status & GC_STATUS_POPUP. */
  readonly popupShown: boolean;
}

/** What a key press means for a BD-J title (libbluray `bd_user_input` for `title_type` bdj). */
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

/** What the ignored-tap rule needs. */
export interface TapReactionDeps {
  /** A one-shot timer; the returned function cancels it. */
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /**
   * A count that changes whenever the disc reacts: a plane publication (flush, init, close), a control call or register
   * write from Java, a background still. Only its changes matter.
   */
  readonly activity: () => number;
  /** A tap got no reaction within the window; `notice` is true for the first such tap of the current menu. */
  readonly ignored: (notice: boolean) => void;
}

/**
 * The ignored-tap rule (bdj/input.ts TapReactionWatch).
 * @internal
 */
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

/**
 * The responsiveness measure (bdj/input.ts InputLatency).
 * @internal
 */
export interface InputLatencyLike {
  input(atMs: number, version: number): void;
  presented(atMs: number, version: number): void;
  clearPending(): void;
  readonly stats: InputLatencyStats | null;
}
