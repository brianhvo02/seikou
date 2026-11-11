# Video Shaders (mpv user shaders, Anime4K) — Design Spec

Date: 2026-10-15
Status: Implemented (2026-10-16); plan docs/superpowers/plans/2026-10-15-video-shaders.md. Real-disc gate passed 2026-10-16 on HDMV_DISC_A (Chrome on Apple M5 Max, Playwright, 1920×1080 and 3840×2160 viewports): Off, Anime4K Mode A (Fast) and (HQ) all within the A/V sync bounds (worst window 15.8 ms mean / 32.9 ms max) with no dropped frames or underruns; HQ at 4K ran 38 passes at about 22 ms GPU per frame; switching while playing, while paused, across a seek and after a reload all worked.
Parent spec: `2026-10-12-bluray-web-player-design.md` (§6 rendering). Independent of M5 (BD-J).

## 1. Goal and scope

A user can add a folder of mpv user shaders (Anime4K's `glsl/` folder in particular) once, have the player keep them across reloads, and pick a shader set from a "Shaders" menu next to Audio and Subtitles. The chosen set runs on the GPU over the video only; disc subtitles, SRT/ASS text and IG menus are drawn on top unshaded. The shader files are used exactly as they are distributed for mpv; we do not ask the user to convert them, and we do not invent our own format.

Why: anime Blu-rays are 1080p and most of the user's watching happens on displays larger than that. mpv users already rely on Anime4K and similar packs; this brings the same files into the player.

In scope:

- A runtime for the subset of mpv's user-shader format that every Anime4K v4.x file uses (§3), on WebGL2 in the engine worker.
- A local shader library (IndexedDB) of `.glsl` files keyed by file name.
- Shader sets from two sources: built-in Anime4K mode lists, and `glsl-shaders set` lines in an imported mpv `input.conf`.
- The Shaders menu, a key to cycle sets, a frame-drop warning, and telemetry.

Out of scope (non-goals):

- Hand-made sets (picking and ordering files in the UI). Deferred; the store format must not preclude it.
- Bundling Anime4K or any shader with the app. The user supplies the files. (Test fixtures may commit some; §8.)
- `//!COMPUTE`, `//!TEXTURE`, `//!PARAM`, `//!BUFFER`, `//!OFFSET`, and hook points other than those in §3.3. Files using them are rejected on add with a reason.
- Pixel-exact parity with mpv/libplacebo, and a libplacebo trace harness like vm-trace/ass-trace.
- Deinterlacing, HDR tone mapping, colour management beyond what the browser applies to a `VideoFrame` today. (The GPU stage makes a deinterlacer possible later; `docs/known-issues.md` lists the 1080i combing.)
- Per-disc shader memory. The choice is global.
- WebGPU, and compute-kernel rewrites for speed.

Anti-goals (would make this a failure even if it works):

- Shaders breaking A/V sync, stalling playback, or touching subtitles/menus.
- Silently applying half a set, or silently switching the user to a different set.

Decisions taken during brainstorming:

| Question | Decision |
|---|---|
| File format | mpv user shaders, unmodified (`.glsl` with `//!` directives) |
| Storage | Local to the browser, survives reloads; nothing uploaded anywhere |
| Where sets come from | Built-in Anime4K modes + `input.conf` import; no set editor in v1 |
| Too slow for the machine | Audio and sync win (frames drop as today); the UI warns with the drop rate; no automatic switching |
| Compile time | While a set compiles, video keeps playing with the previously active set (unshaded if none was active); menu shows "Compiling…" |
| GPU API | WebGL2 (GLSL bodies compile nearly verbatim; WebGPU would need a GLSL→WGSL translator in WASM) |

## 2. Components

| File | Responsibility |
|---|---|
| `src/engine/shaders/parse.ts` | Parses an mpv shader file into passes `{ desc, hooks[], binds[], save, width, height, when, components, body }`. Unknown or unsupported directives produce a `ShaderFileError` with the line and directive. Pure; also imported by the UI to validate files on add. |
| `src/engine/shaders/rpn.ts` | Evaluates `WIDTH`/`HEIGHT`/`WHEN` RPN: float literals, `+ - * / % > < = !`, `NAME.w/.width/.h/.height`. `=` is mpv's fuzzy compare. |
| `src/engine/shaders/plan.ts` | Given the passes of a set (in file order), the source size and the output rect size, returns the frame's pass plan: which passes run, each pass's input textures and output size and format, the named-texture table after each pass. Pure, so the semantics in §3 are unit-tested without a GPU. |
| `src/engine/shaders/codegen.ts` | Builds each pass's GLSL ES 3.00 source: `#version 300 es`, precision, one `uniform sampler2D` per BIND, the `NAME_*` macros and `HOOKED_*` aliases, global uniforms, the user body, and `main()` writing `hook()`. |
| `src/engine/shaders/runner.ts` | `ShaderRunner`: owns a WebGL2 context on its own `OffscreenCanvas`, compiles a set (asynchronously, `KHR_parallel_shader_compile`), uploads a `VideoFrame`, executes the plan with RGBA16F/RG16F/R16F framebuffers, runs the final scale to the output rect, and exposes the result as a drawable image. Reports compile errors with pass and file. |
| `src/engine/render/compositor.ts` (extended) | `drawVideo` draws the runner's output instead of the raw frame when a set is active and compiled; caches the output per `VideoFrame` so overlay-only repaints do not re-run the chain. `CompositorLike` gains an optional `setShaders(set \| null)`. The runner comes from an injectable factory (tests have no WebGL). |
| `src/engine/protocol.ts` | `setVideoShaders` command, shader status event, telemetry (§5). |
| `src/ui/shader-library.ts` | IndexedDB store of files `{ name, source, addedAt }` and imported sets `{ name, files[] , origin }`, plus the selected set. Same DB as `recent-discs.ts` (`bluray-web`), version bumped to 3 with new object stores. `IDBFactory` injectable, as in `recent-discs.ts`. |
| `src/ui/shader-sets.ts` | Built-in Anime4K mode lists (§4.2), `input.conf` parsing, availability (which files are missing). Pure. |
| `src/ui/ShaderMenu.tsx` | The menu (§6), modelled on `AudioMenu`/`SubtitleMenu`. |

`src/engine/shaders/` is original code that follows libplacebo's documented semantics (`src/shaders/custom_mpv.c`, `src/renderer.c`). If code is ported from libplacebo (LGPL-2.1-or-later) rather than written from its documentation, list the source files in `src/engine/NOTICE` as for libbluray. Anime4K (MIT, © 2019 bloc97) is credited in NOTICE for the mode lists, and its licence is committed next to any fixture copies.

## 3. Shader runtime semantics

Follow libplacebo (what mpv uses today) for everything below. The research behind these points is summarized in §9.

### 3.1 Directives

Supported in a HOOK block: `HOOK` (repeatable), `BIND` (repeatable), `SAVE`, `DESC`, `WIDTH`, `HEIGHT`, `WHEN`, `COMPONENTS`. Defaults: `SAVE` = the hooked texture; `WIDTH`/`HEIGHT` = `HOOKED.w`/`HOOKED.h`; `COMPONENTS` = the hooked texture's; no `WHEN` = always run. Anything else (`COMPUTE`, `OFFSET`, `TEXTURE`/`PARAM`/`BUFFER` blocks) rejects the file.

### 3.2 Textures and passes

- A named-texture table, reset every frame. `SAVE` replaces an entry by name (files in one set reuse names such as `conv2d_tf`; the latest save wins).
- A pass whose `WHEN` evaluates to 0, or that BINDs a name not in the table, is skipped silently.
- Sizes and `WHEN` are evaluated per pass against the current table, so after an x2 pass saves `MAIN`, later `MAIN.w` sees the doubled width. This is what makes Anime4K skip its second upscaler on a 2× display.
- Output size is `round(eval(WIDTH))` × `round(eval(HEIGHT))`. Output formats are 16-bit float: R16F, RG16F, RGBA16F for 1, 2, 4 components; 3 uses RGBA16F. Intermediate values are signed and unclamped (Anime4K depends on it). Requires `EXT_color_buffer_float`; without it, shaders are unavailable (§5).
- All bound textures are sampled LINEAR, CLAMP_TO_EDGE (Anime4K's depth-to-space and AutoDownscalePre rely on bilinear sampling, and edge taps on clamping).
- Passes run in set order (files in order, passes in file order) within each stage.

### 3.3 Stages and sizes

- `MAIN` (and `MAINPRESUB`, `NATIVE` as aliases at frame entry): the RGB frame at its visible size (`VideoFrame.visibleRect`, so 1920×1080, not the 1088-line coded size; anamorphic 1440×1080 stays 1440×1080 and the final scale stretches it, as mpv does). Spike-verified (Chrome, WebGL2 `texImage2D` of a `VideoFrame` with visibleRect 1440×1080, display 1920×1080): `textureSize` is 1440×1080, so `MAIN` is the visible size and no deviation is needed; the display aspect only enters the final-scale rect.
- `PREKERNEL`: fires once after all MAIN passes, on the current MAIN, always (even when no scaling follows). Anime4K's `Clamp_Highlights` depends on this.
- `OUTPUT` in expressions is the displayed video rectangle in device pixels: `fitRect(...)`'s width and height, not the canvas size. `NATIVE` / `NATIVE_CROPPED` in expressions is the frame's visible size.
- Hooks that cannot fire on an RGB frame (`LUMA`, `CHROMA`, `ALPHA`, `RGB`, `XYZ`, `CHROMA_SCALED`, `ALPHA_SCALED`, `LINEAR`, `SIGMOID`, `POSTKERNEL`, `SCALED`, `OUTPUT` as a hook) are accepted but never fire, as libplacebo allows. A file none of whose passes can fire is rejected on add ("this shader hooks only LUMA, which this player doesn't provide").
- Final scale: one bilinear pass from the current MAIN (after PREKERNEL) to the output rect. mpv uses Lanczos/hermite here; a better scaler is a later improvement, not v1.
- `PREKERNEL` runs in gamma light here (mpv runs it after linearization when upscaling). Accepted deviation.

### 3.4 Generated GLSL

For each bound `NAME` (and `HOOKED` aliasing the hooked stage's texture): `NAME_raw` (the sampler), `NAME_pos` (varying, this pass's texture coordinate mapped to NAME), `NAME_size`, `NAME_pt`, `NAME_mul` (1.0 for float textures), `NAME_rot` (identity), `NAME_off` (zero), `NAME_tex(pos)` = `NAME_mul * textureLod(NAME_raw, pos, 0.0)`, `NAME_texOff(off)` = `NAME_tex(NAME_pos + NAME_pt * off)`. Global uniforms: `frame` (incremented per pass execution), `random` (per pass), `input_size`, `target_size`, `tex_offset`. Follow libplacebo's `custom_mpv.c` definitions exactly where they differ from this summary.

Passes can bind up to 16 textures (Anime4K UL/GAN do). That is WebGL2's guaranteed minimum, so codegen must not reserve a sampler unit of its own in user passes.

### 3.5 Colour

The `VideoFrame` is uploaded with `texImage2D`; Chromium converts YUV→RGB with the frame's colour space, as `drawImage` does today. The result is drawn into the 2D compositor canvas, so the colours of an "Off" frame and a pass-through shader set must match. (Verified by a test: §8.)

## 4. Library and sets

### 4.1 Adding files

"Add shaders…" opens a folder picker (`showDirectoryPicker`, recursive) with a fallback multi-file input. Every `.glsl` file is parsed (§2 `parse.ts`); valid ones are stored by base file name (re-adding a name replaces it); invalid ones are listed in a dismissible report with their reason. Files larger than 4 MiB are rejected (Anime4K's largest is well under that). If an `input.conf` is among the files, it is imported (§4.3).

### 4.2 Built-in Anime4K modes

The player carries Anime4K v4's mode lists from `md/Template/GLSL_*/input.conf` in the Anime4K repository, pinned to commit `7684e9586f8dcc738af08a1cdceb024cc184f426` (2024-04-25) of `https://github.com/bloc97/Anime4K` (not tag `v4.0.1`: that tag has no `md/Template/` folder and lacks several files; file names are otherwise the same across v4.x): modes A, B, C, A+A, B+B, C+A, each in the HQ (high-end) and Fast (low-end) variant, as ordered lists of file names. Copy them from the templates; do not retype them. A built-in set appears in the menu once the library holds any file it names, and is usable when it holds all of them.

### 4.3 `input.conf` import

Each binding whose command contains `glsl-shaders set "<list>"` (or `change-list glsl-shaders set`) becomes a set. Its file list is the `:`-separated (`;` also accepted) paths reduced to base names (`~~/shaders/Anime4K_Clamp_Highlights.glsl` → `Anime4K_Clamp_Highlights.glsl`). Its name is the text of a `show-text "…"` in the same command, else the key name. `glsl-shaders clr` lines are ignored. An imported set whose file list equals a built-in one is not duplicated; one that only shares a built-in's name is stored as `<name> (imported)`, so set names stay unique. Importing again replaces sets of the same name.

### 4.4 Persistence

The library (files and imported sets) and the selected set name persist in IndexedDB. On start, the selected set is reapplied when a disc plays. Removing a file makes sets that need it unavailable; removing an imported set removes only the set.

## 5. Engine behaviour

- `setVideoShaders { set: { name, files: { name, source }[] } | null }`. The engine parses and compiles in the background while video keeps drawing with the previously active set (unshaded if none was active); on success it switches at the next frame; on failure it drops to unshaded and emits the error.
- Compiled sets are kept for the session (keyed by name and source hash), so switching back is immediate.
- Event `shaderStatus { state: 'off' | 'compiling' | 'active' | 'error' | 'unavailable', set, error? }`. `unavailable` when WebGL2 or `EXT_color_buffer_float` is missing; the menu then explains why and offers nothing.
- WebGL context loss: drop to unshaded, report `error`, and recompile on restore.
- The runner works per presented frame; overlay-only repaints reuse the last output. A resize changes `OUTPUT`, so the plan is recomputed (pure, cheap) and textures are reallocated as needed.
- Telemetry gains `shader: { set, passesRun, gpuMs | null } | null`. `gpuMs` comes from `EXT_disjoint_timer_query_webgl2` when present, else null.
- Frame drops: the presenter already drops late frames; nothing changes there. The UI computes the drop rate from `framesDropped`/`framesPresented` over a sliding 5 s window and warns above 5 % while a set is active (thresholds are my call; tune on the gate).

## 6. UI

- A "Shaders" button in the control bar beside Audio and Subtitles, with the same menu behaviour and keyboard handling as `AudioMenu`.
- Items: "Off", then available sets (built-in first, then imported, each group alphabetical within its origin's order), then unavailable sets greyed out with "missing: Anime4K_Upscale_CNN_x2_VL.glsl" (the first missing name, "+N more"). The active set is checked; a compiling set shows "Compiling…".
- "Add shaders…" and "Manage…" (a small dialog listing files and imported sets, each removable).
- When the drop-rate warning is on, the button shows a warning mark, and the menu shows "A (HQ): 18 % frames dropped — try a Fast mode."
- Key `v` cycles Off → each available set → Off. (mpv's Ctrl+1…6 is not used: Chromium reserves Ctrl/Cmd+digits for tab switching.)
- Compile and file errors show in the menu, naming the file and pass.

## 7. Error handling summary

| Case | Behaviour |
|---|---|
| Unsupported directive or hook-only-unavailable-stages file | Rejected on add, reason listed |
| GLSL compile/link error | Set shows error with file, pass DESC and the driver log's first line; stays unshaded |
| Set missing files | Greyed out, not selectable |
| No WebGL2 / no float render targets | Menu explains; feature off |
| Context loss | Unshaded, then recompile |
| Too slow | Frames drop as today; warning with rate |

## 8. Testing

- Unit (Vitest): `parse.ts` (every directive, defaults, rejections, line numbers); `rpn.ts`; `plan.ts` (SAVE replacement, skip on missing BIND, WHEN with sizes changing mid-chain, PREKERNEL always firing, the Anime4K Mode A plans at 1080p→1080p, 1080p→1440p and 1080p→2160p output with expected passes run and sizes); `codegen.ts` (generated preamble); `shader-sets.ts` (built-in availability, `input.conf` parsing against Anime4K's template files); `shader-library.ts` with an injected `IDBFactory`; compositor with a fake runner (shaded output drawn in the video rect, overlays after it, no re-run on overlay repaint); controller and reducer for the new command and event.
- Fixtures: `fixtures/shaders/` holds tiny hand-written shaders (pass-through, invert, nearest x2 with `SAVE MAIN` and `WIDTH MAIN.w 2 *`, a two-pass BIND/SAVE chain, a `WHEN` skip, a PREKERNEL pass) and a copy of the Anime4K v4 files used by Mode A HQ and Fast with Anime4K's MIT licence.
- E2E (Playwright, Chrome), split by what a GPU-less CI runner can do (my call):
  - In CI (`ubuntu-latest`, software WebGL): the small fixture shaders only, on a synthetic disc. If WebGL2 with `EXT_color_buffer_float` is unavailable there, these tests skip with a logged reason rather than fail; the first plan task is a spike to find out, and to try Chrome's SwiftShader flags if needed.
  - Local only, behind `SHADERS_GPU=1` (like `LOCAL_DISCS`/`NIGHTLY`): Anime4K Mode A compile and presentation, and the A/V sync suite with a set active.
  - What they cover: on a synthetic disc, pass-through matches "Off" pixels within a small tolerance (§3.5); invert inverts; subtitles stay unshaded under invert; Mode A (Fast) compiles and presents frames; A/V sync tests still pass with a pass-through set active. Library persistence across a reload.
- Real-machine gate (as for earlier milestones): play a real anime disc with Anime4K Mode A (HQ) and A (Fast) on the user's display, windowed and fullscreen; check the image, sync, drop rate and the warning; switch sets during playback and across a seek.

## 9. Research notes

From the brainstorming recon (2026-10-15):

- All 49 Anime4K v4 files hook `MAIN`, plus one `PREKERNEL` pass (`Clamp_Highlights`); none use COMPUTE, TEXTURE, PARAM, OFFSET, `texture()`, `texelFetch`, `textureGather` or derivatives. Three distinct `WHEN` expressions (upscale only when OUTPUT ≥ 1.2× MAIN; AutoDownscalePre ranges). Up to 16 binds and 84 passes per file.
- Prior art: Anime4K.js (MIT, maintained) converts the mpv files offline to WebGL1 with a macro preamble, which shows the preamble approach works on these files unchanged. Anime4K-WebGPU (MIT, unmaintained) hand-converts a subset to WGSL compute. No generic mpv-shader runtime for browsers exists.
- WebGL2 accepts a `VideoFrame` in `texImage2D` and works on `OffscreenCanvas` in workers in Chromium; R16F/RG16F/RGBA16F are filterable in core and renderable with `EXT_color_buffer_float`.

## 10. Left to the builder

Internal structure of the runner (texture pooling, how output is handed to the 2D context: drawing the GL canvas directly or `transferToImageBitmap`, `preserveDrawingBuffer`), the folder-picker vs file-input details, exact menu styling, and the telemetry window mechanics.

Settled during review (my calls): `recent-discs.ts` and `shader-library.ts` share one `openDb` so the version-3 upgrade happens in one place; the compiled-set cache lives for the page, not the per-playlist `Session`; changing the set while paused re-renders the current frame; a saved set that is unavailable on startup shows as an error in the menu instead of switching silently to Off.

## Deviations

- Anime4K is pinned to commit 7684e95 (not v4.0.1, which lacks `md/Template/` and several files).
- `NAME_texOff` uses libplacebo's `vec2(off)`, because GLSL ES 3.00 rejects vec2 times int.
- File pickers are hidden `<input type="file">` elements (`webkitdirectory` for folders), not `showDirectoryPicker`.
- Context loss and stale sets have their own error classes (`ShaderContextLostError` and a stale-set error).
