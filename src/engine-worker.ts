// SPDX-License-Identifier: LGPL-2.1-or-later
// The app's engine worker entry: the engine (@seikou/engine/worker-main) with BD-J as its provider.
import audioWasmUrl from '@seikou/engine/audio.wasm?url';
import defaultFontUrl from '@seikou/ass/default-font.ttf?url';
import { ASSET_FETCH_TIMEOUT_MS, engineWorkerTestFlags, startEngineWorker } from '@seikou/engine/worker-main';
import rtJarUrl from './bdj-classlib/rt-bdj.jar?url';
import libblurayJarUrl from './bdj-classlib/libbluray-j2se.jar?url';
import libblurayAwtJarUrl from './bdj-classlib/libbluray-awt-j2se.jar?url';
import { bdjMissing, seikouBdjProvider } from './bdj/provider';

// Test-only flags (engineWorkerTestFlags): bdjfail makes the libbluray jar unreadable, nonestedworkers hides Worker.
const testFlags = engineWorkerTestFlags();
const brokenClassLibrary = testFlags.has('bdjfail');
const g = self as unknown as Record<string, unknown>;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

startEngineWorker({
  audioWasmUrl,
  defaultFontUrl,
  bdj: seikouBdjProvider({
    /** What this browser lacks to run BD-J, seen from this worker (the one that starts the BD-J worker). */
    missing: bdjMissing(
      {
        SharedArrayBuffer: g.SharedArrayBuffer,
        crossOriginIsolated: g.crossOriginIsolated,
        Atomics: g.Atomics,
        Worker: testFlags.has('nonestedworkers') ? undefined : g.Worker,
        WebAssembly: g.WebAssembly,
        OffscreenCanvas: g.OffscreenCanvas,
      },
      { inWorker: true },
    ),
    loadClassLibrary: async () => {
      const [rt, libbluray, libblurayAwt] = await Promise.all([fetchBytes(rtJarUrl), fetchBytes(libblurayJarUrl), fetchBytes(libblurayAwtJarUrl)]);
      return { rt, libbluray: brokenClassLibrary ? new Uint8Array(0) : libbluray, libblurayAwt };
    },
    // BD-J background stills: the browser sniffs the format (PNG, JPEG, GIF) from the bytes
    decodeImage: (bytes) => createImageBitmap(new Blob([new Uint8Array(bytes)])),
  }),
});
