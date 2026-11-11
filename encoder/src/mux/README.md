# mux/: reading encoder output, writing and reading Matroska

The Matroska writer and reader live in the `@seikou/matroska` package (`packages/matroska/`), which runs in Node and in browsers; this area keeps the encoder-specific parts and `mkv-file.ts`, which wraps the package on files (`writeMkv(path, input)`, `readMkv(path)`, over `node-io.ts`'s `nodeFileSink` and `nodeRangeReader`). Paths below named `ebml.ts`, `ids.ts`, `ebml-reader.ts`, `writer.ts`, `reader.ts` and `timing.ts` are in that package's `src/`.

This area reads the streams the encoders produce (IVF with AV1 packets, Ogg with Opus packets) and writes one Matroska (`.mkv`) file with one AV1 track, any number of Opus tracks, any number of subtitle tracks (`S_TEXT/ASS`, `S_HDMV/PGS`) and attached files such as fonts. It writes the container itself, so the app needs no other muxer. The same writer writes WebM (DocType `webm`) for packaging, and a streaming reader reads a finished MKV back.

## Uses

`@seikou/matroska` (the container writer and reader), `@seikou/nas` (title tags) and `plan/` (the timing rules).

## Concepts

- EBML. Matroska is built on EBML (RFC 8794): a tree of elements, each an Element ID, an Element Data Size and data. IDs and sizes are variable-length integers. `ebml.ts` builds the bytes of one element per function; `ids.ts` lists the element IDs with the RFC section that defines each.
- File layout. An EBML header, then one Segment holding SeekHead, Info, Tracks, Attachments (when there are any), Chapters (when there are any), Clusters and Cues (RFC 9559 §6 and §25.3.1). The SeekHead points at each of them except the Clusters. The Segment size, the SeekHead and the duration are not known up front, so the writer reserves room (an 8-byte size, a Void element, a zero duration) and overwrites it at the end. A Void element reserves the SeekHead's space so no later byte moves.
- Tracks. Track 1 is the video, then the audio tracks in input order, then the subtitle tracks in input order. Every TrackEntry carries Name, Language and an explicit FlagDefault (RFC 9559 §5.1.4.1.18, .19, .5); subtitle tracks are TrackType 17 with FlagLacing 0, and a subtitle track marked `isForced` (a signs-and-songs track) gets FlagForced 1 (§5.1.4.1.6).
- WebM. With `docType: 'webm'` the writer follows the WebM container guidelines: DocType `webm`, no subtitle tracks or attachments (it throws when given any), and chapters without EditionUID, EditionFlagDefault and ChapterFlagEnabled, which WebM does not list. The Opus elements (CodecDelay, SeekPreRoll, Channels, DiscardPadding) are kept because the Matroska Opus mapping needs them. A video packet may carry its own `timeMs`, so a remux keeps the source's timestamps.
- Reading. `readMatroska` checks the EBML header's DocType (`matroska` or `webm`), then visits the Segment's top-level elements header by header: Info, Tracks, Attachments and Chapters are parsed, each Cluster is only located, and SeekHead, Cues, Tags and Void are skipped. `blocks()` then reads one cluster at a time, so a file of any size is read in bounded memory. Laced blocks and unknown-size elements are refused (`MkvReadError`); a file that is not Matroska at all gets `NotMatroskaError`.
- Timestamps. TimestampScale is 1,000,000, so timestamps are whole milliseconds. Video frame i is at `videoMs(i)`. Blocks of every track are written in timestamp order (at equal times: video, audio, subtitles, each in track order). Block timestamps are 16-bit signed offsets from their cluster. A cluster opens at every video key frame, which is also where the video Cues point; a block more than 32,767 ms after its cluster's timestamp (a subtitle long after the last key frame) opens a new cluster at its own time, without a video Cue. Subtitle blocks must be at 0 ms or later, in whole milliseconds and in order: the writer throws rather than move them, so the caller drops or clamps events before the first video frame.
- Subtitles. Per the Matroska codec specification, `S_TEXT/ASS` keeps the script header as CodecPrivate and one Dialogue line per block (without its start and end, which become the block's timestamp and BlockDuration, so these blocks are BlockGroups); `S_HDMV/PGS` puts one display set per SimpleBlock. A subtitle block with a `durationMs` is a BlockGroup with BlockDuration (RFC 9559 §5.1.3.5.3), one without is a SimpleBlock.
- Subtitle cues. A player that seeks starts reading at the video cue before the seek point, so an event that began earlier and is still on screen would be missed. Every subtitle block therefore gets a cue of its own (RFC 9559 §5.1.5.1.2): CueTrack, CueClusterPosition, CueRelativePosition (the block's offset from the first byte of its cluster's data) and, for a block with a BlockDuration, CueDuration. CuePoints are in CueTime order; cues at one time share a CuePoint.
- ASS scripts. `assToMatroska` splits a script into the `S_TEXT/ASS` CodecPrivate (the script without its Dialogue and Comment lines, its `[Events]` Format line rewritten as `Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`) and one block per Dialogue line, its fields taken by name from the script's own Format line. ReadOrder is the line's place among the script's Dialogue lines, so players can restore file order. A caller-supplied offset moves each event (positive is later); times are rounded to whole milliseconds once; events that end at or before 0 or start at or after the episode's end are dropped, as are events whose end is not after their start and events whose times can't be read, and a start before 0 is clamped to 0.
- Attachments. One AttachedFile per file with FileName, FileMediaType, FileData and a random non-zero 64-bit FileUID (RFC 9559 §5.1.6.1); no FileDescription.
- AV1. IVF frames are AV1 temporal units. The muxer reads the sequence header OBU (AV1 spec §5.5) for the `av1C` record stored as CodecPrivate, strips temporal delimiter OBUs from block data as the Matroska AV1 mapping asks, and tests each unit for a key frame (§5.9.2).
- Opus. Ogg pages carry packets (RFC 3533 §6); the first is OpusHead (RFC 7845 §5.1) and goes in CodecPrivate unchanged. Each packet's duration comes from its TOC byte (RFC 6716 §3.1). The pre-skip becomes CodecDelay, 80 ms becomes SeekPreRoll, and samples trimmed from the end of the last packet (the final granule position, RFC 7845 §4.4) become DiscardPadding.

## API

- `readIvf(stream)` returns `IvfStream`: header, `packets` (an async iterator of `Av1Packet`) and `sequenceHeader` (resolves early with the `av1C` record).
- `readOggOpus(stream)` returns `OggOpusStream`: `head`, `packets` (`OpusPacket`) and `end` (`OggOpusEnd`, settles after the packets are consumed).
- `assToMatroska(script, durationMs, offsetMs?)` returns `AssTrackData`: the CodecPrivate and the `SubtitleBlock`s of an `S_TEXT/ASS` track.
- `episodeTags({ discKey, playlistId, startMs, title })` (`episode-tags.ts`) gives an episode MKV's segment tags (`SEIKOU_DISC_KEY`, `SEIKOU_PLAYLIST`, `SEIKOU_EPISODE_START_MS`, `ENCODER`, and with an episode title the title's tags (`ANILIST_ID`, or `SEIKOU_TITLE` and `SEASON`), `EPISODE`, `EPISODE_TITLE` and, for a title that is not AniList, `TITLE_NAME`); `ENCODER_TAG` is `seikou-encode <version of the repo's package.json>`.
- `readMkv(path)` (`readMatroska(reader)` in the package, over a `RangeReader`) returns `ParsedMkv`: `docType`, `title`, `durationMs`, `tracks` (`MkvTrack`, defaults filled in), `attachments`, the default edition's `chapters` and `blocks()`, an async generator of `MkvBlock` (track, `timeMs`, `keyframe`, `durationMs`, `discardPaddingNs`, data).
- `ebml-reader.ts`: `readElementHeader` for one element header, `parseElements`/`parseMkv` for a tree of a buffer in memory, and helpers over the tree (`find`, `findAll`, `childOf`, `uintOf`, `floatOf`, `stringOf`, `blocksInOrder`); the tests use it to check the writer's output.
- `writeMkv(path, input)` (`writeMatroska(sink, input)` in the package, through an `MkvSink`) muxes an `MkvInput` (video with its `TrackLabel`, `audio: MkvAudioTrack[]`, `subtitles: MkvSubtitleTrack[]` of `SubtitleBlock`s, `attachments: MkvAttachment[]`, `chapters`) into a file and returns an `MkvResult` (per-track packet and block counts, clusters, duration).
- Building blocks: `splitObus`, `parseSequenceHeader`, `isKeyframe`, `buildAv1C`, `stripTemporalDelimiters`, `opusPacketDuration`, and the `ebml.ts` element writers (`uint`, `sint`, `float64`, `ascii`, `utf8`, `binary`, `master`, `voidElement`, `vint`).

## Files

- `episode-tags.ts`: the segment tags of an episode MKV.
- `mkv-file.ts`, `node-io.ts`: `@seikou/matroska` on files (`writeMkv`, `readMkv`, `nodeFileSink`, `nodeRangeReader`).
- `writer.ts` (package): layout, interleaving, Cues, patching at the end.
- `reader.ts`, `ebml-reader.ts` (package): reading a Matroska file back.
- `ass-track.ts`: ASS script to `S_TEXT/ASS` CodecPrivate and blocks.
- `ebml.ts`, `ids.ts` (package): the element encoding and the IDs.
- `av1.ts`, `ivf.ts`: AV1 syntax and the IVF container; `bit-reader.ts` is the bit reader they share.
- `ogg.ts`: Ogg pages, OpusHead and packet durations; `chunk-reader.ts` reads exact byte counts from a stream.
- Tests: `encoder/tests/mux/` (the writer against real IVF and Ogg streams), `encoder/tests/package/mkv-reader.test.ts` for the reader, and `packages/matroska/src/*.test.ts` for the container code on its own; `encoder/tests/helpers/ebml-reader.ts` re-exports the package's `ebml-reader.ts` for the tests.

## Documentation

- [Encoding tools design (spec)](../../docs/superpowers/specs/2026-11-06-encoding-tools-design.md)
- [M1 pipeline prototype (plan)](../../docs/superpowers/plans/2026-11-06-m1-pipeline-prototype.md)
- [Matroska elements](https://www.matroska.org/technical/elements.html)
- [WebM container guidelines](https://www.webmproject.org/docs/container/)
- [SVT-AV1](https://gitlab.com/AOMediaCodec/SVT-AV1), the encoder that produces the IVF stream
- [opusenc](https://opus-codec.org/docs/opus-tools/opusenc.html), the encoder that produces the Ogg Opus stream
