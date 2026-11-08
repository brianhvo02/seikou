// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { episodePgsTracks } from './disc/pgs';
import { loadPlaylist } from './disc/playlist';
import { readPlaylistPmts } from './disc/pmt';
import { probeClip, type ClipProbe } from './disc/probe';
import { writeMkv } from './mux/mkv-writer';
import { readIvf } from './mux/ivf';
import { readOggOpus } from './mux/ogg';
import { audioChain, ChainError, videoChain, type Chain, type ToolPaths } from './pipeline/chain';
import { buildAudioScript, buildVideoScript } from './pipeline/vpy';
import { WavGuardError } from './pipeline/wav-guard';
import { loadEncodeRecord, NoAudioChosenError } from './subs/encode-record';
import { selectAudio, type SelectedAudio } from './plan/audio-streams';
import { parseEpisodeSpec, planEpisodes, type EpisodePlan } from './plan/episodes';
import type { RecordMetadata } from './subs/record';

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

/** A chain's own failure: a tool's `ChainError` or the audio guard's `WavGuardError`, not a reader's symptom of one. */
function isChainFailure(e: unknown): e is ChainError | WavGuardError {
  return e instanceof ChainError || e instanceof WavGuardError;
}

/** After a failure, prefer a chain's own failure over a downstream parse error it caused. */
function chainFailure(chains: Chain[]): Promise<ChainError | WavGuardError | null> {
  // A healthy chain is drained and its output discarded: the episode is failing anyway.
  // The failed reader's async iterator leaves a 'readable' listener behind, which makes resume() a no-op.
  for (const c of chains) {
    c.stream.removeAllListeners('readable');
    c.stream.resume();
  }
  return new Promise((res) => {
    let pending = chains.length;
    const timer = setTimeout(() => res(null), SETTLE_TIMEOUT_MS);
    const finish = (e: ChainError | WavGuardError | null): void => {
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
          if (isChainFailure(e)) finish(e);
          else if (--pending === 0) finish(null);
        },
      );
    }
  });
}

/**
 * Cuts and encodes each requested episode of a playlist into `<outDir>/<name>.mkv`, one at a time,
 * and returns the output paths. Video and every chosen audio stream are encoded through pipes (see
 * `pipeline/chain`), one independent chain per stream, and muxed as they arrive, so no intermediate
 * files are written beyond small scripts in a temporary folder. The audio streams and their labels
 * come from `selectAudio`: the helper's saved record when there is one (its order, ticks, names and
 * languages; a stream it does not list is left out with a `log` event), else every audio stream of
 * the playlist in STN order; each becomes an Opus track (160 kb/s up to two channels, 320 above,
 * `opusBitrate` for all when set). The video track takes the record's name and language when there
 * is a record. The disc's PG subtitle streams follow as `S_HDMV/PGS` tracks (`episodePgsTracks`) unless
 * `noPgs` is set. Every episode is planned before the first is encoded. When any chain fails the others
 * are stopped, the episode's partial file is deleted and the error thrown is the chain's own
 * (`ChainError` from a tool, `WavGuardError` when a decoded stream's channels or rate differ from the
 * playlist's) when there is one, since a downstream parse error is usually its symptom; episodes
 * already finished are kept. Throws `EpisodeSpecError` for a bad episode list, and `NoAudioChosenError`, before
 * any tool starts, when the record leaves an episode with no audio stream.
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
  const probes = new Map<string, ClipProbe>();
  for (const item of playlist.items) {
    if (!probes.has(item.clipId)) probes.set(item.clipId, await probeClip(item));
  }
  // Each episode keeps its own audio streams (a record can tick different ones per episode), so each is planned alone.
  const pmts = await readPlaylistPmts(playlist);
  const episodes = specs.map((spec, i): { plan: EpisodePlan; audio: SelectedAudio[]; metadata: RecordMetadata | null } => {
    const index = i + 1;
    const audio = selectAudio(playlist, probes, record, index, (message) => onEvent({ kind: 'log', episode: index, message }));
    // The record's ticked streams may all be missing from the playlist; an episode is never encoded without sound.
    if (record !== null && audio.length === 0) throw new NoAudioChosenError(index);
    const [plan] = planEpisodes(playlist, probes, [spec], audio, pmts);
    const metadata = record?.episodes.find((e) => e.index === index)?.metadata ?? null;
    return { plan: { ...plan!, index }, audio, metadata };
  });

  await mkdir(o.outDir, { recursive: true });
  const cacheDir = resolve(o.cacheDir);
  await mkdir(cacheDir, { recursive: true });

  const outputs: string[] = [];
  for (const { plan, audio, metadata } of episodes) {
    const name = o.namePattern.replaceAll('{n}', String(plan.index).padStart(2, '0'));
    const outPath = join(o.outDir, `${name}.mkv`);
    onEvent({ kind: 'episode-start', episode: plan.index, message: `Encoding episode ${plan.index}`, path: outPath });

    // Read before any tool starts: the PG streams come straight from the disc and need no cleanup when they fail.
    const pgs = o.noPgs ? [] : await episodePgsTracks(plan, playlist, (message) => onEvent({ kind: 'log', episode: plan.index, message }));
    const tmp = await mkdtemp(join(tmpdir(), 'encoding-tools-'));
    const chains: Chain[] = [];
    try {
      const videoScript = join(tmp, 'video.vpy');
      await writeFile(videoScript, buildVideoScript(plan, { cacheDir }));
      const audioScripts = audio.map((_, i) => join(tmp, `audio-${i + 1}.vpy`));
      for (const [i, script] of audioScripts.entries()) await writeFile(script, buildAudioScript(plan, { cacheDir }, i));

      // Every chain starts before any reader awaits, and each audio stream has its own: the writer pulls
      // the tracks in timestamp order, and one producer feeding several pipes would stall on whichever
      // pipe the writer is not reading. A failure in any chain stops the others at once.
      const video = videoChain(o.tools, videoScript, svtArgs(o));
      chains.push(video);
      const audioChains = audio.map((a, i) => {
        const chain = audioChain(o.tools, audioScripts[i]!, opusArgs(a.channels, o.opusBitrate), a);
        chains.push(chain);
        return chain;
      });
      for (const c of chains) {
        c.done.catch((e: unknown) => {
          for (const other of chains) if (other !== c) other.abort(e instanceof Error ? e : new Error(String(e)));
        });
      }

      // Every reader must attach before any await: Node discards the unread stdout of a child that
      // exits while nobody is reading, which would lose a short audio stream while video starts up.
      const [ivf, ...oggs] = await Promise.all([readIvf(video.stream), ...audioChains.map((c) => readOggOpus(c.stream))]);
      const seq = await ivf.sequenceHeader;
      await writeMkv(outPath, {
        title: o.title,
        video: {
          width: plan.video.width,
          height: plan.video.height,
          fpsNum: plan.video.fpsNum,
          fpsDen: plan.video.fpsDen,
          codecPrivate: seq.av1C,
          name: metadata?.video.name ?? '',
          language: metadata?.video.language || 'und',
          isDefault: true,
        },
        videoPackets: ivf.packets,
        audio: oggs.map((ogg, i) => ({
          channels: ogg.head.channels,
          sampleRate: 48000,
          codecPrivate: ogg.head.raw,
          codecDelayNs: (BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n,
          seekPreRollNs: 80_000_000n,
          name: audio[i]!.name,
          language: audio[i]!.language,
          isDefault: audio[i]!.isDefault,
          packets: ogg.packets,
          end: ogg.end,
        })),
        subtitles: pgs,
        attachments: [],
        chapters: plan.chapters,
      });
      await Promise.all(chains.map((c) => c.done));
    } catch (err) {
      const toolError = isChainFailure(err) ? null : await chainFailure(chains);
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
