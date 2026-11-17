# Deinterlacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interlaced discs (1080i, 576i, 480i) play without combing: live footage at field rate, 3:2 film and anime (hard and soft pulldown) reassembled to 23.976 frames a second, chosen automatically as the content changes.

**Architecture:** Decoded frames of an interlaced stream go, as YUV planes with field flags, to a `Deinterlacer` in the engine worker (WebGL2). It keeps a ring of plane textures, measures each field on the GPU (read back asynchronously), and a pure-TypeScript cadence detector turns the measurements into output pictures (weave, field match, or motion-adaptive interpolation, each with its own timestamp). The presenter queues pictures instead of frames; the deinterlacer renders the selected one into a canvas the compositor draws (and the shader stage takes as input). CPU reference implementations of the metrics and of `bwdif` make the GPU work checkable.

**Tech Stack:** TypeScript (strict), WebGL2 (GLSL ES 3.00), WebCodecs, Vitest, Playwright, ffmpeg/libx264 for fixtures.

**Spec:** `docs/superpowers/specs/2026-11-17-deinterlacing-design.md`

## Global Constraints

- New original files: `// SPDX-License-Identifier: LGPL-3.0-or-later`. Files ported from FFmpeg's `vf_bwdif.c` / `bwdifdsp.c` keep `LGPL-2.1-or-later`, name FFmpeg as their upstream with its copyright lines in the first 15 lines, and are listed under FFmpeg's "Derived files" in `packages/engine/NOTICE`; `npm run licence-check` must pass.
- Never port, copy or follow line by line FFmpeg's `vf_fieldmatch.c` / `vf_decimate.c` (GPL) or VapourSynth's VIVTC; the field matcher and decimator are our own design.
- A stream is interlaced when its CLPI video `format` is 1 (480i), 2 (576i) or 4 (1080i); every other stream skips the stage.
- Output timing: video mode two pictures per frame, the second half a frame later; film mode 4 pictures per 5-frame cycle spaced exactly 1001/24000 s (41 708.3 µs), only for 29.97-frame sources (50 Hz sources are never film: 2:2 content weaves as progressive); progressive one picture per frame.
- Sync bounds unchanged: 20 ms mean, 50 ms max A/V offset (`SYNC_TOLERANCE_SCALE` as today).
- Ring: about 12 frames at desktop, 8 under the constrained memory profile; decode-ahead is gated on the ring's free slots.
- Device setting `bluray-web:deinterlace` (`auto` | `off`, default `auto`), applied at once; `off` draws woven frames as today.
- Changes crossing the worker boundary go into `packages/engine/src/protocol.ts` first.
- Fixtures are generated (testsrc2 and similar), never from the owner's discs; real titles never appear anywhere.
- No user-agent sniffing.

## Review Focus

1. A seek or play-item change in the middle of a 3:2 cycle: no wrong-field frame, no duplicate or dropped picture, the detector re-locks within a cycle or two (Task 4 test "re-locks after a cut mid-cycle"; Task 7 test "a seek restarts the detector").
2. Film with video-rate titles or credits over it (combing in only part of the frame): stays film where the background is film, never judders the whole picture (Task 4 test "film with combed overlay stays matched").
3. A paused frame in video mode and a held still at a play item's end: a clean full picture, not a single interpolated field that shimmers (Task 7 test "pause shows a woven-or-matched picture").
4. Bottom-field-first streams with no SEI: field order detected, not assumed wrong forever (Task 4 test "detects bottom field first").
5. Low-memory devices: the ring at 8 frames never starves the presenter into stutter at field rate (Task 7 test "constrained profile keeps 2 pictures queued").

---

### Task 1: Interlaced fixtures, and whether each browser decodes them

**Files:**
- Create: `scripts/make-interlaced-disc.ts`, `fixtures/synthetic/disc-interlaced/**` (generated, committed), `tests/e2e/interlaced-decode.spec.ts`
- Modify: `scripts/x264.ts` (frame rate and extra args), `package.json` (`fixture:synthetic` gains the script), `CLAUDE.md` (fixture list)

**Interfaces:**
- Produces: disc `fixtures/synthetic/disc-interlaced` with playlists `00000` (true interlaced 1920x1080i, 29.97, top field first, 4 s of moving `testsrc2` plus a horizontally scrolling bar, CLPI format 4), `00001` (the same but bottom field first), `00002` (hard 3:2 telecine: 24000/1001 `testsrc2` through ffmpeg `telecine=pattern=23`, encoded 1080i TFF), `00003` (soft pulldown: 24p frames encoded with x264 `--pulldown 32`, CLPI format 4, rate 29.97). H.264 picture timing SEI on every unit (`--pic-struct`).
- Produces: `encodeTestVideo(frames, size, extraArgs, rate = 24)` with `rate` as `'30000/1001'` etc.

- [ ] **Step 1: Write the browser check** `tests/e2e/interlaced-decode.spec.ts` "each interlaced playlist decodes every frame in this browser": open each playlist with `?telemetry=1&videopath=canvas`, play 3 s, `expect(t.decoderErrors).toBe(0)` and `framesPresented >= 80`. Mark per project (no skip).
- [ ] **Step 2: Run** `npx playwright test interlaced-decode --project=chromium` — FAIL (disc missing).
- [ ] **Step 3: Write `scripts/make-interlaced-disc.ts`** with `buildSyntheticDisc` (`videoFormat: 4`, `videoRate: 4` for 29.97; PTS per unit 3003 ticks) and x264 options through ffmpeg's `-x264-params`: `interlaced=1:tff=1:pic-struct=1` or `interlaced=1:bff=1:pic-struct=1` (`00000`/`00001`), `-vf telecine=pattern=23` then `interlaced=1:tff=1:pic-struct=1` (`00002`), `pulldown=32:pic-struct=1` (`00003`). Run `npx tsx scripts/make-interlaced-disc.ts fixtures/synthetic/disc-interlaced`; keep the disc under 12 MB (`-crf 30`).
- [ ] **Step 4: Run** the spec in `chromium`, `firefox`, `webkit` — Expected: PASS in Chrome and Firefox. Record WebKit's result. Then run the same playlists on Mac Safari and the owner's iPhone (`tools/devices/run.ts --target safari` / `ios:<udid>`, over HTTPS) and record decoder errors and frames presented.
- [ ] **Step 5: Ledger the Safari result.** If Safari decodes them: continue. If not: `Ruling:` interlaced H.264 in Safari waits for the in-browser decoder (spec "Open fact"); the Task 10 E2E skips WebKit for H.264 with that reason; continue.
- [ ] **Step 6: Commit** `test: interlaced H.264 fixtures (TFF, BFF, hard and soft 3:2) and a decode check per browser`.

### Task 2: H.264 picture structure from picture timing SEI

**Files:**
- Modify: `packages/bdmv/src/codecs/h264.ts`, `packages/bdmv/src/codecs/param-sets.ts`
- Test: `packages/bdmv/src/codecs/h264.test.ts`

**Interfaces:**
- Produces in `@seikou/bdmv/codecs/h264`:
  ```ts
  export interface AvcTiming { readonly picStructPresent: boolean; readonly cpbRemovalDelayBits: number; readonly dpbOutputDelayBits: number; readonly hrdPresent: boolean }
  export function avcTiming(sps: Uint8Array): AvcTiming;            // from the SPS VUI (nal/vcl HRD parameters)
  export function avcPicStruct(au: Uint8Array, timing: AvcTiming): number | null; // pic_struct 0-8 (Table D-1), null without SEI or flag
  ```
  `AccessUnitInfo` is unchanged (the decoder calls `avcPicStruct` itself).

- [ ] **Step 1: Failing tests** with units from `encodeTestVideo` with `-x264-params` `interlaced=1:tff=1:pic-struct=1` and `pulldown=32:pic-struct=1` (passed in `extraArgs`; the helper merges them into its own `-x264-params`): `avcTiming(sps).picStructPresent === true`; TFF interlaced units give `pic_struct` 3 (top then bottom) and BFF give 4; the pulldown stream's units give the repeating sequence `[5, 6, 3, 4]`-style values that x264 writes (assert `new Set(values)` equals what `ffprobe -show_frames` reports as repeat_pict/top_field_first for the same file; write the expected array into the test); a stream without `--pic-struct` gives `null`.
- [ ] **Step 2: Run** `npx vitest run packages/bdmv/src/codecs/h264.test.ts` — FAIL.
- [ ] **Step 3: Implement** VUI parsing to the HRD lengths (H.264 E.1.1), SEI payload walking (already in `seiHasRecoveryPoint`, generalise it), and pic_timing's leading `cpb_removal_delay`/`dpb_output_delay` skip.
- [ ] **Step 4: Run** — PASS. Commit `feat(bdmv): H.264 pic_struct from picture timing SEI`.

### Task 3: Interlaced pictures as planes with field flags

**Files:**
- Create: `packages/engine/src/deinterlace/field-input.ts`, `packages/engine/src/deinterlace/field-input.test.ts`
- Modify: `packages/engine/src/decode/video-decoder.ts` (`WebCodecsVideoDecoder`: an `onFieldInput` sink for interlaced streams)

**Interfaces:**
- Produces:
  ```ts
  export type PlaneFormat = 'I420' | 'NV12';
  export interface YuvPlanes { readonly format: PlaneFormat; readonly width: number; readonly height: number; readonly data: Uint8Array; readonly layout: readonly PlaneLayout[] /* VideoFrame.copyTo's */ ; readonly matrix: 'bt709' | 'smpte170m' | 'bt470bg' }
  export interface FieldFlags { readonly fieldOrder: 'tff' | 'bff' | null; readonly progressive: boolean | null; readonly repeatFirstField: boolean }
  export interface FieldInput { readonly planes: YuvPlanes; readonly timestampUs: number; readonly durationUs: number; readonly flags: FieldFlags }
  export function flagsFromPicStruct(picStruct: number | null): FieldFlags; // Table D-1: 0 progressive, 1/2 single field, 3 tff, 4 bff, 5 tff+repeat, 6 bff+repeat, 7/8 frame doubling/tripling
  export async function framePlanes(frame: VideoFrame): Promise<YuvPlanes>; // copyTo into a reused buffer; I420 or NV12 as the frame is
  ```
  The decoder keeps a `Map<timestampUs, FieldFlags>` filled at `decode()` from each unit's `avcPicStruct`, and on output for an interlaced stream calls `onFieldInput({ planes: await framePlanes(frame), timestampUs, durationUs, flags })` then closes the frame. Progressive streams keep `onOutput` unchanged.

- [ ] **Step 1: Failing tests:** `flagsFromPicStruct` for 0, 3, 4, 5, 6, null (`{ fieldOrder: null, progressive: null, repeatFirstField: false }`); the decoder with a fake `VideoDecoder` that outputs frames out of decode order still pairs each output with its own unit's flags (by timestamp); a frame's planes are copied with `format` and `layout` from `copyTo` and the frame is closed.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/deinterlace/field-input.test.ts packages/engine/src/decode` — FAIL.
- [ ] **Step 3: Implement.** `matrix` from the SPS VUI's `matrix_coefficients` when present, else by height (≤576 lines `smpte170m`/`bt470bg` by 480/576, else `bt709`).
- [ ] **Step 4: Run** — PASS. Commit `feat(engine): interlaced frames reach the deinterlacer as planes with field flags`.

### Task 4: The cadence detector

**Files:**
- Create: `packages/engine/src/deinterlace/cadence.ts`, `packages/engine/src/deinterlace/cadence.test.ts`, `packages/engine/src/deinterlace/metric-sequences.ts` (test helpers building metric sequences)

**Interfaces:**
- Consumes: `FieldFlags` (Task 3).
- Produces:
  ```ts
  /** One frame's measurements (from the GPU, or the CPU reference). Higher comb = more combing. */
  export interface FrameMetrics {
    readonly combWoven: number;      // the frame as coded
    readonly combMatchPrev: number;  // its first field with the previous frame's second field
    readonly combMatchNext: number;  // its second field with the next frame's first field
    readonly diffPrev: number;       // mean abs difference of this frame from the previous (for decimation)
    readonly motionTff: number;      // field-order evidence: motion consistency if top first …
    readonly motionBff: number;      // … and if bottom first
  }
  export type PictureOp = { readonly kind: 'weave' } | { readonly kind: 'match'; readonly with: 'prev' | 'next' } | { readonly kind: 'interpolate'; readonly field: 'top' | 'bottom' };
  export interface PlannedPicture { readonly frame: number /* ring sequence number */; readonly op: PictureOp; readonly timestampUs: number }
  export type CadenceMode = 'progressive' | 'film' | 'video';
  export class CadenceDetector {
    constructor(opts: { readonly frameDurationUs: number; readonly lookahead: number });
    push(seq: number, timestampUs: number, flags: FieldFlags, metrics: FrameMetrics): readonly PlannedPicture[]; // pictures now decided, in order
    flush(): readonly PlannedPicture[];   // end of stream: decide what's left
    reset(): void;                        // seek / play item change
    readonly mode: CadenceMode;
    readonly fieldOrder: 'tff' | 'bff';
    readonly fieldOrderSource: 'stream' | 'detected' | 'assumed';
    readonly locks: number; readonly breaks: number;
  }
  ```
  Constants (exported): `LOCK_CYCLES = 3` (consistent 3:2 cycles to lock), `UNLOCK_FRAMES = 4` (frames of unmatched combing to leave film), `LOOKAHEAD = 5`.

- [ ] **Step 1: Failing tests** (sequences from `metric-sequences.ts`):
  - "clean video": every frame combed whatever the match → 2 pictures per frame, `interpolate` top then bottom (TFF), timestamps t and t + frameDuration/2, `mode === 'video'`.
  - "clean hard 3:2": the woven/match pattern of telecine → after `LOCK_CYCLES` cycles exactly 4 pictures per 5 frames, all `weave` or `match`, timestamps spaced 1001/24000 s, `mode === 'film'`.
  - "soft pulldown": progressive frames with `repeatFirstField` on alternate frames and uneven timestamps → one `weave` per frame, timestamps evened to 1001/24000 s.
  - "progressive": no combing anywhere → one `weave` per frame at its own timestamp.
  - "re-locks after a cut mid-cycle": a 3:2 run, a cut 2 frames into a cycle, 3:2 again in a new phase → no picture repeats or skips a source field; locked again within 2 cycles; `breaks === 1`.
  - "film with combed overlay stays matched": 3:2 metrics with combMatch raised moderately (titles) but still lowest for the right match → stays `film`.
  - "leaves film when video starts": 3:2 then true video → `video` within `UNLOCK_FRAMES` frames, no picture lost.
  - "detects bottom field first": flags `fieldOrder: null`, motionBff consistently lower → `fieldOrder === 'bff'`, `fieldOrderSource === 'detected'`, interpolation order bottom then top.
  - "stream field order wins": flags say `tff` → `fieldOrderSource === 'stream'`.
  - "reset clears the cadence": after `reset()`, the next frames are planned as video until locked again.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/deinterlace/cadence.test.ts` — FAIL.
- [ ] **Step 3: Implement** our own detector (no reference to fieldmatch/decimate/VIVTC code): per frame choose the cleanest of woven/matchPrev/matchNext; in film mode drop, per 5-frame cycle, the matched frame with the lowest `diffPrev`; lock and unlock with the constants; retime film pictures to a 1001/24000 s grid anchored at the cycle's first kept frame.
- [ ] **Step 4: Run** — PASS. Commit `feat(engine): cadence detector for field-rate video and 3:2 film`.

### Task 5: CPU references: metrics and bwdif

**Files:**
- Create: `packages/engine/src/deinterlace/metrics-cpu.ts`, `packages/engine/src/deinterlace/bwdif-cpu.ts` (LGPL-2.1-or-later, ported from FFmpeg `libavfilter/bwdifdsp.c`/`vf_bwdif.c`), tests beside them; `packages/engine/NOTICE` (derived file listed)
- Test fixtures: `fixtures/synthetic/deinterlace-ref/` (generated by `scripts/make-interlaced-disc.ts` too: raw luma of 6 frames of `00000` and ffmpeg `bwdif=mode=send_field:parity=tff` output luma for them, and the untelecined source luma of `00002`'s first 2 cycles)

**Interfaces:**
- Produces:
  ```ts
  export function frameMetrics(prev: Plane | null, cur: Plane, next: Plane | null, fieldOrder: 'tff' | 'bff'): FrameMetrics; // luma only
  export interface Plane { readonly width: number; readonly height: number; readonly stride: number; readonly data: Uint8Array }
  export function bwdifField(prev: Plane, cur: Plane, next: Plane, parity: 0 | 1, tff: boolean): Plane; // one output frame for field `parity` of `cur`
  ```

- [ ] **Step 1: Failing tests:** `bwdifField` on the reference luma equals ffmpeg's output byte for byte (both parities, 4 frames); `frameMetrics` on the telecine reference gives, over 10 frames, the 3:2 pattern (`combMatch*` lowest for the right match) that feeds Task 4's "clean hard 3:2" to the same decisions (run the detector on these metrics in the test).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (bwdif ported function by function, comments naming the upstream function). **Step 4: Run** — PASS; `npm run licence-check` — PASS. Commit `feat(engine): CPU reference of the field metrics and bwdif`.

### Task 6: The GPU deinterlacer

**Files:**
- Create: `packages/engine/src/deinterlace/deinterlacer.ts`, `packages/engine/src/deinterlace/gl-shaders.ts` (bwdif GLSL is LGPL-2.1-or-later, ported, listed in NOTICE), `packages/engine/src/deinterlace/deinterlacer.test.ts` (logic with a fake GL backend)
- Modify: `packages/engine/src/shaders/stage.ts` (`process(source: VideoFrame | OffscreenCanvas, …)`)

**Interfaces:**
- Consumes: `FieldInput` (Task 3), `CadenceDetector` (Task 4).
- Produces:
  ```ts
  export interface DeinterlaceBackend { /* WebGL2 seam, faked in tests */ upload(slot: number, planes: YuvPlanes): void; measure(prev: number | null, cur: number, next: number | null, fieldOrder: 'tff' | 'bff'): Promise<FrameMetrics>; render(op: PictureOp, slots: { prev: number | null; cur: number; next: number | null }, fieldOrder: 'tff' | 'bff', matrix: YuvPlanes['matrix']): OffscreenCanvas; readonly gpuMs: number | null; dispose(): void }
  export function createGlDeinterlaceBackend(width: number, height: number, ringSize: number): DeinterlaceBackend | null; // null without WebGL2
  export interface Picture { readonly timestamp: number; readonly duration: number; close(): void } // what the presenter queues (PresentableFrame)
  export class Deinterlacer {
    constructor(deps: { backend: DeinterlaceBackend; ringSize: number; frameDurationUs: number; onPictures(p: readonly Picture[]): void });
    push(input: FieldInput): void;               // upload, measure, plan; pictures come out through onPictures
    render(p: Picture): OffscreenCanvas;          // draws the picture's op
    freeSlots(): number;                          // decode-ahead gate
    reset(): void; flush(): void; dispose(): void;
    readonly stats: DeinterlaceStats;
  }
  export interface DeinterlaceStats { readonly mode: CadenceMode; readonly fieldOrder: 'tff' | 'bff'; readonly fieldOrderSource: 'stream' | 'detected' | 'assumed'; readonly locks: number; readonly breaks: number; readonly ringSize: number; readonly gpuMs: number | null; readonly fallback: boolean }
  ```
  A ring slot is free once no queued picture, lookahead or neighbour refers to it; `Picture.close()` releases its references.

- [ ] **Step 1: Failing tests** (fake backend that records calls and returns scripted metrics): pictures come out in timestamp order; slots are reused only after every picture referring to them is closed; `freeSlots()` drops as frames arrive and recovers as pictures close; `reset()` closes queued state and frees every slot; `render` passes the picture's op and its neighbours' slots.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/deinterlace/deinterlacer.test.ts` — FAIL.
- [ ] **Step 3: Implement** `Deinterlacer`, then `createGlDeinterlaceBackend`: Y as R8 and chroma as R8 (I420) or RG8 (NV12) textures per slot; metric passes reduce to a 1x1 texture per measure (mip or ping-pong) read through a PIXEL_PACK buffer and `fenceSync`/`clientWaitSync(0)` polling; render passes per op to an RGBA canvas, converting YUV→RGB with `matrix` in the last pass.
- [ ] **Step 4: Run** — PASS. Commit `feat(engine): WebGL2 deinterlacer with a plane ring, GPU metrics and bwdif`.

### Task 7: The player plays interlaced sessions through it

**Files:**
- Modify: `packages/engine/src/player.ts` (session setup, `wireDecoder`, `feedDecoder` gate, `paint`, seek/item reset), `packages/engine/src/render/compositor.ts` (`drawVideo(frame: VideoFrame | DrawnPicture | null)` where `DrawnPicture = { image: OffscreenCanvas; displayWidth: number; displayHeight: number }`), `packages/engine/src/memory-profile.ts` (`deinterlaceRing: number`: desktop 12, constrained 8)
- Test: `packages/engine/src/player.test.ts`, `packages/engine/src/render/compositor.test.ts`

**Interfaces:**
- Consumes: Tasks 3-6.
- Produces: `Player` routes an interlaced session (`isInterlacedFormat(format: number): boolean` in `deinterlace/field-input.ts`: 1, 2, 4) through the deinterlacer when the setting is `auto` and a backend exists; the presenter becomes `VideoPresenter<VideoFrame | Picture>`.

- [ ] **Step 1: Failing tests** (player harness with a fake decoder that emits interlaced frames and a fake deinterlace backend):
  - "an interlaced playlist's frames go to the deinterlacer, a progressive one's to the presenter";
  - "decode-ahead waits for free ring slots" (`feedDecoder` stops at `freeSlots() === 0`);
  - "a seek restarts the detector" (`reset` called, no picture from before the seek is presented);
  - "pause shows a woven-or-matched picture" (paused in video mode, the painted op is `weave` or `match`, never `interpolate`);
  - "constrained profile keeps 2 pictures queued" (ring 8, video mode, the presenter's queue never drops below 2 while playing);
  - "setting off draws woven frames" (no deinterlacer for the session);
  - "no WebGL2: woven frames and telemetry says why".
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/player.test.ts -t "interlaced|deinterlac|ring"` — FAIL.
- [ ] **Step 3: Implement.** The shader stage takes the drawn picture's canvas as input when a set is on.
- [ ] **Step 4: Run** — PASS; full `npx vitest run packages/engine` — PASS. Commit `feat(engine): interlaced sessions play through the deinterlacer`.

### Task 8: Setting, telemetry and docs

**Files:**
- Modify: `packages/engine/src/protocol.ts` (`{ type: 'setDeinterlace'; mode: 'auto' | 'off' }`, `Telemetry.deinterlace: DeinterlaceStats | null`), `packages/engine/src/controller/player-controller.ts` (`setDeinterlace`, example in `examples/player-controller.browser.ts`), `src/ui/video-output.ts` (`deinterlaceSetting()`, key `bluray-web:deinterlace`), `src/ui/VideoOutputMenu.tsx` (a "Deinterlacing" group: Auto, Off; `data-testid="deinterlace-auto"`/`"deinterlace-off"`), `src/ui/App.tsx` (send at load), `docs/playing-discs.md`, `docs/known-issues.md`, `docs/roadmap.md` (item done; the WASM decoder next), `CLAUDE.md`, `packages/engine/public-api.txt` if exported
- Test: `src/ui/VideoOutputMenu.test.tsx`, `src/ui/video-output.test.ts`

- [ ] **Step 1: Failing tests:** the menu lists Deinterlacing Auto (checked by default) and Off; picking Off saves `off` and calls `controller.setDeinterlace('off')`; the setting reads back after reload; storage that throws reads as `auto`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (protocol first). **Step 4: Run** `npm run devsite:model && npm run typecheck && npm test` — PASS. Commit `feat(ui): Deinterlacing Auto / Off in the Video output menu`.

### Task 9: Fall-back on frame pacing

**Files:**
- Modify: `packages/engine/src/deinterlace/deinterlacer.ts`, `packages/engine/src/player.ts` (report late/dropped pictures to it)
- Test: `packages/engine/src/deinterlace/deinterlacer.test.ts`

**Interfaces:**
- Produces: `Deinterlacer.notePacing(late: boolean): void`; constants `PACING_WINDOW = 120` pictures, `PACING_LATE_SHARE = 0.1`. Past the share in a window, `stats.fallback` becomes true and `interpolate` renders with plain field interpolation (`PictureOp` unchanged; the backend's render takes `cheap: boolean`). Never switches back during the session.

- [ ] **Step 1: Failing test** "falls back after a window of late pictures, and only then": 119 on-time + 12 late → `fallback` true, render called with `cheap: true` after; 120 with 11 late → false.
- [ ] **Step 2-4:** run, implement, run. Commit `feat(engine): the deinterlacer falls back to field interpolation when pictures run late`.

### Task 10: End-to-end checks

**Files:**
- Create: `tests/e2e/deinterlace.spec.ts`, `fixtures/synthetic/deinterlace-ref/*.png` (generated by the fixture script: expected pictures at chosen times, from ffmpeg `bwdif` for `00000` and the untelecined source for `00002`)

- [ ] **Step 1: Write the spec:** for `00000`: telemetry `deinterlace.mode === 'video'`, A/V sync within bounds (`collectWindows`/`expectInSync` as the canvas tests do), a paused screenshot at 2.0 s against the bwdif reference PNG with PSNR ≥ 30 dB; `00001`: `fieldOrder === 'bff'`; `00002` and `00003`: `mode === 'film'`, presented pictures ≈ 24 per second over 3 s (`framesPresented` delta 70-74), paused screenshot against the source frame PSNR ≥ 35 dB; Off: `deinterlace === null` and combing present (the screenshot differs from the reference by more than 3 dB worse); projects chromium, firefox, webkit (WebKit per the Task 1 ruling).
- [ ] **Step 2: Run** `npm run build && npx playwright test deinterlace --project=chromium --project=firefox --project=webkit` — fix until PASS.
- [ ] **Step 3: Device check** (owner's iPhone over HTTPS, `tools/devices/run.ts`): a real 1080i disc plays in each mode, `deinterlace.fallback` false, no stutter; record in the spec's status line.
- [ ] **Step 4: Commit** `test(e2e): deinterlacing modes, sync, pictures and the Off switch`.
