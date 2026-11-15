# HDR Video Element, Phase 1 (Sync First) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playlist forced onto the element path (`?videopath=element`) plays its H.264 or HEVC video in a `<video>` element through MSE, kept in step with the audio clock, with the canvas transparent over it, so the owner can judge approach A's sync on real devices.

**Architecture:** The engine worker remuxes the pipeline's video units into fragmented MP4 (`packages/engine/src/element/`) instead of decoding them, and sends init and media segments to the page as events. The page's `ElementVideoOutput` (`packages/engine/src/controller/`) appends them to a `MediaSource` on a muted `<video>` under the canvas and, on every presented frame, nudges `playbackRate` or seeks to follow the engine's clock, which the engine publishes in a shared clock block. The canvas path is untouched for every playlist not forced onto the element path.

**Tech Stack:** TypeScript (strict), WebCodecs-free MSE (`MediaSource`, `ManagedMediaSource`), `requestVideoFrameCallback`, `SharedArrayBuffer`, Vitest, Playwright, ffmpeg with libx265 (fixture only).

**Spec:** `docs/superpowers/specs/2026-11-15-hdr-video-element-design.md` (phase 1 is its §5.10 step 1; phase 2 is outlined at the end of this plan and planned in detail after the owner's decision).

## Global Constraints

- New files start with `// SPDX-License-Identifier: LGPL-3.0-or-later`; the MP4 writing is original code (nothing ported).
- `packages/*` import nothing from `src/` and no React.
- Change `packages/engine/src/protocol.ts` first when a task crosses the worker boundary.
- No user-agent sniffing: ask `MediaSource.isTypeSupported` (or `ManagedMediaSource.isTypeSupported`).
- Browser APIs stay behind injectable interfaces; unit tests use fakes.
- Every export gets a doc comment (`npx vitest run tests/documentation.test.ts`); non-public exports are marked `@internal`; a new public method of `PlayerController` needs an `@example` region in `packages/engine/examples/player-controller.browser.ts`, then `npm run devsite:model`.
- The canvas path must pass every existing test unchanged (`npm test`, `npm run test:e2e`).
- A/V sync bounds (from `tests/e2e/telemetry.ts`): mean within 20 ms, largest within 50 ms.
- TypeScript strict with `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`.

## Review Focus

- **A seek while paused** on the element path must show the frame at the target, as the canvas path does (owner: Task 9, test `paused seek shows the target frame`).
- **Parameter sets that change mid-playlist** (a play item from another clip with another SPS) must produce a new init segment and a `changeType`, not a decode error (Tasks 4 and 7).
- **`QuotaExceededError` on append** (a long UHD clip) must remove what lies behind the playhead and retry once before failing (Task 7).
- **The element running dry while the engine plays** must hold the clock (buffering) and resume, not let audio run ahead (Task 9).
- **Closing the disc or opening another mid-append** must leave no appends running against a torn-down MediaSource (Task 7).

---

### Task 1: The HDR test disc

**Files:**
- Create: `scripts/x265.ts`, `scripts/make-hdr-disc.ts`, `tests/disc-hdr.test.ts`
- Modify: `tests/helpers/bdmv-builders.ts` (stream attributes of HEVC streams), `tests/helpers/synthetic-disc.ts` (clip spec), `package.json` (`fixture:synthetic`)
- Output (committed): `fixtures/synthetic/disc-hdr/`

**Interfaces:**
- Produces: `encodeHevcTestVideo(frames: number, size?: string, hdr?: boolean): Uint8Array[]` (Annex B access units, AUD-split like `encodeTestVideo` in `scripts/x265.ts`); `SyntheticClipSpec.videoDynamicRange?: number` and `videoColorSpace?: number`, written into the HEVC stream attributes as libbluray reads them (`clpi_parse.c` `_parse_stream_attr`: after format, rate, aspect, 2 reserved bits and `oc_flag`, for coding type 0x24: `cr_flag` 1 bit, `dynamic_range_type` 4, `color_space` 4, `hdr_plus_flag` 1, 7 reserved).
- The disc: playlist `00000`, one clip, 8 s, 1920×1080 at 24 fps, HEVC Main10, keyframe every 24 frames, no B-frames, LPCM audio, one PG stream (subtitle at 1 s, cleared at 5 s, as `make-mpeg2-disc.ts` does), chapters every 2 s; CLPI `dynamic_range_type` 1 (HDR10), `color_space` 2 (BT.2020).

- [ ] **Step 1: Write the failing test** `tests/disc-hdr.test.ts`, `it('is an HDR10 HEVC Main10 disc')`: read `fixtures/synthetic/disc-hdr` with `fixtureDiscFiles('disc-hdr')`; parse `BDMV/CLIPINF/00001.clpi`; assert the video stream's `codingType === CodingType.HEVC`; demux the first video PES of `BDMV/STREAM/00001.m2ts`, `analyzeHevc(...)` gives `idr === true` and an SPS whose `hevcCodecStrings(sps)[0]` starts with `hvc1.2.4.` (Main10); the raw CLPI bytes of that stream's attributes carry `dynamic_range_type` 1 and `color_space` 2 (read the two nibbles by offset in the test).
- [ ] **Step 2: Run** `npx vitest run tests/disc-hdr.test.ts`. Expected: FAIL (no fixture).
- [ ] **Step 3: Implement** `encodeHevcTestVideo` with ffmpeg `testsrc2=size=<size>:rate=24`, `-c:v libx265 -pix_fmt yuv420p10le -profile:v main10` and `-x265-params keyint=24:min-keyint=24:scenecut=0:bframes=0:aud=1:repeat-headers=1` plus, with `hdr`, `hdr10=1:hdr10-opt=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400`, output `-f hevc`; split at AUD NAL units (HEVC type 35: `(byte >> 1) & 0x3f === 35`). Extend the builders, write `make-hdr-disc.ts` after `make-mpeg2-disc.ts`, append `&& tsx scripts/make-hdr-disc.ts fixtures/synthetic/disc-hdr` to `fixture:synthetic`, and run that one script.
- [ ] **Step 4: Run** `npx vitest run tests/disc-hdr.test.ts` and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** the scripts, builders, test and `fixtures/synthetic/disc-hdr/`: `test: an HDR10 HEVC Main10 synthetic disc`.

### Task 2: Parameter sets and SPS facts for MP4 sample entries

**Files:**
- Create: `packages/bdmv/src/codecs/param-sets.ts`, `packages/bdmv/src/codecs/param-sets.test.ts`

**Interfaces:**
- Produces (all `@internal`):
  - `interface ParameterSets { vps: Uint8Array[]; sps: Uint8Array[]; pps: Uint8Array[] }` (NAL units without start codes, header bytes included).
  - `findParameterSets(au: Uint8Array, coding: 'avc' | 'hevc'): ParameterSets` (H.264: SPS 7, PPS 8; HEVC: VPS 32, SPS 33, PPS 34).
  - `interface HevcSpsInfo { profileSpace: number; tierFlag: number; profileIdc: number; compatFlags: number; constraintFlags: Uint8Array /* 6 bytes */; levelIdc: number; chromaFormatIdc: number; bitDepthLuma: number; bitDepthChroma: number; width: number; height: number }` and `readHevcSps(sps: Uint8Array): HevcSpsInfo` (width and height after the conformance window).
  - `interface AvcSpsInfo { profileIdc: number; constraintFlags: number; levelIdc: number; width: number; height: number }` and `readAvcSps(sps: Uint8Array): AvcSpsInfo`.
  - `splitNalUnits(au: Uint8Array): Uint8Array[]` (Annex B start codes removed).

- [ ] **Step 1: Write failing tests** in `param-sets.test.ts`, reading the first video access unit of a fixture disc with `M2tsReader` over `syntheticSource(fixtureDiscFiles(name))`: for `disc-hdr`, `findParameterSets(au, 'hevc')` gives one VPS, one SPS and one PPS, and `readHevcSps` gives `{ profileIdc: 2, chromaFormatIdc: 1, bitDepthLuma: 10, bitDepthChroma: 10, width: 1920, height: 1080 }`; for `disc1`, `readAvcSps` gives `profileIdc: 100` and `width`/`height` equal to the size `scripts/make-fixture-disc.ts` encodes; `splitNalUnits([0,0,0,1,0x09,0xf0,0,0,1,0x67,0x64])` gives `[[0x09,0xf0],[0x67,0x64]]`.
- [ ] **Step 2: Run** `npx vitest run packages/bdmv/src/codecs/param-sets.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, reusing the RBSP unescaping and bit reader already in `codecs/` (`unescapeRbsp` in `hevc.ts`); HEVC SPS parsing walks `profile_tier_level` with `sps_max_sub_layers_minus1` sub-layers (H.265 §7.3.3).
- [ ] **Step 4: Run** the test, `npx vitest run tests/documentation.test.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(bdmv): parameter sets and SPS facts for MP4 sample entries`.

### Task 3: The fragmented MP4 writer

**Files:**
- Create: `packages/engine/src/element/fmp4.ts`, `packages/engine/src/element/fmp4.test.ts`

**Interfaces:**
- Consumes: `ParameterSets`, `readAvcSps`, `readHevcSps` (Task 2); `avcCodecString` (`@seikou/bdmv/codecs/h264`), `hevcCodecStrings` (`@seikou/bdmv/codecs/hevc`).
- Produces (`@internal`):
  - `TIMESCALE = 90_000`.
  - `interface VideoTrack { coding: 'avc' | 'hevc'; params: ParameterSets; codec: string; width: number; height: number }` and `videoTrack(coding: 'avc' | 'hevc', params: ParameterSets): VideoTrack` (codec `avc1.…` from `avcCodecString`, or the `hvc1.…` form from `hevcCodecStrings`).
  - `initSegment(track: VideoTrack): Uint8Array`: `ftyp` (major `isom`, brands `isom iso6 mp41`), `moov` (`mvhd`, one `trak` with `tkhd`, `mdia`/`mdhd` at TIMESCALE, `hdlr` vide, `minf`/`vmhd`/`dinf`/`stbl` with `stsd` holding `avc1`+`avcC` or `hvc1`+`hvcC` and empty `stts stsc stsz stco`), `mvex`/`trex`). Track id 1.
  - `interface Fmp4Sample { data: Uint8Array /* length-prefixed NAL units */; durationTicks: number; ctsOffsetTicks: number; sync: boolean }`.
  - `mediaSegment(sequence: number, baseDecodeTicks: number, samples: readonly Fmp4Sample[]): Uint8Array`: `moof` (`mfhd`, `traf` with `tfhd` default-base-is-moof, `tfdt` version 1, `trun` with data offset, per-sample duration, size, flags and signed composition offset, version 1) then `mdat`.
  - `toLengthPrefixed(au: Uint8Array): Uint8Array` (4-byte lengths; drops AUD NAL units, keeps the rest).

- [ ] **Step 1: Write failing tests**: a box walker in the test file asserts the box tree of `initSegment` (`ftyp`, `moov>trak>mdia>minf>stbl>stsd>hvc1>hvcC`, and `avc1>avcC` for H.264) and that `hvcC`'s first bytes carry `configurationVersion 1`, the profile and level of the fixture; `mediaSegment(3, 900_000, samples)` has `mfhd` sequence 3, `tfdt` 900000, `trun` sample count, sizes and the data offset pointing at the first `mdat` byte; `toLengthPrefixed` on two NAL units gives `[0,0,0,2,…,0,0,0,2,…]`. **With ffprobe on PATH** (skip otherwise): write the init and two segments of the HDR fixture's first 48 units to a temporary `.mp4` and assert `ffprobe -count_frames` reports 48 frames of `hevc`, 1920×1080, `yuv420p10le`.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/element/fmp4.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with a small big-endian byte writer (or `tests/helpers/byte-writer.ts`'s approach moved under `element/`); `hvcC` per ISO/IEC 14496-15 §8.3.3 with arrays for VPS, SPS and PPS, `lengthSizeMinusOne` 3; `avcC` per §5.3.3.
- [ ] **Step 4: Run** the test, the doc test and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(engine): a fragmented MP4 writer for H.264 and HEVC`.

### Task 4: The remuxer

**Files:**
- Create: `packages/engine/src/element/remux.ts`, `packages/engine/src/element/remux.test.ts`, `packages/engine/src/element/testdata/avc-1280x720.h264`
- Modify: `packages/engine/src/playback/pipeline.ts` (the video sink passes `dtsUs`, as the PG and IG sinks do)

**Interfaces:**
- Consumes: Task 3's functions; `analyzeAvc`, `analyzeHevc`.
- Produces (`@internal`):
  - `type RemuxOutput = { kind: 'init'; bytes: Uint8Array; codec: string; width: number; height: number } | { kind: 'segment'; bytes: Uint8Array; startUs: number; endUs: number }`.
  - `class ElementRemux { constructor(coding: 'avc' | 'hevc', emit: (out: RemuxOutput) => void); push(unit: { data: Uint8Array; ptsUs: number; dtsUs?: number; inRange: boolean }): void; flush(): void; reset(): void; readonly endUs: number }`.
  - Behaviour: units with `inRange === false` are dropped; until the first IRAP unit (H.264: `analyzeAvc(...).idr`, HEVC: `.key`) nothing is emitted; the first parameter sets give an `init`, and parameter sets that differ from the last ones give a new `init` before the next segment; a segment holds the units from one IRAP unit up to the next and is emitted when the next IRAP arrives or on `flush`; decode time is `dtsUs ?? ptsUs`, converted to TIMESCALE ticks with `Math.round(us * 0.09)`; a sample's duration is the next sample's decode time minus its own (the last sample in a segment takes the one before it); `startUs` is the first sample's PTS, `endUs` the last PTS plus its duration; H.264 units go through `analyzeAvc(...).data` (MVC removed); `reset()` drops everything held and forgets the parameter sets (the next IRAP gives an `init` again); `endUs` is the end of the last emitted segment (`-Infinity` before one).

- [ ] **Step 1: Write failing tests**: 48 units of disc1 (two GOPs) give `init`, then one `segment` when the second IRAP arrives and one on `flush`, with `startUs` and `endUs` matching the units' PTS; units before the first IRAP give nothing; an `inRange: false` unit is dropped; disc2's units (B-frames, PTS ≠ DTS) give samples whose composition offsets equal `pts − dts` in ticks; `reset()` then the same units again give a second `init`; `it('a new SPS mid-stream emits a new init before the next segment')`: disc1's units followed by the units of `testdata/avc-1280x720.h264` (committed; made once with `encodeTestVideo(48, '1280x720')` and split by the same AUD rule, the command in a comment at the top of the test) give `init` (disc1's size), segments, then `init` with `width: 1280` before the next segment.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/element/remux.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ElementRemux` and add `dtsUs` to the video sink in `pipeline.ts` (same conversion as the PG sink).
- [ ] **Step 4: Run** the test and `npx vitest run packages/engine/src/playback/pipeline.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(engine): remux video units into fragmented MP4`.

### Task 5: The protocol and the shared clock block

**Files:**
- Modify: `packages/engine/src/protocol.ts`
- Create: `packages/engine/src/element/clock-block.ts`, `packages/engine/src/element/clock-block.test.ts`

**Interfaces:**
- Produces in `protocol.ts` (doc comments on each):
  - `type VideoPath = 'auto' | 'element' | 'canvas'`.
  - Commands: `{ type: 'setVideoPath'; path: VideoPath }`; `{ type: 'attachVideoElement'; clock: SharedArrayBuffer }`; `{ type: 'videoElementAnswer'; codec: string; playable: boolean }` (handled at once); `{ type: 'videoBuffered'; endUs: number }` (handled at once); `{ type: 'videoStalled' }` and `{ type: 'videoResumed' }` (at once); `{ type: 'videoElementFailed'; message: string }` (at once); `{ type: 'videoSync'; offsetsUs: number[]; presented: number; dropped: number }` (at once).
  - Events: `{ type: 'videoElementQuery'; codec: string }`; `{ type: 'videoInit'; bytes: Uint8Array; codec: string; width: number; height: number }`; `{ type: 'videoSegment'; bytes: Uint8Array; startUs: number; endUs: number }`; `{ type: 'videoReset'; startUs: number; paused: boolean }`; `{ type: 'videoEnded' }`; `{ type: 'videoElementStop' }`.
  - `Telemetry.videoPath: 'canvas' | 'element' | null` (null with no playlist).
- Produces in `clock-block.ts` (`@internal`): `createClockBlock(): SharedArrayBuffer`; `class ClockBlockWriter { constructor(sab: SharedArrayBuffer); write(clockUs: number, running: boolean, atEpochMs: number): void }`; `interface ClockReading { clockUs: number; running: boolean; atEpochMs: number }`; `class ClockBlockReader { constructor(sab: SharedArrayBuffer); read(): ClockReading | null; clockAt(epochMs: number): number | null }` (`clockAt` extrapolates while running). A sequence counter (odd while writing) guards torn reads; `read()` retries up to 4 times, then returns null. Epoch milliseconds are `performance.timeOrigin + performance.now()` on both sides.

- [ ] **Step 1: Write failing tests** in `clock-block.test.ts`: a written reading reads back; `clockAt(at + 40)` is `clockUs + 40_000` while running and `clockUs` while not; a reader that sees an odd sequence (simulate by writing the counter directly) gets null after retries.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/element/clock-block.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the block (an `Int32Array` sequence plus a `Float64Array` of three values over one buffer) and the protocol members; extend `reduceEvent` in `player-controller.ts` to ignore the new events (Task 8 handles them) so `npm run typecheck` passes.
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(engine): the element path's protocol and shared clock block`.

### Task 6: The sync controller

**Files:**
- Create: `packages/engine/src/controller/element-sync.ts`, `packages/engine/src/controller/element-sync.test.ts`

**Interfaces:**
- Consumes: `ClockReading` (Task 5).
- Produces (`@internal`): `interface SyncAction { rate: number; seekToUs: number | null; offsetUs: number | null }`; `class ElementSync { constructor(opts?: { deadBandUs?: number; seekBeyondUs?: number; maxRateDelta?: number; gain?: number }); onFrame(mediaTimeUs: number, clockUs: number | null, playing: boolean): SyncAction; reset(): void }`. Defaults: dead band 10 000 µs, seek beyond 100 000 µs, max rate delta 0.005, gain 0.1 (rate change per second of offset). `offset = mediaTimeUs − clockUs` (positive: video ahead). Not playing or no clock: `{ rate: 1, seekToUs: null, offsetUs: null }`. `|offset| ≤ dead band`: rate 1. Up to seek beyond: `rate = 1 − clamp(offset / 1e6 × gain, −max, max)`. Beyond: `seekToUs = clockUs`, rate 1. After a seek, the next two frames are not corrected (the seek's frames settle), reported with their offsets.

- [ ] **Step 1: Write failing tests**: an offset of 5 ms gives rate 1; +50 ms gives 0.995; −50 ms gives 1.005; +30 ms gives 0.997; +150 ms gives a seek to the clock time; not playing gives rate 1 and null offset; the two frames after a seek report offsets and rate 1; a run of frames whose clock advances 41 667 µs per frame while media time advances 41 667 µs × 1.002 converges (simulate 240 frames applying the rate, assert the last 48 offsets within 10 ms).
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/controller/element-sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ElementSync`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(engine): the element path's sync controller`.

### Task 7: `ElementVideoOutput` on the page

**Files:**
- Create: `packages/engine/src/controller/element-output.ts`, `packages/engine/src/controller/element-output.test.ts`

**Interfaces:**
- Consumes: `ElementSync` (Task 6), `ClockBlockReader` and `createClockBlock` (Task 5), the Task 5 events and commands.
- Produces (`@internal`):
  - Fakeable surfaces: `interface VideoElementLike { muted: boolean; playsInline: boolean; currentTime: number; playbackRate: number; src: string; readonly paused: boolean; play(): Promise<void>; pause(): void; requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number; expectedDisplayTime: number }) => void): number; cancelVideoFrameCallback(id: number): void; getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number }; addEventListener(type: 'waiting' | 'playing' | 'error', fn: () => void): void; removeAttribute(name: string): void; load(): void }`; `interface MediaSourceLike { readonly readyState: string; addSourceBuffer(type: string): SourceBufferLike; endOfStream(): void; addEventListener(type: 'sourceopen', fn: () => void): void }`; `interface SourceBufferLike { readonly updating: boolean; readonly buffered: { length: number; start(i: number): number; end(i: number): number }; appendBuffer(b: Uint8Array): void; remove(start: number, end: number): void; abort(): void; changeType?(type: string): void; addEventListener(type: 'updateend' | 'error', fn: () => void): void }`; `interface ElementOutputDeps { video: VideoElementLike; createMediaSource(): { source: MediaSourceLike; url: string; revoke(): void } | null; isTypeSupported(type: string): boolean; epochMs(): number; post(cmd: EngineCommand): void; setTimer(fn: () => void, ms: number): () => void }`.
  - `class ElementVideoOutput { constructor(deps: ElementOutputDeps); readonly clock: SharedArrayBuffer; handle(e: EngineEvent): boolean /* true when it was one of its events */; setPlaying(playing: boolean): void; dispose(): void }`.
  - Behaviour: `videoElementQuery` answers `videoElementAnswer` with `isTypeSupported('video/mp4; codecs="<codec>"')`; `videoInit` opens a MediaSource (first time) and adds a SourceBuffer, or calls `changeType` when the codec differs, then queues the bytes; `videoSegment` queues; appends run one at a time on `updateend`; after each append `videoBuffered` with the end of the buffered range holding the playhead, in µs; `QuotaExceededError` removes everything more than 10 s behind `currentTime` and retries once, then `videoElementFailed`; behind-playhead data older than 10 s is removed after each append; `videoReset` aborts, removes all, sets `currentTime` to `startUs / 1e6` once the next segment is appended, and pauses or plays per `paused`; `videoEnded` calls `endOfStream()` after the queue drains; `videoElementStop` and `dispose()` cancel callbacks, clear the queue, detach the source (`removeAttribute('src')`, `load()`) and revoke the URL; every presented frame runs `ElementSync.onFrame(meta.mediaTime × 1e6, reader.clockAt(timeOrigin + meta.expectedDisplayTime), playing)` and applies the action; offsets are batched into `videoSync` every 250 ms with `getVideoPlaybackQuality()` totals; `waiting` and `playing` events post `videoStalled` and `videoResumed` while `setPlaying(true)`; an `error` event posts `videoElementFailed`.

- [ ] **Step 1: Write failing tests** with fakes for each behaviour above, including `it('a new codec in videoInit goes through changeType')`, `it('QuotaExceededError removes what is behind and retries once')`, `it('videoElementStop mid-append leaves no append running')` (append in flight, stop, then `updateend` fires: nothing more is appended, no command posted), `it('answers a query from isTypeSupported')`, and the sync wiring (a frame callback at media time 1.05 s with the clock block at 1.0 s sets `playbackRate` 0.995).
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/controller/element-output.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ElementVideoOutput`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(engine): the page's element video output`.

### Task 8: `PlayerController` and the player screen

**Files:**
- Modify: `packages/engine/src/controller/player-controller.ts`, `packages/engine/src/controller/player-controller.test.ts`, `packages/engine/examples/player-controller.browser.ts`, `src/ui/PlayerScreen.tsx`, `src/ui/styles.css`, `src/ui/App.tsx`

**Interfaces:**
- Consumes: `ElementVideoOutput` (Task 7).
- Produces: public `PlayerController.attachVideoElement(video: HTMLVideoElement): void` (creates the output with the browser's `MediaSource`, or `ManagedMediaSource` where `MediaSource` is missing, posts `attachVideoElement` with its clock; once per element) and `PlayerController.setVideoPath(path: VideoPath): void` (posts `setVideoPath`); `PlayerSnapshot.videoElement: boolean` (true from `videoInit` until `videoElementStop` or a close), set in `reduceEvent`; the controller passes engine events to the output first and calls `setPlaying(state === 'playing')` on `state` events.
- UI: a `<video data-testid="video-element" className="player-video">` before the canvas in `PlayerScreen`, `hidden` unless `snapshot.videoElement`; CSS: it and the canvas fill the player box, the video `object-fit: contain`, the canvas above it. `App.tsx` reads `?videopath=element|canvas|auto` and calls `setVideoPath` before the first open.

- [ ] **Step 1: Write failing tests** in `player-controller.test.ts`: `attachVideoElement` posts `attachVideoElement` with a `SharedArrayBuffer` once for the same element; `setVideoPath('element')` posts the command; `videoInit` sets `snapshot.videoElement` true and `videoElementStop` false.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/controller/player-controller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the controller methods, the reducer fields, the screen markup, the CSS and the flag; add `#attachVideoElement` and `#setVideoPath` regions to the browser example and tag both methods with `@example`; run `npm run devsite:model`.
- [ ] **Step 4: Run** `npx vitest run packages/engine/src/controller/player-controller.test.ts src/ui/PlayerScreen.test.tsx tests/examples.test.ts tests/documentation.test.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat: the player screen hands a video element to the engine`.

### Task 9: The engine plays a session on the element path

**Files:**
- Modify: `packages/engine/src/player.ts`, `packages/engine/src/render/compositor.ts`, `packages/engine/src/memory-profile.ts`
- Test: `packages/engine/src/player-element.test.ts` (new, beside `player.test.ts`, with its fakes), `packages/engine/src/render/compositor.test.ts`

**Interfaces:**
- Consumes: `ElementRemux` (Task 4), `ClockBlockWriter` (Task 5), the Task 5 protocol.
- Produces:
  - `Session.element: ElementRemux | null` and a private `hasPicture(s)` (`s.decoder !== null || s.element !== null`) used where `s.decoder === null` means "no picture" today (`player.ts` lines 781, 795, 3214, 3372, 3392, 3403, 3443 at the time of writing).
  - Path choice at session start: the element path when the video path is `element`, the coding is AVC or HEVC, a video element is attached, and the page answers `playable` within 2 s to a `videoElementQuery` (cached per codec); `auto` and `canvas` take the canvas path in phase 1.
  - `MemoryProfile.elementLeadUs`: 10 s desktop, 4 s constrained; `readerBlocked` for an element session: `elementBufferedEndUs − clock ≥ elementLeadUs`.
  - Units go to `s.element.push`; `videoInit` and `videoSegment` events carry the remuxer's output (bytes transferred); on EOF `flush()` then `videoEnded`.
  - The engine writes the clock block every tick while a video element is attached.
  - Start-up: video ready once the page reports a buffered end past the clock (or EOF). A `videoStalled` while playing stops the ring (or the wall clock) and enters `buffering`; `videoResumed` with a buffered end at least 0.5 s past the clock lets the usual start-up resume it.
  - End of playlist: as with a picture, once the remuxer's `endUs` (plus 100 ms) has played and the reader is done.
  - Seeks and pause: a seek emits `videoReset { startUs: target, paused }` and `element.reset()`; a teardown emits `videoElementStop`.
  - Telemetry: `videoPath`; offsets from `videoSync` feed `this.offsets`; `framesPresented` and `framesDropped` take the page's totals on an element session.
  - `CompositorLike.startPlaylist?(picture: boolean, opts?: { element?: { width: number; height: number } })`: in element mode the compositor clears to transparent, draws no video and lays text out on the given size; `setElementSize?(width: number, height: number)` updates it on a new init. The `Compositor` creates its context with `alpha: true` and keeps filling opaque black on the canvas path, so the canvas path's pixels don't change.

- [ ] **Step 1: Write failing tests** in `player-element.test.ts`, driving a `Player` with the existing test deps and a disc1 source: with the video path `element`, an attached video element and a fake page that answers `playable: true`, playing playlist 00000 emits `videoElementQuery`, then `videoInit` and `videoSegment` events covering the playlist, and no WebCodecs decoder is created; with `playable: false` it plays on the canvas path; `it('paused seek shows the target frame')`: seek while paused emits `videoReset { startUs: target, paused: true }`; a `videoStalled` while playing moves the state to `buffering` and stops the ring, and `videoResumed` plus `videoBuffered` past the clock returns it to `playing`; `readerBlocked` waits once the buffered end is 10 s past the clock; telemetry reports `videoPath: 'element'` and the offsets posted by `videoSync`; a playlist with no audio runs the clock block on the wall clock (running true while playing). In `compositor.test.ts`: element mode clears to transparent (`clearRect` called, no black fill, no video draw); the canvas path still fills black.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/player-element.test.ts packages/engine/src/render/compositor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `player.ts`, `compositor.ts` and `memory-profile.ts`.
- [ ] **Step 4: Run** those tests, then `npm test`. Expected: PASS, with every existing test unchanged.
- [ ] **Step 5: Commit**: `feat(engine): play a playlist on the element path`.

### Task 10: End-to-end checks of the element path

**Files:**
- Create: `tests/e2e/element-path.spec.ts`
- Modify: `CLAUDE.md` (the `?videopath=` test flag under the main thread's flags; one paragraph in the architecture on the element path, marked phase 1)

**Interfaces:**
- Consumes: `collectWindows`, `expectInSync`, `telemetry` (`tests/e2e/telemetry.ts`), `setFolder`, `skipWithoutH264`, `CHROME_ONLY` (`tests/e2e/support.ts`).

- [ ] **Step 1: Write the tests** (chromium, not mobile, like the sync tests; WebKit too where noted), each opening with `/?telemetry=1&videopath=element`:
  - `disc1 plays on the element path in sync across the play-item boundary to the end`: telemetry `videoPath === 'element'`, `clockMode === 'audio'`, `expectInSync`, `video-element` visible, state `ended`.
  - `skips to the next chapter and is back in sync within a second` (as in `playback.spec.ts`).
  - `pauses and resumes in sync`.
  - `paused seek shows the target frame`: pause, seek to 5 s, the element's `currentTime` is within 0.05 s of 5.
  - `a B-frame disc plays on the element path in sync` (`fixtures/synthetic/disc2`).
  - `the HDR disc plays on the element path where MSE plays HEVC Main10`: skip with a reason unless `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L120.90"')`; `expectInSync`.
  - `without the flag the canvas path plays`: telemetry `videoPath === 'canvas'`, `video-element` hidden.
- [ ] **Step 2: Run** `npm run build && npx playwright test element-path --project=chromium` and `--project=webkit`. Expected: PASS or skips with reasons; then the whole suite `npm run test:e2e`, unchanged.
- [ ] **Step 3: Update** CLAUDE.md.
- [ ] **Step 4: Run** `npx vitest run tests/documentation.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `test(e2e): the element path plays in sync`.

### Checkpoint: the owner judges sync

Deploy a preview (`gh workflow run preview.yml --ref hdr-video`) and hand the owner this checklist, on Safari (Mac with an HDR display), Safari (iPhone or iPad), and Chrome (Mac with an HDR display, or Windows in HDR mode), each with `?videopath=element&telemetry=1`:

1. `disc1` and `disc-hdr` from the synthetic fixtures (or a local UHD disc), five minutes each: lip sync looks right, no visible speed wobble or stutter.
2. Skip chapters, seek, pause and resume: picture and sound line up within a second.
3. Read `window.__blurayTelemetry` (or the probe-style overlay if added): `avOffsetMeanUs` and `avOffsetMaxAbsUs` within 20 ms and 50 ms.

The owner then decides: approach A everywhere, A with a per-session fallback for a browser that can't hold the bounds, or approach C. Phase 2 is planned in detail after that decision.

## Phase 2 (outline, planned after the checkpoint)

On the approach chosen at the checkpoint (spec §5):

- HDR metadata: VUI colour reading (`colr` `nclx`), mastering-display and content-light-level SEI (`mdcv`, `clli`), `pasp`.
- The path choice: CLPI `dynamic_range_type` and `color_space` in `@seikou/bdmv`; `auto` takes HDR streams; shaders force the canvas path and reopen at the same time.
- Overlay placement over the element (display size and aspect), the BD-J background still rule.
- The fallback: an element failure reopens on the canvas path at the same time, with the once-per-disc notice.
- The Video output setting, the HDR badge (HDR displays only), `video-caps.ts` asking MSE too.
- Tests for each, the documentation pages (`playing-discs.md`, `troubleshooting.md`, `known-issues.md`) and CLAUDE.md.
