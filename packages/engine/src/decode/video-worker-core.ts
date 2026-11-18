// SPDX-License-Identifier: LGPL-3.0-or-later
// The video decoder worker's work, apart from the worker global so tests drive it in-process (video-worker.ts runs it).
import type { FromVideoWorker, ToVideoWorker } from './video-worker-protocol';
import { WasmPictureDecoder, loadVideoWasm, type DecodedPicture, type VideoWasm, type WasmVideoCodecId } from './wasm-video';

/** The part of WasmPictureDecoder the worker uses. */
export type PictureDecoderLike = Pick<WasmPictureDecoder, 'push' | 'drain' | 'flush' | 'reset' | 'setSkipNonReference' | 'close'>;

/** What VideoWorkerCore needs from its worker. */
export interface VideoWorkerCoreDeps {
  /** Sends a message to the engine; `transfer` lists the buffers moved with it. */
  post(message: FromVideoWorker, transfer?: Transferable[]): void;
  /** Loads video.wasm from `wasmUrl` (within `timeoutMs` when given) and opens a decoder for `codec`. */
  openDecoder(wasmUrl: string, codec: WasmVideoCodecId, timeoutMs: number | null): Promise<PictureDecoderLike>;
  /** A clock in milliseconds, for the decode time of a unit. */
  now(): number;
}

/**
 * Runs the video decoder worker's messages in order: opens the decoder, decodes units and sends each picture they
 * complete (its buffer transferred), then `decoded`. Pictures of `discard` units are dropped here: the decoder times a
 * picture by the unit it started in, so a picture whose time is a discarded unit's is that unit's. A failure of the
 * decoder is fatal; after it, units are answered `decoded` and nothing else.
 */
export class VideoWorkerCore {
  private decoder: PictureDecoderLike | null = null;
  private failed = false;
  /** The rounded times of discard units whose pictures have not come out, since the last open, reset or flush. */
  private readonly discards = new Set<number>();

  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VideoWorkerCoreDeps) {}

  /**
   * Queues a message behind the ones before it (an open's load finishes before the units after it are decoded). A
   * message whose handling throws or rejects anywhere is a fatal error for the engine, never a silent stop.
   */
  enqueue(message: ToVideoWorker): void {
    this.chain = this.chain.then(() => this.handle(message)).catch((err: unknown) => this.fail(err));
  }

  /** A message from the engine that could not be deserialized (the worker's messageerror): fatal, as the unit is lost. */
  messageError(): void {
    this.fail(new Error('a message to the video decoder worker could not be read'));
  }

  /** Handles one message; the next must wait for the returned promise (only `open` awaits anything). */
  async handle(message: ToVideoWorker): Promise<void> {
    switch (message.type) {
      case 'open':
        return this.open(message.wasmUrl, message.codec, message.timeoutMs);
      case 'decode':
        this.decode(message.id, message.data, message.ptsUs, message.discard);
        return;
      case 'flush':
        this.run(() => this.send(this.decoder?.flush() ?? []));
        this.discards.clear();
        this.deps.post({ type: 'flushed', id: message.id });
        return;
      case 'reset':
        this.discards.clear();
        this.run(() => this.decoder?.reset());
        return;
      case 'skip':
        this.run(() => this.decoder?.setSkipNonReference(message.on));
        return;
      case 'close':
        this.closeDecoder();
        return;
    }
  }

  private async open(wasmUrl: string, codec: WasmVideoCodecId, timeoutMs: number | null): Promise<void> {
    this.closeDecoder();
    this.failed = false;
    this.discards.clear();
    try {
      this.decoder = await this.deps.openDecoder(wasmUrl, codec, timeoutMs);
    } catch (err) {
      this.fail(err);
      return;
    }
    this.deps.post({ type: 'opened' });
  }

  private decode(id: number, data: Uint8Array, ptsUs: number, discard: boolean): void {
    const start = this.deps.now();
    const decoder = this.decoder;
    if (decoder) {
      if (discard && Number.isFinite(ptsUs)) this.discards.add(Math.round(ptsUs));
      this.run(() => {
        decoder.push(data, ptsUs);
        this.send(decoder.drain());
      });
    }
    this.deps.post({ type: 'decoded', id, ms: this.deps.now() - start });
  }

  /** Sends the pictures that aren't a discard unit's, and forgets the discard times they passed. */
  private send(pictures: readonly DecodedPicture[]): void {
    for (const picture of pictures) {
      if (this.discards.size > 0) {
        const dropped = this.discards.delete(picture.ptsUs);
        // pictures come out in presentation order: a discard time behind this one will never be seen
        for (const t of this.discards) if (t < picture.ptsUs) this.discards.delete(t);
        if (dropped) continue;
      }
      this.deps.post({ type: 'picture', picture }, [picture.data.buffer as ArrayBuffer]);
    }
  }

  /** Runs a decoder call; a throw is fatal (out of memory, a picture that isn't 4:2:0). */
  private run(call: () => void): void {
    if (!this.decoder) return;
    try {
      call();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.closeDecoder();
    if (this.failed) return;
    this.failed = true;
    try {
      this.deps.post({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: true });
    } catch {
      // nothing can reach the engine: its watchdog reports the worker as stopped
    }
  }

  private closeDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    try {
      decoder?.close();
    } catch {
      // closing a decoder that already failed: nothing more to free
    }
  }
}

/** The fetch the worker loads video.wasm with (the global fetch; tests pass a fake). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The worker's openDecoder: fetches video.wasm (aborted after `timeoutMs`, so a stalled fetch fails the open rather
 * than leaving it pending), keeps the compiled module per URL for later opens (a failed load is tried again), and opens
 * a decoder in it.
 */
export function videoDecoderOpener(
  fetchImpl: FetchLike,
  load: (source: Promise<Response>) => Promise<VideoWasm> = loadVideoWasm,
): VideoWorkerCoreDeps['openDecoder'] {
  const modules = new Map<string, Promise<VideoWasm>>();
  return async (wasmUrl, codec, timeoutMs) => {
    let module = modules.get(wasmUrl);
    if (!module) {
      module = load(fetchImpl(wasmUrl, timeoutMs === null ? undefined : { signal: AbortSignal.timeout(timeoutMs) }));
      modules.set(wasmUrl, module);
      module.catch(() => modules.delete(wasmUrl));
    }
    return new WasmPictureDecoder(await module, codec);
  };
}
