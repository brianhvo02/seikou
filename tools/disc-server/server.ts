/// <reference types="node" />
/*
 * Development disc server (spec 2026-10-17 §4.5): serves disc folders on the Mac to devices on the home network, and the
 * built player from the same origin. It speaks the NAS server's disc API (docs/superpowers/specs/2026-10-17-nas-server-
 * design.md): the library listing, manifests with inlined metadata and range reads under `/api/`, so the player opens
 * its discs through the same RemoteSource and HttpTransport as a NAS disc (ruling R19).
 *
 *   npm run disc-server -- --root <dir> [--root <dir>…] [--port 8443] [--cert cert.pem --key key.pem] [--dist dist]
 *
 * Node built-ins and the NAS server's own modules. See README.md.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DiscEntry, LibraryListing } from '@seikou/nas/nas-api';
// The NAS server's own manifest, file resolution and range parsing: the dev server answers exactly as the NAS does.
import { buildManifest, largestClip, resolveDiscFile } from '../../server/src/manifest';
import { parseRange } from '../../server/src/ranges';

export { parseRange };

export interface Disc {
  /** Stable across runs: a hash of the disc folder's real path. */
  readonly id: string;
  readonly name: string;
  /** Real path of the folder that contains BDMV. */
  readonly dir: string;
  /** The folder relative to the root it was found under, prefixed with that root's name (DiscEntry.path). */
  readonly path: string;
}

export interface DiscHandlerOptions {
  readonly roots: readonly string[];
  readonly token: string;
  /** The built player (`npm run build`), served without a token at `/`. */
  readonly distDir?: string;
  /** Test seam: the client address the LAN filter checks (the socket's by default). */
  readonly remoteAddressOf?: (req: IncomingMessage) => string | undefined;
}

/** How deep under a root disc folders are looked for. */
const MAX_DEPTH = 4;

/** The headers `public/_headers` sets, plus CORP: the player needs cross-origin isolation for SharedArrayBuffer. */
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
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.jar': 'application/java-archive',
  '.txt': 'text/plain; charset=utf-8',
};

/** Loopback, RFC 1918, link-local and IPv6 unique-local addresses: the home network. Tailscale's 100.64/10 is not. */
export function isLocalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const a = mapped ? mapped[1]! : address;
  const kind = isIP(a);
  if (kind === 4) {
    const [b0, b1] = a.split('.').map(Number) as [number, number];
    return b0 === 127 || b0 === 10 || (b0 === 172 && b1 >= 16 && b1 <= 31) || (b0 === 192 && b1 === 168) || (b0 === 169 && b1 === 254);
  }
  if (kind === 6) {
    const lower = a.toLowerCase();
    if (lower === '::1') return true;
    const first = Number.parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00; // fe80::/10, fc00::/7
  }
  return false;
}

function childNamed(dir: string, name: string): string | null {
  try {
    const found = readdirSync(dir).find((n) => n.toUpperCase() === name);
    return found === undefined ? null : join(dir, found);
  } catch {
    return null;
  }
}

function isDisc(dir: string): boolean {
  const bdmv = childNamed(dir, 'BDMV');
  const index = bdmv && childNamed(bdmv, 'INDEX.BDMV');
  return index !== null && statSync(index).isFile();
}

/** Every folder under `roots` (or a root itself) that contains BDMV/index.bdmv, sorted by name. */
export function findDiscs(roots: readonly string[]): Disc[] {
  const discs = new Map<string, Disc>();
  const visit = (dir: string, depth: number, path: string): void => {
    if (isDisc(dir)) {
      const real = realpathSync(dir);
      const id = createHash('sha256').update(real).digest('hex').slice(0, 16);
      discs.set(id, { id, name: basename(dir), dir: real, path });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const child = join(dir, name);
      try {
        if (statSync(child).isDirectory()) visit(child, depth + 1, `${path}/${name}`);
      } catch {
        // unreadable or a dangling link
      }
    }
  };
  for (const root of roots) visit(resolve(root), 0, basename(resolve(root)));
  return [...discs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** stat of `rel` under `dir`, or null when it does not exist or resolves (through a link) outside `dir`. */
function containedStat(dir: string, rel: string): Stats | null {
  try {
    const real = realpathSync(join(dir, rel));
    if (real !== dir && !real.startsWith(dir + sep)) return null;
    return statSync(real);
  } catch {
    return null;
  }
}

/**
 * The decoded segments of a URL path, or null when one is empty, `.` or `..`, or carries a slash, backslash or NUL
 * once decoded: nothing may name a file outside the folder it is served from.
 */
export function safeSegments(pathname: string): string[] | null {
  if (!pathname.startsWith('/')) return null;
  const raw = pathname.slice(1).split('/');
  if (raw.length === 1 && raw[0] === '') return [];
  const out: string[] = [];
  for (const segment of raw) {
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

/** The token as the NAS server takes it (server/src/app.ts requireToken): `Authorization: Bearer`, else the `t=` query. */
function requestToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  const bearer = header && /^Bearer\s+(.+)$/i.exec(header);
  return bearer ? bearer[1]!.trim() : url.searchParams.get('t');
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${text}\n`);
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** Bytes of the regular files under a disc folder's BDMV and CERTIFICATE, the ones its manifest lists (links are not followed). */
function discBytes(dir: string): number {
  let total = 0;
  const walk = (abs: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      try {
        const st = lstatSync(join(abs, name));
        if (st.isDirectory()) walk(join(abs, name));
        else if (st.isFile()) total += st.size;
      } catch {
        // vanished meanwhile
      }
    }
  };
  for (const top of ['BDMV', 'CERTIFICATE']) {
    const found = childNamed(dir, top);
    if (found) walk(found);
  }
  return total;
}

/** A disc as the NAS library lists it. */
function discEntry(disc: Disc): DiscEntry {
  return { id: disc.id, name: disc.name, path: disc.path, kind: 'folder', sizeBytes: discBytes(disc.dir) };
}

/** The Vite dev server's port (`npm run dev`), whose pages may read the API across origins. */
export const VITE_DEV_PORT = '5173';

/**
 * Whether a page at `origin` may read the API: the server's own origin (`own`, from the request's Host), or the Vite dev
 * server on loopback or this home network (`http(s)://localhost|<private address>:5173`).
 */
export function corsAllowed(origin: string, own: string | null): boolean {
  if (own !== null && origin === own) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.port !== VITE_DEV_PORT) return false;
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || isLocalAddress(host);
}

/** First 4 MiB of the largest clip, as the NAS's probe route sends it (the pre-flight throughput check). */
const PROBE_BYTES = 4_194_304;

/**
 * A file, whole (200) or one range of it (206), streamed from disk: never more than the asked range is read. `ranges`
 * false sends the first `size` bytes whole, whatever the request asks (the probe).
 */
function sendFile(req: IncomingMessage, res: ServerResponse, path: string, size: number, headers: Record<string, string>, ranges = true): void {
  const range = ranges ? parseRange(req.headers.range, size) : null;
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy()); // the client gave up (a seek aborted the read): stop reading the disk
  stream.pipe(res);
}

/**
 * The request handler: LAN filter, then the token-protected NAS disc API under `/api/`, then the player at `/`.
 *
 *   GET /api/library?path=                  LibraryListing: every disc, flat (no folders), never scanning
 *   GET /api/discs/<id>/manifest            DiscManifest (server/src/manifest.ts buildManifest)
 *   GET|HEAD /api/discs/<id>/files/<path>   a Range of the file (any case, under BDMV or CERTIFICATE), or all of it
 *   GET|HEAD /api/discs/<id>/probe          the first 4 MiB of the largest clip
 *
 * Errors are the NAS's: 401 `{ error: 'unauthorized' }`, 404 `{ error: 'disc-changed' }` for an unknown disc (the
 * engine shows "This disc changed"), 404 `{ error: 'not found' }` for a missing file.
 */
export function createDiscHandler(options: DiscHandlerOptions): RequestListener {
  const remoteOf = options.remoteAddressOf ?? ((req: IncomingMessage) => req.socket.remoteAddress);
  const distDir = options.distDir && existsSync(options.distDir) ? realpathSync(options.distDir) : null;
  let discs = findDiscs(options.roots);
  const discById = (id: string): Disc | undefined => {
    const found = discs.find((d) => d.id === id);
    if (found) return found;
    discs = findDiscs(options.roots); // a disc added since the last listing
    return discs.find((d) => d.id === id);
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL, segments: readonly string[]): Promise<void> => {
    if (!tokenMatches(requestToken(req, url), options.token)) return json(res, { error: 'unauthorized' }, 401);
    const read = segments[1] === 'discs' && segments[3] !== 'manifest';
    if (req.method === 'HEAD' && !read) return plain(res, 405, 'Method not allowed.');
    if (segments.length === 2 && segments[1] === 'library') {
      discs = findDiscs(options.roots);
      const listing: LibraryListing = { folders: [], discs: discs.map(discEntry), scanning: false };
      return json(res, listing);
    }
    if (segments[1] !== 'discs' || segments.length < 4) return json(res, { error: 'not found' }, 404);
    const disc = discById(segments[2]!);
    if (!disc || !isDisc(disc.dir)) return json(res, { error: 'disc-changed' }, 404);
    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (segments.length === 4 && segments[3] === 'manifest') return json(res, await buildManifest(disc.dir, { id: disc.id, name: disc.name }));
    if (segments.length === 4 && segments[3] === 'probe') {
      const clip = await largestClip(disc.dir);
      if (!clip) return json(res, { error: 'not found' }, 404);
      return sendFile(req, res, clip.abs, Math.min(clip.size, PROBE_BYTES), headers, false);
    }
    if (segments.length > 4 && segments[3] === 'files') {
      const file = await resolveDiscFile(disc.dir, segments.slice(4).join('/'));
      if (!file) return json(res, { error: 'not found' }, 404);
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        return json(res, { error: 'not found' }, 404);
      }
      return sendFile(req, res, file, size, headers);
    }
    return json(res, { error: 'not found' }, 404);
  };

  return (req, res) => {
    const remote = remoteOf(req);
    if (!remote || !isLocalAddress(remote)) return plain(res, 403, 'Only devices on the local network may connect.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return plain(res, 405, 'Method not allowed.');
    const target = req.url ?? '/';
    const url = new URL(target, 'http://disc-server'); // for the query only: URL resolves `..` in the path
    const segments = safeSegments(target.split(/[?#]/, 1)[0]!);
    if (!segments) return plain(res, 400, 'Bad path.');

    if (segments[0] !== 'api') {
      if (req.method === 'OPTIONS') return plain(res, 405, 'Method not allowed.');
      return serveApp(req, res, distDir, segments);
    }

    // CORS, so the Vite dev server on this Mac or the LAN can open discs too (the token still gates every read); any other
    // origin gets no Access-Control-Allow-Origin, so a page elsewhere cannot read the API even with a token
    const origin = req.headers.origin;
    const own = req.headers.host ? `${(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${req.headers.host}` : null;
    const cors: Record<string, string> = { Vary: 'Origin' };
    if (origin && corsAllowed(origin, own)) {
      cors['Access-Control-Allow-Origin'] = origin;
      cors['Access-Control-Expose-Headers'] = 'Content-Range, Content-Length, Accept-Ranges';
    }
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Authorization, Range', 'Access-Control-Max-Age': '600' });
      res.end();
      return;
    }
    api(req, res, url, segments).catch(() => {
      if (!res.headersSent) json(res, { error: 'internal' }, 500);
      else res.destroy();
    });
  };
}

function serveApp(req: IncomingMessage, res: ServerResponse, distDir: string | null, segments: readonly string[]): void {
  if (!distDir) return plain(res, 404, 'The player is not built: run npm run build, or pass --dist.');
  let rel = segments.length === 0 ? 'index.html' : segments.join('/');
  let stat = containedStat(distDir, rel);
  // A deep path such as /nas/title/… is the app's own route, not a file: it loads the shell, as the Vite dev and preview
  // servers and Cloudflare Pages do. Under /nas any last segment is a route (play links end in `f.<hex>`, which has an
  // extension-like suffix); elsewhere a path with an extension that is not a file is still a 404.
  if (!stat?.isFile() && (segments[0] === 'nas' || extname(rel) === '')) {
    rel = 'index.html';
    stat = containedStat(distDir, rel);
  }
  if (!stat?.isFile()) return plain(res, 404, 'Not found.');
  // no-cache: a rebuild shows up on reload (the service worker precaches by revision anyway)
  sendFile(req, res, join(distDir, rel), stat.size, {
    ...ISOLATION_HEADERS,
    'Content-Type': MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
}

/** A disc's API base on the server at `origin` (`RemoteDiscSpec.base`, the player's `?disc=`): `<origin>/api/discs/<id>/`. */
export function discApiBase(origin: string, id: string): string {
  return `${origin}/api/discs/${encodeURIComponent(id)}/`;
}

/**
 * The API base of the disc named `name` on a running disc server at `origin`, looked up in its library listing (what the
 * device tools open as `?disc=`).
 */
export async function servedDiscBase(origin: string, token: string, name: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${origin}/api/library?path=`, { headers: { Authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`the disc server answered ${response.status} to /api/library`);
  const listing = (await response.json()) as LibraryListing;
  const found = listing.discs.find((d) => d.name === name);
  if (!found) throw new Error(`the disc server has no disc named "${name}" (it has: ${listing.discs.map((d) => d.name).join(', ')})`);
  return discApiBase(origin, found.id);
}

/** The machine's loopback and private LAN IPv4 addresses: the only ones the server listens on. */
export function listenAddresses(): string[] {
  const out = new Set<string>(['127.0.0.1']);
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && isLocalAddress(info.address)) out.add(info.address);
    }
  }
  return [...out];
}

interface CliOptions {
  roots: string[];
  port: number;
  cert: string | null;
  key: string | null;
  dist: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { roots: [], port: 8443, cert: null, key: null, dist: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--root') opts.roots.push(value);
    else if (flag === '--port') opts.port = Number(value);
    else if (flag === '--cert') opts.cert = value;
    else if (flag === '--key') opts.key = value;
    else if (flag === '--dist') opts.dist = value;
    else throw new Error(`unknown option ${flag}`);
    i++;
  }
  if (opts.roots.length === 0) throw new Error('give at least one --root <dir>');
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) throw new Error('--port must be a port number');
  if ((opts.cert === null) !== (opts.key === null)) throw new Error('--cert and --key go together');
  return opts;
}

function main(argv: readonly string[]): void {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`disc-server: ${(e as Error).message}`);
    console.error('usage: npm run disc-server -- --root <dir> [--root <dir>…] [--port 8443] [--cert cert.pem --key key.pem] [--dist dist]');
    process.exit(2);
  }
  const token = randomBytes(18).toString('base64url');
  const handler = createDiscHandler({ roots: opts.roots, token, distDir: opts.dist });
  const tls = opts.cert && opts.key ? { cert: readFileSync(opts.cert), key: readFileSync(opts.key) } : null;
  // Without a certificate only loopback is served: a LAN page over plain HTTP is not a secure context (no SharedArrayBuffer).
  const addresses = tls ? listenAddresses() : ['127.0.0.1'];
  const scheme = tls ? 'https' : 'http';
  for (const address of addresses) {
    const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
    server.on('error', (e) => console.error(`disc-server: ${address}:${opts.port}: ${e.message}`));
    server.listen(opts.port, address);
  }
  const discs = findDiscs(opts.roots);
  if (!existsSync(opts.dist)) console.warn(`disc-server: ${opts.dist} does not exist; run npm run build to serve the player.`);
  console.log(tls ? `certificate: ${resolve(opts.cert!)}` : 'no --cert/--key: plain HTTP on loopback only (see tools/disc-server/README.md).');
  // the address devices reach: a private one before a link-local (169.254) one
  const lan = addresses.find((a) => a !== '127.0.0.1' && !a.startsWith('169.254.')) ?? addresses.find((a) => a !== '127.0.0.1') ?? '127.0.0.1';
  const origin = `${scheme}://${lan}:${opts.port}`;
  console.log(`\nPlayer (lists the discs): ${origin}/?token=${token}`);
  console.log(discs.length === 0 ? '\nNo discs (folders containing BDMV/index.bdmv) under the roots.' : '\nDiscs:');
  for (const d of discs) console.log(`  ${d.name}: ${origin}/?disc=${encodeURIComponent(discApiBase(origin, d.id))}&token=${token}`);
  console.log(`\nListening on ${addresses.map((a) => `${a}:${opts.port}`).join(', ')}. Ctrl-C stops.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
