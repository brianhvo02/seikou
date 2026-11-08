// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listPlaylists, loadPlaylist } from './disc/playlist';
import { encodeEpisodes, type EncodeEvent } from './encode';
import { MkvReadError } from './mux/mkv-reader';
import { packageEpisode, PackageError } from './package/package';
import { SupError } from './package/sup';
import { WebmError } from './package/webm';
import { loadEncodeRecord, MissingSubtitleFilesError, NoAudioChosenError, RecordMismatchError } from './subs/encode-record';
import { ChainError } from './pipeline/chain';
import { EpisodeSpecError, parseEpisodeSpec } from './plan/episodes';
import { startJobRunner } from './server/jobs';
import { startHelperServer, type AppContext } from './server/server';
import { createSources } from './server/sources';
import { appDataDir } from './subs/app-data';
import { appSettings } from './subs/app-settings';
import { findTools, ToolsError } from './tools';
import type { ToolPaths } from './pipeline/chain';

class UsageError extends Error {}

/** Thrown by `serve` when the helper page has not been built; the command line answers it with exit code 3. */
class WebDirMissingError extends Error {}

const USAGE = `Usage:
  seikou-encode plan <disc> [--playlist ID]
  seikou-encode encode <disc> --playlist ID --episodes SPEC --out DIR
      [--name PATTERN] [--crf N] [--preset N] [--film-grain N] [--svt-args "..."] [--opus-bitrate N] [--title T] [--cache DIR]
      [--no-subtitles] [--no-pgs] [--web DIR]
  seikou-encode package <episode.mkv> --out DIR
  seikou-encode serve <disc> --playlist ID --episodes SPEC [--port N] [--no-open]
  seikou-encode app [--root DIR]... [--port N] [--no-open]`;

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

function mmss(ticks45: number): string {
  const s = Math.floor(ticks45 / 45000);
  return `${pad(Math.floor(s / 60), 2)}:${pad(s % 60, 2)}`;
}

function mmssmmm(ticks45: number): string {
  const totalMs = Math.round(ticks45 / 45);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000);
  return `${pad(Math.floor(s / 60), 2)}:${pad(s % 60, 2)}.${pad(ms, 3)}`;
}

function intOption(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer, got "${value}"`);
  return n;
}

/**
 * The folder BestSource keeps its index files in: `cache` (the `--cache` option) resolved against the working
 * directory, else `bestsource` under the app data directory (see `appDataDir`), which `serve` shares so an encode
 * reuses the index the line-up built.
 */
export function bestsourceCacheDir(cache: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return cache === undefined ? join(appDataDir(env), 'bestsource') : resolve(cache);
}

/** The built helper page: `SEIKOU_ENCODE_WEB_DIR` when set, else `web/dist` beside `src/`. */
function helperWebDir(env: NodeJS.ProcessEnv): string {
  return env.SEIKOU_ENCODE_WEB_DIR ? resolve(env.SEIKOU_ENCODE_WEB_DIR) : fileURLToPath(new URL('../web/dist', import.meta.url));
}

/** Asks the desktop to open `url` in the default browser; a failure to do so is ignored, the URL is printed anyway. */
function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

/** Resolves when the process is asked to stop (SIGINT or SIGTERM). */
function untilStopped(): Promise<void> {
  return new Promise((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

/** The built helper page's folder; throws `WebDirMissingError` when it holds no index.html. */
function builtWebDir(): string {
  const webDir = helperWebDir(process.env);
  if (statSync(join(webDir, 'index.html'), { throwIfNoEntry: false })?.isFile() !== true) {
    throw new WebDirMissingError(`The helper page is not built (no index.html in ${webDir}); run npm run encoder:web:build first`);
  }
  return webDir;
}

/** The external tools, or null (with a note printed) when some are missing. */
function toolsOrNull(): ToolPaths | null {
  try {
    return findTools();
  } catch (err) {
    if (!(err instanceof ToolsError)) throw err;
    console.log(`Alignment is unavailable: ${err.message.split('\n')[0]}`);
    return null;
  }
}

/**
 * Starts the app on the library `roots` with no session and its encode queue, prints its address and runs until
 * stopped.
 */
async function app(roots: readonly string[], port: number, open: boolean): Promise<void> {
  const real: string[] = [];
  for (const root of roots) {
    const dir = resolve(root);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) throw new UsageError(`--root ${root} is not a folder`);
    real.push(dir);
  }
  const webDir = builtWebDir();
  if (real.length === 0 && (await appSettings(appDataDir()).read()).roots.length === 0) {
    console.log('No library folders are set. Add one in the app, or start with --root DIR.');
  }
  const tools = toolsOrNull();
  const token = randomBytes(32).toString('hex');
  const context: AppContext = { dataDir: appDataDir(), token, webDir, tools, sources: createSources(process.env, fetch), roots: real };
  const server = await startHelperServer(context, port);
  const runner = startJobRunner(context);
  const url = `${server.url}?t=${token}`;
  console.log(`App: ${url}`);
  if (open) openInBrowser(url);
  await untilStopped();
  await stopRunning(runner);
  await server.close();
}

/**
 * Stops the encode queue before the process exits: a running job is cancelled, its tools are waited for, and it is
 * saved as interrupted, so it can be retried on the next start.
 */
async function stopRunning(runner: ReturnType<typeof startJobRunner>): Promise<void> {
  if (runner.list().some((j) => j.state === 'running')) console.log('Stopping the running encode; it can be retried after the next start.');
  await runner.shutdown();
}

async function serve(
  disc: string,
  playlistId: string,
  episodes: string,
  port: number,
  open: boolean,
): Promise<void> {
  const discDir = resolve(disc);
  // A bad episode spec is a usage error whether or not the page is built.
  const playlist = await loadPlaylist(discDir, playlistId);
  parseEpisodeSpec(episodes, playlist.chapters.length);
  const webDir = builtWebDir();
  const tools = toolsOrNull();
  const token = randomBytes(32).toString('hex');
  const context: AppContext = { dataDir: appDataDir(), token, webDir, tools, sources: createSources(process.env, fetch), roots: [] };
  const server = await startHelperServer(context, port);
  const runner = startJobRunner(context);
  let session;
  try {
    session = await server.sessions.create({ discDir, playlistId, episodeSpec: episodes });
  } catch (err) {
    await stopRunning(runner);
    await server.close();
    throw err;
  }
  const url = `${server.url}helper/${session.id}?t=${token}`;
  console.log(`Helper: ${url}`);
  if (open) openInBrowser(url);
  await untilStopped();
  await stopRunning(runner);
  await server.close();
}

async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      playlist: { type: 'string' },
      episodes: { type: 'string' },
      out: { type: 'string' },
      name: { type: 'string' },
      crf: { type: 'string' },
      preset: { type: 'string' },
      'film-grain': { type: 'string' },
      'svt-args': { type: 'string' },
      'opus-bitrate': { type: 'string' },
      title: { type: 'string' },
      cache: { type: 'string' },
      port: { type: 'string' },
      root: { type: 'string', multiple: true },
      'no-open': { type: 'boolean' },
      'no-subtitles': { type: 'boolean' },
      'no-pgs': { type: 'boolean' },
      web: { type: 'string' },
    },
  });
  const [command, disc] = positionals;
  if (command === 'app') {
    if (positionals.length > 1) throw new UsageError('expected: app [--root DIR]… [--port N] [--no-open]');
    const port = values.port === undefined ? 0 : intOption(values.port, 'port');
    await app(values.root ?? [], port, values['no-open'] !== true);
    return;
  }
  if (command === 'package') {
    if (disc === undefined || positionals.length > 2) throw new UsageError('expected: package <episode.mkv> --out DIR');
    if (values.out === undefined) throw new UsageError('--out is required');
    const outDir = resolve(values.out);
    await packageEpisode(resolve(disc), outDir);
    console.log(`Packaged ${disc} into ${outDir}`);
    return;
  }
  if (disc === undefined || positionals.length > 2) throw new UsageError('expected: <command> <disc>');

  if (command === 'plan') {
    if (values.playlist === undefined) {
      for (const p of await listPlaylists(disc)) {
        console.log(`${p.id}  ${mmss(p.duration45)}  ${p.clipIds.join(',')}`);
      }
      return;
    }
    const playlist = await loadPlaylist(disc, values.playlist);
    for (const c of playlist.chapters) {
      const clip = playlist.items[c.itemIndex]?.clipId ?? '';
      console.log(`${String(c.index).padStart(2)}  ${mmssmmm(c.start45)}  ${clip}`);
    }
    return;
  }

  if (command === 'encode') {
    if (values.playlist === undefined) throw new UsageError('--playlist is required');
    if (values.episodes === undefined) throw new UsageError('--episodes is required');
    if (values.out === undefined) throw new UsageError('--out is required');
    const outDir = resolve(values.out);
    const cacheDir = bestsourceCacheDir(values.cache);
    const opusBitrate =
      values['opus-bitrate'] === undefined ? undefined : intOption(values['opus-bitrate'], 'opus-bitrate');
    const crf = values.crf === undefined ? 25 : intOption(values.crf, 'crf');
    const preset = values.preset === undefined ? 4 : intOption(values.preset, 'preset');
    const filmGrain = values['film-grain'] === undefined ? 4 : intOption(values['film-grain'], 'film-grain');
    // A bad episode spec is a usage error (exit 2) whether or not the tools are installed.
    const playlist = await loadPlaylist(resolve(disc), values.playlist);
    parseEpisodeSpec(values.episodes, playlist.chapters.length);
    // A saved record that does not fit this encode is a usage error too, whether or not the tools are installed.
    const dataDir = appDataDir();
    const noSubtitles = values['no-subtitles'] === true;
    const record = await loadEncodeRecord({ discDir: resolve(disc), playlistId: values.playlist, episodeSpec: values.episodes, dataDir, noSubtitles });
    const tools = findTools();
    await encodeEpisodes(
      {
        discDir: disc,
        playlistId: values.playlist,
        episodes: values.episodes,
        outDir,
        namePattern: values.name ?? 'episode-{n}',
        crf,
        preset,
        filmGrain,
        extraSvtArgs: (values['svt-args'] ?? '').split(/\s+/).filter((a) => a !== ''),
        opusBitrate,
        cacheDir,
        tools,
        title: values.title,
        dataDir,
        noSubtitles,
        record,
        noPgs: values['no-pgs'] === true,
        webDir: values.web === undefined ? undefined : resolve(values.web),
      },
      printEncodeEvent,
    );
    return;
  }

  if (command === 'serve') {
    if (values.playlist === undefined) throw new UsageError('--playlist is required');
    if (values.episodes === undefined) throw new UsageError('--episodes is required');
    const port = values.port === undefined ? 0 : intOption(values.port, 'port');
    await serve(disc, values.playlist, values.episodes, port, values['no-open'] !== true);
    return;
  }

  throw new UsageError(`unknown command "${command ?? ''}"`);
}

/** Prints what the `encode` command shows of an event: starts and finishes on stdout, log lines on stderr, nothing for progress or packaging events. */
export function printEncodeEvent(e: EncodeEvent): void {
  if (e.kind === 'episode-done') console.log(`Episode ${e.episode} done: ${e.path ?? ''}`);
  else if (e.kind === 'episode-start') console.log(e.message);
  else if (e.kind === 'log') console.error(e.message);
}

/**
 * Runs the command line and returns the process exit code: 0 success, 1 encode or packaging failure (`package` on a
 * file that is not a readable Matroska file with an AV1 track, too), 2 usage
 * error, bad episode list or a saved record that does not fit the encode (another playlist or episode list, or an
 * episode with no audio stream ticked), 3 required tools missing (or, for `serve` and `app`, the page not built). Output goes to stdout and stderr; nothing
 * is thrown.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    await run(argv);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n${USAGE}`);
      return 2;
    }
    if (err instanceof EpisodeSpecError) {
      console.error(err.message);
      return 2;
    }
    if (err instanceof RecordMismatchError || err instanceof NoAudioChosenError) {
      console.error(err.message);
      return 2;
    }
    if (err instanceof MkvReadError || err instanceof WebmError || err instanceof PackageError || err instanceof SupError) {
      console.error(`Packaging failed: ${err.message}`);
      return 1;
    }
    if (err instanceof MissingSubtitleFilesError) {
      console.error(err.message);
      return 1;
    }
    if (err instanceof WebDirMissingError) {
      console.error(err.message);
      return 3;
    }
    if (err instanceof ToolsError) {
      console.error(err.message);
      return 3;
    }
    if (err instanceof ChainError) {
      console.error(`${err.tool} failed (code ${String(err.code)}, signal ${String(err.signal)})\n${err.stderrTail}`);
      return 1;
    }
    if (err instanceof Error && (err as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS_') === true) {
      console.error(`${err.message}\n${USAGE}`);
      return 2;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
