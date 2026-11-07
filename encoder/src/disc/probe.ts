// SPDX-License-Identifier: LGPL-3.0-or-later
import { open } from 'node:fs/promises';
import type { ProgramStream } from '@seikou/bdmv/clpi-parser';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import type { PlaylistItem } from './playlist';
import { audioChannels, audioRate, videoFormat, videoRate } from './stream-codes';

const SOURCE_PACKET_SIZE = 192;

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

export interface VideoProbe {
  pid: number;
  firstPts90: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  interlaced: boolean;
  codingType: number;
}

export interface AudioProbe {
  pid: number;
  firstPts90: number;
  sampleRate: number;
  channels: number;
  codingType: number;
}

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
