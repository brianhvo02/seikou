# @seikou/matroska

Matroska and WebM reading and writing for any JavaScript host: Node, browsers and workers (no `node:` imports, no `Buffer`). `writeMatroska` muxes AV1 video, Opus audio, subtitle tracks (`S_TEXT/ASS`, `S_HDMV/PGS`), attached files and chapters through an `MkvSink`, which appends bytes and overwrites the few places only known at the end (the Segment size, the SeekHead and the duration). `readMatroska` reads a file's tracks, attachments and chapters through a `RangeReader` (a file, a blob or HTTP range requests) and yields the blocks one cluster at a time, so a file of any size is read in bounded memory. The EBML element writers and the tree reader the writer's tests use are exported too.

```ts
import { readMatroska, writeMatroska } from '@seikou/matroska';

// Write: give it a sink and the packets to mux.
await writeMatroska(sink, { video, videoPackets, audio: [], subtitles: [], attachments: [], chapters: [] });

// Read: give it something that reads byte ranges.
const mkv = await readMatroska(reader);
console.log(mkv.tracks, mkv.chapters, mkv.durationMs);
for await (const block of mkv.blocks()) {
  // block.track, block.timeMs, block.keyframe, block.data
}
```
