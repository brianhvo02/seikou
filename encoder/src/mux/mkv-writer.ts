// SPDX-License-Identifier: LGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
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

// File layout (RFC 9559 §6 describes the allowed orderings; §25.3.1 the layout a muxer is
// recommended to produce): EBML header, then one Segment holding, in this order,
//   SeekHead     index of where Info, Tracks, Attachments, Chapters and Cues start (§5.1.1),
//   Info         timestamp scale, duration, application names, title (§5.1.2),
//   Tracks       one video TrackEntry, then one per audio track, then one per subtitle track (§5.1.4),
//   Attachments  one AttachedFile per attachment, when there are any (§5.1.6),
//   Chapters     one edition with one ChapterAtom per chapter, when there are any (§5.1.7),
//   Cluster ...  blocks of every track in timestamp order; a cluster opens at each video key frame,
//                and also at any block too far from its cluster's timestamp (§5.1.3),
//   Cues         one seek point per cluster that opens with a video key frame, and one per subtitle
//                block (below), written last because their positions are only known once the
//                clusters are (§5.1.5; §6.4 explains why Cues usually come last).
// The Segment size, the SeekHead and the Info Duration are not known when writing starts, so the
// writer leaves room (an 8-byte size field, a Void element of `SEEK_HEAD_SIZE` bytes, a duration
// of 0) and overwrites them in place at the end. The Void keeps every later byte offset fixed:
// the SeekHead is rewritten shorter than the reserve and the remainder becomes a new Void (RFC
// 8794 §11.3.2).
//
// Timestamps: TimestampScale is 1,000,000, so every timestamp is a whole millisecond (RFC 9559
// §11.1). Block timestamps are 16-bit signed millisecond offsets from their cluster's Timestamp
// (§10.1, §11.2). Blocks are written in timestamp order, so an offset is never negative; a block
// more than 32,767 ms after its cluster's timestamp (a subtitle long after the last key frame, for
// example) opens a new cluster at its own timestamp. Such a cluster gets no video Cue, because a
// player cannot start decoding video there.
//
// Subtitle cues: a player that seeks to time t starts reading at the cluster of the video cue
// before t, so an event that began in an earlier cluster and is still on screen at t would be
// missed. Every subtitle block therefore gets its own cue: CueTrack (§5.1.5.1.2.1), the block's
// cluster as CueClusterPosition (§5.1.5.1.2.2), the block's place inside that cluster as
// CueRelativePosition (§5.1.5.1.2.3, counted from the first byte of the cluster's data, which is
// the cluster's Timestamp element), and, for a block with a BlockDuration, CueDuration
// (§5.1.5.1.2.4). Cue points are written in CueTime order; cues at one time share a CuePoint, with
// one CueTrackPositions each (video first, then subtitle tracks in track order).

/** Name, language and default flag of one track, written on every TrackEntry. */
export interface TrackLabel {
  /** Written as Name (RFC 9559 §5.1.4.1.18), the label a player shows in its track menu. */
  name: string;
  /** Written as Language (RFC 9559 §5.1.4.1.19): an ISO 639-2 code such as `jpn`, `und` when unknown. Printable ASCII only. */
  language: string;
  /** Written as FlagDefault (RFC 9559 §5.1.4.1.5), 1 or 0, always explicitly because its default is 1. */
  isDefault: boolean;
}

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
}

/** One audio track to mux: its settings, its label and its Opus packets. */
export type MkvAudioTrack = AudioTrackInfo &
  TrackLabel & {
    /** Packets in order; each is stamped from its 48 kHz sample position. */
    packets: AsyncIterable<OpusPacket>;
    /** Resolves after `packets` is consumed; its `discardPadding48` samples at the end of the last packet are marked as DiscardPadding. */
    end: Promise<{ discardPadding48: number }>;
  };

/** One subtitle event or display set, placed on the MKV's timeline. */
export interface SubtitleBlock {
  /** Start in milliseconds from the first video frame: a whole number, 0 or more (`writeMkv` throws a RangeError otherwise). */
  timeMs: number;
  /** Length in whole milliseconds. When given the block is a BlockGroup with BlockDuration (RFC 9559 §5.1.3.5.3); otherwise a SimpleBlock that lasts until the track's next block. */
  durationMs?: number;
  /** The block's data, laid out as the codec mapping of the track's CodecID says. */
  data: Uint8Array;
}

/**
 * One subtitle track to mux. It is written with TrackType 17 (RFC 9559 §5.1.4.1.3) and FlagLacing
 * 0 (§5.1.4.1.12), so every block holds one event. Codec mappings (Matroska codec specification):
 * `S_TEXT/ASS` stores the script's header (everything up to and including the `[Events]` Format
 * line) as CodecPrivate and one Dialogue line per block as `ReadOrder, Layer, Style, Name,
 * MarginL, MarginR, MarginV, Effect, Text`, its start and end moved into the block's timestamp
 * and BlockDuration; `S_HDMV/PGS` has no CodecPrivate and stores the PGS segments of one display
 * set per block, as SimpleBlocks.
 */
export type MkvSubtitleTrack = TrackLabel & {
  codecId: 'S_TEXT/ASS' | 'S_HDMV/PGS';
  /** When true, FlagForced 1 is written (RFC 9559 §5.1.4.1.6): a track a player may show even with subtitles off, such as one with only signs and songs. Otherwise the element is left out (its default is 0). */
  isForced?: boolean;
  /** Stored as CodecPrivate when given. */
  codecPrivate?: Uint8Array;
  /** Sorted by `timeMs` (equal times keep their order); `writeMkv` throws otherwise. */
  blocks: readonly SubtitleBlock[];
};

/** A file attached to the Segment (RFC 9559 §5.1.6.1), such as a font an ASS track uses. */
export interface MkvAttachment {
  /** Written as FileName (RFC 9559 §5.1.6.1.2). */
  name: string;
  /** Written as FileMediaType (RFC 9559 §5.1.6.1.3), such as `font/ttf`. Printable ASCII only. */
  mediaType: string;
  /** Written as FileData (RFC 9559 §5.1.6.1.4). */
  data: Uint8Array;
}

/** One chapter on the MKV's timeline. */
export interface MkvChapter {
  title: string;
  /** Start in nanoseconds from the first video frame. */
  startNs: bigint;
}

/**
 * One video packet to mux: an AV1 temporal unit, timed by its index and the frame rate unless
 * `timeMs` gives its timestamp directly (a remux copies the source's timestamps this way).
 */
export type MkvVideoPacket = Av1Packet & {
  /** Whole milliseconds from the Segment's start, in place of `videoMs(index)`. */
  timeMs?: number;
};

/**
 * What `writeMkv` muxes. Track numbers follow this order: the video is track 1, the audio tracks
 * come next in array order, then the subtitle tracks in array order.
 */
export interface MkvInput {
  /**
   * The EBML DocType (RFC 8794 §11.2.6), `matroska` by default. `webm` follows the WebM container
   * guidelines: no subtitle tracks and no attachments (`writeMkv` throws when given any), and
   * chapters without EditionUID, EditionFlagDefault or ChapterFlagEnabled, which WebM does not
   * list. The Opus elements WebM's table predates (CodecDelay, SeekPreRoll, DiscardPadding) are kept,
   * since the Matroska Opus mapping needs them and WebM players read them.
   */
  docType?: 'matroska' | 'webm';
  /** Segment title. */
  title?: string;
  video: VideoTrackInfo & TrackLabel;
  /** Video packets, one temporal unit per shown frame, in presentation order (AV1 temporal units already are). The first must be a key frame. Packet i gets timestamp `videoMs(i)`, or its own `timeMs`. */
  videoPackets: AsyncIterable<MkvVideoPacket>;
  /** Any number of Opus tracks, none included. Every track's packets are read concurrently with the video's. */
  audio: MkvAudioTrack[];
  /** Any number of subtitle tracks, none included. */
  subtitles: MkvSubtitleTrack[];
  /** May be empty, which writes no Attachments element. Each file gets a random non-zero 64-bit FileUID (RFC 9559 §5.1.6.1.5); FileDescription is not written. */
  attachments: MkvAttachment[];
  /** May be empty, which writes no Chapters element. */
  chapters: MkvChapter[];
}

/** What `writeMkv` reports about the file it wrote. */
export interface MkvResult {
  /** The Segment duration: the latest of the video's end (the last frame's time plus one frame) and each audio track's end (pre-skip and end padding excluded). Subtitle blocks do not extend it. */
  durationNs: bigint;
  videoPackets: number;
  /** Packets written per audio track, in input order. */
  audioPackets: number[];
  /** Blocks written per subtitle track, in input order. */
  subtitleBlocks: number[];
  clusters: number;
}

// Bytes reserved for the SeekHead: five Seek entries of under 25 bytes each plus the SeekHead
// header fit inside it, and the unused part is rewritten as a Void.
const SEEK_HEAD_SIZE = 160;
const APP_NAME = 'seikou-encode';
const VIDEO_TRACK = 1;
const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;
const TRACK_TYPE_SUBTITLE = 17;
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

// Block header (RFC 9559 §10.1, §10.2): track number as an EBML variable-size integer, a signed
// 16-bit big-endian timestamp relative to the cluster, and a flags byte (SimpleBlock: bit 0x80 is
// the key-frame flag; in a Block inside a BlockGroup that bit is reserved and 0; lacing bits are
// 0, meaning one frame per block). The frame data follows.
function blockPayload(track: number, relTs: number, flags: number, data: Uint8Array): Uint8Array {
  if (relTs < MIN_REL_TS || relTs > MAX_REL_TS) {
    throw new RangeError(`block timestamp ${relTs} ms does not fit the cluster's int16 range`);
  }
  const ts = new Uint8Array(3);
  new DataView(ts.buffer).setInt16(0, relTs, false);
  ts[2] = flags;
  return concat([vint(track), ts, data]);
}

function audioMs(pts48: number): number {
  return Math.round(pts48 / 48);
}

function labelElements(label: TrackLabel): Uint8Array[] {
  return [
    uint(Id.FlagDefault, label.isDefault ? 1 : 0),
    utf8(Id.Name, label.name),
    ascii(Id.Language, label.language),
  ];
}

function audioTrackNumber(i: number): number {
  return VIDEO_TRACK + 1 + i;
}

function subtitleTrackNumber(input: MkvInput, j: number): number {
  return VIDEO_TRACK + 1 + input.audio.length + j;
}

function trackEntries(input: MkvInput): Uint8Array {
  const { video } = input;
  return master(Id.Tracks, [
    master(Id.TrackEntry, [
      uint(Id.TrackNumber, VIDEO_TRACK),
      uint(Id.TrackUID, VIDEO_TRACK),
      uint(Id.TrackType, TRACK_TYPE_VIDEO),
      ...labelElements(video),
      ascii(Id.CodecID, 'V_AV1'),
      binary(Id.CodecPrivate, video.codecPrivate),
      uint(Id.DefaultDuration, frameDurationNs(video)),
      master(Id.Video, [uint(Id.PixelWidth, video.width), uint(Id.PixelHeight, video.height)]),
    ]),
    ...input.audio.map((audio, i) =>
      master(Id.TrackEntry, [
        uint(Id.TrackNumber, audioTrackNumber(i)),
        uint(Id.TrackUID, audioTrackNumber(i)),
        uint(Id.TrackType, TRACK_TYPE_AUDIO),
        ...labelElements(audio),
        ascii(Id.CodecID, 'A_OPUS'),
        binary(Id.CodecPrivate, audio.codecPrivate),
        uint(Id.CodecDelay, audio.codecDelayNs),
        uint(Id.SeekPreRoll, audio.seekPreRollNs),
        master(Id.Audio, [float64(Id.SamplingFrequency, audio.sampleRate), uint(Id.Channels, audio.channels)]),
      ]),
    ),
    ...input.subtitles.map((sub, j) =>
      master(Id.TrackEntry, [
        uint(Id.TrackNumber, subtitleTrackNumber(input, j)),
        uint(Id.TrackUID, subtitleTrackNumber(input, j)),
        uint(Id.TrackType, TRACK_TYPE_SUBTITLE),
        ...labelElements(sub),
        ...(sub.isForced === true ? [uint(Id.FlagForced, 1)] : []),
        uint(Id.FlagLacing, 0),
        ascii(Id.CodecID, sub.codecId),
        ...(sub.codecPrivate !== undefined ? [binary(Id.CodecPrivate, sub.codecPrivate)] : []),
      ]),
    ),
  ]);
}

function randomUid(taken: Set<bigint>): bigint {
  for (;;) {
    const uid = randomBytes(8).readBigUInt64BE(0);
    if (uid !== 0n && !taken.has(uid)) {
      taken.add(uid);
      return uid;
    }
  }
}

function attachmentsElement(files: readonly MkvAttachment[]): Uint8Array {
  const taken = new Set<bigint>();
  return master(
    Id.Attachments,
    files.map((f) =>
      master(Id.AttachedFile, [
        utf8(Id.FileName, f.name),
        ascii(Id.FileMediaType, f.mediaType),
        binary(Id.FileData, f.data),
        uint(Id.FileUID, randomUid(taken)),
      ]),
    ),
  );
}

// WebM lists neither EditionUID, EditionFlagDefault nor ChapterFlagEnabled, so `webm` leaves them out.
function chaptersElement(chapters: readonly MkvChapter[], webm: boolean): Uint8Array {
  return master(Id.Chapters, [
    master(Id.EditionEntry, [
      ...(webm ? [] : [uint(Id.EditionUID, 1), uint(Id.EditionFlagDefault, 1)]),
      ...chapters.map((c, i) =>
        master(Id.ChapterAtom, [
          uint(Id.ChapterUID, i + 1),
          uint(Id.ChapterTimeStart, c.startNs),
          ...(webm ? [] : [uint(Id.ChapterFlagEnabled, 1)]),
          master(Id.ChapterDisplay, [utf8(Id.ChapString, c.title), ascii(Id.ChapLanguage, 'und')]),
        ]),
      ),
    ]),
  ]);
}

function ebmlHeader(docType: 'matroska' | 'webm'): Uint8Array {
  return master(Id.EBML, [
    uint(Id.EBMLVersion, 1),
    uint(Id.EBMLReadVersion, 1),
    uint(Id.EBMLMaxIDLength, 4),
    uint(Id.EBMLMaxSizeLength, 8),
    ascii(Id.DocType, docType),
    uint(Id.DocTypeVersion, 4),
    uint(Id.DocTypeReadVersion, 2),
  ]);
}

function checkSubtitleBlocks(subtitles: readonly MkvSubtitleTrack[]): void {
  for (const sub of subtitles) {
    let prev = 0;
    for (const b of sub.blocks) {
      if (!Number.isInteger(b.timeMs) || b.timeMs < 0) {
        throw new RangeError(`subtitle track "${sub.name}": block time ${b.timeMs} ms is not a whole number of milliseconds at or after 0`);
      }
      if (b.durationMs !== undefined && (!Number.isInteger(b.durationMs) || b.durationMs < 0)) {
        throw new RangeError(`subtitle track "${sub.name}": block duration ${b.durationMs} ms is not a whole number of milliseconds at or above 0`);
      }
      if (b.timeMs < prev) {
        throw new Error(`subtitle track "${sub.name}": blocks are out of time order (${b.timeMs} ms after ${prev} ms)`);
      }
      prev = b.timeMs;
    }
  }
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

interface AudioState {
  track: MkvAudioTrack;
  number: number;
  look: Lookahead<OpusPacket>;
  count: number;
  endNs: bigint;
}

/** One CueTrackPositions to write: a video key frame's cluster or one subtitle block. */
interface CueEntry {
  ms: number;
  track: number;
  /** The cluster's offset from the start of the Segment's data. */
  clusterPos: number;
  /** Subtitle blocks only: the block's offset from the first byte of its cluster's data. */
  relativePos?: number;
  /** Subtitle blocks with a BlockDuration only. */
  durationMs?: number;
}

// Groups the entries by time into CuePoints, in CueTime order; entries at one time keep the order
// they were made in (the order the blocks were written: video, then subtitles in track order).
function cuesElement(entries: readonly CueEntry[]): Uint8Array {
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.ms - b.e.ms || a.i - b.i).map((x) => x.e);
  const points: Uint8Array[] = [];
  for (let i = 0; i < sorted.length; ) {
    const ms = sorted[i]!.ms;
    const positions: Uint8Array[] = [];
    for (; i < sorted.length && sorted[i]!.ms === ms; i++) {
      const e = sorted[i]!;
      positions.push(
        master(Id.CueTrackPositions, [
          uint(Id.CueTrack, e.track),
          uint(Id.CueClusterPosition, e.clusterPos),
          ...(e.relativePos !== undefined ? [uint(Id.CueRelativePosition, e.relativePos)] : []),
          ...(e.durationMs !== undefined ? [uint(Id.CueDuration, e.durationMs)] : []),
        ]),
      );
    }
    points.push(master(Id.CuePoint, [uint(Id.CueTime, ms), ...positions]));
  }
  return master(Id.Cues, points);
}

interface SubtitleState {
  track: MkvSubtitleTrack;
  number: number;
  next: number;
}

/**
 * Writes an MKV file at `path` from encoded packets, streaming: packets are consumed as they
 * arrive and written cluster by cluster, so memory use is one cluster (plus the attachments and
 * subtitle blocks, which the input already holds). The blocks of every track are interleaved in
 * timestamp order; at equal timestamps the video comes first, then the audio tracks, then the
 * subtitle tracks, each in input order. A cluster opens at every video key frame, and at any block
 * whose offset from its cluster's timestamp would not fit the block's signed 16-bit field.
 * The Cues hold one point per cluster that opens with a video key frame and one per subtitle block,
 * so a player that seeks finds subtitle events that started before the seek point.
 * Audio blocks are SimpleBlocks (every Opus packet decodes independently, so each carries the
 * key-frame flag), except a last packet that needs end trimming, which becomes a BlockGroup so it
 * can carry DiscardPadding. Subtitle blocks with a duration are BlockGroups with BlockDuration;
 * those without are SimpleBlocks with the key-frame flag.
 * The file is overwritten if it exists; on error it is left partial (the caller deletes it).
 * Throws before opening the file when a subtitle block's time is negative or not a whole number
 * of milliseconds (RangeError: the caller drops or clamps events before the first video frame) or
 * a track's blocks are out of time order, and when a `webm` input has subtitle tracks or
 * attachments; throws while writing when there are no video packets or the first video packet is
 * not a key frame.
 */
export async function writeMkv(path: string, input: MkvInput): Promise<MkvResult> {
  const { video } = input;
  const docType = input.docType ?? 'matroska';
  if (docType === 'webm' && (input.subtitles.length > 0 || input.attachments.length > 0)) {
    throw new Error('a WebM file carries no subtitle tracks and no attachments');
  }
  checkSubtitleBlocks(input.subtitles);
  const fh = await open(path, 'w');
  try {
    const w = new PositionalWriter(fh);
    await w.append(ebmlHeader(docType));
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

    let attachmentsPos: number | null = null;
    if (input.attachments.length > 0) {
      attachmentsPos = w.pos - base;
      await w.append(attachmentsElement(input.attachments));
    }

    let chaptersPos: number | null = null;
    if (input.chapters.length > 0) {
      chaptersPos = w.pos - base;
      await w.append(chaptersElement(input.chapters, docType === 'webm'));
    }

    const cues: CueEntry[] = [];
    let cluster: OpenCluster | null = null;
    let clusters = 0;
    let videoCount = 0;
    let videoEndNs = 0n;
    const frameNs = frameDurationNs(video);

    const closeCluster = async (): Promise<void> => {
      if (cluster === null) return;
      const ts = uint(Id.Timestamp, cluster.timestamp);
      const header = concat([idBytes(Id.Cluster), vintFixed8(ts.length + cluster.bytes), ts]);
      await w.writeAt(concat([header, ...cluster.parts]), cluster.startPos);
      w.pos = cluster.startPos + header.length + cluster.bytes;
      cluster = null;
    };
    const openCluster = async (ms: number, cued: boolean): Promise<OpenCluster> => {
      await closeCluster();
      const c: OpenCluster = { startPos: w.pos, timestamp: ms, parts: [], bytes: 0 };
      cluster = c;
      clusters++;
      if (cued) cues.push({ ms, track: VIDEO_TRACK, clusterPos: w.pos - base });
      return c;
    };
    // The cluster a block at `ms` goes into: the open one, or a new one when the offset would not fit.
    const clusterFor = async (ms: number): Promise<OpenCluster> => {
      if (cluster === null) throw new Error('no video packets to anchor the other tracks to');
      if (ms - cluster.timestamp > MAX_REL_TS) return openCluster(ms, false);
      return cluster;
    };
    const addToCluster = (c: OpenCluster, el: Uint8Array): void => {
      c.parts.push(el);
      c.bytes += el.length;
    };

    const vIter = input.videoPackets[Symbol.asyncIterator]();
    const audios: AudioState[] = input.audio.map((track, i) => ({
      track,
      number: audioTrackNumber(i),
      look: new Lookahead(track.packets),
      count: 0,
      endNs: 0n,
    }));
    const subs: SubtitleState[] = input.subtitles.map((track, j) => ({ track, number: subtitleTrackNumber(input, j), next: 0 }));
    await Promise.all(audios.map((a) => a.look.prime()));
    let vCur = await vIter.next();

    for (;;) {
      const v = vCur.done === true ? null : vCur.value;
      // Pick the earliest pending block; on a tie the first source in track order wins.
      let bestMs = Infinity;
      let pick: { kind: 'video' } | { kind: 'audio'; a: AudioState } | { kind: 'sub'; s: SubtitleState } | null = null;
      if (v !== null) {
        bestMs = v.timeMs ?? videoMs(v.index, video);
        pick = { kind: 'video' };
      }
      // Until the first key frame opens a cluster, only video can be written.
      if (cluster !== null || v === null) {
        for (const a of audios) {
          const p = a.look.current;
          if (p !== null && audioMs(p.pts48) < bestMs) {
            bestMs = audioMs(p.pts48);
            pick = { kind: 'audio', a };
          }
        }
        for (const s of subs) {
          const b = s.track.blocks[s.next];
          if (b !== undefined && b.timeMs < bestMs) {
            bestMs = b.timeMs;
            pick = { kind: 'sub', s };
          }
        }
      }
      if (pick === null) break;

      if (pick.kind === 'video') {
        const p = v!;
        let c: OpenCluster;
        if (p.keyframe) c = await openCluster(bestMs, true);
        else if (cluster === null) throw new Error('first video packet is not a keyframe');
        else c = await clusterFor(bestMs);
        const flags = p.keyframe ? 0x80 : 0x00;
        addToCluster(c, binary(Id.SimpleBlock, blockPayload(VIDEO_TRACK, bestMs - c.timestamp, flags, p.data)));
        videoCount++;
        const endNs = p.timeMs !== undefined ? BigInt(p.timeMs) * 1_000_000n + frameNs : framesToNs(p.index + 1, video);
        if (endNs > videoEndNs) videoEndNs = endNs;
        vCur = await vIter.next();
      } else if (pick.kind === 'audio') {
        const a = pick.a;
        const p = a.look.current!;
        const c = await clusterFor(bestMs);
        let discard = 0;
        if (a.look.currentIsLast) discard = (await a.track.end).discardPadding48;
        if (discard > 0) {
          const block = binary(Id.Block, blockPayload(a.number, bestMs - c.timestamp, 0x00, p.data));
          const paddingNs = (BigInt(discard) * 1_000_000_000n) / 48000n;
          addToCluster(c, master(Id.BlockGroup, [block, sint(Id.DiscardPadding, paddingNs)]));
        } else {
          // Every Opus packet is independently decodable, so SimpleBlocks carry the keyframe flag.
          addToCluster(c, binary(Id.SimpleBlock, blockPayload(a.number, bestMs - c.timestamp, 0x80, p.data)));
        }
        const endSamples = p.pts48 + p.durationSamples - Math.max(discard, 0);
        // Playback drops the first CodecDelay of decoded audio (the Opus pre-skip), so it is not part of the duration.
        a.endNs = (BigInt(endSamples) * 1_000_000_000n) / 48000n - a.track.codecDelayNs;
        a.count++;
        await a.look.advance();
      } else {
        const s = pick.s;
        const b = s.track.blocks[s.next]!;
        const c = await clusterFor(bestMs);
        cues.push({
          ms: bestMs,
          track: s.number,
          clusterPos: c.startPos - base,
          relativePos: uint(Id.Timestamp, c.timestamp).length + c.bytes,
          ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
        });
        if (b.durationMs !== undefined) {
          const block = binary(Id.Block, blockPayload(s.number, bestMs - c.timestamp, 0x00, b.data));
          addToCluster(c, master(Id.BlockGroup, [block, uint(Id.BlockDuration, b.durationMs)]));
        } else {
          addToCluster(c, binary(Id.SimpleBlock, blockPayload(s.number, bestMs - c.timestamp, 0x80, b.data)));
        }
        s.next++;
      }
    }
    await closeCluster();
    if (videoCount === 0) throw new Error('no video packets');

    const cuesPos = w.pos - base;
    await w.append(cuesElement(cues));

    let durationNs = videoEndNs;
    for (const a of audios) if (a.endNs > durationNs) durationNs = a.endNs;

    // Patches: Segment size, SeekHead, Duration.
    await w.writeAt(vintFixed8(w.pos - base), segmentSizePos);
    const seek = (id: number, position: number): Uint8Array =>
      master(Id.Seek, [binary(Id.SeekID, idBytes(id)), uint(Id.SeekPosition, position)]);
    const seekHead = master(Id.SeekHead, [
      seek(Id.Info, infoPos),
      seek(Id.Tracks, tracksPos),
      ...(attachmentsPos !== null ? [seek(Id.Attachments, attachmentsPos)] : []),
      ...(chaptersPos !== null ? [seek(Id.Chapters, chaptersPos)] : []),
      seek(Id.Cues, cuesPos),
    ]);
    await w.writeAt(concat([seekHead, voidElement(SEEK_HEAD_SIZE - seekHead.length)]), seekHeadPos);
    const durationPayload = new Uint8Array(8);
    new DataView(durationPayload.buffer).setFloat64(0, Number(durationNs) / 1e6, false);
    await w.writeAt(durationPayload, durationPayloadPos);

    return {
      durationNs,
      videoPackets: videoCount,
      audioPackets: audios.map((a) => a.count),
      subtitleBlocks: subs.map((s) => s.next),
      clusters,
    };
  } finally {
    await fh.close();
  }
}
