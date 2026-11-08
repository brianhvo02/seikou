# package/: an episode MKV as a static web directory

This area turns a finished episode MKV into the files a browser player needs. Browsers play AV1 and Opus in WebM but take neither ASS, PGS nor attached fonts there, so each of those becomes a file of its own, and a manifest lists them. Nothing here encodes: every byte comes from the MKV.

## Concepts

- **The directory.**

  ```
  <name>/
    video.webm           AV1 + every Opus track, chapters, no attachments
    subs/<n>-<lang>-<kind>.ass
    fonts/<file>
    pgs/<n>-<lang>.sup
    chapters.vtt
    episode.json
  ```

  `n` counts the tracks of that kind from 1 in the MKV's track order, `lang` is the track's Language, and `kind` is `signs` for a forced ASS track (FlagForced, RFC 9559 §5.1.4.1.6, which the encode sets on signs-and-songs tracks) and `full` otherwise. `subs/`, `pgs/` and `fonts/` exist only when they have files.
- **WebM.** A Matroska file with DocType `webm` and the elements the WebM container guidelines allow. `writeWebm` remuxes the MKV's first AV1 track and every Opus track, renumbered from 1, through the same writer that wrote the MKV (`mux/mkv-writer.ts` with `docType: 'webm'`): the blocks keep their data and timestamps, clusters open at video key frames and the Cues point only at those. Subtitle tracks, attachments and tags are left out.
- **ASS.** An `S_TEXT/ASS` track keeps the script's header as CodecPrivate and one event per block, `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`, timed by the block (Matroska codec specification, "SSA/ASS"). `rebuildAss` puts the events back as Dialogue lines in ReadOrder order, after the `[Events]` Format line, with times rounded to centiseconds. Centiseconds are as fine as an ASS time goes, while the MKV's blocks are timed in milliseconds: a time that is not a multiple of 10 ms (a nudge such as -3 ms moves every event off the centisecond grid) lands up to 5 ms from the MKV's time in the web `.ass`.
- **PGS.** An `S_HDMV/PGS` block is one display set: its segments (type, 16-bit length, data) without the `.sup` headers. `toSup` writes each segment behind a 10-byte header: `PG`, the PTS (the block's time on the 90 kHz clock, 32 bits) and a DTS of 0.
- **Chapters.** `toVtt` writes one WebVTT cue per chapter, from its start to the next chapter's, the last to the MKV's Duration; titles are escaped as WebVTT cue text.
- **Zero.** The MKV's zero is the episode's first video frame, and every file keeps it: block times, `.sup` PTS, ASS times and chapter cues all count from there.
- **All or nothing.** `packageEpisode` builds the directory under a temporary name beside it and moves it into place when complete, replacing an older one: only an empty directory or one holding an `episode.json` (an earlier package of an episode) is replaced, and anything else at that path is refused with `PackageError` before anything is written; on failure the temporary directory is removed. The MKV is read twice, one cluster at a time (`mux/mkv-reader.ts`): once for the subtitle blocks, which are small and kept in memory, and the block count of every track, once for the WebM. Each track's stream ends at its count, so the remux never reads ahead to learn that a block is a track's last; blocks of other tracks wait only while they are interleaved ahead, and more than 64 MiB waiting (an Opus track starting far later than the video) is refused with `WebmError`.

## API

- `packageEpisode(mkvPath, outDir)` writes the directory and returns its `EpisodeManifest` (`title`, `video { file, width, height }`, `audio { index, name, language, default }[]`, `subtitles { file, name, language, default }[]`, `pgs { file, name, language }[]`, `fonts`, `chapters`), the content of `episode.json`.
- `writeWebm(mkv, path, { blockCounts, maxQueuedBytes })`, `countBlocks(mkv)` and `webmTracks(mkv)`, `safeName(name, fallback)`, `rebuildAss(codecPrivate, blocks)`, `toSup(blocks)`, `toVtt(chapters, durationMs)`.
- Errors: `NotMatroskaError` and `MkvReadError` (from `readMkv`), `WebmError` (no AV1 track, or a track missing what its codec needs), `PackageError` (an ASS block that is not a Matroska ASS event, or an output path holding something other than a package), `SupError` (a PGS block that does not split into whole segments).

## Where to look

- `package.ts`: the directory, the manifest and the ASS rebuild.
- `webm.ts`: the remux, and the splitter that turns one pass over the blocks into one stream per track.
- `sup.ts`, `vtt.ts`: the `.sup` and WebVTT writers.
- Tests: `encoder/tests/package/` (an episode MKV built from the fixtures by `episode-mkv.ts`), and `encode --web` in `encoder/tests/encode.test.ts`.
