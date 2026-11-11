# @seikou/matroska

Matroska and WebM reading and writing for any JavaScript host: Node, browsers and workers (no `node:` imports, no `Buffer`). It is what the encoder uses to write its MKV files and what the player's engine uses to read them.

## What it does

- `writeMatroska` muxes AV1 video, Opus audio, subtitle tracks (`S_TEXT/ASS`, `S_HDMV/PGS`), attached files, chapters and Segment tags through an `MkvSink`. It writes Cues for video key frames and for every subtitle block, so a player can seek. `checkMatroskaInput` runs the checks that need no packets, so a caller can refuse a bad input before it opens a file.
- `openMatroska` opens a file for playback over byte-range reads. It reads the SeekHead and, through it, tracks, attachments (their bytes only when you call `data()`), chapters, tags and Cues, and no Cluster. `blocksFrom(timeMs)` then yields blocks from the right cluster onward, splitting laced blocks.
- `readMatroska` reads a whole file front to back, one cluster at a time, in bounded memory. It refuses laced blocks and elements of unknown size.

Both readers take a `RangeReader`: `{ size, name?, read(offset, length, signal?) }`. A reader's `name` (a path or URL) ends every error message.

## Modules

All sources are in `src/`. The package root exports the names listed in `public-api.txt`; every module can also be imported by path (`@seikou/matroska/<module>`), and what the root leaves out is internal and can change without notice.

| Module | What it does |
| --- | --- |
| `writer` | `writeMatroska` and `checkMatroskaInput`: the muxer. |
| `playback` | `openMatroska`: the seekable reader, with `blocksFrom(timeMs)`. |
| `reader` | `readMatroska`: the front-to-back reader. |
| `parse` | Internal: pieces both readers share: reading ranges, the EBML header and Segment, TrackEntry, chapters and splitting a cluster into blocks. |
| `ebml`, `ebml-reader`, `ids` | EBML element writers, the tree reader, and the Matroska element ids, each noted with the section of RFC 8794 or RFC 9559 that defines it. |
| `io` | The `RangeReader` and `MkvSink` interfaces. |
| `blob-reader` | `blobRangeReader`: a `RangeReader` over a `Blob` or `File`. |
| `timing` | `videoMs`, `framesToNs` and `frameDurationNs`, which put frames on the Matroska time grid. |
| `errors` | The errors the readers throw for a file that is truncated, malformed or not Matroska. |
| `test-io` | An in-memory `MkvSink` for tests (internal). It is not shipped in the npm package. |

## What a consumer provides

- A `RangeReader` for reading: `{ size, name?, read(offset, length, signal?) }`. `blobRangeReader` covers a `Blob` or `File`, and the usage example below shows HTTP and Node files.
- An `MkvSink` for writing: `write` appends, `writeAt` overwrites bytes already written, and `close` finishes.

## Usage

```ts
import { blobRangeReader, openMatroska, writeMatroska, type MkvSink } from '@seikou/matroska';

// In a browser or worker, a Blob or File is a RangeReader through blobRangeReader.
const mkv = await openMatroska(blobRangeReader(file));
console.log(mkv.tracks, mkv.chapters, mkv.tags, mkv.durationMs);
for await (const block of mkv.blocksFrom(90_000)) {
  // block.track, block.timeMs, block.keyframe, block.data
}

// HTTP range requests, or a Node file, are a few lines each: read `length` bytes at `offset`
// (a Range header, or fs.read on a file handle) and return fewer only at the end of the data.
const httpReader = {
  size,
  name: url,
  async read(offset, length, signal) {
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal });
    return new Uint8Array(await res.arrayBuffer());
  },
};

// Writing: the MkvSink is yours to implement. `write` appends, `writeAt` overwrites bytes already
// written (the Segment size, the SeekHead and the duration are patched at the end), `close` finishes.
declare const sink: MkvSink;
await writeMatroska(sink, {
  video, // { width, height, fpsNum, fpsDen, codecPrivate, name, language, isDefault }
  videoPackets, // AsyncIterable of { index, keyframe, data }
  audio: [],
  subtitles: [],
  attachments: [],
  chapters: [{ title: 'Opening', startNs: 0n }],
  tags: { TITLE: 'Starfall Wanderer', EPISODE: '1' },
  appName: 'my-muxer', // MuxingApp and WritingApp; `@seikou/matroska` when left out
});
```

A laced block comes out one frame per `MkvBlock`, with `frameIndex` and `frameCount` set. Frame times are spaced by the track's DefaultDuration, else by an equal share of the block's BlockDuration; with neither (Opus audio written by `writeMatroska` has no DefaultDuration), every frame carries the block's own time, and a caller that needs the real spacing, such as an Opus packet's length from its TOC byte, works it out from `frameIndex` and `frameCount`.

The `timing.ts` helpers (`videoMs`, `framesToNs`, `frameDurationNs`) are exported because packet times and chapter times must fall on the same frame grid: a video packet's timestamp is `videoMs(index, video)` in whole milliseconds, and a chapter that starts at a frame is `framesToNs(frame, video)`, which the reader rounds back to that same millisecond. Computing both through these functions keeps a chapter's start equal to its frame's block time.

The EBML element writers (`concat`, `uint`, `sint`, `float64`, `ascii`, `utf8`, `binary`, `master`, `voidElement`) and the tree reader (`parseMkv`, `find`, `findAll`, `childOf`, `uintOf`, `floatOf`, `stringOf`, `EbmlNode`, `EbmlError`) are exported too. The lower-level `vint`, `vintFixed8`, `idBytes`, `parseElements` and `readElementHeader` are internal, importable from `@seikou/matroska/ebml` and `@seikou/matroska/ebml-reader`.

## Documentation and references

Links to repository files are relative to the Seikou repository.

- Using the packages in your own page or tool: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- Where the package is used: the encoder, [`encoder/docs/superpowers/specs/2026-11-06-encoding-tools-design.md`](../../encoder/docs/superpowers/specs/2026-11-06-encoding-tools-design.md), and the player's engine, [`docs/superpowers/specs/2026-11-08-encodes-library-design.md`](../../docs/superpowers/specs/2026-11-08-encodes-library-design.md).
- The packages' design: [`docs/superpowers/specs/2026-11-07-packages-design.md`](../../docs/superpowers/specs/2026-11-07-packages-design.md).
- Matroska element list: https://www.matroska.org/technical/elements.html
- Matroska format, RFC 9559: https://www.rfc-editor.org/rfc/rfc9559
- EBML, RFC 8794: https://www.rfc-editor.org/rfc/rfc8794
- WebM container: https://www.webmproject.org/docs/container/
