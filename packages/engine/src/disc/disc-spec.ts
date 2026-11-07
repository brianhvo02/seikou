/*
 * Original code for bluray-web: what a disc is opened from, as it crosses between workers.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
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

export interface RemoteDiscSpec {
  readonly kind: 'remote';
  /** The disc's API base, ending with '/': `https://…/bluray/api/discs/<id>/`, or `rtc://<nasId>/api/discs/<id>/`. */
  readonly base: string;
  readonly token: string;
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

export interface ByteSourceDeps {
  readonly fetch: typeof fetch;
  readonly readAheadBytes: number;
  /** Size of one range request; REMOTE_CHUNK_BYTES by default. */
  readonly chunkBytes?: number;
  /** Range requests in flight at most while reading ahead; REMOTE_IN_FLIGHT by default. */
  readonly inFlight?: number;
  onWaiting(waiting: boolean): void;
  /** A fresh session token after a 401; without it a 401 means unpaired. */
  refreshToken?(): Promise<string>;
}

export const REMOTE_CHUNK_BYTES = 2 * 1024 * 1024;
export const REMOTE_IN_FLIGHT = 4;
/**
 * The BD-J worker's NAS reads (ruling R20): JAR entries, fonts and metadata, mostly small and scattered, so smaller
 * requests and fewer of them at once than playback's; a JAR read in order still streams at 4 MB in flight.
 */
export const BDJ_REMOTE_CHUNK_BYTES = 512 * 1024;
export const BDJ_REMOTE_IN_FLIGHT = 2;

/** The disc's bytes: picked files from disk, or the NAS by HTTP range reads. */
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
