// SPDX-License-Identifier: LGPL-3.0-or-later
import { open } from 'node:fs/promises';
import type { ProgramStream } from 'seikou/engine/bdmv/clpi-parser';
import { PesAssembler } from 'seikou/engine/demux/pes-assembler';
import { parseSourcePacket } from 'seikou/engine/demux/ts-packet';
import type { PlaylistItem } from './playlist';
import { audioChannels, audioRate, videoFormat, videoRate } from './stream-codes';

const SOURCE_PACKET_SIZE = 192;
/** Read size: a multiple of the source packet size. */
const CHUNK_SIZE = SOURCE_PACKET_SIZE * 512;

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
async function firstPtsByPid(item: PlaylistItem, pids: readonly number[]): Promise<Map<number, number>> {
  const wanted = new Set(pids);
  const found = new Map<number, number>();
  const assembler = new PesAssembler((pes) => {
    if (wanted.has(pes.pid) && !found.has(pes.pid) && pes.pts !== undefined) found.set(pes.pid, pes.pts);
  });

  const file = await open(item.m2tsPath, 'r');
  try {
    const buf = new Uint8Array(CHUNK_SIZE);
    let carried = 0; // bytes of a partial packet at the start of buf
    while (found.size < wanted.size) {
      const { bytesRead } = await file.read(buf, carried, CHUNK_SIZE - carried, null);
      if (bytesRead === 0) break;
      const available = carried + bytesRead;
      const whole = available - (available % SOURCE_PACKET_SIZE);
      for (let off = 0; off < whole && found.size < wanted.size; off += SOURCE_PACKET_SIZE) {
        const packet = parseSourcePacket(buf, off);
        if (packet !== null) assembler.push(packet);
      }
      carried = available - whole;
      buf.copyWithin(0, whole, available);
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

export async function probeClip(item: PlaylistItem): Promise<ClipProbe> {
  const videoStream = findStream(item, item.videoPid);
  const audioStreams = item.audioPids.map((pid) => findStream(item, pid));
  const firstPts = await firstPtsByPid(item, [item.videoPid, ...item.audioPids]);

  const video: VideoProbe = {
    pid: item.videoPid,
    firstPts90: firstPts.get(item.videoPid)!,
    ...videoRate(videoStream.rate),
    ...videoFormat(videoStream.format),
    codingType: videoStream.codingType,
  };
  const audio: AudioProbe[] = audioStreams.map((s) => ({
    pid: s.pid,
    firstPts90: firstPts.get(s.pid)!,
    sampleRate: audioRate(s.rate),
    channels: audioChannels(s.format),
    codingType: s.codingType,
  }));
  return { clipId: item.clipId, video, audio };
}
