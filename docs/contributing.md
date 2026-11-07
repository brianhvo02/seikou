# Contributing

`CLAUDE.md` at the repository root is the full developer reference: the architecture, every command, the constraints (licensing, supported browsers, test fixtures) and the specs under `docs/superpowers/specs/`. Read it first. This page keeps the everyday commands and notes.

Seikou's own code is licensed LGPL-3.0-or-later (see the top-level `LICENSE` and `COPYING`). Files ported from libbluray, libudfread and FFmpeg keep LGPL-2.1-or-later, as their headers say. Some directories have their own licences: see the License section of the README. `npm run licence-check` checks the headers and every `package.json`.

## Run and build

- `npm run dev`: dev server (cross-origin isolated).
- `npm run build`: typecheck, then production build.
- `npm run typecheck`: `tsc -b`.

## Tests

- `npm test`: unit tests.
- `npm run test:e2e`: Playwright. The `chromium` and `mobile-chromium` projects require Google Chrome, and all projects need a working audio output. `--project=firefox|webkit|mobile-chromium` runs the others.
- The A/V sync checks allow 20 ms mean and 50 ms max offset. `SYNC_TOLERANCE_SCALE=2` doubles both on slower machines.
- Put your own decrypted discs under `fixtures/local/<name>/BDMV/...` to enable `tests/local`. `LOCAL_DISCS=1 npx playwright test local-discs` also plays each one in Chrome, seeks around it, switches audio tracks and checks every PG subtitle track. It decodes the PG streams in Node first to know where subtitles are due, and caches that in `fixtures/local/.pgscan-<name>.json`.
- Nightly sync test:

      npx tsx scripts/make-fixture-disc.ts fixtures/local/long-disc --seconds-per-clip 300
      NIGHTLY=1 npx playwright test -g "ten minutes"

## Fixtures and generated files

- `npm run fixture:synthetic` regenerates `fixtures/synthetic/`. It needs `ffmpeg` on PATH with libx264 (the video fixtures), its mpeg2video encoder (`disc-mpeg2-menu`) and its ac3, eac3, dca and truehd encoders (the audio fixtures and `disc3`), and Docker for `disc1.iso`. Their bytes depend on the host ffmpeg version (currently 9.0.2). `fixtures/synthetic/disc3` is the four-codec audio disc (LPCM, AC-3 5.1, TrueHD with an AC-3 core, DTS).
- `npm run wasm:build` rebuilds `packages/engine/wasm/audio/audio.wasm` (FFmpeg n9.0.2 AC-3, E-AC-3 and DTS decoders plus `shim.c`) and `src/wasm/freetype/freetype.wasm` (FreeType 2.13.2 with Ubuntu's patches, for BD-J text) in Docker (`wasm:build:audio` / `wasm:build:freetype` build one). It needs Docker. The builds are reproducible, and `.github/workflows/wasm.yml` checks that the committed `.wasm` files match. `npm run bdj-trace:freetype-golden` regenerates `tests/bdj/fonts/freetype-golden.json` from the BD-J harness image's system FreeType.
- `scripts/fetch-libbluray.sh` clones libbluray at the commit the engine is ported from into `.cache/libbluray` (gitignored), the reference for every ported function.
- The libbluray trace harness (`tools/vm-trace/`, Docker): `npm run vm-trace:build` builds patched libbluray and the harness, `npm run vm-trace:golden` regenerates `tests/vm-trace/golden/` from it (never edit those by hand), and `npm run vm-trace -- <disc> <script> [--dump-pages]` runs libbluray and our replay live and prints the first divergence. `npm test` replays the golden traces without Docker.

## CI

`.github/workflows/ci.yml` runs typecheck and unit tests, then the Playwright suite on `ubuntu-latest`, one runner per browser project (`chromium`, `firefox`, `webkit`, `mobile-chromium`). `scripts/ci-audio.sh` gives the runner a PulseAudio null sink, because the sync tests need a running audio output. CI uses `SYNC_TOLERANCE_SCALE=1.5`; local runs keep the default bounds.

To try the Linux setup locally in Docker, install Chrome from `dl.google.com/linux/direct/google-chrome-stable_current_<arch>.deb`. Google ships arm64 builds, but `npx playwright install chrome` (Playwright 1.64) still refuses to run on Linux arm64.

## Deployment

The player needs `SharedArrayBuffer` (audio ring buffer), which browsers only expose to cross-origin isolated pages. A static deploy of `dist/` must therefore send these response headers on every file:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

`public/_headers` (copied into `dist/` by `npm run build`) does this on Netlify and Cloudflare Pages:

    /*
      Cross-Origin-Opener-Policy: same-origin
      Cross-Origin-Embedder-Policy: require-corp

Hosts must serve `.wasm` as `application/wasm`. Other hosts need the equivalent in their own configuration. Without the headers the app shows an error and cannot play.

To run the NAS server, see [Self-hosting](self-hosting.md).
