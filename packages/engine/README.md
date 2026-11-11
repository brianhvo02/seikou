# @seikou/engine

The Blu-ray player engine for browsers. It opens a disc from local files or a NAS over HTTP (`openDisc`), runs HDMV navigation and IG menus, demuxes and decodes the video and audio, and composites video, PG, ASS and text subtitles on an `OffscreenCanvas`. All of this runs in a worker that `createEngineWorker(name)` starts.

On the page, `createController({ worker, profile })` returns a `PlayerController`, an external store over the worker's messages that also plays the audio through an AudioWorklet. The engine also plays the AV1 and Opus episodes the Seikou encoder makes, from Matroska files.

The reference, with an example for every function, is at [/developers/engine](https://bluray.pages.dev/developers/engine).

## Modules

All of it lives in `src/`. The package root exports the names listed in `public-api.txt`; every module can also be imported by path (`@seikou/engine/<module>`), and what the root leaves out is internal and can change without notice.

| Module | What it does |
| --- | --- |
| `protocol.ts` | The contract between page and worker: the `EngineCommand` and `EngineEvent` unions and `Telemetry`. |
| `player.ts`, `worker-main.ts`, `worker.ts` | `Player` owns one disc and at most one playing playlist; `startEngineWorker` (in `worker-main.ts`) is the worker's entry, and `worker.ts` is the package's own. |
| `controller/` | The page side: `createController`, `PlayerController` and its snapshot reducer, the audio output and AudioWorklet (`pcm-worklet.ts`), file drops and folder walking (`entry-walk.ts`), Wake Lock and Media Session. |
| `disc/` | Opening a disc: `openDisc`, `FileSource` for local files, `RemoteSource` and `HttpTransport` for a NAS, `port-fetch.ts` for reads over a `MessagePort`, the read-ahead cache and its fill (buffer first), main-title guessing and player settings. |
| `nav/`, `hdmv/` | Navigation and the HDMV virtual machine: the navigator, playlist timeline, registers (PSRs and GPRs), UO masks, and PG stream selection. |
| `graphics/` | IG decoding and the graphics controller behind HDMV menus. |
| `playback/` | The pipeline that reads, demuxes and feeds the decoders, with backpressure and seek, plus stream selection and tracks. |
| `decode/` | Video through WebCodecs (H.264, HEVC, AV1); audio through LPCM, `audio.wasm` (FFmpeg's AC-3, E-AC-3 and DTS decoders, with the TrueHD core filter) and Opus through WebCodecs. |
| `audio/`, `clock/` | The shared-memory PCM ring, the writer, and `MasterClock`, which derives playback time from the frames played. |
| `render/` | `VideoPresenter` picks which frame to show against the clock, and `Compositor` draws video, subtitles and menus. |
| `shaders/` | mpv user shaders (such as Anime4K) parsed, planned and run on WebGL2. |
| `subs/` | SRT parsing and layout, the text renderer interface and the episode subtitle set. PG comes from `@seikou/pg` and ASS from `@seikou/ass`. |
| `encode/` | Playing an encode: one MKV as a play item, with its AV1 and Opus tracks, chapters, and ASS and PGS subtitles. |
| `bdj-provider.ts`, `bdj-types.ts` | The optional BD-J interface (see below). |
| `memory-profile.ts` | The desktop and constrained memory profiles. |
| `wasm/audio/` | `audio.wasm` and its build source. Rebuild it only with `npm run wasm:build` at the repository root. |

## What a consumer must provide

- Vite. The package imports its AudioWorklet, `audio.wasm` and the default font with Vite's `?url` and `?worker&url` suffixes. A TypeScript consumer needs Vite's client types (`"types": ["vite/client"]` in its tsconfig), or tsc reports those imports as unknown modules.
- Cross-origin isolation: the audio ring is a `SharedArrayBuffer`, so the page must be served with COOP and COEP headers.
- A canvas and a worker: pass `createController` a worker factory and a profile, and attach an `HTMLCanvasElement`; the worker draws on its transferred `OffscreenCanvas`.
- BD-J, optionally: a host with a BD-J runtime writes its own worker entry that calls `startEngineWorker` from `@seikou/engine/worker-main` with a `BdjProvider` (from `@seikou/engine/bdj-provider`); both are internal modules, outside the root's API. Seikou's app passes `seikouBdjProvider` from `src/bdj/`. Without a provider, BD-J discs open to the playlist picker.

## Usage

```ts
import { createController, createEngineWorker } from '@seikou/engine';

const controller = createController({ worker: () => createEngineWorker('bluray-engine'), profile: 'desktop' });
controller.attachCanvas(canvas); // an HTMLCanvasElement; the worker draws on its OffscreenCanvas
controller.subscribe(() => render(controller.getSnapshot()));
controller.open(entries); // [path, File] pairs of a BDMV folder (walkEntries, also exported, turns dropped entries into them)
```

## Documentation

These are in the Seikou repository.

- Using the packages in your own page or tool: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- Design: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`, and the package split in `docs/superpowers/specs/2026-11-07-packages-design.md`.
- Audio: `2026-10-13-m2-audio-coverage-design.md`. HDMV menus: `2026-10-14-m3-hdmv-menus-design.md`. Subtitles: `2026-10-15-m4a-pgs-srt-design.md` and `2026-10-15-m4b-ass-renderer-design.md`. Shaders: `2026-10-15-video-shaders-design.md`. BD-J: `2026-10-16-m5c-bdj-playback-design.md`. Encodes: `2026-11-08-encodes-library-design.md` (all under `docs/superpowers/specs/`).
- `NOTICE` lists the files derived from [libbluray](https://www.videolan.org/developers/libbluray.html) and [FFmpeg](https://ffmpeg.org), and the FFmpeg build behind `audio.wasm` (`wasm/audio/NOTICE`). The shader support follows libplacebo's behaviour without containing its code.
- Video and audio decoding uses [WebCodecs](https://www.w3.org/TR/webcodecs/).
- Sibling packages: `@seikou/bdmv` (parsers and demuxer), `@seikou/pg`, `@seikou/ass`, `@seikou/matroska`, `@seikou/nas`.
