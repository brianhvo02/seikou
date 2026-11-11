# @seikou/fansubs

Finding and timing fansub subtitles for a disc. The package finds a title's best releases, picks one subtitle file per episode, downloads it with its fonts, reads the disc's dialogue audio, and shifts the subtitles until their dialogue lines up with the disc's. It is used by Seikou's NAS server and runs in Node.

## Modules

All sources are in `src/`. The package root exports the names listed in `public-api.txt`; every module can also be imported by path (`@seikou/fansubs/<module>`), and what the root leaves out is internal and can change without notice.

- Finding releases: `seadex` (`createSeaDex`) is the SeaDex client, by AniList id. `tosho` (`createTosho`) is the Anime Tosho client, for its JSON feed and storage downloads. The caller paces both; the NAS server makes one request every 2.5 s to each service.
- Choosing: `choose` (`choosePerEpisode`, `rankReleases`) ranks a SeaDex entry's releases and picks, per episode, the first with ASS or SSA subtitles in the wanted languages. `episode-files` (`episodeOfFile`, `mainFile`) reads which episode a release's file name holds.
- Fetching: `tracks` (`fetchTrack`) fetches a track and names it. `archive` (`unxz`, `fontsIn7z`) unpacks Anime Tosho's xz tracks and 7z font packs with the `7z-wasm` dependency. `fetch-cache` (`FetchCache`) is the download cache, and `semaphore` limits concurrent jobs.
- Reading the disc: `disc-source` (`FansubDiscSource`) is how the package reads a disc's files. `audio-decoder` (`AudioDecoder`) is the interface for turning an audio stream into PCM. `disc-audio` (`episodeAudio`) finds a playlist's dialogue audio through the disc's playlist and clip info, demuxes the audio PID and decodes it.
- Timing: `dialogue` (`dialogueIntervals`) finds which ASS events are speech, `speech` (internal) builds a speech mask from audio (one byte per 10 ms frame), `align` lines a track up with the disc (a single offset, a split at a cut, or `none`, and never a confident wrong answer), and `retime` shifts the Start and End of Dialogue lines.
- Picks: `pick-store` (`PickStore`) keeps a viewer's own Anime Tosho pick, with fonts pooled by content, within a byte budget.
- Tests: `fixture-sources` (`fixtureFansubSources`, internal) serves recorded SeaDex and Anime Tosho answers from a folder instead of the network.

## What a consumer provides

- The `fetch` the SeaDex and Anime Tosho clients use.
- A `FansubDiscSource`, which reads the disc's original files (paths are disc-relative and upper-case).
- An `AudioDecoder` that turns a clip's audio stream into 16 kHz PCM. The package runs no decoder of its own, so the server supplies one backed by ffmpeg (`ffmpegAudioDecoder` in `server/src/fansubs/ffmpeg-decoder.ts`).
- Directories for the caches and the pick store.

## Usage

```ts
import { createSeaDex, createTosho, choosePerEpisode, fetchTrack, align, retime } from '@seikou/fansubs';
```

The usual order: `createSeaDex` and `createTosho` find releases, `choosePerEpisode` picks files, `fetchTrack` and `fontsIn7z` download them, `episodeAudio` reads the disc, and `align` and `retime` shift the subtitles.

## Documentation and references

Links to repository files are relative to the Seikou repository.

- Using the packages in your own page or tool: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- Design: [`docs/superpowers/specs/2026-10-23-fansubs-design.md`](../../docs/superpowers/specs/2026-10-23-fansubs-design.md).
- The encoder's subtitle helper, which uses the same package: [`encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md`](../../encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md).
- Fansubs as a user sees them: [`docs/nas.md`](../../docs/nas.md). The services the NAS contacts for them are listed in [`docs/self-hosting.md`](../../docs/self-hosting.md).
- It builds on [`packages/ass`](../ass/README.md), [`packages/bdmv`](../bdmv/README.md), [`packages/nas`](../nas/README.md) and [`packages/titles`](../titles/README.md).
- SeaDex: https://releases.moe (the API the client calls is at https://seadex.moe)
- Anime Tosho: https://animetosho.org
