// SPDX-License-Identifier: LGPL-3.0-or-later
import { timingSafeEqual } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';
import { alignRoutes } from './align-routes';
import { discRoutes, prepareDisc } from './disc-routes';
import { fansubRoutes } from './fansub-routes';
import { httpError, sendFile, type HelperContext, type RouteTable } from './http';
import { recordRoutes } from './record-routes';
import { titleRoutes } from './title-routes';

export type { HelperContext, HelperSources, Route, RouteTable } from './http';

// The helper backend: a plain Node HTTP server on 127.0.0.1 that serves the helper page and its API. It is reachable
// only from this machine, but any web page the user opens can still send requests to it, so every API request needs
// the run's token, and the Host header must name the server itself, which stops a page that rebinds its own name to
// 127.0.0.1 (DNS rebinding) from reading the answers.

/** Every route the API answers, in match order. */
const ROUTES: RouteTable = [...discRoutes, ...titleRoutes, ...fansubRoutes, ...alignRoutes, ...recordRoutes];

/**
 * Cross-origin isolation on every answer: the page needs SharedArrayBuffer for the engine, and the API's answers are
 * same-origin resources.
 */
const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.jar': 'application/java-archive',
  '.txt': 'text/plain; charset=utf-8',
};

/** The running helper server. */
export interface HelperServer {
  /** `http://127.0.0.1:<port>/`, ending with a slash. */
  readonly url: string;
  readonly port: number;
  /** Stops listening and drops open connections. */
  close(): Promise<void>;
}

/**
 * The decoded segments of a URL path, or null when one is empty, `.` or `..`, or carries a slash, backslash or NUL
 * once decoded, or does not decode: no request may name a file outside the folder it is served from.
 */
function safeSegments(pathname: string): string[] | null {
  if (!pathname.startsWith('/')) return null;
  if (pathname === '/') return [];
  const out: string[] = [];
  for (const segment of pathname.slice(1).split('/')) {
    let s: string;
    try {
      s = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s)) return null;
    out.push(s);
  }
  return out;
}

function tokenMatches(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token a request carries: `Authorization: Bearer`, else the `t` query parameter (what the engine's reads use). */
function requestToken(req: IncomingMessage, query: URLSearchParams): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return bearer ? bearer[1]!.trim() : query.get('t');
}

/** Whether `host` names this server: `127.0.0.1:<port>` or `localhost:<port>`, the only names the page is opened by. */
function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const lower = host.toLowerCase();
  return lower === `127.0.0.1:${port}` || lower === `localhost:${port}`;
}

/** stat of `rel` under `dir` (a real path), or null when it is missing or resolves through a link outside `dir`. */
function containedFile(dir: string, rel: string): { path: string; size: number } | null {
  try {
    const real = realpathSync(join(dir, rel));
    if (real !== dir && !real.startsWith(dir + sep)) return null;
    const st = statSync(real);
    return st.isFile() ? { path: real, size: st.size } : null;
  } catch {
    return null;
  }
}

async function api(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams, ctx: HelperContext): Promise<void> {
  if (!tokenMatches(requestToken(req, query), ctx.token)) return httpError(res, 401, 'unauthorized');
  let pathMatched = false;
  for (const [method, pattern, route] of ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (method === req.method) return route(req, res, match, ctx);
  }
  if (pathMatched) return httpError(res, 405, 'method-not-allowed');
  httpError(res, 404, 'not-found');
}

function servePage(req: IncomingMessage, res: ServerResponse, webDir: string | null, segments: readonly string[]): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') return httpError(res, 405, 'method-not-allowed');
  const rel = segments.length === 0 ? 'index.html' : segments.join('/');
  const file = webDir === null ? null : containedFile(webDir, rel);
  if (!file) return httpError(res, 404, 'not-found');
  // no-cache: a rebuilt page shows on reload
  sendFile(req, res, file.path, file.size, {
    'Content-Type': MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
}

/**
 * Starts the helper backend for `ctx` on 127.0.0.1 at `port` (0 picks a free one). The disc is read first, so the
 * promise rejects when `ctx.discDir` is not a Blu-ray folder, and when the port cannot be bound.
 *
 * Every answer carries the cross-origin isolation headers. Requests whose Host is not this server answer 403
 * `bad-host`; paths with an empty, `.` or `..` segment answer 400 `bad-path`. Under `/api/` a request without the
 * run's token answers 401 `unauthorized`, an unknown path 404 `not-found`, a known path with another method 405;
 * API answers are never cached. Anything else is a file of `ctx.webDir` (`/` is its index.html), served without a
 * token. A route that throws answers 500 `internal`.
 */
export async function startHelperServer(ctx: HelperContext, port = 0): Promise<HelperServer> {
  await prepareDisc(ctx);
  const webDir = ctx.webDir === null ? null : realpathSync(ctx.webDir);
  let boundPort = 0;

  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(name, value);
    if (!hostAllowed(req.headers.host, boundPort)) return httpError(res, 403, 'bad-host', 'Open the helper at the address it printed.');
    const target = req.url ?? '/';
    const [pathname = '/', search = ''] = target.split('#', 1)[0]!.split(/\?(.*)/s, 2);
    const segments = safeSegments(pathname);
    if (!segments) return httpError(res, 400, 'bad-path');
    if (segments[0] !== 'api') return servePage(req, res, webDir, segments);
    api(req, res, pathname, new URLSearchParams(search), ctx).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      httpError(res, 500, 'internal', e instanceof Error ? e.message : String(e));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  boundPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${boundPort}/`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
