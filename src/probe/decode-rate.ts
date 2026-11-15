// SPDX-License-Identifier: LGPL-3.0-or-later
/// <reference lib="webworker" />
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import type { EpEntry } from '@seikou/bdmv/clpi-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { analyzeAvc, avcCodecString } from '@seikou/bdmv/codecs/h264';
import { analyzeHevc, hevcCodecStrings } from '@seikou/bdmv/codecs/hevc';
import type { ByteSource } from '@seikou/bdmv/byte-source';
import { M2tsReader } from '@seikou/bdmv/demux/m2ts-reader';

/** The video codings the decode-rate check measures. */
export type ProbeCoding = 'h264' | 'hevc';

/** How fast this device decodes, and decodes and draws, a stretch of one clip's video, against the rate it plays at. */
export interface DecodeRate {
  /** The clip measured, such as `00001`. */
  readonly clip: string;
  /** The codec string the decoder was configured with. */
  readonly codec: string;
  /** The frame rate the clip plays at, from its CLPI. */
  readonly frameRate: number;
  /** Access units fed to the decoder in each pass. */
  readonly units: number;
  /** Frames decoded per second with each frame closed at once; 0 when the pass failed. */
  readonly decodeFps: number;
  /** Frames per second when each frame is also drawn onto a 1920×1080 canvas, as the compositor draws it; 0 when the pass failed. */
  readonly drawFps: number;
  /** The decoded picture's size, from the first frame. */
  readonly width: number;
  readonly height: number;
  /** The first decoder error, when a pass had one. */
  readonly error?: string;
}

/** Access units measured per pass: ten seconds of 24p film. */
export const MEASURE_UNITS = 240;
/** Access units read past the start while looking for the first IDR before giving up on the clip. */
const SEARCH_UNITS = 600;
/** A pass stops waiting for its flush after this long and reports what came out. */
const FLUSH_TIMEOUT_MS = 30_000;
/** At most this many chunks wait in the decoder, so a TV decoder's small buffer pool (16 on Samsung) is never exhausted. */
const MAX_QUEUED = 4;

/** The frame rate a CLPI `rate` code stands for (Blu-ray video frame_rate, as libbluray's `BLURAY_VIDEO_RATE_*`); 23.976 when unknown. */
export function frameRateOf(code: number): number {
  switch (code) {
    case 2:
      return 24;
    case 3:
      return 25;
    case 4:
      return 30000 / 1001;
    case 6:
      return 50;
    case 7:
      return 60000 / 1001;
    default:
      return 24000 / 1001;
  }
}

/** A clip whose video has the measured coding: its name, video PID, rate code, the PID's EP entries and the stream file's size. */
export interface ClipCandidate {
  readonly clip: string;
  readonly pid: number;
  readonly rateCode: number;
  readonly entries: readonly EpEntry[];
  readonly size: number;
}

/** The largest candidate (most likely the main feature, so real bit rates), or null when there is none. */
export function chooseClip(candidates: readonly ClipCandidate[]): ClipCandidate | null {
  let best: ClipCandidate | null = null;
  for (const c of candidates) if (!best || c.size > best.size) best = c;
  return best;
}

/** Where to start reading: the EP entry halfway through the clip (past any logos at its start), or 0 without entries. */
export function middleSpn(entries: readonly EpEntry[]): number {
  return entries.length === 0 ? 0 : entries[Math.floor(entries.length / 2)].spn;
}

const CODING: Record<ProbeCoding, number> = { h264: CodingType.AVC, hevc: CodingType.HEVC };

async function candidates(source: ByteSource, coding: ProbeCoding): Promise<ClipCandidate[]> {
  const found: ClipCandidate[] = [];
  for (const name of source.list('BDMV/CLIPINF')) {
    if (!name.toUpperCase().endsWith('.CLPI')) continue;
    const path = `BDMV/CLIPINF/${name}`;
    const clpi = parseClpi(await source.read(path, 0, source.size(path)));
    const stream = clpi.programs.flatMap((p) => p.streams).find((s) => s.codingType === CODING[coding]);
    if (!stream) continue;
    const clip = name.slice(0, -5);
    const streamPath = source.list('BDMV/STREAM').find((f) => f.toUpperCase() === `${clip.toUpperCase()}.M2TS`);
    if (!streamPath) continue;
    found.push({
      clip,
      pid: stream.pid,
      rateCode: stream.rate,
      entries: clpi.epMaps.find((m) => m.pid === stream.pid)?.entries ?? [],
      size: source.size(`BDMV/STREAM/${streamPath}`),
    });
  }
  return found;
}

interface Unit {
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly timestamp: number;
}

/** Reads MEASURE_UNITS access units from the first IDR at or after `startSpn`, and the codec strings to try. */
async function readUnits(source: ByteSource, clip: ClipCandidate, coding: ProbeCoding, startSpn: number): Promise<{ units: Unit[]; codecs: string[] }> {
  const path = `BDMV/STREAM/${source.list('BDMV/STREAM').find((f) => f.toUpperCase() === `${clip.clip.toUpperCase()}.M2TS`)}`;
  const reader = new M2tsReader({ source, path, startSpn, pids: new Set([clip.pid]) });
  const units: Unit[] = [];
  let codecs: string[] = [];
  let seen = 0;
  try {
    outer: for (let packets = await reader.next(); packets; packets = await reader.next()) {
      for (const pes of packets) {
        if (pes.pid !== clip.pid) continue;
        seen++;
        const info = coding === 'h264' ? analyzeAvc(pes.payload) : analyzeHevc(pes.payload);
        if (units.length === 0) {
          if (!info.idr || !info.sps) {
            if (seen > SEARCH_UNITS) break outer;
            continue;
          }
          codecs = coding === 'h264' ? [avcCodecString(info.sps)] : [...hevcCodecStrings(info.sps)];
        }
        // 90 kHz PTS to microseconds; the decoder only needs them distinct and increasing per unit.
        units.push({ data: info.data.slice(), key: units.length === 0, timestamp: Math.round(((pes.pts ?? 0) * 100) / 9) });
        if (units.length >= MEASURE_UNITS) break outer;
      }
    }
  } finally {
    reader.cancel();
  }
  return { units, codecs };
}

async function firstSupported(codecs: readonly string[]): Promise<string | null> {
  for (const codec of codecs) {
    try {
      if ((await VideoDecoder.isConfigSupported({ codec })).supported === true) return codec;
    } catch {
      // try the next form
    }
  }
  return null;
}

interface PassResult {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly error?: string;
}

/** Decodes every unit once, drawing each frame onto `draw` when given, and times it from the first chunk to the flush. */
async function pass(units: readonly Unit[], codec: string, draw: OffscreenCanvasRenderingContext2D | null): Promise<PassResult> {
  let frames = 0;
  let width = 0;
  let height = 0;
  let error: string | undefined;
  const decoder = new VideoDecoder({
    output: (frame) => {
      if (frames === 0) {
        width = frame.displayWidth;
        height = frame.displayHeight;
      }
      if (draw) draw.drawImage(frame, 0, 0, 1920, 1080);
      frame.close();
      frames++;
    },
    error: (e) => {
      error ??= e.message;
    },
  });
  const waitDequeue = (): Promise<void> =>
    new Promise((resolve) => {
      if ('ondequeue' in decoder) decoder.addEventListener('dequeue', () => resolve(), { once: true });
      else setTimeout(resolve, 0);
    });
  const start = performance.now();
  try {
    decoder.configure({ codec });
    for (const u of units) {
      while (decoder.decodeQueueSize >= MAX_QUEUED && error === undefined && decoder.state === 'configured') await waitDequeue();
      if (error !== undefined || decoder.state !== 'configured') break;
      decoder.decode(new EncodedVideoChunk({ type: u.key ? 'key' : 'delta', timestamp: u.timestamp, data: u.data }));
    }
    if (decoder.state === 'configured') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      });
      try {
        await Promise.race([decoder.flush(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    error ??= err instanceof Error ? err.message : String(err);
  }
  const seconds = (performance.now() - start) / 1000;
  if (decoder.state !== 'closed') decoder.close();
  // a pass that lost frames is not a rate: report it as failed with what it managed
  const fps = frames > 0 && seconds > 0 ? frames / seconds : 0;
  return { fps, width, height, ...(error === undefined && frames < units.length * 0.9 ? { error: `only ${frames} of ${units.length} frames came out` } : error === undefined ? {} : { error }) };
}

/**
 * Measures how fast this device decodes the disc's largest clip of `coding`, from its middle: the units are read into
 * memory first, so the network doesn't count, then decoded twice, once closing each frame at once and once drawing
 * each onto a 1920×1080 OffscreenCanvas first. Null when the disc has no such clip.
 */
export async function measureDecodeRate(source: ByteSource, coding: ProbeCoding): Promise<DecodeRate | null> {
  const clip = chooseClip(await candidates(source, coding));
  if (!clip) return null;
  const frameRate = frameRateOf(clip.rateCode);
  const base = { clip: clip.clip, frameRate };
  const { units, codecs } = await readUnits(source, clip, coding, middleSpn(clip.entries));
  if (units.length === 0) return { ...base, codec: '', units: 0, decodeFps: 0, drawFps: 0, width: 0, height: 0, error: 'no IDR picture found' };
  const codec = await firstSupported(codecs);
  if (!codec) return { ...base, codec: codecs.join(' / '), units: units.length, decodeFps: 0, drawFps: 0, width: 0, height: 0, error: 'decoder does not support the codec' };
  const decodeOnly = await pass(units, codec, null);
  const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
  const drawn = ctx ? await pass(units, codec, ctx) : { fps: 0, width: 0, height: 0, error: 'no 2D context' };
  const error = decodeOnly.error ?? drawn.error;
  return {
    ...base,
    codec,
    units: units.length,
    decodeFps: decodeOnly.error ? 0 : decodeOnly.fps,
    drawFps: drawn.error ? 0 : drawn.fps,
    width: decodeOnly.width || drawn.width,
    height: decodeOnly.height || drawn.height,
    ...(error === undefined ? {} : { error }),
  };
}
