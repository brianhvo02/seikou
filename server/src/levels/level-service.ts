import type { spawn as nodeSpawn } from 'node:child_process';
import type { DiscManifest, LevelId, LevelInfo, LevelReason } from '@seikou/nas/nas-api';
import type { Capacity, EncoderCodec } from './capacity';
import { ClipRunner, RetryLater, realClock, type Clock } from './clip-run';
import type { ClipInput, EncoderBackend, ScanInfo } from './encoder';
import type { LevelDiscSource } from './level-discs';
import { audioBpsOf, buildVersion, fpsOf, loadDisc, type ClipVersion, type DiscInfo, type EncodedLevel, type Version } from './level-version';
import { SOURCE_PACKET_BYTES, keptAudioFor, levelDefFor, levelsFor, planClip, type IntervalPlan, type PlanTuning } from './levels';
import type { SegmentCache } from './segment-cache';

export { firstAudioBps, folderDiscSource, isoDiscSource, libraryDiscSources, type ClipSource, type LevelDiscSource } from './level-discs';
export type { EncodedLevel } from './level-version';

/** Film the encoder runs ahead of the latest read, in milliseconds: far enough that playback rarely catches it, short enough not to encode what is never watched. */
export const READ_AHEAD_FILM_MS = 120_000;
/** A read at most this much film ahead of the running encoder waits for it; one further ahead (a seek) restarts it there. */
export const WAIT_FILM_MS = 10_000;
/** A read waiting this long, in milliseconds, answers `retryAfter`, which the route turns into a 503 with `Retry-After: 1`. */
export const READ_WAIT_MS = 15_000;
/** An encoder no read has touched for this long, in milliseconds, stops. */
export const ENCODER_IDLE_MS = 60_000;
const DISC_INFOS = 16;
const VERSIONS = 32;

export type { LevelInfo, LevelReason };

/** The short name each level shows in the player's Quality menu and the pre-flight's level list. */
export const LEVEL_LABELS: Readonly<Record<LevelId, string>> = {
  original: 'Original',
  'h264-1080': '1080p',
  'phone-720': 'Phone',
  'hevc-1080': '1080p HEVC',
  'hevc-1080-hdr': '1080p HDR',
  'h264-1080-sdr': '1080p SDR',
};

const ENCODED_LEVELS = new Set<string>(['h264-1080', 'phone-720', 'hevc-1080', 'hevc-1080-hdr', 'h264-1080-sdr']);

/**
 * The id of a viewing, which a GPU lease is for: a device watching a disc at a level and audio stream number. Disc ids
 * hold no colon, which `parseViewingId` relies on.
 */
export function viewingIdOf(deviceId: string, discId: string, level: EncodedLevel, audio: number): string {
  return `${deviceId}:${discId}:${level}:${audio}`;
}

/** A viewing id's parts, read from the end (disc ids hold no colon; a device id's would stay in the device part); null when it isn't one `viewingIdOf` built. */
export function parseViewingId(viewingId: string): { deviceId: string; discId: string; level: EncodedLevel; audio: number } | null {
  const audioAt = viewingId.lastIndexOf(':');
  const levelAt = viewingId.lastIndexOf(':', audioAt - 1);
  const discAt = viewingId.lastIndexOf(':', levelAt - 1);
  if (audioAt < 0 || levelAt < 0 || discAt < 0) return null;
  const level = viewingId.slice(levelAt + 1, audioAt);
  const audio = Number(viewingId.slice(audioAt + 1));
  if (!ENCODED_LEVELS.has(level) || !Number.isInteger(audio)) return null;
  return { deviceId: viewingId.slice(0, discAt), discId: viewingId.slice(discAt + 1, levelAt), level: level as EncodedLevel, audio };
}

/** The device-and-disc part of a viewing id (`<device>:<disc>:`): the viewings one lease moves between. */
function viewerOf(viewingId: string): string {
  const audioAt = viewingId.lastIndexOf(':');
  return viewingId.slice(0, viewingId.lastIndexOf(':', audioAt - 1) + 1);
}

/** What a `LevelService` is built from; everything but `discs`, `cache`, `capacity` and `backend` is optional. */
export interface LevelServiceOptions {
  /** A disc's files by its id; null when it is gone or changed. */
  readonly discs: (discId: string) => Promise<LevelDiscSource | null>;
  /** Where encoded intervals are kept. */
  readonly cache: SegmentCache;
  /** The GPU's leases. */
  readonly capacity: Capacity;
  /** The encoder's ffmpeg command lines. */
  readonly backend: EncoderBackend;
  /** The codecs the backend encodes (whose self-test passed); levels of other codecs aren't offered. Default: both. */
  readonly codecs?: ReadonlySet<EncoderCodec>;
  /** Injectable for tests: how ffmpeg is started. */
  readonly spawn?: typeof nodeSpawn;
  /** Injectable for tests: the scan probe (ffprobe). */
  readonly probe?: (input: ClipInput, options: { readonly startByte: number; readonly videoPid: number; readonly signal?: AbortSignal }) => Promise<ScanInfo>;
  readonly clock?: Clock;
  /** Replaces `READ_AHEAD_FILM_MS`. */
  readonly readAheadMs?: number;
  /** Replaces `WAIT_FILM_MS`. */
  readonly waitFilmMs?: number;
  /** Replaces `READ_WAIT_MS`. */
  readonly waitMs?: number;
  /** Replaces `ENCODER_IDLE_MS`. */
  readonly idleMs?: number;
  /** Receives log lines; default none. */
  readonly log?: (message: string) => void;
  /** Injectable for tests whose fixtures' intervals are short: the plan's knobs (`planClip`). */
  readonly planTuning?: Partial<PlanTuning>;
}

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    for (const oldest of this.map.keys()) {
      if (this.map.size <= this.max) break;
      this.map.delete(oldest);
    }
  }
  delete(key: string, value?: V): void {
    if (value === undefined || this.map.get(key) === value) this.map.delete(key);
  }
  deleteWhere(test: (key: string) => boolean): void {
    for (const key of [...this.map.keys()]) if (test(key)) this.map.delete(key);
  }
}

/** The interval holding byte `offset` of a level's clip. */
function intervalAt(intervals: readonly IntervalPlan[], offset: number): number {
  const spn = Math.floor(offset / SOURCE_PACKET_BYTES);
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (intervals[mid]!.spnStart <= spn) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function filmSeconds(intervals: readonly IntervalPlan[]): number {
  return Math.max(1, intervals.reduce((n, iv) => n + iv.endPts45 - iv.startPts45, 0)) / 45_000;
}

/**
 * Serves discs at re-encoded quality levels: each level is another version of the disc, with the same
 * files, its stream files re-encoded and the CLPI and MPLS files that describe them rewritten (`level-version.ts`).
 * Reads of a level's stream files drive the viewing's encoder for that clip (`ClipRunner`), ahead of the reader;
 * finished intervals live in the segment cache. Every viewing holds a lease on the GPU's capacity. A version is rebuilt
 * when one of its clips was replaced (size or mtime).
 */
export class LevelService {
  private readonly discInfos = new Lru<Promise<DiscInfo>>(DISC_INFOS);
  private readonly versions = new Lru<Promise<Version | null>>(VERSIONS);
  /** By `<viewing id>|<version key>|<clip id>`. */
  private readonly runners = new Map<string, ClipRunner>();
  private readonly clock: Clock;
  private readonly log: (message: string) => void;
  /** Aborted by `close()`: stops the scan probes still running. */
  private readonly closing = new AbortController();

  constructor(private readonly options: LevelServiceOptions) {
    this.clock = options.clock ?? realClock;
    this.log = options.log ?? (() => {});
  }

  /**
   * The disc's manifest at a level and audio stream (1-based, as PSR1), and a lease for the viewing; `busy` when the GPU
   * has no room for it, null when the disc is gone or isn't offered at that level.
   */
  async manifest(discId: string, level: string, audio: number, viewingId: string): Promise<DiscManifest | { busy: true } | null> {
    const source = await this.options.discs(discId);
    if (!source) return null;
    let version = await this.version(discId, level, audio, source);
    if (version && !(await this.unchanged([...version.clips.values()]))) {
      this.invalidate(discId);
      version = await this.version(discId, level, audio, source);
    }
    if (!version) return null;
    if (!this.admit(version, viewingId)) return { busy: true };
    return version.manifest;
  }

  /**
   * Bytes [offset, offset + length) of a file of the disc at a level. A stream file's bytes come from the cache, or the
   * read waits on the viewing's encoder for the clip (restarted at the interval when it is not about to reach it); after
   * 15 s of waiting, or when the encoder moved elsewhere or is backing off after a failure, the answer is `retryAfter`.
   * `busy` when the viewing holds no lease and none is free; null when the disc or file is gone. Throws a RangeError
   * when the range runs past the file.
   */
  async read(
    discId: string,
    level: string,
    audio: number,
    path: string,
    offset: number,
    length: number,
    viewingId: string,
    signal: AbortSignal,
  ): Promise<Buffer | { retryAfter: 1 } | { busy: true } | null> {
    const key = path.toUpperCase();
    let version = await this.version(discId, level, audio);
    let clip = version?.clips.get(key);
    if (version && clip && !(await this.unchanged([clip]))) {
      this.invalidate(discId);
      version = await this.version(discId, level, audio);
      clip = version?.clips.get(key);
    }
    if (!version) return null;
    const size = version.sizes.get(key);
    if (size === undefined) return null;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
      throw new RangeError(`levels: bytes ${offset}+${length} lie past ${key} (${size} bytes)`);
    }
    if (!this.admit(version, viewingId)) return { busy: true };
    const rewritten = version.rewritten.get(key);
    if (rewritten) return Buffer.from(rewritten.subarray(offset, offset + length));
    if (!clip) return version.disc.source.readRange(key, offset, length);
    if (length === 0) return Buffer.alloc(0);
    return this.readClip(version, clip, viewingId, offset, length, signal);
  }

  /**
   * The levels a disc can be played at, for a client that decodes what `client` says. With `deviceId`, the capacity a
   * level needs counts the device's own leases on this disc as free (choosing a level moves its lease).
   */
  async levels(
    discId: string,
    client: { readonly hevc: boolean; readonly hevc10: boolean; readonly hdr: boolean },
    deviceId?: string,
    audioNumber = 1,
  ): Promise<LevelInfo[] | null> {
    const source = await this.options.discs(discId);
    if (!source) return null;
    const disc = await this.discInfo(discId, source);
    const main = disc.main;
    if (!main) return [{ level: 'original', label: LEVEL_LABELS.original, budgetMbps: 0, available: true }];
    const offered = levelsFor(main.video);
    const durationS = filmSeconds(planClip(main.clpi, levelDefFor('phone-720', main.video), 0).intervals);
    const mbps = (bytes: number): number => Math.round((bytes * 8) / durationS / 100_000) / 10;
    const out: LevelInfo[] = [];
    out.push({
      level: 'original',
      label: LEVEL_LABELS.original,
      budgetMbps: mbps(disc.sizes.get(main.m2tsPath) ?? 0),
      ...(offered.includes('original') ? { available: true } : { available: false, reason: 'unplayable' as const }),
    });
    const audio = keptAudioFor(main.item, audioNumber);
    const audioBps = audio ? await audioBpsOf(disc, main, audio, this.log) : 0;
    const fps = fpsOf(main.video.rate);
    const replacing = deviceId === undefined ? [] : this.leasesOf(`${deviceId}:${discId}:`);
    for (const level of offered) {
      if (level === 'original') continue;
      const def = levelDefFor(level, main.video);
      const reason: LevelReason | undefined = !this.encodes(level)
        ? 'no-encoder'
        : def.codec === 'hevc' && !client.hevc
          ? 'no-hevc'
          : def.hdr && !client.hevc10
            ? 'no-hevc10'
            : def.hdr && !client.hdr
              ? 'no-hdr-display'
              : !this.options.capacity.fits(def.codec, fps, replacing)
                ? 'busy'
                : undefined;
      const budget = mbps(planClip(main.clpi, def, audioBps, this.options.planTuning).sizeBytes);
      out.push({ level, label: LEVEL_LABELS[level], budgetMbps: budget, ...(reason ? { available: false, reason } : { available: true }) });
    }
    return out;
  }

  /** The size of a file of the disc at a level and audio stream, as its manifest gives it; null when there is none. */
  async size(discId: string, level: string, audio: number, path: string): Promise<number | null> {
    const version = await this.version(discId, level, audio);
    return version?.sizes.get(path.toUpperCase()) ?? null;
  }

  /** Whether the disc's original plays in the app (its main title isn't MPEG-2 or VC-1); null when the disc is gone. */
  async originalPlayable(discId: string): Promise<boolean | null> {
    const source = await this.options.discs(discId);
    if (!source) return null;
    const { main } = await this.discInfo(discId, source);
    return !main || levelsFor(main.video).includes('original');
  }

  /** What is encoding now, one entry per leased viewing, for the owner's admin screen; `gpuShare` is 0 to 1 of its codec's budget. */
  encodingNow(): readonly { deviceId: string; discId: string; level: EncodedLevel; audio: number; codec: EncoderCodec; gpuShare: number }[] {
    const { capacity } = this.options;
    const out = [];
    for (const l of capacity.list()) {
      const v = parseViewingId(l.viewingId);
      if (v) out.push({ ...v, codec: l.codec, gpuShare: l.needFps / capacity.budgetOf(l.codec) });
    }
    return out;
  }

  /** The viewing ended (the disc closed): its encoders stop and its lease is released. */
  release(viewingId: string): void {
    this.closeRunners((key) => key.startsWith(`${viewingId}|`));
    this.options.capacity.release(viewingId);
  }

  /** Stops every encoder and aborts the scan probes still running. */
  close(): void {
    this.closing.abort();
    this.closeRunners(() => true);
  }

  private leasesOf(prefix: string): string[] {
    return this.options.capacity
      .inUse()
      .viewings.filter((v) => v.viewingId.startsWith(prefix))
      .map((v) => v.viewingId);
  }

  /** Touches the viewing's lease, or leases one, moving the device's lease on this disc (whose encoders then stop). */
  private admit(version: Version, viewingId: string): boolean {
    const { capacity } = this.options;
    if (capacity.has(viewingId)) {
      capacity.touch(viewingId);
      return true;
    }
    const viewer = viewerOf(viewingId);
    const replacing = viewer ? this.leasesOf(viewer).filter((id) => id !== viewingId) : [];
    if (!capacity.lease(viewingId, version.codec, version.fps, replacing)) return false;
    for (const old of replacing) this.closeRunners((key) => key.startsWith(`${old}|`));
    return true;
  }

  private closeRunners(test: (key: string) => boolean): void {
    for (const [key, runner] of this.runners) {
      if (!test(key)) continue;
      this.runners.delete(key);
      runner.close();
    }
  }

  /** Whether each clip's source still has the size and mtime its plan was built with. */
  private async unchanged(clips: readonly ClipVersion[]): Promise<boolean> {
    const stamps = await Promise.all(clips.map((c) => c.source.stamp()));
    return stamps.every((s, i) => s !== null && s.size === clips[i]!.stamp.size && s.mtimeMs === clips[i]!.stamp.mtimeMs);
  }

  /** Forgets everything built from a disc: its information, its versions and their encoders. */
  private invalidate(discId: string): void {
    this.log(`levels: a clip of disc ${discId} changed; its levels are rebuilt`);
    this.discInfos.delete(discId);
    this.versions.deleteWhere((key) => key.startsWith(`${discId}:`));
    this.closeRunners((key) => key.includes(`|${discId}:`));
  }

  private async readClip(version: Version, clip: ClipVersion, viewingId: string, offset: number, length: number, signal: AbortSignal): Promise<Buffer | { retryAfter: 1 }> {
    const runner = this.runner(version, clip, viewingId);
    const { intervals } = clip.runPlan;
    const first = intervalAt(intervals, offset);
    const last = intervalAt(intervals, offset + length - 1);
    runner.noteRead(first);

    const timeout = new Error('levels: the read waited too long');
    const wait = new AbortController();
    const timer = this.clock.setTimeout(() => wait.abort(timeout), this.options.waitMs ?? READ_WAIT_MS);
    const onAbort = (): void => wait.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      const out = Buffer.allocUnsafe(length);
      for (let i = first; i <= last; i++) {
        const iv = intervals[i]!;
        const bytes = await runner.interval(i, wait.signal);
        const start = iv.spnStart * SOURCE_PACKET_BYTES;
        const from = Math.max(offset, start);
        const to = Math.min(offset + length, start + iv.budgetBytes);
        if (bytes.length !== iv.budgetBytes) throw new Error(`levels: interval ${i} is ${bytes.length} bytes, not its budget of ${iv.budgetBytes}`);
        bytes.copy(out, from - offset, from - start, to - start);
      }
      return out;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof RetryLater || (wait.signal.aborted && wait.signal.reason === timeout)) return { retryAfter: 1 };
      throw err;
    } finally {
      this.clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The viewing's encoder for a clip. Each viewing has its own (its lease pays for it), so two viewers far apart in one
   * clip never restart each other's; they share the cache.
   */
  private runner(version: Version, clip: ClipVersion, viewingId: string): ClipRunner {
    const key = `${viewingId}|${version.key}|${clip.info.id}`;
    let runner = this.runners.get(key);
    if (!runner) {
      const created: ClipRunner = new ClipRunner(clip.runPlan, {
        backend: this.options.backend,
        cache: this.options.cache,
        clock: this.clock,
        readAheadMs: this.options.readAheadMs ?? READ_AHEAD_FILM_MS,
        waitFilmMs: this.options.waitFilmMs ?? WAIT_FILM_MS,
        idleMs: this.options.idleMs ?? ENCODER_IDLE_MS,
        onIdle: () => {
          if (this.runners.get(key) === created) this.runners.delete(key);
        },
        log: this.log,
      });
      runner = created;
      this.runners.set(key, runner);
    }
    return runner;
  }

  /** Whether the backend encodes a level's codec (the codec doesn't depend on the source). */
  private encodes(level: string): boolean {
    const codecs = this.options.codecs;
    return !codecs || codecs.has(levelDefFor(level as EncodedLevel, { height: 1080 }).codec);
  }

  private async version(discId: string, level: string, audio: number, known?: LevelDiscSource): Promise<Version | null> {
    if (!ENCODED_LEVELS.has(level) || !Number.isInteger(audio) || audio < 1 || audio > 32 || !this.encodes(level)) return null;
    const key = `${discId}:${level}:${audio}`;
    let version = this.versions.get(key);
    if (!version) {
      const built = (async () => {
        const source = known ?? (await this.options.discs(discId));
        if (!source) return null;
        const disc = await this.discInfo(discId, source);
        return buildVersion(key, disc, level as EncodedLevel, audio, {
          cache: this.options.cache,
          ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
          ...(this.options.probe ? { probe: this.options.probe } : {}),
          log: this.log,
          signal: this.closing.signal,
          backendId: this.options.backend.id,
          ...(this.options.planTuning ? { planTuning: this.options.planTuning } : {}),
        });
      })();
      version = built;
      this.versions.set(key, built);
      built.then(
        (v) => {
          if (!v) this.versions.delete(key, built);
        },
        () => this.versions.delete(key, built),
      );
    }
    return version;
  }

  private discInfo(discId: string, source: LevelDiscSource): Promise<DiscInfo> {
    let info = this.discInfos.get(discId);
    if (!info) {
      const loading = loadDisc(discId, source);
      info = loading;
      this.discInfos.set(discId, loading);
      loading.catch(() => this.discInfos.delete(discId, loading));
    }
    return info;
  }
}
