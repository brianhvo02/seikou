// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The NAS of nas.spec.ts, started by playwright.encoder.config.ts (`npx tsx encoder/tests/e2e/nas-stand-in.ts`, after
 * `npm run server:build`): Seikou's built NAS server on NAS_PORT over a copy of fixtures/synthetic with the encoder's
 * speech disc beside it, an empty encodes folder, and its own data folder, all under the run's temporary folder
 * (`SEIKOU_ENCODE_E2E_NAS`). AniList, TMDB, the music lookups, SeaDex and Anime Tosho are the recorded answers Seikou's
 * NAS E2E uses, so nothing touches the network; there is no rendezvous Worker, so no WebRTC route either.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Not Seikou's NAS E2E ports (4191, 4192) nor the encoder's other servers (4195, 4197). */
export const NAS_PORT = 4198;
/** The NAS's API base, as a pairing names it. */
export const NAS_BASE = `http://127.0.0.1:${NAS_PORT}/api/`;
/** The built NAS server. */
export const SERVER = join(REPO, 'server/dist/server.mjs');
/** Where the encoder's speech disc sits in the NAS's root (the synthetic discs hold a smaller `disc-speech` of their own). */
export const SPEECH_FOLDER = 'Encoder source/disc-speech';

/** The run's NAS folder, made by the config. */
export function nasDir(): string {
  const dir = process.env.SEIKOU_ENCODE_E2E_NAS;
  if (!dir) throw new Error('SEIKOU_ENCODE_E2E_NAS is not set: run this through playwright.encoder.config.ts');
  return dir;
}

/** The server's environment over the run's NAS folder, also what `server.mjs owner-code` needs to mint a code for it. */
export function nasEnv(dir: string = nasDir()): Record<string, string> {
  return {
    LIBRARY_ROOTS: `syn=${join(dir, 'root')}`,
    DATA_DIR: join(dir, 'data'),
    ENCODES_DIR: join(dir, 'encodes'),
    PORT: String(NAS_PORT),
    PUBLIC_BASE: NAS_BASE,
    // Named here because Playwright hands the earlier servers' `APP_URL` (the encoder app's address) to this one.
    APP_URL: 'https://bluray.pages.dev/',
    // Nothing proxies here.
    TRUSTED_PROXY: '',
    SCAN_PAUSE_MS: '0',
    METADATA_FIXTURE: join(REPO, 'tests/e2e/fixtures/nas-metadata.json'),
    MUSIC_FIXTURE: join(REPO, 'tests/e2e/fixtures/nas-music.json'),
    FANSUB_FIXTURE: join(REPO, 'tests/e2e/fixtures/fansubs'),
    FANSUB_NIGHTLY: 'off',
    LEVELS_BACKEND: 'off',
  };
}

/** Sets every file and folder under `dir` to `when`, deepest first. */
function backdateTree(dir: string, when: Date): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) backdateTree(join(dir, e.name), when);
    else utimesSync(join(dir, e.name), when, when);
  }
  utimesSync(dir, when, when);
}

function main(): void {
  const dir = nasDir();
  const env = nasEnv(dir);
  const root = join(dir, 'root');
  cpSync(join(REPO, 'fixtures/synthetic'), root, { recursive: true });
  cpSync(join(REPO, 'encoder/fixtures/disc-speech'), join(root, SPEECH_FOLDER), { recursive: true });
  // The NAS leaves out discs written in the last hour (a download still in progress).
  backdateTree(root, new Date('2024-01-01T00:00:00Z'));
  mkdirSync(env.DATA_DIR!, { recursive: true });
  mkdirSync(env.ENCODES_DIR!, { recursive: true });
  const server = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: 'inherit' });
  server.on('exit', (code) => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
