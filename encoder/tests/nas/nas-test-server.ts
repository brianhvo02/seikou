// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appHandlers } from '../../../server/src/app';
import { Auth } from '../../../server/src/auth';
import { BdjStore } from '../../../server/src/bdj-store';
import { EncodeIndex } from '../../../server/src/encodes/index-store';
import { UploadStore } from '../../../server/src/encodes/uploads';
import { createServer } from '../../../server/src/http';
import { Library } from '../../../server/src/library';
import type { TitleLibrary } from '../../../server/src/routes/titles';
import { Store } from '../../../server/src/store';

// Seikou's NAS server, in this process, for the encoder's NAS tests: its real pairing, session, me, disc and encodes
// routes on 127.0.0.1, over temporary copies of the fixtures. Codes are minted straight through its `Auth`.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
/** Long enough ago that the NAS counts every copied file as settled. */
const SETTLED = new Date('2024-01-01T00:00:00Z');
/** Past a session's hour, so every token the NAS gave before lapses. */
const SESSION_LIFE_MS = 2 * 60 * 60 * 1000;

/** A running stand-in. */
export interface NasTestServer {
  /** The API base, `http://127.0.0.1:<port>/api/`. */
  readonly base: string;
  /** A fresh code for a new owner person (named `name`). */
  ownerCode(name?: string): Promise<string>;
  /** A fresh code for a new person who is not an owner. */
  guestCode(name?: string): Promise<string>;
  /** The encodes folder (`ENCODES_DIR`), holding episode 1 of AniList 990001; null when started without one. */
  readonly encodesDir: string | null;
  /** The library root `syn`, a copy of fixtures/synthetic; null when started without discs. */
  readonly discsDir: string | null;
  /** The NAS's data folder. */
  readonly dataDir: string;
  /** Moves the NAS's clock past every session it has given, as if it had forgotten them all. */
  expireSessions(): void;
  /** Stops answering: the server closes its port and every connection, keeping its state. */
  pause(): Promise<void>;
  /** Answers again on the same port, as it was before `pause`. */
  resume(): Promise<void>;
  /** Stops the server and removes its folders. */
  close(): Promise<void>;
}

/** What to start with: the encodes folder and the disc library, both by default. */
export interface NasTestServerOptions {
  readonly encodes?: boolean;
  readonly discs?: boolean;
  /** Changes the copy of the disc library (its folder given) before it is backdated and scanned. */
  readonly prepare?: (discsDir: string) => void;
}

function backdate(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) backdate(join(dir, e.name));
    else utimesSync(join(dir, e.name), SETTLED, SETTLED);
  }
  utimesSync(dir, SETTLED, SETTLED);
}

/** Starts the stand-in on a free port and waits for its first library and encodes scans. */
export async function startNasTestServer(opts: NasTestServerOptions = {}): Promise<NasTestServer> {
  const tmp = mkdtempSync(join(tmpdir(), 'encoder-nas-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir);
  let clockOffset = 0;
  const now = (): number => Date.now() + clockOffset;
  const auth = new Auth(new Store(dataDir), now);

  let discsDir: string | null = null;
  if (opts.discs !== false) {
    discsDir = join(tmp, 'syn');
    cpSync(join(REPO, 'fixtures/synthetic'), discsDir, { recursive: true });
    opts.prepare?.(discsDir);
    backdate(discsDir);
  }
  const library = new Library(discsDir === null ? [] : [{ name: 'syn', dir: discsDir }], join(dataDir, 'library.json'), { scanPauseMs: 0 });
  await library.scan();

  let encodesDir: string | null = null;
  let encodes: EncodeIndex | undefined;
  let encodeUploads: UploadStore | undefined;
  if (opts.encodes !== false) {
    encodesDir = join(tmp, 'encodes');
    mkdirSync(join(encodesDir, '990001'), { recursive: true });
    cpSync(join(REPO, 'fixtures/encodes/990001/1.mkv'), join(encodesDir, '990001/1.mkv'));
    backdate(encodesDir);
    encodes = new EncodeIndex({ dir: encodesDir, dataDir, log: () => {}, settleMs: 0 });
    await encodes.scan();
    encodeUploads = new UploadStore({ dir: encodesDir, index: encodes, log: () => {} });
  }

  const titles = {
    service: { gate: () => 'everyone', entriesFor: () => new Map(), addEncodeArt: () => {}, encodeArtUrls: () => null },
    owner: {},
  } as unknown as TitleLibrary;
  const server = createServer(
    appHandlers({
      auth,
      library,
      bdjStore: new BdjStore(dataDir),
      publicBase: 'https://nas.example/bluray/api/',
      titles,
      now,
      ...(encodes ? { encodes } : {}),
      ...(encodeUploads ? { encodeUploads } : {}),
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api/`;
  const stop = (): Promise<void> =>
    new Promise<void>((r) => {
      if (!server.listening) return r();
      server.close(() => r());
      server.closeAllConnections();
    });
  const code = (name: string, owner: boolean): Promise<string> => Promise.resolve(auth.createCode({ newPerson: { name, owner } }).code);

  return {
    base,
    ownerCode: (name = 'Mika Owner') => code(name, true),
    guestCode: (name = 'Sora Guest') => code(name, false),
    encodesDir,
    discsDir,
    dataDir,
    expireSessions() {
      clockOffset += SESSION_LIFE_MS;
    },
    pause: stop,
    async resume() {
      if (!server.listening) await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    },
    async close() {
      encodes?.close();
      await stop();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
