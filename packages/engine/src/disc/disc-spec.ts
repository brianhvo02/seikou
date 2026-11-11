/*
 * Original code for Seikou: what a disc is opened from, as it crosses between workers.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { FileSource } from './file-source';
import { HttpTransport } from './http-transport';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { normalizeDiscPaths } from './paths';
import { RemoteSource } from './remote-source';

/** Picked files (paths as the picker reports them), or a disc on the NAS. Structured-cloneable (a fetch port is transferred). */
export type DiscSpec =
  | { readonly kind: 'files'; readonly entries: ReadonlyArray<readonly [string, Blob]> }
  | RemoteDiscSpec;

/** A disc (or an encoded episode's file set) on the NAS, as the page hands it to the engine; structured-cloneable. */
export interface RemoteDiscSpec {
  /** Tells a remote spec from picked files. */
  readonly kind: 'remote';
  /** The disc's API base, ending with '/': `https://…/bluray/api/discs/<id>/`, or `rtc://<nasId>/api/discs/<id>/`. */
  readonly base: string;
  /** The device's session token, sent as `t` on every request; replaced through `setToken` when the NAS refreshes it. */
  readonly token: string;
  /** The disc's file list and inlined small files, as the NAS served it. */
  readonly manifest: DiscManifest;
  /** Extra query parameters for every files request (without the '?'): `level=<id>&audio=<n>` for a quality level. */
  readonly query?: string;
  /** The original version's manifest, for the BD-J worker, when `manifest` is a level's. */
  readonly original?: DiscManifest;
  /**
   * Where the disc's requests go when they can't be fetched from this worker (the WebRTC route, whose connection lives
   * on the main thread): `portFetch` over it. It must be in the message's transfer list.
   */
  readonly fetchPort?: MessagePort;
}

/** What a message carrying `spec` must transfer: its fetch port, if it has one. */
export function discTransfer(spec: DiscSpec): Transferable[] {
  return spec.kind === 'remote' && spec.fetchPort ? [spec.fetchPort] : [];
}

/** What `createByteSource` needs for a NAS disc. */
export interface ByteSourceDeps {
  /** The `fetch` to use: the worker's own, or `portFetch` over the WebRTC port. */
  readonly fetch: typeof fetch;
  /** The most bytes the source holds ahead of the read position and from earlier reads. */
  readonly readAheadBytes: number;
  /** Size of one range request; REMOTE_CHUNK_BYTES by default. */
  readonly chunkBytes?: number;
  /** Range requests in flight at most while reading ahead; REMOTE_IN_FLIGHT by default. */
  readonly inFlight?: number;
  /** Called with true when a read has waited several seconds on the NAS, and false when such reads have landed. */
  onWaiting(waiting: boolean): void;
  /** A fresh session token after a 401; without it a 401 means unpaired. */
  refreshToken?(): Promise<string>;
}

/** Bytes in one range request of a NAS disc read by the player. */
export const REMOTE_CHUNK_BYTES = 2 * 1024 * 1024;
/** Range requests in flight at once while the player reads ahead. */
export const REMOTE_IN_FLIGHT = 4;
/**
 * Bytes in one range request of the BD-J worker's NAS reads: JAR entries, fonts and metadata, mostly small and scattered,
 * so smaller requests and fewer of them at once than playback's. Its read-ahead is smaller for the same reason: it reads no streams, and more would only add memory.
 */
export const BDJ_REMOTE_CHUNK_BYTES = 512 * 1024;
/** Range requests in flight at once for the BD-J worker, fewer than playback's. */
export const BDJ_REMOTE_IN_FLIGHT = 2;

/**
 * The disc's bytes: picked files from disk (`FileSource`, paths normalised to the folder holding BDMV), or the NAS by
 * HTTP range reads (`RemoteSource` over `HttpTransport`). Throws `DiscError` for picked files that are not one disc.
 * @internal
 */
export function createByteSource(spec: DiscSpec, deps: ByteSourceDeps): FileSource | RemoteSource {
  if (spec.kind === 'files') return new FileSource(normalizeDiscPaths(spec.entries));
  const transport = new HttpTransport(spec.base, spec.token, {
    fetch: deps.fetch,
    ...(spec.query ? { query: spec.query } : {}),
    ...(deps.refreshToken ? { refreshToken: () => deps.refreshToken!() } : {}),
  });
  return new RemoteSource(spec.manifest, transport, {
    readAheadBytes: deps.readAheadBytes,
    chunkBytes: deps.chunkBytes ?? REMOTE_CHUNK_BYTES,
    inFlight: deps.inFlight ?? REMOTE_IN_FLIGHT,
    onWaiting: (waiting) => deps.onWaiting(waiting),
  });
}
