/**
 * The 5e live device check (Task 9): two made-up test people on the live NAS, their devices paired on a preview origin
 * of the player, BD-J saved data checked across people and devices, and the library discs left unconfirmed by the
 * library check (tools/bdj-library) opened from the NAS on a touch device with screenshots after every step.
 *
 *   npx tsx tools/devices/live-check.ts --origin https://<branch>.bluray.pages.dev --out <dir outside the repo> \
 *     --mika-phone ios:<udid> --mika-tablet ios:<udid> [--sora-a chrome-profile] [--sora-b chrome] \
 *     [--store-disc auto|<library path>|none] [--rehearse-store <library path>] [--library] [--disc <id>]…
 *
 * What it does, in order (each part is skipped with a reason when it cannot run):
 *   1. People. "Mika (test)" is made (or found) by the NAS's owner tooling over ssh (server/deploy/deploy.sh
 *      --owner-code --person), and a headless controller device is paired for it (as scripts/verify-level.ts pairs).
 *      "Sora (test)" is made through the controller's owner session (POST admin/codes {newPerson}) and gets its own
 *      controller. Every browser device is paired with a fresh code (POST admin/codes {personId}) through the app's
 *      own pairing screen (`/?pair=<code>`), on --origin only. Before pairing, a browser already paired on that origin
 *      as anyone but a test person stops the run: it is never re-paired.
 *   2. Store (disc-bdj-store, fixtures/synthetic/disc-bdj-store, from the NAS library): Mika's phone opens it and shows
 *      count 0 (libbluray's plane hash for the first opening), and Mika's NAS store reaches 1 (read back by Mika's
 *      controller); Mika's tablet shows 1 and the NAS reaches 2; Sora's first browser shows 0 and Sora's NAS store
 *      reaches 1 while Mika's stays 2; Sora's second browser shows 1 (Sora's count, never Mika's 2).
 *      --rehearse-store <library path> runs the same steps on another disc without expecting counts (a dry run).
 *   3. Library (--library): on Mika's phone, each disc id (default: the 14 unconfirmed ones) is mapped through
 *      $BDJ_LIBRARY_DIR/map.tsv to its NAS library disc, opened from the NAS, and driven with tools/bdj-library/
 *      generic.keys through the on-screen remote, with a screenshot after every step (<out>/<id>/).
 *   3b. Places (--places): a disc of two 30 s clips is generated (scripts/make-fixture-disc.ts) and placed beside the
 *      store disc. On Mika's phone it is played from the NAS folder, a stored subtitle (uploaded by Mika's controller on
 *      its playlist) is picked, and Pause saves the place at the stopped clock; reopening offers Resume at that time with
 *      the subtitle back, and Continue watching resumes it without asking. The subtitle is deleted at the end; the
 *      places go with Mika.
 *   4. Clean-up, always (also on Ctrl-C): each browser forgets its test pairing and test saved data before it closes;
 *      then Sora, then Mika is deleted (DELETE admin/people/<id>, which also clears their saved data on the NAS), and the
 *      NAS's people file is read back over ssh to confirm no test person, device or saved data is left.
 *
 * Targets: ios:<udid> (safaridriver on a real device: touch), sim:<name> (Appium on an iOS Simulator: touch),
 * chrome-profile (installed Chrome with a fresh temporary profile), chrome (another Chrome with its own context).
 * Device ids come only from the command line, and results name devices by role. Tokens and pairing codes are never
 * printed or written. Results go to --out, which must lie outside the repository.
 */

import { execFile, spawn } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MenuKey } from '../../src/engine/protocol';
import { readTar } from '../../src/engine/bdj/store/tar';
import type { DiscEntry, LibraryListing } from '../../src/engine/disc/nas-api';
import { parseKeyScript, type KeyStep } from '../../tests/bdj/key-script';
import { BAND_POINT, environment, openRemote, Page, remoteOpsFor, startTargetDriver, type GateDriver, type RemoteOps } from './gate';
import { PageReloadedError, write } from './session';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const MIKA = 'Mika (test)';
export const SORA = 'Sora (test)';
const TEST_NAMES: readonly string[] = [MIKA, SORA];
const CONTROLLER_NAME = 'live-check controller';
/** The production player: its storage is never touched. */
export const PRODUCTION_ORIGIN = 'https://bluray.pages.dev';
/** The library check's unconfirmed discs (ledger, Task 7 and 7b). */
export const UNCONFIRMED = [
  '085018d8d8', '14ac0689d3', '1f2a950e80', '52c889f003', '5a26f0e0a5', '5b2a44a1ad', '67e6e09cab',
  '735a50dd72', '8ea8027fb4', 'a9b45f88a5', 'c8ebb51ad0', 'd1ec3e501e', 'ed40609362', '49deae306e',
] as const;
/** disc-bdj-store's organisation and the app's count file (scripts/make-bdj-store-disc.ts). */
const STORE_ORG = '7fff0002';
const STORE_COUNT = '4001/count';
const STORE_DISC_NAME = 'disc-bdj-store';
const FOLDER_KEY = 'bluray-web:nas-folder';

// ---------------------------------------------------------------------------------------------------------------------
// Pure parts (live-check.test.ts)

/** The settled plane libbluray drew at disc-bdj-store's n-th opening on one storage (index 0: "count 0"). */
export function storeHashes(read: (n: number) => string = (n) => readFileSync(join(REPO, `tests/bdj/golden/disc-bdj-store.open.${n}.jsonl`), 'utf8')): string[] {
  return [1, 2, 3].map((n) => {
    const end = read(n).trim().split('\n').map((l) => JSON.parse(l) as { script?: string; hash?: string }).find((e) => e.script === 'end');
    if (!end?.hash) throw new Error(`disc-bdj-store.open.${n}.jsonl has no end hash`);
    return end.hash;
  });
}

/** The count a plane hash shows (its index in storeHashes), or null for another plane. */
export function countOf(hash: string | null, hashes: readonly string[]): number | null {
  const i = hash === null ? -1 : hashes.indexOf(hash);
  return i < 0 ? null : i;
}

/** Refuses the production origin and anything that is not a Pages preview or a local preview. */
export function checkOrigin(origin: string): string {
  const u = new URL(origin);
  if (u.origin !== origin.replace(/\/+$/, '')) throw new Error(`--origin ${origin}: give an origin only (no path)`);
  if (u.origin === PRODUCTION_ORIGIN) throw new Error('--origin is the live site: the check runs on a preview origin only');
  if (!/^https:\/\/[a-z0-9-]+\.bluray\.pages\.dev$/.test(u.origin) && !/^http:\/\/localhost:4173$/.test(u.origin)) {
    throw new Error(`--origin ${u.origin}: not a preview of the player (https://<branch>.bluray.pages.dev)`);
  }
  return u.origin;
}

/** The code `node server.mjs owner-code` printed. */
export function parseOwnerCode(out: string): { code: string; person: string | null; rendezvous: boolean } {
  const code = /Owner pairing code: ([0-9A-Z-]+)/.exec(out)?.[1];
  if (!code) throw new Error('the owner tooling printed no pairing code');
  return { code, person: /^Person: (.*)$/m.exec(out)?.[1] ?? null, rendezvous: /Rendezvous: registered/.test(out) };
}

export interface LibraryRoot {
  readonly name: string;
  /** The folder on the NAS host (/mnt/…), as the library check's map.tsv names paths. */
  readonly hostDir: string;
}

/**
 * The library roots from the NAS's own settings: LIBRARY_ROOTS (`name=dir` or `name=dir@group`) from its .env and the
 * bind mounts of its compose.override.yaml (`source:` then `target:`), with the container targets mapped back to the
 * host sources.
 */
export function parseRoots(env: string, override: string): LibraryRoot[] {
  const line = /^LIBRARY_ROOTS=(\S+)\s*$/m.exec(env)?.[1]?.replace(/^(["'])(.*)\1$/, '$2');
  if (!line) throw new Error('the NAS .env has no LIBRARY_ROOTS');
  const binds = new Map<string, string>();
  for (const m of override.matchAll(/source:\s*(\S+)\s*\n\s*target:\s*(\S+)/g)) binds.set(m[2]!.replace(/^["']|["']$/g, ''), m[1]!.replace(/^["']|["']$/g, ''));
  return line.split(',').map((entry) => {
    const eq = entry.indexOf('=');
    const name = entry.slice(0, eq);
    let dir = entry.slice(eq + 1);
    const at = dir.lastIndexOf('@');
    if (at > 0) dir = dir.slice(0, at);
    const mount = [...binds.keys()].filter((t) => dir === t || dir.startsWith(`${t}/`)).sort((a, b) => b.length - a.length)[0];
    return { name, hostDir: mount ? binds.get(mount)! + dir.slice(mount.length) : dir };
  });
}

/** A host path (map.tsv) as the NAS library's root-relative path, or null when no root holds it. */
export function libraryPath(hostPath: string, roots: readonly LibraryRoot[]): string | null {
  const root = [...roots].sort((a, b) => b.hostDir.length - a.hostDir.length).find((r) => hostPath.startsWith(`${r.hostDir}/`));
  return root ? `${root.name}/${hostPath.slice(root.hostDir.length + 1)}` : null;
}

/** map.tsv: library-check id → host path. */
/** The folder a run places its test disc in: `<root>/zz-live-check-<run id>` (run id: 8 lowercase hex digits). */
export function testDiscFolder(root: LibraryRoot, runId: string): { hostDir: string; libraryPath: string } {
  if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error(`bad run id ${runId}`);
  if (!/^\/mnt\/[A-Za-z0-9]+\/[A-Za-z]+$/.test(root.hostDir)) throw new Error(`root ${root.name} is not a /mnt/<drive>/<folder> root`);
  return { hostDir: `${root.hostDir}/zz-live-check-${runId}`, libraryPath: `${root.name}/zz-live-check-${runId}/${STORE_DISC_NAME}` };
}

/**
 * Whether `dir` is exactly the folder this run placed (the only path the clean-up may delete): one of the roots, then
 * `zz-live-check-<this run's id>`, nothing above or below it, no quotes or other characters a shell would read.
 */
export function ownTestFolder(dir: string, runId: string, roots: readonly LibraryRoot[]): boolean {
  if (!/^[0-9a-f]{8}$/.test(runId)) return false;
  return roots.some((r) => /^\/mnt\/[A-Za-z0-9]+\/[A-Za-z]+$/.test(r.hostDir) && dir === `${r.hostDir}/zz-live-check-${runId}`);
}

export function parseMap(tsv: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of tsv.split('\n').slice(1)) {
    const [id, , , path] = line.split('\t');
    if (id && path) out.set(id, path);
  }
  return out;
}

const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export interface Options {
  origin: string;
  nas: string;
  out: string;
  mikaPhone: string | null;
  mikaTablet: string | null;
  soraA: string | null;
  soraB: string | null;
  /** 'auto' (look for disc-bdj-store in the library), a library path, or null (no store check). */
  /** 'place' (copy disc-bdj-store into a folder of its own under --place-root, removed at the end), 'auto', a library path, or null. */
  storeDisc: string | null;
  /** The library root (LIBRARY_ROOTS name) the test disc is placed under. */
  placeRoot: string;
  rehearseStore: string | null;
  library: boolean;
  /** Resume, Continue watching and a stored subtitle on Mika's phone, with a disc of its own (--places). */
  places: boolean;
  discs: string[];
  libraryDir: string;
  wdPorts: [number, number];
  headless: boolean;
  callTimeoutMs: number;
}

const USAGE =
  'usage: live-check.ts --origin <preview origin> --out <dir> --nas <api base> (or $LIVE_CHECK_NAS) [--mika-phone <target>] [--mika-tablet <target>] [--sora-a chrome-profile] [--sora-b chrome] ' +
  '[--store-disc place|auto|<library path>|none] --place-root <root> [--rehearse-store <library path>|<id>] [--library] [--places] [--disc <id>]… [--library-dir dir] [--wd-ports 4211,4212] [--headless] [--call-timeout ms]';

export function parseLiveArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Options {
  const o: Options = {
    origin: '', nas: env.LIVE_CHECK_NAS ?? '', out: '', mikaPhone: null, mikaTablet: null, soraA: 'chrome-profile', soraB: 'chrome', storeDisc: 'place', placeRoot: '', rehearseStore: null,
    library: false, places: false, discs: [], libraryDir: env.BDJ_LIBRARY_DIR ?? join(homedir(), '.cache/bluray-web/bdj-library'), wdPorts: [4211, 4212], headless: false, callTimeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--library') { o.library = true; continue; }
    if (flag === '--places') { o.places = true; continue; }
    if (flag === '--headless') { o.headless = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
    switch (flag) {
      case '--origin': o.origin = v; break;
      case '--nas': o.nas = v; break;
      case '--out': o.out = v; break;
      case '--mika-phone': o.mikaPhone = v; break;
      case '--mika-tablet': o.mikaTablet = v; break;
      case '--sora-a': o.soraA = v === 'none' ? null : v; break;
      case '--sora-b': o.soraB = v === 'none' ? null : v; break;
      case '--store-disc': o.storeDisc = v === 'none' ? null : v; break;
      case '--place-root': o.placeRoot = v; break;
      case '--rehearse-store': o.rehearseStore = v; break;
      case '--disc': o.discs.push(v); break;
      case '--library-dir': o.libraryDir = v; break;
      case '--wd-ports': {
        const ports = v.split(',').map(Number);
        if (ports.length !== 2 || ports.some((p) => !Number.isInteger(p) || p <= 4200 || p > 65535 || p === 4191 || p === 4192)) throw new Error('--wd-ports: two ports above 4200 (never 4191/4192)');
        o.wdPorts = [ports[0]!, ports[1]!];
        break;
      }
      case '--call-timeout': o.callTimeoutMs = Number(v); break;
      default: throw new Error(`unknown option ${flag}\n${USAGE}`);
    }
  }
  if (!o.origin || !o.out) throw new Error(USAGE);
  // no default: the NAS is the caller's to name
  if (!o.nas) throw new Error(`no NAS given: pass --nas <api base> or set LIVE_CHECK_NAS (for example https://<nas host>/bluray/api/)\n${USAGE}`);
  if (o.storeDisc === 'place' && !o.placeRoot) throw new Error(`no root to place the test disc under: pass --place-root <library root name> (or --store-disc none)\n${USAGE}`);
  if (!o.nas.endsWith('/')) o.nas = `${o.nas}/`;
  o.origin = checkOrigin(o.origin);
  const out = resolve(o.out);
  const rel = relative(REPO, out);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) throw new Error('--out must lie outside the repository (screenshots show real discs)');
  o.out = out;
  if (o.discs.length === 0) o.discs = [...UNCONFIRMED];
  for (const t of [o.mikaPhone, o.mikaTablet, o.soraA, o.soraB]) {
    if (t !== null && !/^(ios:[0-9A-Fa-f-]{20,}|sim:.+|chrome-profile|chrome)$/.test(t)) throw new Error(`unknown target ${t}\n${USAGE}`);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------------
// The NAS: a headless controller device per test person (pairing as scripts/verify-level.ts does)

class HttpError extends Error {
  constructor(readonly status: number, body: string, what: string) {
    super(`${what}: HTTP ${status} ${body.slice(0, 200)}`);
  }
}

const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

class Controller {
  private session: { token: string; expiresAt: number } | null = null;
  private constructor(readonly base: string, readonly deviceId: string, readonly personId: string, private readonly key: webcrypto.CryptoKeyPair) {}

  static async pair(base: string, code: string): Promise<Controller> {
    const key = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', key.publicKey);
    const res = await fetch(`${base}pair/redeem`, jsonPost({ code: code.trim().toUpperCase(), deviceName: CONTROLLER_NAME, publicKeyJwk: { kty, crv, x, y } }));
    if (!res.ok) throw new HttpError(res.status, await res.text(), 'pairing the controller');
    const { deviceId, personId, owner } = (await res.json()) as { deviceId: string; personId: string; owner: boolean };
    if (!owner) throw new Error('the controller is not an owner device');
    return new Controller(base, deviceId, personId, key);
  }

  private async token(fresh: boolean): Promise<string> {
    if (!fresh && this.session && this.session.expiresAt - Date.now() > 5 * 60_000) return this.session.token;
    const c = await fetch(`${this.base}session/challenge`, jsonPost({ deviceId: this.deviceId }));
    if (!c.ok) throw new HttpError(c.status, await c.text(), 'session challenge');
    const { challenge } = (await c.json()) as { challenge: string };
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key.privateKey, new TextEncoder().encode(challenge));
    const res = await fetch(`${this.base}session`, jsonPost({ deviceId: this.deviceId, challenge, signature: Buffer.from(sig).toString('base64url') }));
    if (!res.ok) throw new HttpError(res.status, await res.text(), 'session');
    this.session = (await res.json()) as { token: string; expiresAt: number };
    return this.session.token;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await this.token(attempt > 0)}`);
      const res = await fetch(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
      if (res.status !== 401 || attempt > 0) return res;
      await res.body?.cancel();
    }
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) throw new HttpError(res.status, await res.text(), path.split('?')[0]!);
    return (await res.json()) as T;
  }

  /** disc-bdj-store's count in this person's NAS store, or null when there is none. */
  async storeCount(): Promise<string | null> {
    const res = await this.fetch(`bdj-store/persistent/${STORE_ORG}`);
    if (!res.ok) throw new HttpError(res.status, await res.text(), 'reading the NAS store');
    const f = readTar(new Uint8Array(await res.arrayBuffer())).find((e) => e.path === STORE_COUNT);
    return f ? new TextDecoder().decode(f.bytes) : null;
  }
}

interface PersonRow {
  id: string;
  name: string;
  owner: boolean;
}

/** One owner code from the NAS's owner tooling over ssh (deploy.sh --owner-code --person <name>). */
function sshOwnerCode(person: string): Promise<{ code: string; person: string | null; rendezvous: boolean }> {
  return new Promise((res, rej) =>
    execFile('bash', [join(REPO, 'server/deploy/deploy.sh'), '--owner-code', '--person', person], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) rej(new Error(`deploy.sh --owner-code: ${err.message} ${String(stderr).slice(0, 300)}`));
      else {
        try {
          res(parseOwnerCode(String(stdout)));
        } catch (e) {
          rej(e as Error);
        }
      }
    }),
  );
}

/** The ssh host of the NAS, from $BLURAY_NAS_HOST: there is no default. */
function nasHost(): string {
  const host = process.env.BLURAY_NAS_HOST;
  if (!host) throw new Error('no NAS ssh host given: set BLURAY_NAS_HOST (for example your-nas)');
  return host;
}

/** Runs a read-only command on the NAS host. */
function sshRead(script: string): Promise<string> {
  const host = nasHost();
  return new Promise((res, rej) =>
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host, script], { timeout: 60_000 }, (err, stdout, stderr) => (err ? rej(new Error(`ssh: ${err.message} ${String(stderr).slice(0, 200)}`)) : res(String(stdout)))),
  );
}

let rootsCache: LibraryRoot[] | null = null;

/** The library roots, read once from the NAS: only the LIBRARY_ROOTS line of its .env (the file holds secrets) and its compose.override.yaml. */
async function nasRoots(): Promise<LibraryRoot[]> {
  if (rootsCache) return rootsCache;
  const SEP = '---override---';
  const out = await sshRead(`grep '^LIBRARY_ROOTS=' ~/bluray-server/.env; echo '${SEP}'; cat ~/bluray-server/compose.override.yaml`);
  const [env, override] = out.split(SEP);
  rootsCache = parseRoots(env ?? '', override ?? '');
  return rootsCache;
}

class People {
  mika: Controller | null = null;
  sora: Controller | null = null;
  mikaId: string | null = null;
  soraId: string | null = null;
  /** People that were not test people when the run started: never touched; checked unchanged at the end. */
  others: PersonRow[] = [];
  deleted: string[] = [];
  private cleaned = false;

  constructor(private readonly base: string, private readonly log: (m: string) => void) {}

  async setUp(): Promise<void> {
    const first = await sshOwnerCode(MIKA);
    if (first.person !== MIKA) throw new Error(`the owner tooling paired "${first.person}", not ${MIKA}`);
    this.mika = await Controller.pair(this.base, first.code);
    this.mikaId = this.mika.personId;
    const people = await this.people();
    const mikaRow = people.find((p) => p.id === this.mikaId);
    if (mikaRow?.name !== MIKA) throw new Error(`the controller's person is "${mikaRow?.name}", not ${MIKA}`);
    this.others = people.filter((p) => !TEST_NAMES.includes(p.name));
    this.log(`${MIKA}: person ${this.mikaId}; ${this.others.length} other people on the NAS (left alone)`);
    const leftover = people.find((p) => p.name === SORA);
    const made = await this.mika.json<{ code: string; personId: string; personName: string }>(
      'admin/codes',
      jsonPost(leftover ? { personId: leftover.id } : { newPerson: { name: SORA, owner: true } }),
    );
    if (made.personName !== SORA) throw new Error(`the code is for "${made.personName}", not ${SORA}`);
    this.soraId = made.personId;
    this.sora = await Controller.pair(this.base, made.code);
    this.log(`${SORA}: person ${this.soraId}${leftover ? ' (left over from an earlier run)' : ''}`);
    // a test person left over from an earlier run may hold saved data: start both from nothing
    for (const id of [this.mikaId, this.soraId]) {
      const r = await this.mika.fetch(`admin/people/${encodeURIComponent(id)}/saved-data`, { method: 'DELETE' });
      if (r.status !== 204) throw new HttpError(r.status, await r.text(), 'clearing a test person\'s saved data');
    }
  }

  async people(): Promise<PersonRow[]> {
    return (await this.mika!.json<{ people: PersonRow[] }>('admin/people')).people;
  }

  /** A fresh single-use code for a browser device of `personId` (registered with the rendezvous, so the app can pair). */
  async code(personId: string): Promise<string> {
    const r = await this.mika!.json<{ code: string; rendezvous: boolean; personId: string; personName: string }>('admin/codes', jsonPost({ personId }));
    if (r.personId !== personId || !TEST_NAMES.includes(r.personName)) throw new Error('the code is not for a test person');
    if (!r.rendezvous) throw new Error('the NAS could not register the code with the rendezvous: the app cannot pair with it');
    return r.code;
  }

  /** Deletes Sora, then Mika (each only when its name is still a test name), then confirms over ssh. */
  async cleanUp(): Promise<{ confirmed: boolean; detail: string }> {
    if (this.cleaned) return { confirmed: true, detail: 'already cleaned' };
    this.cleaned = true;
    const problems: string[] = [];
    // Mika's controller may be missing (the run failed while pairing it): a fresh owner code gives another
    if (!this.mika && this.mikaId === null) {
      const people = await this.peopleOverSsh().catch(() => null);
      if (people?.some((p) => p.name === MIKA)) {
        const c = await sshOwnerCode(MIKA);
        this.mika = await Controller.pair(this.base, c.code);
        this.mikaId = this.mika.personId;
      }
    }
    if (this.mika) {
      const before = await this.people().catch(() => [] as PersonRow[]);
      if (!this.soraId) this.soraId = before.find((p) => p.name === SORA)?.id ?? null;
      for (const id of [this.soraId, this.mikaId]) {
        if (!id) continue;
        const row = before.find((p) => p.id === id);
        if (row && !TEST_NAMES.includes(row.name)) {
          problems.push(`person ${id} is "${row.name}", not a test person: left alone`);
          continue;
        }
        if (!row) continue;
        const r = await this.mika.fetch(`admin/people/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((e: unknown) => e as Error);
        if (r instanceof Error) problems.push(`deleting ${row.name}: ${r.message}`);
        else if (r.status !== 204) problems.push(`deleting ${row.name}: HTTP ${r.status} ${await r.text()}`);
        else {
          this.deleted.push(row.name);
          this.log(`deleted ${row.name} (${id}) and its devices and saved data`);
        }
        if (id === this.soraId && !(r instanceof Error) && r.status === 204) {
          const after = await this.people();
          if (after.some((p) => p.id === id || p.name === SORA)) problems.push(`${SORA} is still in the admin listing`);
          else this.log(`admin listing: ${SORA} gone; ${after.filter((p) => !TEST_NAMES.includes(p.name)).length} other people`);
        }
      }
    }
    // the controller of a deleted person can no longer list: the NAS's own people file, read over ssh, confirms it
    const left = await this.peopleOverSsh().catch((e: unknown) => {
      problems.push(`reading the NAS's people over ssh: ${(e as Error).message}`);
      return null;
    });
    if (left) {
      const test = left.filter((p) => TEST_NAMES.includes(p.name) || p.id === this.mikaId || p.id === this.soraId);
      if (test.length > 0) problems.push(`still on the NAS: ${test.map((p) => p.name).join(', ')}`);
      const devices = await sshRead(`docker exec bluray-server node -e 'const a=require("/data/auth.json");const ids=${JSON.stringify([this.mikaId, this.soraId].filter(Boolean))};console.log(a.devices.filter(d=>ids.includes(d.personId)).length)'`).catch(() => '?');
      if (devices.trim() !== '0') problems.push(`test devices left: ${devices.trim()}`);
      const ids = [this.mikaId, this.soraId].filter((x): x is string => x !== null);
      if (ids.length > 0) {
        const data = await sshRead(`docker exec bluray-server sh -c '${ids.map((id) => `test -e /data/users/${id} && echo ${id}`).join('; ')}; true'`).catch(() => '?');
        if (data.trim() !== '') problems.push(`saved data left: ${data.trim()}`);
      }
      const othersNow = left.filter((p) => !TEST_NAMES.includes(p.name));
      if (this.others.length > 0 && (othersNow.length !== this.others.length || this.others.some((o) => !othersNow.some((p) => p.id === o.id && p.name === o.name)))) {
        problems.push('the other people changed during the run (not by this check: it never writes to them)');
      }
      if (problems.length === 0) this.log(`NAS people file: no test person, device or saved data left; ${othersNow.length} other people as before`);
    }
    return { confirmed: problems.length === 0, detail: problems.join('; ') || 'no test person, device or saved data left' };
  }

  /** The NAS's people (id, name, owner), read from its auth file over ssh. */
  private async peopleOverSsh(): Promise<PersonRow[]> {
    const out = await sshRead(`docker exec bluray-server node -e 'const a=require("/data/auth.json");console.log(JSON.stringify(a.people.map(p=>({id:p.id,name:p.name,owner:p.owner}))))'`);
    return JSON.parse(out) as PersonRow[];
  }
}

interface MetadataStatus {
  running: boolean;
  filed: number;
  unsorted: number;
  music: number;
  lastRunAt: number | null;
}

/** A disc folder a run places on the NAS: `<parent>/<name>` on this machine. */
export interface PlacedDisc {
  readonly name: string;
  readonly parent: string;
}

/** Pipes a local tar of `disc` (its folder, by name) into `script` run over ssh on the NAS host. */
function sshUntar(disc: PlacedDisc, script: string): Promise<void> {
  const host = nasHost();
  return new Promise((res, rej) => {
    // no AppleDouble files or macOS extended attributes: the NAS gets the fixture's files and nothing else
    const tar = spawn('tar', ['--no-mac-metadata', '--no-xattrs', '-C', disc.parent, '-cf', '-', disc.name], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host, script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d: Buffer) => (err += d.toString()));
    ssh.stderr.on('data', (d: Buffer) => (err += d.toString()));
    tar.stdout.pipe(ssh.stdin);
    const timer = setTimeout(() => ssh.kill('SIGKILL'), 120_000);
    ssh.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) res();
      else rej(new Error(`copying the test disc: ssh exit ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/**
 * The test discs (disc-bdj-store, and the places disc for --places) placed on the NAS for one run, in a folder of its
 * own (`<root>/zz-live-check-<run id>/`), and removed at the end; the library is rescanned both times through the owner
 * route (POST admin/rescan).
 */
class TestDisc {
  readonly runId = randomBytes(4).toString('hex');
  readonly hostDir: string;
  readonly libraryPath: string;
  private readonly roots: LibraryRoot[];
  /** Set once the folder exists on the NAS (made by this run): only then may the clean-up remove it. */
  created = false;
  removed = false;
  /** The title matcher's counts before the disc was placed. */
  statusBefore: MetadataStatus | null = null;
  readonly report: { placed?: boolean; listedAfterMs?: number; removed?: boolean; gone?: boolean; unlisted?: boolean; countsRestored?: boolean; detail: string[] } = { detail: [] };

  constructor(rootName: string, roots: LibraryRoot[], private readonly log: (m: string) => void, private readonly discs: readonly PlacedDisc[]) {
    this.roots = roots;
    const root = this.roots.find((r) => r.name === rootName);
    if (!root) throw new Error(`--place-root ${rootName}: not a library root (${this.roots.map((r) => r.name).join(', ')})`);
    ({ hostDir: this.hostDir, libraryPath: this.libraryPath } = testDiscFolder(root, this.runId));
  }

  /** A placed disc's path in the NAS library. */
  pathOf(name: string): string {
    return `${parentOf(this.libraryPath)}/${name}`;
  }

  /** Whether the library lists every placed disc ('all') or any of them ('any'). */
  private async listed(c: Controller, how: 'all' | 'any'): Promise<boolean> {
    const l = await c.json<LibraryListing>(`library?path=${encodeURIComponent(parentOf(this.libraryPath))}`).catch(() => null);
    const has = (d: PlacedDisc): boolean => !!l?.discs.some((x) => x.path === this.pathOf(d.name));
    return how === 'all' ? this.discs.every(has) : this.discs.some(has);
  }

  private async rescan(c: Controller): Promise<number> {
    const at = Date.now();
    const r = await c.fetch('admin/rescan', { method: 'POST' });
    if (r.status !== 202) throw new HttpError(r.status, await r.text(), 'admin/rescan');
    return at;
  }

  private status(c: Controller): Promise<MetadataStatus> {
    return c.json<MetadataStatus>('admin/metadata/status');
  }

  /** Whether this run places the disc named `name`. */
  places(name: string): boolean {
    return this.discs.some((d) => d.name === name);
  }

  /** Copies the discs into a new folder (mkdir fails if it exists), rescans, and waits until the library lists them. */
  async place(c: Controller): Promise<void> {
    if (!ownTestFolder(this.hostDir, this.runId, this.roots)) throw new Error('refusing a test folder path this run did not make');
    this.statusBefore = await this.status(c);
    // mkdir without -p: the folder must be new, so the clean-up only ever removes what this run made
    await sshRead(`mkdir -- '${this.hostDir}'`);
    this.created = true; // from here on the clean-up removes it, even when the copy below fails
    for (const disc of this.discs) {
      await sshUntar(disc, `tar -C '${this.hostDir}' -xf -`);
      const files = Number((await sshRead(`find '${this.hostDir}/${disc.name}' -type f | wc -l`)).trim());
      const listing = await new Promise<string>((res, rej) => execFile('find', [join(disc.parent, disc.name), '-type', 'f'], (e, out) => (e ? rej(e) : res(String(out)))));
      const want = listing.trim().split('\n').length;
      if (files !== want) throw new Error(`the NAS copy of ${disc.name} has ${files} files, the source ${want}`);
      this.log(`test disc placed at ${this.pathOf(disc.name)}`);
    }
    this.report.placed = true;
    const at = await this.rescan(c);
    const deadline = at + 20 * 60_000;
    while (!(await this.listed(c, 'all'))) {
      if (Date.now() > deadline) throw new Error('the rescan did not list the test discs in 20 minutes');
      await sleep(3000);
    }
    this.report.listedAfterMs = Date.now() - at;
    this.log(`test discs listed ${Math.round(this.report.listedAfterMs / 1000)} s after the rescan`);
  }

  /**
   * Removes exactly this run's folder (checked against the run id and the roots, and that it holds only the test disc),
   * checks it is gone, rescans, and waits until the disc is unlisted and the matcher's counts are back.
   */
  async remove(c: Controller | null): Promise<void> {
    if (!this.created || this.removed) return;
    const d = this.hostDir;
    if (!ownTestFolder(d, this.runId, this.roots)) {
      this.report.detail.push(`refused to delete ${d}: not this run's folder`);
      return;
    }
    const contents = (await sshRead(`find '${d}' -mindepth 1 -maxdepth 1 -printf '%f\\n'`).catch((e: unknown) => `ERROR ${(e as Error).message}`)).trim();
    // what this run put there: the discs' folders, or fewer when a copy failed
    const names = this.discs.map((x) => x.name);
    if (contents !== '' && contents.split('\n').some((n) => !names.includes(n))) {
      this.report.detail.push(`left ${d} in place: it holds "${contents.replaceAll('\n', ', ')}", not only ${names.join(', ')}`);
      return;
    }
    await sshRead(`rm -r -- '${d}'`);
    this.removed = true;
    this.report.removed = true;
    const left = (await sshRead(`test -e '${d}' && echo present || echo gone`)).trim();
    this.report.gone = left === 'gone';
    if (!this.report.gone) this.report.detail.push(`${d} is still there after rm`);
    this.log(`test folder removed (${left})`);
    if (!c) {
      this.report.detail.push('no owner session for the rescan: the nightly scan will drop the disc');
      return;
    }
    const at = await this.rescan(c);
    const deadline = at + 20 * 60_000;
    while (await this.listed(c, 'any')) {
      if (Date.now() > deadline) {
        this.report.detail.push('the rescan still lists the test disc after 20 minutes');
        return;
      }
      await sleep(3000);
    }
    this.report.unlisted = true;
    // the title run that follows the scan: filed/unsorted/music back to where they were before the disc came
    const before = this.statusBefore;
    while (Date.now() < deadline) {
      const s = await this.status(c);
      if (!s.running && (s.lastRunAt ?? 0) >= at) {
        this.report.countsRestored = !before || (s.filed === before.filed && s.unsorted === before.unsorted && s.music === before.music);
        if (!this.report.countsRestored) this.report.detail.push(`matcher counts now filed ${s.filed} / unsorted ${s.unsorted} / music ${s.music}, before ${before!.filed} / ${before!.unsorted} / ${before!.music}`);
        break;
      }
      await sleep(3000);
    }
    if (this.report.countsRestored === undefined) this.report.detail.push('no title run after the rescan within 20 minutes');
    this.log(`library rescanned: test disc unlisted; matcher counts ${this.report.countsRestored ? 'as before' : 'NOT as before'}`);
  }

  get clean(): boolean {
    return !this.created || (!!this.report.gone && !!this.report.unlisted && this.report.countsRestored !== false);
  }
}

/** The places check's disc (--places): generated for the run, not a fixture. */
export const PLACES_DISC_NAME = 'disc-places';

/**
 * Generates the places disc (playlist 00000 of two 30 s clips, LPCM audio) in a folder of its own under the gitignored
 * fixtures/local (the fixture writer writes only under fixtures/), its files dated two hours back so the NAS's scan
 * counts it as settled (SETTLE_MS) at once. Returns it with a remover.
 */
export async function makePlacesDisc(): Promise<PlacedDisc & { remove(): void }> {
  mkdirSync(join(REPO, 'fixtures/local'), { recursive: true });
  const parent = mkdtempSync(join(REPO, 'fixtures/local/live-check-places-'));
  const dir = join(parent, PLACES_DISC_NAME);
  await new Promise<void>((res, rej) =>
    execFile('npx', ['tsx', join(REPO, 'scripts/make-fixture-disc.ts'), dir, '--seconds-per-clip', '30'], { cwd: REPO, timeout: 300_000 }, (err, _out, stderr) =>
      err ? rej(new Error(`making the places disc: ${err.message} ${String(stderr).slice(0, 300)}`)) : res(),
    ),
  );
  const past = new Date(Date.now() - 2 * 3_600_000);
  const date = (path: string): void => {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.isDirectory()) date(join(path, e.name));
      utimesSync(join(path, e.name), past, past);
    }
  };
  date(dir);
  utimesSync(dir, past, past);
  return { name: PLACES_DISC_NAME, parent, remove: () => rmSync(parent, { recursive: true, force: true }) };
}

/** A subtitle file for the places check: one cue across the whole disc. */
const PLACES_SRT = '1\n00:00:00,000 --> 00:01:00,000\nPlaces check (test)\n';
const PLACES_SRT_NAME = 'places-check.srt';

/** m:ss, as the resume prompt shows a place's time. */
export function clockLabel(timeUs: number): string {
  const s = Math.floor(timeUs / 1_000_000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Browsers

/** Chrome through Playwright with a profile of its own: a fresh temporary profile, or a fresh context. */
class ChromeDriver implements GateDriver {
  readonly touch = false;
  private readonly log: string[] = [];
  private constructor(
    private readonly closeAll: () => Promise<void>,
    private readonly page: import('@playwright/test').Page,
    readonly via: string,
  ) {
    page.on('console', (m) => this.log.push(`${new Date().toISOString()} ${m.type()} ${m.text()}`));
  }

  static async start(kind: 'chrome-profile' | 'chrome', headless: boolean, origin: string, nasBase: string): Promise<ChromeDriver> {
    const pw = await import('@playwright/test');
    const grant = async (ctx: import('@playwright/test').BrowserContext): Promise<void> => {
      for (const o of [origin, new URL(nasBase).origin]) await ctx.grantPermissions(['local-network-access'], { origin: o }).catch(() => undefined);
    };
    if (kind === 'chrome-profile') {
      const dir = mkdtempSync(join(tmpdir(), 'live-check-profile-'));
      const ctx = await pw.chromium.launchPersistentContext(dir, { channel: 'chrome', headless, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
      await grant(ctx);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      return new ChromeDriver(async () => {
        await ctx.close();
        rmSync(dir, { recursive: true, force: true });
      }, page, `Playwright, Google Chrome with a fresh temporary profile${headless ? ' (headless)' : ''}`);
    }
    const browser = await pw.chromium.launch({ channel: 'chrome', headless });
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    await grant(ctx);
    const page = await ctx.newPage();
    return new ChromeDriver(() => browser.close(), page, `Playwright, Google Chrome ${browser.version()}, a fresh context${headless ? ' (headless)' : ''}`);
  }

  async open(url: string): Promise<void> { await this.page.goto(url); }
  evaluate<T>(e: string): Promise<T> { return this.page.evaluate(`(${e})`) as Promise<T>; }
  evaluateAsync<T>(e: string): Promise<T> { return this.page.evaluate(`Promise.resolve(${e})`) as Promise<T>; }
  async tap(x: number, y: number): Promise<void> { await this.page.mouse.click(x, y); }
  async press(key: MenuKey): Promise<void> {
    const k = ({ up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter' } as Partial<Record<MenuKey, string>>)[key];
    if (!k) throw new Error(`no keyboard key for ${key}`);
    await this.page.keyboard.press(k);
  }
  async screenshot(out: string): Promise<void> { write(out, await this.page.screenshot()); }
  async consoleLog(): Promise<string[]> { return [...this.log]; }
  close(): Promise<void> { return this.closeAll(); }
}

interface Browser {
  readonly role: string;
  readonly target: string;
  readonly person: string;
  driver: GateDriver | null;
  page: Page | null;
}

/** The pairing record in the page's IndexedDB (src/ui/nas/nas-store.ts), without creating the database. */
const READ_PAIRING = `new Promise((resolve) => { const r = indexedDB.open('bluray-web'); r.onupgradeneeded = () => r.transaction.abort();
  r.onerror = (e) => { e.preventDefault(); resolve(null); };
  r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('nas')) { db.close(); resolve(null); return; }
    const g = db.transaction('nas', 'readonly').objectStore('nas').get('pairing');
    g.onsuccess = () => { db.close(); const p = g.result; resolve(p ? { personName: p.personName ?? null, deviceName: p.deviceName, base: p.base } : null); };
    g.onerror = () => { db.close(); resolve(null); }; }; })`;

/** Forgets the pairing (only a test person's) and the test people's BD-J write-ahead records (bdj-store, `nas-person:<id>|…`). */
const forgetTest = (names: readonly string[], personIds: readonly string[]): string => `new Promise((resolve) => {
  const names = ${JSON.stringify(names)}; const ids = ${JSON.stringify(personIds)}; const done = { pairing: false, records: 0 };
  const step2 = () => { const r = indexedDB.open('bdj-store'); r.onupgradeneeded = () => r.transaction.abort(); r.onerror = (e) => { e.preventDefault(); resolve(done); };
    r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('scopes')) { db.close(); resolve(done); return; }
      const tx = db.transaction('scopes', 'readwrite'); const s = tx.objectStore('scopes'); const c = s.openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) return; const k = String(cur.key); if (ids.some((id) => k.startsWith('nas-person:' + id + '|'))) { cur.delete(); done.records++; } cur.continue(); };
      tx.oncomplete = () => { db.close(); resolve(done); }; tx.onerror = () => { db.close(); resolve(done); }; }; };
  const r = indexedDB.open('bluray-web'); r.onupgradeneeded = () => r.transaction.abort(); r.onerror = (e) => { e.preventDefault(); step2(); };
  r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('nas')) { db.close(); step2(); return; }
    const tx = db.transaction('nas', 'readwrite'); const s = tx.objectStore('nas'); const g = s.get('pairing');
    g.onsuccess = () => { const p = g.result; if (p && names.includes(p.personName)) { s.delete('pairing'); done.pairing = true; } };
    tx.oncomplete = () => { db.close(); try { localStorage.removeItem(${JSON.stringify(FOLDER_KEY)}); } catch {} step2(); }; tx.onerror = () => { db.close(); step2(); }; }; })`;

const visible = (sel: string): string => `[...document.querySelectorAll(${JSON.stringify(sel)})].some((e) => e.getClientRects().length > 0)`;
const cssString = (s: string): string => JSON.stringify(s);

/**
 * Scrolls the first visible match to the middle of the viewport, then taps it once the page has stopped moving (a tap
 * off screen reaches nothing; one sent while Safari still scrolls lands beside it). Says whether the touch reached it.
 */
async function tapInView(page: Page, selector: string, during: string): Promise<boolean> {
  await page.until<boolean>(
    // the page's end can lie under Safari's floating toolbar: room below it (test only) lets the element reach the middle
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getClientRects().length > 0); if (!e) return false;` +
      ` document.body.style.paddingBottom = '60vh'; e.scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`,
    during,
    30_000,
  );
  try {
    // tapOn waits for the scroll (and the toolbar it moves) to settle and reads the element's box after it
    return (await page.tapOn(selector, during)).landed;
  } finally {
    // undo the room and the scroll: left in place, they push the player off the screen and later touches out of bounds;
    // then let the page settle, so the next screen's first touch is not aimed while it still moves
    await page.until<boolean>(`(() => { document.body.style.paddingBottom = ''; window.scrollTo(0, 0); return true; })()`, during, 10_000).catch(() => undefined);
    await page.settle(null, during).catch(() => undefined);
  }
}

/**
 * A DOM click on the first visible match: for navigation that needs no user gesture (the screens move as posters
 * load, so a touch at coordinates taken a moment earlier can miss). Play stays a real touch: it starts audio.
 */
async function clickEl(page: Page, selector: string, during: string): Promise<void> {
  await page.until<boolean>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getClientRects().length > 0); if (!e) return false; e.click(); return true; })()`,
    during,
    30_000,
  );
}

interface TelemetrySnap {
  t: { bdj?: { firstFrameMs?: number | null } | null; bdjPlane?: { flushes: number; hash?: string | null } | null; framesPresented?: number } | null;
  playlist: string | null;
  bdjMenu: string | null;
  state: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

interface StoreStep {
  role: string;
  person: string;
  expected: number | null;
  shown: number | null;
  hash: string | null;
  seen: string[];
  nasMika: string | null;
  nasSora: string | null;
  ok: boolean;
  note?: string;
}

interface LibraryStep {
  n: number;
  step: string;
  held: boolean;
  ms: number;
  hash: string | null;
  playlist: string | null;
  menu: string | null;
  shot: string;
}

interface LibraryDisc {
  id: string;
  nasDiscId?: string;
  opened: boolean;
  firstFrameMs?: number | null;
  steps: LibraryStep[];
  error?: string;
  reloaded?: boolean;
}

interface PlacesStep {
  step: string;
  ok: boolean;
  detail: string;
  shot?: string;
}

interface Result {
  startedAt: string;
  finishedAt?: string;
  origin: string;
  devices: Record<string, string>;
  people: { created: boolean; deleted: string[]; cleanupConfirmed?: boolean; cleanupDetail?: string };
  pairings: Array<{ role: string; person: string; ok: boolean; error?: string }>;
  store: { ran: boolean; mode: 'check' | 'rehearsal' | null; skipped?: string; disc?: string; steps: StoreStep[]; pass?: boolean };
  library: { ran: boolean; skipped?: string; discs: LibraryDisc[] };
  places: { ran: boolean; skipped?: string; steps: PlacesStep[]; pass?: boolean };
  testDisc?: { libraryPath: string; clean: boolean; placed?: boolean; listedAfterMs?: number; removed?: boolean; gone?: boolean; unlisted?: boolean; countsRestored?: boolean; detail: string[] };
  environment: Record<string, unknown>;
  errors: string[];
}

class LiveCheck {
  private readonly t0 = Date.now();
  readonly r: Result;
  readonly people: People;
  private readonly browsers: Browser[] = [];
  private readonly hashes = storeHashes();
  /** Set on Ctrl-C: no further device step starts while the clean-up runs. */
  aborted = false;
  /** disc-bdj-store placed on the NAS for this run (--store-disc place). */
  testDisc: TestDisc | null = null;

  constructor(private readonly o: Options) {
    this.people = new People(o.nas, (m) => this.log(m));
    this.r = {
      startedAt: new Date().toISOString(), origin: o.origin, devices: {}, people: { created: false, deleted: [] }, pairings: [],
      store: { ran: false, mode: null, steps: [] }, library: { ran: false, discs: [] }, places: { ran: false, steps: [] }, environment: {}, errors: [],
    };
    const add = (role: string, target: string | null, person: string): void => {
      if (!target) return;
      this.browsers.push({ role, target, person, driver: null, page: null });
      this.r.devices[role] = target.startsWith('ios:') ? 'real device (safaridriver)' : target.startsWith('sim:') ? `Simulator ${target.slice(4)} (Appium)` : target;
    };
    add('mika-phone', o.mikaPhone, MIKA);
    add('mika-tablet', o.mikaTablet, MIKA);
    add('sora-a', o.soraA, SORA);
    add('sora-b', o.soraB, SORA);
  }

  log(msg: string): void { console.error(`[${((Date.now() - this.t0) / 1000).toFixed(1)} s] ${msg}`); }

  private browser(role: string): Browser | null { return this.browsers.find((b) => b.role === role) ?? null; }

  private async start(b: Browser): Promise<Page> {
    if (b.page) return b.page;
    const iosIndex = this.browsers.filter((x) => x.target.startsWith('ios:')).indexOf(b);
    b.driver = b.target === 'chrome-profile' || b.target === 'chrome'
      ? await ChromeDriver.start(b.target, this.o.headless, this.o.origin, this.o.nas)
      : await startTargetDriver(b.target, { driverPort: this.o.wdPorts[Math.max(0, iosIndex) % 2]!, headless: this.o.headless, touch: true, callTimeoutMs: this.o.callTimeoutMs });
    b.page = new Page(b.driver, (line) => this.log(`${b.role}: ${line}`));
    this.log(`${b.role}: ${b.driver.via}`);
    return b.page;
  }

  /** Forgets the test pairing and saved data in the browser, then closes it. */
  private async stop(b: Browser): Promise<void> {
    if (!b.driver || !b.page) return;
    try {
      const ids = [this.people.mikaId, this.people.soraId].filter((x): x is string => x !== null);
      await b.page.open(`${this.o.origin}/?telemetry=1`);
      const done = await b.driver.evaluateAsync<{ pairing: boolean; records: number }>(forgetTest(TEST_NAMES, ids));
      this.log(`${b.role}: forgot the test pairing (${done.pairing ? 'removed' : 'none'}) and ${done.records} test saved-data records`);
    } catch (err) {
      this.r.errors.push(`${b.role}: forgetting the test pairing: ${(err as Error).message}`);
    }
    await b.driver.close().catch(() => undefined);
    b.driver = null;
    b.page = null;
  }

  /** Pairs the browser as `b.person` through the app's pairing screen, unless it already is. */
  private async pair(b: Browser, personId: string): Promise<void> {
    const page = await this.start(b);
    await page.open(`${this.o.origin}/?telemetry=1`);
    if (!this.r.environment[b.role]) this.r.environment[b.role] = await environment(page).catch((e: unknown) => String(e));
    const existing = await b.driver!.evaluateAsync<{ personName: string | null; deviceName: string } | null>(READ_PAIRING);
    if (existing && existing.personName === b.person) {
      this.log(`${b.role}: already paired as ${b.person}`);
      this.r.pairings.push({ role: b.role, person: b.person, ok: true });
      return;
    }
    if (existing && !TEST_NAMES.includes(existing.personName ?? '')) {
      throw new Error(`${b.role}: this browser is already paired on ${this.o.origin} as someone who is not a test person; not re-pairing it (unpair it by hand, or use another origin)`);
    }
    if (existing) await b.driver!.evaluateAsync(forgetTest(TEST_NAMES, []));
    const code = await this.people.code(personId);
    await page.open(`${this.o.origin}/?pair=${encodeURIComponent(code)}&telemetry=1`);
    await page.until(`(document.querySelector('[data-testid=pair-code]')?.value ?? '') !== ''`, 'the pairing screen', 30_000);
    await page.until(`!document.querySelector('[data-testid=pair-button]')?.disabled`, 'the pair button', 15_000);
    // a DOM click: pairing needs no user gesture, and a touch at coordinates missed the button on a real iPhone
    await clickEl(page, '[data-testid=pair-button]', 'the pair button');
    const text = await page.until<string>(
      `(() => { const e = document.querySelector('[data-testid=pair-error]'); if (e && e.getClientRects().length) return 'ERROR: ' + e.textContent; const p = document.querySelector('[data-testid=nas-paired]'); return p ? p.textContent : null; })()`,
      'the pairing',
      45_000,
    );
    if (text.startsWith('ERROR: ')) throw new Error(`${b.role}: pairing failed: ${text.slice(7)}`);
    if (!text.includes(`Paired as ${b.person}.`)) throw new Error(`${b.role}: paired as "${text}", expected ${b.person}`);
    this.log(`${b.role}: paired as ${b.person}`);
    this.r.pairings.push({ role: b.role, person: b.person, ok: true });
  }

  /** From the landing screen of a paired page: the NAS's folder browser at the disc's folder, its pre-flight, Play. */
  private async openNasDisc(page: Page, disc: DiscEntry, query = ''): Promise<void> {
    await this.openPreflight(page, disc, query);
    await page.until(`(() => { const b = document.querySelector('[data-testid=nas-play]'); return !!b && !b.disabled; })()`, 'the pre-flight', 60_000);
    // Play is a real touch (it starts audio); when a touch misses (seen on the Simulator with the pre-flight's longer
    // "play now with pauses" page), it is tried once more, then clicked in the DOM (the picture still plays; audio may not)
    const left = `!document.querySelector('[data-testid=nas-play]') || ${visible('[data-testid=nas-play-now]')}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt < 2) await tapInView(page, '[data-testid=nas-play]', 'Play');
      else {
        this.log('Play: two touches missed; clicking it in the DOM (audio may stay muted)');
        await clickEl(page, '[data-testid=nas-play]', 'Play');
      }
      const gone = await page.until<boolean>(left, 'Play', 4000).catch((err: unknown) => {
        if (err instanceof PageReloadedError) throw err;
        return false;
      });
      if (gone) break;
    }
    // a slow link gets a buffering offer: play now
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await page.probe<boolean>(visible('[data-testid=nas-play-now]'), 'the buffering offer')) {
        await tapInView(page, '[data-testid=nas-play-now]', 'Play now with pauses');
        break;
      }
      if (await page.probe<boolean>(`!!document.querySelector('[data-testid=player]')`, 'the player')) break;
      await sleep(300);
    }
  }

  /** The landing page (with `query` added), then the NAS's folder browser at the disc's folder, and the disc: its pre-flight. */
  private async openPreflight(page: Page, disc: DiscEntry, query: string): Promise<void> {
    await page.open(`${this.o.origin}/?telemetry=1${query}`);
    await page.until(visible('[data-testid=nas-paired]'), 'the paired landing', 30_000);
    await page.d.evaluate(`(localStorage.setItem(${JSON.stringify(FOLDER_KEY)}, ${JSON.stringify(parentOf(disc.path))}), true)`);
    await clickEl(page, '[data-testid=nas-open]', 'Open from NAS');
    await page.until(visible('[data-testid=title-library]') + ` || ${visible('[data-testid=nas-library]')}`, 'the NAS library', 30_000);
    if (!(await page.probe<boolean>(visible('[data-testid=nas-library]'), 'the folder browser'))) await clickEl(page, '[data-testid=browse-folders]', 'Browse folders');
    const sel = `[data-testid=nas-disc][data-name=${cssString(disc.name)}]`;
    await page.until(visible(sel), 'the disc in its folder', 30_000);
    await clickEl(page, sel, 'the disc');
  }

  private snap(page: Page, during: string): Promise<TelemetrySnap> {
    return page.probe<TelemetrySnap>(
      "(() => { const p = document.querySelector('[data-testid=player]'); return { t: window.__blurayTelemetry ?? null, playlist: p?.getAttribute('data-playlist') ?? null, bdjMenu: p?.getAttribute('data-bdj-menu') ?? null, state: p?.getAttribute('data-state') ?? null }; })()",
      during,
    );
  }

  /** Waits until the plane has been quiet for `quietMs` on `expected` (or on any hash when null); returns the hash. */
  private async settled(page: Page, expected: string | null, quietMs: number, timeoutMs: number, seen: string[]): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let since = Date.now();
    let hash: string | null = null;
    while (Date.now() < deadline) {
      const s = await this.snap(page, 'the plane');
      const f = s.t?.bdjPlane?.flushes ?? 0;
      if (f !== last) { last = f; since = Date.now(); }
      const h = s.t?.bdjPlane?.hash ?? null;
      if (Date.now() - since >= quietMs && h !== null) {
        hash = h;
        if (seen.at(-1) !== h) seen.push(h);
        if (expected === null ? f > 0 : h === expected) return h;
      }
      await sleep(200);
    }
    return hash;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Store

  private async findStoreDisc(): Promise<DiscEntry | null> {
    const c = this.people.mika!;
    const spec = this.o.rehearseStore ?? this.o.storeDisc;
    if (spec === null) return null;
    if (/^[0-9a-f]{10}$/.test(spec)) {
      // a library-check id (map.tsv), so no disc name goes on the command line
      const host = parseMap(readFileSync(join(this.o.libraryDir, 'map.tsv'), 'utf8')).get(spec);
      const path = host ? libraryPath(host, await nasRoots()) : null;
      return path ? this.discAt(path) : null;
    }
    if (spec === 'place') return this.testDisc?.places(STORE_DISC_NAME) ? this.discAt(this.testDisc.pathOf(STORE_DISC_NAME)) : null;
    if (spec !== 'auto') return this.discAt(spec);
    // auto: disc-bdj-store anywhere in the top three levels of the library
    const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
    while (queue.length > 0) {
      const { path, depth } = queue.shift()!;
      const l = await c.json<LibraryListing>(`library?path=${encodeURIComponent(path)}`).catch(() => null);
      if (!l) continue;
      const d = l.discs.find((x) => x.name === STORE_DISC_NAME);
      if (d) return d;
      if (depth < 2) for (const f of l.folders) queue.push({ path: f.path, depth: depth + 1 });
    }
    return null;
  }

  private async discAt(path: string): Promise<DiscEntry | null> {
    const l = await this.people.mika!.json<LibraryListing>(`library?path=${encodeURIComponent(parentOf(path))}`).catch(() => null);
    return l?.discs.find((d) => d.path === path) ?? null;
  }

  private async nasCounts(): Promise<{ mika: string | null; sora: string | null }> {
    return { mika: await this.people.mika!.storeCount(), sora: await this.people.sora!.storeCount() };
  }

  /** Polls until the person's NAS count is `want` (the 2 s NAS put after the write, with margin). */
  private async nasReaches(who: 'mika' | 'sora', want: number, timeoutMs = 30_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let v: string | null = null;
    while (Date.now() < deadline) {
      v = (await this.nasCounts())[who];
      if (v === String(want)) return v;
      await sleep(500);
    }
    return v;
  }

  async store(): Promise<void> {
    const rehearsal = this.o.rehearseStore !== null;
    this.r.store.mode = rehearsal ? 'rehearsal' : 'check';
    const disc = await this.findStoreDisc();
    if (!disc) {
      this.r.store.skipped = this.o.storeDisc === null && !rehearsal ? 'no store disc asked for (--store-disc none)' : `${rehearsal ? 'the rehearsal disc' : STORE_DISC_NAME} is not in the NAS library`;
      this.log(`store: skipped (${this.r.store.skipped})`);
      return;
    }
    this.r.store.ran = true;
    this.r.store.disc = rehearsal ? `rehearsal disc ${disc.id}` : `${STORE_DISC_NAME} (${disc.id})`;
    const start = await this.nasCounts();
    if (start.mika !== null || start.sora !== null) throw new Error(`the test people's NAS stores are not empty at the start (${JSON.stringify(start)})`);
    // [role, person, the count it must show, the NAS count it must leave]
    const plan: Array<[string, 'mika' | 'sora', number, number]> = [['mika-phone', 'mika', 0, 1], ['mika-tablet', 'mika', 1, 2], ['sora-a', 'sora', 0, 1], ['sora-b', 'sora', 1, 2]];
    for (const [role, who, shows, leaves] of plan) {
      if (this.aborted) break;
      const b = this.browser(role);
      if (!b) continue;
      const step: StoreStep = { role, person: b.person, expected: rehearsal ? null : shows, shown: null, hash: null, seen: [], nasMika: null, nasSora: null, ok: false };
      this.r.store.steps.push(step);
      try {
        await this.pair(b, who === 'mika' ? this.people.mikaId! : this.people.soraId!);
        const page = b.page!;
        await this.openNasDisc(page, disc);
        await page.until('window.__blurayTelemetry?.bdj?.firstFrameMs ?? null', "the first frame of Java's first playlist", 90_000);
        step.hash = await this.settled(page, rehearsal ? null : this.hashes[shows]!, 1500, 45_000, step.seen);
        step.shown = countOf(step.hash, this.hashes);
        await page.d.screenshot(join(this.o.out, 'store', `${role}.png`)).catch(() => undefined);
        if (!rehearsal) await this.nasReaches(who, leaves);
        else await sleep(4000); // the NAS put runs 2 s after Java's last write
        const n = await this.nasCounts();
        step.nasMika = n.mika;
        step.nasSora = n.sora;
        if (rehearsal) {
          step.ok = step.hash !== null;
          step.note = 'rehearsal: a settled plane was read; counts are not expected on this disc';
        } else {
          const mikaWant = who === 'mika' ? String(leaves) : '2';
          const soraWant = who === 'mika' ? null : String(leaves);
          step.ok = step.shown === shows && n.mika === mikaWant && n.sora === soraWant;
          if (who === 'sora' && step.shown === 2) step.note = "Sora's browser showed Mika's count";
        }
        this.log(`store ${role}: shows ${step.shown ?? step.hash} (expected ${step.expected ?? 'any'}); NAS Mika ${n.mika}, Sora ${n.sora}: ${step.ok ? 'ok' : 'FAIL'}`);
      } catch (err) {
        step.note = (err as Error).message;
        this.log(`store ${role}: ${step.note}`);
        if (b.driver) await b.driver.screenshot(join(this.o.out, 'store', `${role}-error.png`)).catch(() => undefined);
      } finally {
        await this.stop(b);
      }
    }
    this.r.store.pass = this.r.store.steps.length === 4 && this.r.store.steps.every((s) => s.ok);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Places

  /** The player's state, playlist, clock (telemetry) and the disc key in the address bar (`/nas/play/<key>`). */
  private playing(page: Page, during: string): Promise<{ state: string | null; playlist: string | null; clockUs: number | null; discKey: string | null }> {
    return page.probe(
      "(() => { const p = document.querySelector('[data-testid=player]'); const m = /^\\/nas\\/play\\/([^/?]+)/.exec(location.pathname);" +
        " return { state: p?.getAttribute('data-state') ?? null, playlist: p?.getAttribute('data-playlist') ?? null, clockUs: window.__blurayTelemetry?.clockUs ?? null, discKey: m ? decodeURIComponent(m[1]) : null }; })()",
      during,
    );
  }

  /**
   * Starts playback with a real touch on `selector` (it starts audio), tried twice, then a DOM click, as for Play: a touch
   * can miss on the iPhone (the page moving under it). Done once the element is gone.
   */
  private async touchStart(page: Page, selector: string, what: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt < 2) await tapInView(page, selector, what);
      else {
        this.log(`${what}: two touches missed; clicking it in the DOM (audio may stay muted)`);
        await clickEl(page, selector, what);
      }
      const gone = await page.until<boolean>(`!${visible(selector)}`, what, 4000).catch((err: unknown) => {
        if (err instanceof PageReloadedError) throw err;
        return false;
      });
      if (gone) return;
    }
  }

  /** Waits until the player plays at `atLeastUs` or later; returns its playlist and disc key. */
  private async playingFrom(page: Page, atLeastUs: number, during: string): Promise<{ playlist: string; discKey: string; clockUs: number }> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const p = await this.playing(page, during);
      if (p.state === 'playing' && p.playlist && p.discKey && (p.clockUs ?? -1) >= atLeastUs) return { playlist: p.playlist, discKey: p.discKey, clockUs: p.clockUs! };
      if (Date.now() > deadline) throw new Error(`${during}: not playing from ${clockLabel(atLeastUs)} (${JSON.stringify(p)})`);
      await sleep(250);
    }
  }

  /** Pauses with the control bar's button (in the DOM: a tap on the picture only shows the controls); returns the stopped clock. */
  private async pauseAt(page: Page, during: string): Promise<number> {
    await clickEl(page, '[data-testid=play-toggle]', `${during}: pause`);
    await page.until(`document.querySelector('[data-testid=player]')?.getAttribute('data-state') === 'paused'`, `${during}: paused`, 15_000);
    await sleep(1500); // telemetry while paused reads the stopped clock
    const p = await this.playing(page, during);
    if (p.clockUs === null) throw new Error(`${during}: no clock in the telemetry`);
    return p.clockUs;
  }

  /** The person's place for `playlist` on `discKey`, once it is at `nearUs` (± 2 s), or the last one read. */
  private async placeNear(discKey: string, playlist: string, nearUs: number): Promise<{ timeUs: number; finished: boolean; settings: { textFiles: Array<{ name: string; subtitleId?: string }> } } | null> {
    type Place = { timeUs: number; finished: boolean; settings: { textFiles: Array<{ name: string; subtitleId?: string }> } };
    const deadline = Date.now() + 20_000;
    let last: Place | null = null;
    while (Date.now() < deadline) {
      const res = await this.people.mika!.fetch(`me/playback/${encodeURIComponent(discKey)}`);
      if (res.ok) last = ((await res.json()) as { places: Record<string, Place> }).places[playlist] ?? null;
      else await res.body?.cancel();
      if (last && Math.abs(last.timeUs - nearUs) < 2_000_000) return last;
      await sleep(500);
    }
    return last;
  }

  /** Whether the Subtitles menu shows the stored subtitle `id` picked, with its file in the text set; the menu is closed after. */
  private async storedPicked(page: Page, id: string, during: string): Promise<boolean> {
    await clickEl(page, '[data-testid=subtitle-menu]', `${during}: the Subtitles menu`);
    const ok = await page.until<boolean>(
      `(() => { const f = document.querySelector('[data-testid=subtitle-file-0]'); const r = document.querySelector(${JSON.stringify(`[data-testid=subtitle-stored-${id}]`)});` +
        ` return !!f && f.textContent.includes(${JSON.stringify(PLACES_SRT_NAME)}) && r?.getAttribute('aria-checked') === 'true'; })()`,
      `${during}: the stored subtitle in the text set`,
      20_000,
    ).catch((err: unknown) => {
      if (err instanceof PageReloadedError) throw err;
      return false;
    });
    await clickEl(page, '[data-testid=subtitle-menu]', `${during}: closing the Subtitles menu`).catch(() => undefined);
    return ok;
  }

  async places(): Promise<void> {
    const b = this.browser('mika-phone');
    if (!this.o.places) {
      this.r.places.skipped = 'not asked for (--places)';
      return;
    }
    if (!b) {
      this.r.places.skipped = 'no --mika-phone';
      return;
    }
    const disc = this.testDisc?.places(PLACES_DISC_NAME) ? await this.discAt(this.testDisc.pathOf(PLACES_DISC_NAME)) : null;
    if (!disc) {
      this.r.places.skipped = `${PLACES_DISC_NAME} is not in the NAS library`;
      return;
    }
    this.r.places.ran = true;
    const c = this.people.mika!;
    const dir = join(this.o.out, 'places');
    const steps = this.r.places.steps;
    const step = async (name: string, page: Page, run: () => Promise<{ ok: boolean; detail: string }>): Promise<boolean> => {
      const shot = join(dir, `${String(steps.length + 1).padStart(2, '0')}-${name.replace(/[^A-Za-z0-9]+/g, '-')}.png`);
      let rec: PlacesStep;
      try {
        rec = { step: name, ...(await run()) };
      } catch (err) {
        rec = { step: name, ok: false, detail: (err as Error).message };
      }
      await page.d.screenshot(shot).then(() => (rec.shot = relative(this.o.out, shot))).catch(() => undefined);
      steps.push(rec);
      this.log(`places: ${name}: ${rec.ok ? 'ok' : 'FAIL'}: ${rec.detail}`);
      return rec.ok;
    };
    // ?placemin=1: any playlist makes a place (the disc's is 60 s, under the 300 s a place needs by default)
    const query = '&placemin=1';
    let subtitleId: string | null = null;
    try {
      await this.pair(b, this.people.mikaId!);
      const page = b.page!;
      let discKey = '';
      let playlist = '';
      let savedUs = 0;

      // the player lists a disc's stored subtitles once per open: the subtitle is on the NAS before the disc opens
      const made = await c.json<{ id: string }>('subtitles', jsonPost({ name: 'Places check (test)', language: 'en', offsetMs: 0, for: { kind: 'chapter', discId: disc.id, playlistId: '00000', chapter: 0 } }));
      subtitleId = made.id;
      const put = await c.fetch(`subtitles/${encodeURIComponent(made.id)}/file/${PLACES_SRT_NAME}`, { method: 'PUT', body: PLACES_SRT });
      if (!put.ok) throw new HttpError(put.status, await put.text(), 'uploading the subtitle file');

      const played = await step('play from the NAS folder', page, async () => {
        await this.openNasDisc(page, disc, query);
        await page.until(visible('[data-testid=playlist-00000]'), 'the playlist picker', 30_000);
        await this.touchStart(page, '[data-testid=playlist-00000]', 'playlist 00000');
        ({ playlist, discKey } = await this.playingFrom(page, 500_000, 'the first play'));
        return { ok: true, detail: `playlist ${playlist}, disc key ${discKey.slice(0, 2)}…` };
      });
      if (!played || this.aborted) return;

      // the menus are used while paused: the controls (and an open menu) stay up only then on a touch device
      await step('pick a stored subtitle', page, async () => {
        await this.pauseAt(page, 'the pause to pick');
        await clickEl(page, '[data-testid=subtitle-menu]', 'the Subtitles menu');
        await clickEl(page, `[data-testid=subtitle-stored-${made.id}]`, 'the stored subtitle'); // a pick closes the menu
        const ok = await this.storedPicked(page, made.id, 'the pick');
        await clickEl(page, '[data-testid=play-toggle]', 'play');
        await this.playingFrom(page, 0, 'playing again');
        return { ok, detail: 'picked from "From the NAS"' };
      });

      const paused = await step('pause saves the place at the stopped clock', page, async () => {
        if ((await this.playing(page, 'the player')).state === 'paused') await clickEl(page, '[data-testid=play-toggle]', 'play');
        await this.playingFrom(page, 8_000_000, 'playing past 0:08');
        const clockUs = await this.pauseAt(page, 'the pause');
        const place = await this.placeNear(discKey, playlist, clockUs);
        if (!place) return { ok: false, detail: 'no place on the NAS' };
        savedUs = place.timeUs;
        const trail = clockUs - place.timeUs;
        const subtitle = place.settings.textFiles.some((f) => f.subtitleId === subtitleId);
        // the engine reports the stopped clock's time at a pause: no 250 ms report interval to trail by
        return { ok: Math.abs(trail) <= 50_000 && subtitle && !place.finished, detail: `paused at ${clockUs} µs, saved ${place.timeUs} µs (trails by ${Math.round(trail / 1000)} ms); stored subtitle in the place: ${subtitle}` };
      });
      if (!paused || this.aborted) return;

      await step('reopening offers Resume, with the subtitle back', page, async () => {
        await this.openPreflight(page, disc, query);
        const want = `Resume at ${clockLabel(savedUs)}`;
        const text = await page.until<string>(`(() => { const e = document.querySelector('[data-testid=resume-at]'); return e && e.getClientRects().length ? e.textContent : null; })()`, 'the resume prompt', 30_000);
        const asked = await page.probe<boolean>(visible('[data-testid=resume-start-over]'), 'Start from beginning');
        await page.d.screenshot(join(dir, 'resume-prompt.png')).catch(() => undefined);
        await this.touchStart(page, '[data-testid=resume-at]', 'Resume');
        const at = await this.playingFrom(page, 0, 'the resume');
        const from = at.clockUs >= savedUs - 500_000;
        await this.pauseAt(page, 'the pause after resuming');
        const subtitle = await this.storedPicked(page, subtitleId!, 'the resume');
        return { ok: text === want && asked && from && subtitle, detail: `prompt "${text}" (want "${want}"), Start from beginning offered: ${asked}; playing from ${at.clockUs} µs; subtitle back: ${subtitle}` };
      });
      if (this.aborted) return;

      await step('Continue watching resumes without asking', page, async () => {
        const place = await this.placeNear(discKey, playlist, savedUs);
        if (place) savedUs = place.timeUs;
        await page.open(`${this.o.origin}/nas?telemetry=1${query}`);
        const card = `[data-testid=continue-card][data-playlist=${cssString(playlist)}]`;
        await page.until(visible(card), 'the Continue watching card', 30_000);
        const kind = await page.probe<string | null>(`document.querySelector(${JSON.stringify(card)})?.getAttribute('data-kind') ?? null`, 'the card');
        await page.d.screenshot(join(dir, 'continue-watching.png')).catch(() => undefined);
        await clickEl(page, card, 'the Continue watching card');
        await page.until(visible('[data-testid=resume-at]'), 'Resume', 30_000);
        const asked = await page.probe<boolean>(visible('[data-testid=resume-start-over]'), 'Start from beginning');
        await this.touchStart(page, '[data-testid=resume-at]', 'Resume');
        const at = await this.playingFrom(page, 0, 'the resume from Continue watching');
        return { ok: kind === 'resume' && !asked && at.clockUs >= savedUs - 500_000, detail: `card ${kind}; asked: ${asked}; playing from ${at.clockUs} µs (saved ${savedUs} µs)` };
      });
    } catch (err) {
      steps.push({ step: 'run', ok: false, detail: (err as Error).message });
      this.log(`places: ${(err as Error).message}`);
    } finally {
      if (subtitleId !== null) {
        const id: string = subtitleId;
        const del = await c.fetch(`subtitles/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((e: unknown) => e as Error);
        const gone = !(del instanceof Error) && (del.status === 204 || del.status === 404);
        if (!gone) this.r.errors.push(`places: deleting the test subtitle ${id}: ${del instanceof Error ? del.message : `HTTP ${del.status}`}`);
        else this.log('places: test subtitle deleted');
      }
      await this.stop(b);
    }
    this.r.places.pass = steps.length === 5 && steps.every((x) => x.ok);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Library

  /** Opens the remote without reaching the disc: a tap off the picture first (an unknown disc may take a tap on it). */
  private remoteOps(page: Page): RemoteOps {
    const base = remoteOpsFor(page, [960, 540]);
    return {
      ...base,
      tapMenu: async () => {
        // the band is read once the page has settled (tapAt), so the touch is not aimed at a page still moving
        const band = await page.tapAt(() => page.probe<{ x: number; y: number } | null>(BAND_POINT, 'the letterbox'), 'a tap off the picture');
        if (!band) return base.tapMenu();
        return 'the letterbox (off the picture)';
      },
    };
  }

  private async key(page: Page, key: MenuKey): Promise<void> {
    if (!page.d.touch) {
      await page.d.press(key);
      return;
    }
    await openRemote(this.remoteOps(page));
    // a touch on the remote's key, checked in the page; two that miss give way to a DOM click, logged
    await page.tapOnOrClick(`[data-testid=remote-${key}]`, `the remote's ${key}`);
  }

  /** The playlist playing when the last key was sent. */
  private beforeKeyPlaylist: string | null = null;

  /** One step of the key script, approximated from the page's telemetry (the device sees flushes and playlists late). */
  private async runStep(page: Page, s: KeyStep): Promise<boolean> {
    const at = await this.snap(page, s.text);
    const from = at.t?.bdjPlane?.flushes ?? 0;
    const t0 = Date.now();
    let last = from;
    let lastAt = Date.now();
    let menuSince: number | null = null;
    const poll = async (timeoutMs: number, held: (snap: TelemetrySnap, quietMs: number) => boolean): Promise<boolean> => {
      while (Date.now() - t0 < timeoutMs) {
        const snap = await this.snap(page, s.text);
        const f = snap.t?.bdjPlane?.flushes ?? 0;
        if (f !== last) { last = f; lastAt = Date.now(); }
        if (held(snap, Date.now() - lastAt)) return true;
        await sleep(200);
      }
      return false;
    };
    switch (s.kind) {
      case 'key':
        // a playlist the key starts can be playing before the next step begins: `wait playlist` counts from here
        this.beforeKeyPlaylist = at.playlist;
        await this.key(page, s.key);
        return true;
      case 'waitMenu':
        return poll(90_000, (snap, quiet) => {
          const shown = snap.bdjMenu === 'true';
          if (!shown) {
            menuSince = null;
            return false;
          }
          const since = (menuSince ??= Date.now());
          return quiet >= s.ms || Date.now() - since >= 30_000;
        });
      case 'waitQuiet':
        return poll(60_000, (_snap, quiet) => quiet >= s.ms);
      case 'waitStill':
        return poll(90_000, (_snap, quiet) => last > from && quiet >= s.ms);
      case 'waitFlush':
        return poll(90_000, () => last >= s.n);
      case 'waitPlaylist':
        return poll(60_000, (snap) => (s.playlist === null ? snap.playlist !== null && snap.playlist !== '' && snap.playlist !== (this.beforeKeyPlaylist ?? at.playlist) : snap.playlist === String(s.playlist).padStart(5, '0')));
      case 'pointer':
        return false;
    }
  }

  async library(): Promise<void> {
    const b = this.browser('mika-phone');
    if (!this.o.library) {
      this.r.library.skipped = 'not asked for (--library)';
      return;
    }
    if (!b) {
      this.r.library.skipped = 'no --mika-phone';
      return;
    }
    const map = parseMap(readFileSync(join(this.o.libraryDir, 'map.tsv'), 'utf8'));
    const roots = await nasRoots();
    const steps = parseKeyScript(readFileSync(join(REPO, 'tools/bdj-library/generic.keys'), 'utf8'));
    this.r.library.ran = true;
    try {
      await this.pair(b, this.people.mikaId!);
      const page = b.page!;
      for (const id of this.o.discs) {
        if (this.aborted) break;
        const rec: LibraryDisc = { id, opened: false, steps: [] };
        this.beforeKeyPlaylist = null;
        this.r.library.discs.push(rec);
        const dir = join(this.o.out, id);
        try {
          const host = map.get(id);
          if (!host) throw new Error('not in map.tsv');
          const path = libraryPath(host, roots);
          if (!path) throw new Error('its folder is in no library root');
          const disc = await this.discAt(path);
          if (!disc) throw new Error('the NAS library does not list it');
          rec.nasDiscId = disc.id;
          await this.openNasDisc(page, disc);
          rec.firstFrameMs = await page.until<number>('window.__blurayTelemetry?.bdj?.firstFrameMs ?? null', "the first frame of Java's first playlist", 120_000);
          rec.opened = true;
          await page.d.screenshot(join(dir, '00-opened.png')).catch(() => undefined);
          for (const [n, s] of steps.entries()) {
            const t = Date.now();
            const held = await this.runStep(page, s);
            const snap = await this.snap(page, s.text);
            const shot = join(dir, `${String(n + 1).padStart(2, '0')}-${s.text.replace(/[^A-Za-z0-9]+/g, '-')}.png`);
            await page.d.screenshot(shot).catch(() => undefined);
            rec.steps.push({ n, step: s.text, held, ms: Date.now() - t, hash: snap.t?.bdjPlane?.hash ?? null, playlist: snap.playlist, menu: snap.bdjMenu, shot: relative(this.o.out, shot) });
            this.log(`${id}: ${s.text}: ${held ? 'held' : 'NOT HELD'} (playlist ${snap.playlist}, menu ${snap.bdjMenu})`);
          }
          await sleep(3000);
          await page.d.screenshot(join(dir, '99-end.png')).catch(() => undefined);
        } catch (err) {
          rec.error = (err as Error).message;
          rec.reloaded = err instanceof PageReloadedError;
          this.log(`${id}: ${rec.error}`);
          await page.d.screenshot(join(dir, 'error.png')).catch(() => undefined);
          if (rec.reloaded) await page.open(`${this.o.origin}/?telemetry=1`).catch(() => undefined);
        }
        write(join(dir, 'result.json'), `${JSON.stringify(rec, null, 2)}\n`);
      }
    } finally {
      await this.stop(b);
    }
  }

  /** Closes every browser still open (forgetting its test pairing). */
  async stopAll(): Promise<void> {
    for (const b of this.browsers) await this.stop(b).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const o = parseLiveArgs(process.argv.slice(2));
  if (!existsSync(join(REPO, 'tests/bdj/golden/disc-bdj-store.open.1.jsonl'))) throw new Error('the disc-bdj-store goldens are missing');
  const check = new LiveCheck(o);
  let cleaning: Promise<void> | null = null;
  const cleanUp = (): Promise<void> =>
    (cleaning ??= (async () => {
      await check.stopAll();
      // the test disc first: its rescan needs Mika's owner session, which goes with Mika
      const disc = check.testDisc;
      if (disc) {
        await disc.remove(check.people.mika).catch((e: unknown) => disc.report.detail.push(`removing the test disc: ${(e as Error).message}`));
        check.r.testDisc = { libraryPath: disc.libraryPath, clean: disc.clean, ...disc.report };
        check.log(`test disc: ${disc.clean ? 'removed and unlisted' : `NOT CLEAN: ${disc.report.detail.join('; ')}`}`);
      }
      const c = await check.people.cleanUp().catch((e: unknown) => ({ confirmed: false, detail: `clean-up failed: ${(e as Error).message}` }));
      check.r.people.deleted = check.people.deleted;
      check.r.people.cleanupConfirmed = c.confirmed;
      check.r.people.cleanupDetail = c.detail;
      check.r.finishedAt = new Date().toISOString();
      write(join(o.out, 'live-check.json'), `${JSON.stringify(check.r, null, 2)}\n`);
      check.log(`clean-up: ${c.confirmed ? 'confirmed' : 'NOT CONFIRMED'}: ${c.detail}`);
    })());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      check.aborted = true;
      check.log(`${sig}: cleaning up before exiting`);
      void cleanUp().finally(() => process.exit(130));
    });
  }
  let failed = false;
  let placesDisc: (PlacedDisc & { remove(): void }) | null = null;
  try {
    await check.people.setUp();
    check.r.people.created = true;
    const placed: PlacedDisc[] = [];
    if (o.storeDisc === 'place' && o.rehearseStore === null) placed.push({ name: STORE_DISC_NAME, parent: join(REPO, 'fixtures/synthetic') });
    if (o.places) {
      placesDisc = await makePlacesDisc();
      placed.push(placesDisc);
    }
    if (placed.length > 0) {
      check.testDisc = new TestDisc(o.placeRoot, await nasRoots(), (m) => check.log(m), placed);
      await check.testDisc.place(check.people.mika!);
    }
    await check.store();
    await check.places();
    await check.library();
  } catch (err) {
    failed = true;
    check.r.errors.push((err as Error).message);
    check.log(`error: ${(err as Error).message}`);
  } finally {
    await cleanUp();
    placesDisc?.remove();
  }
  const r = check.r;
  console.error(
    `store: ${r.store.ran ? (r.store.mode === 'rehearsal' ? `rehearsed (${r.store.steps.filter((s) => s.ok).length}/${r.store.steps.length} planes read)` : r.store.pass ? 'PASS' : 'FAIL') : `skipped (${r.store.skipped})`}; ` +
      `places: ${r.places.ran ? (r.places.pass ? 'PASS' : 'FAIL') : `skipped (${r.places.skipped})`}; ` +
      `library: ${r.library.ran ? `${r.library.discs.filter((d) => d.opened).length}/${r.library.discs.length} opened` : `skipped (${r.library.skipped})`}; ` +
      `${r.testDisc ? `test disc: ${r.testDisc.clean ? 'removed' : 'NOT CLEAN'}; ` : ''}people deleted: ${r.people.cleanupConfirmed ? 'confirmed' : 'NOT CONFIRMED'} → ${join(o.out, 'live-check.json')}`,
  );
  process.exit(failed || !r.people.cleanupConfirmed || (r.testDisc && !r.testDisc.clean) || (r.store.ran && r.store.mode === 'check' && !r.store.pass) || (r.places.ran && !r.places.pass) ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
