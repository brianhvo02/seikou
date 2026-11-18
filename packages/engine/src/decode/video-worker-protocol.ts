// SPDX-License-Identifier: LGPL-3.0-or-later
// The messages between the engine worker's WasmVideoDecoder and the video decoder worker (video-worker.ts).
import type { DecodedPicture, WasmVideoCodecId } from './wasm-video';

/** What the engine sends the video decoder worker. Messages are handled in the order sent. */
export type ToVideoWorker =
  /**
   * Loads video.wasm from `wasmUrl` (fetched with a `timeoutMs` limit, none when null) and opens a decoder for `codec`,
   * closing any open before; answered `opened`, or a fatal `error`.
   */
  | { readonly type: 'open'; readonly wasmUrl: string; readonly codec: WasmVideoCodecId; readonly timeoutMs: number | null }
  /**
   * One unit of the elementary stream (a PES payload, which need not hold a whole picture) and its playlist time (NaN
   * for none). Answered `decoded` with the same id, after the pictures it completed; a `discard` unit's pictures are
   * decoded for reference and never sent.
   */
  | { readonly type: 'decode'; readonly id: number; readonly data: Uint8Array; readonly ptsUs: number; readonly discard: boolean }
  /** Ends the stream: every picture still held is sent, then `flushed` with the id. */
  | { readonly type: 'flush'; readonly id: number }
  /** Drops every picture held (a seek); the next picture out is a key picture. */
  | { readonly type: 'reset' }
  /** On: B pictures, which nothing refers to, are not decoded (a device too slow to decode them all). */
  | { readonly type: 'skip'; readonly on: boolean }
  /** Closes the decoder; the worker may then be terminated. */
  | { readonly type: 'close' };

/** What the video decoder worker sends back. */
export type FromVideoWorker =
  /** The answer to `open`: units can be decoded. */
  | { readonly type: 'opened' }
  /** A decoded picture, in presentation order; its `data` buffer is transferred, not copied. */
  | { readonly type: 'picture'; readonly picture: DecodedPicture }
  /** The answer to `decode`: the unit took `ms` milliseconds to decode. */
  | { readonly type: 'decoded'; readonly id: number; readonly ms: number }
  /** The answer to `flush`: every picture was sent. */
  | { readonly type: 'flushed'; readonly id: number }
  /** A failure; `fatal` says the decoder has stopped for good (the module didn't load, a picture it can't output). */
  | { readonly type: 'error'; readonly message: string; readonly fatal: boolean };
