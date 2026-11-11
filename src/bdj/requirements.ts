/*
 * Original code for Seikou: what a browser needs to run BD-J, named for the user (the BD-J menus spec,
 * docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md, lists the same features). The engine
 * worker checks its own global before it offers BD-J (worker.ts); the page's capability report (src/ui/capabilities.ts)
 * checks the page's, which cannot see whether a worker may start workers.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

type Bag = Record<string, unknown>;

/** The features BD-J needs, each with the name the user is shown when it is missing. */
export const BDJ_REQUIREMENTS = {
  /** The register file, status block and graphics plane are shared with the BD-J worker. */
  sharedMemory: 'cross-origin isolation (SharedArrayBuffer)',
  /** The BD-J worker waits for the graphics plane's lock (graphics-plane.ts). */
  atomicsWait: 'Atomics.wait in workers',
  /** The engine worker starts the BD-J worker. */
  nestedWorkers: 'workers started from workers',
  /** FreeType (src/wasm/freetype). */
  webAssembly: 'WebAssembly',
  /** The engine worker draws the BD-J plane through an OffscreenCanvas. */
  offscreenCanvas: 'OffscreenCanvas',
} as const;

/** Where bdjMissing runs. */
export interface BdjRequirementOptions {
  /**
   * `g` is a worker's global, where Atomics.wait may be called: it is tried with a 0 ms timeout. On a page's main
   * thread (false) it always throws, so only its presence is checked.
   */
  readonly inWorker?: boolean;
}

/** The names (BDJ_REQUIREMENTS) of what `g` lacks to run BD-J, in a fixed order; empty when nothing is missing. */
export function bdjMissing(g: Bag, opts: BdjRequirementOptions = {}): string[] {
  const missing: string[] = [];
  const sab = typeof g.SharedArrayBuffer === 'function' && g.crossOriginIsolated === true;
  if (!sab) missing.push(BDJ_REQUIREMENTS.sharedMemory);
  if (!atomicsWaits(g, sab, opts.inWorker === true)) missing.push(BDJ_REQUIREMENTS.atomicsWait);
  if (typeof g.Worker !== 'function') missing.push(BDJ_REQUIREMENTS.nestedWorkers);
  const wasm = g.WebAssembly as Bag | undefined;
  if (typeof wasm !== 'object' || wasm === null || typeof wasm.instantiate !== 'function') missing.push(BDJ_REQUIREMENTS.webAssembly);
  if (typeof g.OffscreenCanvas !== 'function') missing.push(BDJ_REQUIREMENTS.offscreenCanvas);
  return missing;
}

function atomicsWaits(g: Bag, sab: boolean, inWorker: boolean): boolean {
  const atomics = g.Atomics as { wait?: unknown } | undefined;
  if (typeof atomics !== 'object' || atomics === null || typeof atomics.wait !== 'function') return false;
  if (!inWorker || !sab) return true;
  try {
    const cell = new Int32Array(new (g.SharedArrayBuffer as typeof SharedArrayBuffer)(4));
    return (atomics.wait as typeof Atomics.wait)(cell, 0, 0, 0) === 'timed-out';
  } catch {
    return false;
  }
}

/** The notice for a disc (or title) whose BD-J this browser cannot run (the engine's, bdj-provider.ts). */
export { bdjUnsupportedMessage } from '@seikou/engine/bdj-provider';
