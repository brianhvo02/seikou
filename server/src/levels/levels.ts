import type { Clpi, EpMap } from '@seikou/bdmv/clpi-parser';
import type { PlayItem } from '@seikou/bdmv/mpls-parser';
import type { LevelId } from '../../../src/engine/disc/nas-api';
import { CodingType, isVideoCoding } from '@seikou/bdmv/stream-types';

export type { LevelId };

export interface LevelDef {
  readonly id: Exclude<LevelId, 'original'>;
  readonly codec: 'h264' | 'hevc';
  readonly width: number;
  readonly height: number;
  /** The encoder's target rate, bits per second. */
  readonly targetBps: number;
  /** The encoder's maxrate (1.25 × target), which the byte budget is sized for. */
  readonly peakBps: number;
  /** HEVC Main10 with the source's HDR10 metadata kept. */
  readonly hdr: boolean;
  /** HDR source tone-mapped to SDR. */
  readonly tonemap: boolean;
}

const PEAK_FACTOR = 1.25;

function level(id: LevelDef['id'], codec: LevelDef['codec'], height: 720 | 1080, targetBps: number, hdr = false, tonemap = false): LevelDef {
  const width = height === 720 ? 1280 : 1920;
  return { id, codec, width, height, targetBps, peakBps: targetBps * PEAK_FACTOR, hdr, tonemap };
}

export const LEVELS: Readonly<Record<Exclude<LevelId, 'original'>, LevelDef>> = {
  'h264-1080': level('h264-1080', 'h264', 1080, 8_000_000),
  'phone-720': level('phone-720', 'h264', 720, 3_000_000),
  'hevc-1080': level('hevc-1080', 'hevc', 1080, 5_000_000),
  'hevc-1080-hdr': level('hevc-1080-hdr', 'hevc', 1080, 5_000_000, true),
  'h264-1080-sdr': level('h264-1080-sdr', 'h264', 1080, 8_000_000, false, true),
};

/** Video no browser decodes, so a disc with it never plays at `original` (ruling L-R1). */
const UNPLAYABLE_VIDEO = new Set<number>([CodingType.MPEG1_VIDEO, CodingType.MPEG2_VIDEO, CodingType.VC1]);

/** The levels a disc's primary video can be served at, best first. */
export function levelsFor(source: { codingType: number; height: number; hdr: boolean }): LevelId[] {
  const original: LevelId[] = UNPLAYABLE_VIDEO.has(source.codingType) ? [] : ['original'];
  if (source.hdr) return [...original, 'hevc-1080-hdr', 'h264-1080-sdr'];
  if (source.height <= 720) return [...original, 'phone-720'];
  return [...original, 'h264-1080', 'hevc-1080', 'phone-720'];
}

/**
 * A level's definition for a source. The phone level never scales a standard-definition source
 * up: a source of 576 lines or fewer keeps its own size (720 × 480 or 720 × 576).
 */
export function levelDefFor(id: LevelDef['id'], source: { height: number }): LevelDef {
  const def = LEVELS[id];
  if (id === 'phone-720' && source.height <= 576) return { ...def, width: 720, height: source.height <= 480 ? 480 : 576 };
  return def;
}

/** BD video_format and frame-rate codes (libbluray bluray.h, bd_video_format_e and bd_video_rate_e). */
const VIDEO_FORMAT_480P = 3;
const VIDEO_FORMAT_720P = 5;
const VIDEO_FORMAT_1080P = 6;
const VIDEO_FORMAT_576P = 7;
const VIDEO_RATE_25 = 3;
const VIDEO_RATE_30000_1001 = 4;

/**
 * The primary video's coding attributes at a level. For 720p and 1080p the frame-rate code is the
 * source's: an interlaced source is deinterlaced to its frame rate, so 1080i 29.97 (rate 4) becomes
 * 1080p 29.97. Standard definition has one rate per format (480 lines 29.97, 576 lines 25), as
 * 480i and 576i do on disc.
 */
export function videoAttrsFor(level: LevelDef, sourceRate: number): { newCoding: number; newFormat: number; newRate: number } {
  const newCoding = level.codec === 'h264' ? CodingType.AVC : CodingType.HEVC;
  if (level.height === 480) return { newCoding, newFormat: VIDEO_FORMAT_480P, newRate: VIDEO_RATE_30000_1001 };
  if (level.height === 576) return { newCoding, newFormat: VIDEO_FORMAT_576P, newRate: VIDEO_RATE_25 };
  return { newCoding, newFormat: level.height === 720 ? VIDEO_FORMAT_720P : VIDEO_FORMAT_1080P, newRate: sourceRate };
}

export interface KeptAudio {
  /** 1-based, in the play item's STN. */
  readonly streamNumber: number;
  readonly pid: number;
  /** The coding on the disc; the level carries `coreCoding(coding)`. */
  readonly coding: number;
}

/**
 * The primary audio a play item keeps at a level (ruling L-R3): the requested stream number
 * (1-based, as PSR1) when the item has it as a main-clip stream; otherwise the item's first
 * main-clip primary audio stream (stream 1 on any disc whose stream 1 is in the main clip);
 * otherwise null, and the item keeps no audio. Sub-path audio is never kept. `coding` is the
 * stream's coding on the disc; the level carries `coreCoding(coding)`.
 */
export function keptAudioFor(item: PlayItem, requestedNumber: number): KeptAudio | null {
  const audio = item.stn.audio;
  const isMain = (n: number): boolean => audio[n - 1]?.streamType === 1;
  const streamNumber = isMain(requestedNumber) ? requestedNumber : audio.findIndex((a) => a.streamType === 1) + 1;
  if (streamNumber === 0) return null;
  const s = audio[streamNumber - 1]!;
  return { streamNumber, pid: s.pid, coding: s.codingType };
}

/**
 * The coding type of what a level carries for a kept audio stream: TrueHD travels as its AC-3
 * substream, DTS-HD as its DTS core; everything else as it is.
 */
export function coreCoding(codingType: number): number {
  if (codingType === CodingType.TRUEHD) return CodingType.AC3;
  if (codingType === CodingType.DTSHD || codingType === CodingType.DTSHD_MASTER) return CodingType.DTS;
  return codingType;
}

/** BD audio sample-rate code for 48 kHz, the rate of every AC-3 and DTS core. */
export const AUDIO_RATE_48K = 1;

/** Intervals shorter than this (the clip's last, cut at the presentation end) don't set the rate. */
const MIN_RATE_INTERVAL_45 = 22_500;

/**
 * The level's TS_recording_rate: the highest rate any interval's budget stands for (budget ÷
 * duration), rounded up. The field counts 188-byte TS packets (the engine scales it by 192/188),
 * so the budget's 192-byte source packets count 188 bytes each. Intervals under 0.5 s are left
 * out unless there are no others.
 */
export function maxBudgetRate(intervals: readonly IntervalPlan[]): number {
  const rate = (minDuration: number): number => {
    let max = 0;
    for (const iv of intervals) {
      const duration = iv.endPts45 - iv.startPts45;
      if (duration > 0 && duration >= minDuration) {
        const tsBytes = (iv.budgetBytes / SOURCE_PACKET_BYTES) * TS_PACKET_BYTES;
        max = Math.max(max, Math.ceil((tsBytes * PTS45_HZ) / duration));
      }
    }
    return max;
  };
  return rate(MIN_RATE_INTERVAL_45) || rate(0);
}

/** One EP interval of a clip: the bytes from one video EP entry to the next, and its place at a level. */
export interface IntervalPlan {
  readonly index: number;
  /** 45 kHz, the EP entry's PTS. */
  readonly startPts45: number;
  /** 45 kHz, the next entry's PTS (or the STC sequence's end), unwrapped: always after `startPts45`. */
  readonly endPts45: number;
  /** Source packets [srcSpnStart, srcSpnEnd) of the original clip; the first interval starts at 0. */
  readonly srcSpnStart: number;
  readonly srcSpnEnd: number;
  /** The interval's bytes at the level, a whole number of aligned units. */
  readonly budgetBytes: number;
  /** The interval's first source packet at the level: the running total of budgets ÷ 192. */
  readonly spnStart: number;
}

/** 32 source packets, the aligned unit of an m2ts file. */
export const ALIGNED_UNIT_BYTES = 6144;
export const SOURCE_PACKET_BYTES = 192;
const TS_PACKET_BYTES = 188;
/** Room for the clip's graphics in every interval's budget: this much with one PG or IG stream (or none). */
export const GRAPHICS_ALLOWANCE_BPS = 1_500_000;
/**
 * More room per PG stream beyond the first, since every language's subtitles change at once. With 2 s intervals, 11-PG
 * discs (bursts of 420 KB in 0.75 s, a 5-PG film's 768 KB in 1 s) fit with at least 240 KB to spare at phone-720 across
 * 12 sampled discs, and the video is squeezed below its peak in 0.13% of intervals (7.4% with no merge and 1.5 Mb/s).
 */
export const PG_EXTRA_BPS = 50_000;
/** More room per IG stream (menu pages arrive in bursts). */
export const IG_EXTRA_BPS = 1_000_000;
/** The least room for graphics in any interval, per PG or IG stream: a display set arrives whole (binds only below 2 s). */
export const GRAPHICS_BURST_BYTES = 32 * 1024;
/**
 * EP intervals shorter than this (2 s) are merged with the next ones (a clip's last with the one before), within one
 * STC sequence: a one-frame interval can't hold an IDR, a short one can't hold the audio its source muxed among the
 * source's IDR or a clip's audio tail, and over 2 s a burst of subtitles is a small part of the budget. The merged-away
 * EP entries are dropped from the level's EP map (a seek lands on the entry before, at most 2 s earlier), and keyframes
 * are forced only at the kept ones.
 */
export const MIN_INTERVAL_45 = 90_000;
/** The rate an over-budget interval's video is re-encoded down to, at the least (`encodeIntervalAt`). */
export const VIDEO_FLOOR_BPS = 1_000_000;
/** The least room for an interval's video, an IDR at the floor rate with room (measured 4 to 18 KB on Quick Sync). */
const IDR_ALLOWANCE_BYTES = 48 * 1024;
/**
 * Bumped whenever the plan's formula changes, so no segment cached under an earlier plan is served (part of
 * `planHash`): 2 merges short intervals, counts the audio at its packets' rate and sizes the graphics room by the clip's
 * PG and IG streams.
 */
export const BUDGET_VERSION = 2;

/** The plan's knobs, for the real-disc simulation; production uses the constants above. */
export interface PlanTuning {
  readonly minInterval45: number;
  readonly graphicsBps: number;
  readonly graphicsMinBytes: number;
}

/** The clip's kept graphics streams (every PG, text subtitle and IG stream in its CLPI), by kind. */
function graphicsCounts(clpi: Clpi): { pg: number; ig: number } {
  const pids = (codings: readonly number[]): number =>
    new Set(clpi.programs.flatMap((p) => p.streams).filter((s) => codings.includes(s.codingType)).map((s) => s.pid)).size;
  return { pg: pids([CodingType.PG, CodingType.TEXT_SUBTITLE]), ig: pids([CodingType.IG]) };
}

/** The room a clip's graphics get: a rate over each interval, and a least number of bytes per interval. */
export function graphicsRoom(clpi: Clpi): { bps: number; minBytes: number } {
  const { pg, ig } = graphicsCounts(clpi);
  return {
    bps: GRAPHICS_ALLOWANCE_BPS + Math.max(0, pg - 1) * PG_EXTRA_BPS + ig * IG_EXTRA_BPS,
    minBytes: (pg + ig) * GRAPHICS_BURST_BYTES,
  };
}
const PTS45_WRAP = 2 ** 32;
const PTS45_HZ = 45_000;

/** The EP map of a clip's primary video: the first video stream of the first program that has one. */
export function videoEpMap(clpi: Clpi): EpMap | undefined {
  for (const program of clpi.programs) {
    for (const s of program.streams) {
      if (!isVideoCoding(s.codingType)) continue;
      const map = clpi.epMaps.find((m) => m.pid === s.pid);
      if (map) return map;
    }
  }
  return undefined;
}

/** The STC sequence's presentation end for a source packet, or undefined. */
function stcEndAt(clpi: Clpi, spn: number): { index: number; end: number } | undefined {
  let found: { index: number; end: number } | undefined;
  let index = 0;
  for (const atc of clpi.atcSequences) {
    for (const stc of atc.stc) {
      if (stc.spnStcStart <= spn) found = { index, end: stc.presentationEnd };
      index++;
    }
  }
  return found;
}

/** Bytes rounded up to an aligned unit; never empty. */
function aligned(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / ALIGNED_UNIT_BYTES)) * ALIGNED_UNIT_BYTES;
}

/** One EP entry's stretch of the clip, before short ones are merged. */
interface RawInterval {
  readonly pts: number;
  readonly duration: number;
  readonly stc: number;
  readonly srcSpnStart: number;
  readonly srcSpnEnd: number;
}

/**
 * Splits a clip into intervals at its video EP entries, merging any shorter than `MIN_INTERVAL_45` with the next one in
 * its STC sequence (the sequence's last with the one before), and gives each a byte budget at the level:
 * ⌈max(duration × video peak, an IDR) + duration × audio + max(duration × graphics rate, graphics minimum)⌉, in aligned
 * units, where `audioBps` is the kept audio's rate in source packets (`audioWireBps`) and the graphics room comes from the
 * clip's PG and IG streams (`graphicsRoom`). The budget holds the kept packets of a burst of subtitles or of the audio
 * muxed among the source's IDR with the video at the floor rate at worst; what still doesn't fit is the re-mux's last
 * resort (`shedGraphics`).
 */
export function planClip(clpi: Clpi, level: LevelDef, audioBps: number, tuning?: Partial<PlanTuning>): { intervals: IntervalPlan[]; sizeBytes: number } {
  const map = videoEpMap(clpi);
  if (!map || map.entries.length === 0) throw new Error('levels: the clip has no video EP map');
  const room = graphicsRoom(clpi);
  const minInterval = tuning?.minInterval45 ?? MIN_INTERVAL_45;
  const graphicsBps = tuning?.graphicsBps ?? room.bps;
  const graphicsMin = tuning?.graphicsMinBytes ?? room.minBytes;
  const entries = map.entries;
  const raw: RawInterval[] = entries.map((e, i) => {
    const next = entries[i + 1];
    const stc = stcEndAt(clpi, e.spn);
    const nextStc = next ? stcEndAt(clpi, next.spn) : undefined;
    const endRaw = next && nextStc?.index === stc?.index ? next.pts : (stc?.end ?? e.pts);
    return {
      pts: e.pts,
      duration: (endRaw - e.pts + PTS45_WRAP) % PTS45_WRAP,
      stc: stc?.index ?? -1,
      srcSpnStart: i === 0 ? 0 : e.spn,
      srcSpnEnd: next ? next.spn : clpi.numSourcePackets,
    };
  });
  // Groups of consecutive raw intervals, each at least `minInterval` long where its STC sequence allows.
  const groups: RawInterval[][] = [];
  for (const r of raw) {
    const open = groups.at(-1);
    const openLength = open?.reduce((n, g) => n + g.duration, 0) ?? Infinity;
    if (open && open[0]!.stc === r.stc && openLength < minInterval) open.push(r);
    else groups.push([r]);
  }
  for (let g = groups.length - 1; g > 0; g--) {
    const group = groups[g]!;
    const before = groups[g - 1]!;
    const isLastOfStc = g === groups.length - 1 || groups[g + 1]![0]!.stc !== group[0]!.stc;
    if (isLastOfStc && before[0]!.stc === group[0]!.stc && group.reduce((n, r) => n + r.duration, 0) < minInterval) {
      before.push(...group);
      groups.splice(g, 1);
    }
  }
  const intervals: IntervalPlan[] = [];
  let total = 0;
  groups.forEach((group, index) => {
    const first = group[0]!;
    const duration = group.reduce((n, r) => n + r.duration, 0);
    const seconds = duration / PTS45_HZ;
    const budgetBytes = aligned(
      Math.max((seconds * level.peakBps) / 8, IDR_ALLOWANCE_BYTES) + (seconds * audioBps) / 8 + Math.max((seconds * graphicsBps) / 8, graphicsMin),
    );
    intervals.push({
      index,
      startPts45: first.pts,
      endPts45: first.pts + duration,
      srcSpnStart: first.srcSpnStart,
      srcSpnEnd: group.at(-1)!.srcSpnEnd,
      budgetBytes,
      spnStart: total / SOURCE_PACKET_BYTES,
    });
    total += budgetBytes;
  });
  return { intervals, sizeBytes: total };
}

/**
 * Where a source packet number lands at the level: the first interval starting at or after it
 * (the end of the clip past the last). Used for sequence and program starts, so EP entries before
 * an STC change stay out of the new sequence's range.
 */
export function mapSpn(intervals: readonly IntervalPlan[], srcSpn: number): number {
  for (const iv of intervals) if (iv.srcSpnStart >= srcSpn) return iv.spnStart;
  const last = intervals.at(-1);
  return last ? last.spnStart + last.budgetBytes / SOURCE_PACKET_BYTES : 0;
}

/** The interval holding a source packet number, at the level: the start of the interval containing it. */
export function mapSpnDown(intervals: readonly IntervalPlan[], srcSpn: number): number {
  let spn = 0;
  for (const iv of intervals) {
    if (iv.srcSpnStart > srcSpn) break;
    spn = iv.spnStart;
  }
  return spn;
}
