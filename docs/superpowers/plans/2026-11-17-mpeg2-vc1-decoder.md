# MPEG-2 and VC-1 Decoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MPEG-1, MPEG-2 and VC-1 video plays with a picture in every supported browser through FFmpeg's decoders in WASM on a worker of their own, interlaced pictures going to the deinterlacer, and NAS discs with that video offered at Original to clients that decode it fast enough.

**Architecture:** `video.wasm` (FFmpeg n9.0.2 decoders and parsers plus `shim.c`) runs in a dedicated decoder worker the engine worker starts through an injected factory. `WasmVideoDecoder` gives `Player` the same surface as `WebCodecsVideoDecoder`: interlaced pictures go to `onFieldInput` as I420 planes with field flags, progressive ones become `VideoFrame`s. A one-time speed probe per device and module decides whether NAS discs default to Original.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`), Emscripten in the pinned emsdk image, FFmpeg n9.0.2, WebCodecs `VideoFrame`, Vitest, Playwright, Node NAS server.

**Spec:** `docs/superpowers/specs/2026-11-17-mpeg2-vc1-decoder-design.md`

## Global Constraints

- New files: `SPDX-License-Identifier: LGPL-3.0-or-later`. `shim.c` is `LGPL-2.1-or-later` with the stated reason "LGPL-2.1-or-later because it links FFmpeg's decoders into one module" (as `packages/engine/wasm/audio/shim.c`), and the new module is listed in `packages/engine/NOTICE`. `npm run licence-check` passes.
- FFmpeg tag `n9.0.2`, the emsdk image digest `audio/build.sh` pins, `linux/amd64`, `SOURCE_DATE_EPOCH=0`; `-O3 -msimd128`; no pthreads. `video.wasm` and `video.wasm.sha256` are committed and rebuilt only by `npm run wasm:build` (`wasm:build:video`); CI's `wasm.yml` rebuilds and diffs it.
- Decoders `mpeg1video,mpeg2video,vc1`, parsers `mpegvideo,vc1`.
- The module is fetched only when a playlist with MPEG-1 (`CodingType.MPEG1_VIDEO`), MPEG-2 or VC-1 video opens (or for the speed probe), with `ASSET_FETCH_TIMEOUT_MS`; the service worker keeps it in a runtime cache, never the precache.
- Decoding never runs on the engine worker's thread.
- Interlaced = CLPI format 1, 2 or 4 (`isInterlacedFormat`). Interlaced pictures reach `onFieldInput` as `FieldInput` with I420 planes; no `VideoFrame` is made for them.
- Speed gate: a codec is "fast enough" when it decodes its 1080 bench clip at ≥ 1.5× the clip's frame rate (field pairs count as frames for interlaced). Results cached in `localStorage` under `bluray-web:wasm-video-speed`, keyed by the module's URL (content-hashed by the build).
- NAS: Original for MPEG-1/2 and VC-1 only when the client sends `mpeg2=1` / `vc1=1` on `GET discs/<id>/levels`. On a NAS disc at Original with a re-encoded level available, a failed decoder or more than 10 s of playback spent skipping switches to the auto level through `setLevel`.
- A failed or missing decoder leaves today's no-picture playback (`unsupported` with `noPicture`, notice `no-picture`), never a dead player.
- `protocol.ts` changes before anything that crosses the worker boundary.
- No user-agent sniffing. The repo is public: no clip, name or path from the owner's discs in any committed file.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01VgtGbWF6p6g1qY1JCsKaE9`

## Review Focus

1. A seek into the middle of an MPEG-2 GOP or a VC-1 entry point: no green or garbage picture, the first picture shown is a complete one at or after the target (Task 5 test "a seek shows no picture before the next I picture").
2. An MPEG-2 stream whose PES packets split a picture, or carry two (common on real discs): every picture decoded once with its own time (Task 2 test "pictures split across or packed into PES payloads keep their times").
3. The decoder worker dying mid-playlist (a WASM trap, out of memory on a phone): playback goes on without a picture and the notice shows, and on a NAS disc at Original the level switches (Task 5 "a worker that dies falls back to no picture"; Task 7 "a failed decoder at Original switches to the auto level").
4. Skipping on a slow device while interlaced: the detector treats the gap as a break, never as a new cadence (Task 5 test "a skip is a cadence break for the deinterlacer").
5. A disc that changes between progressive and interlaced, or between sizes, across play items (a 480i extra after a 1080i feature): each item takes its own path with no stale ring or frame size (Task 5 test "items of different size and scan type each play on their own path").

---

### Task 1: A licensed VC-1 sample

**Files:**
- Create: `fixtures/vc1-sample/README.md`, `fixtures/vc1-sample/<sample files>`
- Modify: the `NOTICE` that covers `fixtures/` (create `fixtures/NOTICE` if none does)

**Interfaces:**
- Produces: `fixtures/vc1-sample/interlaced.vc1` (a VC-1 Advanced Profile elementary stream, interlaced, ideally 1080i) and, if found, `fixtures/vc1-sample/progressive.vc1`; the README names source URL, licence text or link, author, and what was cut (seconds, frames).

- [ ] **Step 1: Find candidates.** Search FFmpeg's FATE samples (`samples.ffmpeg.org`, `fate-suite/vc1/`), SMPTE RP 228 / VC-1 conformance material, Microsoft's published VC-1 test streams, and freely licensed footage already encoded to VC-1 (for example Blender Foundation films in VC-1, CC BY). Keep only streams whose licence is stated and allows redistribution in an LGPL repository.
- [ ] **Step 2: Gate.** If no candidate has a stated licence that allows redistribution, STOP: write what was searched and why each candidate failed to the task report, commit nothing, and report BLOCKED so the controller asks the owner (spec §"VC-1 fixture").
- [ ] **Step 3: Cut and commit.** Cut to at most 5 MB per file (ffmpeg `-c copy` to `.vc1` elementary stream; keep whole GOPs from an entry point), check with `ffprobe -show_frames` that it is Advanced Profile and, for `interlaced.vc1`, that frames are interlaced; write the README and the NOTICE entry.

```bash
git add fixtures/vc1-sample fixtures/NOTICE
git commit -m "fixtures: a licensed VC-1 sample for the WASM decoder's tests"
```

### Task 2: `video.wasm` and its TypeScript wrapper

**Files:**
- Create: `packages/engine/wasm/video/build.sh`, `shim.c`, `video.wasm`, `video.wasm.sha256`
- Create: `packages/engine/src/decode/wasm-video.ts`, `packages/engine/src/decode/wasm-video.test.ts`
- Create: `scripts/make-mpeg2-es.ts` (writes `packages/engine/src/decode/fixtures/mpeg2-*.m2v` and their expected-picture JSON from ffprobe)
- Modify: `package.json` (`wasm:build:video`, include it in `wasm:build`), `packages/engine/package.json` (`exports["./video.wasm"]`, `files`), `.github/workflows/wasm.yml`, `packages/engine/NOTICE`, `scripts/ci-changes.sh` (the new module in the wasm group)

**Interfaces:**
- Produces (`wasm-video.ts`):
  - `export const WasmVideoCodec = { MPEG1: 0, MPEG2: 1, VC1: 2 } as const;` and `type WasmVideoCodecId`
  - `export function wasmVideoCodecFor(codingType: number): WasmVideoCodecId | null`
  - `export interface DecodedPicture { width: number; height: number; displayWidth: number; displayHeight: number; data: Uint8Array /* I420, tightly packed: Y w×h, U, V (w/2)×(h/2) */; ptsUs: number; durationUs: number; keyFrame: boolean; matrix: PlaneMatrix | null; flags: FieldFlags }`
  - `export function loadVideoWasm(source: BufferSource | Promise<Response>): Promise<VideoWasm>`
  - `export class WasmPictureDecoder { constructor(wasm: VideoWasm, codec: WasmVideoCodecId); push(bytes: Uint8Array, ptsUs: number): void; drain(): DecodedPicture[]; flush(): DecodedPicture[]; reset(): void; setSkipNonReference(on: boolean): void; close(): void }` (synchronous; pictures come out in presentation order)
- Field flags: MPEG-2 `top_field_first`, `progressive_frame`, `repeat_first_field` and VC-1 TFF/RFF map to `FieldFlags` (`fieldOrder` from TFF for a non-progressive frame, `progressive` from `progressive_frame` / the frame coding mode, `repeatFirstField` from RFF); a progressive sequence's frames give `progressive: true`.

- [ ] **Step 1: Generate the MPEG-2 test streams.** `scripts/make-mpeg2-es.ts` encodes with ffmpeg's `mpeg2video` 1 s each of: 1080p 23.976 progressive, 1080i 29.97 top field first (`-flags +ilme+ildct -top 1`), 1080i bottom field first (`-top 0`), using `scripts/mpeg2-video.ts`'s content; runs `ffprobe -show_frames` and writes `<name>.json` (`[{ ptsUs, interlaced, topFieldFirst, repeatPict }]`). Commit the outputs (each under 1 MB).
- [ ] **Step 2: Write the failing tests** in `wasm-video.test.ts` (load `video.wasm` from disk as `tests/helpers/audio-wasm.ts` does for audio):
  - `decodes every MPEG-2 picture with ffprobe's times and field flags` (each of the three streams: count, `ptsUs`, `flags.progressive === !interlaced`, `flags.fieldOrder` from `topFieldFirst`)
  - `decodes the VC-1 sample's pictures with their field flags` (count and flags against an ffprobe JSON of `fixtures/vc1-sample/interlaced.vc1` written in Step 1's script)
  - `pictures split across or packed into PES payloads keep their times` (push the 1080i stream in 1000-byte slices carrying the PES time only on the slice where a picture starts, then as one blob of two pictures with the first's time; same pictures and times as whole-picture pushes)
  - `reset drops queued pictures and the next output starts at an I picture`
  - `skipping non-reference pictures drops B pictures only` (with `setSkipNonReference(true)` the 1080p stream yields exactly its I and P pictures)
  - `I420 planes match ffmpeg's decode` (first picture's Y plane SHA-256 equals a hash the script stored from `ffmpeg -f rawvideo -pix_fmt yuv420p`)
- [ ] **Step 3: Run** `npx vitest run packages/engine/src/decode/wasm-video.test.ts` — Expected: FAIL (no module).
- [ ] **Step 4: Write `build.sh` and `shim.c`** (configure as `audio/build.sh` with the decoders and parsers above, `-O3 -msimd128`, exports for open, push, receive, picture accessors, skip, reset, close, malloc, free; open VC-1 from the in-band sequence and entry-point headers found by the parser before the first picture), then `npm run wasm:build:video`.
- [ ] **Step 5: Write `wasm-video.ts`** to the interfaces above.
- [ ] **Step 6: Run** the test file — Expected: PASS. Run `npm run licence-check` — Expected: exit 0.
- [ ] **Step 7: Commit**

```bash
git add packages/engine/wasm/video packages/engine/src/decode/wasm-video.ts packages/engine/src/decode/wasm-video.test.ts packages/engine/src/decode/fixtures scripts/make-mpeg2-es.ts package.json packages/engine/package.json packages/engine/NOTICE .github/workflows/wasm.yml scripts/ci-changes.sh
git commit -m "feat(engine): video.wasm, FFmpeg's MPEG-1/2 and VC-1 decoders, and its wrapper"
```

### Task 3: Disc fixtures for MPEG-2 and VC-1, and the bench clips

**Files:**
- Create: `scripts/mpeg2-pulldown.ts` (original code: sets `repeat_first_field`/`top_field_first` per a 3:2 pattern and `frame_rate_code` 4 on a 23.976 progressive stream, as a soft-pulldown tool does), `scripts/make-mpeg2-interlaced-disc.ts`, `scripts/make-vc1-disc.ts`
- Create: `fixtures/synthetic/disc-mpeg2-interlaced/`, `fixtures/synthetic/disc-vc1/`, `packages/engine/wasm/video/bench/mpeg2-1080i.m2v`, `packages/engine/wasm/video/bench/vc1-1080i.vc1`, `packages/engine/wasm/video/bench/README.md`
- Modify: `package.json` (`fixture:synthetic` runs both scripts), `CLAUDE.md` (fixture list)

**Interfaces:**
- Produces: `disc-mpeg2-interlaced` playlists `00000` 1080i TFF video (4 s), `00001` 1080i BFF video, `00002` 1080i hard 3:2 telecine of 23.976 film, `00003` 480i soft pulldown (`mpeg2-pulldown.ts`), `00004` 1080p 23.976 progressive; `disc-vc1` playlist `00000` from `interlaced.vc1` and `00001` from `progressive.vc1` when Task 1 found one. Bench clips: 0.5 s, 1080, interlaced, ≤ 2 MB each.

- [ ] **Step 1: Failing test** `tests/fixtures/mpeg2-vc1-discs.test.ts`: `the MPEG-2 and VC-1 discs' playlists carry their codings and formats` (open each disc with `openDisc` over `tests/helpers/fixture-disc.ts`; assert each playlist's primary video `codingType` (0x02 MPEG-2, 0xEA VC-1) and CLPI format (4 for 1080i, 1 for 480i, 6 for 1080p)), and `the soft pulldown stream's flags repeat in 3:2` (parse `00003`'s picture coding extensions: the RFF/TFF sequence repeats `[tff+rff, bff, bff+rff, tff]`).
- [ ] **Step 2: Run** `npx vitest run tests/fixtures/mpeg2-vc1-discs.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write the scripts** on `tests/helpers/bdmv-builders.ts` and `scripts/mpeg2-video.ts` as `make-interlaced-disc.ts` does for H.264 (VC-1 PES with stream id 0xFD and stream type 0xEA), run them, write the bench README (what each clip is, from which fixture).
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts fixtures/synthetic/disc-mpeg2-interlaced fixtures/synthetic/disc-vc1 packages/engine/wasm/video/bench tests/fixtures/mpeg2-vc1-discs.test.ts package.json CLAUDE.md
git commit -m "fixtures: interlaced, telecined, soft-pulldown and progressive MPEG-2 and VC-1 discs"
```

### Task 4: The decoder worker and `WasmVideoDecoder`

**Files:**
- Modify first: `packages/engine/src/protocol.ts` only if a type crosses to the page here (it shouldn't; the worker is engine-internal)
- Create: `packages/engine/src/decode/video-worker-protocol.ts`, `packages/engine/src/decode/video-worker.ts` (entry), `packages/engine/src/decode/wasm-video-decoder.ts`, `packages/engine/src/decode/wasm-video-decoder.test.ts`

**Interfaces:**
- Consumes: Task 2's `WasmPictureDecoder`, `DecodedPicture`, `wasmVideoCodecFor`.
- Produces:
  - `video-worker-protocol.ts`: `type ToVideoWorker = { type: 'open'; wasmUrl: string; codec: WasmVideoCodecId } | { type: 'decode'; id: number; data: Uint8Array; ptsUs: number; discard: boolean } | { type: 'flush'; id: number } | { type: 'reset' } | { type: 'skip'; on: boolean } | { type: 'close' }`; `type FromVideoWorker = { type: 'opened' } | { type: 'picture'; picture: DecodedPicture } | { type: 'decoded'; id: number; ms: number } | { type: 'flushed'; id: number } | { type: 'error'; message: string; fatal: boolean }` (picture data transferred).
  - `export class WasmVideoDecoder implements Decoder<VideoUnit, VideoFrame>` in `wasm-video-decoder.ts`: `constructor(deps: { createWorker(): WorkerLike; wasmUrl: string; makeFrame(p: DecodedPicture): VideoFrame })`; `onFieldInput: ((input: FieldInput) => void) | null`; `onFieldsUnreadable` (never called; present for `Player.wireDecoder`); `setSkipping(on: boolean): void`; `readonly skipped: number; readonly decodeMs: number | null` (mean of the last 30); `queueSize` = units sent and not yet answered `decoded`; at most 8 in flight before `queueSize` reports the backlog to the pipeline.
  - `export function frameFromPicture(p: DecodedPicture): VideoFrame` (`new VideoFrame(p.data, { format: 'I420', codedWidth, codedHeight, displayWidth, displayHeight, timestamp: p.ptsUs, duration, colorSpace })`, matrix from the picture else by height as `video-decoder.ts` does).
  - `WorkerLike` is the engine's existing one (`bdj-provider.ts`).

- [ ] **Step 1: Failing tests** in `wasm-video-decoder.test.ts` with a fake `WorkerLike` that answers messages:
  - `configure opens the worker for the stream's codec and rejects with UnsupportedCodecError when it reports a fatal error`
  - `an interlaced stream's pictures go to onFieldInput as I420 planes with their flags and no VideoFrame`
  - `a progressive stream's pictures go to onOutput as VideoFrames at their times`
  - `discard units are decoded and never output`
  - `queueSize counts units not yet decoded and flush resolves after flushed`
  - `reset drops pictures in flight from before it` (pictures tagged with a generation; late ones dropped)
  - `a worker error event or a fatal error reports a fatal decoder error once`
  - `setSkipping sends skip and counts skipped pictures`
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/decode/wasm-video-decoder.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the protocol file, `video-worker.ts` (loads the module once per `open`, decodes on message, posts pictures in order, posts `decoded` per unit with its time in ms, honours `skip`), and `wasm-video-decoder.ts`. Interlaced-ness comes from `configure`'s `StreamConfig`: add `readonly interlaced?: boolean` to `StreamConfig` (set by `Player` from the CLPI format).
- [ ] **Step 4: Run** — Expected: PASS. Run `npx tsc -b` — Expected: clean.
- [ ] **Step 5: Commit** `feat(engine): a decoder worker for MPEG and VC-1 video, behind the engine's decoder interface`

### Task 5: `Player` plays MPEG and VC-1 with a picture

**Files:**
- Modify first: `packages/engine/src/protocol.ts` (`Telemetry.videoDecoder: { kind: 'webcodecs' | 'wasm'; decodeMs: number | null; skipped: number } | null`; event `{ type: 'videoDecoderTrouble'; reason: 'failed' | 'slow' }`)
- Modify: `packages/engine/src/player.ts`, `packages/engine/src/decode/video-decoder.ts` (`isSupportedVideoCoding` → `canDecodeVideo`), `packages/engine/src/worker-main.ts` (`EngineWorkerOptions.videoWasmUrl?: string`; the worker factory `() => new Worker(new URL('./decode/video-worker.ts', import.meta.url), { type: 'module' })`; test flag `novideowasm` leaves it out), `packages/engine/src/worker.ts`, `src/engine-worker.ts` (pass `videoWasmUrl` from `@seikou/engine/video.wasm?url`), `packages/engine/src/deinterlace/field-input.ts` (`FieldInput.afterSkip?: boolean`), `packages/engine/src/deinterlace/interlaced-video.ts` (an `afterSkip` input restarts the detector's cycle as at a cut), `tests/e2e/unsupported-video.spec.ts` (runs with `?novideowasm=1`)
- Test: `packages/engine/src/player.test.ts`

**Interfaces:**
- Consumes: Task 4's `WasmVideoDecoder`, `frameFromPicture`.
- Produces: `PlayerDeps.videoWasm?: { createWorker(): WorkerLike; wasmUrl: string }` (absent → MPEG/VC-1 play without a picture as today); `export function canDecodeVideo(codingType: number, wasm: boolean): boolean`; `Player` emits `videoDecoderTrouble` `'failed'` when the WASM decoder fails, `'slow'` once 10 s of playback time has passed with skipping on since the playlist started or the last seek.

- [ ] **Step 1: Failing tests** in `player.test.ts` (a fake `videoWasm` whose worker decodes the fixture discs' units into planes of the right size):
  - `an MPEG-2 playlist plays with a picture through the WASM decoder and shows no no-picture notice`
  - `an interlaced MPEG-2 playlist's pictures go to the deinterlacer`
  - `without videoWasm an MPEG-2 playlist plays without a picture and shows the notice` (today's behaviour kept)
  - `a worker that dies falls back to no picture` (notice shown, `videoDecoderTrouble` `'failed'`, audio clock still runs)
  - `a seek shows no picture before the next I picture`
  - `pictures late against the clock turn skipping on, and it turns off once caught up`
  - `a skip is a cadence break for the deinterlacer` (the next `FieldInput` after a skipped picture carries `afterSkip`)
  - `ten seconds of skipping emits videoDecoderTrouble slow once`
  - `items of different size and scan type each play on their own path` (a 1080i item then a 480i item then a 1080p item of the fixture discs)
  - `telemetry names the decoder in use`
  - `a sequence header that changes the size within an item restarts the deinterlacer's ring at the new size`
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/player.test.ts -t "WASM|MPEG|skip|decoder in use|own path"` — Expected: FAIL.
- [ ] **Step 3: Implement.** Skipping: `Player` turns `setSkipping(true)` when a decoded picture arrives later than the clock by more than one frame duration, and off when two consecutive pictures arrive at least two frame durations early. The element path never takes these codings (`choosePath` keeps them on the canvas).
- [ ] **Step 4: Run** the filtered tests, then `npx vitest run packages/engine/src` — Expected: PASS.
- [ ] **Step 5: Run** `npm run build && npx playwright test unsupported-video --project=chromium` — Expected: PASS (with the flag).
- [ ] **Step 6: Commit** `feat(engine): MPEG-1/2 and VC-1 play with a picture through the WASM decoder`

### Task 6: The speed probe and the page's video caps

**Files:**
- Modify first: `packages/engine/src/protocol.ts` (command `{ type: 'probeVideoDecoder' }`; event `{ type: 'videoDecoderSpeed'; speed: { mpeg2Fps: number; vc1Fps: number; moduleUrl: string } | null }`)
- Modify: `packages/engine/src/player.ts` (answers the probe by decoding `packages/engine/wasm/video/bench/*` through a `WasmVideoDecoder` with no clock and timing it; `null` when there is no `videoWasm` or it fails), `packages/engine/src/worker-main.ts` (`EngineWorkerOptions.videoBenchUrls?: { mpeg2: string; vc1: string }`), `src/engine-worker.ts`, `packages/engine/src/controller/` (a `probeVideoDecoder(): Promise<…>` on `PlayerController`), `src/ui/video-caps.ts` (`VideoCaps.mpeg2`, `VideoCaps.vc1`: true when the cached or probed speed is ≥ 1.5 × 29.97), `src/sw.ts` (runtime cache for `video.wasm` and the bench clips)
- Test: `src/ui/video-caps.test.ts`, `packages/engine/src/player.test.ts`, `packages/engine/src/controller/*.test.ts`

**Interfaces:**
- Produces: `export function wasmVideoPlayable(speed: { mpeg2Fps: number; vc1Fps: number } | null): { mpeg2: boolean; vc1: boolean }` in `src/ui/video-caps.ts` (threshold `1.5 * 30000 / 1001`); `localStorage` key `bluray-web:wasm-video-speed` holding `{ moduleUrl, mpeg2Fps, vc1Fps }`, used when its `moduleUrl` equals the current one.

- [ ] **Step 1: Failing tests:** `wasmVideoPlayable passes a codec at 1.5x 29.97 and fails it just below` (45.0 → true, 44.9 → false); `the cached speed is used for the same module and probed again for a new one`; `a failed probe makes both codings unplayable`; in `player.test.ts` `probeVideoDecoder answers with the bench clips' decode rates, and null without videoWasm`.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement.** The probe runs at most once per page load and only when a caller asks (the NAS pre-flight, Task 7), never at start-up.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: a one-time decode speed probe decides whether MPEG and VC-1 play at Original`

### Task 7: NAS discs at Original

**Files:**
- Modify: `server/src/levels/levels.ts` (`levelsFor(source, client?: { mpeg2?: boolean; vc1?: boolean })`: `original` for MPEG-1/2 when `client.mpeg2`, for VC-1 when `client.vc1`; other callers pass nothing and keep today's result), `server/src/levels/level-service.ts` (client gains `mpeg2`, `vc1`), `server/src/routes/discs.ts` (`flag(url, 'mpeg2')`, `flag(url, 'vc1')`; route doc), `src/ui/nas/nas-client.ts` and the pre-flight (`Preflight.tsx`, `level-model.ts`: ask the probe through `videoCaps`, send the flags), `src/ui/nas/level-session.ts` (on `videoDecoderTrouble` while at `original` with a re-encoded level in the list, switch to `autoLevel` of the re-encoded ones), `tests/e2e/nas.spec.ts`
- Test: `server/src/levels/levels.test.ts`, `server/src/routes/discs.test.ts` (or the levels route's test), `src/ui/nas/level-model.test.ts`, `src/ui/nas/level-session.test.ts`

**Interfaces:**
- Consumes: Task 5's `videoDecoderTrouble`, Task 6's `VideoCaps.mpeg2/vc1`.

- [ ] **Step 1: Failing tests:** `levelsFor offers original for MPEG-2 only to a client that decodes it` (no client → no original; `{ mpeg2: true }` → original first; VC-1 needs `vc1`); `the levels route passes mpeg2 and vc1 through`; `the pre-flight sends mpeg2=1 when the speed probe passed and not when it failed`; `a failed decoder at Original switches to the auto level` and `slow at Original switches too, and nothing switches on a local disc`.
- [ ] **Step 2: Run** `npx vitest run server/src/levels src/ui/nas` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: E2E.** In `tests/e2e/nas.spec.ts` add `an MPEG-2 disc on the NAS opens at Original with a picture where the probe passes` (serve `disc-mpeg2-interlaced` from the stand-in's temporary copy; with `?novideowasm=1` the level list offers no Original). Run `npm run build && npx playwright test tests/e2e/nas.spec.ts --project=chromium` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): MPEG and VC-1 discs at Original for clients that decode them`

### Task 8: End to end, docs and the service worker

**Files:**
- Create: `tests/e2e/mpeg-vc1.spec.ts`
- Modify: `docs/playing-discs.md`, `docs/troubleshooting.md`, `docs/nas.md`, `docs/known-issues.md`, `docs/roadmap.md` (remove the item), `CLAUDE.md` (the decoder, the module, the test flag `novideowasm`, the speed probe, the fixtures), `tools/bdj-library` verdict docs if `unsupported-video` changes meaning

- [ ] **Step 1: Write the E2E specs** (every project; `skipWithoutH264` doesn't apply):
  - `an MPEG-2 1080p playlist plays with a picture in sync` (telemetry `videoDecoder.kind === 'wasm'`, A/V mean ≤ 20 ms × `SYNC_TOLERANCE_SCALE`, max ≤ 50 ms × scale, frames presented)
  - `interlaced MPEG-2 is deinterlaced: video at field rate, telecine and soft pulldown as film` (`deinterlace.stats.mode` per playlist 00000–00003)
  - `a VC-1 interlaced playlist plays with a picture and is deinterlaced`
  - `Deinterlacing Off draws MPEG-2 woven`
  - `with the decoder unavailable the disc plays without a picture and says so` (`?novideowasm=1`)
- [ ] **Step 2: Run** `npm run build && npx playwright test mpeg-vc1 --project=chromium --project=firefox --project=webkit` — Expected: PASS (or a recorded known issue per browser, with a reason in `known-issues.md`).
- [ ] **Step 3: Docs.** Update the pages listed: what plays now, the probe, the fall-back to a re-encoded level, the no-picture case. `npx vitest run tests/documentation.test.ts` — Expected: PASS.
- [ ] **Step 4: Commit** `test(e2e): MPEG-2 and VC-1 with a picture in every browser; docs`

### Task 9: Real discs and the device check

Done by the controller with the owner (needs the owner's discs and iPhone).

- [ ] **Step 1:** `LOCAL_DISCS=1 npx playwright test local-discs` — Expected: the owner's MPEG-2 and VC-1 discs play with a picture and seek.
- [ ] **Step 2:** On the owner's iPhone 17 Pro over HTTPS through the dev disc server (self-signed cert, `safaridriver` with `acceptInsecureCerts`), one MPEG-2 1080i and one VC-1 1080i disc, Deinterlacing Auto: frames presented at the expected rate, dropped near 0, A/V mean ≤ 20 ms and max ≤ 50 ms, telemetry `videoDecoder.decodeMs` and `skipped` recorded in the ledger. Delete the copied clips afterwards.
- [ ] **Step 3:** Rerun the BD-J library check's `unsupported-video` discs (`npm run bdj-library:check -- --only <id>` for each) and record the new verdicts.
