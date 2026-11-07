// SPDX-License-Identifier: LGPL-3.0-or-later
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listPlaylists, loadPlaylist } from './disc/playlist';
import { encodeEpisodes } from './encode';
import { ChainError } from './pipeline/chain';
import { EpisodeSpecError, parseEpisodeSpec } from './plan/episodes';
import { findTools, ToolsError } from './tools';

class UsageError extends Error {}

const USAGE = `Usage:
  seikou-encode plan <disc> [--playlist ID]
  seikou-encode encode <disc> --playlist ID --episodes SPEC --out DIR
      [--name PATTERN] [--crf N] [--preset N] [--svt-args "..."] [--opus-bitrate N] [--title T]`;

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
      'svt-args': { type: 'string' },
      'opus-bitrate': { type: 'string' },
      title: { type: 'string' },
    },
  });
  const [command, disc] = positionals;
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
    const cacheDir = join(outDir, '.cache', 'bestsource');
    const opusBitrate =
      values['opus-bitrate'] === undefined ? undefined : intOption(values['opus-bitrate'], 'opus-bitrate');
    const crf = values.crf === undefined ? 25 : intOption(values.crf, 'crf');
    const preset = values.preset === undefined ? 4 : intOption(values.preset, 'preset');
    // A bad episode spec is a usage error (exit 2) whether or not the tools are installed.
    const playlist = await loadPlaylist(resolve(disc), values.playlist);
    parseEpisodeSpec(values.episodes, playlist.chapters.length);
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
        extraSvtArgs: (values['svt-args'] ?? '').split(/\s+/).filter((a) => a !== ''),
        opusBitrate,
        cacheDir,
        tools,
        title: values.title,
      },
      (e) => {
        if (e.kind === 'episode-done') console.log(`Episode ${e.episode} done: ${e.path ?? ''}`);
        else if (e.kind === 'episode-start') console.log(e.message);
        else console.error(e.message);
      },
    );
    return;
  }

  throw new UsageError(`unknown command "${command ?? ''}"`);
}

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
