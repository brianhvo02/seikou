// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/bdmv: the Blu-ray disc format read without a player. Everything else is internal, reached through ./*.

// How disc bytes are read, and why a disc failed to open or read.
export { type ByteSource, DiscError, type DiscErrorCode } from './byte-source';
// The error every parser throws for malformed bytes.
export { ParseError } from './byte-reader';
// Stream coding types.
export { CodingType } from './stream-types';
// index.bdmv: titles, First Play and Top Menu.
export { parseIndex, type IndexBdmv, type IndexTitle, type IndexAppInfo, type IndexObject } from './index-parser';
// Playlists (.mpls): play items, sub paths, marks and stream tables.
export {
  parseMpls,
  type Mpls,
  type PlayItem,
  type SubPlayItem,
  type SubPath,
  type PlayListMark,
  MarkType,
  type StnTable,
  type StreamEntry,
} from './mpls-parser';
// Clip information (.clpi): stream attributes and the EP map.
export {
  parseClpi,
  type Clpi,
  type AtcSequence,
  type StcSequence,
  type ProgramInfo,
  type ProgramStream,
  type EpMap,
  type EpEntry,
} from './clpi-parser';
// MovieObject.bdmv: HDMV navigation commands.
export { parseMovieObjects, type MovieObjects, type MovieObject, type MobjCmd, type HdmvInsn } from './mobj-parser';
// BD-J object files.
export {
  parseBdjo,
  type Bdjo,
  type BdjoApp,
  type BdjoAppCacheItem,
  type BdjoAccessiblePlaylists,
  type BdjoAppName,
  type BdjoAppProfile,
  type BdjoTerminalInfo,
} from './bdjo-parser';
// id.bdmv: the disc ID.
export { parseBdid, type BdidData } from './bdid-parser';
// sound.bdmv: menu sounds.
export { parseSoundBdmv, type SoundData, type SoundClip } from './sound-parser';
// Reading ISO images.
export { readUdf, UdfImage, type UdfFile, type UdfExtent, type UdfRead, UdfError } from './udf';
// One 192-byte source packet.
export { parseSourcePacket, type TsPacket } from './demux/ts-packet';
// Reassembling PES packets from TS packets.
export { PesAssembler, type PesPacket } from './demux/pes-assembler';
// Demuxing a clip: the PES packets of chosen PIDs from a range of an .m2ts file.
export { M2tsReader, type M2tsReaderOptions, type DemuxStats } from './demux/m2ts-reader';
// The WebCodecs codec string of an H.264 stream.
export { avcCodecString } from './codecs/h264';
// The WebCodecs codec string of an HEVC stream.
export { hevcCodecString } from './codecs/hevc';
