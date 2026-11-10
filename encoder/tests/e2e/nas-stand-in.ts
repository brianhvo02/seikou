// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The NAS of nas.spec.ts, started by playwright.encoder.config.ts (`npx tsx encoder/tests/e2e/nas-stand-in.ts`, after
 * `npm run server:build`): Seikou's built NAS server on NAS_PORT over a copy of fixtures/synthetic with the encoder's
 * speech disc in a made-up title's folder (below), an empty encodes folder, and its own data folder, all under the
 * run's temporary folder (`SEIKOU_ENCODE_E2E_NAS`). AniList and TMDB answer with the made-up entries of `encoder/tests/fixtures/nas-titles.json`
 * (posters left out, so nothing fetches an image), the music lookups, SeaDex and Anime Tosho with the recorded answers
 * Seikou's NAS E2E uses, so nothing touches the network; there is no rendezvous Worker, so no WebRTC route either.
 * Three discs sit in the folders of two made-up AniList series so the NAS files them: copies of the encoder's `disc1`
 * (real clips) and Seikou's `disc-vm` as the first and second disc of Lantern Road (990001, two episodes of 4 s, one on
 * each disc), and the encoder's speech disc (real clips, five chapters) as Starfall Wanderer's (990010, which the NAS
 * lists no episodes for).
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Not Seikou's NAS E2E ports (4191, 4192) nor the encoder's other servers (4195, 4197). */
export const NAS_PORT = 4198;
/** The NAS's API base, as a pairing names it. */
export const NAS_BASE = `http://127.0.0.1:${NAS_PORT}/api/`;
/** The built NAS server. */
export const SERVER = join(REPO, 'server/dist/server.mjs');
/** A copy of the encoder's `disc1`, filed under the made-up AniList series Lantern Road (990001) as its first disc (episode 1 is its playlist 00001). */
export const LANTERN_FIRST_FOLDER = 'Anime/Lantern Road/Lantern Road Vol.1';
/** A copy of `disc-vm`, Lantern Road's second disc (episode 2 is its playlist 00001): the one a check moves to a TMDB title. */
export const LANTERN_SECOND_FOLDER = 'Anime/Lantern Road/Lantern Road Vol.2';
/** A copy of the encoder's speech disc, the only disc of the made-up AniList series Starfall Wanderer (990010). */
export const STARFALL_FOLDER = 'Anime/Starfall Wanderer/Starfall Wanderer Vol.1';

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
    METADATA_FIXTURE: join(dir, 'metadata.json'),
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
  cpSync(join(REPO, 'encoder/fixtures/disc1'), join(root, LANTERN_FIRST_FOLDER), { recursive: true });
  cpSync(join(REPO, 'encoder/fixtures/disc-speech'), join(root, STARFALL_FOLDER), { recursive: true });
  cpSync(join(REPO, 'fixtures/synthetic/disc-vm'), join(root, LANTERN_SECOND_FOLDER), { recursive: true });
  // The recorded titles, without their poster addresses (the NAS would fetch them).
  const recorded = JSON.parse(readFileSync(join(REPO, 'encoder/tests/fixtures/nas-titles.json'), 'utf8')) as Record<string, Record<string, unknown>[]>;
  recorded['Starfall Wanderer'] = [
    {
      source: 'anilist',
      id: 'anilist:990010',
      kind: 'series',
      format: 'TV',
      names: { english: 'Starfall Wanderer', romaji: 'Ryuusei no Tabibito', native: null, synonyms: [] },
      animation: true,
      year: 2023,
      startDate: 20230701,
      episodes: 2,
      runtimeMin: 24,
      seasons: [],
      relations: [],
      poster: null,
      banner: null,
    },
  ];
  for (const entries of Object.values(recorded)) for (const e of entries) e.poster = null;
  writeFileSync(env.METADATA_FIXTURE!, JSON.stringify(recorded));
  // The NAS leaves out discs written in the last hour (a download still in progress).
  backdateTree(root, new Date('2024-01-01T00:00:00Z'));
  mkdirSync(env.DATA_DIR!, { recursive: true });
  mkdirSync(env.ENCODES_DIR!, { recursive: true });
  const server = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: 'inherit' });
  server.on('exit', (code) => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
