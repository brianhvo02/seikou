import { Readable } from 'node:stream';
import { findEpAfter, findEpBefore, parseClpi, stcSpnRange, type Clpi } from '@seikou/bdmv/clpi-parser';
import { parseMpls, type PlayItem } from '@seikou/bdmv/mpls-parser';
import { PesAssembler, readTimestamp } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import type { AudioDecoder } from './audio-decoder';
import type { FansubDiscSource } from './disc-source';

const SOURCE_PACKET = 192;
const SAMPLES_PER_MS = 16;
/** PES stream_id_extension of the AC-3 core inside a Blu-ray TrueHD PID. */
const AC3_CORE_EXTENSION = 0x76;
/** The most of a play item's share of a window that decoded audio may leave empty (at its ends) before the window is refused. */
const MAX_UNCOVERED_MS = 2000;
const PTS_WRAP = 2 ** 33;
/** How far outside a window the byte range reaches, in 45 kHz ticks: audio is muxed a little before or after its video. */
const MARGIN_45 = 22_500;

/** 16 kHz mono PCM of one stretch of a playlist; `startMs` is the playlist time of `pcm[0]`. */
export interface AudioWindow {
  /** Where the stretch starts in the episode, in milliseconds. */
  readonly startMs: number;
  /** 16 kHz mono signed 16-bit samples. */
  readonly pcm: Int16Array;
}

/** A span of an episode's time, in milliseconds from its start. */
export interface TimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Up to six windows of a minute, evenly spread over the middle of an episode (the first and last minute and a half hold
 * openings, endings and previews): fewer and shorter ones (never under 30 s) when it is under nine minutes, the whole of it
 * when under three and a half.
 * @internal
 */
export function windowsFor(durationMs: number): TimeWindow[] {
  const margin = 90_000;
  const span = durationMs - 2 * margin;
  if (durationMs < 210_000 || span <= 0) return [{ fromMs: 0, toMs: durationMs }];
  const count = Math.max(1, Math.min(6, Math.floor(span / 30_000)));
  const length = Math.min(60_000, Math.floor(span / count));
  const step = count === 1 ? 0 : (span - length) / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const fromMs = margin + Math.round(i * step);
    return { fromMs, toMs: fromMs + length };
  });
}

/**
 * Hands bytes to a decoder: false once the decoder is gone (it exited, or its input closed), so the feeder stops.
 * @internal
 */
export type Write = (bytes: Uint8Array) => Promise<boolean>;

/**
 * Cuts an m2ts stream into whole source packets, drops the audio PID's packets before its first PES start, and reports
 * that PES's PTS. For TrueHD only the AC-3 core is wanted: the result is that core as a raw AC-3 stream (`core`), since
 * ffmpeg would take the PID for TrueHD and wait for a major sync, or map two streams.
 * Every audio PES's PTS is appended to `pesPts` (for `assertNoDecodeGap`); the packets go to `write`, and the first PES's
 * PTS is returned (null when the range holds none).
 * @internal
 */
export async function demuxAudioPid(stream: Readable, pid: number, core: boolean, write: Write, pesPts: number[], signal?: AbortSignal): Promise<number | null> {
  let carry: Buffer = Buffer.alloc(0);
  let firstPts: number | null = null;
  const cores: Uint8Array[] = [];
  const assembler = new PesAssembler((pes) => {
    if (pes.pts === undefined) return;
    const ac3 = pes.streamIdExtension === AC3_CORE_EXTENSION || (pes.streamIdExtension === undefined && pes.payload[0] === 0x0b && pes.payload[1] === 0x77);
    if (!ac3) return;
    firstPts ??= pes.pts;
    pesPts.push(pes.pts);
    cores.push(pes.payload);
  });
  const flushCores = async (): Promise<boolean> => {
    if (!cores.length) return true;
    const bytes = Buffer.concat(cores);
    cores.length = 0;
    return write(bytes);
  };
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (signal?.aborted) break;
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % SOURCE_PACKET);
    carry = bytes.subarray(whole);
    const kept: Buffer[] = [];
    for (let at = 0; at < whole; at += SOURCE_PACKET) {
      const p = parseSourcePacket(bytes, at);
      if (core) {
        if (p && p.pid === pid) assembler.push(p);
        continue;
      }
      if (p && p.pid === pid) {
        const pl = p.payload;
        const startsPes = p.payloadUnitStart && pl.length >= 14 && pl[0] === 0 && pl[1] === 0 && pl[2] === 1 && (pl[7] & 0x80) !== 0;
        if (startsPes) {
          const pts = readTimestamp(pl, 9);
          firstPts ??= pts;
          pesPts.push(pts);
        } else if (firstPts === null) {
          continue; // the tail of a PES that began before the range
        }
      }
      kept.push(bytes.subarray(at, at + SOURCE_PACKET));
    }
    if (core ? !(await flushCores()) : kept.length > 0 && !(await write(Buffer.concat(kept)))) break;
  }
  if (core) {
    assembler.flush();
    await flushCores();
  }
  return firstPts;
}

/**
 * Whether the decoded audio is as long as the PES timestamps say: ffmpeg gives decoded frames contiguous times whatever the
 * stream's timestamps are, so a frame it dropped (a damaged PES) would silently shift every later sample. Throws when
 * the decode is short of the span the PES packets cover (plus one PES, the last one's length) by more than two PES.
 * @internal
 */
export function assertNoDecodeGap(pesPts: readonly number[], decodedSamples: number, pid: number): void {
  if (pesPts.length < 3) return;
  const steps = pesPts.slice(1).map((p, i) => ((p - pesPts[i] + PTS_WRAP) % PTS_WRAP) / 90).sort((x, y) => x - y);
  const typical = steps[steps.length >> 1];
  const expectedMs = ((pesPts[pesPts.length - 1] - pesPts[0] + PTS_WRAP) % PTS_WRAP) / 90 + typical;
  const decodedMs = decodedSamples / SAMPLES_PER_MS;
  if (expectedMs - decodedMs > 2 * typical + 20) {
    throw new Error(`disc audio: PID 0x${pid.toString(16)} decoded ${Math.round(decodedMs)} ms of the ${Math.round(expectedMs)} ms its PES packets span (a damaged or lost packet)`);
  }
}

/**
 * 16 kHz mono PCM of windows of a playlist's audio stream (each play item's own STN entry number `audioIndex`, the first
 * by default), reading only the bytes each window needs (from the EP entry before it to the one after it, inside the play
 * item's STC sequence). A window is `[fromMs, toMs)` in playlist time, clamped to the playlist; `startMs` is its start,
 * exact to 10 ms: each decoded stretch is placed by the PTS of its first audio PES.
 * It throws, never returning silence for audio it could not read: when the stream isn't there, the decoder fails, frames were
 * lost inside a stretch (`assertNoDecodeGap`), or what was decoded leaves more than `MAX_UNCOVERED_MS` of a play item's share of the window empty.
 */
export async function episodeAudio(
  disc: FansubDiscSource,
  playlistId: string,
  windows: readonly TimeWindow[] | 'whole',
  decode: AudioDecoder,
  signal?: AbortSignal,
  options: { readonly audioIndex?: number } = {},
): Promise<AudioWindow[]> {
  const mplsBytes = await disc.readFile(`BDMV/PLAYLIST/${playlistId}.mpls`);
  if (!mplsBytes) throw new Error(`disc audio: no playlist ${playlistId}`);
  const mpls = parseMpls(mplsBytes);
  const items: Array<{ item: PlayItem; startMs: number; endMs: number }> = [];
  let at = 0;
  for (const item of mpls.playItems) {
    const ms = (item.outTime - item.inTime) / 45;
    items.push({ item, startMs: at, endMs: at + ms });
    at += ms;
  }
  const durationMs = at;
  const clpis = new Map<string, Clpi>();
  const clpiOf = async (clipId: string): Promise<Clpi> => {
    let clpi = clpis.get(clipId);
    if (!clpi) {
      const bytes = await disc.readFile(`BDMV/CLIPINF/${clipId}.clpi`);
      if (!bytes) throw new Error(`disc audio: no clip info ${clipId}`);
      clpi = parseClpi(bytes);
      clpis.set(clipId, clpi);
    }
    return clpi;
  };

  const spans = windows === 'whole' ? [{ fromMs: 0, toMs: durationMs }] : windows;
  const result: AudioWindow[] = [];
  for (const w of spans) {
    const fromMs = Math.max(0, w.fromMs);
    const toMs = Math.min(durationMs, w.toMs);
    const pcm = new Int16Array(Math.max(0, Math.round((toMs - fromMs) * SAMPLES_PER_MS)));
    for (const { item, startMs, endMs } of items) {
      const itemFrom = Math.max(fromMs, startMs);
      const itemTo = Math.min(toMs, endMs);
      if (itemFrom >= itemTo) continue;
      signal?.throwIfAborted();
      const audio = item.stn.audio[options.audioIndex ?? 0];
      if (!audio) throw new Error(`disc audio: playlist ${playlistId} has no audio stream ${options.audioIndex ?? 0} on clip ${item.clipId}`);
      const clpi = await clpiOf(item.clipId);
      const map = clpi.epMaps[0];
      const range = stcSpnRange(clpi, item.stcId);
      const clip = await disc.clip(`BDMV/STREAM/${item.clipId}.m2ts`);
      if (!clip) throw new Error(`disc audio: no clip ${item.clipId}`);
      const from45 = item.inTime + (itemFrom - startMs) * 45;
      const to45 = item.inTime + (itemTo - startMs) * 45;
      const first = map && findEpBefore(map, from45 - MARGIN_45, range);
      const last = map && findEpAfter(map, to45 + MARGIN_45, range);
      const fromByte = (first?.spn ?? (Number.isFinite(range.startSpn) ? range.startSpn : 0)) * SOURCE_PACKET;
      const toByte = (last?.spn ?? Math.min(range.endSpn, clpi.numSourcePackets)) * SOURCE_PACKET;
      // Lazy: the clip is opened only when the decoder starts consuming. A decoder may queue first (the server's waits for a
      // slot), and a stream opened then, with nobody listening, would hold a file open and crash the process on an open error.
      const read = Readable.from((async function* () { yield* clip.read(fromByte, toByte); })(), { objectMode: false });
      const decoded = await decode({ read, pid: audio.pid, coding: audio.codingType, ...(signal ? { signal } : {}) });
      // PTS of the first sample, as playlist time (33-bit wrap folded into the nearest side of the play item's in-time).
      let delta = (decoded.firstPts - item.inTime * 2) % PTS_WRAP;
      if (delta > PTS_WRAP / 2) delta -= PTS_WRAP;
      else if (delta < -PTS_WRAP / 2) delta += PTS_WRAP;
      const pieceStartMs = startMs + delta / 90;
      const pieceStart = Math.round((pieceStartMs - fromMs) * SAMPLES_PER_MS);
      const lo = Math.max(pieceStart, Math.round((itemFrom - fromMs) * SAMPLES_PER_MS), 0);
      const hi = Math.min(pieceStart + decoded.pcm.length, Math.round((itemTo - fromMs) * SAMPLES_PER_MS), pcm.length);
      const covers = (hi - lo) / SAMPLES_PER_MS;
      const wanted = itemTo - itemFrom;
      if (lo >= hi || wanted - covers > MAX_UNCOVERED_MS) {
        throw new Error(`disc audio: the audio of clip ${item.clipId} covers ${Math.round(covers)} of ${Math.round(wanted)} ms of the window`);
      }
      pcm.set(decoded.pcm.subarray(lo - pieceStart, hi - pieceStart), lo);
    }
    result.push({ startMs: fromMs, pcm });
  }
  return result;
}
