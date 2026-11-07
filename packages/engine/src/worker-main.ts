/*
 * Original code for bluray-web: the engine worker's body. startEngineWorker builds the Player with the browser's
 * decoders, compositor, shaders and ASS fonts and answers the page's commands. A host that brings BD-J passes a
 * BdjProvider (the app's src/engine-worker.ts); the package's own entry (worker.ts) passes none.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { readFontFile } from '@seikou/ass/font-tables';
import { createFontFaceLoader } from '@seikou/ass/fonts';
import { createCanvasMeasurer } from '@seikou/ass/measure';
import { drawWarped } from '@seikou/ass/warp';
import type { BdjProvider } from './bdj-provider';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import { loadAudioWasm } from './decode/wasm-audio';
import { browserVideoCodecApi } from './decode/video-decoder';
import { playerSettingsForLocale } from './disc/player-settings';
import { Player } from './player';
import type { EngineCommand, EngineEvent } from './protocol';
import { Compositor } from './render/compositor';
import { createWebGlBackend } from './shaders/webgl-backend';

export interface WorkerScope {
  postMessage(message: EngineEvent): void;
  onmessage: ((event: MessageEvent<EngineCommand>) => void) | null;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
}

/**
 * Test-only (E2E) flags the page puts in the worker's name, 'bluray-engine:<flag>,<flag>' (the app's createController
 * call, from the page's query, like ?telemetry=1):
 * - bdjfail (?bdjfail=1): the libbluray jar is unreadable, so every BD-J boot fails and the fallback (spec §5) can be
 *   seen in the browser (read by the app's worker entry);
 * - nonestedworkers (?nonestedworkers=1): the worker behaves as if it could not start workers, so the capability
 *   fallback (spec m5d §4.5) can be seen in a browser that has them (read by the app's worker entry);
 * - nodecoder (?nodecoder=1): the browser supports no video decoder configuration, so a decoder that fails to configure
 *   (UnsupportedCodecError) can be seen in any browser;
 * - telemetry (?telemetry=1): telemetry carries the BD-J plane's settled hash (PlayerDeps.planeHashTelemetry) and BD-J's
 *   memory (PlayerDeps.memoryTelemetry).
 */
export function engineWorkerTestFlags(): ReadonlySet<string> {
  return new Set(((self as unknown as { name?: string }).name ?? '').split(':')[1]?.split(',') ?? []);
}

/** The wait for an asset the worker fetches: the audio wasm, the default font (and a provider's class library jars). */
export const ASSET_FETCH_TIMEOUT_MS = 20_000;

export interface EngineWorkerOptions {
  /** BD-J; without it, BD-J discs and titles open to the playlist picker (bdj-provider.ts). */
  readonly bdj?: BdjProvider;
  /** audio.wasm's URL (`@seikou/engine/audio.wasm?url`). */
  readonly audioWasmUrl: string;
  /** The default ASS font's URL (`@seikou/ass/default-font.ttf?url`). */
  readonly defaultFontUrl: string;
  /** The worker's global (default: self). */
  readonly scope?: WorkerScope;
}

/** Starts the engine in this worker: a Player that answers the page's commands. */
export function startEngineWorker(options: EngineWorkerOptions): Player {
  const { bdj, audioWasmUrl, defaultFontUrl } = options;
  const scope = options.scope ?? (self as unknown as WorkerScope);
  const testFlags = engineWorkerTestFlags();
  const player = new Player({
    emit: (event) => scope.postMessage(event),
    videoCodecApi: testFlags.has('nodecoder') ? { ...browserVideoCodecApi, isConfigSupported: async (config) => ({ supported: false, config }) } : browserVideoCodecApi,
    nowMs: () => performance.now(),
    requestFrame: (callback) => {
      if (scope.requestAnimationFrame) scope.requestAnimationFrame(() => callback());
      else setTimeout(callback, 16);
    },
    createCompositor: (canvas) => new Compositor(canvas),
    // WebGL2 on its own OffscreenCanvas, created when the first shader set is chosen
    createShaderBackend: (events) => createWebGlBackend((w, h) => new OffscreenCanvas(w, h), events),
    // Commands run one at a time, so a stalled download would block every later one: give up and report it instead.
    createAudioDecoder: createAudioDecoderFactory(() => loadAudioWasm(fetch(audioWasmUrl, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) }))),
    planeHashTelemetry: testFlags.has('telemetry'),
    memoryTelemetry: testFlags.has('telemetry'),
    ...(bdj ? { bdj } : {}),
    // buffer first: a NAS disc's on-disk read-ahead cache, written through sync access handles (dedicated workers only)
    ...(readAheadCacheSupported() ? { readAheadCacheRoot: () => navigator.storage.getDirectory() } : {}),
    // bd_set_player_setting_str as a player application sets it: the browser's language and region
    playerSettings: playerSettingsForLocale(navigator.language),
    bdjLog: (line, error) => (error ? console.warn : console.debug)(`[BD-J] ${line}`),
    log: (line) => console.info(`[engine] ${line}`),
    // ASS: fonts in the worker's FontFaceSet, DejaVu Sans as the default font (libass's fallback in our harness)
    createAssDeps: async () => {
      const response = await fetch(defaultFontUrl, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
      const defaultFont = await readFontFile('DejaVuSans.ttf', new Uint8Array(await response.arrayBuffer()));
      return {
        loader: createFontFaceLoader((self as unknown as { fonts: FontFaceSet }).fonts),
        defaultFont,
        measurer: createCanvasMeasurer(new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!),
        createCanvas: (w, h) => new OffscreenCanvas(w, h),
        Path2D,
        canvasFilter: supportsCanvasFilter(),
        warp: drawWarped,
      };
    },
  });

  scope.onmessage = (event) => {
    void player.handle(event.data);
  };
  void player.startReadAheadCache();
  return player;
}

/** OPFS with sync access handles (dedicated workers), which the read-ahead cache writes through. */
function readAheadCacheSupported(): boolean {
  const fileHandle = (self as unknown as { FileSystemFileHandle?: { prototype: Record<string, unknown> } }).FileSystemFileHandle;
  return typeof navigator.storage?.getDirectory === 'function' && typeof fileHandle?.prototype.createSyncAccessHandle === 'function';
}

/** Whether a 2D canvas applies `ctx.filter` (Safari ignores it): a blurred dot must spread to its neighbour. */
function supportsCanvasFilter(): boolean {
  try {
    const canvas = new OffscreenCanvas(9, 9);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.filter = 'blur(2px)';
    ctx.fillStyle = '#fff';
    ctx.fillRect(4, 4, 1, 1);
    return ctx.getImageData(5, 4, 1, 1).data[3]! > 0;
  } catch {
    return false;
  }
}
