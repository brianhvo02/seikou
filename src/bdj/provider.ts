/*
 * Original code for bluray-web: Seikou's BD-J provider (bdj-provider.ts), assembled from this directory's modules. The
 * app's worker entry passes it to the player as PlayerDeps.bdj.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { BdjProvider } from '@seikou/engine/bdj-provider';
import type { ClassLibrarySource, DecodeImage, WorkerLike } from '@seikou/engine/bdj-types';
import { BackgroundStill } from './background';
import { EarlyBdjWorker } from './early-worker';
import { bdjPlaybackEvents } from './events';
import { GraphicsPlaneReader, createGraphicsPlane } from './graphics-plane';
import { BDJ_EVENT_MOUSE, InputLatency, TapReactionWatch, UoRestriction, bdjMouseParam, bdjUserInput } from './input';
import { PlayerBdjHost } from './player-host';
import { BdjSession } from './session';
import { REGISTER_WORDS } from './shared-registers';
import { StatusBlockWriter, createStatusBlock } from './status-block';

export { bdjMissing } from './requirements';

export interface SeikouBdjOptions {
  /** What this browser lacks to run BD-J (bdjMissing on the engine worker's global). */
  readonly missing: readonly string[];
  /** The class library jars. */
  readonly loadClassLibrary: () => Promise<ClassLibrarySource>;
  /** Decodes a background still (createImageBitmap); without it, background stills are not shown. */
  readonly decodeImage?: DecodeImage;
  /** A new BD-J worker; by default a module Worker running bdj-worker-entry.ts (tests pass their own). */
  readonly createWorker?: () => WorkerLike;
}

/** Seikou's BD-J, for PlayerDeps.bdj. */
export function seikouBdjProvider(options: SeikouBdjOptions): BdjProvider {
  return {
    missing: options.missing,
    // a literal new Worker(new URL(...)) so the bundler builds the BD-J worker as its own chunk
    createWorker: options.createWorker ?? (() => new Worker(new URL('./bdj-worker-entry.ts', import.meta.url), { type: 'module' })),
    loadClassLibrary: options.loadClassLibrary,
    ...(options.decodeImage ? { decodeImage: options.decodeImage } : {}),
    REGISTER_WORDS,
    createBackgroundStill: (deps) => new BackgroundStill(deps),
    playbackEvents: bdjPlaybackEvents,
    createPlayerHost: (deps) => new PlayerBdjHost(deps),
    createEarlyWorker: (worker) => new EarlyBdjWorker(worker),
    createGraphicsPlane: () => new GraphicsPlaneReader(createGraphicsPlane()),
    createStatusBlock: () => new StatusBlockWriter(createStatusBlock()),
    createSession: (deps) => new BdjSession(deps),
    input: {
      BDJ_EVENT_MOUSE,
      UoRestriction,
      bdjMouseParam,
      bdjUserInput,
      createTapReactionWatch: (deps) => new TapReactionWatch(deps),
      createInputLatency: () => new InputLatency(),
    },
  };
}
