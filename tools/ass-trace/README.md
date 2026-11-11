# libass trace harness

This harness runs real libass on an ASS script and records what it lays out and draws, so Seikou's native ASS renderer (`packages/ass/src/`, milestone 4b) can be compared with libass frame by frame. The renderer is a port of libass, and a difference between the two is a porting bug. The reference is libass 0.17.5 (`4a05d81`), patched by `trace.patch` to print its layout, built in Docker with FreeType, HarfBuzz and FriBidi from Ubuntu 24.04 (pinned by digest), without fontconfig or libunibreak.

## What's inside

- `Dockerfile`: the image that builds the patched libass and `ass_trace.c`.
- `trace.patch`: the changes to libass that make it print its layout trace.
- `ass_trace.c`: the harness program. It renders a script at each listed time and writes the trace and the frames.
- `build.sh`: `npm run ass-trace:build`, builds the image.
- `golden.sh`: `npm run ass-trace:golden`, regenerates the committed goldens.
- `run.sh`: runs libass on one script (`npm run ass-trace` wraps it).
- `out/`: output of local runs (gitignored).

The comparison side lives in `tests/ass-trace/` (the trace format, the runner and the goldens) and is run by `npm run test:ass`.

## Commands

- `npm run ass-trace:build` builds the image.
- `npm run ass-trace:golden` regenerates `tests/ass-trace/golden/` from every `fixtures/ass/<name>/<name>.ass`
  that has a `times.txt` (one time in ms per line; an optional `storage.txt` holds `<w>x<h>`). Never edit
  the goldens by hand: a difference between libass and our renderer is fixed in the port. CI regenerates them
  and fails on any diff (`.github/workflows/ass-trace.yml`).
- `npm run ass-trace -- <file.ass> <fonts dir> <times file> [<w>x<h>]` traces any file into
  `tools/ass-trace/out/<name>/` (`trace.jsonl` and `<ms>.png`).
- `ASS_LOCAL=1 npx playwright test -c playwright.ass.config.ts local` checks real scripts: each
  `fixtures/local/ass/<name>/` (gitignored) holds a script, its fonts (any depth up to two) and optionally
  `times.txt` and `exceptions.json` (`{"events": {"<index>": "reason"}}`, differences recorded in
  `docs/known-issues.md`, reported but not failing). libass runs live, cached by content in
  `tools/ass-trace/out/local/<name>/`; the report, our failing frames and diff images go to
  `test-results/ass-local/<name>/`. The gate also checks the animated draw-time p95 against 8 ms.

Settings match what our trace page uses: a 1920×1080 frame, font scale 1, no hinting, complex shaping, no
font provider other than the fonts directory and `[Fonts]`, DejaVu Sans (from the fonts directory) as the
default font, no colour-matrix conversion. Frames are libass's images blended onto opaque `#808080`.

The trace format (one JSON line per event shown, after collision handling) is documented in
`tests/ass-trace/format.ts`.

## Documentation

- The commands are listed in the Commands section of `CLAUDE.md`.
- The renderer and this harness were designed in `docs/superpowers/specs/2026-10-15-m4b-ass-renderer-design.md`.
- Known differences from libass are recorded in `docs/known-issues.md`.
- libass: https://github.com/libass/libass
