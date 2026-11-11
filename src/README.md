# Player app

This folder is the Seikou web app: a React front end for the player, the NAS screens and the help pages, plus the BD-J runtime that the engine uses for Java discs. Most of the player itself (the engine, the parsers, subtitles) lives in the workspace packages under [`packages/`](../packages), and the app wires them to a user interface.

## Entry files

- `main.tsx`: mounts `ui/App`, registers the service worker in production and asks for persistent storage when installed.
- `engine-worker.ts`: the engine worker's entry. It starts `@seikou/engine` and passes it the BD-J provider.
- `sw.ts`: the service worker (precache, offline, cross-origin isolation headers on cached responses).

## What's inside

- [`ui/`](ui): the React interface: the landing screen, the player screen and its menus (audio, subtitles, shaders, quality, encode menus), place saving and resume, touch and keyboard input, capabilities and memory profile, the theme, and the bundled [Anime4K](ui/anime4k) shaders.
  - [`ui/nas/`](ui/nas): the NAS client, pairing, the title and Encodes libraries, owner screens, the pre-flight with buffering and quality levels, subtitles and fansubs, and the WebRTC client in `ui/nas/rtc/`. Each screen keeps its logic in a pure `*-model.ts` file.
  - [`ui/help/`](ui/help): the `/help` pages, built from `docs/*.md` at build time.
- [`bdj/`](bdj): BD-J, a JVM written in TypeScript. It has the class-file loader, interpreter and natives (`jvm/`), the runtime and worker that run libbluray's Java stack, the graphics plane, input, fonts (FreeType), and the saved-data store (`store/`).
- [`bdj-classlib/`](bdj-classlib): the Java class library BD-J needs, as committed jars. Rebuild it only with `npm run bdj-classlib:build`.
- [`wasm/freetype/`](wasm/freetype): FreeType compiled to WASM for BD-J text. Rebuild it only with `npm run wasm:build`.
- [`probe/`](probe): the device probe page, `probe.html`, which checks what a browser supports.

The app imports `@seikou/engine`, `@seikou/nas`, `@seikou/bdmv`, `@seikou/ass` and `@seikou/titles`. The engine itself never imports from `src/`. BD-J reaches it only through a provider (`bdj/provider.ts`).

## Documentation

User docs: [`docs/getting-started.md`](../docs/getting-started.md), [`docs/playing-discs.md`](../docs/playing-discs.md) and, for contributors, [`docs/contributing.md`](../docs/contributing.md).

Design specs in [`docs/superpowers/specs/`](../docs/superpowers/specs):

- [`2026-10-14-m3-hdmv-menus-design.md`](../docs/superpowers/specs/2026-10-14-m3-hdmv-menus-design.md): HDMV menus.
- [`2026-10-15-m4a-pgs-srt-design.md`](../docs/superpowers/specs/2026-10-15-m4a-pgs-srt-design.md) and [`2026-10-15-m4b-ass-renderer-design.md`](../docs/superpowers/specs/2026-10-15-m4b-ass-renderer-design.md): subtitles.
- [`2026-10-15-m5b-bdj-jvm-core-design.md`](../docs/superpowers/specs/2026-10-15-m5b-bdj-jvm-core-design.md), [`2026-10-16-m5c-bdj-playback-design.md`](../docs/superpowers/specs/2026-10-16-m5c-bdj-playback-design.md), [`2026-10-17-m5d-bdj-menus-design.md`](../docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md) and [`2026-10-18-m5e-bdj-library-coverage-design.md`](../docs/superpowers/specs/2026-10-18-m5e-bdj-library-coverage-design.md): BD-J.
- [`2026-10-15-video-shaders-design.md`](../docs/superpowers/specs/2026-10-15-video-shaders-design.md): video shaders.
- [`2026-10-16-cross-browser-and-remote-design.md`](../docs/superpowers/specs/2026-10-16-cross-browser-and-remote-design.md): browser and mobile support.

Licences: [`bdj/NOTICE`](bdj/NOTICE) and [`bdj-classlib/NOTICE`](bdj-classlib/NOTICE).
