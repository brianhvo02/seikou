# vm-trace: libbluray trace harness

This harness runs a disc through real libbluray and prints what its HDMV virtual machine and navigation do (register writes, events, seeks, and a hash of the interactive-graphics and PG planes after each step). Seikou's HDMV VM, Navigator and graphics controller are ported from libbluray, so the port is checked by replaying the same key script and comparing the two traces entry by entry. A difference is a porting bug to fix in the port, never in a golden file.

## What's inside

- `Dockerfile`: ubuntu 24.04 (pinned by digest, linux/amd64) with libbluray cloned at `448f896`, `trace.patch` applied, built with meson as a static library, and `vm_trace.c` linked statically against it.
- `trace.patch`: four small changes to libbluray, nothing else.
  - `register.c`: `bd_trace_write_cb` is called after every successful `bd_gpr_write` / `bd_psr_setting_write`, after the PSR callbacks have run.
  - `bluray.c`: `bd_trace_event_cb` is called for every event put in the event queue, `bd_trace_seek_cb` for every accepted `bd_seek_playitem` / `bd_seek_mark` / `_clip_seek_time` (the `seek` entries), and `bd_trace_finished()` reports that the HDMV program has ended and no playlist is playing.
  - `hdmv_vm.c`: the random state always starts at 1.
  - `util/time.c`: `bd_get_scr()` is a counter that the harness advances by 1800 per read (`bd_trace_tick()`).
- `vm_trace.c`: the harness. `vm_trace <disc-dir> <script>` prints the trace (`tests/vm-trace/format.ts`) to stdout. libbluray's own log goes to stderr.
  - It registers an overlay callback (which also turns libbluray's graphics controller on) and applies the IG overlay operations to a Y, Cr, Cb, T plane with exactly the semantics of `packages/pg/src/overlay-plane.ts`. Every `step` entry carries that plane's FNV-1a hash as `plane`.
  - It sets `BLURAY_PLAYER_SETTING_DECODE_PG` (without it libbluray decodes no PG; it also sets PSR2's display flag, which the replay repeats untraced) and applies the PG overlay operations to a second, buffered plane (a back buffer that `BD_OVERLAY_FLUSH` copies to the visible plane, as `OverlayPlane`'s buffered mode does). `step` entries carry the visible PG plane's hash as `pg`.
  - The script step `subs off` is `bd_select_stream(bd, BLURAY_PG_TEXTST_STREAM, 1, 0)` here and `PgStreamControl.select('off')` in the replay. `subs N` is `bd_select_stream(bd, BLURAY_PG_TEXTST_STREAM, N, 1)` and `select({ pg: N })`. A disc's own program usually leaves PG off.
- `build.sh`: `npm run vm-trace:build` builds the image and copies the binary to `out/vm_trace` (gitignored).
- `golden.sh`: `npm run vm-trace:golden` regenerates `tests/vm-trace/golden/*.jsonl` for every script in `tests/vm-trace/scripts/` whose disc is in `fixtures/synthetic`. Golden files are only ever produced this way, never edited. CI regenerates them and fails on any diff.
- `run.sh <disc> <script>`: libbluray's trace for `fixtures/synthetic/<disc>` and `tests/vm-trace/scripts/<disc>.<script>.keys`, run in the pinned image with the disc mounted read-only. `<disc>` may also be a path to a disc folder and `<script>` a path to a `.keys` file.
- `npm run vm-trace -- <disc> <script> [--dump-pages]` runs both sides live and prints the first divergence. With `--dump-pages` the replay prints every IG menu it reads (pages, buttons with rectangles and centres, neighbours, decoded commands), which is how scripts for real discs are written. Scripts for local discs (the ones in `tests/vm-trace/scripts/` named after a disc in `fixtures/local/` rather than a synthetic disc) have no golden file; run them with the disc's folder as `<disc>`, for example `npm run vm-trace -- fixtures/local/<disc folder> tests/vm-trace/scripts/<script>.keys`.

## How a run is sequenced

PSR 8 (TIME) is not traced: it follows the presentation position, which is time dependent. Everything else is compared in order and by value; times are diagnostic.

libbluray splits its work over `bd_read_ext()` calls in ways that depend on its event queue, so the harness does not step scripts per call. Each loop iteration first lets the VM run until it is suspended and the queue is empty (`bd_read_ext` with a zero length, repeated), then runs every script step whose `wait` holds, each followed by the same settling, and finally does one 6144-byte read (the clock advances 1800 per read). Waits are state based: `wait title N` holds while the last title entry is N, `wait page N` while the last PSR 11 write was N, `wait end` while the program has ended and no playlist plays. The replay in `tests/vm-trace/replay.ts` follows the same sequence.

Interactive graphics are fed as libbluray feeds them. A main-path IG stream is demuxed per 6144-byte aligned unit as it is read (`gc_decode_ts(..., -1)`, no PTS gate), and a completed display set runs INIT_MENU inside that read, before play marks are checked; the replay hands the navigator the PES units that complete in the unit just read. A sub-path IG clip is read whole when its playlist opens (`_preload_m2ts`, synchronous in libbluray): the replay's settling waits for the navigator's preload to finish and then lets the VM run again.

PG is fed the same way: the PES units of the PID PSR2 names (main path) that complete in the aligned unit just read are decoded, and a completed display set is rendered at once (libbluray's `GC_CTRL_PG_UPDATE` right after `gc_decode_ts`); presentation timing is the overlay consumer's job and is not traced.

Script steps that act on animated or effect-driven pages should follow a `wait page N` and a `wait reads N`, so both sides hash the plane at the same point of the deterministic 1800-tick clock.

Events (`title`, `playlist`, `playitem`, `chapter`, `menu`, `popup`, `uo`, `sound`, `still`) are logged when libbluray queues them, which inside a PSR write is during callback dispatch, before that write's `psr` entry. The replay logs them from a PSR listener registered ahead of the Navigator for the same reason.

## Limits

- Item stills (`BD_EVENT_STILL_TIME`) have no trace entry; `still` is the HDMV STILL event only, but the replay logs it from the port's `hold()`, so a disc with item stills would diverge until that is separated.
- The replay port assumes play items start at packet 0 (first item, seamless connections) and tracks marks by packet like libbluray; other start packets are not modelled there. The Navigator itself derives start packets from the CLPI like `_fill_clip`.
- libbluray exposes no IG composition through its API, so `--dump-pages` comes from our decoder, not from the harness.

## Documentation

- The commands are listed in the Commands section of `CLAUDE.md`.
- The HDMV VM, menus and the comparison were designed in `docs/superpowers/specs/2026-10-14-m3-hdmv-menus-design.md`.
- The comparison side is `tests/vm-trace/` (trace format, replay, key scripts and goldens). CI regenerates the goldens in `.github/workflows/vm-trace.yml`.
- libbluray (the upstream, ported here at commit `448f896`): https://www.videolan.org/developers/libbluray.html
- The BD-J counterpart is `tools/bdj-trace/README.md`.
