// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * Matroska / EBML element ids used by the writer, written with their length-marker bits as they
 * appear in the file (so a 4-byte id such as `Segment` has its first byte's top bits set).
 * Each entry names the element and the section that defines it: RFC 9559 (Matroska) for the
 * Segment and everything inside it, RFC 8794 (EBML) for the header elements and `Void`.
 * Ids were checked against the RFC text. `idBytes` in `ebml.ts` turns one into its bytes.
 */
export const Id = {
  /** RFC 8794 §11.2.1: master element that opens the file and holds the header fields below. */
  EBML: 0x1a45dfa3,
  /** RFC 8794 §11.2.2: version of the EBML syntax the file uses (1). */
  EBMLVersion: 0x4286,
  /** RFC 8794 §11.2.3: oldest EBML version a reader must understand to read the file (1). */
  EBMLReadVersion: 0x42f7,
  /** RFC 8794 §11.2.4: longest element id in the file, in bytes (4). */
  EBMLMaxIDLength: 0x42f2,
  /** RFC 8794 §11.2.5: longest element size field in the file, in bytes (8). */
  EBMLMaxSizeLength: 0x42f3,
  /** RFC 8794 §11.2.6: the document type, the string `matroska` here. */
  DocType: 0x4282,
  /** RFC 8794 §11.2.7: version of the document type the file was written to (Matroska version 4 added CodecDelay and DiscardPadding). */
  DocTypeVersion: 0x4287,
  /** RFC 8794 §11.2.8: oldest document-type version a reader needs to play the file. */
  DocTypeReadVersion: 0x4285,
  /** RFC 9559 §5.1: master element holding everything after the EBML header. */
  Segment: 0x18538067,
  /** RFC 9559 §5.1.1: index of where the other top-level elements start. */
  SeekHead: 0x114d9b74,
  /** RFC 9559 §5.1.1.1: one entry of the SeekHead (an id and a position). */
  Seek: 0x4dbb,
  /** RFC 9559 §5.1.1.1.1: the id bytes of the element a Seek entry points at. */
  SeekID: 0x53ab,
  /** RFC 9559 §5.1.1.1.2: byte offset of that element from the start of the Segment's data. */
  SeekPosition: 0x53ac,
  /** RFC 9559 §5.1.2: master element with segment-wide information. */
  Info: 0x1549a966,
  /** RFC 9559 §5.1.2.9: nanoseconds per timestamp tick (1,000,000 makes every timestamp a millisecond count). */
  TimestampScale: 0x2ad7b1,
  /** RFC 9559 §5.1.2.10: length of the Segment in timestamp ticks, as a float. */
  Duration: 0x4489,
  /** RFC 9559 §5.1.2.13: name of the library that muxed the file. */
  MuxingApp: 0x4d80,
  /** RFC 9559 §5.1.2.14: name of the application that wrote the file. */
  WritingApp: 0x5741,
  /** RFC 9559 §5.1.2.12: the Segment's title, UTF-8. */
  Title: 0x7ba9,
  /** RFC 9559 §5.1.4: master element holding the track descriptions. */
  Tracks: 0x1654ae6b,
  /** RFC 9559 §5.1.4.1: master element describing one track. */
  TrackEntry: 0xae,
  /** RFC 9559 §5.1.4.1.1: the non-zero number blocks use to refer to the track. */
  TrackNumber: 0xd7,
  /** RFC 9559 §5.1.4.1.2: a unique, non-zero id for the track. */
  TrackUID: 0x73c5,
  /** RFC 9559 §5.1.4.1.3: kind of track: 1 video, 2 audio, 17 subtitle. */
  TrackType: 0x83,
  /** RFC 9559 §5.1.4.1.5: 1 when a player may pick the track automatically, 0 when it may not. Its default is 1, so the writer always writes it. */
  FlagDefault: 0x88,
  /** RFC 9559 §5.1.4.1.12: 0 promises that no block of the track uses lacing (one frame per block). */
  FlagLacing: 0x9c,
  /** RFC 9559 §5.1.4.1.18: a human-readable name for the track, UTF-8. */
  Name: 0x536e,
  /** RFC 9559 §5.1.4.1.21: codec name, such as `V_AV1` or `A_OPUS`. */
  CodecID: 0x86,
  /** RFC 9559 §5.1.4.1.22: codec setup bytes whose layout the codec mapping defines (`av1C` for AV1, the OpusHead packet for Opus). */
  CodecPrivate: 0x63a2,
  /** RFC 9559 §5.1.4.1.25: nanoseconds of decoded audio a player drops at the start; for Opus this is the pre-skip. */
  CodecDelay: 0x56aa,
  /** RFC 9559 §5.1.4.1.26: nanoseconds a decoder must decode after a seek before output is valid (80 ms for Opus). */
  SeekPreRoll: 0x56bb,
  /** RFC 9559 §5.1.4.1.13: nanoseconds one frame lasts. */
  DefaultDuration: 0x23e383,
  /** RFC 9559 §5.1.4.1.19: track language as an ISO 639-2 code (`und` for undetermined). */
  Language: 0x22b59c,
  /** RFC 9559 §5.1.4.1.28: master element with video settings. */
  Video: 0xe0,
  /** RFC 9559 §5.1.4.1.28.6: width of the coded picture in pixels. */
  PixelWidth: 0xb0,
  /** RFC 9559 §5.1.4.1.28.7: height of the coded picture in pixels. */
  PixelHeight: 0xba,
  /** RFC 9559 §5.1.4.1.29: master element with audio settings. */
  Audio: 0xe1,
  /** RFC 9559 §5.1.4.1.29.1: sampling frequency in Hz, as a float. */
  SamplingFrequency: 0xb5,
  /** RFC 9559 §5.1.4.1.29.3: number of audio channels. */
  Channels: 0x9f,
  /** RFC 9559 §5.1.6: master element holding the files attached to the Segment, such as fonts for ASS subtitles. */
  Attachments: 0x1941a469,
  /** RFC 9559 §5.1.6.1: one attached file. */
  AttachedFile: 0x61a7,
  /** RFC 9559 §5.1.6.1.1: a description of the file; the writer leaves it out. */
  FileDescription: 0x467e,
  /** RFC 9559 §5.1.6.1.2: the file's name, UTF-8. */
  FileName: 0x466e,
  /** RFC 9559 §5.1.6.1.3: the file's media type (MIME type), such as `font/ttf`. */
  FileMediaType: 0x4660,
  /** RFC 9559 §5.1.6.1.4: the file's bytes. */
  FileData: 0x465c,
  /** RFC 9559 §5.1.6.1.5: a unique, non-zero id for the file. */
  FileUID: 0x46ae,
  /** RFC 9559 §5.1.7: master element holding the chapter editions. */
  Chapters: 0x1043a770,
  /** RFC 9559 §5.1.7.1: one edition, a complete chapter list. */
  EditionEntry: 0x45b9,
  /** RFC 9559 §5.1.7.1.1: unique id of the edition. */
  EditionUID: 0x45bc,
  /** RFC 9559 §5.1.7.1.2: 1 marks the edition a player uses when the user picks none. */
  EditionFlagDefault: 0x45db,
  /** RFC 9559 §5.1.7.1.4: one chapter. */
  ChapterAtom: 0xb6,
  /** RFC 9559 §5.1.7.1.4.1: unique id of the chapter. */
  ChapterUID: 0x73c4,
  /** RFC 9559 §5.1.7.1.4.3: chapter start in nanoseconds. */
  ChapterTimeStart: 0x91,
  /**
   * Not listed in RFC 9559: the earlier Matroska specification's flag (default 1) that a chapter is
   * enabled. The writer sets it to 1, which is also what a reader assumes when it is absent.
   */
  ChapterFlagEnabled: 0x4598,
  /** RFC 9559 §5.1.7.1.4.9: master element holding one chapter title in one language. */
  ChapterDisplay: 0x80,
  /** RFC 9559 §5.1.7.1.4.10: the chapter title, UTF-8. */
  ChapString: 0x85,
  /** RFC 9559 §5.1.7.1.4.11: language of the title (ISO 639-2). */
  ChapLanguage: 0x437c,
  /** RFC 9559 §5.1.3: master element holding blocks that share a base timestamp. */
  Cluster: 0x1f43b675,
  /** RFC 9559 §5.1.3.1: the cluster's base timestamp in ticks; block timestamps are relative to it. */
  Timestamp: 0xe7,
  /** RFC 9559 §5.1.3.4: one frame with its track number, relative timestamp and flags (layout in §10.2). */
  SimpleBlock: 0xa3,
  /** RFC 9559 §5.1.3.5: a block plus extra information about it, such as BlockDuration or DiscardPadding. */
  BlockGroup: 0xa0,
  /** RFC 9559 §5.1.3.5.1: the block inside a BlockGroup (layout in §10.1). */
  Block: 0xa1,
  /** RFC 9559 §5.1.3.5.3: how long the block lasts, in track ticks (milliseconds here); subtitle events carry their length in it. */
  BlockDuration: 0x9b,
  /** RFC 9559 §5.1.3.5.7: nanoseconds of padding at the end of the block that a player drops. */
  DiscardPadding: 0x75a2,
  /** RFC 9559 §5.1.5: master element holding the seek index. */
  Cues: 0x1c53bb6b,
  /** RFC 9559 §5.1.5.1: one seek point. */
  CuePoint: 0xbb,
  /** RFC 9559 §5.1.5.1.1: the seek point's timestamp in ticks. */
  CueTime: 0xb3,
  /** RFC 9559 §5.1.5.1.2: where the seek point's data is. */
  CueTrackPositions: 0xb7,
  /** RFC 9559 §5.1.5.1.2.1: track number the seek point is for. */
  CueTrack: 0xf7,
  /** RFC 9559 §5.1.5.1.2.2: offset of the cluster from the start of the Segment's data. */
  CueClusterPosition: 0xf1,
  /** RFC 9559 §5.1.5.1.2.3: position of the referenced SimpleBlock or BlockGroup inside its Cluster, 0 being the first byte of the Cluster's data. */
  CueRelativePosition: 0xf0,
  /** RFC 9559 §5.1.5.1.2.4: how long the referenced block lasts, in Segment ticks (milliseconds here); subtitle cues carry it so a seek finds events still on screen. */
  CueDuration: 0xb2,
  /** RFC 8794 §11.3.2: padding that readers skip; the writer reserves space with it and patches it later. */
  Void: 0xec,
} as const;
