import type { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseClpi, type Clpi } from '@seikou/bdmv/clpi-parser';
import { parseMpls, type Mpls, type PlayItem } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import type { DiscManifest } from '@seikou/nas/nas-api';
import type { EncoderCodec } from './capacity';
import type { ClipRunPlan } from './clip-run';
import { fallbackAudioBps } from './audio-core';
import { clpiVideoIsHdr, rewriteClpi } from './clpi-writer';
import { deinterlaces, frameTicks, probeScan, type ClipInput, type ScanInfo } from './encoder';
import { firstAudioBps, type ClipSource, type LevelDiscSource } from './level-discs';
import {
  BUDGET_VERSION,
  SOURCE_PACKET_BYTES,
  coreCoding,
  keptAudioFor,
  levelDefFor,
  levelsFor,
  planClip,
  videoAttrsFor,
  videoEpMap,
  type IntervalPlan,
  type KeptAudio,
  type LevelDef,
  type LevelId,
  type PlanTuning,
} from './levels';
import { rewriteMpls, type VideoAttrs } from './mpls-writer';
import type { GraphicsByNumber } from './remux';
import type { SegmentCache } from './segment-cache';

/** A quality level that re-encodes: every `LevelId` but `original`. */
export type EncodedLevel = Exclude<LevelId, 'original'>;

/** Where a clip's first audio frame is looked for. */
const AUDIO_PROBE_BYTES = 16 * 1024 * 1024;
/** CLPI `format` code → picture lines (libbluray `bd_video_format_e`: 1 480i, 2 576i, 3 480p, 4 1080i, 5 720p, 6 1080p, 7 576p, 8 2160p). */
const FORMAT_LINES: Readonly<Record<number, number>> = { 1: 480, 2: 576, 3: 480, 4: 1080, 5: 720, 6: 1080, 7: 576, 8: 2160 };
/** CLPI `rate` code → frames per second (libbluray `bd_video_rate_e`; an interlaced source is deinterlaced to its frame rate). */
const RATE_FPS: Readonly<Record<number, number>> = { 1: 24_000 / 1001, 2: 24, 3: 25, 4: 30_000 / 1001, 6: 50, 7: 60_000 / 1001 };
const GRAPHICS_CODINGS = new Set<number>([CodingType.PG, CodingType.IG, CodingType.TEXT_SUBTITLE]);

/** A film's output frame rate in frames per second, from its CLPI frame-rate code (29.97 when unknown). */
export function fpsOf(rate: number): number {
  return RATE_FPS[rate] ?? RATE_FPS[4]!;
}

/** A clip's primary video as its CLPI describes it. */
export interface VideoInfo {
  /** The video's transport stream PID. */
  readonly pid: number;
  /** The CLPI `coding_type`, a `CodingType`. */
  readonly codingType: number;
  /** The picture height in lines, from the CLPI `format` code (1080 when the code is unknown). */
  readonly height: number;
  /** CLPI frame-rate code. */
  readonly rate: number;
  /** HEVC with a non-zero dynamic_range_type in the CLPI. */
  readonly hdr: boolean;
}

/** One stream clip of a disc that a level re-encodes. */
export interface ClipInfo {
  /** The 5-digit clip name, such as `00001`. */
  readonly id: string;
  /** The clip's information file in the manifest, `BDMV/CLIPINF/<id>.CLPI`. */
  readonly clpiPath: string;
  /** The clip's stream file in the manifest, `BDMV/STREAM/<id>.M2TS`. */
  readonly m2tsPath: string;
  /** The original CLPI file. */
  readonly clpiBytes: Uint8Array;
  readonly clpi: Clpi;
  readonly video: VideoInfo;
  /**
   * The first main-path play item that plays this clip (playlists in path order, items in order, angle clips included).
   * Its STN picks the clip's kept audio: a clip carries one audio stream at a level, so when play items of several
   * playlists disagree on it (rare: the same stream numbering is the rule), the first one decides and the others' STN
   * names an audio PID the clip doesn't carry.
   */
  readonly item: PlayItem;
}

/** What the level service reads of a disc once and keeps: its manifest, playlists and the clips a level re-encodes. */
export interface DiscInfo {
  /** The library's disc id. */
  readonly id: string;
  readonly source: LevelDiscSource;
  readonly manifest: DiscManifest;
  /** The original size of every file in the manifest by disc-relative path, bytes. */
  readonly sizes: ReadonlyMap<string, number>;
  /** Each readable playlist's path, original bytes, play items and the clip ids those items (and their angles) play. */
  readonly playlists: readonly { readonly path: string; readonly bytes: Uint8Array; readonly items: readonly PlayItem[]; readonly clipIds: readonly string[] }[];
  /** The clips with primary video that a playlist's main path plays: the ones a level re-encodes. */
  readonly clips: ReadonlyMap<string, ClipInfo>;
  /** The largest of them: its video decides the disc's levels, rates and capacity. */
  readonly main: ClipInfo | null;
  /** The kept audio's rate in bits per second of source packets (`audioBpsOf`), by `<clip id>:<PID>`. */
  readonly audioBps: Map<string, Promise<number>>;
  /** The probe of each clip's picture (`scanOf`), by clip id. */
  readonly scans: Map<string, Promise<ScanInfo>>;
}

/** One clip of a version: its plan and the size the version serves. */
export interface ClipVersion {
  readonly info: ClipInfo;
  /** What the clip's encoder and re-mux need (`ClipRunner`). */
  readonly runPlan: ClipRunPlan;
  /** The re-encoded stream file's size in bytes: the sum of the interval budgets. */
  readonly sizeBytes: number;
  /** The source clip's size and mtime the version was built with. */
  readonly stamp: { readonly size: number; readonly mtimeMs: number };
  readonly source: ClipSource;
}

/** A disc at one level and audio stream: another version of the same files. */
export interface Version {
  /** `<disc id>:<level>:<audio>`. */
  readonly key: string;
  readonly disc: DiscInfo;
  /** The codec the level encodes, for the GPU lease. */
  readonly codec: EncoderCodec;
  /** The film's output frame rate, for the GPU lease. */
  readonly fps: number;
  /** The disc's manifest with the version's sizes and rewritten inline files. */
  readonly manifest: DiscManifest;
  /** Every file's size in this version by upper-case disc-relative path, bytes. */
  readonly sizes: ReadonlyMap<string, number>;
  /** CLPI and MPLS files rewritten for the level. */
  readonly rewritten: ReadonlyMap<string, Uint8Array>;
  /** By `.M2TS` path. */
  readonly clips: ReadonlyMap<string, ClipVersion>;
}

/** What `buildVersion` needs besides the disc. */
export interface VersionDeps {
  /** Where encoded intervals are kept, for the cache key. */
  readonly cache: SegmentCache;
  /** Starts ffmpeg; default `child_process.spawn`. */
  readonly spawn?: typeof nodeSpawn;
  /** The scan probe (ffprobe); default `probeScan`. */
  readonly probe?: (input: ClipInput, options: { readonly startByte: number; readonly videoPid: number; readonly signal?: AbortSignal }) => Promise<ScanInfo>;
  /** Receives log lines; default none. */
  readonly log?: (message: string) => void;
  /** Aborted when the service closes: stops a scan probe still running. */
  readonly signal?: AbortSignal;
  /** The encoder backend's id, for the segment cache key. */
  readonly backendId: string;
  /** Injectable for tests whose fixtures' intervals are short: the plan's knobs (`planClip`). */
  readonly planTuning?: Partial<PlanTuning>;
}

async function fileBytes(manifest: DiscManifest, source: LevelDiscSource, path: string): Promise<Uint8Array | null> {
  const inline = manifest.inline[path];
  if (inline !== undefined) return new Uint8Array(Buffer.from(inline, 'base64'));
  return source.readFile(path);
}

/**
 * Reads a disc's playlists and clip information, and finds the clips a level re-encodes. A playlist or CLPI the parsers
 * refuse is skipped, as the player skips it. Throws what `source.manifest()` throws.
 */
export async function loadDisc(id: string, source: LevelDiscSource): Promise<DiscInfo> {
  const manifest = await source.manifest();
  const sizes = new Map(manifest.files.map((f) => [f.path, f.size]));
  const playlists: DiscInfo['playlists'][number][] = [];
  const items = new Map<string, PlayItem>();
  for (const { path } of manifest.files) {
    if (!/^BDMV\/PLAYLIST\/[^/]+\.MPLS$/.test(path)) continue;
    const bytes = await fileBytes(manifest, source, path);
    if (!bytes) continue;
    let mpls: Mpls;
    try {
      mpls = parseMpls(bytes);
    } catch {
      continue; // a playlist the player can't read either
    }
    const clipIds: string[] = [];
    for (const item of mpls.playItems) {
      for (const clipId of [item.clipId, ...item.angleClipIds]) {
        clipIds.push(clipId);
        if (!items.has(clipId)) items.set(clipId, item);
      }
    }
    playlists.push({ path, bytes, items: mpls.playItems, clipIds });
  }

  const clips = new Map<string, ClipInfo>();
  for (const [clipId, item] of items) {
    const clpiPath = `BDMV/CLIPINF/${clipId}.CLPI`;
    const m2tsPath = `BDMV/STREAM/${clipId}.M2TS`;
    if (!sizes.has(m2tsPath)) continue;
    const clpiBytes = await fileBytes(manifest, source, clpiPath);
    if (!clpiBytes) continue;
    let clpi: Clpi;
    try {
      clpi = parseClpi(clpiBytes);
    } catch {
      continue;
    }
    const map = videoEpMap(clpi);
    if (!map || map.entries.length === 0) continue;
    const stream = clpi.programs.flatMap((p) => p.streams).find((s) => s.pid === map.pid)!;
    const height = FORMAT_LINES[stream.format] ?? 1080;
    const hdr = clpiVideoIsHdr(clpiBytes, map.pid);
    clips.set(clipId, { id: clipId, clpiPath, m2tsPath, clpiBytes, clpi, video: { pid: map.pid, codingType: stream.codingType, height, rate: stream.rate, hdr }, item });
  }
  let main: ClipInfo | null = null;
  for (const c of clips.values()) if (!main || (sizes.get(c.m2tsPath) ?? 0) > (sizes.get(main.m2tsPath) ?? 0)) main = c;
  return { id, source, manifest, sizes, playlists, clips, main, audioBps: new Map(), scans: new Map() };
}

/**
 * The kept audio's rate in bits per second of source packets (`audioWireBps`: its nominal rate plus what its PES and TS
 * packets add), from its first frame in the clip; one read per clip and PID. With no readable frame in the clip's first 16 MiB,
 * the coding's fallback (`fallbackAudioBps`), logged.
 */
export function audioBpsOf(disc: DiscInfo, info: ClipInfo, kept: KeptAudio, log: (message: string) => void = () => {}): Promise<number> {
  const key = `${info.id}:${kept.pid}`;
  let bps = disc.audioBps.get(key);
  if (!bps) {
    const reading = (async () => {
      const clip = await disc.source.clip(info.m2tsPath);
      if (!clip) throw new Error(`levels: ${info.m2tsPath} is missing`);
      try {
        return await firstAudioBps(clip.read(0, Math.min(clip.size, AUDIO_PROBE_BYTES)), kept.pid, kept.coding);
      } catch (err) {
        const stream = info.clpi.programs.flatMap((p) => p.streams).find((s) => s.pid === kept.pid) ?? null;
        const bps = fallbackAudioBps(kept.coding, stream);
        log(`levels: ${(err as Error).message} in ${info.m2tsPath}; using the fallback ${bps} b/s of coding 0x${kept.coding.toString(16)}`);
        return bps;
      }
    })();
    bps = reading;
    disc.audioBps.set(key, reading);
    reading.catch(() => {
      if (disc.audioBps.get(key) === reading) disc.audioBps.delete(key);
    });
  }
  return bps;
}

/**
 * A clip's scan: one probe per clip, because it reads the clip's head with ffprobe and every level and audio stream of
 * the disc needs the same answer; a failed probe is tried again next time.
 */
function scanOf(disc: DiscInfo, info: ClipInfo, clip: ClipSource, deps: VersionDeps): Promise<ScanInfo> {
  let scan = disc.scans.get(info.id);
  if (!scan) {
    const probe = deps.probe ?? ((input, options) => probeScan(input, { ...options, ...(deps.spawn ? { spawn: deps.spawn } : {}) }));
    const startByte = videoEpMap(info.clpi)!.entries[0]!.spn * SOURCE_PACKET_BYTES;
    const probing = probe(clip.input, { startByte, videoPid: info.video.pid, ...(deps.signal ? { signal: deps.signal } : {}) });
    scan = probing;
    disc.scans.set(info.id, probing);
    probing.catch(() => {
      if (disc.scans.get(info.id) === probing) disc.scans.delete(info.id);
    });
  }
  return scan;
}

/**
 * The encoder's shortest frame time for a clip (`ClipEncoderOptions.frameTicks`): the probe's, never more than the
 * CLPI rate's, so a clip that opens on a still (long frames in the probe) can't inflate it.
 */
export function clipFrameTicks(scan: ScanInfo, rate: number): number {
  const clpi = frameTicks(fpsOf(rate));
  return scan.frameTicks === undefined ? clpi : Math.min(scan.frameTicks, clpi);
}

/**
 * Bumped whenever the encoder makes different bytes for the same plan, so no segment an earlier encoder cached is
 * served: 2 restores the source's PTS and forces keyframes on the EP frames.
 */
export const ENCODER_VERSION = 2;

/**
 * A short hash of what decides a clip's bytes at a level besides the clip itself: the level's definition, the kept
 * audio, every interval's place and budget, the encoder backend and its version, and whether the clip is deinterlaced. It is part of
 * the segment cache key, so a changed plan never reuses bytes made for another.
 */
export function planHash(
  def: LevelDef,
  kept: KeptAudio | null,
  intervals: readonly IntervalPlan[],
  encode: { readonly backend: string; readonly deinterlace: boolean },
): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({ encoder: ENCODER_VERSION, budget: BUDGET_VERSION, def, kept, backend: encode.backend, deinterlace: encode.deinterlace }));
  for (const iv of intervals) h.update(`${iv.startPts45},${iv.endPts45},${iv.srcSpnStart},${iv.srcSpnEnd},${iv.budgetBytes};`);
  return h.digest('hex').slice(0, 12);
}

/**
 * The disc at a level and audio stream: the same files, with each re-encoded clip's planned size, its CLPI rewritten,
 * and every playlist that plays one rewritten (video attributes per play item, from that item's clip; a playlist with
 * no re-encoded clip is left as it is). Null when the disc's main video isn't offered at the level.
 */
export async function buildVersion(key: string, disc: DiscInfo, level: EncodedLevel, audio: number, deps: VersionDeps): Promise<Version | null> {
  const main = disc.main;
  if (!main || !levelsFor(main.video).includes(level)) return null;

  const rewritten = new Map<string, Uint8Array>();
  const clips = new Map<string, ClipVersion>();
  const attrs = new Map<string, VideoAttrs>();
  for (const info of disc.clips.values()) {
    const source = await disc.source.clip(info.m2tsPath);
    if (!source) continue;
    const def = levelDefFor(level, info.video);
    const kept = keptAudioFor(info.item, audio);
    const audioBps = kept ? await audioBpsOf(disc, info, kept, deps.log) : 0;
    const { intervals, sizeBytes } = planClip(info.clpi, def, audioBps, deps.planTuning);
    const streams = info.clpi.programs.flatMap((p) => p.streams);
    const graphics = [...new Set(streams.filter((s) => GRAPHICS_CODINGS.has(s.codingType)).map((s) => s.pid))];
    const video = videoAttrsFor(def, info.video.rate);
    attrs.set(info.id, video);
    rewritten.set(info.clpiPath, rewriteClpi(info.clpiBytes, { intervals, level: def, keepPids: graphics, audio: kept, videoPid: info.video.pid, ...video }));
    const runPlan = clipRunPlan(disc, info, def, kept, graphics, intervals, source, level, audio, deps);
    clips.set(info.m2tsPath, { info, sizeBytes, runPlan, source, stamp: { size: source.size, mtimeMs: source.mtimeMs } });
  }
  if (clips.size === 0) return null;
  for (const playlist of disc.playlists) {
    const first = playlist.clipIds.find((id) => attrs.has(id));
    if (first === undefined) continue; // no re-encoded clip: unchanged
    const fallback = attrs.get(first)!;
    rewritten.set(playlist.path, rewriteMpls(playlist.bytes, { audioStreamNumber: audio }, (item) => attrs.get(item.clipId) ?? fallback));
  }

  const sizes = new Map(disc.sizes);
  for (const [path, clip] of clips) sizes.set(path, clip.sizeBytes);
  for (const [path, bytes] of rewritten) sizes.set(path, bytes.length);
  const inline: Record<string, string> = { ...disc.manifest.inline };
  for (const [path, bytes] of rewritten) if (path in inline) inline[path] = Buffer.from(bytes).toString('base64');
  const manifest: DiscManifest = {
    ...disc.manifest,
    files: disc.manifest.files.map((f) => ({ path: f.path, size: sizes.get(f.path) ?? f.size })),
    inline,
  };
  return { key, disc, codec: levelDefFor(level, main.video).codec, fps: fpsOf(main.video.rate), manifest, sizes, rewritten, clips };
}

/**
 * The clip's kept PG and IG PIDs by stream number: as the play item's STN lists them, then any it doesn't (by the CLPI's
 * coding), each kind on its own.
 */
export function graphicsByNumber(info: Pick<ClipInfo, 'item' | 'clpi'>, graphics: readonly number[]): GraphicsByNumber {
  const kept = new Set(graphics);
  const coding = new Map(info.clpi.programs.flatMap((p) => p.streams).map((s) => [s.pid, s.codingType]));
  const byNumber = (listed: readonly { pid: number }[], isKind: (c: number | undefined) => boolean): number[] => {
    const ordered = [...new Set(listed.map((s) => s.pid).filter((pid) => kept.has(pid)))];
    return [...ordered, ...graphics.filter((pid) => !ordered.includes(pid) && isKind(coding.get(pid)))];
  };
  return {
    pg: byNumber(info.item.stn.pg, (c) => c !== CodingType.IG),
    ig: byNumber(info.item.stn.ig, (c) => c === CodingType.IG),
  };
}

/** The clip's plan for its encoder and re-mux: the intervals, the cache key, the kept PIDs and the program's stream types. */
function clipRunPlan(
  disc: DiscInfo,
  info: ClipInfo,
  def: LevelDef,
  kept: KeptAudio | null,
  graphics: readonly number[],
  intervals: readonly IntervalPlan[],
  source: ClipSource,
  level: EncodedLevel,
  audio: number,
  deps: VersionDeps,
): ClipRunPlan {
  const { clpi, video } = info;
  const stcs = clpi.atcSequences.flatMap((a) => a.stc);
  const ownPcrPids = [...new Set(stcs.map((s) => s.pcrPid))].filter((pid) => pid !== video.pid);
  const coreFilters = new Map<number, number>();
  if (kept && kept.coding !== coreCoding(kept.coding)) coreFilters.set(kept.pid, kept.coding);
  let cacheKey: Promise<string> | null = null;
  return {
    intervals,
    label: `disc ${disc.id} clip ${info.id} at ${level}, audio ${audio}`,
    // Waits for the clip's scan probe (once per clip): the deinterlace decision is part of the key.
    cacheKey: () =>
      (cacheKey ??= scanOf(disc, info, source, deps).then(
        (scan) => deps.cache.key(disc.id, level, audio, `${info.id}.${planHash(def, kept, intervals, { backend: deps.backendId, deinterlace: deinterlaces(scan) })}`, source.size, source.mtimeMs),
        (err: Error) => {
          cacheKey = null; // probed again next time
          throw err;
        },
      )),
    read: source.read,
    encoder: {
      input: source.input,
      intervals,
      stcStarts: stcs.map((s) => s.spnStcStart),
      videoPid: video.pid,
      sourceCoding: video.codingType,
      level: def,
      hdr: video.hdr,
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
    },
    scan: () =>
      scanOf(disc, info, source, deps).then((scan) => ({ interlaced: deinterlaces(scan), frameTicks: clipFrameTicks(scan, video.rate) })),
    kept: {
      keepPids: [0, ...graphics, ...ownPcrPids, ...(kept ? [kept.pid] : [])],
      coreFilters,
      pmtPids: [...new Set(clpi.programs.map((p) => p.programMapPid))],
      videoStreamType: def.codec === 'h264' ? CodingType.AVC : CodingType.HEVC,
      pcrPid: stcs[0]?.pcrPid ?? video.pid,
      graphics: graphicsByNumber(info, graphics),
    },
  };
}
