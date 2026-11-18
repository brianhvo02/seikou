// SPDX-License-Identifier: LGPL-3.0-or-later
// The video decoder worker's entry (a module worker the engine worker starts): FFmpeg's MPEG-1, MPEG-2 and VC-1
// decoders from video.wasm, off the engine worker's thread.
import type { ToVideoWorker } from './video-worker-protocol';
import { VideoWorkerCore, videoDecoderOpener } from './video-worker-core';

interface VideoWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToVideoWorker>) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

const scope = self as unknown as VideoWorkerScope;

const core = new VideoWorkerCore({
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
  openDecoder: videoDecoderOpener((url, init) => fetch(url, init)),
  now: () => performance.now(),
});

scope.onmessage = (event) => core.enqueue(event.data);
scope.onmessageerror = () => core.messageError();
