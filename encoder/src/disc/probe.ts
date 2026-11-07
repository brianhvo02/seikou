// SPDX-License-Identifier: LGPL-3.0-or-later
import { open } from 'node:fs/promises';
import type { ProgramStream } from '@seikou/bdmv/clpi-parser';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import type { PlaylistItem } from './playlist';
import { audioChannels, audioRate, videoFormat, videoRate } from './stream-codes';

// An m2ts file is a sequence of 192-byte source packets: a 4-byte header (a 2-bit copy-permission
// indicator and a 30-bit arrival timestamp) followed by one 188-byte MPEG-2 transport packet
// (ISO/IEC 13818-1 §2.4.3.2).
const SOURCE_PACKET_SIZE = 192;

/** Thrown when a clip's streams cannot be described: a PID missing from the CLPI, or no PES with a timestamp. */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** What the clip-info file and the first video PES say about a clip's video. */
export interface VideoProbe {
  pid: number;
  /** PTS of the first video PES, in 90 kHz ticks (ISO/IEC 13818-1 §2.4.3.7: 33 bits, so it wraps after about 26.5 hours). */
  firstPts90: number;
  /** Frame rate as a fraction, from the stream's `video_rate` code. */
  fpsNum: number;
  fpsDen: number;
  /** Frame size from the stream's `video_format` code. */
  width: number;
  height: number;
  interlaced: boolean;
  /** CLPI stream coding type (0x1b is H.264, 0x24 HEVC, 0x02 MPEG-2, 0xea VC-1). */
  codingType: number;
}

/** What the clip-info file and the first audio PES say about one audio stream. */
export interface AudioProbe {
  pid: number;
  /** PTS of the first PES of this stream, in 90 kHz ticks. */
  firstPts90: number;
  /** Hz, from the stream's audio rate code. */
  sampleRate: number;
  channels: number;
  /** CLPI stream coding type (0x80 LPCM, 0x81 AC-3, 0x82 DTS, 0x83 TrueHD, 0x84 E-AC-3, 0x85 and 0x86 DTS-HD). */
  codingType: number;
}

/** A probed clip: its video stream and its main-path audio streams in playlist order. */
export interface ClipProbe {
  clipId: string;
  video: VideoProbe;
  audio: AudioProbe[];
}

function findStream(item: PlaylistItem, pid: number): ProgramStream {
  for (const program of item.clpi.programs) {
    const stream = program.streams.find((s) => s.pid === pid);
    if (stream !== undefined) return stream;
  }
  throw new ProbeError(`Clip ${item.clipId}: PID ${pid} has no stream entry in the CLPI`);
}

/** Reads the m2ts just far enough to get the first PTS of each wanted PID. */
async function firstPtsByPid(item: PlaylistItem, pids: readonly number[], chunkPackets: number): Promise<Map<number, number>> {
  const wanted = new Set(pids);
  const found = new Map<number, number>();
  const assembler = new PesAssembler((pes) => {
    if (wanted.has(pes.pid) && !found.has(pes.pid) && pes.pts !== undefined) found.set(pes.pid, pes.pts);
  });

  const file = await open(item.m2tsPath, 'r');
  try {
    const chunkSize = SOURCE_PACKET_SIZE * chunkPackets;
    let tail = new Uint8Array(0); // partial packet left over from the previous chunk
    while (found.size < wanted.size) {
      // A fresh buffer per chunk: the assembler keeps views into packet payloads, so a buffer must never be reused.
      const buf = new Uint8Array(chunkSize);
      buf.set(tail);
      const { bytesRead } = await file.read(buf, tail.length, chunkSize - tail.length, null);
      if (bytesRead === 0) break;
      const available = tail.length + bytesRead;
      const whole = available - (available % SOURCE_PACKET_SIZE);
      for (let off = 0; off < whole && found.size < wanted.size; off += SOURCE_PACKET_SIZE) {
        const packet = parseSourcePacket(buf, off);
        if (packet !== null) assembler.push(packet);
      }
      tail = buf.slice(whole, available);
    }
    if (found.size < wanted.size) assembler.flush();
  } finally {
    await file.close();
  }

  for (const pid of wanted) {
    if (!found.has(pid)) throw new ProbeError(`Clip ${item.clipId}: no PES with a PTS found for PID ${pid}`);
  }
  return found;
}

/**
 * Describes one play item's clip. Stream attributes come from the CLPI; the first PTS of each
 * stream comes from reading the start of the m2ts (the CLPI does not hold it), and the PTS values
 * are what let the planner place audio relative to video. `chunkPackets` is the read size in
 * source packets (only the memory/speed trade-off; the result does not depend on it). Rejects
 * with `ProbeError` when a stream has no CLPI entry or never shows a PTS before the file ends.
 */
export async function probeClip(item: PlaylistItem, chunkPackets = 512): Promise<ClipProbe> {
  const videoStream = findStream(item, item.videoPid);
  const audioStreams = item.audioPids.map((pid) => findStream(item, pid));
  const firstPts = await firstPtsByPid(item, [item.videoPid, ...item.audioPids], chunkPackets);
  const ptsOf = (pid: number): number => {
    const pts = firstPts.get(pid);
    if (pts === undefined) throw new ProbeError(`Clip ${item.clipId}: no first PTS for PID ${pid}`);
    return pts;
  };

  const video: VideoProbe = {
    pid: item.videoPid,
    firstPts90: ptsOf(item.videoPid),
    ...videoRate(videoStream.rate),
    ...videoFormat(videoStream.format),
    codingType: videoStream.codingType,
  };
  const audio: AudioProbe[] = audioStreams.map((s) => ({
    pid: s.pid,
    firstPts90: ptsOf(s.pid),
    sampleRate: audioRate(s.rate),
    channels: audioChannels(s.format),
    codingType: s.codingType,
  }));
  return { clipId: item.clipId, video, audio };
}
