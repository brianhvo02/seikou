// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/matroska: Matroska and WebM writing and reading. Everything else is internal, reached through ./*.

// Writing an MKV through an MkvSink, and checking its input first.
export {
  writeMatroska,
  checkMatroskaInput,
  type MkvInput,
  type MkvResult,
  type VideoTrackInfo,
  type AudioTrackInfo,
  type TrackLabel,
  type MkvAudioTrack,
  type MkvSubtitleTrack,
  type MkvVideoPacket,
  type VideoPacket,
  type AudioPacket,
  type SubtitleBlock,
  type MkvAttachment,
  type MkvChapter,
} from './writer';
// The seekable reader.
export { openMatroska, type MatroskaFile, type MkvAttachedFile, type MkvChapterInfo } from './playback';
// The front-to-back reader.
export { readMatroska, type ParsedMkv, type MkvTrack, type MkvBlock } from './reader';
// What the readers throw for a truncated, malformed or non-Matroska file.
export { MkvReadError, NotMatroskaError } from './errors';
// The reader and sink interfaces a host implements.
export type { RangeReader, MkvSink } from './io';
// A RangeReader over a Blob or File.
export { blobRangeReader } from './blob-reader';
// Putting frames and chapters on the Matroska time grid.
export { videoMs, framesToNs, frameDurationNs } from './timing';
// Matroska element ids.
export { Id } from './ids';
// EBML element writers.
export { concat, uint, sint, float64, ascii, utf8, binary, master, voidElement } from './ebml';
// The EBML tree reader.
export { EbmlError, type EbmlNode, parseMkv, findAll, find, childOf, uintOf, floatOf, stringOf } from './ebml-reader';
