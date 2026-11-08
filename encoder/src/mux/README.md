# mux/: reading encoder output and writing Matroska

This area reads the streams the encoders produce (IVF with AV1 packets, Ogg with Opus packets) and writes one Matroska (`.mkv`) file with one AV1 track, any number of Opus tracks, any number of subtitle tracks (`S_TEXT/ASS`, `S_HDMV/PGS`) and attached files such as fonts. It writes the container itself, so the app needs no other muxer.

## Concepts

- **EBML.** Matroska is built on EBML (RFC 8794): a tree of elements, each an Element ID, an Element Data Size and data. IDs and sizes are variable-length integers. `ebml.ts` builds the bytes of one element per function; `mkv-ids.ts` lists the element IDs with the RFC section that defines each.
- **File layout.** An EBML header, then one Segment holding SeekHead, Info, Tracks, Attachments (when there are any), Chapters (when there are any), Clusters and Cues (RFC 9559 §6 and §25.3.1). The SeekHead points at each of them except the Clusters. The Segment size, the SeekHead and the duration are not known up front, so the writer reserves room (an 8-byte size, a Void element, a zero duration) and overwrites it at the end. A Void element reserves the SeekHead's space so no later byte moves.
- **Tracks.** Track 1 is the video, then the audio tracks in input order, then the subtitle tracks in input order. Every TrackEntry carries Name, Language and an explicit FlagDefault (RFC 9559 §5.1.4.1.18, .19, .5); subtitle tracks are TrackType 17 with FlagLacing 0.
- **Timestamps.** TimestampScale is 1,000,000, so timestamps are whole milliseconds. Video frame i is at `videoMs(i)`. Blocks of every track are written in timestamp order (at equal times: video, audio, subtitles, each in track order). Block timestamps are 16-bit signed offsets from their cluster. A cluster opens at every video key frame, which is also where the video Cues point; a block more than 32,767 ms after its cluster's timestamp (a subtitle long after the last key frame) opens a new cluster at its own time, without a video Cue. Subtitle blocks must be at 0 ms or later, in whole milliseconds and in order: the writer throws rather than move them, so the caller drops or clamps events before the first video frame.
- **Subtitles.** Per the Matroska codec specification, `S_TEXT/ASS` keeps the script header as CodecPrivate and one Dialogue line per block (without its start and end, which become the block's timestamp and BlockDuration, so these blocks are BlockGroups); `S_HDMV/PGS` puts one display set per SimpleBlock. A subtitle block with a `durationMs` is a BlockGroup with BlockDuration (RFC 9559 §5.1.3.5.3), one without is a SimpleBlock.
- **Subtitle cues.** A player that seeks starts reading at the video cue before the seek point, so an event that began earlier and is still on screen would be missed. Every subtitle block therefore gets a cue of its own (RFC 9559 §5.1.5.1.2): CueTrack, CueClusterPosition, CueRelativePosition (the block's offset from the first byte of its cluster's data) and, for a block with a BlockDuration, CueDuration. CuePoints are in CueTime order; cues at one time share a CuePoint.
- **ASS scripts.** `assToMatroska` splits a script into the `S_TEXT/ASS` CodecPrivate (the script without its Dialogue and Comment lines, its `[Events]` Format line rewritten as `Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`) and one block per Dialogue line, its fields taken by name from the script's own Format line. ReadOrder is the line's place among the script's Dialogue lines, so players can restore file order. A caller-supplied offset moves each event (positive is later); times are rounded to whole milliseconds once; events that end at or before 0 or start at or after the episode's end are dropped, and a start before 0 is clamped to 0.
- **Attachments.** One AttachedFile per file with FileName, FileMediaType, FileData and a random non-zero 64-bit FileUID (RFC 9559 §5.1.6.1); no FileDescription.
- **AV1.** IVF frames are AV1 temporal units. The muxer reads the sequence header OBU (AV1 spec §5.5) for the `av1C` record stored as CodecPrivate, strips temporal delimiter OBUs from block data as the Matroska AV1 mapping asks, and tests each unit for a key frame (§5.9.2).
- **Opus.** Ogg pages carry packets (RFC 3533 §6); the first is OpusHead (RFC 7845 §5.1) and goes in CodecPrivate unchanged. Each packet's duration comes from its TOC byte (RFC 6716 §3.1). The pre-skip becomes CodecDelay, 80 ms becomes SeekPreRoll, and samples trimmed from the end of the last packet (the final granule position, RFC 7845 §4.4) become DiscardPadding.

## API

- `readIvf(stream)` returns `IvfStream`: header, `packets` (an async iterator of `Av1Packet`) and `sequenceHeader` (resolves early with the `av1C` record).
- `readOggOpus(stream)` returns `OggOpusStream`: `head`, `packets` (`OpusPacket`) and `end` (`OggOpusEnd`, settles after the packets are consumed).
- `assToMatroska(script, durationMs, offsetMs?)` returns `AssTrackData`: the CodecPrivate and the `SubtitleBlock`s of an `S_TEXT/ASS` track.
- `writeMkv(path, input)` muxes an `MkvInput` (video with its `TrackLabel`, `audio: MkvAudioTrack[]`, `subtitles: MkvSubtitleTrack[]` of `SubtitleBlock`s, `attachments: MkvAttachment[]`, `chapters`) into a file and returns an `MkvResult` (per-track packet and block counts, clusters, duration).
- Building blocks: `splitObus`, `parseSequenceHeader`, `isKeyframe`, `buildAv1C`, `stripTemporalDelimiters`, `opusPacketDuration`, and the `ebml.ts` element writers (`uint`, `sint`, `float64`, `ascii`, `utf8`, `binary`, `master`, `voidElement`, `vint`).

## Where to look

- `mkv-writer.ts`: layout, interleaving, Cues, patching at the end.
- `ass-track.ts`: ASS script to `S_TEXT/ASS` CodecPrivate and blocks.
- `ebml.ts`, `mkv-ids.ts`: the element encoding and the IDs.
- `av1.ts`, `ivf.ts`: AV1 syntax and the IVF container; `bit-reader.ts` is the bit reader they share.
- `ogg.ts`: Ogg pages, OpusHead and packet durations; `chunk-reader.ts` reads exact byte counts from a stream.
- Tests: `encoder/tests/mux/`; `encoder/tests/helpers/ebml-reader.ts` is an independent reader the writer's output is checked with.
