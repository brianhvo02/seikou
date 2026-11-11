# Milestone 5d: BD-J Menus on Every Device — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BD-J discs show their own menus, drawn as libbluray draws them, operable by keys, mouse and touch on desktop browsers, iPhone and iPad, through to the feature.

**Architecture:** The BD-J worker writes libbluray's `updateGraphicN` dirty rectangles into a shared ARGB plane that the engine's compositor draws over the video; background stills are drawn under it. Text comes from FreeType built to WebAssembly behind the ported `BDFontMetrics`/`BDGraphics` natives. Keys and pointer input reach Java as libbluray's `bd_user_input`/`bd_mouse_select` send them; the UI routes taps to the menu while the plane shows pixels and falls back to the on-screen remote when the disc doesn't react. A development disc server serves discs to devices, which the builder drives with Appium/XCUITest and Safari's remote inspector.

**Tech Stack:** TypeScript (strict), Web Workers, SharedArrayBuffer, WebAssembly (emsdk in Docker), FreeType, Node HTTP, Vitest, Playwright (Chromium/Firefox/WebKit/mobile), Xcode + iOS Simulator, Appium XCUITest, Docker (libbluray harness).

**Spec:** `docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md`. Also read the 5c spec §9, the cross-browser spec §3 (esp. §3.5, §3.9), `docs/known-issues.md` "BD-J (milestones 5b-5c)" and "Browsers and devices". libbluray at `448f896` is in `.cache/libbluray/src/libbluray/`.

**Git:** until the user accepts the Xcode licence, `/usr/bin/git` fails; use `/Library/Developer/CommandLineTools/usr/bin/git`.

## Global Constraints

- Port function by function from libbluray `448f896`; every ported/derived file listed in `src/engine/NOTICE`; LGPL SPDX on new `src/engine/` files; OpenJDK-derived code only in `src/bdj-classlib/` (GPLv2+CPE).
- `src/engine/` imports nothing from `src/ui/` or `src/player/`; new browser APIs behind injectable deps.
- Cross-origin isolation stays; no user-agent sniffing beyond the existing iPadOS check.
- Build artifacts (WASM, class library, goldens) change only through their scripts, with CI rebuild-and-diff.
- The BD-J graphics plane is 1920×1080 ARGB; only dirty rectangles are copied; the compositor shows it only after a flush.
- Taps go to the disc only while the BD-J plane shows non-transparent pixels; otherwise taps behave as today (`src/ui/touch.ts`).
- Ignored tap: no plane flush, control call or register write within the responsiveness window → on-screen remote opens and notice "This disc's menu doesn't respond to taps here. Use the remote."; once per menu (until the plane is next cleared).
- Responsiveness: key/tap → visible menu change ≤ 0.2 s on a computer, ≤ 0.5 s on iPhone (input to next presented frame containing the plane change).
- Start-up: iPhone BDJ_DISC_A open → first logo frame ≤ 10 s target, > 15 s is a blocker; desktop Chrome warm stays ≤ 5,000 ms.
- Navigation keys are not filtered by key interest (libbluray doesn't); transport controls unchanged.
- Development disc server: LAN only, per-run token, HTTP byte ranges; designed as the seed of the cross-browser spec's NAS server (§4 there).
- HDMV menus, subtitles, shaders, A/V sync, 5c control-call parity and existing tests keep passing unchanged.

## Review Focus

1. Rotating a phone or resizing the window while a BD-J menu shows: the plane stays aligned with the video rectangle and taps map to the right menu coordinates. (Task 6 and Task 8 tests.)
2. Picking a playlist, closing the disc or a BD-J failure while a menu is drawn: the plane is cleared at once; no stale menu over the next video. (Task 6 test.)
3. Holding an arrow key (key repeat): keys reach Java in order, without unbounded queueing, and responsiveness holds. (Task 8 test.)
4. The development disc server receiving a request without the token, outside the LAN, with a `..` path, or a range beyond EOF: refused or answered per HTTP semantics, never serving files outside the disc roots. (Task 1 test.)
5. A tap during the feature (plane empty) toggles the controls and never opens the remote or the ignored-tap notice. (Task 8 test.)

---

## File map

| Files | Status | Task |
|---|---|---|
| `tools/disc-server/*`, `src/engine/disc/http-source.ts`, UI open-by-URL | create / modify | 1 |
| `tools/devices/*` (Appium/inspector scripts, README), `src/probe/` additions | create / modify | 2 |
| `src/wasm/freetype/*` (Docker build, committed `.wasm`), `.github/workflows/wasm.yml`, `src/engine/bdj/fonts/freetype.ts` | create / modify | 4 |
| `src/engine/bdj/jvm/natives/fonts.ts` (ported from `java_awt_BDFontMetrics.c`, `java_awt_BDGraphics.c`), `natives/libbluray.ts` | create / modify | 5 |
| `tools/bdj-trace/*` (plane dumps, key scripts, font fallback) | modify | 3 |
| `src/engine/bdj/graphics-plane.ts`, `natives/libbluray.ts` (`updateGraphicN`), `src/engine/render/compositor.ts`, `src/engine/player.ts` | create / modify | 6 |
| `src/engine/bdj/background.ts`, compositor background layer, libjpeg (conditional) | create / modify | 7 |
| `src/engine/bdj/input.ts`, `player.ts`, `protocol.ts`, `src/ui/touch.ts`, `src/ui/PlayerScreen.tsx`, `RemotePad.tsx` | create / modify | 8 |
| `tests/bdj/xlets/src/bdjweb/menu/*`, `scripts/make-bdj-menu-disc.ts`, `fixtures/synthetic/disc-bdj-menu/**`, goldens | create | 9 |
| `tests/bdj/replay-player.ts`, `tests/local/bdj-menus.test.ts`, key scripts | modify / create | 10 |
| speed work as profiled | modify | 11 |
| `src/ui/capabilities.ts`, `tests/e2e/bdj-menu.spec.ts`, Playwright projects | modify / create | 12 |
| `src/engine/memory-profile.ts`, JVM/VFS caches | modify | 13 |
| `tools/devices/gate.ts`, spec status | create / modify | 14 |
| docs, `CLAUDE.md` | modify | 15 |

---

### Task 1: Development disc server and HTTP disc source

**Files:** Create `tools/disc-server/server.ts`, `tools/disc-server/README.md`, `src/engine/disc/http-source.ts`, tests `tools/disc-server/server.test.ts`, `src/engine/disc/http-source.test.ts`. Modify the UI open path (`src/ui/App.tsx` / disc input) for `?disc=<url>`; `package.json` (`"disc-server": "tsx tools/disc-server/server.ts"`).

**Interfaces:**
- Server CLI: `npm run disc-server -- --root <dir> [--root <dir>…] [--port 8443]` prints a URL with a fresh random token (`https://<lan-ip>:<port>/?token=…`) and a self-signed or mkcert certificate path (HTTPS so the player page stays a secure context on devices). Routes (all require `Authorization: Bearer <token>` or `?token=`): `GET /discs` → `[{ id, name }]`; `GET /discs/<id>/manifest` → `{ files: [{ path, size }] }` (paths as `normalizeDiscPaths` expects); `GET /discs/<id>/file/<path>` with `Range` → 206 partial content. Bind only to private LAN addresses and loopback; reject other source addresses with 403.
- `class HttpSource implements ByteSource { static open(baseUrl: string, token: string, signal?: AbortSignal): Promise<HttpSource>; paths(): string[]; … }` — reads ranges with `fetch` + `Range`, honours `AbortSignal`, maps HTTP failures to `DiscError('read-failed')`. Same `ByteSource` contract as `FileSource` (case-normalised paths, `exists`/`size`/`list`/`read`).
- Player/UI: a disc URL (`?disc=https://…/discs/<id>&token=…`) opens through `HttpSource` instead of a folder pick; the engine receives a `ByteSource` factory through deps (the worker builds `HttpSource`), so engine code stays UI-free.

- [ ] **Step 1: Failing tests:** server refuses without token (401), from a non-LAN address (403; inject the remote address in the test), and for `../` paths (400); `Range: bytes=0-9` → 206 with 10 bytes and correct `Content-Range`; a range starting beyond EOF → 416; files over 4 GiB served by range without loading into memory (test with a sparse file). `HttpSource` over a local test server reads the synthetic disc and `openDisc` succeeds; abort cancels an in-flight read.
- [ ] **Step 2: Run** `npx vitest run tools/disc-server src/engine/disc/http-source.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run typecheck`; open `fixtures/synthetic/disc1` via the server in local Chrome (`npm run build && npm run preview`, then the printed URL) and confirm playback.
- [ ] **Step 5: Commit** `feat(tools): development disc server and HTTP disc source`.

### Task 2: Device automation and the early USB checks

**Files:** Create `tools/devices/README.md` (one-time user setup: Xcode licence, Developer Mode, trust, Appium + XCUITest driver install, WebDriverAgent signing with a free Apple ID, 7-day re-sign), `tools/devices/run.ts` (open a URL in Safari on a named device or Simulator, wait for a condition, read `window.__blurayTelemetry`, take screenshots, send taps at page coordinates, collect console logs), `tools/devices/probe.ts`.

**Interfaces:** `npx tsx tools/devices/run.ts --device <udid|"sim:iPhone 17 Pro"> --url <url> [--until <js-expression>] [--tap x,y …] [--screenshot out.png] [--telemetry out.json]`.

- [ ] **Step 1:** Write the README and scripts; verify on the iOS Simulator (`xcrun simctl`) first: open `probe.html` and `fixtures/synthetic/disc1` via the disc server, read telemetry.
- [ ] **Step 2 (needs the user's one-time setup; ask through the controller when ready):** on the plugged-in iPhone and iPad, run `probe.html` over the disc server and record: sample rate, worker rAF, HEVC, Blob slicing over 4 GiB (server route).
- [ ] **Step 3 (USB route; the user picks the folder in Files):** with BDJ_DISC_A on a USB-C SSD, run `probe.html` on iPhone and iPad and record Blob slicing over 4 GiB from USB and HEVC decode. Record all results in `docs/known-issues.md` "Browsers and devices" (the empty probe table).
- [ ] **Step 4: Commit** `test(devices): Safari automation on iPhone, iPad and the Simulator; device probe results`.
- Decision point: if Blob slicing over 4 GiB fails over USB, or HEVC decode fails on iPhone/iPad, the controller records it and the gate (Task 14) uses the server route / BDJ_DISC_B there; report it, don't work around it here.

### Task 3: Harness plane dumps and key scripts

**Files:** Modify `tools/bdj-trace/` (`bdj_trace.c`, `trace.patch` if needed, `run.sh`, `README.md`): ARGB overlay dumps, `.keys` scripts, the font fallback mapping.

**Interfaces:**
- `run.sh <disc> --keys <file.keys> [--dump-planes <dir>]`: at every `BD_ARGB_OVERLAY_FLUSH` print a JSONL line `{"plane":"flush","n":<k>,"hash":"<fnv1a-32 hex of 1920×1080 ARGB>","t":<ms>}` and, with `--dump-planes`, write `<dir>/<k>.png`.
- `.keys` format as vm-trace's (`tests/vm-trace/scripts/*.keys`: `wait …` / key lines), extended with `wait flush <k>`, `wait playlist <n>`, `key <BD_VK name>`, `mouse <x> <y>`, `click <x> <y>`; the harness sends keys with `bd_user_input` and mouse with `bd_mouse_select` + `BD_VK_MOUSE_ACTIVATE`.
- Font fallback: the image installs `default-font.ttf` and configures libbluray's font resolution (fontconfig off; JRE font dir with symlinks for `serif`/`sansserif`/`monospaced`/`dialog`/`dialoginput` names → the bundled file) so both sides resolve missing fonts identically.

- [ ] **Step 1:** Implement; **Step 2:** run on `fixtures/local/BDJ_DISC_A` with a script reaching the main menu; confirm flush hashes and PNGs look right (compare a PNG with the 5b spike's frame visually). **Step 3:** README; commit `test(bdj): libbluray plane dumps and key scripts`.

### Task 4: FreeType in WebAssembly

**Files:** Create `src/wasm/freetype/build.sh`, `Dockerfile` (pinned emsdk as `src/wasm/audio/`), `shim.c` (exports: init, new face from memory, set char size, load+render glyph to 8-bit coverage, advances, kerning, metrics), committed `src/wasm/freetype/freetype.wasm` and its JS glue if any; `src/engine/bdj/fonts/freetype.ts`; test `freetype.test.ts`. Modify `package.json` (`"wasm:build"` runs both builds or add `"wasm:build:freetype"`), `.github/workflows/wasm.yml` (rebuild + diff both), `src/wasm/` licence notes (FreeType under the FreeType License; credit line in NOTICE).

**Interfaces:** `interface FreeType { newFace(bytes: Uint8Array): number; setSize(face: number, pixelSize: number): void; glyph(face: number, codepoint: number): { advance: number; bitmap: Uint8Array; width: number; rows: number; left: number; top: number }; metrics(face: number): { ascent: number; descent: number; height: number }; free(face: number): void }` and `loadFreeType(bytes: Uint8Array): Promise<FreeType>`.

- [ ] **Step 1:** Pin FreeType to the version libbluray's harness image uses (read it from `tools/bdj-trace/Dockerfile`'s apt package `libfreetype-dev` version) and the same build options affecting rendering (hinting, autohinter, LCD off) as Ubuntu's package, so glyphs match the harness.
- [ ] **Step 2: Failing test:** render "Ag" at 24 px with the bundled `src/engine/ass/default-font.ttf`; compare advances, metrics and coverage bitmaps with golden values produced by a tiny C program in the harness image linking the system FreeType (committed `tests/bdj/fonts/freetype-golden.json`, generated by a script in `tools/bdj-trace/`).
- [ ] **Step 3: Build** with `npm run wasm:build` (Docker). **Step 4: Run** → PASS; CI workflow diff passes locally. **Step 5: Commit** `build(wasm): FreeType for BD-J text`.

### Task 5: BD-J font and text natives

**Files:** Create `src/engine/bdj/jvm/natives/fonts.ts` (port of `bdj/native/java_awt_BDFontMetrics.c` and `drawStringN` from `java_awt_BDGraphics.c`); modify `natives/libbluray.ts` (remove the 5b stubs), BD-J runtime deps to receive `FreeType`; `src/engine/NOTICE`. Test `fonts.test.ts`.

**Interfaces:** natives `java/awt/BDFontMetrics.initN/destroyN/resolveFontN/getFontFamilyAndStyleN/loadFontN/destroyFontN/charWidthN/stringWidthN/charsWidthN/unloadFontConfigN` and `java/awt/BDGraphicsBase.drawStringN` with libbluray's semantics; font files from the VFS (disc `AUXDATA/*.otf` via the font index, the BDJO default font); a system-font name libbluray would resolve through the JRE or fontconfig maps to the bundled `default-font.ttf` (same mapping configured in the harness, Task 3).

- [ ] **Step 1: Failing tests:** `stringWidthN("PLAY")` and `drawStringN` into an `int[]` back buffer with a disc font and the fallback font equal the harness's values for the same font/size/colour (goldens from Task 3's harness and Task 4's FreeType helper); `resolveFontN` of an unknown family returns the fallback.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; conformance, bdj-trace and local parity tests unchanged. **Step 5: Commit** `feat(bdj): text rendering with FreeType`.

### Task 6: The BD-J graphics plane

**Files:** Create `src/engine/bdj/graphics-plane.ts`; modify `natives/libbluray.ts` (`updateGraphicN` ported from `_updateGraphic`), BD-J worker/session (share the plane), `src/engine/render/compositor.ts` (`drawBdj?(plane)` after `drawIg` slot), `src/engine/player.ts` (draw on flush; clear on stop/pick/close/failure), `src/engine/NOTICE`. Tests: `graphics-plane.test.ts`, compositor and player tests.

**Interfaces:**
- `createGraphicsPlane(): SharedArrayBuffer` (header: width, height, dirty x0/y0/x1/y1, flush counter, visible-pixels flag; then 1920×1080 Uint32 ARGB). `class GraphicsPlaneWriter { init(w, h): void; draw(argb: Int32Array, stride: number, x0, y0, x1, y1): void; flush(): void; close(): void }` (BD-J side, mirrors libbluray's ARGB overlay commands); `class GraphicsPlaneReader { flushCount(): number; visible(): boolean; copyDirtyInto(imageData: ImageData): Rect | null }` (engine side).
- `visible()` = any non-zero alpha in the last flushed plane (maintained incrementally from dirty rects), used by Task 8's tap rule.

- [ ] **Step 1: Failing tests:** `updateGraphicN` with a dirty rect writes exactly that rect (ported clipping from `_updateGraphic`); nothing is visible to the reader until `flush`; `visible()` turns false when the disc clears the plane; compositor draws the plane scaled to the video rectangle, over IG/PG/text, and re-maps on resize (Review Focus 1: canvas resize → plane still drawn in the new video rect); player clears the plane at once on picker playlist, close and BD-J failure (Review Focus 2).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; HDMV/compositor tests unchanged. **Step 5: Commit** `feat(bdj): BD-J menus drawn over the video`.

### Task 7: Background stills

**Files:** Create `src/engine/bdj/background.ts`; modify the JVM hook for `org/havi/ui/HStillImageBackgroundConfiguration.displayImage` (libbluray leaves it unimplemented: our host receives the image's source bytes/path and shows it), compositor (background layer under the video), protocol/telemetry as needed. Test `background.test.ts`.

- [ ] **Step 1:** Find in libbluray's Java (`org/havi/ui/HBackgroundImage.java`, `HStillImageBackgroundConfiguration.java`) where the image bytes/URL are available, and hook `displayImage` (an intrinsic or a native replacing the unimplemented body, in `src/engine/` — libbluray code is LGPL) to send the image bytes to the engine; the engine decodes with an injected decoder (`createImageBitmap` in production).
- [ ] **Step 2: Failing test:** a test xlet (or the Task 9 menu disc) calling `displayImage` makes the compositor draw that still under the video; it clears with the plane rules of Task 6.
- [ ] **Step 3:** Check whether BDJ_DISC_A or BDJ_DISC_B decode JPEGs into Java-visible images (AWT `Toolkit.createImage` of a JPEG drawn into the graphics plane): instrument a local run. If yes, build libjpeg (the JRE's version, from the harness image) into WASM through the Task 4 pipeline and back `sun/awt/image/JPEGImageDecoder`'s natives with it; if no, record that in the report and skip.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(bdj): background stills under the video`.

### Task 8: Keys, pointer, taps and the ignored-tap rule

**Files:** Create `src/engine/bdj/input.ts` (ports of `bd_user_input`'s BD-J branch incl. `_get_key_uo_index` and flag handling, and `bd_mouse_select`'s BD-J branch); modify `src/engine/player.ts` (route `menuKey`/`pointer` commands to BD-J while a BD-J title runs; reaction tracking), `src/engine/protocol.ts` (event `bdjMenu { visible: boolean }`, notice `bdj-tap-ignored`), `src/player/player-controller.ts` reducer, `src/ui/touch.ts` (`classifyTap` uses `menuActive || bdjMenuVisible`), `src/ui/PlayerScreen.tsx` (open `RemotePad` on `bdj-tap-ignored`), `src/engine/NOTICE`. Tests: `input.test.ts`, `player-bdj.test.ts`, `touch.test.ts`, reducer test.

**Interfaces:** `bdjKeyEvent(vk: number, flags?: number): number` (the param libbluray passes with `BDJ_EVENT_VK_KEY`); `bdjMouseParam(x: number, y: number): number` (`(x << 16) | y`); notice copy exactly: "This disc's menu doesn't respond to taps here. Use the remote."

- [ ] **Step 1: Failing tests:** arrows/Enter/digits/Top Menu/pop-up produce the VK_KEY params `bd_user_input` would (pressed|typed|released when no flags) and are not filtered by key interest; Top Menu and pop-up respect `_get_key_uo_index` UO checks; a click maps through `toMenuSpace` to `BDJ_EVENT_MOUSE` + `BD_VK_MOUSE_ACTIVATE`; held arrow key repeats are forwarded in order and the forwarding queue is bounded (drops nothing below a cap of e.g. 8 pending, coalesces beyond) (Review Focus 3); a tap with `bdjMenuVisible` → `menuClick`, without → toggle controls and no notice (Review Focus 5); a tap with no reaction within the window (0.2 s desktop / 0.5 s constrained profile, injectable clock) → `bdj-tap-ignored` once per menu and the remote opens; a reaction (flush, control call, register write) within the window → no notice; rotation/resize between taps maps to the new rectangle (Review Focus 1).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; HDMV menu and touch tests unchanged. **Step 5: Commit** `feat(bdj): keys, mouse and taps reach BD-J menus`.

### Task 9: Synthetic BD-J menu disc and golden

**Files:** Create xlet sources `tests/bdj/xlets/src/bdjweb/menu/*.java` (Java 1.3: an `HScene` with three `HTextButton`s using a disc font in `AUXDATA` and the fallback font, a PNG image, focus moves on arrows, Enter selects playlist 00000, a `MouseListener` on one button, a background still via `HStillImageBackgroundConfiguration`), `scripts/make-bdj-menu-disc.ts`, `fixtures/synthetic/disc-bdj-menu/**`, `tests/bdj/scripts/disc-bdj-menu.*.keys`, goldens `tests/bdj/golden/disc-bdj-menu.*.jsonl` (control calls + plane flush hashes). Modify `tools/bdj-classlib/pack.sh`, `package.json` `fixture:synthetic`, `tools/bdj-trace/golden.sh`, CI workflows.

- [ ] **Step 1:** Build the disc and goldens through the scripts (Docker). **Step 2: Failing test** `tests/bdj/bdj-menu.test.ts`: replay through the real Player with the same key script; control calls and plane hashes at every flush match the golden. **Step 3:** Fix any divergence in the port (never in the golden). **Step 4: Run** → PASS; CI workflows cover the new paths. **Step 5: Commit** `test(bdj): synthetic BD-J menu disc with plane goldens`.

### Task 10: Local discs, menu to feature

**Files:** Create `tests/bdj/scripts/bdj_disc_a.{play,chapters}.keys`, `tests/bdj/scripts/bdj_disc_b.play.keys`, `tests/local/bdj-menus.test.ts`; modify `tests/bdj/replay-player.ts` (plane hashes per flush, key scripts), `tests/bdj/run.ts` (`--keys`).

- [ ] **Step 1:** Write the scripts with the harness (Task 3) against the real discs: BDJ_DISC_A first menu → PLAY → feature playlist (and → CHAPTERS); BDJ_DISC_B language picker → English → main menu → PLAY → feature. Save libbluray's traces + plane hashes to the SDD workspace.
- [ ] **Step 2: Failing test:** our replay reaches the same feature playlists with matching control calls, and plane hashes match at each script's checked flushes. **Step 3:** Fix divergences in the port; where a frame legitimately differs (e.g. timing-dependent animation frames), restrict the check to stable flushes named in the script, and record why. **Step 4: Run** `npx vitest run tests/local/bdj-menus.test.ts` → PASS. **Step 5: Commit** `test(bdj): local BD-J discs from menu to feature`.

### Task 11: Responsiveness and the desktop start-up bar

- [ ] **Step 1:** Add telemetry `bdj.inputLatencyMs` (input to next presented frame with a plane change) and measure in Chrome on both discs (arrow moves, Enter) and BDJ_DISC_A warm start-up (5c's check).
- [ ] **Step 2:** If latency > 200 ms or start-up > 5,000 ms: profile (DevTools in the BD-J worker; `node --cpu-prof` on the replay) and add intrinsics/fast paths as in 5c (equivalence tests, OpenJDK-derived code only in `src/bdj-classlib/intrinsics/`). A JIT is not started; if it seems needed, report to the controller.
- [ ] **Step 3:** Tests: a local test asserts latency ≤ 200 ms in Chrome (LOCAL_DISCS). **Step 4: Commit** `perf(bdj): menu responsiveness`.

### Task 12: Safari, Firefox and mobile emulation

**Files:** Modify `src/ui/capabilities.ts` (BD-J feature: SharedArrayBuffer, Atomics, nested workers, WASM, OffscreenCanvas as used), create `tests/e2e/bdj-menu.spec.ts`, Playwright config projects as needed.

- [ ] **Step 1: Failing tests:** `bdj-menu.spec.ts` on the synthetic menu disc in Chromium, Firefox, WebKit and the mobile emulation project: menu draws (screenshot region check against the plane golden's first flush, decoded), arrows move focus, a tap on the mouse-listening button reacts, a tap on a non-listening area opens the remote and shows the notice; a capability report without nested workers (forced via test hook) shows a named message and the picker.
- [ ] **Step 2:** Make it pass; where WebKit/Firefox lack a needed API (e.g. nested workers), bring the alternative to the controller before changing architecture. **Step 3: Commit** `test(bdj): BD-J menus in Firefox, WebKit and mobile emulation`.

### Task 13: Memory under the constrained profile

**Files:** Modify `src/engine/memory-profile.ts` (`bdjClassCacheBytes`, `bdjVfsCacheBytes`, `bdjDecodedImageBytes` budgets), JVM caches (inflated class bytes dropped after define, ZIP entry caches bounded), VFS `/tmp` cache eviction for disc JAR copies, plane buffers reused.

- [ ] **Step 1: Failing tests:** under `constrained`, the JVM's retained class bytes and VFS cache stay under their budgets after booting BDJ_DISC_A in the Node replay (measure with the JVM's own accounting; LOCAL_DISCS), behaviour unchanged (control calls + plane hashes as Task 10).
- [ ] **Step 2: Implement** budgets (initial values from a desktop measurement; final values set in Task 14 from the iPhone/iPad measurement). **Step 3: Commit** `feat(bdj): memory budgets for phones and tablets`.

### Task 14: Device gate

**Files:** Create `tools/devices/gate.ts` (scripted gate per device: open disc via server URL, wait for first logo frame, record `bdj.firstFrameMs`, run the menu-to-feature key/tap script, record `inputLatencyMs`, stay 10 minutes in menus, detect page reloads = memory kills); modify the 5d spec's status line and `docs/known-issues.md`.

- [ ] **Step 1:** Simulator dry run of the full gate.
- [ ] **Step 2 (user setup ready; controller coordinates):** run on iPhone 17 Pro and iPad Pro over the server route, then the USB route (user picks the folder; script continues), for both discs (BDJ_DISC_A where HEVC decodes); Safari macOS, Firefox desktop (BDJ_DISC_B if no HEVC), Chrome.
- [ ] **Step 3:** Tune the constrained budgets (Task 13) from the measurements; if iPhone BDJ_DISC_A first frame > 10 s, profile and speed up (no JIT without the user); > 15 s blocks the milestone — report to the controller.
- [ ] **Step 4:** Record results in the 5d spec's status line and known-issues; commit `test(bdj): device gate`.

### Task 15: Docs and final verification

- [ ] Update `CLAUDE.md` (5d done; the plane, fonts/FreeType WASM, input, disc server, device tooling), `docs/known-issues.md`, the 5d spec's §9 deviations, the parent spec's BD-J row.
- [ ] Verify: `npm run typecheck && npm test`, `npm run build`, `npm run test:e2e`, `npm run wasm:build` + diff, `npm run bdj-classlib:build` + diff, `npm run bdj-trace:golden` + diff, `npm run vm-trace:golden` + diff, `LOCAL_DISCS=1 npx playwright test tests/e2e/local-discs.spec.ts`.
- [ ] Commit `docs(bdj): milestone 5d`.
