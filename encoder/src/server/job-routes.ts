// SPDX-License-Identifier: LGPL-3.0-or-later
import { lstat, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';
import { readBody } from '../../../server/src/http';
import { httpError, json, sendFile, type Route, type RouteTable } from './http';
import { discOf, sessionsOf } from './sessions';
import { JobError, jobRunnerOf, MAX_LOG_TAIL, type Job, type JobProgress } from './jobs';
import { testDirOf } from './test-encode';

// The routes of the encode queue, its live event stream, and the files the jobs wrote.

/** Largest body `POST /api/jobs` reads. */
const MAX_BODY = 64 * 1024;

/** A comment line sent on an idle event stream, so proxies and the browser keep it open. */
const PING_MS = 30_000;

/** Content types of the files a job writes. */
const OUTPUT_TYPES: Readonly<Record<string, string>> = {
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * `text` as one folder name: characters a file system treats specially (and control characters) become `_`, leading
 * and trailing dots and spaces go, it is at most 100 characters, and `disc` stands in when nothing is left.
 */
export function safePathSegment(text: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').slice(0, 100);
  return cleaned.replace(/[.\s]+$/, '') || 'disc';
}

/** Answers a refusal: its status, code, message and any more fields. */
function refuse(res: ServerResponse, e: JobError): void {
  json(res, e.status, { error: e.code, message: e.message, ...e.extra });
}

/** Runs `fn`, answering a `JobError` it throws as its refusal. */
async function answering(res: ServerResponse, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof JobError) return refuse(res, e);
    throw e;
  }
}

/** A captured, percent-encoded path segment, decoded; a bad escape becomes a value no job has. */
function idOf(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/** Reads a JSON object body; undefined (after answering 413 or 400) when it is too large or not a JSON object. */
async function bodyOf(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const bytes = await readBody(req, MAX_BODY);
  if (bytes === null) {
    res.setHeader('Connection', 'close');
    httpError(res, 413, 'too-large', 'That request is too large.');
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // answered below
  }
  httpError(res, 400, 'bad-request', 'The body must be a JSON object.');
  return undefined;
}

/** Streams the queue as server-sent events until the client goes away. */
const jobEvents: Route = async (req, res, _match, app) => {
  const runner = jobRunnerOf(app);
  await runner.ready;
  // Refused before the stream opens: an empty list would look like an empty queue.
  const unreadable = runner.unreadableError;
  if (unreadable !== null) return refuse(res, unreadable);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const onJobs = (jobs: Job[]): void => send('jobs', { jobs });
  const onProgress = (p: JobProgress): void => send('progress', p);
  send('jobs', { jobs: runner.list() });
  runner.events.on('jobs', onJobs);
  runner.events.on('progress', onProgress);
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  ping.unref();
  const stop = (): void => {
    clearInterval(ping);
    runner.events.off('jobs', onJobs);
    runner.events.off('progress', onProgress);
  };
  req.on('close', stop);
  res.on('close', stop);
};

/**
 * Answers the file `segments` names under `root`, whole or one range, with the content type `typeOf` gives: 400
 * `bad-path` for an empty, `.` or `..` segment or one holding a separator, and 404 for anything that is not a regular
 * file whose real path is inside `root`'s, or (with `noLinks`) that is itself a symbolic link.
 */
async function serveUnder(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  segments: readonly string[],
  typeOf: (file: string) => string,
  noLinks = false,
): Promise<void> {
  // The server refuses these already; the route does not rely on it.
  if (segments.some((s) => s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s))) return httpError(res, 400, 'bad-path');
  let file: string;
  let size: number;
  try {
    const realRoot = await realpath(root);
    const asked = join(realRoot, ...segments);
    if (noLinks && (await lstat(asked)).isSymbolicLink()) return httpError(res, 404, 'not-found', 'There is no such file.');
    file = await realpath(asked);
    if (!file.startsWith(realRoot + sep)) return httpError(res, 404, 'not-found', 'There is no such file.');
    const st = await stat(file);
    if (!st.isFile()) return httpError(res, 404, 'not-found', 'There is no such file.');
    size = st.size;
  } catch {
    return httpError(res, 404, 'not-found', 'There is no such file.');
  }
  sendFile(req, res, file, size, { 'Content-Type': typeOf(file), 'Cache-Control': 'no-store' });
}

/** Answers a file under a job's own output folder, whole or one range. */
const serveOutput: Route = async (req, res, match, app) => {
  const runner = jobRunnerOf(app);
  await runner.ready;
  const job = runner.get(idOf(match[1]!));
  if (job === null) return httpError(res, 404, 'not-found', 'There is no such job.');
  await serveUnder(req, res, job.outDir, match[2]!.split('/').map(idOf), (file) => OUTPUT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
};

/**
 * Answers one sample of a test job, `<data>/tests/<job>/<profile>/<n>.webm`, whole or one range: only from a test
 * job's own folder, worked out from its id, and never through a symbolic link.
 */
const serveSample: Route = async (req, res, match, app) => {
  const runner = jobRunnerOf(app);
  await runner.ready;
  const job = runner.get(idOf(match[1]!));
  if (job === null || job.kind !== 'test') return httpError(res, 404, 'not-found', 'There is no such test.');
  const profile = idOf(match[2]!);
  const name = idOf(match[3]!);
  if (!/^[a-z0-9]{1,32}$/.test(profile) || !/^[1-9]\d{0,2}\.webm$/.test(name)) return httpError(res, 404, 'not-found', 'There is no such sample.');
  await serveUnder(req, res, testDirOf(app.dataDir, job.id), [profile, name], () => 'video/webm', true);
};

/**
 * The job routes:
 *
 *   GET /api/jobs                    `{ jobs: Job[] }`, oldest first
 *   POST /api/jobs                   body `{ kind?, discKey, playlistId, episodeSpec, settings, outDir, noSubtitles? }`, or
 *                                    for a test `{ kind: 'test', discKey, playlistId, episodeSpec, profiles }` with one to
 *                                    three `{ id, name, settings }`; 201 with the Job
 *   POST /api/jobs/<id>/cancel       the Job, once it has stopped; 409 `not-cancellable`
 *   POST /api/jobs/<id>/retry        the Job; 409 `not-retryable`
 *   DELETE /api/jobs/<id>            `{ deleted: true }` for a finished job; 409 `not-finished`
 *   GET /api/jobs/<id>/log?tail=N    the last N lines of the job's log as text (default and most 2000)
 *   GET /api/jobs/defaults?disc=&playlist=   `{ outDir }`: `<data>/output/<disc label>/<playlist>`, the folder the queue dialog offers
 *   GET /api/jobs/events            server-sent events: `jobs` with `{ jobs }` on connect and on every change, and
 *                                    `progress` with a `JobProgress` (see `JobRunner`)
 *   GET|HEAD /api/outputs/<id>/<path>   a file under that job's output folder, whole or one range
 *   GET|HEAD /api/tests/<id>/<profile>/<n>.webm   a test job's sample, whole or one range, as `video/webm`
 *
 * Refusals are `{ error, message, ... }` (see `JobRunner.add`); an unknown job answers 404 `not-found`. While
 * `jobs.json` cannot be read, every job route, the list and the event stream included, answers 500 `jobs-unreadable`
 * (the stream before it opens, so a browser's EventSource fails and does not reconnect), never an empty queue.
 */
export const jobRoutes: RouteTable = [
  [
    'GET',
    /^\/api\/jobs$/,
    async (_req, res, _match, app) => {
      const runner = jobRunnerOf(app);
      await runner.ready;
      const unreadable = runner.unreadableError;
      if (unreadable !== null) return refuse(res, unreadable);
      json(res, 200, { jobs: runner.list() });
    },
  ],
  [
    'POST',
    /^\/api\/jobs$/,
    async (req, res, _match, app) => {
      const body = await bodyOf(req, res);
      if (body === undefined) return;
      await answering(res, async () => {
        const job = await jobRunnerOf(app).add({
          kind: body.kind,
          discKey: body.discKey,
          playlistId: body.playlistId,
          episodeSpec: body.episodeSpec,
          settings: body.settings,
          profiles: body.profiles,
          outDir: body.outDir,
          noSubtitles: body.noSubtitles,
        });
        json(res, 201, job);
      });
    },
  ],
  ['GET', /^\/api\/jobs\/events$/, jobEvents],
  [
    'GET',
    /^\/api\/jobs\/defaults$/,
    async (req, res, _match, app) => {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const discKey = q.get('disc');
      const playlist = q.get('playlist');
      if (discKey === null || playlist === null || !/^\d{5}$/.test(playlist)) {
        return httpError(res, 400, 'bad-request', 'disc and a five-digit playlist are needed.');
      }
      const dir = await sessionsOf(app).discDirOf(discKey);
      if (dir === null) return httpError(res, 404, 'not-found', 'No disc the app knows has that key.');
      const disc = await discOf(app, dir);
      json(res, 200, { outDir: join(app.dataDir, 'output', safePathSegment(disc.label), playlist) });
    },
  ],
  [
    'POST',
    /^\/api\/jobs\/([^/]+)\/cancel$/,
    (_req, res, match, app) => answering(res, async () => json(res, 200, await jobRunnerOf(app).cancel(idOf(match[1]!)))),
  ],
  [
    'POST',
    /^\/api\/jobs\/([^/]+)\/retry$/,
    (_req, res, match, app) => answering(res, async () => json(res, 200, await jobRunnerOf(app).retry(idOf(match[1]!)))),
  ],
  [
    'DELETE',
    /^\/api\/jobs\/([^/]+)$/,
    (_req, res, match, app) =>
      answering(res, async () => {
        await jobRunnerOf(app).remove(idOf(match[1]!));
        json(res, 200, { deleted: true });
      }),
  ],
  [
    'GET',
    /^\/api\/jobs\/([^/]+)\/log$/,
    (req, res, match, app) =>
      answering(res, async () => {
        const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('tail');
        const tail = raw === null ? MAX_LOG_TAIL : Number(raw);
        if (!Number.isInteger(tail) || tail < 0) return httpError(res, 400, 'bad-request', 'tail must be a whole number.');
        const lines = await jobRunnerOf(app).logTail(idOf(match[1]!), tail);
        const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), 'Cache-Control': 'no-store' });
        res.end(text);
      }),
  ],
  ['GET', /^\/api\/outputs\/([^/]+)\/(.+)$/, serveOutput],
  ['HEAD', /^\/api\/outputs\/([^/]+)\/(.+)$/, serveOutput],
  ['GET', /^\/api\/tests\/([^/]+)\/([^/]+)\/([^/]+)$/, serveSample],
  ['HEAD', /^\/api\/tests\/([^/]+)\/([^/]+)\/([^/]+)$/, serveSample],
];
