# HDR Video, Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HDR discs play in HDR by default: the element path carries the stream's colour and HDR metadata, `auto` sends HDR streams to it, the viewer can choose the video output, sees an HDR badge, gets HDR subtitles and menus where the browser can draw them, and a failure falls back with the spec's notice.

**Architecture:** Phase 1 (plan `2026-11-15-hdr-video-element.md`, all on branch `hdr-video`) built the remux, the page's `ElementVideoOutput`, sync, `?videopath=element` and the failure fallback. Phase 2 first moves the element-session code out of `player.ts`, then adds the SPS colour and aspect facts and the HDR SEI (`@seikou/bdmv`), the `colr`/`mdcv`/`clli`/`pasp` boxes, the automatic choice with shaders and the page's `decodingInfo` answer, then the UI (setting, badge, notice), HDR overlays, `video-caps.ts`, E2E and docs.

**Tech Stack:** TypeScript, Media Source Extensions, Vitest (jsdom for components), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-15-hdr-video-element-design.md` (approach A chosen 2026-11-16; §5.1, §5.2, §5.6–§5.9, §5.11).

## Global Constraints

- Change `packages/engine/src/protocol.ts` first for anything that crosses the worker boundary.
- New files: `SPDX-License-Identifier: LGPL-3.0-or-later`; the MP4 boxes and SEI readers are original code, nothing ported.
- No user-agent sniffing: every browser difference is a capability check (`isTypeSupported`, `decodingInfo`, `matchMedia`, a canvas context option that throws or is ignored).
- `VideoPath` stays `'auto' | 'element' | 'canvas'`. `auto`: element for HDR streams only; `element`: every stream the element can play; `canvas`: never. A shader set on forces the canvas path.
- An HDR stream: the clip's CLPI `dynamicRange` is 1 or 2 (`ProgramStream.dynamicRange`, on `main` already), else the first SPS's VUI `transfer_characteristics` is 16 (PQ) or 18 (HLG).
- Exact copy (spec §5.7): the setting **Video output** with options `Auto (HDR through the browser's video player)`, `Always the video player`, `Always the canvas`; the badge text `HDR`; the fallback notice for an HDR session: `HDR video couldn't play in this browser, so it shows without HDR and its colours may look flat`.
- HDR overlays (spec §5.6): graphics white at the BT.2408 reference, 203 nits, only while an HDR stream plays on the element path; otherwise the overlays stay as now.
- The canvas path's existing tests pass unchanged; an SDR disc with `auto` keeps the canvas path.
- Every export has a doc comment (no task, ruling or plan numbers in comments); `npm run devsite:model` after changes under `packages/*/src`; `public-api.txt` equals each barrel. No real disc titles anywhere.

## Review Focus

1. A Dolby Vision disc (HDR10 base layer, CLPI says 2 on the enhancement stream only): `auto` takes the element path and the badge says HDR (Task 5 test).
2. An HDR stream whose SEI carries no mastering metadata: `colr` is still written, `mdcv`/`clli` are left out, and the init segment is valid (Task 3 test).
3. Turning a shader set on and off during an element session: the playlist reopens at the same time on the other path, once, with no fallback notice (Task 5 test).
4. A viewer whose saved setting is `element` on a browser that refuses the codec: the canvas path plays with no notice; only a failure after starting shows the notice (Task 5 and Task 7 tests).
5. HDR overlays where the canvas has no extended-range mode: overlays draw exactly as before, no exception (Task 8 test).

---

### Task 1: Move the element session out of `player.ts`

**Files:** Create `packages/engine/src/element/element-session.ts` (+ `.test.ts` for anything moved that had no test); Modify `packages/engine/src/player.ts`.

**Interfaces:**
- Produces: `class ElementSession` holding what `player.ts` now keeps per element session (remuxer, reset generation, buffered and emitted ends, stall state, the codec query cache and its timeout), with the methods the player calls today under the same names. `player.ts` keeps the decision of when to start and stop it.

- [ ] **Step 1:** Run `npx vitest run packages/engine` and `npx playwright test tests/e2e/element-path.spec.ts --project=chromium`; record the counts.
- [ ] **Step 2:** Move the code with no behaviour change; `player.ts` should shrink by most of the element-path additions.
- [ ] **Step 3:** The same two commands, same counts; `npm run typecheck`.
- [ ] **Step 4: Commit** `refactor(engine): the element session lives in its own module`.

### Task 2: SPS colour and aspect, and the HDR SEI

**Files:** Modify `packages/bdmv/src/codecs/param-sets.ts`; Create `packages/bdmv/src/codecs/hdr-sei.ts`; Tests beside them.

**Interfaces:**
- Produces on `HevcSpsInfo` and `AvcSpsInfo`: `colour: { primaries: number; transfer: number; matrix: number; fullRange: boolean } | null` (null when the VUI has no `colour_description`) and `sar: { width: number; height: number }` (1:1 when absent; `aspect_ratio_idc` 1–16 from the table in H.264 Table E-1 / H.265 Table E-1, 255 explicit).
- Produces in `hdr-sei.ts`: `interface MasteringDisplay { primaries: [x: number, y: number][] /* G, B, R as coded, 0.00002 units */; whitePoint: [number, number]; maxLuminance: number /* 0.0001 cd/m² */; minLuminance: number }`, `interface ContentLight { maxCll: number; maxFall: number }`, and `readHdrSei(nals: readonly Uint8Array[]): { mastering: MasteringDisplay | null; light: ContentLight | null }` over HEVC prefix SEI NAL units (type 39), payload types 137 and 144, with emulation-prevention bytes removed.

- [ ] **Step 1: Failing tests.** `readHevcSps` of `fixtures/synthetic/disc-hdr`'s first SPS gives `colour: { primaries: 9, transfer: 16, matrix: 9, fullRange: false }` and `sar: { width: 1, height: 1 }`; disc1's H.264 SPS gives its colour (or null) and 1:1; a hand-built SPS with `aspect_ratio_idc` 255 and 4:3 gives `{ width: 4, height: 3 }`. `readHdrSei` over disc-hdr's first access unit gives the `master-display` and `max-cll` that `scripts/make-hdr-disc.ts` passed to x265 (read the values from the script); an access unit without those SEI gives nulls; a payload with an emulation-prevention byte inside it reads correctly.
- [ ] **Step 2:** `npx vitest run packages/bdmv/src/codecs` — FAIL.
- [ ] **Step 3:** Implement (the VUI follows the fields the readers already skip to; `sps_extension` and HRD parameters need no parsing past `colour_description`).
- [ ] **Step 4:** Same — PASS; `npm run typecheck`; `npm run devsite:model`.
- [ ] **Step 5: Commit** `feat(bdmv): SPS colour and aspect, and the HDR SEI`.

### Task 3: `colr`, `mdcv`, `clli` and `pasp`, and the display size

**Files:** Modify `packages/engine/src/element/fmp4.ts`, `packages/engine/src/element/remux.ts`, the session code from Task 1, `packages/engine/src/protocol.ts` (`videoInit`); Tests beside them.

**Interfaces:**
- Consumes: Task 2's `colour`, `sar`, `readHdrSei`.
- Produces: `VideoTrack` gains `colour`, `sar`, `mastering`, `light` (from the stream's first IRAP access unit); the sample entry writes `colr` (`nclx`) when `colour` is known, `pasp` always, and `mdcv`/`clli` when known. `videoInit`'s `width`/`height` become the display size (`width * sar.width / sar.height`), which the compositor's overlay placement already takes.

- [ ] **Step 1: Failing tests.** In `fmp4.test.ts`: an init segment for a track with colour 9/16/9 limited range contains a `colr` box `nclx 0009 0010 0009 00` inside the sample entry after the `hvcC`; with mastering metadata an `mdcv` box of 24 bytes of payload in ISO/IEC 23001-8 order (display primaries G, B, R; white point; max then min luminance) and a `clli` box of 4; without them neither box; `pasp` with the SAR. In `remux.test.ts`: disc-hdr's init carries all four; a 4:3-SAR stream reports a display width of `width * 4 / 3`.
- [ ] **Step 2:** `npx vitest run packages/engine/src/element` — FAIL.
- [ ] **Step 3:** Implement; the boxes go after `hvcC`/`avcC` in the sample entry.
- [ ] **Step 4:** Same — PASS; `npx playwright test tests/e2e/element-path.spec.ts --project=chromium` — PASS (the HDR test's segment is now tagged; Chrome must still play it).
- [ ] **Step 5: Commit** `feat(engine): the element path's init segment carries the stream's colour, HDR metadata and aspect`.

### Task 4: The page answers with `decodingInfo`, and knows the display

**Files:** Modify `packages/engine/src/protocol.ts` (`videoElementQuery` gains `hdr: { transfer: 'pq' | 'hlg'; mastering: boolean } | null`; `videoElementAnswer` gains `hdrDisplay: boolean`; a new command `displayHdr { hdr: boolean }`), `packages/engine/src/controller/element-output.ts` or a new `controller/element-caps.ts`, `PlayerController`; Tests beside them.

**Interfaces:**
- Produces: `elementPlayable(env, codec, hdr): Promise<boolean>` in `controller/element-caps.ts`: `isTypeSupported` (ManagedMediaSource or MediaSource) and, for HDR, `navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType, width, height, bitrate, framerate, transferFunction, colorGamut: 'rec2020', hdrMetadataType: mastering ? 'smpteSt2086' : undefined } })`'s `supported`; where `decodingInfo` is missing or throws, `isTypeSupported` decides. The controller tracks `matchMedia('(dynamic-range: high)')` and its `change` event, sends `displayHdr` on change, and answers with `hdrDisplay`. Answers stay cached per codec plus HDR facts for the page's life.

- [ ] **Step 1: Failing tests.** `elementPlayable` with a fake env: SDR asks only `isTypeSupported`; HDR PQ with mastering passes `transferFunction: 'pq'`, `colorGamut: 'rec2020'`, `hdrMetadataType: 'smpteSt2086'`; `decodingInfo` unsupported → false; `decodingInfo` throwing → the `isTypeSupported` answer. The controller posts `displayHdr` when the media query changes.
- [ ] **Step 2:** run them — FAIL. **Step 3:** implement. **Step 4:** PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(engine): the page answers the element question with the browser's HDR decoding support`.

### Task 5: The automatic choice and shaders

**Files:** Modify the session code from Task 1 and `packages/engine/src/player.ts` (`elementCoding`, `choosePath`, the shader command); `packages/engine/src/protocol.ts` (`Telemetry.videoHdr: boolean`, the snapshot's `videoHdr` through the reducer); Tests: `packages/engine/src/player.test.ts` (or the element session's test).

**Interfaces:**
- Consumes: Task 4's query and answer; CLPI `ProgramStream.dynamicRange` of the session's first clip's video streams (any HEVC stream with 1 or 2, as `dynamicRangeOf` reads); Task 2's SPS `colour.transfer`.
- Produces: `streamIsHdr(clips, sps)`; an event `videoHdr { hdr: boolean }` (true while an HDR stream plays on the element path), reduced into `snapshot.videoHdr`.

- [ ] **Step 1: Failing tests** (fake page answers):
  - `auto`: disc-hdr's playlist takes the element path; disc1 takes the canvas path and asks nothing; a playlist whose CLPI says 2 only on the enhancement-layer PID (0x1015) is HDR; an HEVC stream with no CLPI HDR but SPS transfer 16 is HDR.
  - `element`: disc1 takes the element path; `canvas`: disc-hdr takes the canvas path.
  - A page that answers false: canvas path, no notice.
  - A shader set turned on during an element session reopens the playlist at the same time on the canvas path, once, with no notice; turned off, it reopens on the element path; with a set on at the start, an HDR playlist takes the canvas path.
  - `videoHdr` is emitted true on an HDR element session and false when it ends or falls back.
- [ ] **Step 2:** FAIL. **Step 3:** implement; the shader reopen uses the same reopen the level switch uses. **Step 4:** PASS; `npx vitest run packages/engine`; `npm run typecheck`; `npm run devsite:model`.
- [ ] **Step 5: Commit** `feat(engine): HDR streams take the element path by default, and shaders take the canvas`.

### Task 6: The Video output setting and the HDR badge

**Files:** Create `src/ui/video-output.ts` (`VideoOutputSetting`: read and write `localStorage['bluray-web:video-output']`, try/catch, default `auto`; `?videopath=` overrides it for the page's life without saving), `src/ui/VideoOutputMenu.tsx`; Modify `src/ui/App.tsx` (send `setVideoPath` from the setting before the first open), `src/ui/PlayerScreen.tsx` / `ControlBar.tsx` (the menu; the badge beside `level-badge`); Tests: `src/ui/video-output.test.ts`, `src/ui/VideoOutputMenu.test.tsx` (jsdom).

**Interfaces:**
- Produces: `data-testid="video-output-menu"`, items `menuitemradio` with `data-path="auto|element|canvas"` and the spec's exact labels; the badge `<span class="level-badge" data-testid="hdr-badge">HDR</span>` shown when `snapshot.videoHdr` and the display is HDR (`matchMedia('(dynamic-range: high)')`, re-read on change).

- [ ] **Step 1: Failing tests:** the setting's default, save and read back, a storage that throws, the flag overriding without saving; the menu lists the three labels, marks the current one and calls `setVideoPath` on a pick; the badge shows only for `videoHdr` on an HDR display.
- [ ] **Step 2:** FAIL. **Step 3:** implement; a pick takes effect from the next playlist (the engine applies `setVideoPath` at the next session start; say so in the menu's hint line). **Step 4:** PASS; `npm test`; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(ui): the Video output setting and the HDR badge`.

### Task 7: The fallback notice for HDR, and a test flag

**Files:** Modify the element session / `player.ts` (`element-failed` notice text), `src/ui/App.tsx` (flag), `packages/engine/src/controller/element-output.ts`; Test: `tests/e2e/element-path.spec.ts`.

**Interfaces:**
- Produces: `?elementfail=1` (test-only, listed in CLAUDE.md's flags): every append fails with an error that is not `QuotaExceededError` (which the output retries), so the session fails at once. An HDR session's failure notice is the spec's exact copy; an SDR session's keeps today's text.

- [ ] **Step 1: Failing test** (E2E, Chrome): disc-hdr with `?elementfail=1&telemetry=1` plays, `videoPath` is `canvas`, `elementFailure` is set, and the notice shows the spec's text once; reopening the playlist doesn't show it again.
- [ ] **Step 2:** `npx playwright test tests/e2e/element-path.spec.ts --project=chromium -g fallback` — FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): an HDR session that fails says so in the spec's words`.

### Task 8: HDR overlays and the background still

**Files:** Modify `packages/engine/src/render/compositor.ts` and its factory (`PlayerDeps.createCompositor`), the BD-J plane draw path in the compositor; Tests: `packages/engine/src/render/compositor.test.ts`.

**Interfaces:**
- Produces: `Compositor.setHdrOverlays(on: boolean): boolean` (true when the canvas could switch): while an HDR element session plays the compositor recreates its 2D context in the browser's extended-range mode so that overlay white lands at 203 nits; where that throws or the context reports no HDR, it returns false and draws as now. The builder picks the mechanism (spec §5.6): first try a context with `colorSpace: 'rec2100-pq'` and `colorType: 'float16'` (Chrome maps sRGB white to the 203-nit reference when converting into PQ), and verify the white level by reading back a pixel; document what was measured in `docs/known-issues.md`.
- Background still: on the element path the BD-J background still is drawn while no element frame is showing (before the first `videoFrame` callback of the session and while paused before one), and cleared once one shows.

- [ ] **Step 1: Failing tests** (fake canvas): `setHdrOverlays(true)` asks the factory for the HDR context options and returns true; a factory that throws leaves the SDR context and returns false; overlays draw the same pixels either way in the fake; the background still is drawn in element mode until the first element frame, then not.
- [ ] **Step 2:** FAIL. **Step 3:** implement; the session calls `setHdrOverlays(true)` when an HDR element session starts and `false` when it ends.
- [ ] **Step 4:** PASS; `npx playwright test tests/e2e/element-path.spec.ts --project=chromium` and `tests/e2e/bdj-menu.spec.ts --project=chromium` — PASS.
- [ ] **Step 5: Commit** `feat(engine): subtitles and menus over HDR video at the graphics reference white`.

### Task 9: `video-caps.ts` asks MSE

**Files:** Modify `src/ui/video-caps.ts`; Test: `src/ui/video-caps.test.ts`.

**Interfaces:**
- Produces: `VideoCapsEnv.isTypeSupported?: (type: string) => boolean` (ManagedMediaSource or MediaSource); `hevc` and `hevc10` are true when WebCodecs or MSE plays HEVC Main / Main10 (`video/mp4; codecs="hvc1.1.6.L120.90"` / `"hvc1.2.4.L120.90"`). The level flags sent to the NAS keep their meaning.

- [ ] **Step 1: Failing tests:** WebCodecs says no and MSE yes → `hevc10: true`; both no → false; no MSE in the env → WebCodecs alone.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; `npx playwright test tests/e2e/nas.spec.ts --project=chromium` — PASS.
- [ ] **Step 5: Commit** `feat(ui): HEVC counts as playable when the browser's video player plays it`.

### Task 10: End-to-end, docs and the owner's check

**Files:** Modify `tests/e2e/element-path.spec.ts`, `docs/playing-discs.md`, `docs/troubleshooting.md`, `docs/known-issues.md`, `CLAUDE.md`.

- [ ] **Step 1: E2E:** without any flag, disc-hdr takes the element path where MSE plays HEVC Main10 (skip with a reason elsewhere) and disc1 the canvas path; the Video output menu switches disc1 to the element path from the next playlist; turning a shader set on during disc-hdr reopens on the canvas path (`SHADERS_GPU=1` only); the HDR badge appears only when `(dynamic-range: high)` matches (emulate it with `page.emulateMedia` if supported, else skip with a reason). Run in chromium and webkit.
- [ ] **Step 2: Docs:** `playing-discs.md` (HDR, the Video output setting, the badge); `troubleshooting.md` (HDR looks dim: the display or system HDR setting, Windows' SDR content brightness, Firefox has no HDR); `known-issues.md` (the background still rule, Dolby Vision plays its HDR10 base, HDR10+ metadata isn't passed on, HDR on the canvas path stays flat, HDR overlays where the browser has no HDR canvas); CLAUDE.md's element-path paragraph and flags (`?videopath=` now overrides the setting; `?elementfail=1`).
- [ ] **Step 3:** `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e` (locally; note any known flakes by name), `npx vitest run tests/documentation.test.ts` — PASS.
- [ ] **Step 4: Commit** `docs: HDR playback, the Video output setting and what remains`.

### Owner's check (after the final review)

Push `hdr-video`, `gh workflow run preview.yml --ref hdr-video`, and on the three setups, without any flag: an HDR disc shows the HDR badge and HDR highlights; subtitles and BD-J menus no longer look grey beside them (Chrome; Safari as measured); an SDR disc plays as before; Video output → Always the canvas takes effect on the next playlist.
