/// <reference types="node" />
/**
 * The NAS side of nas.spec.ts, started by Playwright's webServer (`npx tsx tests/e2e/nas-server.ts`, after
 * `npm run server:build`): the built NAS server on NAS_PORT, serving a temporary copy of fixtures/synthetic as root
 * `syn`, and the rendezvous Worker's fetch handler, with in-memory storage, on RENDEZVOUS_PORT.
 *
 * The title library's AniList and TMDB are the recorded entries of tests/e2e/fixtures/nas-metadata.json
 * (`METADATA_FIXTURE`, ruling R3), made-up titles that match the folders TITLE_DISCS puts synthetic discs in. Starfall
 * Wanderer's runtime of 0.0667 minutes (4 s) makes disc1's 4-second playlist 00001 its one episode. The Music shelf's
 * lookups are the recorded releases of tests/e2e/fixtures/nas-music.json (`MUSIC_FIXTURE`), made up as well, and its one
 * release folder holds a generated `cover.png` (`MUSIC_COVER`). SeaDex and Anime Tosho are the recorded answers in
 * tests/e2e/fixtures/fansubs (`FANSUB_FIXTURE`).
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Not 4190: that is ManageSieve's, one of the Fetch standard's bad ports, which Firefox and WebKit refuse to reach. */
export const NAS_PORT = 4192;
export const RENDEZVOUS_PORT = 4191;
export const RENDEZVOUS_URL = `http://localhost:${RENDEZVOUS_PORT}`;
/** Recreated on every start. */
export const NAS_E2E_DIR = join(REPO, '.cache/e2e-nas');
/** The copy of fixtures/synthetic the server serves as root `syn`. */
export const NAS_ROOT = join(NAS_E2E_DIR, 'syn');
/** Discs each browser deletes from the root: between listing and pre-flight (`changed/<project>`), and between pre-flight and opening (`changed/<project>-open`). */
export const CHANGED_FOLDER = 'changed';
export const PROJECTS = ['chromium', 'firefox', 'webkit'] as const;
export const SERVER = join(REPO, 'server/dist/server.mjs');
/** The recorded metadata entries the server matches discs against. */
export const METADATA_FIXTURE = join(REPO, 'tests/e2e/fixtures/nas-metadata.json');
/** The recorded SeaDex and Anime Tosho answers for Starfall Wanderer's fansubs (made up; `make-fixtures.ts` there). */
export const FANSUB_FIXTURE = join(REPO, 'tests/e2e/fixtures/fansubs');
/** The recorded music releases (catalogue number → MusicBrainz-shaped release) the server looks music discs up in. */
export const MUSIC_FIXTURE = join(REPO, 'tests/e2e/fixtures/nas-music.json');
/** The Music shelf's release folder, recorded in MUSIC_FIXTURE by its catalogue number. */
export const MUSIC_RELEASE = 'Music/[2024.05.01] Lantern Parade - Night Lights [CD][ZQCL-2468]';
/**
 * Where the stand-in puts the disc the encodes fixture was cut from (`encoder/fixtures/disc-speech`, whose key the
 * episodes' `SEIKOU_DISC_KEY` tag names), so subtitles stored for its playlist reach the episodes. Nothing names it: it
 * is an Unsorted disc.
 */
export const ENCODE_SOURCE_FOLDER = 'Encode source/disc-speech';
/** The key of that disc, as the episodes' tags name it. */
export const ENCODE_SOURCE_KEY = 'f.148C2FD8E35B72A696EB6FB331CB0AE7';

/** Copies of synthetic discs in the folders the metadata fixture's titles match: root-relative folder → fixture disc. */
export const TITLE_DISCS: Readonly<Record<string, string>> = {
  'Anime/Starfall Wanderer (星降りの旅人)/Starfall Wanderer Vol.1': 'disc1',
  'Anime/Starfall Wanderer (星降りの旅人)/Starfall Wanderer Vol.2': 'disc-subs',
  'Anime/Moonlit Harbor (月影の港)/Moonlit Harbor': 'disc2',
  [MUSIC_RELEASE]: 'disc3',
};

/**
 * Each browser's own Unsorted discs (the owner screens' tests change their choices, and the projects run side by side):
 * two discs of a made-up series with no disc number (`no-disc-number`, the series suggested, each with a catalogue
 * number), and one disc nothing names (`no-title`). Named in the metadata fixture as anilist:90011x.
 */
export const OWNER_SERIES: Readonly<Record<(typeof PROJECTS)[number], string>> = { chromium: 'Ember Tide', firefox: 'Paper Comet', webkit: 'Glass Orchard' };
/** The project's disc nothing names, its folder name unique so each browser finds only its own card. */
export const ownerStray = (project: (typeof PROJECTS)[number]): string => `Stray Reel ${project}`;
/** Root-relative folders of a project's owner discs: the series' two, then the stray one. */
export function ownerDiscs(project: (typeof PROJECTS)[number]): { series: [string, string]; stray: string } {
  const name = OWNER_SERIES[project];
  const at = `Owner/${project}`;
  return { series: [`${at}/${name}/${name} [ZMXA-1101]`, `${at}/${name}/${name} [ZMXA-1102]`], stray: `${at}/${ownerStray(project)}` };
}

/**
 * The production CORS policy (packages/nas/src/cors-policy.ts) allows the preview on localhost:4173 only. When the
 * preview runs on another port (E2E_PORT, a second checkout), the stand-ins below present the page's origin to the NAS
 * server and the rendezvous Worker as 4173's, and the allowed origin they answer back as the page's: a test-only
 * translation, so the deployed policy stays as it is. With E2E_PORT unset or 4173 nothing is rewritten.
 */
const POLICY_ORIGIN = 'http://localhost:4173';
const PAGE_ORIGIN = `http://localhost:${process.env.E2E_PORT ?? 4173}`;
const TRANSLATE = PAGE_ORIGIN !== POLICY_ORIGIN;
/** Where the NAS server listens behind its stand-in when origins are translated. */
const NAS_INNER_PORT = 4194;

/** The page's origin as the policy knows it, for a request on its way in. */
export function inboundOrigin(origin: string | undefined, page = PAGE_ORIGIN): string | undefined {
  return origin === page ? POLICY_ORIGIN : origin;
}

/** The allowed origin of a response on its way out, back to the page's. */
export function outboundAllowOrigin(allowed: string | undefined, page = PAGE_ORIGIN): string | undefined {
  return allowed === POLICY_ORIGIN ? page : allowed;
}

function translatedRequestHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = { ...headers };
  if (typeof headers.origin === 'string') out.origin = inboundOrigin(headers.origin);
  return out;
}

/** NAS_PORT → the NAS server on NAS_INNER_PORT, streaming both ways, with the origins translated. */
function startNasProxy(): void {
  createServer((req, res) => {
    const upstream = request(
      { host: '127.0.0.1', port: NAS_INNER_PORT, method: req.method, path: req.url, headers: translatedRequestHeaders(req.headers) },
      (answer) => {
        const headers = { ...answer.headers };
        const allowed = headers['access-control-allow-origin'];
        if (typeof allowed === 'string') headers['access-control-allow-origin'] = outboundAllowOrigin(allowed);
        res.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }).listen(NAS_PORT);
}

/** The server's environment, also what `server.mjs owner-code` needs to mint a code for it. */
export const NAS_ENV: Readonly<Record<string, string>> = {
  LIBRARY_ROOTS: `syn=${NAS_ROOT}`,
  DATA_DIR: join(NAS_E2E_DIR, 'data'),
  // Encoded episodes (the fixtures' copies); the server scans them at start.
  ENCODES_DIR: join(NAS_E2E_DIR, 'encodes'),
  PORT: String(NAS_PORT),
  PUBLIC_BASE: `http://localhost:${NAS_PORT}/api/`,
  RENDEZVOUS_URL,
  // Nothing proxies here; the default ('caddy') would only log that it does not resolve.
  TRUSTED_PROXY: '127.0.0.1',
  METADATA_FIXTURE,
  MUSIC_FIXTURE,
  FANSUB_FIXTURE,
  // Fansubs run only from the owner's button here: a nightly pass would attach tracks to the fixture series mid-run.
  FANSUB_NIGHTLY: 'off',
  // The WebRTC route on loopback: no STUN discovery, and a UDP port of its own.
  RTC_ADVERTISE: '127.0.0.1',
  RTC_PORT: '47990',
  // libx264 (needs ffmpeg on PATH): the default (qsv) would only fail its self-test here. H.264 levels encode; HEVC ones answer no-encoder.
  LEVELS_BACKEND: 'x264',
  // Viewings outlast their tests by 2 minutes (a lease lapses then), and the real budgets (about six 1080p viewings) ran out between tests.
  LEVELS_GPU_SCALE: '8',
};

/**
 * The running server's rendezvous key (its NAS id), kept here: `ownerCode()` in nas.spec.ts replaces the key file for
 * each code, and a code that should lead to this server over WebRTC is minted with this key put back.
 */
export const NAS_SERVER_KEY = join(NAS_E2E_DIR, 'server-rendezvous-key.json');

/** Makes the server's rendezvous key before it starts, in its data folder and in NAS_SERVER_KEY. */
async function makeServerKey(): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const key = JSON.stringify({ privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) });
  mkdirSync(NAS_ENV.DATA_DIR!, { recursive: true });
  writeFileSync(join(NAS_ENV.DATA_DIR!, 'rendezvous-key.json'), key, { mode: 0o600 });
  writeFileSync(NAS_SERVER_KEY, key, { mode: 0o600 });
}

/** Puts `changed/<project>` (a copy of disc1, timestamps kept so its disc id never changes) back in the root. */
export function restoreChangedDisc(project: string): string {
  const dir = join(NAS_ROOT, CHANGED_FOLDER, project);
  cpSync(join(REPO, 'fixtures/synthetic/disc1'), dir, { recursive: true, preserveTimestamps: true });
  return dir;
}

/**
 * The rendezvous Worker's fetch handler over node:http, as its tests run it (no workerd), and its signalling: the real
 * `Signalling` object per NAS id over a Node WebSocket stand-in (signalling-standin.ts).
 */
async function startRendezvous(): Promise<void> {
  // Imported here: playwright.config.ts and nas.spec.ts import this file's constants only.
  const { CodeRegistry } = await import('../../rendezvous/src/code-registry');
  const { default: worker } = await import('../../rendezvous/src/index');
  const { memoryState } = await import('../../rendezvous/src/memory-state');
  const { completeUpgrade, signallingNamespace } = await import('./signalling-standin');
  const registry = new CodeRegistry(memoryState());
  const CODE_REGISTRY = { idFromName: (name: string) => ({ name }), get: () => ({ fetch: (r: Request) => registry.fetch(r) }) };
  const env = { CODE_REGISTRY, SIGNALLING: signallingNamespace({ CODE_REGISTRY }) };
  let client = 0;
  /** Every request counts as a new client (see below). */
  const clientAddress = (): string => {
    client = (client + 1) % 65_536;
    return `198.18.${client >> 8}.${client & 255}`;
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const origin = inboundOrigin(req.headers.origin);
      if (origin !== undefined) headers.set('Origin', origin);
      // Every request counts as a new client: a run pairs a browser for each test, far more than the 10 lookups a
      // minute one address gets (that limit is unit-tested in rendezvous/).
      headers.set('CF-Connecting-IP', clientAddress());
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const request = new Request(`${RENDEZVOUS_URL}${req.url ?? '/'}`, { method: req.method, headers, body });
      worker.fetch(request, env).then(
        async (response) => {
          const out = Object.fromEntries(response.headers);
          const allowed = outboundAllowOrigin(out['access-control-allow-origin']);
          if (allowed !== undefined) out['access-control-allow-origin'] = allowed;
          res.writeHead(response.status, out);
          res.end(Buffer.from(await response.arrayBuffer()));
        },
        (err: unknown) => {
          console.error('rendezvous stand-in failed', err);
          res.writeHead(500).end();
        },
      );
    });
  });
  // Signalling sockets (`/signal/nas`, `/signal/device`): through the Worker's own routing and limits.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    headers.set('CF-Connecting-IP', clientAddress());
    worker.fetch(new Request(`${RENDEZVOUS_URL}${req.url ?? '/'}`, { method: req.method, headers }), env).then(
      (answer) => completeUpgrade(req, socket, head, answer),
      (err: unknown) => {
        console.error('rendezvous stand-in: a signalling upgrade failed', err);
        socket.destroy();
      },
    );
  });
  server.listen(RENDEZVOUS_PORT);
}

/** A small made-up PNG (a 4×4 square of one colour), the music release's folder cover. */
function coverPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const size = 4;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.from([0, ...Array.from({ length: size }, () => [0xe0, 0x7a, 0x3c]).flat()]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** Sets every file and folder under `dir` to `when`, deepest first. */
function backdateTree(dir: string, when: Date): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) backdateTree(join(dir, e.name), when);
    else utimesSync(join(dir, e.name), when, when);
  }
  utimesSync(dir, when, when);
}

async function main(): Promise<void> {
  // A fresh checkout (CI) gives the fixtures modification times of minutes ago, and the scan leaves out discs written in
  // the last hour (a download still in progress). The copies below keep these times, so set them in the past first.
  backdateTree(join(REPO, 'fixtures/synthetic'), new Date('2024-01-01T00:00:00Z'));
  rmSync(NAS_E2E_DIR, { recursive: true, force: true });
  mkdirSync(NAS_E2E_DIR, { recursive: true });
  cpSync(join(REPO, 'fixtures/synthetic'), NAS_ROOT, { recursive: true, preserveTimestamps: true });
  cpSync(join(REPO, 'fixtures/encodes'), join(NAS_E2E_DIR, 'encodes'), { recursive: true, filter: (src) => !src.endsWith('README.md') });
  // The encodes index leaves a file written in the last 10 s for its next scan (a copy in progress), 10 minutes on:
  // in the past, the copies are listed by the scan at start.
  backdateTree(join(NAS_E2E_DIR, 'encodes'), new Date('2024-01-01T00:00:00Z'));
  for (const project of PROJECTS) for (const name of [project, `${project}-open`]) restoreChangedDisc(name);
  for (const [folder, disc] of Object.entries(TITLE_DISCS)) cpSync(join(REPO, 'fixtures/synthetic', disc), join(NAS_ROOT, folder), { recursive: true, preserveTimestamps: true });
  cpSync(join(REPO, 'encoder/fixtures/disc-speech'), join(NAS_ROOT, ENCODE_SOURCE_FOLDER), { recursive: true });
  backdateTree(join(NAS_ROOT, ENCODE_SOURCE_FOLDER, '..'), new Date('2024-01-01T00:00:00Z'));
  const cover = join(NAS_ROOT, MUSIC_RELEASE, 'cover.png');
  writeFileSync(cover, coverPng());
  for (const path of [cover, join(NAS_ROOT, MUSIC_RELEASE)]) utimesSync(path, new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
  // Minimal discs: index.bdmv and one clip whose size is unique, so no two share a content fingerprint (copies would
  // share owner choices). Their times are set in the past: the scan leaves out discs written moments ago (a download
  // still in progress).
  const past = new Date('2024-01-01T00:00:00Z');
  let size = 0;
  for (const project of PROJECTS) {
    const { series, stray } = ownerDiscs(project);
    for (const folder of [...series, stray]) {
      const bdmv = join(NAS_ROOT, folder, 'BDMV');
      mkdirSync(join(bdmv, 'STREAM'), { recursive: true });
      cpSync(join(REPO, 'fixtures/synthetic/disc1/BDMV/index.bdmv'), join(bdmv, 'index.bdmv'));
      writeFileSync(join(bdmv, 'STREAM/00001.m2ts'), Buffer.alloc(192 * (1000 + size++)));
      for (const path of ['STREAM/00001.m2ts', 'index.bdmv', 'STREAM', '']) utimesSync(join(bdmv, path), past, past);
    }
  }
  await startRendezvous();
  await makeServerKey();
  const env = { ...process.env, ...NAS_ENV, ...(TRANSLATE ? { PORT: String(NAS_INNER_PORT) } : {}) };
  const server = spawn(process.execPath, [SERVER], { env, stdio: 'inherit' });
  if (TRANSLATE) startNasProxy();
  server.on('exit', (code) => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
