// SPDX-License-Identifier: LGPL-3.0-or-later
/** The disc's bitmap subtitle (PG) streams of one episode, copied into `S_HDMV/PGS` tracks without decoding. */
import { open } from 'node:fs/promises';
import type { ByteSource } from '@seikou/bdmv/byte-source';
import { findEpAfter, findEpBefore, stcSpnRange } from '@seikou/bdmv/clpi-parser';
import { M2tsReader } from '@seikou/bdmv/demux/m2ts-reader';
import type { MkvSubtitleTrack, SubtitleBlock } from '../mux/mkv-writer';
import { languageName } from '../plan/audio-streams';
import type { EpisodePlan, Segment } from '../plan/episodes';
import type { Playlist } from './playlist';

// A Blu-ray PG stream is a run of PES packets (ISO/IEC 13818-1 §2.4.3.6) on one PID, each holding whole PG
// segments with the PES's PTS as their presentation time. A segment is `segment_type` (8 bits), `segment_length`
// (16 bits) and that many bytes (libbluray graphics_processor.c, which `@seikou/pg` ports). The Matroska codec
// mapping of `S_HDMV/PGS` stores the segments as they are, so each PES payload becomes one block at its PTS.
//
// A display set's composition segment (PCS, type 0x16) opens with a video descriptor (width 16 bits, height 16
// bits, frame_rate 4 bits and 4 reserved) and then a composition descriptor (composition_number 16 bits,
// composition_state 2 bits and 6 reserved) (libbluray pg_decode.c, `pg_decode_video_descriptor` and
// `pg_decode_composition_descriptor`). Only an Epoch Start or an Acquisition Point carries everything a decoder
// needs to draw; a Normal display set updates objects of the epoch before it. So a track starts at its first
// Epoch Start or Acquisition Point, or a player would meet updates to objects it never saw.

/** PG `segment_type` of the presentation composition segment (PCS). */
const PCS_SEGMENT_TYPE = 0x16;
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

/** `d` folded into (-2^32, 2^32], the nearest way round the 33-bit PTS clock. */
function foldPts(d: number): number {
  const m = ((d % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
  return m > PTS_WRAP / 2 ? m - PTS_WRAP : m;
}

/** Whether a PES payload holds a PCS whose composition_state is Epoch Start or Acquisition Point. */
function startsEpochOrAcquisition(payload: Uint8Array): boolean {
  let at = 0;
  while (at + 3 <= payload.length) {
    const type = payload[at]!;
    const length = (payload[at + 1]! << 8) | payload[at + 2]!;
    if (type === PCS_SEGMENT_TYPE) {
      if (at + PCS_STATE_OFFSET >= payload.length) return false;
      const state = payload[at + PCS_STATE_OFFSET]! & 0xc0;
      return state === EPOCH_START || state === ACQUISITION_POINT;
    }
    at += 3 + length;
  }
  return false;
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

/**
 * Appends the blocks one segment of the episode contributes to each track. `tracks[i]` collects the PES of the
 * segment's item's i-th PG stream; `framesBefore` is the episode's frame count before this segment.
 */
async function readSegment(plan: EpisodePlan, segment: Segment, framesBefore: number, tracks: SubtitleBlock[][]): Promise<void> {
  const { item, videoFrames, videoFirstPts90 } = segment;
  const pids = item.pgPids.slice(0, tracks.length);
  if (pids.length === 0) return;
  const { fpsNum, fpsDen } = plan.video;
  const frame90 = (fpsDen * 90000) / fpsNum;
  const [firstFrame, endFrame] = videoFrames;
  // Where this segment sits on the episode's timeline, exactly (the video blocks round the same value).
  const segmentStartMs = (framesBefore * fpsDen * 1000) / fpsNum;

  const range = stcSpnRange(item.clpi, item.stcId);
  const map = item.clpi.epMaps[0];
  const start45 = (((videoFirstPts90 + firstFrame * frame90) % PTS_WRAP) / 2) - LEAD_45;
  const end45 = (((videoFirstPts90 + endFrame * frame90) % PTS_WRAP) / 2) + TAIL_45;
  const fromEp = map && findEpBefore(map, start45, range);
  const toEp = map && findEpAfter(map, end45, range);
  const fromSpn = fromEp?.spn ?? (Number.isFinite(range.startSpn) ? range.startSpn : 0);
  const toSpn = toEp?.spn ?? Math.min(range.endSpn, item.clpi.numSourcePackets);

  // A clip boundary is a new timeline for a PG decoder, so each segment waits for its own epoch start.
  const epochSeen = pids.map(() => false);
  const clip = await openClip(item.m2tsPath);
  try {
    const reader = new M2tsReader({ source: clip.source, path: item.m2tsPath, startSpn: fromSpn, endSpn: Math.max(fromSpn, toSpn), pids: new Set(pids) });
    for (let batch = await reader.next(); batch !== null; batch = await reader.next()) {
      for (const pes of batch) {
        if (pes.pts === undefined) continue;
        const track = pids.indexOf(pes.pid);
        if (track < 0) continue;
        const rel90 = foldPts(pes.pts - videoFirstPts90);
        // The frame a display set belongs to is the nearest one, as the planner rounds chapter marks; so a set at a
        // chapter mark is the episode's even when the mark lies just before its first frame.
        const frame = Math.round(rel90 / frame90);
        if (frame < firstFrame || frame >= endFrame) continue;
        if (!epochSeen[track]) {
          if (!startsEpochOrAcquisition(pes.payload)) continue;
          epochSeen[track] = true;
        }
        const withinMs = Math.max(0, (rel90 - firstFrame * frame90) / 90);
        tracks[track]!.push({ timeMs: Math.round(segmentStartMs + withinMs), data: pes.payload.slice() });
      }
    }
  } finally {
    await clip.close();
  }
}

/**
 * The disc's PG (bitmap subtitle) streams for one episode, as `S_HDMV/PGS` tracks for `writeMkv`'s `subtitles`.
 * There is one track per main-path PG stream in the STN table of `playlist`'s first play item, in STN order, named
 * `<Language> (disc)` (`English (disc)`) with the STN language (`und` when it gives none), never default and with
 * no CodecPrivate; an episode where a stream shows nothing still gets its (empty) track, so every episode of a
 * playlist has the same tracks. `plan` must come from `planEpisodes` on the same playlist.
 *
 * Each PES of a stream becomes one block holding its payload unchanged (the stream's PG segments; the Matroska
 * codec mapping of `S_HDMV/PGS`), at its PTS measured from the episode's first video frame, in whole milliseconds
 * rounded to the nearest. A segment of a later clip is placed after the frames before it, so the times share the
 * video blocks' zero. Which PES belong to the episode follows the planner's rounding: a PES belongs to the frame
 * nearest its PTS (the 33-bit wrap folded the nearest way round), and is kept when that frame is one the episode
 * plays; one just before the first frame is clamped to that frame's time. In each clip the episode touches, a
 * stream's PES before its first composition segment (type 0x16) whose composition_state is Epoch Start or
 * Acquisition Point are dropped, since a player could not draw them.
 *
 * Reads only the bytes each segment needs: from the EP map entry 10 s before the segment's first frame to the one
 * after its end, within the play item's STC sequence. Rejects when a clip cannot be read.
 */
export async function episodePgsTracks(plan: EpisodePlan, playlist: Playlist): Promise<MkvSubtitleTrack[]> {
  const first = playlist.items[0];
  if (first === undefined || first.pgPids.length === 0) return [];
  const blocks: SubtitleBlock[][] = first.pgPids.map(() => []);
  let framesBefore = 0;
  for (const segment of plan.segments) {
    await readSegment(plan, segment, framesBefore, blocks);
    framesBefore += segment.videoFrames[1] - segment.videoFrames[0];
  }
  return first.pgPids.map((_, i) => {
    const language = first.pgLanguages[i] || 'und';
    // Stable: PES of one stream come in decode order, which is presentation order; equal times keep it.
    const sorted = [...blocks[i]!].sort((a, b) => a.timeMs - b.timeMs);
    return { codecId: 'S_HDMV/PGS', name: `${languageName(language)} (disc)`, language, isDefault: false, blocks: sorted };
  });
}
