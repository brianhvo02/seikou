import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setPriority } from 'node:os';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import { analyzeAvc } from '../../../src/engine/decode/h264';
import { analyzeHevc } from '../../../src/engine/decode/hevc';
import { readTimestamp } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import { SOURCE_PACKET_BYTES, VIDEO_FLOOR_BPS, type IntervalPlan, type LevelDef } from './levels';
import type { EncodedPes } from './remux';

/** What an encoder backend needs to build one ffmpeg run. */
export interface EncoderArgsInput {
  /** The clip's path, read by ffmpeg itself, or `pipe:0` when its bytes come on stdin (an ISO image's extents). */
  readonly file: string;
  /**
   * The run's bytes of a file, [startByte, endByte): from the first interval's EP entry to the run's end. A pipe's bytes
   * are already that range. (ffmpeg's `-ss` counts from its own guess of the file's start time, which can be an audio
   * PTS before the video's, so a run is bounded by bytes instead, and `-copyts` keeps the clip's PTS.)
   */
  readonly startByte: number;
  readonly endByte: number;
  /**
   * 90 kHz, the PTS of the frame at every EP entry of the run (`epFramePts`: exact, where the EP map keeps it to 512
   * ticks), in one STC sequence and increasing: each gets an IDR.
   */
  readonly keyframesPts90: readonly number[];
  /** 90 kHz, the shortest time between two frames of the source (`frameTicks`): where the keyframes are forced. */
  readonly frameTicks: number;
  /** The source's primary video PID; the output carries that stream only. */
  readonly videoPid: number;
  /** The source video's coding type (CLPI), which names the hardware decoder. */
  readonly sourceCoding: number;
  readonly level: LevelDef;
  /** Deinterlace the source to its frame rate (see `deinterlaces`). */
  readonly interlaced: boolean;
  /** The source is HDR10: an `hdr` level keeps it (Main10), a `tonemap` level maps it to SDR. */
  readonly hdr: boolean;
  /** The encoder's target rate, bits per second; maxrate is 1.25 × it, the buffer 2 × it. */
  readonly rateBps: number;
}

export interface EncoderBackend {
  /** Which encoder (`qsv`, `x264`): part of the segment cache key, since the two make different bytes. */
  readonly id: string;
  readonly binary: string;
  args(input: EncoderArgsInput): string[];
  /** How far to lower the encoder process's priority (a nice value; 0 or absent leaves it as it is). */
  nice?(input: EncoderArgsInput): number;
}

/** A long GOP: the forced keyframes at EP entries are the ones that matter. */
const GOP_FRAMES = 1000;
const PEAK_FACTOR = 1.25;
const BUFFER_FACTOR = 2;
const PTS_WRAP = 2 ** 33;

/** 90 kHz ticks from one frame to the next at its shortest, at `fps` (3753 at 23.976, 3003 at 29.97). */
export function frameTicks(fps: number): number {
  return Math.floor(90_000 / fps);
}

/**
 * When ffmpeg forces the keyframe of the frame at `pts90` (an EP entry): one microsecond after `pts90 − frameTicks`.
 * ffmpeg forces the first frame whose timestamp is at or after the time, and it compares the timestamp the encoder
 * sees, which ffmpeg 7.1's QSV filters have already rounded down to their frame-rate grid (by up to a frame; see
 * `SourceFrames`). The time lies after the frame before (at most `pts90 − frameTicks`) and at or before the frame
 * itself for any such shift under `frameTicks` less a microsecond, so the keyframe lands on the EP entry's frame
 * whether the build shifts timestamps or not.
 */
export function keyframeTime(pts90: number, ticks: number): string {
  const at = Math.max(0, pts90 - ticks);
  const seconds = Math.floor(at / 90_000);
  // At most 999 989: a tick is 11.1 µs, so the microsecond after never carries into the next second.
  const micros = Math.floor(((at % 90_000) * 1_000_000) / 90_000) + 1;
  return `${seconds}.${String(micros).padStart(6, '0')}`;
}

const keyframeTimes = (input: EncoderArgsInput): string => input.keyframesPts90.map((pts) => keyframeTime(pts, input.frameTicks)).join(',');

function inputArgs(input: EncoderArgsInput): string[] {
  if (input.file === 'pipe:0') return ['-i', 'pipe:0'];
  return ['-nostdin', '-i', `subfile,,start,${input.startByte},end,${input.endByte},,:${input.file}`];
}

function mapArgs(input: EncoderArgsInput): string[] {
  return ['-map', `0:#0x${input.videoPid.toString(16)}`, '-an', '-sn', '-dn'];
}

function rateArgs(rateBps: number): string[] {
  const rate = Math.round(rateBps);
  return ['-b:v', String(rate), '-maxrate', String(Math.round(rate * PEAK_FACTOR)), '-bufsize', String(rate * BUFFER_FACTOR)];
}

/**
 * Every frame through as it comes (no frame-rate conversion: soft pulldown stays 23.976p), stamped on the 90 kHz clock:
 * the encoder's default time base is the frame rate's, which would move each PTS to its grid (1080i29.97 by 900 ticks)
 * and off the EP entries. `-mpegts_copyts` keeps the muxer from adding its 1.4 s delay. (ffmpeg 7.1's QSV
 * filters still round each PTS down to their frame-rate grid, which no option undoes: `ClipEncoder` restores them.)
 */
const OUTPUT = ['-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-mpegts_copyts', '1', '-f', 'mpegts', 'pipe:1'];
const HEAD = ['-hide_banner', '-nostats', '-loglevel', 'error'];
/** The nice value of a VC-1 encode, whose software decode takes about 0.45 of a core per viewing (bursts of 1.35): the NAS's other services come first. */
const VC1_SOFTWARE_NICE = 10;

const QSV_DECODERS = new Map<number, string>([
  [CodingType.AVC, 'h264_qsv'],
  [CodingType.HEVC, 'hevc_qsv'],
  [CodingType.MPEG2_VIDEO, 'mpeg2_qsv'],
  [CodingType.VC1, 'vc1_qsv'],
]);

/** Whether an HDR clip is tone-mapped: at every SDR level, not only the one made for it (a disc's other clips may be HDR). */
const tonemaps = (input: EncoderArgsInput): boolean => input.hdr && !input.level.hdr;

/**
 * The QSV video filter: scale (and P010 for HDR; NV12 from HEVC, which may be 10-bit, to H.264), deinterlace, or
 * tone-map, as the level and source need.
 */
function qsvFilter(input: EncoderArgsInput): string {
  const { level } = input;
  const size = `w=${level.width}:h=${level.height}`;
  const p010 = input.hdr && level.hdr;
  const deinterlace = input.interlaced ? 'deinterlace=2:' : '';
  if (tonemaps(input)) return `vpp_qsv=${deinterlace}${size}:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709`;
  const format = p010 ? ':format=p010' : level.codec === 'h264' && input.sourceCoding === CodingType.HEVC ? ':format=nv12' : '';
  if (input.interlaced) return `vpp_qsv=${deinterlace}${size}${format}`;
  return `scale_qsv=${size}${format}`;
}

/**
 * The NAS's Intel Quick Sync encoder (spec §2's spike): the source's QSV decoder, `scale_qsv` or `vpp_qsv` (advanced
 * deinterlacing, tone-mapping), `h264_qsv` at preset medium or `hevc_qsv` at veryfast, an IDR at every EP entry.
 */
export const qsvBackend: EncoderBackend = {
  id: 'qsv',
  binary: 'ffmpeg',
  args(input) {
    const { level } = input;
    const decoder = QSV_DECODERS.get(input.sourceCoding);
    if (!decoder) throw new Error(`levels: no QSV decoder for coding type 0x${input.sourceCoding.toString(16)}`);
    const hdr = input.hdr && level.hdr;
    const codec = level.codec === 'h264' ? ['-c:v', 'h264_qsv'] : ['-c:v', 'hevc_qsv', ...(hdr ? ['-profile:v', 'main10'] : [])];
    const preset = level.codec === 'h264' ? 'medium' : 'veryfast';
    const colour = hdr
      ? ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc']
      : tonemaps(input)
        ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
        : [];
    // The QSV VC-1 decoder drops frames (a disc's first I-frame among them, so its first interval never starts):
    // VC-1 is decoded in software and uploaded to the GPU for the filters and the encoder, at a lower priority (`nice`).
    const vc1 = input.sourceCoding === CodingType.VC1;
    const decode = vc1
      ? ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw', '-copyts', '-c:v', 'vc1']
      : ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-copyts', '-c:v', decoder];
    return [
      ...HEAD, ...decode,
      ...inputArgs(input), ...mapArgs(input),
      '-vf', `${vc1 ? 'format=nv12,hwupload=extra_hw_frames=64,' : ''}${qsvFilter(input)}`,
      ...codec, '-preset', preset, ...rateArgs(input.rateBps), ...colour,
      '-forced_idr', '1', '-force_key_frames', keyframeTimes(input), '-g', String(GOP_FRAMES),
      ...OUTPUT,
    ];
  },
  nice: (input) => (input.sourceCoding === CodingType.VC1 ? VC1_SOFTWARE_NICE : 0),
};

/** Software H.264 (libx264), for machines without Quick Sync, such as CI. HDR sources and HEVC levels aren't supported. */
export const x264Backend: EncoderBackend = {
  id: 'x264',
  binary: 'ffmpeg',
  args(input) {
    const { level } = input;
    if (level.codec !== 'h264') throw new Error(`levels: x264Backend encodes H.264 levels only, not ${level.id}`);
    const filters = [...(input.interlaced ? ['bwdif=mode=send_frame'] : []), `scale=${level.width}:${level.height}`];
    return [
      ...HEAD, '-copyts',
      ...inputArgs(input), ...mapArgs(input),
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...rateArgs(input.rateBps),
      '-x264-params', `keyint=${GOP_FRAMES}`, '-forced-idr', '1', '-force_key_frames', keyframeTimes(input),
      ...OUTPUT,
    ];
  },
};

/** Streams a clip's bytes [fromByte, toByte); without `toByte`, to its end. */
export type ClipReader = (fromByte: number, toByte?: number) => Readable;

/** The clip as a path ffmpeg opens itself, or a reader whose bytes are piped to it (an ISO image's extents). */
export type ClipInput = { readonly path: string } | { readonly read: ClipReader };

export interface ClipEncoderOptions {
  readonly input: ClipInput;
  readonly intervals: readonly IntervalPlan[];
  /** SPNs where the clip's STC sequences start (CLPI spnStcStart); a run never crosses one. */
  readonly stcStarts?: readonly number[];
  readonly videoPid: number;
  /** The source video's coding type (CLPI). */
  readonly sourceCoding: number;
  readonly level: LevelDef;
  /** Deinterlace to the frame rate: `deinterlaces(await probeScan(…))`. */
  readonly interlaced: boolean;
  /**
   * 90 kHz, the shortest time between two of the source's frames (an interlaced source is deinterlaced to its frame
   * rate): the scan probe's `frameTicks`, else `frameTicks(fps)` of the CLPI's rate. It places the forced keyframes.
   */
  readonly frameTicks: number;
  readonly hdr: boolean;
  /** Default: the level's target. */
  readonly rateBps?: number;
  /** The most intervals one ffmpeg run covers (its keyframe list stays far below the argument limit). Default 300. */
  readonly maxIntervalsPerRun?: number;
  /** Injectable for tests. */
  readonly spawn?: typeof nodeSpawn;
  /** Lowers a process's priority (`os.setPriority`); for tests. */
  readonly setPriority?: (pid: number, nice: number) => void;
}

export const MAX_INTERVALS_PER_RUN = 300;
const TS_PACKET = 188;
/** An EP entry's PTS keeps 45 kHz bits 8 and up (90 kHz bits 9 and up); frames are always more than 512 ticks apart. */
const EP_PTS_GRAIN = 512;
const STDERR_KEEP = 4096;

export interface ClipEncoderEvents {
  interval: [index: number, video: EncodedPes[]];
  error: [err: Error];
  /** The run finished at `lastIndex`, the last interval of its window; the caller starts the next run after it. */
  end: [lastIndex: number];
}

/**
 * A run's intervals: from `from`, in one STC sequence, with increasing PTS (no 33-bit wrap), at most `max`; and the
 * over-run interval after them when the run stops only for its size. With an open GOP, the source's leading pictures
 * of the next GOP (display time before the next EP entry, so the last interval's) come after that entry's bytes, so the
 * run reads the over-run interval too and forces its IDR: the encode's split stays aligned, and everything from that
 * IDR on is dropped.
 */
export function runWindow(
  intervals: readonly IntervalPlan[],
  from: number,
  stcStarts: readonly number[],
  max: number,
): { window: IntervalPlan[]; overrun: IntervalPlan | null; endSpn: number } {
  const first = intervals[from];
  if (!first) throw new Error(`levels: the clip has no interval ${from}`);
  const stcOf = (spn: number): number => stcStarts.filter((s) => s > 0 && s <= spn).length;
  // A new STC sequence, or a 33-bit PTS wrap, ends a run: ffmpeg would unwrap or jump the timestamps the splitter
  // matches on. (A wrap loses the leading pictures of the GOP after it: rare enough to accept.)
  const continues = (i: number): boolean =>
    stcOf(intervals[i]!.srcSpnStart) === stcOf(first.srcSpnStart) && intervals[i]!.startPts45 > intervals[i - 1]!.startPts45;
  const window = [first];
  let i = from + 1;
  for (; i < intervals.length && window.length < max && continues(i); i++) window.push(intervals[i]!);
  const overrun = i < intervals.length && continues(i) ? intervals[i]! : null;
  const last = overrun ?? window.at(-1)!;
  // The bytes end where the next STC sequence starts, else at the end of the over-run (or last) interval.
  const nextStc = stcStarts.find((s) => s > last.srcSpnStart && s < last.srcSpnEnd);
  return { window, overrun, endSpn: nextStc ?? last.srcSpnEnd };
}

/**
 * Runs ffmpeg over one window of a clip's EP intervals (`runWindow`: one STC sequence, at most 300 intervals) and hands
 * over the encoded video one interval at a time, in decode order: an access unit whose PTS is an EP entry's (to its
 * 512-tick grain) starts that entry's interval, and must be an IDR. Frames before the first interval's IDR (leading
 * pictures of an open GOP) are dropped, and so is everything from the over-run interval's IDR on. `end` follows the
 * window's last interval; a run that stops short is an error.
 *
 * The run's bytes are always piped to ffmpeg (a path is read here too), and the video PES timestamps of those bytes
 * are taken on the way (`SourceFrames`): every encoded frame gets back its source frame's PTS, and its DTS moves with
 * it, before the split. ffmpeg's QSV filters move each re-encoded frame's PTS by up to a frame (in 7.1 they
 * round it down to their frame-rate grid), which would put the encode off the EP entries and off the
 * untouched audio and subtitles.
 */
export class ClipEncoder extends EventEmitter<ClipEncoderEvents> {
  private process: ChildProcess | null = null;
  private reader: Readable | null = null;
  /** Bumped on every start and stop, so a dead run's callbacks do nothing. */
  private run = 0;

  constructor(
    private readonly backend: EncoderBackend,
    private readonly options: ClipEncoderOptions,
  ) {
    super();
  }

  start(fromInterval: number): void {
    this.stop();
    const run = ++this.run;
    const { options } = this;
    const { window, overrun, endSpn } = runWindow(options.intervals, fromInterval, options.stcStarts ?? [], options.maxIntervalsPerRun ?? MAX_INTERVALS_PER_RUN);
    const keyed = [...window, ...(overrun ? [overrun] : [])];
    const fail = (err: Error): void => {
      if (run !== this.run) return;
      this.stop();
      this.emit('error', err);
    };
    epFramePts(options.input, options.videoPid, keyed).then(
      (keyframesPts90) => {
        if (run !== this.run) return;
        try {
          this.launch(run, window, overrun, endSpn, keyframesPts90);
        } catch (err) {
          fail(new Error(`levels: ffmpeg did not start: ${(err as Error).message}`));
        }
      },
      (err: Error) => fail(new Error(`levels: reading the clip's EP entries failed: ${err.message}`)),
    );
  }

  private launch(run: number, window: readonly IntervalPlan[], overrun: IntervalPlan | null, endSpn: number, keyframesPts90: readonly number[]): void {
    const { options } = this;
    const first = window[0]!;
    const lastIndex = window.at(-1)!.index;
    const startByte = first.srcSpnStart * SOURCE_PACKET_BYTES;
    const endByte = endSpn * SOURCE_PACKET_BYTES;
    const ticks = options.frameTicks;
    const argsInput: EncoderArgsInput = {
      file: 'pipe:0',
      startByte,
      endByte,
      keyframesPts90,
      frameTicks: ticks,
      videoPid: options.videoPid,
      sourceCoding: options.sourceCoding,
      level: options.level,
      interlaced: options.interlaced,
      hdr: options.hdr,
      rateBps: options.rateBps ?? options.level.targetBps,
    };
    const args = this.backend.args(argsInput);
    const child = (options.spawn ?? nodeSpawn)(this.backend.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const nice = this.backend.nice?.(argsInput) ?? 0;
    if (nice !== 0 && child.pid !== undefined) {
      try {
        (options.setPriority ?? setPriority)(child.pid, nice);
      } catch (err) {
        console.warn('levels: could not lower the encoder priority', err);
      }
    }
    this.process = child;
    const live = (): boolean => run === this.run;
    const fail = (err: Error): void => {
      if (!live()) return;
      this.stop();
      this.emit('error', err);
    };

    const frames = new SourceFrames(options.videoPid, ticks);
    const splitter = new IntervalSplitter(window, overrun, options.level.codec, frames);
    let emitted = -1;
    const emit = (done: { index: number; video: EncodedPes[] }): void => {
      if (!live()) return;
      emitted = done.index;
      this.emit('interval', done.index, done.video);
    };
    const handOver = (step: () => Array<{ index: number; video: EncodedPes[] }>): boolean => {
      try {
        for (const done of step()) emit(done);
        return true;
      } catch (err) {
        fail(err as Error);
        return false;
      }
    };

    const { input } = options;
    const reader = 'read' in input ? input.read(startByte, endByte) : createReadStream(input.path, { start: startByte, end: endByte - 1 });
    this.reader = reader;
    reader.on('error', (err) => fail(new Error(`levels: reading the clip failed: ${err.message}`)));
    // The source's timestamps are taken before ffmpeg gets the bytes, so they lead its output.
    reader.on('data', (chunk: Buffer) => {
      if (!live()) return;
      frames.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      handOver(() => splitter.drain());
    });
    // ffmpeg may stop reading before the range's end (stopped, or failed): a broken pipe is not an error of its own.
    child.stdin!.on('error', () => {});
    reader.pipe(child.stdin!);
    let stderr = '';
    let pending = new Uint8Array(0);
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!live()) return;
      const data = pending.length ? concat(pending, chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const whole = data.length - (data.length % TS_PACKET);
      for (let at = 0; at < whole && live(); at += TS_PACKET) if (!handOver(() => splitter.push(data, at))) return;
      pending = data.slice(whole);
    });
    child.on('error', (err) => fail(new Error(`levels: ffmpeg did not start: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (!live()) return;
      if (code !== 0) {
        fail(new Error(`levels: ffmpeg exited with ${code ?? signal}: ${stderr.trim()}`));
        return;
      }
      // ffmpeg read everything it encoded: the source's timestamps are all in.
      if (!handOver(() => splitter.finish())) return;
      if (!live()) return;
      if (emitted !== lastIndex) {
        fail(new Error(`levels: ffmpeg ended after interval ${emitted} of a run to ${lastIndex}: ${stderr.trim()}`));
        return;
      }
      this.process = null;
      this.reader = null;
      this.emit('end', lastIndex);
    });
  }

  /** Stops reading ffmpeg's output (it then blocks on its pipe), so the caller can hold back: backpressure. */
  pause(): void {
    this.process?.stdout?.pause();
  }

  resume(): void {
    this.process?.stdout?.resume();
  }

  /** Stops the run and kills ffmpeg; no event follows. */
  stop(): void {
    this.run++;
    this.reader?.destroy();
    this.reader = null;
    this.process?.kill('SIGKILL');
    this.process = null;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * The source's video frames of a run, from the bytes ffmpeg is fed (192-byte source packets from the run's first EP
 * entry), so each encoded frame can be given back its source frame's timestamps.
 *
 * An encoded frame whose PTS is `o` is the source frame with the smallest PTS `p ≥ o`. With `-fps_mode passthrough`
 * every encoded frame is one source frame, at its PTS or (in builds that round timestamps, such as ffmpeg 7.1 through QSV
 * with QSV filters) moved earlier by less than a frame: `p − gap < o ≤ p`, where `gap` is the time to the frame before
 * in display order. So the source frame is found from `o` alone, for any shift under a frame (none included), and it
 * doesn't depend on which frames the decoder dropped or the encoder reordered, as counting frames would: the leading
 * pictures of an open GOP at the start of the bytes, which can't be decoded, and the frames past the over-run IDR. A
 * second encoded frame finding the same source frame is an error, so a shift of a frame or more never goes unnoticed.
 *
 * The match is final once a source PES with a DTS past `p` was seen (every PES after it in decode order has a DTS,
 * hence a PTS, past `p`), or once the source is all in.
 *
 * A PES less than three quarters of `frameTicks` after a frame's PES just before it in decode order is the second
 * field of a field pair (an interlaced picture coded as two fields, half a frame apart): the frame the decoder makes
 * of the pair has the first field's PTS. Frames are at least `frameTicks` apart.
 */
export class SourceFrames {
  /** Frame PTS, ascending. */
  private readonly pts: number[] = [];
  private readonly matched = new Set<number>();
  /** The PTS of the PES before, when it was a frame or a first field: the next PES may be its second field. */
  private open: number | null = null;
  private maxDts = -Infinity;
  private partial: Uint8Array = new Uint8Array(0);
  private complete = false;

  constructor(
    private readonly videoPid: number,
    private readonly frameTicks: number,
  ) {}

  /** The next bytes of the run's source, from its first source packet on. */
  push(bytes: Uint8Array): void {
    let data = bytes;
    if (this.partial.length > 0) data = concat(this.partial, bytes);
    const whole = data.length - (data.length % SOURCE_PACKET_BYTES);
    for (let at = 0; at < whole; at += SOURCE_PACKET_BYTES) this.packet(data, at);
    this.partial = data.slice(whole);
  }

  /** The source PES with these timestamps, in decode order (for tests; `push` parses packets into it). */
  add(pts90: number, dts90: number = pts90): void {
    // Half a frame apart; frames are a whole one apart (three quarters leaves room either way).
    const field = this.open !== null && pts90 > this.open && (pts90 - this.open) * 4 < this.frameTicks * 3;
    this.open = field ? null : pts90;
    this.maxDts = Math.max(this.maxDts, dts90);
    if (field) return;
    let i = this.pts.length;
    while (i > 0 && this.pts[i - 1]! > pts90) i--;
    if (this.pts[i - 1] !== pts90) this.pts.splice(i, 0, pts90);
  }

  /** The source is all in (ffmpeg ended). */
  end(): void {
    this.complete = true;
  }

  /**
   * The source frame PTS of an encoded frame at `pts90`, or null while it can't be known yet. Throws when there is no
   * such source frame, or another encoded frame had it.
   */
  match(pts90: number): number | null {
    let lo = 0;
    let hi = this.pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pts[mid]! < pts90) lo = mid + 1;
      else hi = mid;
    }
    const p = this.pts[lo];
    if (p === undefined || !(this.complete || this.maxDts > p)) {
      if (this.complete) throw new Error(`levels: an encoded frame at PTS ${pts90} has no source frame at or after it`);
      return null;
    }
    if (this.matched.has(p)) throw new Error(`levels: two encoded frames are the source frame at PTS ${p} (the last at ${pts90})`);
    this.matched.add(p);
    return p;
  }

  private packet(data: Uint8Array, at: number): void {
    const ts = parseSourcePacket(data, at);
    if (!ts || ts.pid !== this.videoPid || !ts.payloadUnitStart) return;
    const p = ts.payload;
    if (p.length < 14 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1 || !(p[7]! & 0x80)) return;
    const pts = readTimestamp(p, 9);
    this.add(pts, p[7]! >> 6 === 3 && p.length >= 19 ? readTimestamp(p, 14) : pts);
  }
}

/** Source packets read at an EP entry to find its frame's PES header (it is the entry's first packet on a disc). */
const EP_READ_PACKETS = 64;
/** EP entries read at once. */
const EP_READS_AT_ONCE = 16;
/** Exact EP frame PTS by clip (its input) and EP SPN, so a run's restart or retry doesn't read them again. */
const epPtsCache = new WeakMap<ClipInput, Map<number, number>>();

/** The PTS of the first video PES in `bytes` (source packets) within the EP entry's 512-tick grain, or null. */
function epPtsIn(bytes: Uint8Array, videoPid: number, plan: IntervalPlan): number | null {
  for (let at = 0; at + SOURCE_PACKET_BYTES <= bytes.length; at += SOURCE_PACKET_BYTES) {
    const ts = parseSourcePacket(bytes, at);
    if (!ts || ts.pid !== videoPid || !ts.payloadUnitStart) continue;
    const p = ts.payload;
    if (p.length < 14 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1 || !(p[7]! & 0x80)) continue;
    const pts = readTimestamp(p, 9);
    if (Math.floor(pts / EP_PTS_GRAIN) === Math.floor((plan.startPts45 * 2) / EP_PTS_GRAIN)) return pts;
  }
  return null;
}

/**
 * The exact PTS of the frame at each interval's EP entry: the EP map keeps only its 45 kHz bits 8 and up, and the
 * keyframe times (`keyframeTime`) need the frame's own. Read from the PES header at the entry's SPN; an entry whose
 * header isn't found there keeps the EP map's PTS (the frame lies at most 511 ticks after it).
 */
export async function epFramePts(input: ClipInput, videoPid: number, plans: readonly IntervalPlan[]): Promise<number[]> {
  let cache = epPtsCache.get(input);
  if (!cache) epPtsCache.set(input, (cache = new Map()));
  const out = plans.map((plan) => cache.get(plan.srcSpnStart) ?? null);
  const missing = plans.flatMap((_, i) => (out[i] === null ? [i] : []));
  if (missing.length === 0) return out as number[];
  const length = EP_READ_PACKETS * SOURCE_PACKET_BYTES;
  const file = 'path' in input ? await open(input.path, 'r') : null;
  try {
    const readAt = async (from: number): Promise<Uint8Array> => {
      if (file) {
        const buffer = new Uint8Array(length);
        const { bytesRead } = await file.read(buffer, 0, length, from);
        return buffer.subarray(0, bytesRead);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of (input as { readonly read: ClipReader }).read(from, from + length)) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };
    for (let i = 0; i < missing.length; i += EP_READS_AT_ONCE) {
      await Promise.all(
        missing.slice(i, i + EP_READS_AT_ONCE).map(async (k) => {
          const plan = plans[k]!;
          const pts = epPtsIn(await readAt(plan.srcSpnStart * SOURCE_PACKET_BYTES), videoPid, plan) ?? plan.startPts45 * 2;
          out[k] = pts;
          cache.set(plan.srcSpnStart, pts);
        }),
      );
    }
  } finally {
    await file?.close();
  }
  return out as number[];
}

/** Writes a 33-bit timestamp at `at` of a PES header, keeping its 4-bit prefix. */
function writeTimestamp(pes: Uint8Array, at: number, ts: number): void {
  const t = ((ts % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
  const high = Math.floor(t / 2 ** 30);
  const mid = Math.floor(t / 2 ** 15) & 0x7fff;
  const low = t & 0x7fff;
  pes[at] = (pes[at]! & 0xf0) | (high << 1) | 1;
  pes[at + 1] = mid >> 7;
  pes[at + 2] = ((mid & 0x7f) << 1) | 1;
  pes[at + 3] = low >> 7;
  pes[at + 4] = ((low & 0x7f) << 1) | 1;
}

interface EncodedFrame {
  readonly pes: Uint8Array;
  readonly pts: number;
  readonly dts: number;
}

/**
 * Collects ffmpeg's TS output (188-byte packets) into whole video PES, gives each its source frame's timestamps
 * (`SourceFrames`: the PTS restored, the DTS moved with it, kept increasing and at most the PTS), then splits them into
 * the run's intervals. A PES waits while its source frame isn't known yet.
 */
/**
 * An encoded frame's DTS once its PTS is the source frame's (`pts`): the encoder's own DTS, kept as it is. It already
 * rises with every frame and is at or before the encoder's PTS, which the restore only ever moves later (to the source
 * frame at or after it), so it stays at or before the restored PTS. Shifting each DTS by its own frame's restore does
 * not: the shifts differ by a tick or two with the QSV filters' rounding, and where the encoder packs DTS a tick apart
 * (around frames a VC-1 decoder dropped) a later frame's DTS would have to pass its PTS. A DTS that doesn't rise past
 * `lastDts` moves a tick on; one that would then pass `pts` is refused. A PES with no DTS field (`encodedDts` null) decodes
 * at its PTS, which it can't say otherwise.
 */
export function encodedFrameDts(encodedDts: number | null, pts: number, lastDts: number): number {
  const wanted = encodedDts ?? pts;
  const dts = wanted <= lastDts ? lastDts + 1 : wanted;
  if (dts > pts) throw new Error(`levels: an encoded frame's DTS can't stay increasing and at most its PTS ${pts}`);
  return dts;
}

class IntervalSplitter {
  private videoPid: number | null = null;
  private chunks: Uint8Array[] = [];
  /** Whole encoded PES, waiting for their source frame. */
  private waiting: EncodedFrame[] = [];
  private lastDts = -Infinity;
  private current: { plan: IntervalPlan; video: EncodedPes[] } | null = null;
  /** The over-run interval's IDR came: everything from it on is dropped. */
  private past = false;
  /** EP PTS grain → interval: unique within the run's one STC sequence. */
  private readonly starts: ReadonlyMap<number, IntervalPlan>;
  private readonly last: IntervalPlan;

  constructor(
    private readonly window: readonly IntervalPlan[],
    overrun: IntervalPlan | null,
    private readonly codec: LevelDef['codec'],
    private readonly frames: SourceFrames,
  ) {
    this.starts = new Map([...window, ...(overrun ? [overrun] : [])].map((iv) => [Math.floor((iv.startPts45 * 2) / EP_PTS_GRAIN), iv]));
    this.last = window.at(-1)!;
  }

  /** Parses the packet at `at` of `data`; returns the intervals it completed. */
  push(data: Uint8Array, at: number): Array<{ index: number; video: EncodedPes[] }> {
    if (data[at] !== 0x47) throw new Error('levels: ffmpeg wrote a TS packet without its sync byte');
    // parseSourcePacket reads a 192-byte source packet; a 188-byte TS packet is one without its 4-byte header.
    const ts = parseSourcePacket(data, at - 4);
    if (!ts || !ts.hasPayload) return [];
    const p = ts.payload;
    const startsPes = ts.payloadUnitStart && p.length >= 4 && p[0] === 0 && p[1] === 0 && p[2] === 1 && (p[3]! & 0xf0) === 0xe0;
    if (this.videoPid === null) {
      if (!startsPes) return [];
      this.videoPid = ts.pid;
    }
    if (ts.pid !== this.videoPid) return [];
    if (ts.payloadUnitStart) this.endPes();
    this.chunks.push(p.slice());
    return this.drain();
  }

  /** Places the waiting PES whose source frames are known; returns the intervals they completed. */
  drain(): Array<{ index: number; video: EncodedPes[] }> {
    const out: Array<{ index: number; video: EncodedPes[] }> = [];
    while (this.waiting.length > 0) {
      if (this.past) {
        this.waiting = [];
        break;
      }
      const frame = this.waiting[0]!;
      const pts = this.frames.match(frame.pts);
      if (pts === null) break;
      this.waiting.shift();
      const done = this.place(frame, pts);
      if (done) out.push(done);
    }
    return out;
  }

  /** The end of ffmpeg's output: the intervals its last PES completed, then the one still open. */
  finish(): Array<{ index: number; video: EncodedPes[] }> {
    this.endPes();
    this.frames.end();
    const out = this.drain();
    const last = this.current;
    this.current = null;
    return [...out, ...(last && last.video.length > 0 ? [{ index: last.plan.index, video: last.video }] : [])];
  }

  /** The PES collected so far, whole: it waits for its source frame. */
  private endPes(): void {
    if (this.chunks.length === 0) return;
    if (this.past) {
      this.chunks = [];
      return;
    }
    const size = this.chunks.reduce((n, c) => n + c.length, 0);
    let pes = new Uint8Array(size);
    let at = 0;
    for (const c of this.chunks) {
      pes.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    if (pes.length < 14 || !(pes[7]! & 0x80)) throw new Error('levels: an encoded video PES has no PTS');
    const declared = (pes[4]! << 8) | pes[5]!;
    if (declared) pes = pes.subarray(0, 6 + declared);
    // The PES carries the PTS modulo 2^33, as the EP map does; a run never crosses a wrap (`runWindow`).
    const pts = readTimestamp(pes, 9);
    const dts = pes[7]! >> 6 === 3 ? readTimestamp(pes, 14) : pts;
    this.waiting.push({ pes, pts, dts });
  }

  /** Puts an encoded frame, given its source PTS, into its interval; returns the interval it completed. */
  private place(frame: EncodedFrame, pts: number): { index: number; video: EncodedPes[] } | null {
    const { pes } = frame;
    const shift = pts - frame.pts;
    const hasDts = pes[7]! >> 6 === 3;
    const dts90 = encodedFrameDts(hasDts ? frame.dts : null, pts, this.lastDts);
    this.lastDts = dts90;
    if (shift !== 0) writeTimestamp(pes, 9, pts);
    if (hasDts) writeTimestamp(pes, 14, dts90);
    else if (dts90 !== pts) throw new Error(`levels: an encoded frame without a DTS would decode at ${dts90}, before its PTS ${pts}`);

    const plan = this.starts.get(Math.floor(pts / EP_PTS_GRAIN));
    let done: { index: number; video: EncodedPes[] } | null = null;
    if (plan && plan !== this.current?.plan) {
      const expected = this.current ? this.current.plan.index + 1 : this.window[0]!.index;
      if (plan.index !== expected) throw new Error(`levels: the encode reached interval ${plan.index} where ${expected} was due`);
      const es = pes.subarray(9 + pes[8]!);
      const idr = this.codec === 'h264' ? analyzeAvc(es).idr : analyzeHevc(es).idr;
      if (!idr) throw new Error(`levels: interval ${plan.index} of the encode doesn't start with an IDR`);
      done = this.current ? { index: this.current.plan.index, video: this.current.video } : null;
      this.current = plan.index > this.last.index ? null : { plan, video: [] };
      this.past = this.current === null;
      if (this.past) return done;
    }
    // Before the first interval's IDR: leading pictures of the source's open GOP, not part of the run.
    if (!this.current) return done;
    const { plan: cur } = this.current;
    const offset = (pts - cur.startPts45 * 2 + PTS_WRAP) % PTS_WRAP;
    if (offset >= (cur.endPts45 - cur.startPts45) * 2) {
      // Past the window's end (the over-run's frames, should its IDR be late): not this run's.
      if (cur === this.last) return done;
      throw new Error(`levels: a frame of the encode lies past interval ${cur.index}`);
    }
    this.current.video.push({ pes, dts90 });
    return done;
  }
}

/** What the start of a clip's primary video says about its scan. */
export interface ScanInfo {
  /** Some frames are coded interlaced. */
  readonly interlaced: boolean;
  /** MPEG-2 repeat flags (soft pulldown): progressive film at 23.976 shown as 29.97i. */
  readonly softPulldown: boolean;
  /**
   * 90 kHz, the shortest time between two of the probed frames' PTS (a decoded frame: a field pair counts once), which
   * places the forced keyframes (`keyframeTime`); absent when fewer than two frames had one.
   */
  readonly frameTicks?: number;
}

export const SCAN_PROBE_FRAMES = 120;

/**
 * Probes about the first 120 frames of the primary video from the clip's first EP entry (`startByte`) with ffprobe:
 * `interlaced_frame`, `repeat_pict` and `pts` per frame. Task 6 calls it once per clip.
 */
/** A scan probe that hasn't answered after this long is killed, and the probe fails (tried again on the next build). */
export const PROBE_TIMEOUT_MS = 20_000;

export function probeScan(
  input: ClipInput,
  options: {
    readonly startByte: number;
    readonly videoPid: number;
    readonly binary?: string;
    readonly spawn?: typeof nodeSpawn;
    /** Kills the probe, as when the service closes. */
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<ScanInfo> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('levels: the scan probe was stopped'));
    const piped = 'read' in input;
    const source = piped ? 'pipe:0' : `subfile,,start,${options.startByte},end,0,,:${input.path}`;
    const args = [
      '-v', 'error', '-select_streams', `#0x${options.videoPid.toString(16)}`, '-read_intervals', `%+#${SCAN_PROBE_FRAMES}`,
      '-show_entries', 'frame=pts,interlaced_frame,repeat_pict', '-of', 'json', '-i', source,
    ];
    const child = (options.spawn ?? nodeSpawn)(options.binary ?? 'ffprobe', args, { stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let reader: Readable | null = null;
    if ('read' in input) {
      reader = input.read(options.startByte);
      reader.on('error', (err) => {
        child.kill('SIGKILL');
        reject(new Error(`levels: reading the clip failed: ${err.message}`));
      });
      child.stdin!.on('error', () => {});
      reader.pipe(child.stdin!);
    }
    let out = '';
    let err = '';
    let stopped: string | null = null;
    const stop = (why: string): void => {
      stopped ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(`levels: ffprobe timed out after ${(options.timeoutMs ?? PROBE_TIMEOUT_MS) / 1000} s`), options.timeoutMs ?? PROBE_TIMEOUT_MS);
    const onAbort = (): void => stop('levels: the scan probe was stopped');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => (err = (err + chunk.toString('utf8')).slice(-STDERR_KEEP)));
    child.on('error', (e) => {
      done();
      reject(new Error(`levels: ffprobe did not start: ${e.message}`));
    });
    child.on('close', (code) => {
      done();
      reader?.destroy();
      if (stopped !== null) return reject(new Error(stopped));
      if (code !== 0) return reject(new Error(`levels: ffprobe exited with ${code}: ${err.trim()}`));
      try {
        const frames = (JSON.parse(out) as { frames?: Array<{ pts?: number; interlaced_frame?: number; repeat_pict?: number }> }).frames ?? [];
        if (frames.length === 0) throw new Error('no frames');
        const pts = frames.flatMap((f) => (typeof f.pts === 'number' ? [f.pts] : [])).sort((a, b) => a - b);
        let gap = Infinity;
        for (let i = 1; i < pts.length; i++) if (pts[i]! > pts[i - 1]!) gap = Math.min(gap, pts[i]! - pts[i - 1]!);
        resolve({
          interlaced: frames.some((f) => f.interlaced_frame === 1),
          softPulldown: frames.some((f) => (f.repeat_pict ?? 0) > 0),
          ...(gap === Infinity ? {} : { frameTicks: gap }),
        });
      } catch (e) {
        reject(new Error(`levels: ffprobe's frames could not be read: ${(e as Error).message}`));
      }
    });
  });
}

/** Whether to deinterlace: interlaced video is, soft-pulldown film is encoded as its progressive 23.976 frames. */
export function deinterlaces(scan: ScanInfo): boolean {
  return scan.interlaced && !scan.softPulldown;
}

/** The floor of the over-budget retry, which the budget formula counts on (`graphicsAllowanceBps`). */
export const MIN_RETRY_RATE_BPS = VIDEO_FLOOR_BPS;
/** The retry aims this far under the rate that would just fill the budget. */
const RETRY_MARGIN = 0.95;

/** Encodes one interval of a clip at `rateBps` (a run of that interval alone) and returns its video. */
function encodeOne(backend: EncoderBackend, options: ClipEncoderOptions, index: number, rateBps: number, signal?: AbortSignal): Promise<EncodedPes[]> {
  return new Promise((resolve, reject) => {
    const stopped = (): Error => new Error(`levels: the re-encode of interval ${index} was stopped`);
    if (signal?.aborted) return reject(stopped());
    const encoder = new ClipEncoder(backend, { ...options, rateBps, maxIntervalsPerRun: 1 });
    const onAbort = (): void => {
      encoder.stop();
      reject(stopped());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (): void => signal?.removeEventListener('abort', onAbort);
    let video: EncodedPes[] | null = null;
    encoder.on('interval', (_, v) => (video = v));
    encoder.on('error', (err) => {
      settle();
      reject(err);
    });
    encoder.on('end', () => {
      settle();
      if (video) resolve(video);
      else reject(new Error(`levels: the encode ended without interval ${index}`));
    });
    encoder.start(index);
  });
}

/** The one try below the floor, before an interval is given up: its video barely more than its IDR. */
export const LAST_TRY_RATE_BPS = 250_000;

/** An interval whose bytes can't fit its budget at any rate, even with its graphics dropped: it is never served. */
export class IntervalDoesNotFit extends Error {
  constructor(readonly index: number) {
    super(`levels: interval ${index} overflows its budget even at ${LAST_TRY_RATE_BPS / 1000} kbps with its graphics dropped`);
    this.name = 'IntervalDoesNotFit';
  }
}

/**
 * The over-budget retry (Review Focus 1): re-encodes interval `index` at `rate × (budget ÷ actual) × 0.95`, where
 * `actual` is the re-muxed size the last try needed (budget + overflow), down to a floor of 1 Mbps, until `remux` fits
 * it into the plan's budget. One try is always made, at the floor at least. When it doesn't fit at the floor,
 * `lastResort` gets the floor's video (the re-mux drops subtitle and menu PES, `shedGraphics`); when that can't fit it
 * either, one more try at 250 kbps (as it is, then through `lastResort`); then it throws `IntervalDoesNotFit`: an
 * interval is never served truncated or oversized. An abort of `signal` (its run stopped) kills the ffmpeg and rejects.
 */
export async function encodeIntervalAt(
  backend: EncoderBackend,
  options: ClipEncoderOptions,
  index: number,
  overflowed: { readonly rateBps: number; readonly overflowBytes: number },
  remux: (video: readonly EncodedPes[]) => { bytes: Uint8Array } | { overflow: number },
  signal?: AbortSignal,
  lastResort?: (video: readonly EncodedPes[]) => { bytes: Uint8Array } | null,
): Promise<{ bytes: Uint8Array; rateBps: number }> {
  const plan = options.intervals[index];
  if (!plan) throw new Error(`levels: the clip has no interval ${index}`);
  const budget = plan.budgetBytes;
  let rate = overflowed.rateBps;
  let overflow = overflowed.overflowBytes;
  let video: readonly EncodedPes[];
  do {
    rate = Math.max(MIN_RETRY_RATE_BPS, Math.round(((rate * budget) / (budget + overflow)) * RETRY_MARGIN));
    video = await encodeOne(backend, options, index, rate, signal);
    const result = remux(video);
    if ('bytes' in result) return { bytes: result.bytes, rateBps: rate };
    overflow = result.overflow;
  } while (rate > MIN_RETRY_RATE_BPS);
  const shed = lastResort?.(video);
  if (shed) return { bytes: shed.bytes, rateBps: rate };
  video = await encodeOne(backend, options, index, LAST_TRY_RATE_BPS, signal);
  const last = remux(video);
  if ('bytes' in last) return { bytes: last.bytes, rateBps: LAST_TRY_RATE_BPS };
  const lastShed = lastResort?.(video);
  if (lastShed) return { bytes: lastShed.bytes, rateBps: LAST_TRY_RATE_BPS };
  throw new IntervalDoesNotFit(index);
}
