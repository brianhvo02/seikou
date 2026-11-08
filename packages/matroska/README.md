# @seikou/matroska

Matroska and WebM reading and writing for any JavaScript host: Node, browsers and workers (no `node:` imports, no `Buffer`).

- `writeMatroska` muxes AV1 video, Opus audio, subtitle tracks (`S_TEXT/ASS`, `S_HDMV/PGS`), attached files, chapters and Segment tags through an `MkvSink`. It writes Cues for video key frames and for every subtitle block, so a player can seek. `checkMatroskaInput` runs the checks that need no packets, so a caller can refuse a bad input before it opens a file.
- `openMatroska` opens a file for playback over byte-range reads. It reads the SeekHead and, through it, tracks, attachments (their bytes only when you call `data()`), chapters, tags and Cues, and no Cluster. `blocksFrom(timeMs)` then yields blocks from the right cluster onward, splitting laced blocks.
- `readMatroska` reads a whole file front to back, one cluster at a time, in bounded memory. It refuses laced blocks and elements of unknown size.

Both readers take a `RangeReader`: `{ size, name?, read(offset, length, signal?) }`. A reader's `name` (a path or URL) ends every error message.

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

The EBML element writers and the tree reader the tests use are exported too.
