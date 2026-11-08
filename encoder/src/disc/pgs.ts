// SPDX-License-Identifier: LGPL-3.0-or-later
/** The disc's bitmap subtitle (PG) streams of one episode, copied into `S_HDMV/PGS` tracks without decoding. */
import { open } from 'node:fs/promises';
import type { ByteSource } from '@seikou/bdmv/byte-source';
import { findEpAfter, findEpBefore, stcSpnRange } from '@seikou/bdmv/clpi-parser';
import { M2tsReader } from '@seikou/bdmv/demux/m2ts-reader';
import type { MkvSubtitleTrack, SubtitleBlock } from '@seikou/matroska';
import { languageName } from '../plan/audio-streams';
import type { EpisodePlan, Segment } from '../plan/episodes';
import type { Playlist, PlaylistItem } from './playlist';

// A Blu-ray PG stream is a run of PES packets (ISO/IEC 13818-1 §2.4.3.6) on one PID, each holding whole PG
// segments. A segment is `segment_type` (8 bits), `segment_length` (16 bits) and that many bytes (libbluray
// graphics_processor.c, which `@seikou/pg` ports). A display set is the segments from a presentation composition
// segment (PCS, type 0x16) up to and including the next END segment (type 0x80), in stream order. Each segment's
// PES has its own PTS, and only the PCS's is the display set's presentation time: the window, palette and object
// segments carry decode timing, usually earlier (libbluray's graphics processor keys a display set on the PCS PTS).
// The Matroska codec mapping of `S_HDMV/PGS` stores the segments of one display set per block, unchanged, so a
// display set's PES payloads are joined into one block at the PCS's PTS.
//
// A PCS opens with a video descriptor (width 16 bits, height 16 bits, frame_rate 4 bits and 4 reserved) and then a
// composition descriptor (composition_number 16 bits, composition_state 2 bits and 6 reserved) (libbluray
// pg_decode.c, `pg_decode_video_descriptor` and `pg_decode_composition_descriptor`). Only an Epoch Start or an
// Acquisition Point carries everything a decoder needs to draw; a Normal display set updates objects of the epoch
// before it. So a track starts at its first Epoch Start or Acquisition Point, or a player would meet updates to
// objects it never saw.

/** PG `segment_type` of the presentation composition segment (PCS). */
const PCS_SEGMENT_TYPE = 0x16;
/** PG `segment_type` of the END segment, the last of a display set. */
const END_SEGMENT_TYPE = 0x80;
/** Offset of the composition_state byte in a PCS, from the segment's first byte: the 3-byte header, the 5-byte video descriptor, composition_number. */
const PCS_STATE_OFFSET = 3 + 5 + 2;
/** composition_state in the top two bits of its byte: Epoch Start and Acquisition Point. */
const EPOCH_START = 0x80;
const ACQUISITION_POINT = 0x40;
/** PTS is 33 bits (ISO/IEC 13818-1 §2.4.3.7), so it wraps after 2^33 ticks. */
const PTS_WRAP = 2 ** 33;
/**
 * How far before an episode's part of a clip the read starts, in 45 kHz ticks (10 s): a display set's PES is muxed
 * ahead of its presentation time, so one shown at the part's first frame can lie well before that frame's bytes.
 */
const LEAD_45 = 450_000;
/** How far after the part's end the read goes, in 45 kHz ticks (1 s): the EP entry after the end, plus a margin. */
const TAIL_45 = 45_000;
/** PlayItem connection_condition values of a seamless join, across which a PG decoder keeps its epoch. */
const SEAMLESS_CONNECTIONS = new Set([5, 6]);

/** `d` folded into (-2^32, 2^32], the nearest way round the 33-bit PTS clock. */
function foldPts(d: number): number {
  const m = ((d % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
  return m > PTS_WRAP / 2 ? m - PTS_WRAP : m;
}

/** The types of the segments a PES payload holds, in order. */
function segmentTypes(payload: Uint8Array): number[] {
  const types: number[] = [];
  let at = 0;
  while (at + 3 <= payload.length) {
    types.push(payload[at]!);
    at += 3 + ((payload[at + 1]! << 8) | payload[at + 2]!);
  }
  return types;
}

/** The composition_state bits of the PCS a payload starts with, or null when it does not start with a whole one. */
function pcsState(payload: Uint8Array): number | null {
  if (payload[0] !== PCS_SEGMENT_TYPE || payload.length <= PCS_STATE_OFFSET) return null;
  return payload[PCS_STATE_OFFSET]! & 0xc0;
}

/** One PES of a PG stream, as `groupDisplaySets` takes it: its PTS (90 kHz) when it has one, and its payload. */
export interface PgPes {
  pts?: number;
  payload: Uint8Array;
}

/** One complete PG display set: what an `S_HDMV/PGS` block holds. */
export interface PgDisplaySet {
  /** The PCS's PTS in 90 kHz ticks: the display set's presentation time. */
  pts90: number;
  /** Whether the PCS's composition_state is Epoch Start (0x80) or Acquisition Point (0x40): a decoder can draw it from nothing. */
  startsEpoch: boolean;
  /** Every segment of the display set, PCS first and END last, joined in stream order (a fresh copy). */
  data: Uint8Array;
}

/**
 * Groups one PG stream's PES, in stream order, into display sets: each runs from a PES whose payload starts with a
 * PCS (segment type 0x16) up to and including the PES that holds the END segment (type 0x80), whatever PTS the PES
 * in between carry, and is timed at the PCS's PTS. PES before the first PCS (the tail of a display set the read
 * began inside), a display set whose PCS has no PTS, and a last one with no END are left out; a PCS met before the
 * END of the set before it starts a new set and drops the unfinished one.
 */
export function groupDisplaySets(pes: Iterable<PgPes>): PgDisplaySet[] {
  const sets: PgDisplaySet[] = [];
  let current: { pts90: number | undefined; startsEpoch: boolean; parts: Uint8Array[] } | null = null;
  for (const p of pes) {
    const state = pcsState(p.payload);
    if (state !== null) {
      current = { pts90: p.pts, startsEpoch: state === EPOCH_START || state === ACQUISITION_POINT, parts: [] };
    }
    if (current === null) continue;
    current.parts.push(p.payload);
    if (segmentTypes(p.payload).includes(END_SEGMENT_TYPE)) {
      if (current.pts90 !== undefined) {
        const data = new Uint8Array(current.parts.reduce((n, part) => n + part.length, 0));
        let at = 0;
        for (const part of current.parts) {
          data.set(part, at);
          at += part.length;
        }
        sets.push({ pts90: current.pts90, startsEpoch: current.startsEpoch, data });
      }
      current = null;
    }
  }
  return sets;
}

/**
 * For each track (a PG stream of the playlist's first play item, by STN position), the PID that carries it in
 * `item`: the stream at the same STN position when its language agrees, else the first of `item`'s streams in that
 * language not already taken, else none (null), which `log` reports.
 */
function pidsForItem(first: PlaylistItem, item: PlaylistItem, log: (message: string) => void): (number | null)[] {
  if (item === first) return [...first.pgPids];
  const taken = new Set<number>();
  const wanted = first.pgLanguages.map((language, i) => ({ language, i }));
  const result: (number | null)[] = wanted.map(() => null);
  for (const { language, i } of wanted) {
    if (item.pgPids[i] !== undefined && item.pgLanguages[i] === language) {
      result[i] = i;
      taken.add(i);
    }
  }
  for (const { language, i } of wanted) {
    if (result[i] !== null) continue;
    const j = item.pgLanguages.findIndex((l, k) => l === language && !taken.has(k));
    if (j >= 0) {
      result[i] = j;
      taken.add(j);
    } else {
      log(`Play item ${item.index} (clip ${item.clipId}) has no PG stream in ${language || 'und'}; PG track ${i + 1} shows nothing there`);
    }
  }
  return result.map((j) => (j === null ? null : item.pgPids[j]!));
}

/** A `ByteSource` over one open file, all `M2tsReader` needs. */
async function openClip(path: string): Promise<{ source: ByteSource; close: () => Promise<void> }> {
  const file = await open(path, 'r');
  const { size } = await file.stat();
  const source: ByteSource = {
    exists: (p) => p === path,
    size: () => size,
    list: () => [],
    read: async (_p, offset, length) => {
      // A fresh buffer per read: the PES assembler keeps views into packets until a PES is complete.
      const buf = new Uint8Array(length);
      const { bytesRead } = await file.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    },
  };
  return { source, close: () => file.close() };
}

/** Every PES of `pids` in the bytes one segment of the episode needs, per PID in stream order. */
async function readSegmentPes(segment: Segment, frame90: number, pids: readonly number[]): Promise<Map<number, PgPes[]>> {
  const { item, videoFrames, videoFirstPts90 } = segment;
  const range = stcSpnRange(item.clpi, item.stcId);
  const map = item.clpi.epMaps[0];
  const start45 = ((videoFirstPts90 + videoFrames[0] * frame90) % PTS_WRAP) / 2 - LEAD_45;
  const end45 = ((videoFirstPts90 + videoFrames[1] * frame90) % PTS_WRAP) / 2 + TAIL_45;
  const fromEp = map && findEpBefore(map, start45, range);
  const toEp = map && findEpAfter(map, end45, range);
  const fromSpn = fromEp?.spn ?? (Number.isFinite(range.startSpn) ? range.startSpn : 0);
  const toSpn = toEp?.spn ?? Math.min(range.endSpn, item.clpi.numSourcePackets);

  const byPid = new Map<number, PgPes[]>(pids.map((pid) => [pid, []]));
  const clip = await openClip(item.m2tsPath);
  try {
    const reader = new M2tsReader({ source: clip.source, path: item.m2tsPath, startSpn: fromSpn, endSpn: Math.max(fromSpn, toSpn), pids: new Set(pids) });
    for (let batch = await reader.next(); batch !== null; batch = await reader.next()) {
      for (const pes of batch) byPid.get(pes.pid)?.push({ ...(pes.pts !== undefined ? { pts: pes.pts } : {}), payload: pes.payload });
    }
  } finally {
    await clip.close();
  }
  return byPid;
}

/**
 * The disc's PG (bitmap subtitle) streams for one episode, as `S_HDMV/PGS` tracks for `writeMkv`'s `subtitles`.
 * There is one track per main-path PG stream in the STN table of `playlist`'s first play item, in STN order, named
 * `<Language> (disc)` (`English (disc)`) with the STN language (`und` when it gives none), never default and with
 * no CodecPrivate; an episode where a stream shows nothing still gets its (empty) track, so every episode of a
 * playlist has the same tracks. `plan` must come from `planEpisodes` on the same playlist. In a later play item a
 * track takes the stream at its STN position when the language agrees, else the item's first other stream in that
 * language; when the item has none, `log` is called once with a line naming the item and the track shows nothing
 * there.
 *
 * Each display set (`groupDisplaySets`) becomes one block holding its segments unchanged (the Matroska codec mapping
 * of `S_HDMV/PGS`), at its PCS's PTS measured from the episode's first video frame, in whole milliseconds rounded to
 * the nearest. A segment of a later clip is placed after the frames before it, so the times share the video blocks'
 * zero. Which display sets belong to the episode follows the planner's rounding: a display set belongs to the frame
 * nearest its PTS (the 33-bit wrap folded the nearest way round), and is kept when that frame is one the episode
 * plays; one just before the first frame is clamped to that frame's time. A stream's display sets are dropped until
 * its first Epoch Start or Acquisition Point, counted from the episode's start and again from the start of every
 * later play item that does not join its predecessor seamlessly (connection_condition other than 5 or 6), since a
 * player could not draw them; across a seamless join the epoch carries on.
 *
 * Reads only the bytes each segment needs: from the EP map entry 10 s before the segment's first frame to the one
 * after its end, within the play item's STC sequence. Rejects when a clip cannot be read.
 */
export async function episodePgsTracks(
  plan: EpisodePlan,
  playlist: Playlist,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<MkvSubtitleTrack[]> {
  const first = playlist.items[0];
  if (first === undefined || first.pgPids.length === 0) return [];
  const { fpsNum, fpsDen } = plan.video;
  const frame90 = (fpsDen * 90000) / fpsNum;
  const blocks: SubtitleBlock[][] = first.pgPids.map(() => []);
  const epochSeen = first.pgPids.map(() => false);
  let framesBefore = 0;
  for (const [s, segment] of plan.segments.entries()) {
    const { item, videoFrames, videoFirstPts90 } = segment;
    if (s > 0 && !SEAMLESS_CONNECTIONS.has(item.connectionCondition)) epochSeen.fill(false);
    const pids = pidsForItem(first, item, log);
    const present = pids.filter((pid): pid is number => pid !== null);
    const byPid = present.length > 0 ? await readSegmentPes(segment, frame90, present) : new Map<number, PgPes[]>();
    // Where this segment sits on the episode's timeline, exactly (the video blocks round the same value).
    const segmentStartMs = (framesBefore * fpsDen * 1000) / fpsNum;
    for (const [track, pid] of pids.entries()) {
      if (pid === null) continue;
      for (const set of groupDisplaySets(byPid.get(pid) ?? [])) {
        const rel90 = foldPts(set.pts90 - videoFirstPts90);
        // The nearest frame, as the planner rounds chapter marks: a set at a chapter mark is the episode's even
        // when the mark lies just before its first frame.
        const frame = Math.round(rel90 / frame90);
        if (frame < videoFrames[0] || frame >= videoFrames[1]) continue;
        if (!epochSeen[track]) {
          if (!set.startsEpoch) continue;
          epochSeen[track] = true;
        }
        const withinMs = Math.max(0, (rel90 - videoFrames[0] * frame90) / 90);
        blocks[track]!.push({ timeMs: Math.round(segmentStartMs + withinMs), data: set.data });
      }
    }
    framesBefore += videoFrames[1] - videoFrames[0];
  }
  return first.pgPids.map((_, i) => {
    const language = first.pgLanguages[i] || 'und';
    // Display sets come in presentation order on any sound stream; the stable sort keeps one that does not from
    // failing the whole episode in the writer, and moves whole display sets, never their segments.
    const sorted = [...blocks[i]!].sort((a, b) => a.timeMs - b.timeMs);
    return { codecId: 'S_HDMV/PGS', name: `${languageName(language)} (disc)`, language, isDefault: false, blocks: sorted };
  });
}
