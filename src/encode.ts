// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPlaylist } from './disc/playlist';
import { probeClip, type ClipProbe } from './disc/probe';
import { writeMkv } from './mux/mkv-writer';
import { readIvf } from './mux/ivf';
import { readOggOpus } from './mux/ogg';
import { audioChain, ChainError, videoChain, type Chain, type ToolPaths } from './pipeline/chain';
import { buildAudioScript, buildVideoScript } from './pipeline/vpy';
import { parseEpisodeSpec, planEpisodes } from './plan/episodes';

export interface EncodeOptions {
  discDir: string;
  playlistId: string;
  episodes: string;
  outDir: string;
  /** `{n}` is replaced by the episode index zero-padded to 2. Default 'episode-{n}'. */
  namePattern: string;
  crf: number;
  preset: number;
  extraSvtArgs: string[];
  opusBitrate?: number;
  cacheDir: string;
  tools: ToolPaths;
  title?: string;
}

export interface EncodeEvent {
  kind: 'episode-start' | 'episode-done' | 'log';
  episode: number;
  message: string;
  path?: string;
}

export function svtArgs(o: Pick<EncodeOptions, 'crf' | 'preset' | 'extraSvtArgs'>): string[] {
  return [
    '--preset', String(o.preset),
    '--crf', String(o.crf),
    '--enable-variance-boost', '1',
    '--tf-strength', '1',
    '--film-grain', '4',
    '--tile-columns', '1',
    '--keyint', '-2',
    '--color-primaries', '1',
    '--transfer-characteristics', '1',
    '--matrix-coefficients', '1',
    '--color-range', '0',
    '--progress', '0',
    ...o.extraSvtArgs,
  ];
}

export function opusArgs(channels: number, bitrate?: number): string[] {
  return ['--bitrate', String(bitrate ?? (channels <= 2 ? 160 : 320)), '--ignorelength'];
}

const SETTLE_TIMEOUT_MS = 5000;

/** After a failure, prefer the tool's own ChainError over a downstream parse error it caused. */
function chainFailure(chains: Chain[]): Promise<ChainError | null> {
  // A healthy chain is drained and its output discarded: the episode is failing anyway.
  // The failed reader's async iterator leaves a 'readable' listener behind, which makes resume() a no-op.
  for (const c of chains) {
    c.stream.removeAllListeners('readable');
    c.stream.resume();
  }
  return new Promise((res) => {
    let pending = chains.length;
    const timer = setTimeout(() => res(null), SETTLE_TIMEOUT_MS);
    const finish = (e: ChainError | null): void => {
      clearTimeout(timer);
      res(e);
    };
    if (pending === 0) finish(null);
    for (const c of chains) {
      c.done.then(
        () => {
          if (--pending === 0) finish(null);
        },
        (e: unknown) => {
          if (e instanceof ChainError) finish(e);
          else if (--pending === 0) finish(null);
        },
      );
    }
  });
}

export async function encodeEpisodes(
  o: EncodeOptions,
  onEvent: (e: EncodeEvent) => void,
): Promise<string[]> {
  const playlist = await loadPlaylist(resolve(o.discDir), o.playlistId);
  const specs = parseEpisodeSpec(o.episodes, playlist.chapters.length);
  const probes = new Map<string, ClipProbe>();
  for (const item of playlist.items) {
    if (!probes.has(item.clipId)) probes.set(item.clipId, await probeClip(item));
  }
  const audioPid = playlist.items[0]?.audioPids[0];
  if (audioPid === undefined) throw new Error(`Playlist ${o.playlistId} has no audio stream`);
  const plans = planEpisodes(playlist, probes, specs, audioPid);

  await mkdir(o.outDir, { recursive: true });
  const cacheDir = resolve(o.cacheDir);
  await mkdir(cacheDir, { recursive: true });

  const outputs: string[] = [];
  for (const plan of plans) {
    const name = o.namePattern.replaceAll('{n}', String(plan.index).padStart(2, '0'));
    const outPath = join(o.outDir, `${name}.mkv`);
    onEvent({ kind: 'episode-start', episode: plan.index, message: `Encoding episode ${plan.index}`, path: outPath });

    const tmp = await mkdtemp(join(tmpdir(), 'encoding-tools-'));
    const chains: Chain[] = [];
    try {
      const videoScript = join(tmp, 'video.vpy');
      const audioScript = join(tmp, 'audio.vpy');
      await writeFile(videoScript, buildVideoScript(plan, { cacheDir }));
      await writeFile(audioScript, buildAudioScript(plan, { cacheDir }));
      const video = videoChain(o.tools, videoScript, svtArgs(o));
      chains.push(video);
      const audio = audioChain(o.tools, audioScript, opusArgs(plan.audio.channels, o.opusBitrate));
      chains.push(audio);

      // Both readers must attach before either await: Node discards the unread stdout of a child that
      // exits while nobody is reading, which would lose a short audio stream while video starts up.
      const [ivf, ogg] = await Promise.all([readIvf(video.stream), readOggOpus(audio.stream)]);
      const seq = await ivf.sequenceHeader;
      await writeMkv(outPath, {
        title: o.title,
        video: {
          width: plan.video.width,
          height: plan.video.height,
          fpsNum: plan.video.fpsNum,
          fpsDen: plan.video.fpsDen,
          codecPrivate: seq.av1C,
        },
        audio: {
          channels: ogg.head.channels,
          sampleRate: 48000,
          codecPrivate: ogg.head.raw,
          codecDelayNs: (BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n,
          seekPreRollNs: 80_000_000n,
          language: 'und',
        },
        videoPackets: ivf.packets,
        audioPackets: ogg.packets,
        audioEnd: ogg.end,
        chapters: plan.chapters,
      });
      await Promise.all([video.done, audio.done]);
    } catch (err) {
      const toolError = err instanceof ChainError ? null : await chainFailure(chains);
      for (const c of chains) c.abort(err instanceof Error ? err : new Error(String(err)));
      await unlink(outPath).catch(() => {});
      await rm(tmp, { recursive: true, force: true });
      throw toolError ?? err;
    }
    await rm(tmp, { recursive: true, force: true });
    outputs.push(outPath);
    onEvent({ kind: 'episode-done', episode: plan.index, message: `Finished episode ${plan.index}`, path: outPath });
  }
  return outputs;
}
