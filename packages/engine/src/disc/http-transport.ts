/*
 * Original code for Seikou: byte ranges of a NAS disc's files over HTTP (the NAS server's files route).
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { DiscError, type DiscErrorCode } from '@seikou/bdmv/byte-source';
import type { RangeTransport } from './remote-source';

/** Shown when the NAS says a file it served has changed (the 404 `disc-changed` answer). */
export const DISC_CHANGED_MESSAGE = 'This disc changed on the NAS. Open its folder again.';
/** Shown when a request fails at the network level or times out. */
export const NAS_LOST_MESSAGE = 'Connection to the NAS lost.';
/** Shown when the NAS refuses the token and a fresh one does not help. */
export const NAS_UNPAIRED_MESSAGE = 'This device is no longer paired with the NAS.';

/** A request that has not answered (headers and body) after this long has lost the NAS. The first read of a disc may wake its drive. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** How long the engine waits for the controller's fresh token before it gives up (as unpaired). */
export const TOKEN_TIMEOUT_MS = 10_000;

/** Why a remote read failed, for the UI: the disc changed, the NAS cannot be reached, or the device is not paired. */
export type RemoteFailure = 'disc-changed' | 'nas-lost' | 'nas-unpaired';

/**
 * A DiscError of a remote disc, with what went wrong for the UI.
 * @example ../../examples/remote-disc-error.ts#construct
 */
export class RemoteDiscError extends DiscError {
  constructor(
    readonly reason: RemoteFailure,
    code: DiscErrorCode,
    message: string,
    paths: readonly string[] = [],
  ) {
    super(code, message, paths);
  }
}

const discChanged = (path: string): RemoteDiscError => new RemoteDiscError('disc-changed', 'source-changed', DISC_CHANGED_MESSAGE, [path]);
const nasLost = (path: string): RemoteDiscError => new RemoteDiscError('nas-lost', 'read-failed', NAS_LOST_MESSAGE, [path]);
const unpaired = (path: string): RemoteDiscError => new RemoteDiscError('nas-unpaired', 'read-failed', NAS_UNPAIRED_MESSAGE, [path]);

/** What `HttpTransport` needs beyond the disc's address. */
export interface HttpTransportOptions {
  /** The `fetch` to use: the worker's own, or `portFetch` over the WebRTC port. */
  readonly fetch: typeof fetch;
  /** A fresh session token, asked for once when a request answers 401; none (or a rejection) means unpaired. */
  readonly refreshToken?: () => Promise<string>;
  /** Extra query parameters for every files URL (without the '?'), such as `level=<id>&audio=<n>`; kept across token refreshes. */
  readonly query?: string;
}

/**
 * Reads `<base>files/<path>?t=<token>` with a single `Range: bytes=a-b` and no other headers, so the request needs no
 * preflight. `base` ends with '/': `https://…/bluray/api/discs/<id>/`. A 503 is waited out for its `Retry-After`, and a
 * 401 is retried once with a fresh token. Runs wherever it is built: the engine worker or the BD-J worker.
 * @example ../../examples/http-transport.ts#construct
 */
export class HttpTransport implements RangeTransport {
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly base: string,
    private token: string,
    private readonly opts: HttpTransportOptions,
  ) {}

  /**
   * Uses `token` for later requests (a refresh the main thread pushed).
   * @example ../../examples/http-transport.ts#setToken
   */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * The bytes of `path` from `offset`, at most `length`; fewer at the end of the file, none past it. Throws a
   * `RemoteDiscError` (`nas-lost` after 30 s without an answer or on a network failure, `nas-unpaired` after a refused
   * refresh, `disc-changed` on the NAS's changed-disc 404) or a `DiscError` for other failures; an abort rejects with the signal's reason.
   * @example ../../examples/http-transport.ts#read
   */
  async read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    let retried = false;
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    for (;;) {
      const token = this.token;
      const answer = await this.request(path, offset, length, token, signal);
      if (answer.status === 503) {
        // the NAS is still encoding what this read needs: wait as long as it says, within the read's budget
        const left = deadline - Date.now();
        if (left <= 0) throw nasLost(path);
        await sleep(Math.min(answer.retryAfterMs ?? 1000, left), signal);
        continue;
      }
      if (answer.status !== 401) return answer.bytes;
      if (retried) throw unpaired(path);
      retried = true;
      // a request that went out with an older token tries the current one first
      if (this.token === token) await this.refresh(path);
    }
  }

  private async refresh(path: string): Promise<void> {
    const refresh = this.opts.refreshToken;
    if (!refresh) throw unpaired(path);
    this.refreshing ??= refresh().finally(() => (this.refreshing = null));
    try {
      this.token = await this.refreshing;
    } catch {
      throw unpaired(path);
    }
  }

  /** One request, cut off after REQUEST_TIMEOUT_MS. The bytes of a 206 (empty for 416), or a 401 to retry. */
  private async request(path: string, offset: number, length: number, token: string, signal?: AbortSignal): Promise<{ status: number; bytes: Uint8Array; retryAfterMs?: number }> {
    signal?.throwIfAborted();
    const url = `${this.base}files/${path.split('/').map(encodeURIComponent).join('/')}?t=${encodeURIComponent(token)}${this.opts.query ? `&${this.opts.query}` : ''}`;
    const controller = new AbortController();
    const lost = nasLost(path);
    const timer = setTimeout(() => controller.abort(lost), REQUEST_TIMEOUT_MS);
    const onAbort = (): void => controller.abort(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.opts.fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal: controller.signal });
      switch (response.status) {
        case 206:
          return { status: 206, bytes: new Uint8Array(await response.arrayBuffer()) };
        case 416: // starts at or past the end of the file
          return { status: 416, bytes: new Uint8Array(0) };
        case 401:
          return { status: 401, bytes: new Uint8Array(0) };
        case 404:
          if ((await errorOf(response)) === 'disc-changed') throw discChanged(path);
          throw new DiscError('read-failed', `Failed to read ${path}: the NAS does not have it`, [path]);
        case 503: {
          // Retry-After says the NAS is still encoding; without it (a NAS from before it was CORS-exposed, or a proxy hid it)
          // the body tells retry ('retry') from a refusal ('busy': no room to encode a level), which is not worth retrying
          const seconds = Number(response.headers.get('Retry-After'));
          if (response.headers.has('Retry-After') && Number.isFinite(seconds) && seconds >= 0) {
            return { status: 503, bytes: new Uint8Array(0), retryAfterMs: seconds * 1000 };
          }
          const body = await bodyOf(response);
          if (body.error === 'retry') return { status: 503, bytes: new Uint8Array(0), retryAfterMs: 1000 };
          throw new DiscError('read-failed', body.message ?? `Failed to read ${path}: HTTP 503`, [path]);
        }
        default:
          throw new DiscError('read-failed', `Failed to read ${path}: HTTP ${response.status}`, [path]);
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.aborted) throw lost;
      if (err instanceof DiscError) throw err;
      throw lost; // fetch rejects with a TypeError when the network fails
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** The `error` and `message` of a JSON error body, each null when absent or unreadable. */
async function bodyOf(response: Response): Promise<{ error: string | null; message: string | null }> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    return { error: typeof body.error === 'string' ? body.error : null, message: typeof body.message === 'string' ? body.message : null };
  } catch {
    return { error: null, message: null };
  }
}

/** Waits `ms`; an abort of `signal` rejects at once with its reason. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function errorOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Fresh tokens from the main thread: `request` asks for one (once for every waiter) and settles with the next token
 * delivered, or rejects after TOKEN_TIMEOUT_MS.
 */
export class TokenRelay {
  private waiters: Array<{ resolve: (token: string) => void; cancel: () => void }> = [];

  constructor(
    private readonly ask: () => void,
    private readonly setTimer: (ms: number, fn: () => void) => () => void,
  ) {}

  /** Asks the main thread for a token (once however many wait) and resolves with the next one delivered; rejects after 10 s. */
  request(): Promise<string> {
    return new Promise((resolve, reject) => {
      const first = this.waiters.length === 0;
      const waiter = {
        resolve,
        cancel: this.setTimer(TOKEN_TIMEOUT_MS, () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error('no session token arrived'));
        }),
      };
      this.waiters.push(waiter);
      if (first) this.ask();
    });
  }

  /** The main thread's answer: settles every waiting request with `token`. */
  deliver(token: string): void {
    for (const w of this.waiters.splice(0)) {
      w.cancel();
      w.resolve(token);
    }
  }
}
