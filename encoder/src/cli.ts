// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discKeyOfFolder } from './disc/disc-key';
import { listPlaylists, loadPlaylist } from './disc/playlist';
import { encodeEpisodes, episodeName, type EncodeEvent, type EncodeOptions } from './encode';
import { hostOf, NasClient, NasError } from './nas/client';
import { checkNasDestination, NasDestinationError, uploadNameOf } from './nas/destination';
import { ensureMirror, FetchError } from './nas/mirror';
import { NasLibrary } from './nas/nas-library';
import { NasUploadFailed, runNasEpisodes } from './nas/nas-episodes';
import { readNasPairing, removeNasPairing } from './nas/nas-store';
import { pairWithNas } from './nas/pairing';
import { UploadError } from './nas/upload';
import { MkvReadError } from '@seikou/matroska';
import { packageEpisode, PackageError } from './package/package';
import { SupError } from './package/sup';
import { WebmError } from './package/webm';
import { loadEncodeRecord, MissingSubtitleFilesError, NoAudioChosenError, RecordMismatchError } from './subs/encode-record';
import { ChainError } from './pipeline/chain';
import { EpisodeSpecError, parseEpisodeSpec, parseOnly } from './plan/episodes';
import { startJobRunner } from './server/jobs';
import { takeJobsLock, type JobsLock } from './server/jobs-lock';
import { encoderDeviceName } from './server/nas-routes';
import { startHelperServer, type AppContext } from './server/server';
import { createSources } from './server/sources';
import { appDataDir } from './subs/app-data';
import { appSettings } from './subs/app-settings';
import { findTools, ToolsError } from './tools';
import type { ToolPaths } from './pipeline/chain';

class UsageError extends Error {}

/** Thrown by `serve` when the helper page has not been built; the command line answers it with exit code 3. */
class WebDirMissingError extends Error {}

/** Thrown by `app` when another process runs the data folder's encode queue; the command line answers it with exit code 1. */
class QueueElsewhereError extends Error {}

/** A refusal that is no usage mistake (not paired, an unknown NAS disc): exit code 2, the message without the usage. */
class RefusedError extends Error {}

/**
 * Thrown when an encode to the NAS or of a NAS disc was stopped with Ctrl-C; exit code 1. `upload` is the upload the
 * stop cut short, whose MKV is kept.
 */
export class StoppedError extends Error {
  constructor(readonly upload: NasUploadFailed | null = null) {
    super('Stopped.');
  }
}

/** What the command line says when the NAS does not answer. */
const NAS_UNREACHABLE = "The NAS can't be reached.";
/** What it says when the NAS no longer knows this encoder. */
const NAS_FORGOT = 'The NAS no longer knows this encoder. Pair it again with seikou-encode nas pair.';
/** The disc argument of a NAS disc: `nas:<disc key>`. */
const NAS_DISC = 'nas:';
/** How long the command line waits for the NAS to say it knows this encoder. */
const NAS_ANSWER_MS = 15_000;

/** One line for a NAS failure: no answer is `The NAS can't be reached.`, a NAS that forgot this encoder says so. */
function nasFailure(err: unknown): string {
  if ((err instanceof NasError || err instanceof FetchError || err instanceof UploadError) && err.code === 'unreachable') return NAS_UNREACHABLE;
  if (err instanceof NasError && err.code === 'unauthorized') return NAS_FORGOT;
  return err instanceof Error ? err.message : String(err);
}

/** What the command line prints for a failed or stopped NAS run: the failure, then where an MKV not uploaded is kept. */
export function nasRunFailure(err: NasError | FetchError | UploadError | NasUploadFailed | StoppedError): string {
  if (err instanceof NasUploadFailed) return `${nasFailure(err.cause)}\n${err.kept}`;
  if (err instanceof StoppedError) return err.upload === null ? err.message : `${err.message}\n${err.upload.kept}`;
  return nasFailure(err);
}

const USAGE = `Usage:
  seikou-encode plan <disc | nas:KEY> [--playlist ID]
  seikou-encode encode <disc | nas:KEY> --playlist ID --episodes SPEC [--only LIST] (--out DIR | --nas [--out DIR])
      [--name PATTERN] [--crf N] [--preset N] [--film-grain N] [--svt-args "..."] [--opus-bitrate N] [--title T] [--cache DIR]
      [--no-subtitles] [--no-pgs] [--web DIR]
  seikou-encode nas pair (--code CODE --base URL | --link URL)
  seikou-encode nas status
  seikou-encode nas unpair
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
 * stopped. It refuses to start (`QueueElsewhereError`) while another process holds the data folder's queue lock.
 */
async function app(roots: readonly string[], port: number, open: boolean): Promise<void> {
  const real: string[] = [];
  for (const root of roots) {
    const dir = resolve(root);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) throw new UsageError(`--root ${root} is not a folder`);
    real.push(dir);
  }
  const webDir = builtWebDir();
  const dataDir = appDataDir();
  const attempt = takeJobsLock(dataDir);
  if ('heldBy' in attempt) throw new QueueElsewhereError(`Another seikou-encode app (pid ${attempt.heldBy}) is using the data folder ${dataDir}.`);
  const token = randomBytes(32).toString('hex');
  let context: AppContext;
  let server: Awaited<ReturnType<typeof startHelperServer>>;
  try {
    if (real.length === 0 && (await appSettings(dataDir).read()).roots.length === 0) {
      console.log('No library folders are set. Add one in the app, or start with --root DIR.');
    }
    context = { dataDir, token, webDir, tools: toolsOrNull(), sources: createSources(process.env, fetch), roots: real, nas: { client: await NasClient.load(dataDir) } };
    server = await startHelperServer(context, port);
  } catch (err) {
    attempt.lock.release();
    throw err;
  }
  const runner = startJobRunner(context, {}, attempt.lock);
  const url = `${server.url}?t=${token}`;
  console.log(`App: ${url}`);
  if (open) openInBrowser(url);
  await untilStopped();
  await stopRunning(runner);
  await server.close();
}

/**
 * The line the first Ctrl-C prints while a job runs, saying what the stop waits for (see `JobRunner.waitingFor`);
 * null when nothing runs.
 */
export function stoppingLine(waitingFor: string | null): string | null {
  return waitingFor === null ? null : `Stopping: waiting for ${waitingFor} to finish; press Ctrl-C again to quit now.`;
}

/**
 * Stops the encode queue before the process exits: a running job is cancelled, its tools are waited for, and it is
 * saved as interrupted, so it can be retried on the next start. A second Ctrl-C meanwhile quits at once, since the
 * first one took the only signal listener.
 */
async function stopRunning(runner: ReturnType<typeof startJobRunner>): Promise<void> {
  const line = stoppingLine(runner.waitingFor());
  if (line !== null) console.log(line);
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
  const dataDir = appDataDir();
  const context: AppContext = { dataDir, token, webDir, tools, sources: createSources(process.env, fetch), roots: [], nas: { client: await NasClient.load(dataDir) } };
  const server = await startHelperServer(context, port);
  const runner = startJobRunner(context);
  await runner.ready;
  if (runner.queueElsewhere !== null) {
    console.log(`The encode queue runs in another seikou-encode app (pid ${runner.queueElsewhere}); this helper can't queue encodes.`);
  }
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

/** `nas pair`, `nas status` and `nas unpair`; `extra` counts the positionals after the subcommand. */
async function nasCommand(sub: string | undefined, extra: number, values: { code?: string; base?: string; link?: string }): Promise<void> {
  if (extra > 0) throw new UsageError('expected: nas pair | nas status | nas unpair');
  const dataDir = appDataDir();
  if (sub === 'pair') {
    if (values.link === undefined && (values.code === undefined || values.base === undefined)) throw new UsageError('nas pair needs --code CODE --base URL, or --link URL');
    let paired: Awaited<ReturnType<typeof pairWithNas>>;
    try {
      paired = await pairWithNas(dataDir, values.link === undefined ? { code: values.code, base: values.base } : { link: values.link }, encoderDeviceName());
    } catch (err) {
      // a code or address the encoder or the NAS refuses is for the user to fix; a NAS that does not answer is a failure
      if (err instanceof NasError && (err.code === 'bad-address' || err.code === 'not-owner' || (err.code === 'http' && [400, 401, 404].includes(err.status ?? 0)))) {
        throw new RefusedError(err.message);
      }
      throw err;
    }
    console.log(`Paired with ${hostOf(paired.base)} as ${paired.personName}`);
    return;
  }
  if (sub === 'status') {
    const pairing = await readNasPairing(dataDir);
    console.log(pairing === null ? 'Not paired' : `Paired with ${hostOf(pairing.base)} as ${pairing.personName}`);
    return;
  }
  if (sub === 'unpair') {
    const pairing = await readNasPairing(dataDir);
    await removeNasPairing(dataDir);
    console.log(pairing === null ? 'Not paired' : `Unpaired from ${hostOf(pairing.base)}. The NAS lists this encoder until an owner removes it in Seikou's admin screen.`);
    return;
  }
  throw new UsageError(`unknown nas command "${sub ?? ''}"`);
}

/** The pairing's NAS client, once the NAS has said it knows it. Not paired, or forgotten by the NAS, is a refusal (exit 2). */
async function nasClient(dataDir: string): Promise<NasClient> {
  const client = await NasClient.load(dataDir);
  if (client === null) throw new RefusedError('This encoder is not paired with a NAS. Pair it first: seikou-encode nas pair --code CODE --base URL');
  try {
    await client.me({ signal: AbortSignal.timeout(NAS_ANSWER_MS) });
  } catch (err) {
    client.close();
    if (err instanceof NasError && err.code === 'unauthorized') throw new RefusedError(NAS_FORGOT);
    throw err;
  }
  return client;
}

/** The disc folder of a `plan` or `encode` argument: a folder here, or the mirror of `nas:<key>`, whose id a listing of the NAS gives. */
async function discOfArgument(arg: string, dataDir: string, client: NasClient | null): Promise<string> {
  if (!arg.startsWith(NAS_DISC) || client === null) return resolve(arg);
  const key = arg.slice(NAS_DISC.length);
  const library = new NasLibrary({ dataDir, nas: { client } });
  await library.scan();
  if (library.reachable === false) throw new NasError('unreachable', null, NAS_UNREACHABLE);
  const disc = library.byKey(key);
  if (disc === null) throw new RefusedError(`The NAS has no disc with key ${key}.`);
  return (await ensureMirror(dataDir, client, disc.discId, key)).dir;
}

/**
 * Runs `work` with an abort signal that Ctrl-C (or SIGTERM) sets, so a NAS run lets go of its clips before the process
 * ends; a stopped run rejects with `StoppedError`. A second Ctrl-C quits at once, since the first took the only listener.
 */
async function stoppable<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await work(controller.signal);
  } catch (err) {
    // the tools hear Ctrl-C too, and may fail before the abort reaches the encode
    if (controller.signal.aborted) throw new StoppedError(err instanceof NasUploadFailed ? err : null);
    throw err;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/** The encode options `encodeWithNas` sets the rest of. */
type NasEncodeOptions = Omit<EncodeOptions, 'outDir' | 'signal' | 'onlyEpisodes'>;

/**
 * The data folder's queue lock, which `encode` holds while it works on a NAS disc: clip claims live in one process, so
 * an app running the queue beside it would empty the clips this encode fetched, or rewrite the mirror under it.
 */
function takeQueueLock(dataDir: string): JobsLock {
  const attempt = takeJobsLock(dataDir);
  if ('heldBy' in attempt) {
    throw new QueueElsewhereError(`Another seikou-encode app (pid ${attempt.heldBy}) is using the data folder ${dataDir}; queue this encode there, or stop it first.`);
  }
  return attempt.lock;
}

/**
 * The NAS part of `encode` (see `runNasEpisodes`): each episode encoded on its own, a NAS disc's clips fetched one
 * episode ahead and let go of after, and with `uploadNames` each MKV uploaded and deleted once the NAS has it. Without
 * an output folder the MKVs go to `<data>/nas-out/cli-<8 hex>/`, removed at the end when empty (an MKV whose upload
 * failed stays).
 */
async function encodeWithNas(o: {
  options: NasEncodeOptions;
  dataDir: string;
  outDir: string | undefined;
  client: NasClient;
  discKey: string;
  fromNas: boolean;
  uploadNames: string[] | null;
  episodeCount: number;
  only: number[] | undefined;
}): Promise<void> {
  const dataDir = o.dataDir;
  const id = randomBytes(4).toString('hex');
  const outDir = o.outDir ?? join(dataDir, 'nas-out', `cli-${id}`);
  try {
    await mkdir(outDir, { recursive: true });
    await stoppable((signal) =>
      runNasEpisodes({
        dataDir,
        client: o.client,
        discDir: o.options.discDir,
        discKey: o.discKey,
        playlistId: o.options.playlistId,
        episodeSpec: o.options.episodes,
        episodeCount: o.episodeCount,
        ...(o.only === undefined ? {} : { only: o.only }),
        fetchClips: o.fromNas,
        uploadNames: o.uploadNames,
        holder: `cli:${id}`,
        signal,
        log: (line) => console.log(line),
        encode: async (index) => {
          let path = join(outDir, `${episodeName(o.options.namePattern, index)}.mkv`);
          await encodeEpisodes({ ...o.options, outDir, signal, onlyEpisodes: [index] }, (e) => {
            if (e.kind === 'episode-done' && e.path !== undefined) path = e.path;
            printEncodeEvent(e);
          });
          return path;
        },
      }),
    );
  } finally {
    if (o.outDir === undefined) await rmdir(outDir).catch(() => undefined);
  }
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
      only: { type: 'string' },
      'no-subtitles': { type: 'boolean' },
      'no-pgs': { type: 'boolean' },
      web: { type: 'string' },
      nas: { type: 'boolean' },
      code: { type: 'string' },
      base: { type: 'string' },
      link: { type: 'string' },
    },
  });
  const [command, disc] = positionals;
  if (command === 'nas') {
    await nasCommand(disc, positionals.length - 2, values);
    return;
  }
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

  const onNas = disc.startsWith(NAS_DISC);

  if (command === 'plan') {
    const dataDir = appDataDir();
    const client = onNas ? await nasClient(dataDir) : null;
    let dir: string;
    try {
      dir = await discOfArgument(disc, dataDir, client);
    } finally {
      client?.close();
    }
    if (values.playlist === undefined) {
      for (const p of await listPlaylists(dir)) {
        console.log(`${p.id}  ${mmss(p.duration45)}  ${p.clipIds.join(',')}`);
      }
      return;
    }
    const playlist = await loadPlaylist(dir, values.playlist);
    for (const c of playlist.chapters) {
      const clip = playlist.items[c.itemIndex]?.clipId ?? '';
      console.log(`${String(c.index).padStart(2)}  ${mmssmmm(c.start45)}  ${clip}`);
    }
    return;
  }

  if (command === 'encode') {
    if (values.playlist === undefined) throw new UsageError('--playlist is required');
    if (values.episodes === undefined) throw new UsageError('--episodes is required');
    const toNas = values.nas === true;
    if (!toNas && values.out === undefined) throw new UsageError('--out (or --nas) is required');
    // the NAS's Encodes library plays the MKV itself
    if (toNas && values.web !== undefined) throw new UsageError('--web does not go with --nas');
    const cacheDir = bestsourceCacheDir(values.cache);
    const opusBitrate =
      values['opus-bitrate'] === undefined ? undefined : intOption(values['opus-bitrate'], 'opus-bitrate');
    const crf = values.crf === undefined ? 25 : intOption(values.crf, 'crf');
    const preset = values.preset === undefined ? 4 : intOption(values.preset, 'preset');
    const filmGrain = values['film-grain'] === undefined ? 4 : intOption(values['film-grain'], 'film-grain');
    const dataDir = appDataDir();
    const client = onNas || toNas ? await nasClient(dataDir) : null;
    let lock: JobsLock | null = null;
    try {
      lock = onNas ? takeQueueLock(dataDir) : null;
      const discDir = await discOfArgument(disc, dataDir, client);
      // A bad episode spec is a usage error (exit 2) whether or not the tools are installed.
      const playlist = await loadPlaylist(discDir, values.playlist);
      const episodeCount = parseEpisodeSpec(values.episodes, playlist.chapters.length).length;
      const only = values.only === undefined ? undefined : parseOnly(values.only, episodeCount);
      // So are missing episode titles for the NAS, and a saved record that does not fit this encode.
      let uploadNames: string[] | null = null;
      const discKey = client === null ? '' : (await discKeyOfFolder(discDir)).key;
      if (toNas) {
        const checked = await checkNasDestination({ dataDir, client, discKey, playlistId: values.playlist, episodeSpec: values.episodes, chapters: playlist.chapters.length, only });
        if (!checked.reachable) throw new NasError('unreachable', null, NAS_UNREACHABLE);
        uploadNames = checked.pairs.map(uploadNameOf);
      }
      const noSubtitles = values['no-subtitles'] === true;
      const record = await loadEncodeRecord({ discDir, playlistId: values.playlist, episodeSpec: values.episodes, dataDir, noSubtitles });
      const tools = findTools();
      const options: NasEncodeOptions = {
        discDir,
        playlistId: values.playlist,
        episodes: values.episodes,
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
      };
      const outDir = values.out === undefined ? undefined : resolve(values.out);
      if (client === null) await encodeEpisodes({ ...options, outDir: outDir!, onlyEpisodes: only }, printEncodeEvent);
      else await encodeWithNas({ options, outDir, dataDir, client, discKey, fromNas: onNas, uploadNames, episodeCount, only });
    } finally {
      lock?.release();
      client?.close();
    }
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
 * file that is not a readable Matroska file with an AV1 track, too; `app`, and `encode` of a NAS disc, when another
 * process runs the data folder's encode queue; a NAS that does not answer, a failed fetch or upload, a stop with
 * Ctrl-C), 2 usage error, bad episode list or a saved record that does not fit the encode (another playlist or episode
 * list, or an episode with no audio stream ticked), not paired or a refused pairing, an unknown `nas:` key, or an
 * encode the NAS can't take (see `checkNasDestination`), 3 required tools missing (or, for `serve` and `app`, the page not built). Output goes to stdout and stderr; nothing
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
    if (err instanceof RecordMismatchError || err instanceof NoAudioChosenError || err instanceof RefusedError || err instanceof NasDestinationError) {
      console.error(err.message);
      return 2;
    }
    if (err instanceof NasUploadFailed || err instanceof NasError || err instanceof FetchError || err instanceof UploadError || err instanceof StoppedError) {
      console.error(nasRunFailure(err));
      return 1;
    }
    if (err instanceof MkvReadError || err instanceof WebmError || err instanceof PackageError || err instanceof SupError) {
      console.error(`Packaging failed: ${err.message}`);
      return 1;
    }
    if (err instanceof MissingSubtitleFilesError) {
      console.error(err.message);
      return 1;
    }
    if (err instanceof QueueElsewhereError) {
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
