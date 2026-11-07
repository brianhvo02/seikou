// SPDX-License-Identifier: LGPL-3.0-or-later
import { open, type FileHandle } from 'node:fs/promises';
import { frameDurationNs, framesToNs, videoMs } from '../plan/timing';
import {
  ascii,
  binary,
  concat,
  float64,
  idBytes,
  master,
  sint,
  uint,
  utf8,
  vint,
  vintFixed8,
  voidElement,
} from './ebml';
import type { Av1Packet } from './ivf';
import { Id } from './mkv-ids';
import type { OpusPacket } from './ogg';

export interface VideoTrackInfo {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  codecPrivate: Uint8Array;
}

export interface AudioTrackInfo {
  channels: number;
  sampleRate: number;
  codecPrivate: Uint8Array;
  codecDelayNs: bigint;
  seekPreRollNs: bigint;
  language: string;
}

export interface MkvChapter {
  title: string;
  startNs: bigint;
}

export interface MkvInput {
  title?: string;
  video: VideoTrackInfo;
  audio: AudioTrackInfo;
  videoPackets: AsyncIterable<Av1Packet>;
  audioPackets: AsyncIterable<OpusPacket>;
  audioEnd: Promise<{ discardPadding48: number }>;
  chapters: MkvChapter[];
}

export interface MkvResult {
  durationNs: bigint;
  videoPackets: number;
  audioPackets: number;
  clusters: number;
}

const SEEK_HEAD_SIZE = 160;
const APP_NAME = 'encoding-tools';
const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;
const MAX_REL_TS = 32767;
const MIN_REL_TS = -32768;

interface OpenCluster {
  startPos: number;
  timestamp: number;
  parts: Uint8Array[];
  bytes: number;
}

class PositionalWriter {
  pos = 0;

  constructor(private readonly fh: FileHandle) {}

  async writeAt(data: Uint8Array, position: number): Promise<void> {
    let done = 0;
    while (done < data.length) {
      const { bytesWritten } = await this.fh.write(data, done, data.length - done, position + done);
      done += bytesWritten;
    }
  }

  async append(data: Uint8Array): Promise<void> {
    await this.writeAt(data, this.pos);
    this.pos += data.length;
  }
}

function blockPayload(track: number, relTs: number, flags: number, data: Uint8Array): Uint8Array {
  if (relTs < MIN_REL_TS || relTs > MAX_REL_TS) {
    throw new RangeError(`block timestamp ${relTs} ms does not fit the cluster's int16 range`);
  }
  const head = new Uint8Array(4);
  head[0] = 0x80 | track;
  new DataView(head.buffer).setInt16(1, relTs, false);
  head[3] = flags;
  return concat([head, data]);
}

function audioMs(pts48: number): number {
  return Math.round(pts48 / 48);
}

function trackEntries(input: MkvInput): Uint8Array {
  const { video, audio } = input;
  return master(Id.Tracks, [
    master(Id.TrackEntry, [
      uint(Id.TrackNumber, VIDEO_TRACK),
      uint(Id.TrackUID, 1),
      uint(Id.TrackType, 1),
      ascii(Id.CodecID, 'V_AV1'),
      binary(Id.CodecPrivate, video.codecPrivate),
      uint(Id.DefaultDuration, frameDurationNs(video)),
      master(Id.Video, [uint(Id.PixelWidth, video.width), uint(Id.PixelHeight, video.height)]),
    ]),
    master(Id.TrackEntry, [
      uint(Id.TrackNumber, AUDIO_TRACK),
      uint(Id.TrackUID, 2),
      uint(Id.TrackType, 2),
      ascii(Id.CodecID, 'A_OPUS'),
      binary(Id.CodecPrivate, audio.codecPrivate),
      uint(Id.CodecDelay, audio.codecDelayNs),
      uint(Id.SeekPreRoll, audio.seekPreRollNs),
      ascii(Id.Language, audio.language),
      master(Id.Audio, [float64(Id.SamplingFrequency, audio.sampleRate), uint(Id.Channels, audio.channels)]),
    ]),
  ]);
}

function chaptersElement(chapters: readonly MkvChapter[]): Uint8Array {
  return master(Id.Chapters, [
    master(Id.EditionEntry, [
      uint(Id.EditionUID, 1),
      uint(Id.EditionFlagDefault, 1),
      ...chapters.map((c, i) =>
        master(Id.ChapterAtom, [
          uint(Id.ChapterUID, i + 1),
          uint(Id.ChapterTimeStart, c.startNs),
          uint(Id.ChapterFlagEnabled, 1),
          master(Id.ChapterDisplay, [utf8(Id.ChapString, c.title), ascii(Id.ChapLanguage, 'und')]),
        ]),
      ),
    ]),
  ]);
}

function ebmlHeader(): Uint8Array {
  return master(Id.EBML, [
    uint(Id.EBMLVersion, 1),
    uint(Id.EBMLReadVersion, 1),
    uint(Id.EBMLMaxIDLength, 4),
    uint(Id.EBMLMaxSizeLength, 8),
    ascii(Id.DocType, 'matroska'),
    uint(Id.DocTypeVersion, 4),
    uint(Id.DocTypeReadVersion, 2),
  ]);
}

/** Reads one packet ahead so the last one is known before it is written. */
class Lookahead<T> {
  private readonly it: AsyncIterator<T>;
  current: T | null = null;
  private upcoming: T | null = null;

  constructor(source: AsyncIterable<T>) {
    this.it = source[Symbol.asyncIterator]();
  }

  private async pull(): Promise<T | null> {
    const r = await this.it.next();
    return r.done === true ? null : r.value;
  }

  async prime(): Promise<void> {
    this.current = await this.pull();
    this.upcoming = this.current === null ? null : await this.pull();
  }

  /** True when `current` is the final element. */
  get currentIsLast(): boolean {
    return this.current !== null && this.upcoming === null;
  }

  async advance(): Promise<void> {
    this.current = this.upcoming;
    this.upcoming = this.current === null ? null : await this.pull();
  }
}

export async function writeMkv(path: string, input: MkvInput): Promise<MkvResult> {
  const { video, audio } = input;
  const fh = await open(path, 'w');
  try {
    const w = new PositionalWriter(fh);
    await w.append(ebmlHeader());
    await w.append(idBytes(Id.Segment));
    const segmentSizePos = w.pos;
    await w.append(vintFixed8(0));
    const base = w.pos; // all SeekPosition / CueClusterPosition values are relative to this

    const seekHeadPos = w.pos;
    await w.append(voidElement(SEEK_HEAD_SIZE));

    const infoPos = w.pos - base;
    const infoChildren = [
      uint(Id.TimestampScale, 1_000_000),
      float64(Id.Duration, 0),
      ascii(Id.MuxingApp, APP_NAME),
      ascii(Id.WritingApp, APP_NAME),
      ...(input.title !== undefined ? [utf8(Id.Title, input.title)] : []),
    ];
    const info = master(Id.Info, infoChildren);
    const infoPrefix = info.length - infoChildren.reduce((n, c) => n + c.length, 0);
    // Duration payload sits after its 2-byte id and 1-byte size.
    const durationPayloadPos = w.pos + infoPrefix + infoChildren[0]!.length + 3;
    await w.append(info);

    const tracksPos = w.pos - base;
    await w.append(trackEntries(input));

    let chaptersPos: number | null = null;
    if (input.chapters.length > 0) {
      chaptersPos = w.pos - base;
      await w.append(chaptersElement(input.chapters));
    }

    const cues: { ms: number; clusterPos: number }[] = [];
    let cluster: OpenCluster | null = null;
    let clusters = 0;
    let videoCount = 0;
    let audioCount = 0;
    let lastVideoIndex = -1;
    let lastAudioEndNs = 0n;

    const closeCluster = async (): Promise<void> => {
      if (cluster === null) return;
      const ts = uint(Id.Timestamp, cluster.timestamp);
      const header = concat([idBytes(Id.Cluster), vintFixed8(ts.length + cluster.bytes), ts]);
      await w.writeAt(concat([header, ...cluster.parts]), cluster.startPos);
      w.pos = cluster.startPos + header.length + cluster.bytes;
      cluster = null;
    };
    const addToCluster = (c: OpenCluster, el: Uint8Array): void => {
      c.parts.push(el);
      c.bytes += el.length;
    };

    const vIter = input.videoPackets[Symbol.asyncIterator]();
    const aLook = new Lookahead(input.audioPackets);
    await aLook.prime();
    let vCur = await vIter.next();

    while (vCur.done !== true || aLook.current !== null) {
      const v = vCur.done === true ? null : vCur.value;
      const a = aLook.current;
      const useVideo = v !== null && (a === null || cluster === null || videoMs(v.index, video) <= audioMs(a.pts48));
      if (useVideo) {
        const ms = videoMs(v.index, video);
        if (v.keyframe) {
          await closeCluster();
          cluster = { startPos: w.pos, timestamp: ms, parts: [], bytes: 0 };
          clusters++;
          cues.push({ ms, clusterPos: w.pos - base });
        } else if (cluster === null) {
          throw new Error('first video packet is not a keyframe');
        }
        const flags = v.keyframe ? 0x80 : 0x00;
        addToCluster(cluster, binary(Id.SimpleBlock, blockPayload(VIDEO_TRACK, ms - cluster.timestamp, flags, v.data)));
        videoCount++;
        lastVideoIndex = Math.max(lastVideoIndex, v.index);
        vCur = await vIter.next();
      } else {
        if (a === null || cluster === null) throw new Error('no video packets to anchor the audio to');
        const ms = audioMs(a.pts48);
        let discard = 0;
        if (aLook.currentIsLast) discard = (await input.audioEnd).discardPadding48;
        if (discard > 0) {
          const block = binary(Id.Block, blockPayload(AUDIO_TRACK, ms - cluster.timestamp, 0x00, a.data));
          const paddingNs = (BigInt(discard) * 1_000_000_000n) / 48000n;
          addToCluster(cluster, master(Id.BlockGroup, [block, sint(Id.DiscardPadding, paddingNs)]));
        } else {
          // Every Opus packet is independently decodable, so SimpleBlocks carry the keyframe flag.
          addToCluster(cluster, binary(Id.SimpleBlock, blockPayload(AUDIO_TRACK, ms - cluster.timestamp, 0x80, a.data)));
        }
        const endSamples = a.pts48 + a.durationSamples - Math.max(discard, 0);
        // Playback drops the first CodecDelay of decoded audio (the Opus pre-skip), so it is not part of the duration.
        lastAudioEndNs = (BigInt(endSamples) * 1_000_000_000n) / 48000n - audio.codecDelayNs;
        audioCount++;
        await aLook.advance();
      }
    }
    await closeCluster();
    if (videoCount === 0) throw new Error('no video packets');

    const cuesPos = w.pos - base;
    await w.append(
      master(
        Id.Cues,
        cues.map((c) =>
          master(Id.CuePoint, [
            uint(Id.CueTime, c.ms),
            master(Id.CueTrackPositions, [uint(Id.CueTrack, VIDEO_TRACK), uint(Id.CueClusterPosition, c.clusterPos)]),
          ]),
        ),
      ),
    );

    const videoEndNs = framesToNs(lastVideoIndex + 1, video);
    const durationNs = videoEndNs > lastAudioEndNs ? videoEndNs : lastAudioEndNs;

    // Patches: Segment size, SeekHead, Duration.
    await w.writeAt(vintFixed8(w.pos - base), segmentSizePos);
    const seek = (id: number, position: number): Uint8Array =>
      master(Id.Seek, [binary(Id.SeekID, idBytes(id)), uint(Id.SeekPosition, position)]);
    const seekHead = master(Id.SeekHead, [
      seek(Id.Info, infoPos),
      seek(Id.Tracks, tracksPos),
      ...(chaptersPos !== null ? [seek(Id.Chapters, chaptersPos)] : []),
      seek(Id.Cues, cuesPos),
    ]);
    await w.writeAt(concat([seekHead, voidElement(SEEK_HEAD_SIZE - seekHead.length)]), seekHeadPos);
    const durationPayload = new Uint8Array(8);
    new DataView(durationPayload.buffer).setFloat64(0, Number(durationNs) / 1e6, false);
    await w.writeAt(durationPayload, durationPayloadPos);

    return { durationNs, videoPackets: videoCount, audioPackets: audioCount, clusters };
  } finally {
    await fh.close();
  }
}
