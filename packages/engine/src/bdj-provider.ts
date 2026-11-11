/*
 * Original code for Seikou: BD-J as an optional provider of the engine. The player takes everything BD-J from a
 * BdjProvider (PlayerDeps.bdj) and never imports BD-J; the app assembles the provider (src/bdj/provider.ts) in
 * its worker entry. Without one, BD-J discs and titles open to the playlist picker with the missing requirement named
 * BDJ_RUNTIME.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * Internal to @seikou/engine: not part of its public API; importable through the package's subpath for Seikou's own use.
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type {
  BackgroundStillDeps,
  BackgroundStillLike,
  BdjEventSink,
  BdjInput,
  BdjPlaybackEvents,
  BdjSessionDeps,
  BdjSessionLike,
  ClassLibrarySource,
  DecodeImage,
  EarlyBdjWorkerLike,
  GraphicsPlaneReaderLike,
  InputLatencyLike,
  KeyUoContext,
  PlayerBdjHostDeps,
  PlayerBdjHostLike,
  StatusBlockWriterLike,
  TapReactionDeps,
  TapReactionWatchLike,
  WorkerLike,
} from './bdj-types';
import type { UoOp } from './hdmv/uo-mask';

/** The BD-J graphics plane's fixed size: the largest BD-J graphics configuration (bdj/graphics-plane.ts). */
export const PLANE_WIDTH = 1920;
/** The BD-J graphics plane's height in pixels (see PLANE_WIDTH). */
export const PLANE_HEIGHT = 1080;

/** The requirement a player without a BD-J provider lacks (PlayerDeps.bdj). */
export const BDJ_RUNTIME = 'BD-J runtime';

/**
 * The notice for a disc (or title) whose BD-J cannot run here: what the browser lacks, or (no provider) that this player
 * has no BD-J, and what to do instead.
 */
export function bdjUnsupportedMessage(missing: readonly string[], what: 'disc' | 'title' = 'disc'): string {
  if (missing.length === 1 && missing[0] === BDJ_RUNTIME) return `This ${what} uses BD-J (Java) menus, which this player does not include. Choose a playlist to play.`;
  return `This ${what} uses BD-J (Java) menus, which this browser can't run: it lacks ${missing.join(', ')}. Choose a playlist to play.`;
}

/** BD-J user input (bdj/input.ts). */
export interface BdjInputProvider {
  /** bdj.h BDJ_EVENT_MOUSE. */
  readonly BDJ_EVENT_MOUSE: number;
  /** bd->uo_restriction_level's levels; the player runs BD-J titles at RELAXED. */
  readonly UoRestriction: { readonly RELAXED: number };
  /** bd_mouse_select's BD-J event parameter for a position. */
  bdjMouseParam(x: number, y: number): number;
  /** bd_user_input under title_type bdj, for `key` (a BD_VK_* code, optionally OR'd with BD_VK_KEY_* flags). */
  bdjUserInput(key: number, ctx: KeyUoContext & { readonly isUoMasked: (op: UoOp) => boolean }): BdjInput;
  /** The ignored-tap rule for one BD-J worker. */
  createTapReactionWatch(deps: TapReactionDeps): TapReactionWatchLike;
  /** The responsiveness measure, one per disc open. */
  createInputLatency(): InputLatencyLike;
}

/**
 * Everything BD-J the engine takes from its host, as factories so the engine never imports BD-J code. The app assembles
 * one in `src/bdj/provider.ts` and passes it to `startEngineWorker`; the engine calls these from the engine worker.
 */
export interface BdjProvider {
  /**
   * What this browser lacks to run BD-J (bdj/requirements.ts bdjMissing on the engine worker's global): when any is
   * missing, BD-J discs and titles open to the picker with a notice naming it.
   */
  readonly missing: readonly string[];
  /** A new BD-J worker (bdj/bdj-worker.ts) for each BD-J session. */
  createWorker(): WorkerLike;
  /** The BD-J class library jars; fetched once, as soon as a BD-J disc is opened. */
  loadClassLibrary(): Promise<ClassLibrarySource>;
  /** Decodes a BD-J background still (createImageBitmap); without it, background stills are not shown. */
  readonly decodeImage?: DecodeImage;
  /** The words of a register file shared with the BD-J worker (bdj/shared-registers.ts). */
  readonly REGISTER_WORDS: number;
  /** The background still under the video, one per player. */
  createBackgroundStill(deps: BackgroundStillDeps): BackgroundStillLike;
  /** The playback events Java hears, sent to `sink` (bdj/events.ts bdjPlaybackEvents). */
  playbackEvents(sink: BdjEventSink): BdjPlaybackEvents;
  /** What answers a BD-J title's calls (bdj/player-host.ts PlayerBdjHost). */
  createPlayerHost(deps: PlayerBdjHostDeps): PlayerBdjHostLike;
  /** Wraps a worker whose boot may go out before a session adopts it (bdj/early-worker.ts EarlyBdjWorker). */
  createEarlyWorker(worker: WorkerLike): EarlyBdjWorkerLike;
  /** A new graphics plane, read on the engine's side. */
  createGraphicsPlane(): GraphicsPlaneReaderLike;
  /** A new status block, written on the engine's side. */
  createStatusBlock(): StatusBlockWriterLike;
  /** The engine side of one BD-J worker (bdj/session.ts BdjSession). */
  createSession(deps: BdjSessionDeps): BdjSessionLike;
  readonly input: BdjInputProvider;
}
