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
  vintFixed8,
  voidElement,
} from './ebml';
import type { Av1Packet } from './ivf';
import { Id } from './mkv-ids';
import type { OpusPacket } from './ogg';

// File layout (RFC 9559 §6 describes the allowed orderings; §25.3.1 the layout a muxer is
// recommended to produce): EBML header, then one Segment holding, in this order,
//   SeekHead     index of where Info, Tracks, Chapters and Cues start (§5.1.1),
//   Info         timestamp scale, duration, application names, title (§5.1.2),
//   Tracks       one video and one audio TrackEntry (§5.1.4),
//   Chapters     one edition with one ChapterAtom per chapter, when there are any (§5.1.7),
//   Cluster ...  blocks of video and audio, each cluster starting at a video key frame (§5.1.3),
//   Cues         one seek point per cluster, written last because their positions are only known
//                once the clusters are (§5.1.5; §6.4 explains why Cues usually come last).
// The Segment size, the SeekHead and the Info Duration are not known when writing starts, so the
// writer leaves room (an 8-byte size field, a Void element of `SEEK_HEAD_SIZE` bytes, a duration
// of 0) and overwrites them in place at the end. The Void keeps every later byte offset fixed:
// the SeekHead is rewritten shorter than the reserve and the remainder becomes a new Void (RFC
// 8794 §11.3.2).
//
// Timestamps: TimestampScale is 1,000,000, so every timestamp is a whole millisecond (RFC 9559
// §11.1). Block timestamps are 16-bit signed millisecond offsets from their cluster's Timestamp
// (§10.1, §11.2). Because each cluster opens with a key frame, offsets stay small.

/** Video track settings. The MKV's video codec is always AV1 (`V_AV1`). */
export interface VideoTrackInfo {
  /** Coded picture size in pixels. */
  width: number;
  height: number;
  /** Frame rate as a fraction; becomes DefaultDuration and fixes each frame's timestamp. */
  fpsNum: number;
  fpsDen: number;
  /** The `av1C` record (see `buildAv1C`), stored as CodecPrivate. */
  codecPrivate: Uint8Array;
}

/** Audio track settings. The MKV's audio codec is always Opus (`A_OPUS`). */
export interface AudioTrackInfo {
  channels: number;
  /** Written as SamplingFrequency in Hz; the encode passes 48000, the rate Opus decodes at (the encoder's input rate lives only in the OpusHead). */
  sampleRate: number;
  /** The complete OpusHead packet, stored as CodecPrivate. */
  codecPrivate: Uint8Array;
  /** The Opus pre-skip as nanoseconds (RFC 9559 §5.1.4.1.25). */
  codecDelayNs: bigint;
  /** Nanoseconds a decoder must decode after a seek (80 ms for Opus, RFC 7845 §4.6). */
  seekPreRollNs: bigint;
  /** ISO 639-2 language code of the track, `und` when unknown. */
  language: string;
}

/** One chapter on the MKV's timeline. */
export interface MkvChapter {
  title: string;
  /** Start in nanoseconds from the first video frame. */
  startNs: bigint;
}

/** What `writeMkv` muxes. */
export interface MkvInput {
  /** Segment title. */
  title?: string;
  video: VideoTrackInfo;
  audio: AudioTrackInfo;
  /** Video packets, one temporal unit per shown frame, in presentation order (AV1 temporal units already are). The first must be a key frame. Packet i gets timestamp `videoMs(i)`. */
  videoPackets: AsyncIterable<Av1Packet>;
  /** Audio packets in order; each is stamped from its 48 kHz sample position. */
  audioPackets: AsyncIterable<OpusPacket>;
  /** Resolves after `audioPackets` is consumed; its `discardPadding48` samples at the end of the last packet are marked as DiscardPadding. */
  audioEnd: Promise<{ discardPadding48: number }>;
  /** May be empty, which writes no Chapters element. */
  chapters: MkvChapter[];
}

/** What `writeMkv` reports about the file it wrote. */
export interface MkvResult {
  /** The Segment duration: the later of the video's end and the audio's end (pre-skip and end padding excluded). */
  durationNs: bigint;
  videoPackets: number;
  audioPackets: number;
  clusters: number;
}

// Bytes reserved for the SeekHead: four Seek entries of under 25 bytes each plus the SeekHead header
// fit well inside it, and the unused part is rewritten as a Void.
const SEEK_HEAD_SIZE = 160;
const APP_NAME = 'seikou-encode';
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

// Block header (RFC 9559 §10.1, §10.2): track number as an EBML variable-size integer (one byte
// for tracks 1 to 126, `0x80 | track`), a signed 16-bit big-endian timestamp relative to the
// cluster, and a flags byte (SimpleBlock: bit 0x80 is the key-frame flag; lacing bits are 0,
// meaning one frame per block). The frame data follows.
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

/**
 * Writes an MKV file at `path` from encoded packets, streaming: packets are consumed as they
 * arrive and written cluster by cluster, so memory use is one cluster. Video and audio are
 * interleaved by timestamp. The file is overwritten if it exists; on error it is left partial
 * (the caller deletes it). Throws when there are no video packets, the first video packet is not
 * a key frame, or a block's offset from its cluster does not fit 16 bits (a cluster longer than
 * about 32 seconds). Audio blocks are SimpleBlocks (every Opus packet decodes independently, so
 * each carries the key-frame flag), except a last packet that needs end trimming, which becomes a
 * BlockGroup so it can carry DiscardPadding.
 */
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
