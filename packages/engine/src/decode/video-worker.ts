// SPDX-License-Identifier: LGPL-3.0-or-later
// The video decoder worker's entry (a module worker the engine worker starts): FFmpeg's MPEG-1, MPEG-2 and VC-1
// decoders from video.wasm, off the engine worker's thread. The module is fetched once per URL and kept.
import type { ToVideoWorker } from './video-worker-protocol';
import { VideoWorkerCore } from './video-worker-core';
import { WasmPictureDecoder, loadVideoWasm, type VideoWasm } from './wasm-video';

interface VideoWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToVideoWorker>) => void) | null;
}

const scope = self as unknown as VideoWorkerScope;
const modules = new Map<string, Promise<VideoWasm>>();

function moduleAt(wasmUrl: string, timeoutMs: number | null): Promise<VideoWasm> {
  let module = modules.get(wasmUrl);
  if (!module) {
    module = loadVideoWasm(fetch(wasmUrl, timeoutMs === null ? undefined : { signal: AbortSignal.timeout(timeoutMs) }));
    modules.set(wasmUrl, module);
    // a failed load is tried again at the next open
    module.catch(() => modules.delete(wasmUrl));
  }
  return module;
}

const core = new VideoWorkerCore({
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
  openDecoder: async (wasmUrl, codec, timeoutMs) => new WasmPictureDecoder(await moduleAt(wasmUrl, timeoutMs), codec),
  now: () => performance.now(),
});

let chain: Promise<void> = Promise.resolve();
scope.onmessage = (event) => {
  // messages run one after another: an open's load finishes before the units after it are decoded
  chain = chain.then(() => core.handle(event.data));
};
