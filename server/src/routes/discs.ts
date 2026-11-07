import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { parseDiscKey } from '@seikou/nas/disc-key';
import type { DiscEntry } from '@seikou/nas/nas-api';
import type { Auth } from '../auth';
import type { DiscActivity } from '../disc-activity';
import { json, requestSignal } from '../http';
import type { Handler, Response } from '../http';
import { IsoTrees, isoFileStream, isoUnchanged } from '../iso';
import { RetryLater } from '../levels/clip-run';
import { viewingIdOf, type EncodedLevel, type LevelService } from '../levels/level-service';
import type { Library } from '../library';
import { buildIsoManifest, buildManifest, discUnchanged, largestClip, largestIsoClip, resolveDiscFile, resolveIsoFile } from '../manifest';
import { parseRange } from '../ranges';
import { requestDevice } from './titles';

const PROBE_BYTES = 4_194_304;
/** The most one read of a level's file answers (the client reads 2 MiB chunks); a longer range is clamped. */
export const MAX_LEVEL_READ_BYTES = 4_194_304;
const ROUTE = /^\/api\/discs\/([^/]+)\/(manifest|probe|levels|viewing|files\/(.+))$/;
const ENCODED_LEVELS: ReadonlySet<string> = new Set<EncodedLevel>(['h264-1080', 'phone-720', 'hevc-1080', 'hevc-1080-hdr', 'h264-1080-sdr']);

/** A refused lease, for a disc whose original plays (spec §6.4). */
export const BUSY_COPY = 'The NAS is busy re-encoding for others. This will play at original quality.';
/** A refused lease, for an MPEG-2 or VC-1 disc, whose original doesn't. */
export const BUSY_TRY_LATER_COPY = 'The NAS is busy. Try again in a few minutes.';
const RESOLVE = /^\/api\/discs\/resolve\/([^/]+)$/;

const notFound = (): Response => json(404, { error: 'not found' });
const discChanged = (): Response => json(404, { error: 'disc-changed' });
const badRequest = (): Response => json(400, { error: 'bad request' });
/** Ask the client to come back in a second: the encoder hasn't reached the bytes yet, or was restarted or closed. */
const retryLater = (): Response => json(503, { error: 'retry' }, { 'Retry-After': '1' });

/** What the routes use of the level service (tests stub it). */
export type LevelRouteService = Pick<LevelService, 'manifest' | 'read' | 'levels' | 'release' | 'size' | 'originalPlayable'>;

/** The quality levels: absent when `LEVELS_BACKEND` is off or the GPU self-test failed, and every level route is 404. */
export interface DiscLevels {
  readonly service: LevelRouteService;
  /** Verifies the token: the viewing's device comes from it, never from the request. */
  readonly auth: Auth;
}

function bytesHeaders(length: number): Record<string, string> {
  return {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Length': String(length),
  };
}

/** Opens bytes `[start, end]` (inclusive) of a file. */
type OpenBytes = (start: number, end: number) => Readable;

/** `[start, end]` (inclusive) as a streamed body; nothing for HEAD or an empty span. */
function bytes(req: IncomingMessage, open: OpenBytes, status: number, start: number, end: number, headers: Record<string, string> = {}): Response {
  const length = end - start + 1;
  const body = req.method === 'HEAD' || length === 0 ? undefined : open(start, end);
  return { status, headers: { ...bytesHeaders(length), ...headers }, body };
}

/** A file of `size` bytes: the `Range` asked for, or all of it. */
function serveBytes(req: IncomingMessage, size: number, open: OpenBytes): Response {
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') return { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': '0' } };
  if (range === null) return bytes(req, open, 200, 0, size - 1);
  return bytes(req, open, 206, range.start, range.end, { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` });
}

async function serveFile(req: IncomingMessage, file: string): Promise<Response> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return notFound();
  }
  return serveBytes(req, size, (start, end) => createReadStream(file, { start, end }));
}

/** ISO discs whose parsed UDF trees are kept. */
export const ISO_TREES = 32;

/**
 * `GET /api/discs/<id>/manifest`, `GET|HEAD /api/discs/<id>/files/<path>` (a `Range` or the whole file) and
 * `GET|HEAD /api/discs/<id>/probe` (the first 4 MiB of the largest clip); `appHandlers` puts the token guard in front.
 * With `levels`, also the quality levels (`levelRoute`) and `DELETE /api/discs/<id>/viewing`; without, those are 404.
 * `level=original`, or no level, is the original disc. `isoTrees` is shared with the quality levels' disc sources.
 * `activity` is told of every file read (original or level, folder or ISO), for work that waits while someone watches.
 */
export function discRoutes(library: Library, levels?: DiscLevels, isoTrees: IsoTrees = new IsoTrees(ISO_TREES), activity?: DiscActivity): Handler {

  /** The same three actions for an ISO disc, from its UDF tree (parsed once per disc id). */
  const isoRoute = async (req: IncomingMessage, disc: DiscEntry, action: string, encodedPath: string | undefined): Promise<Response> => {
    const abs = library.locate(disc);
    if (!abs || !(await isoUnchanged(disc, abs))) return discChanged();
    let tree;
    try {
      tree = await isoTrees.get(disc.id, abs);
    } catch (err) {
      // Replaced while we read it: the client should rescan. Otherwise it is a real failure.
      if (!(await isoUnchanged(disc, abs))) return discChanged();
      throw err;
    }
    if (action === 'manifest') return json(200, await buildIsoManifest(abs, tree, disc));
    if (action === 'probe') {
      const clip = largestIsoClip(tree);
      if (!clip) return notFound();
      return bytes(req, (start, end) => isoFileStream(abs, clip, start, end), 200, 0, Math.min(clip.size, PROBE_BYTES) - 1);
    }
    let path: string;
    try {
      path = decodeURIComponent(encodedPath!);
    } catch {
      return notFound();
    }
    const file = resolveIsoFile(tree, path);
    return file ? serveBytes(req, file.size, (start, end) => isoFileStream(abs, file, start, end)) : notFound();
  };

  /** The listed disc a link key names. Several copies of one fingerprint answer the one with the smallest path (byte order). */
  const resolve = (key: string): DiscEntry | null => {
    const parsed = parseDiscKey(key);
    if (!parsed) return null;
    if (parsed.kind === 'disc') return library.disc(parsed.discId) ?? null;
    let best: { discId: string; path: string } | null = null;
    for (const ev of library.evidence()) {
      if (ev.fingerprint !== parsed.fingerprint) continue;
      if (best === null || Buffer.compare(Buffer.from(ev.path), Buffer.from(best.path)) < 0) best = ev;
    }
    return best ? (library.disc(best.discId) ?? null) : null;
  };

  return async (req, url) => {
    const resolved = RESOLVE.exec(url.pathname);
    if (resolved) {
      if (req.method !== 'GET') return null;
      let key: string;
      try {
        key = decodeURIComponent(resolved[1]!);
      } catch {
        return json(404, { error: 'not-found' });
      }
      const disc = resolve(key);
      return disc ? json(200, { disc }) : json(404, { error: 'not-found' });
    }
    const match = ROUTE.exec(url.pathname);
    if (!match) return null;
    const [, id = '', matched = '', encodedPath] = match;
    const action = encodedPath === undefined ? matched : 'files';
    const read = action === 'probe' || action === 'files';
    if (action === 'viewing') {
      if (req.method !== 'DELETE') return null;
      return levels ? release(levels, req, url, id) : notFound();
    }
    if (!(req.method === 'GET' || (read && req.method === 'HEAD'))) return null;
    if (read) activity?.note();
    const level = url.searchParams.get('level');
    // `level=original`, an empty `level=` or none: the original disc.
    const atLevel = action === 'levels' || ((action === 'manifest' || action === 'files') && level !== null && level !== '' && level !== 'original');
    if (atLevel && !levels) return notFound();

    const disc = library.disc(id);
    if (!disc) return discChanged();
    if (atLevel) {
      // The disc must be as the scan saw it, as for the original; the level service then checks each clip's identity.
      const abs = library.locate(disc);
      if (!abs || !(disc.kind === 'iso' ? await isoUnchanged(disc, abs) : await discUnchanged(disc, abs))) return discChanged();
      return levelRoute(levels!, req, url, disc.id, action, encodedPath);
    }
    if (disc.kind === 'iso') return isoRoute(req, disc, action, encodedPath);
    const dir = library.locate(disc);
    if (!dir || !(await discUnchanged(disc, dir))) return discChanged();

    if (action === 'manifest') return json(200, await buildManifest(dir, disc));
    if (action === 'probe') {
      const clip = await largestClip(dir);
      if (!clip) return notFound();
      return bytes(req, (start, end) => createReadStream(clip.abs, { start, end }), 200, 0, Math.min(clip.size, PROBE_BYTES) - 1);
    }
    let path: string;
    try {
      path = decodeURIComponent(encodedPath!);
    } catch {
      return notFound();
    }
    const file = await resolveDiscFile(dir, path);
    return file ? serveFile(req, file) : notFound();
  };
}

/** The `audio` query (1-based, as PSR1), 1 when absent; NaN when it isn't a whole number. */
function audioParam(url: URL): number {
  const audio = url.searchParams.get('audio');
  if (audio === null) return 1;
  return /^\d{1,2}$/.test(audio) ? Number(audio) : NaN;
}

const flag = (url: URL, name: string): boolean => {
  const value = url.searchParams.get(name);
  return value === '1' || value === 'true';
};

/** The busy answer: its copy depends on whether the disc's original plays in the app. */
async function busy(service: LevelRouteService, discId: string): Promise<Response> {
  const original = await service.originalPlayable(discId);
  return json(503, { error: 'busy', message: original === false ? BUSY_TRY_LATER_COPY : BUSY_COPY });
}

/** `DELETE /api/discs/<id>/viewing?level=&audio=`: the token's device closed the disc; its lease and encoders go. */
async function release(levels: DiscLevels, req: IncomingMessage, url: URL, discId: string): Promise<Response> {
  const device = requestDevice(levels.auth, req.headers.authorization, url);
  if (!device) return json(401, { error: 'unauthorized' });
  const level = url.searchParams.get('level') ?? '';
  const audio = audioParam(url);
  if (!ENCODED_LEVELS.has(level) || !(audio >= 1 && audio <= 32)) return badRequest();
  levels.service.release(viewingIdOf(device.id, discId, level as EncodedLevel, audio));
  return { status: 204 };
}

/**
 * `GET /api/discs/<id>/levels?hevc=&hevc10=&hdr=&audio=` (priced with that audio stream, 1 by default), and the manifest and files at `?level=<level>&audio=<n>` (spec §5):
 * a level's manifest leases the GPU for the token's device's viewing; a read answers 503 with `Retry-After: 1` while the
 * encoder hasn't reached its bytes (or was restarted or closed), and 503 `busy` when the GPU has no room for the viewing.
 * A read is clamped to 4 MiB.
 */
async function levelRoute(levels: DiscLevels, req: IncomingMessage, url: URL, discId: string, action: string, encodedPath: string | undefined): Promise<Response> {
  const { service } = levels;
  const device = requestDevice(levels.auth, req.headers.authorization, url);
  if (!device) return json(401, { error: 'unauthorized' });
  if (action === 'levels') {
    const audio = audioParam(url);
    if (!(audio >= 1 && audio <= 32)) return notFound();
    const list = await service.levels(discId, { hevc: flag(url, 'hevc'), hevc10: flag(url, 'hevc10'), hdr: flag(url, 'hdr') }, device.id, audio);
    return list ? json(200, { levels: list }) : discChanged();
  }
  const level = url.searchParams.get('level')!;
  const audio = audioParam(url);
  if (!ENCODED_LEVELS.has(level) || !(audio >= 1 && audio <= 32)) return notFound();
  const viewingId = viewingIdOf(device.id, discId, level as EncodedLevel, audio);

  if (action === 'manifest') {
    const manifest = await service.manifest(discId, level, audio, viewingId);
    if (!manifest) return notFound();
    return 'busy' in manifest ? busy(service, discId) : json(200, manifest);
  }

  let path: string;
  try {
    path = decodeURIComponent(encodedPath!);
  } catch {
    return notFound();
  }
  const size = await service.size(discId, level, audio, path);
  if (size === null) return notFound();
  // No Range (or one we don't serve, as parseRange's null) means `bytes=0-`, as for the original; an empty file is 200.
  if (size === 0) return { status: 200, headers: bytesHeaders(0) };
  const range = parseRange(req.headers.range, size) ?? { start: 0, end: size - 1, asked: false };
  if (range === 'unsatisfiable') return { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': '0' } };
  const start = range.start;
  const end = Math.min(range.end, start + MAX_LEVEL_READ_BYTES - 1);
  // The whole file, unasked for a range and small enough: 200, as for the original.
  const whole = 'asked' in range && start === 0 && end === size - 1;
  const headers: Record<string, string> = whole ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` };
  const length = end - start + 1;
  if (req.method === 'HEAD') return { status: whole ? 200 : 206, headers: { ...bytesHeaders(length), ...headers } };

  // The requester went away (the connection closed, or the data channel's request was cancelled): stop waiting; the
  // encoder carries on.
  const gone = requestSignal(req);
  let got: Awaited<ReturnType<LevelRouteService['read']>>;
  try {
    got = await service.read(discId, level, audio, path, start, length, viewingId, gone.signal);
  } catch (err) {
    if (err instanceof RetryLater || gone.signal.aborted) return retryLater();
    // The file's size moved between the size and the read: its clip was replaced.
    if (err instanceof RangeError) return discChanged();
    throw err;
  } finally {
    gone.done();
  }
  if (got === null) return notFound();
  if ('retryAfter' in got) return retryLater();
  if ('busy' in got) return busy(service, discId);
  return { status: whole ? 200 : 206, headers: { ...bytesHeaders(length), ...headers }, body: got };
}
