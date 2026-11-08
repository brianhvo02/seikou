// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { episodePgsTracks } from './disc/pgs';
import { loadPlaylist } from './disc/playlist';
import { readPlaylistPmts } from './disc/pmt';
import { probeClip, type ClipProbe } from './disc/probe';
import { writeMkv } from './mux/mkv-writer';
import { packageEpisode } from './package/package';
import { readIvf } from './mux/ivf';
import { readOggOpus } from './mux/ogg';
import { audioChain, ChainError, videoChain, type Chain, type ToolPaths } from './pipeline/chain';
import { buildAudioScript, buildVideoScript } from './pipeline/vpy';
import { WavGuardError } from './pipeline/wav-guard';
import { loadEncodeRecord, NoAudioChosenError } from './subs/encode-record';
import { episodeSubtitleTracks, recordFontLoader } from './subs/episode-subtitles';
import { selectAudio, type SelectedAudio } from './plan/audio-streams';
import { EpisodeSpecError, parseEpisodeSpec, planEpisodes, type EpisodePlan } from './plan/episodes';
import type { RecordMetadata, SubtitleRecord } from './subs/record';

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
  /** Every `{n}` is replaced by the episode index zero-padded to 2 (see `episodeName`). Default 'episode-{n}'. */
  namePattern: string;
  /** SVT-AV1 constant rate factor; lower is higher quality and larger. */
  crf: number;
  /** SVT-AV1 preset; lower is slower and more efficient. */
  preset: number;
  /** SVT-AV1 film-grain synthesis level (`--film-grain`), 0 to 50; the command line uses 4. */
  filmGrain: number;
  /** Appended last to SVT-AV1's arguments, so they override the defaults. */
  extraSvtArgs: string[];
  /** Opus bitrate in kb/s; by default 160 for stereo or less and 320 above. */
  opusBitrate?: number;
  /** Where BestSource keeps its index files; created if missing and reused between runs. */
  cacheDir: string;
  tools: ToolPaths;
  /** Written to the MKV's Info element as the segment title when the record names none for the episode. */
  title?: string;
  /** The app data directory, where the helper's saved subtitle records and fetched files live. */
  dataDir: string;
  /** Ignore the helper's saved record and encode without its subtitle choices. */
  noSubtitles: boolean;
  /**
   * The record to follow, already loaded and checked by `loadEncodeRecord`: a caller that loaded it passes it so the
   * encode uses exactly what it checked, and `null` means no record. When left out, `encodeEpisodes` loads it itself
   * (honouring `noSubtitles`).
   */
  record?: SubtitleRecord | null;
  /** Leave the disc's PG subtitle streams out of the MKV. */
  noPgs: boolean;
  /**
   * When set, each episode is packaged for the web player (`packageEpisode`) into `<webDir>/<name>/`
   * as soon as its MKV is complete. A packaging failure stops the run with the MKV kept and no
   * partial directory left.
   */
  webDir?: string;
  /** Aborts the encode: every tool of every running chain is stopped and has exited, the partial file is removed, and `encodeEpisodes` then rejects with an `AbortError`. A signal that is already aborted rejects before anything starts. */
  signal?: AbortSignal;
  /** 1-based episode numbers, as the episode list numbers them, to encode; the others are skipped. Output names still follow the full list's numbering. All episodes when left out. */
  onlyEpisodes?: readonly number[];
  /** Cut only each episode's first audio stream (a test sample's choice). */
  onlyFirstAudio?: boolean;
  /** The clock, in milliseconds, that paces `progress` events. Default `Date.now`. */
  now?: () => number;
}

/** Progress notification passed to the callback of `encodeEpisodes`. */
export interface EncodeEvent {
  kind: 'episode-start' | 'episode-done' | 'log' | 'progress' | 'packaged' | 'package-failed';
  /** 1-based episode number. */
  episode: number;
  /** For `package-failed`, the error's message. */
  message: string;
  /** The episode's output file, for `episode-start` and `episode-done`; the package directory for `packaged`. */
  path?: string;
  /** For `progress`: video frames written so far. At most one event a second per episode, and a last one with `framesDone` equal to `frames` when the episode is complete. */
  framesDone?: number;
  /** For `progress`: the episode's video frames in all. */
  frames?: number;
}

/**
 * SVT-AV1 command-line arguments for one encode: the quality knobs from `o`, the encoder's
 * defaults for anime, and `o.extraSvtArgs` last. Colour is tagged as BT.709 limited range
 * (primaries, transfer and matrix 1, range 0) because Blu-ray video is, and `--keyint -2` lets
 * SVT-AV1 pick the key-frame interval (about five seconds).
 */
export function svtArgs(o: Pick<EncodeOptions, 'crf' | 'preset' | 'filmGrain' | 'extraSvtArgs'>): string[] {
  return [
    '--preset', String(o.preset),
    '--crf', String(o.crf),
    '--enable-variance-boost', '1',
    '--tf-strength', '1',
    '--film-grain', String(o.filmGrain),
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

/** An episode's output name without its extension: every `{n}` in `pattern` becomes `index` zero-padded to two digits. */
export function episodeName(pattern: string, index: number): string {
  return pattern.replaceAll('{n}', String(index).padStart(2, '0'));
}

const SETTLE_TIMEOUT_MS = 5000;
const PROGRESS_INTERVAL_MS = 1000;

/** The error an aborted encode rejects with: named `AbortError`, as the platform's own aborts are. */
function abortError(): Error {
  return new DOMException('The encode was aborted', 'AbortError');
}

/** `packets` as they are, calling `onPacket` after each one has been taken by the consumer. */
async function* counting<T>(packets: AsyncIterable<T>, onPacket: () => void): AsyncGenerator<T> {
  for await (const packet of packets) {
    yield packet;
    onPacket();
  }
}

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
 * is a record. The MKV's title is the record's episode title, else `title`; chapter titles are the record's, else
 * `Chapter n`. With a record, its ticked ASS tracks (retimed by the saved shift or split and the nudge) and fonts
 * are muxed after the audio (`episodeSubtitleTracks`), then the disc's PG subtitle streams as `S_HDMV/PGS` tracks
 * (`episodePgsTracks`) unless `noPgs` is set. `record` is read once: the CLI passes the one it checked, so what is
 * encoded cannot change in between. Every episode is planned before the first is encoded. When any chain fails the others
 * are stopped, the episode's partial file is deleted and the error thrown is the chain's own
 * (`ChainError` from a tool, `WavGuardError` when a decoded stream's channels or rate differ from the
 * playlist's) when there is one, since a downstream parse error is usually its symptom; episodes
 * already finished are kept. With `webDir`, each complete MKV is then packaged into `<webDir>/<name>/`
 * (`packageEpisode`, followed by a `log` event); its errors stop the run, the MKV kept. Throws `EpisodeSpecError` for a bad episode list, and, before any tool starts, `NoAudioChosenError` when the record leaves an episode with no audio stream, and any
 * error from reading or decoding a subtitle track of any episode.
 *
 * Each episode is written to `<name>.mkv.partial` and renamed to `<name>.mkv` once complete, so an earlier file of that
 * name survives a failed run; a failure of any kind removes the partial file. `progress` events count the video
 * packets written (see `EncodeEvent`). With `onlyEpisodes` only those episodes are encoded, named as in the full list.
 * `signal` aborts the run (see `EncodeOptions.signal`). With `webDir`, a `packaged` event follows each package and a
 * failed one sends `package-failed` first, then throws as before, with the MKV kept.
 */
export async function encodeEpisodes(
  o: EncodeOptions,
  onEvent: (e: EncodeEvent) => void,
): Promise<string[]> {
  const isAborted = (): boolean => o.signal?.aborted === true;
  if (isAborted()) throw abortError();
  const now = o.now ?? Date.now;
  const playlist = await loadPlaylist(resolve(o.discDir), o.playlistId);
  const specs = parseEpisodeSpec(o.episodes, playlist.chapters.length);
  if (o.onlyEpisodes?.length === 0) throw new EpisodeSpecError('onlyEpisodes is empty; leave it out to encode every episode');
  for (const n of o.onlyEpisodes ?? []) {
    if (!Number.isInteger(n) || n < 1 || n > specs.length) throw new EpisodeSpecError(`Episode ${String(n)} is not in the episode list, which has ${specs.length}`);
  }
  const wanted = (index: number): boolean => o.onlyEpisodes === undefined || o.onlyEpisodes.includes(index);
  // The record is checked before anything is planned; later steps read the subtitle choices from it, and only from this one read.
  const record =
    o.record !== undefined
      ? o.record
      : await loadEncodeRecord({
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
  const episodes = specs.flatMap((spec, i): { plan: EpisodePlan; audio: SelectedAudio[]; metadata: RecordMetadata | null }[] => {
    const index = i + 1;
    if (!wanted(index)) return [];
    const chosen = selectAudio(playlist, probes, record, index, (message) => onEvent({ kind: 'log', episode: index, message }));
    // The record's ticked streams may all be missing from the playlist; an episode is never encoded without sound.
    if (record !== null && chosen.length === 0) throw new NoAudioChosenError(index);
    const audio = o.onlyFirstAudio === true ? chosen.slice(0, 1) : chosen;
    const [plan] = planEpisodes(playlist, probes, [spec], audio, pmts);
    const metadata = record?.episodes.find((e) => e.index === index)?.metadata ?? null;
    return [{ plan: { ...plan!, index }, audio, metadata }];
  });

  // Every episode's subtitles are built before the first encode, so an unreadable or undecodable track fails now and not after hours of encoding.
  const subtitles = new Map<number, Awaited<ReturnType<typeof episodeSubtitleTracks>>>();
  if (record !== null) {
    // One loader for every episode: the fonts are read once and every episode's MKV attaches the same copies.
    const fonts = recordFontLoader(record, o.dataDir);
    for (const { plan } of episodes) subtitles.set(plan.index, await episodeSubtitleTracks(record, plan.index, Number(plan.durationNs / 1_000_000n), o.dataDir, fonts));
  }

  if (isAborted()) throw abortError();
  await mkdir(o.outDir, { recursive: true });
  const cacheDir = resolve(o.cacheDir);
  await mkdir(cacheDir, { recursive: true });

  const outputs: string[] = [];
  for (const { plan, audio, metadata } of episodes) {
    const name = episodeName(o.namePattern, plan.index);
    const outPath = join(o.outDir, `${name}.mkv`);
    const partialPath = `${outPath}.partial`;
    if (isAborted()) throw abortError();
    onEvent({ kind: 'episode-start', episode: plan.index, message: `Encoding episode ${plan.index}`, path: outPath });

    // Read before any tool starts: the PG streams come straight from the disc and need no cleanup when they fail.
    // ASS tracks come first, then the disc's PGS tracks.
    const ass = subtitles.get(plan.index) ?? { tracks: [], attachments: [] };
    const pgs = o.noPgs ? [] : await episodePgsTracks(plan, playlist, (message) => onEvent({ kind: 'log', episode: plan.index, message }));
    const tmp = await mkdtemp(join(tmpdir(), 'encoding-tools-'));
    const chains: Chain[] = [];
    // The first real failure of a chain: an abort that arrives later does not replace it.
    let chainError: ChainError | WavGuardError | null = null;
    const onAbort = (): void => {
      for (const c of chains) c.abort(abortError());
    };
    try {
      const videoScript = join(tmp, 'video.vpy');
      await writeFile(videoScript, buildVideoScript(plan, { cacheDir }));
      const audioScripts = audio.map((_, i) => join(tmp, `audio-${i + 1}.vpy`));
      for (const [i, script] of audioScripts.entries()) await writeFile(script, buildAudioScript(plan, { cacheDir }, i));

      // The signal is checked again here, after every await that can let it arrive and before any tool starts.
      if (isAborted()) throw abortError();

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
          if (chainError === null && isChainFailure(e)) chainError = e;
          for (const other of chains) if (other !== c) other.abort(e instanceof Error ? e : new Error(String(e)));
        });
      }

      o.signal?.addEventListener('abort', onAbort, { once: true });
      if (isAborted()) onAbort();

      // Every reader must attach before any await: Node discards the unread stdout of a child that
      // exits while nobody is reading, which would lose a short audio stream while video starts up.
      const [ivf, ...oggs] = await Promise.all([readIvf(video.stream), ...audioChains.map((c) => readOggOpus(c.stream))]);
      const seq = await ivf.sequenceHeader;
      let framesDone = 0;
      let lastProgress = now();
      await writeMkv(partialPath, {
        title: metadata?.title || o.title,
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
        videoPackets: counting(ivf.packets, () => {
          framesDone += 1;
          const t = now();
          // The closing event at 100% is sent once the episode is complete.
          if (t - lastProgress < PROGRESS_INTERVAL_MS || framesDone >= plan.frameCount) return;
          lastProgress = t;
          onEvent({ kind: 'progress', episode: plan.index, message: `Episode ${plan.index}: ${framesDone} of ${plan.frameCount} frames`, framesDone, frames: plan.frameCount });
        }),
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
        subtitles: [...ass.tracks, ...pgs],
        attachments: ass.attachments,
        chapters: plan.chapters.map((c, i) => ({ ...c, title: metadata?.chapters[i] || c.title })),
      });
      await Promise.all(chains.map((c) => c.done));
      // A finished file of the same name is replaced only now, by the rename.
      await rename(partialPath, outPath);
    } catch (err) {
      const wasAborted = isAborted() && chainError === null && !isChainFailure(err);
      const toolError = wasAborted || isChainFailure(err) ? null : await chainFailure(chains);
      for (const c of chains) c.abort(err instanceof Error ? err : new Error(String(err)));
      // Leave no process behind: the partial file is removed only once every tool has exited.
      await Promise.all(chains.map((c) => c.exited));
      // The tools are gone; closing the pipes' read ends frees their descriptors.
      for (const c of chains) c.stream.destroy();
      await unlink(partialPath).catch(() => {});
      await rm(tmp, { recursive: true, force: true });
      throw wasAborted ? abortError() : toolError ?? err;
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
    }
    await rm(tmp, { recursive: true, force: true });
    onEvent({ kind: 'progress', episode: plan.index, message: `Episode ${plan.index}: ${plan.frameCount} of ${plan.frameCount} frames`, framesDone: plan.frameCount, frames: plan.frameCount });
    if (isAborted()) throw abortError();
    if (o.webDir !== undefined) {
      // The MKV is complete and kept even when packaging fails: `package` can be run on it again.
      const webPath = join(o.webDir, name);
      try {
        await packageEpisode(outPath, webPath);
      } catch (err) {
        onEvent({ kind: 'package-failed', episode: plan.index, message: err instanceof Error ? err.message : String(err), path: webPath });
        throw err;
      }
      onEvent({ kind: 'packaged', episode: plan.index, message: `Packaged episode ${plan.index}`, path: webPath });
      onEvent({ kind: 'log', episode: plan.index, message: `Packaged episode ${plan.index} into ${webPath}` });
    }
    outputs.push(outPath);
    onEvent({ kind: 'episode-done', episode: plan.index, message: `Finished episode ${plan.index}`, path: outPath });
  }
  return outputs;
}
