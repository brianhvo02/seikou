# Milestone 4a: PGS and SRT Subtitles — Design Spec

Date: 2026-10-15
Status: Implemented (2026-10-15); plan `docs/superpowers/plans/2026-10-15-m4a-pgs-srt.md`. See §9 for where the implementation differs.
Parent spec: `2026-10-12-bluray-web-player-design.md` (§6, §7, §9, §11 milestone 4). Builds on `2026-10-14-m3-hdmv-menus-design.md` (graphics stack, trace harness).

## 1. Goal and scope

A user watching a disc can turn on any of its PG subtitle streams, sees forced captions (signs, foreign-language lines) even with subtitles off, and can load an `.srt` file of their own (from a menu or by dropping it on the player), shift its timing and change its size. Disc subtitles are verified against real libbluray with the M3 trace harness.

In scope:

- PGS: segment decoding (PCS, WDS, PDS, ODS, END), display sets with epoch start, acquisition point and normal states, rendering through the graphics controller's PG path (forced objects, PSR2 display flag, cropping), stream selection through PSR2, timed presentation by PTS.
- SRT: text decoding (BOM, strict UTF-8, user-chosen fallback), parsing, styling (`<i> <b> <u> <font color>`, `{\anN}`), drawing on the canvas, offset (±100 ms steps, `[` and `]`) and size scale.
- A subtitle menu, drag and drop of `.srt`, and an encoding prompt.
- Trace harness extension: PG plane hashes and a synthetic PG disc with golden traces.

Out of scope: the native ASS renderer and its golden-image tests (milestone 4b, its own spec), HDMV TextST streams (stream type 0x92), PG carried in sub-paths (libbluray decodes main-path PG only), remembering subtitle files per disc, and showing a PG stream and a text track at the same time.

Decisions taken during brainstorming:

| Question | Decision |
|---|---|
| Scope | Split milestone 4: M4a is PGS and SRT; M4b is the native ASS renderer |
| PGS verification | Extend the libbluray trace harness (PG plane hash, PSR2), plus unit and E2E tests and the real-disc gate |
| SRT features | Offset and size controls, encoding fallback, drag and drop (not per-disc memory) |
| Selection | One subtitle choice (a PG stream, the text track, or Off); forced PG captions show whatever is chosen |
| Where text is drawn | In the engine worker's compositor, on the same clock as video (not a DOM overlay) |

## 2. Components

PG code is ported from libbluray at commit `448f896`, lives under `src/engine/`, is LGPL-2.1-or-later with SPDX headers, and is listed in `src/engine/NOTICE`. SRT code is original.

| File | Source | Responsibility |
|---|---|---|
| `graphics/pg-decoder.ts` | `decoders/pg_decode.c`, `graphics_processor.c` (PG branch) | `PgSegmentDecoder.push(payload, pts, dts)` returns a complete `PgDisplaySet` (PCS with composition objects, their forced and crop flags, windows, palettes, objects) or null; honours composition states. Reuses `graphics/segments.ts` for PDS, ODS and fragment joining. |
| `graphics/graphics-controller.ts` (extended) | `_render_pg`, `_render_pg_composition_object`, `_reset_pg`, `GC_CTRL_PG_UPDATE`, `GC_CTRL_PG_RESET` | Renders a PG display set into the PG overlay: forced objects always, others when PSR2's display flag (bit 31) is set; crop; flush at the PCS PTS; then the deferred clear of the drawn areas. Overlay ops carry `plane: 'ig' \| 'pg'`. |
| `nav/subtitles.ts` | `_init_pg_stream`, `_find_pg_stream`, `_select_pg_textst_stream`, the PSR2 branch of `_process_psr_change_event` | `PgStreamControl`: resolves the PID from PSR2 and the current play item's STN (main path only), queues PG units, hands display sets to the controller when the clock reaches their PTS, resets on a PSR2 change and on seeks. Uses the navigator's `RegisterFile`, or a private one on discs without a navigator (BD-J, raw playlist picks), so PSR2 drives every disc the same way. |
| `subs/srt.ts` | original | `decodeText(bytes, fallback?)` returns text or `{ needsEncoding: true }`; `parseSrt(text)` returns cues `{ startUs, endUs, lines: StyledRun[][], align: 1–9 }`. Tolerates numbering gaps, `,` or `.` before milliseconds, CRLF, a missing final blank line. |
| `subs/text-renderer.ts` | original | `TextSubtitleRenderer` (the parent spec's `SubtitleRenderer`): `render(ctx, timeUs, videoRect)` draws the active cues with a black outline and soft shadow, font size relative to the video rectangle's height times the user scale; `changed(timeUs)` says whether the visible cue set differs from the last render. |
| `render/compositor.ts` | — | Draw order video → PG plane → text → IG plane, letterboxed. `drawPg(plane)` mirrors `drawIg`. |
| `playback/pipeline.ts` | — | A PG sink and `setPgStream(n)`, like IG. |
| `protocol.ts` | — | See §5. |
| UI | — | `SubtitleMenu`, drag and drop, encoding prompt, keys (§6). |

## 3. Runtime behaviour

### 3.1 PG presentation

PG PES units of the selected PID are queued and decoded by DTS (PTS when absent). A completed display set is passed to the controller (`PG_UPDATE`) when the master clock reaches its PCS PTS; the controller draws it into the PG `OverlayPlane`, and an empty composition clears it. The reader runs up to 2 s ahead, so the queue holds a few display sets; it is capped at 64 and drops the oldest when full.

### 3.2 Seeks and stream changes

- **Seek:** the queue and any half-received display set are dropped and PG is reset (`GC_CTRL_PG_RESET`, as `_seek_internal` does). The plane clears; subtitles resume at the next epoch start or acquisition point at or after the target.
- **Stream change** (a user pick, a VM `SET_STREAM`, or a play item whose STN differs): PSR2 changes → `_init_pg_stream` → reset and new PID. The pipeline restarts at the current time with the new PID, as audio switching does, so the current subtitle appears without waiting for the next epoch far ahead.

### 3.3 Selection and forced captions

One subtitle choice at a time:

- A PG stream: PSR2 = stream number with the display flag set (`_select_pg_textst_stream`), the text track is hidden.
- The text track: PSR2's display flag is cleared (the stream number stays, so forced captions of that stream still show), the text track is drawn.
- Off: display flag cleared, text track hidden.

With the display flag clear, `_render_pg` draws only composition objects with `forced_on_flag`. A user selection is checked against the `pgChange` and `pgEnableDisable` UO masks; a masked change is refused with the usual notice.

Initial PSR2 follows the existing language selection (`_update_stream_psr_by_lang`): the stream in the preferred subtitle language (PSR17) with the display flag on, or the first stream with it off when none matches (libbluray's default PSR17 matches none, so subtitles start off). A disc's program may change it with `SET_STREAM`.

### 3.4 Text subtitles

- `addTextSubtitle` sends the file bytes to the worker. Decoding tries a BOM, then strict UTF-8, then the encoding sent with the command; if none is given and UTF-8 fails, the engine emits `subtitleEncodingNeeded` and the UI asks, then sends the command again with the choice.
- The track belongs to the open disc and stays across playlist changes until replaced or removed; cue times are matched against playlist time plus the offset.
- Overlapping cues with the same alignment stack (bottom-aligned: later cues above earlier ones).
- Unknown tags render as text; malformed blocks are skipped and counted, with one notice when more than half of the blocks fail.
- The compositor redraws only when the visible cue set changes, a PG or IG plane changes, or the video frame changes.

## 4. Errors

| Situation | Behaviour |
|---|---|
| Corrupt PG segment or display set | Dropped; counted in `pgErrors`; the plane keeps its last good state |
| PG PID absent from the clip | No subtitles for that stream; no error |
| SRT not UTF-8 and no encoding given | `subtitleEncodingNeeded`; the UI asks |
| SRT with no readable cues | Notice "This file has no subtitles we can read"; no track |
| Masked PG selection | Refused with "The disc doesn't allow this here." |

## 5. Protocol

Commands:

- `selectSubtitle { choice: { kind: 'pg'; stream: number } | { kind: 'text' } | { kind: 'off' } }`
- `addTextSubtitle { name: string; bytes: ArrayBuffer; encoding?: string }`
- `removeTextSubtitle`
- `setSubtitleOffset { ms: number }`, `setSubtitleScale { scale: number }` (0.5–2.0)

Events:

- `subtitles { pg: PgTrack[]; text: { name: string; cues: number } | null; selected: 'off' | 'text' | { pg: number }; offsetMs: number; scale: number }`, emitted on playlist start, play item change, PSR2 change and every subtitle command.
- `subtitleEncodingNeeded { name: string }`

`PgTrack` is `{ index, language }`. Telemetry gains `pg: { objectsShown: number; forced: number } | null`, `pgErrors` and `textCue: boolean`.

## 6. UI

- **Subtitle menu** in the control bar (shown when there are PG tracks or a text track): the PG tracks by language, the loaded file's name, Off, and "Load subtitle file…". With a text track loaded, offset − / + (100 ms) with the current value, and size − / +.
- **Drag and drop:** dropping an `.srt` on the player loads it and selects it.
- **Encoding prompt:** a small dialog listing UTF-8, windows-1252, ISO-8859-2, Shift_JIS, EUC-KR, GBK, Big5 and windows-1251.
- **Keys:** `[` and `]` shift the text offset by 100 ms (with a short notice of the new value); `S` cycles subtitles (Off → each PG track → text → Off), checked against the UO mask like the other keys.

## 7. Testing

- **Unit tests (Node):** PCS and WDS decoding and display-set assembly with new `pcsSegment` and `wdsSegment` builders; `_render_pg` (forced versus display flag, crop, deferred clear); the PG queue (PTS gating, cap, seek reset, stream switch); PSR2 selection and UO checks; SRT decoding (BOM, UTF-8, fallback, needs-encoding) and parsing edge cases and tag runs; text layout (alignment, wrapping, stacking) against a fake 2D context.
- **libbluray traces:** the harness also applies `BD_OVERLAY_PG` operations to a second plane with the same semantics, and each `step` entry carries `pg` next to `plane`. A synthetic `disc-subs` (feature with two PG streams, one with forced objects) with scripts for subtitles on, a stream change by VM `SET_STREAM`, and off with forced captions only; goldens committed. A local HDMV_DISC_A or BDJ_DISC_B script compared live.
- **Chrome E2E (`tests/e2e/subtitles.spec.ts`):** a PG track drawn at its time (telemetry `pg.objectsShown`); Off still shows forced objects; an SRT loaded through the menu and by drag and drop shows its cue at the right time, and `]` shifts it; a windows-1252 file triggers the prompt and decodes; a masked PG change is refused.
- **Real-disc gate:** on each local disc, select every PG stream of the main feature, seek, and see objects drawn with 0 PG errors.

## 8. Exit criteria

1. CI is green, including the PG trace replay and the harness workflow.
2. The real-disc gate passes on BDJ_DISC_A, BDJ_DISC_B and HDMV_DISC_A.
3. `npm run vm-trace` matches libbluray for the local PG script.
4. `docs/known-issues.md` lists what is deferred: ASS (M4b), TextST, sub-path PG, per-disc subtitle memory; SRT is verified on synthetic data only.

## 9. Deviations (recorded during planning and implementation)

Decided while planning:

1. **PG rendering is its own class** (`graphics/pg-renderer.ts`), not part of `GraphicsController`, because PG also plays on discs without a navigator (BD-J, raw playlist picks), where no graphics controller exists. The ported functions are the same; the shared crop step lives in `graphics/composition.ts`. Overlay operations carry no `plane` field: each plane has its own renderer.
2. **The PG plane is double-buffered.** `OverlayPlane` has a buffered mode (operations change a back buffer, `flush` makes it visible), matching libbluray's overlay contract, where `_render_pg` flushes a subtitle and queues the clear of the same area for the next flush. IG stays immediate, so the M3 goldens did not change.
3. **The trace harness sets `BLURAY_PLAYER_SETTING_DECODE_PG`**, without which libbluray decodes no PG; the replay repeats its PSR2 write untraced.

Decided while implementing (each is a `Ruling` line in the execution ledger):

4. **Display sets are decoded as they arrive and presented at their PTS.** libbluray decodes PG with no DTS gate as it reads; the order of decoding is the same, so nothing visible changes.
5. **A seek resets PG fully** (`GC_CTRL_PG_RESET`, as `_seek_internal`), including the epoch.
6. **Play item changes come from the reader** (a pipeline `itemStarted` callback). The previous item's queued subtitles still show, and the plane resets when presentation reaches the new item; doing it at presentation time would drop the next item's first subtitles, because the reader runs up to 2 s ahead.
7. **A PSR2 change that keeps the PID** (display flag on or off) only resets the plane and keeps the queued display sets (libbluray's `_init_pg_stream` resets everything). The display flag is read when a set is rendered, so a forced caption read ahead before the user turned subtitles off still shows. Turning the display on, or a new PID, restarts the read at the current time so the current subtitle appears.
8. **A user's subtitle pick is refused whole** when any part of it is masked (libbluray's `_select_pg_textst_stream` applies the allowed half). The same holds for picking the text track while PG's display flag cannot be cleared.
9. **PG units outside the play item's IN/OUT time are dropped**, as libbluray's `m2ts_filter` does.
10. **Unknown SRT tags render as text** (§3.4); override blocks `{\…}` other than `{\anN}` are removed.
11. **The subtitle menu shows whenever a playlist plays**, not only when there are PG tracks or a text track, so "Load subtitle file…" is always reachable. Masked picks are disabled in it with the usual tooltip.
12. **`subtitles` is also emitted when a disc opens or closes**, so the UI learns that the text track was dropped with the disc.
13. **The real-disc gate expects a subtitle after a seek only where the disc has one starting within 25 s of the landing point.** `tests/helpers/pg-scan.ts` decodes every PG stream in Node to find them (and asserts no decode errors). Some real tracks are sparse (BDJ_DISC_A's second Spanish and French streams hold 16 and 18 subtitles in 124 minutes), so "drawn within 30 s of every seek" would fail on correct playback.
14. **Trace scripts gained `subs N`** (stream N with the display flag) next to `subs off`: a disc's own program usually leaves PG off (HDMV_DISC_A writes PSR2 = `0x0FFF0001`), so the HDMV_DISC_A script turns stream 1 on to compare non-empty planes.
