// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The page's one Seikou engine. The controller (and with it the engine worker and its audio output) is made the first
 * time the line-up step asks for it and kept for the page's life, so leaving the step and coming back finds the disc
 * where it was. `showAt` opens the disc the first time and seeks after that.
 */
import { useState } from 'react';
import { createController, createEngineWorker, type PlayerController } from '@seikou/engine';
import type { RemoteDiscSpec } from '@seikou/engine';

/**
 * The part of the engine's controller the helper uses. Components take this rather than the class, so tests can
 * stand in for the engine, which needs a worker, WebCodecs and an AudioWorklet that jsdom has none of.
 */
export type PlayerLike = Pick<
  PlayerController,
  | 'subscribe'
  | 'getSnapshot'
  | 'attachCanvas'
  | 'resize'
  | 'startAudio'
  | 'play'
  | 'pause'
  | 'seek'
  | 'openRemote'
  | 'loadSubtitleFiles'
  | 'setSubtitleStart'
  | 'shiftSubtitleFile'
>;

/** The controller made for this page; null until the line-up step first needs it. */
let pageController: PlayerController | null = null;

/**
 * The page's controller, made on first use with the engine's own worker (no BD-J: a BD-J disc's playlist still
 * plays, which is all the helper needs) and the desktop memory profile. Every later call answers the same one.
 */
export function useController(): PlayerController {
  const [controller] = useState(() => {
    pageController ??= createController({ worker: () => createEngineWorker('seikou-encode-engine'), profile: 'desktop' });
    return pageController;
  });
  return controller;
}

/** The disc and playlist to show: a helper session has both, and so does a library disc's playlist. */
export interface ShownPlaylist {
  /** The disc's key, as the backend's disc routes name it. */
  readonly discKey: string;
  /** Five-digit playlist name. */
  readonly playlistId: string;
}

/** The part of a backend client `showAt` needs: the engine's way into a disc. */
export interface DiscOpener {
  /** What the engine needs to read the disc `discKey`. */
  remoteDisc(discKey: string): Promise<RemoteDiscSpec>;
}

/**
 * What a controller has open: the disc and playlist, and the open in flight or done. A failed open is forgotten, so
 * the next call tries again.
 */
const opens = new WeakMap<PlayerLike, { readonly id: string; readonly opening: Promise<void> }>();

/**
 * Shows the disc's playlist at `timeUs` (microseconds of playlist time). The first call for a controller fetches the
 * disc's manifest and opens it there, playing the playlist directly (no disc menus); later calls for the same disc
 * and playlist wait for that open and seek, and a call for another one opens that instead. Rejects with the `ApiError` of a manifest that could not be fetched.
 */
export async function showAt(controller: PlayerLike, api: DiscOpener, shown: ShownPlaylist, timeUs: number): Promise<void> {
  const id = `${shown.discKey}|${shown.playlistId}`;
  const open = opens.get(controller);
  if (open?.id === id) {
    await open.opening;
    controller.seek(timeUs);
    return;
  }
  // The engine gives a playlist sound only when its audio output is attached before the playlist starts, so the
  // output is started, and waited for, before the disc opens.
  const opening = Promise.all([api.remoteDisc(shown.discKey), controller.startAudio()]).then(([spec]) => {
    controller.openRemote(spec, undefined, undefined, undefined, { playlistId: shown.playlistId, timeUs, hdmv: null, playback: null });
  });
  opens.set(controller, { id, opening });
  try {
    await opening;
  } catch (e) {
    opens.delete(controller);
    throw e;
  }
}
