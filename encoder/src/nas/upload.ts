// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { errorOfBody, hostOf, jsonPost, NasError, type NasClient } from './client';
import { defaultSleep, RETRY_DELAYS_MS } from './mirror';

// Uploading an episode's MKV into the NAS's Encodes library, through Seikou's resumable upload (`server/src/routes/
// encodes.ts`): `POST encodes/uploads { size, sha256, name }` opens an upload, `PUT encodes/uploads/<id>` stores one
// `Content-Range` of it, `GET encodes/uploads/<id>` says which ranges are stored, and `POST encodes/uploads/<id>/complete`
// checks the bytes, the hash and the tags and files the episode. Nothing here logs; no message holds the token.

/** How many bytes each `PUT` carries (the NAS takes at most 16 MiB). */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Where an episode's upload is, kept with the job so a retry resumes it: the NAS's upload id (null before one is
 * opened), the file's SHA-256 (hashed once), its size, and the bytes the NAS holds.
 */
export interface UploadState {
  id: string | null;
  sha256: string | null;
  size: number;
  sent: number;
}

/** Why an upload failed. */
export type UploadErrorCode = 'unreachable' | 'no-room' | 'bad-tags' | 'folder-unavailable' | 'not-configured' | 'refused';

/**
 * An upload the NAS did not take: `unreachable` (no answer, or a 5xx, after the retries), `no-room`, `bad-tags` (the MKV
 * lacks its `ANILIST_ID` and `EPISODE` tags), `folder-unavailable` (the NAS's encodes folder is missing for now),
 * `not-configured` (the NAS has no encodes folder) or `refused` (any other refusal).
 */
export class UploadError extends Error {
  override name = 'UploadError';
  constructor(
    readonly code: UploadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What `uploadEpisode` takes besides the file. */
export interface UploadOptions {
  /** Stops the upload; it then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Bytes the NAS holds and the file's size, after each stored range. */
  readonly onProgress?: (sent: number, size: number) => void;
  /** The state, after each change worth keeping (a hash, an id, a stored range). */
  readonly onState?: (s: UploadState) => void;
  /** Waits between retries; tests pass a short one. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Bytes per `PUT` (`UPLOAD_CHUNK_BYTES`); tests pass a smaller one. */
  readonly chunkBytes?: number;
}

/** Inclusive byte ranges, as the NAS keeps them. */
type Ranges = readonly (readonly [number, number])[];

/** A failure worth another try: no answer, or a 5xx other than the folder's. */
class Retryable extends Error {}

/** How long one request (an open, a piece, a status, the completion) may take before it counts as unanswered. */
const REQUEST_TIMEOUT_MS = 60_000;

/** How many times an upload starts over (a forgotten id, a hash mismatch) before it gives up. */
const MAX_FRESH_STARTS = 3;

async function sha256Of(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The inclusive ranges of `[0, size)` that `ranges` leaves out, in order. */
function missingOf(ranges: Ranges, size: number): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of sorted) {
    if (a > at) out.push([at, a - 1]);
    at = Math.max(at, b + 1);
  }
  if (at < size) out.push([at, size - 1]);
  return out;
}

function storedOf(ranges: Ranges): number {
  return ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
}

/** `ms`, or the abort of `signal` (throwing its reason). */
function pause(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Uploads `path` as `name` (`<anilistId>-<episode>.mkv`): hashes once (kept in `state`), creates or resumes the upload
 * (a stored id whose GET is 404 starts over), PUTs the missing ranges in order, completes. Resolves with the NAS's
 * encode id (`entry.id`, or `filed`'s id when `entry` is null). `state` is changed in place, and `onState` hears each
 * change. Each request is tried again after 1, 2, 4 and 8 s on a network error, a 5xx or 60 s without an answer, then
 * fails `unreachable`. The NAS answers a POST of a file this device already has open with that upload's id, so a lost
 * answer to it is resumed. A
 * closed client or a session the NAS refuses throws `NasError('unauthorized')`.
 */
export async function uploadEpisode(client: NasClient, path: string, name: string, state: UploadState, o: UploadOptions = {}): Promise<string> {
  const host = hostOf(client.base);
  const sleep = o.sleep ?? defaultSleep;
  const chunkBytes = o.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  const signal = o.signal;
  const changed = (): void => o.onState?.({ ...state });

  /** `attempt`'s answer, tried again on no answer or a 5xx (but the folder's 503) as the network rules say. */
  const send = async (what: string, attempt: (s: AbortSignal) => Promise<Response>): Promise<Response> => {
    for (let i = 0; ; i++) {
      signal?.throwIfAborted();
      try {
        // each request has its own time limit, so a NAS gone without a reset does not hold a piece for minutes; running
        // out of it counts as no answer
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await attempt(signal ? AbortSignal.any([signal, timeout]) : timeout);
        if (res.status < 500 || res.status === 503) {
          if (res.status !== 503) return res;
          // 503 is either the folder's (an answer) or a busy server (another try)
          const body = await res.clone().json().catch(() => null) as { error?: unknown } | null;
          if (body?.error === 'encodes-folder-unavailable') return res;
        }
        await res.body?.cancel();
        throw new Retryable();
      } catch (e) {
        signal?.throwIfAborted();
        if (!(e instanceof Retryable || (e instanceof NasError && e.code === 'unreachable'))) throw e;
        const delay = RETRY_DELAYS_MS[i];
        if (delay === undefined) throw new UploadError('unreachable', `${host} is not answering (${what}).`);
        await pause(delay, sleep, signal);
      }
    }
  };

  /** The `UploadError` (or `NasError`) of an error answer the steps below do not handle themselves. */
  const refusal = async (res: Response, what: string): Promise<Error> => {
    let body: { error?: unknown; message?: unknown } | null = null;
    try {
      body = (await res.json()) as { error?: unknown; message?: unknown };
    } catch {
      // not JSON
    }
    const error = typeof body?.error === 'string' ? body.error : null;
    const nasMessage = typeof body?.message === 'string' ? body.message : null;
    if (res.status === 401) return new NasError('unauthorized', 401, `${host} refused the encoder's session. Pair it again.`, error);
    if (res.status === 404 && error === 'not-configured') return new UploadError('not-configured', `${host} has no encodes folder set up, so it takes no encodes.`);
    if (res.status === 503 && error === 'encodes-folder-unavailable') {
      return new UploadError('folder-unavailable', nasMessage ?? `The encodes folder on ${host} is not available right now.`);
    }
    if (res.status === 507) return new UploadError('no-room', nasMessage ?? `${host} has no room for this episode.`);
    if (res.status === 403 && error === 'https-only') return new UploadError('refused', `${host} takes uploads over HTTPS only.`);
    if (res.status === 403) return new UploadError('refused', `${host} refused the upload: the encoder's person is not an owner.`);
    if (res.status === 429) return new UploadError('refused', `${host} has too many uploads open from this encoder; they are removed after 24 hours unused.`);
    if (res.status === 409 && error === 'bad-folder') return new UploadError('refused', `${host} cannot file the episode: its show's folder there is not a folder.`);
    return new UploadError('refused', `${host} answered ${res.status}${error === null ? '' : ` (${error})`} for ${what}.`);
  };

  const size = (await stat(path)).size;
  if (state.sha256 === null || state.size !== size) {
    state.id = null;
    state.sent = 0;
    state.size = size;
    state.sha256 = await sha256Of(path, signal);
    changed();
  }

  let freshStarts = 0;
  const startOver = async (rehash: boolean): Promise<void> => {
    if (++freshStarts > MAX_FRESH_STARTS) throw new UploadError('refused', `${host} lost the upload of ${name} again and again.`);
    state.id = null;
    state.sent = 0;
    if (rehash) state.sha256 = await sha256Of(path, signal);
    changed();
  };
  let hashMismatches = 0;

  for (;;) {
    // what the NAS holds of a stored upload
    let ranges: Ranges = [];
    if (state.id !== null) {
      const id = state.id;
      const res = await send('an upload', (s) => client.request(`encodes/uploads/${id}`, { signal: s }));
      if (res.status === 404 && (await errorOfBody(res.clone())) !== 'not-configured') {
        await res.body?.cancel();
        await startOver(false);
        continue;
      }
      if (!res.ok) throw await refusal(res, 'an upload');
      const body = (await res.json()) as { size?: unknown; ranges?: unknown };
      if (body.size !== size || !Array.isArray(body.ranges)) {
        await startOver(false);
        continue;
      }
      ranges = body.ranges as Ranges;
    } else {
      const body = { size, sha256: state.sha256, name };
      const res = await send('a new upload', (s) => client.request('encodes/uploads', jsonPost(body, s)));
      if (res.status === 409 && (await errorOfBody(res.clone())) === 'in-progress') {
        await res.body?.cancel();
        throw new UploadError('refused', 'Another upload of this episode is open on the NAS; it is removed after 24 hours unused.');
      }
      if (!res.ok) throw await refusal(res, 'a new upload');
      const id = ((await res.json()) as { id?: unknown }).id;
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new UploadError('refused', `${host} gave an upload id the encoder cannot read.`);
      state.id = id;
      changed();
      // the NAS may answer with an upload this device opened before (its answer lost): ask what it holds
      continue;
    }
    const id = state.id;
    state.sent = storedOf(ranges);
    o.onProgress?.(state.sent, size);

    // the missing ranges, in order, in chunks read from the file
    let lost = false;
    const fh = await open(path, 'r');
    try {
      for (const [from, to] of missingOf(ranges, size)) {
        for (let a = from; a <= to && !lost; a += chunkBytes) {
          const b = Math.min(to, a + chunkBytes - 1);
          const bytes = new Uint8Array(b - a + 1);
          const { bytesRead } = await fh.read(bytes, 0, bytes.length, a);
          if (bytesRead !== bytes.length) throw new UploadError('refused', `${path} changed while it was being uploaded.`);
          const res = await send('a piece of an upload', (s) =>
            client.request(`encodes/uploads/${id}`, { method: 'PUT', headers: { 'Content-Range': `bytes ${a}-${b}/${size}` }, body: bytes, signal: s }),
          );
          if (res.status === 404 && (await errorOfBody(res.clone())) !== 'not-configured') {
            await res.body?.cancel();
            lost = true;
            break;
          }
          if (!res.ok) throw await refusal(res, 'a piece of an upload');
          await res.body?.cancel();
          state.sent += bytes.length;
          changed();
          o.onProgress?.(state.sent, size);
        }
        if (lost) break;
      }
    } finally {
      await fh.close();
    }
    if (lost) {
      await startOver(false);
      continue;
    }

    const res = await send('completing an upload', (s) => client.request(`encodes/uploads/${id}/complete`, { method: 'POST', signal: s }));
    if (res.ok) {
      const done = (await res.json()) as { entry?: { id?: unknown } | null; filed?: unknown };
      const encodeId = typeof done.entry?.id === 'string' ? done.entry.id : typeof done.filed === 'string' ? done.filed : null;
      if (encodeId === null) throw new UploadError('refused', `${host} filed the episode but gave no id the encoder can read.`);
      state.id = null;
      changed();
      return encodeId;
    }
    const error = await errorOfBody(res.clone());
    if (res.status === 409 && error === 'incomplete') {
      // the NAS lacks some ranges after all: ask it which and send them
      await res.body?.cancel();
      continue;
    }
    if (res.status === 404 && error !== 'not-configured') {
      await res.body?.cancel();
      await startOver(false);
      continue;
    }
    if (res.status === 422 && error === 'hash-mismatch') {
      // the NAS removed the upload; the file is hashed again, and the episode sent again once
      await res.body?.cancel();
      if (++hashMismatches > 1) {
        state.id = null;
        changed();
        throw new UploadError('refused', `${host} received other bytes than the file holds, twice; the upload was dropped.`);
      }
      await startOver(true);
      continue;
    }
    if (res.status === 422 && error === 'bad-tags') {
      // the NAS keeps such an upload; it is dropped, so a corrected file can be sent under the same name
      await res.body?.cancel();
      await abandonUpload(client, id);
      state.id = null;
      changed();
      throw new UploadError('bad-tags', `${host} refused the episode: its file has no ANILIST_ID and EPISODE tags.`);
    }
    throw await refusal(res, 'completing an upload');
  }
}

/** Drops upload `id` on the NAS, best effort: an upload a job no longer resumes. */
export async function abandonUpload(client: NasClient, id: string): Promise<void> {
  try {
    const res = await client.request(`encodes/uploads/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await res.body?.cancel();
  } catch {
    // the NAS drops an upload left 24 hours unused anyway
  }
}
