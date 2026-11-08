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
import { loadEncodeRecord } from './subs/encode-record';
import { parseEpisodeSpec, planEpisodes } from './plan/episodes';

/** Everything `encodeEpisodes` needs. */
export interface EncodeOptions {
  /** The decrypted disc folder, or its BDMV folder. */
  discDir: string;
  /** Five-digit playlist id, for example `00000`. */
  playlistId: string;
  /** Chapter ranges, one episode each, in the syntax `parseEpisodeSpec` takes (`1-3,4-6`). */
  episodes: string;
  /** Created if missing. Existing files of the same name are overwritten. */
  outDir: string;
  /** `{n}` is replaced by the episode index zero-padded to 2. Default 'episode-{n}'. */
  namePattern: string;
  /** SVT-AV1 constant rate factor; lower is higher quality and larger. */
  crf: number;
  /** SVT-AV1 preset; lower is slower and more efficient. */
  preset: number;
  /** Appended last to SVT-AV1's arguments, so they override the defaults. */
  extraSvtArgs: string[];
  /** Opus bitrate in kb/s; by default 160 for stereo or less and 320 above. */
  opusBitrate?: number;
  /** Where BestSource keeps its index files; created if missing and reused between runs. */
  cacheDir: string;
  tools: ToolPaths;
  /** Written to the MKV's Info element as the segment title. */
  title?: string;
  /** The app data directory, where the helper's saved subtitle records and fetched files live. */
  dataDir: string;
  /** Ignore the helper's saved record and encode without its subtitle choices. */
  noSubtitles: boolean;
  /** Leave the disc's PG subtitle streams out of the MKV. */
  noPgs: boolean;
  /** When set, each finished episode is also packaged for the web player into a folder of its name under this directory. */
  webDir?: string;
}

/** Progress notification passed to the callback of `encodeEpisodes`. */
export interface EncodeEvent {
  kind: 'episode-start' | 'episode-done' | 'log';
  /** 1-based episode number. */
  episode: number;
  message: string;
  /** The episode's output file, for `episode-start` and `episode-done`. */
  path?: string;
}

/**
 * SVT-AV1 command-line arguments for one encode: the quality knobs from `o`, the encoder's
 * defaults for anime, and `o.extraSvtArgs` last. Colour is tagged as BT.709 limited range
 * (primaries, transfer and matrix 1, range 0) because Blu-ray video is, and `--keyint -2` lets
 * SVT-AV1 pick the key-frame interval (about five seconds).
 */
export function svtArgs(o: Pick<EncodeOptions, 'crf' | 'preset' | 'extraSvtArgs'>): string[] {
  return [
    '--preset', String(o.preset),
    '--crf', String(o.crf),
    '--enable-variance-boost', '1',
    '--tf-strength', '1',
    '--film-grain', '4',
    // From JET's base list for anime. Sharpness 1 raises the deblocking filter's sharpness, which the
    // JET guide reports as a conservative gain in efficiency and perceived quality. Luma bias 25 gives
    // dark frames more bits, since SVT-AV1 underspends on them; it is unsuited to PQ (HDR10) sources,
    // which this encoder does not take.
    '--sharpness', '1',
    '--luminance-qp-bias', '25',
    // Quantisation matrices with a lower floor: both JET and Codec Wiki recommend them for efficiency.
    '--enable-qm', '1',
    '--qm-min', '0',
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

/**
 * opusenc arguments: bitrate in kb/s (the default depends on the channel count) and
 * `--ignorelength`, which makes opusenc read a WAV stream of unknown length from a pipe.
 */
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

/**
 * Cuts and encodes each requested episode of a playlist into `<outDir>/<name>.mkv`, one at a time,
 * and returns the output paths. Video and audio are encoded through pipes (see `pipeline/chain`)
 * and muxed as they arrive, so no intermediate files are written beyond two small scripts in a
 * temporary folder. Uses the first audio stream of the playlist. On failure the episode's
 * partial file is deleted and the error thrown is the failing tool's `ChainError` when there is
 * one (a downstream parse error is usually its symptom); episodes already finished are kept.
 * Throws `EpisodeSpecError` for a bad episode list.
 */
export async function encodeEpisodes(
  o: EncodeOptions,
  onEvent: (e: EncodeEvent) => void,
): Promise<string[]> {
  const playlist = await loadPlaylist(resolve(o.discDir), o.playlistId);
  const specs = parseEpisodeSpec(o.episodes, playlist.chapters.length);
  // The record is checked before anything is planned; later steps read the subtitle choices from it.
  const record = await loadEncodeRecord({
    discDir: resolve(o.discDir),
    playlistId: o.playlistId,
    episodeSpec: o.episodes,
    dataDir: o.dataDir,
    noSubtitles: o.noSubtitles,
  });
  void record;
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
