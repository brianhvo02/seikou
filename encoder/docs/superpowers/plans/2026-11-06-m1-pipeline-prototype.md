# M1 Pipeline Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command line tool that reads a decrypted Blu-ray playlist, cuts it into episodes at chapter marks the user chooses, and writes one AV1 + Opus MKV with chapters per episode through pipes only, with no intermediate media on disk.

**Architecture:** Seikou's MPLS/CLPI parsers and TS demuxer (imported through a path alias) build a playlist model and probe each clip's first timestamps. An episode plan turns chapter ranges into frame and sample ranges. Generated VapourSynth scripts drive `vspipe` into `SvtAv1EncApp` and `opusenc`; this project's own IVF, Ogg and Matroska code muxes the two pipe outputs into the MKV.

**Tech Stack:** Node 22+, TypeScript (strict, ESM), vitest, tsx. External processes: `vspipe` (VapourSynth R82) with the BestSource plugin, `SvtAv1EncApp` (SVT-AV1 4.x), `opusenc` (opus-tools 0.2). Test oracle only: `ffprobe` when present.

**Spec:** `docs/superpowers/specs/2026-11-06-encoding-tools-design.md`

## Global Constraints

- Node ≥ 22, `"type": "module"`, TypeScript `strict: true`, `moduleResolution: "bundler"`, tests with vitest, scripts run with `tsx`.
- License LGPL-3.0-or-later. Every `.ts` file starts with `// SPDX-License-Identifier: LGPL-3.0-or-later`.
- No ffmpeg anywhere in `src/`. `ffprobe` appears only in tests as an oracle, skipped when absent.
- Seikou code is imported only as `seikou/engine/...`, resolved by a path alias to `../seikou/src/engine/` (temporary until `@seikou/bdmv` exists; spec §2).
- Nothing media-like is written to disk except the output MKV and BestSource index files under the cache directory.
- Timing units are named in identifiers: `*45` (45 kHz MPLS/CLPI ticks), `*90` (90 kHz PES ticks), `*48` (Opus samples at 48 kHz), `*Ns` (`bigint` nanoseconds), `*Ms` (Matroska 1 ms timestamps).
- SVT-AV1 defaults: `--preset 4 --crf 25 --enable-variance-boost 1 --tf-strength 1 --film-grain 4 --tile-columns 1 --keyint -2 --color-primaries 1 --transfer-characteristics 1 --matrix-coefficients 1 --color-range 0 --progress 0`. Opus defaults: `--bitrate 160` for ≤ 2 channels, `--bitrate 320` otherwise, always `--ignorelength`.
- Integration tests that need the real tools are wrapped in `describe.skipIf(!haveTools)` where `haveTools` resolves `vspipe`, `SvtAv1EncApp`, `opusenc` on PATH and `vspipe` can load `bs` (checked once in `tests/helpers/tools.ts`).

## Review Focus

1. A playlist with LINK marks (type 2) or marks outside a play item's `[inTime, outTime)`: only ENTRY marks inside the item become chapters (Task 2 test `ignores link marks and marks outside the item`).
2. An episode spec that is unordered, overlapping, or beyond the chapter count (`"3-2"`, `"1-2,2-3"`, `"1-5"` on four chapters): a clear `EpisodeSpecError`, nothing encoded (Task 4 tests).
3. Audio that starts later or earlier than video in the m2ts (typical on real discs): sample positions are computed from the audio stream's own first PTS, and a late start becomes a positive audio offset in the MKV, never silence trimmed from the video (Task 4 test `audio starting 20 ms after video`).
4. An encoder or vspipe failure mid-episode: the sibling process is killed, the partial MKV is deleted, the exit code is non-zero and the tool's stderr is in the error (Task 6 fake-binary test, Task 10 test `deletes the partial file`).
5. A chapter mark that does not fall on a frame boundary: it rounds to the nearest frame and the rebased chapter time comes from that frame, so chapters never point between frames (Task 4 test `rounds a mark to the nearest frame`).

---

### Task 1: Repository scaffold, Seikou alias, fixture disc

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE` (LGPL-3.0 text), `COPYING` (GPL-3.0 text, required alongside LGPL-3.0), `README.md`, `src/index.ts`
- Create: `fixtures/disc1/` (copy of `../seikou/fixtures/synthetic/disc1`, 2.6 MB: two 4 s H.264 clips, LPCM stereo, chapters every 2 s)
- Create: `tests/helpers/tools.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: the alias `seikou/engine/*` → `../seikou/src/engine/*` in `tsconfig.json` `paths` and `vitest.config.ts` `resolve.alias`; `haveTools: boolean` and `toolPaths(): ToolPaths | null` in `tests/helpers/tools.ts` with `ToolPaths = { vspipe: string; svt: string; opusenc: string }`.

- [ ] **Step 1: Initialise the repo and package**

Run: `cd ~/encoding-tools && git init && npm init -y`, then set in `package.json`: `"type": "module"`, `"license": "LGPL-3.0-or-later"`, `"engines": { "node": ">=22" }`, scripts `test: vitest run`, `typecheck: tsc --noEmit`, `cli: tsx src/cli.ts`; devDependencies `typescript@^5.7`, `vitest@^3`, `tsx@^4`, `@types/node@^22`. `.gitignore`: `node_modules`, `dist`, `.cache`, `*.tsbuildinfo`, `test-results`.

- [ ] **Step 2: Fetch the license texts**

Run: `curl -fsSL https://www.gnu.org/licenses/lgpl-3.0.txt -o LICENSE && curl -fsSL https://www.gnu.org/licenses/gpl-3.0.txt -o COPYING`
Expected: both files start with the GNU license title line.

- [ ] **Step 3: Write `tsconfig.json` and `vitest.config.ts` with the alias**

`tsconfig.json`: `strict`, `target ES2022`, `module ESNext`, `moduleResolution bundler`, `allowImportingTsExtensions false`, `noEmit`, `paths: { "seikou/engine/*": ["../seikou/src/engine/*"] }`, `include: ["src", "tests", "scripts"]`. `vitest.config.ts`: `resolve.alias` mapping `seikou/engine` to `path.resolve('../seikou/src/engine')`, `test.include: ['tests/**/*.test.ts']`, `test.testTimeout: 120000`.

- [ ] **Step 4: Copy the fixture disc**

Run: `cp -R ../seikou/fixtures/synthetic/disc1 fixtures/disc1 && find fixtures/disc1 -type f | wc -l`
Expected: `7`.

- [ ] **Step 5: Write the failing smoke test**

```ts
// tests/smoke.test.ts
import { readFileSync } from 'node:fs';
import { parseMpls } from 'seikou/engine/bdmv/mpls-parser';
it('parses the fixture playlist through the seikou alias', () => {
  const m = parseMpls(new Uint8Array(readFileSync('fixtures/disc1/BDMV/PLAYLIST/00000.mpls')));
  expect(m.playItems.map((p) => p.clipId)).toEqual(['00001', '00002']);
  expect(m.marks).toHaveLength(4);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/smoke.test.ts`
Expected: FAIL, cannot resolve `seikou/engine/bdmv/mpls-parser` (alias missing or deps not installed).

- [ ] **Step 7: Install dependencies and write `tests/helpers/tools.ts` and `src/index.ts`**

`tools.ts` exports `toolPaths()` (resolves each binary with a PATH search, honouring env overrides `ENCODING_TOOLS_VSPIPE`, `ENCODING_TOOLS_SVT`, `ENCODING_TOOLS_OPUSENC`; `null` when one is missing) and `haveTools` (all three found, and BestSource loads: write a temp script containing `import vapoursynth as vs`, `vs.core.bs`, `vs.core.std.BlankClip().set_output()` and run `vspipe --info <script> -`; exit 0 means the plugin loaded). `src/index.ts` exports nothing yet but carries the SPDX header.

- [ ] **Step 8: Run the smoke test and verify it passes**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS.

- [ ] **Step 9: Write `README.md`**

Sections: what this is (one paragraph from the spec §1), requirements (`brew install vapoursynth vapoursynth-bestsource svt-av1 opus-tools`; Node 22), the temporary Seikou alias and why, `npm test`, license.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "chore: scaffold repo, seikou alias, fixture disc"
```

### Task 2: Playlist model

**Files:**
- Create: `src/disc/playlist.ts`
- Test: `tests/disc/playlist.test.ts`

**Interfaces:**
- Consumes: `parseMpls`, `Mpls`, `PlayItem`, `MarkType` from `seikou/engine/bdmv/mpls-parser`; `parseClpi`, `Clpi` from `seikou/engine/bdmv/clpi-parser`.
- Produces:
  ```ts
  export interface PlaylistItem { index: number; clipId: string; m2tsPath: string; clpi: Clpi; inTime45: number; outTime45: number; videoPid: number; audioPids: number[]; connectionCondition: number }
  export interface Chapter { index: number /* 1-based */; itemIndex: number; time45: number /* clip time */; start45: number /* playlist time, 0 at the first item's inTime */ }
  export interface Playlist { id: string; discDir: string; items: PlaylistItem[]; chapters: Chapter[]; duration45: number }
  export function bdmvRoot(dir: string): string  // accepts the disc folder or its BDMV folder; returns the BDMV folder
  export function listPlaylists(discDir: string): Promise<{ id: string; duration45: number; clipIds: string[] }[]>
  export function loadPlaylist(discDir: string, playlistId: string): Promise<Playlist>
  ```
  `start45` of an item = sum of `(outTime45 - inTime45)` of the items before it. Chapters: marks with `type === MarkType.ENTRY` and `inTime45 <= time45 < outTime45` of their item, sorted by `(itemIndex, time45)`, duplicates (same item and time) collapsed; a chapter at the playlist start is added if no mark lands there. `videoPid` = first main-path video entry of the item's STN; `audioPids` = main-path audio entries in STN order.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/disc/playlist.test.ts
const disc = 'fixtures/disc1';
it('loads playlist 00000 with two items and four chapters', async () => {
  const p = await loadPlaylist(disc, '00000');
  expect(p.items.map((i) => [i.clipId, i.inTime45, i.outTime45, i.videoPid, i.audioPids])).toEqual([
    ['00001', 450000, 630000, 4113, [4352]], ['00002', 450000, 630000, 4113, [4352]]]);
  expect(p.duration45).toBe(360000);
  expect(p.chapters.map((c) => [c.index, c.itemIndex, c.time45, c.start45])).toEqual([
    [1, 0, 450000, 0], [2, 0, 540000, 90000], [3, 1, 450000, 180000], [4, 1, 540000, 270000]]);
  expect(p.items[0].m2tsPath).toMatch(/BDMV\/STREAM\/00001\.m2ts$/);
});
it('accepts the BDMV folder itself and lists playlists', async () => {
  expect(bdmvRoot('fixtures/disc1/BDMV')).toBe(bdmvRoot('fixtures/disc1'));
  const list = await listPlaylists(disc);
  expect(list.map((l) => [l.id, l.duration45, l.clipIds])).toEqual([['00000', 360000, ['00001', '00002']], ['00001', 180000, ['00002']]]);
});
it('ignores link marks and marks outside the item', () => {
  // build a Playlist from a hand-made Mpls object via the exported pure helper chaptersFromMarks(mpls, items)
  const items = [{ index: 0, inTime45: 1000, outTime45: 5000 }] as PlaylistItem[];
  const marks = [
    { type: 2, playItemRef: 0, time: 2000 }, { type: 1, playItemRef: 0, time: 9000 },
    { type: 1, playItemRef: 0, time: 3000 }, { type: 1, playItemRef: 0, time: 3000 }];
  expect(chaptersFromMarks(marks as PlayListMark[], items).map((c) => [c.time45, c.start45])).toEqual([[1000, 0], [3000, 2000]]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/disc/playlist.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/disc/playlist.ts`**

Also export `chaptersFromMarks(marks: readonly PlayListMark[], items: readonly PlaylistItem[]): Chapter[]` (pure, used by the third test). Read files with `fs/promises`; CLPI path `BDMV/CLIPINF/<clipId>.clpi`, stream `BDMV/STREAM/<clipId>.m2ts`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run tests/disc/playlist.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/disc/playlist.ts tests/disc/playlist.test.ts && git commit -m "feat(disc): playlist model with chapters from entry marks"
```

### Task 3: Clip probe (first timestamps, frame rate, sample rate)

**Files:**
- Create: `src/disc/probe.ts`, `src/disc/stream-codes.ts`
- Test: `tests/disc/probe.test.ts`, `tests/disc/stream-codes.test.ts`

**Interfaces:**
- Consumes: `PlaylistItem` (Task 2); `parseSourcePacket` from `seikou/engine/demux/ts-packet`; `PesAssembler`, `PesPacket` from `seikou/engine/demux/pes-assembler`; `ProgramStream` from `seikou/engine/bdmv/clpi-parser`.
- Produces:
  ```ts
  // stream-codes.ts (Blu-ray CLPI/STN code tables)
  export function videoRate(code: number): { fpsNum: number; fpsDen: number }   // 1→24000/1001, 2→24/1, 3→25/1, 4→30000/1001, 6→50/1, 7→60000/1001; else throws
  export function videoFormat(code: number): { width: number; height: number; interlaced: boolean } // 1→720x480 i, 2→720x576 i, 3→720x480 p, 4→1920x1080 i, 5→720x576 p, 6→1920x1080 p, 7→1280x720 p, 8→3840x2160 p
  export function audioRate(code: number): number   // 1→48000, 4→96000, 5→192000, 12→48000, 14→48000
  export function audioChannels(formatCode: number): number // 1→1, 3→2, 6→6, 12→6
  // probe.ts
  export interface VideoProbe { pid: number; firstPts90: number; fpsNum: number; fpsDen: number; width: number; height: number; interlaced: boolean; codingType: number }
  export interface AudioProbe { pid: number; firstPts90: number; sampleRate: number; channels: number; codingType: number }
  export interface ClipProbe { clipId: string; video: VideoProbe; audio: AudioProbe[] }
  export function probeClip(item: PlaylistItem): Promise<ClipProbe>
  ```
  `probeClip` streams the m2ts in 192-byte source packets through `parseSourcePacket` and a `PesAssembler`, records the first `pts` seen per PID of interest, and stops reading once every PID has one (or at EOF, which throws `ProbeError` naming the missing PID). Codes come from the CLPI program stream entry for each PID.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/disc/stream-codes.test.ts
it('maps Blu-ray rate and format codes', () => {
  expect(videoRate(1)).toEqual({ fpsNum: 24000, fpsDen: 1001 });
  expect(videoFormat(6)).toEqual({ width: 1920, height: 1080, interlaced: false });
  expect(audioRate(1)).toBe(48000);
  expect(audioChannels(3)).toBe(2);
  expect(() => videoRate(5)).toThrow();
});
// tests/disc/probe.test.ts
it('finds first timestamps and stream parameters of clip 00001', async () => {
  const p = await loadPlaylist('fixtures/disc1', '00000');
  const probe = await probeClip(p.items[0]);
  expect(probe.video).toEqual({ pid: 4113, firstPts90: 900000, fpsNum: 24000, fpsDen: 1001, width: 1920, height: 1080, interlaced: false, codingType: 27 });
  expect(probe.audio).toEqual([{ pid: 4352, firstPts90: 900000, sampleRate: 48000, channels: 2, codingType: 128 }]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/disc`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `stream-codes.ts` and `probe.ts`**

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run tests/disc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/disc tests/disc && git commit -m "feat(disc): clip probe for first PTS, frame rate and sample rate"
```

### Task 4: Episode plan

**Files:**
- Create: `src/plan/episodes.ts`, `src/plan/timing.ts`
- Test: `tests/plan/episodes.test.ts`, `tests/plan/timing.test.ts`

**Interfaces:**
- Consumes: `Playlist`, `PlaylistItem`, `Chapter` (Task 2); `ClipProbe` (Task 3).
- Produces:
  ```ts
  // timing.ts
  export function frameAt(t45: number, video: { firstPts90: number; fpsNum: number; fpsDen: number }): number   // Math.round(((t45 * 2 - firstPts90) * fpsNum) / (fpsDen * 90000))
  export function sampleAt(t45: number, audio: { firstPts90: number; sampleRate: number }): number           // Math.round(((t45 * 2 - firstPts90) * sampleRate) / 90000)
  export function frameDurationNs(video: { fpsNum: number; fpsDen: number }): bigint                          // BigInt(fpsDen) * 1_000_000_000n / BigInt(fpsNum) rounded to nearest
  export function framesToNs(frames: number, video): bigint                                                    // (BigInt(frames) * BigInt(fpsDen) * 1_000_000_000n + BigInt(fpsNum) / 2n) / BigInt(fpsNum)
  // episodes.ts
  export interface EpisodeSpec { from: number; to: number | null }   // 1-based inclusive chapter indices; null = last chapter
  export class EpisodeSpecError extends Error {}
  export function parseEpisodeSpec(text: string, chapterCount: number): EpisodeSpec[]  // "1-4,5-8,9-" ; also "3" means "3-3"
  export interface Segment { item: PlaylistItem; videoFrames: [number, number]; audioSamples: [number, number]; audioOffsetNs: bigint }
  export interface EpisodeChapter { title: string; startNs: bigint }
  export interface EpisodePlan { index: number; segments: Segment[]; chapters: EpisodeChapter[]; frameCount: number; durationNs: bigint; video: VideoProbe; audio: AudioProbe }
  export function planEpisodes(playlist: Playlist, probes: Map<string, ClipProbe>, specs: EpisodeSpec[], audioPid: number): EpisodePlan[]
  ```
  An episode runs from its first chapter's `start45` to the next episode's first chapter (or `playlist.duration45`). For each item overlapped by that range, the segment's clip-time bounds are `max(itemIn, episodeStart - itemStart45 + itemIn)` and `min(itemOut, ...)`; `videoFrames = [frameAt(lo), frameAt(hi))` clamped to `[0, frameAt(itemOut))`, `audioSamples` likewise with `sampleAt`, clamped to `≥ 0`. `audioOffsetNs` = `max(0, audio.firstPts90 - lo*2) * 1_000_000_000n / 90000n` for the first segment, else `0n`. Chapter `startNs` for chapter `c` in the episode = `framesToNs(framesBefore(c), video)` where `framesBefore` counts frames of earlier segments plus `frameAt(c.time45) - segment.videoFrames[0]` within its segment (so chapters sit on frame boundaries). Titles `Chapter 1..n` per episode. `frameCount` = sum of segment frame spans; `durationNs = framesToNs(frameCount)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/plan/timing.test.ts
const v = { firstPts90: 900000, fpsNum: 24000, fpsDen: 1001 };
it('maps 45 kHz times to frames and samples', () => {
  expect(frameAt(450000, v)).toBe(0);
  expect(frameAt(630000, v)).toBe(96);
  expect(frameAt(451000, v)).toBe(1);          // 2000 ticks at 90k = 0.53 frames → rounds to 1
  expect(sampleAt(540000, { firstPts90: 900000, sampleRate: 48000 })).toBe(96000);
  expect(framesToNs(96, v)).toBe(4004000000n);
});
// tests/plan/episodes.test.ts
it('parses episode specs and rejects bad ones', () => {
  expect(parseEpisodeSpec('1-2,3-4', 4)).toEqual([{ from: 1, to: 2 }, { from: 3, to: 4 }]);
  expect(parseEpisodeSpec('1-3,4-', 4)).toEqual([{ from: 1, to: 3 }, { from: 4, to: null }]);
  expect(parseEpisodeSpec('2', 4)).toEqual([{ from: 2, to: 2 }]);
  for (const bad of ['3-2', '1-2,2-3', '1-5', '', '0-1', 'a-b']) expect(() => parseEpisodeSpec(bad, 4)).toThrow(EpisodeSpecError);
});
it('plans two episodes of one clip each on disc1', async () => {
  const p = await loadPlaylist('fixtures/disc1', '00000');
  const probes = new Map([[ '00001', await probeClip(p.items[0]) ], [ '00002', await probeClip(p.items[1]) ]]);
  const plans = planEpisodes(p, probes, parseEpisodeSpec('1-2,3-4', 4), 4352);
  expect(plans.map((e) => e.segments.map((s) => [s.item.clipId, s.videoFrames, s.audioSamples, s.audioOffsetNs])))
    .toEqual([[['00001', [0, 96], [0, 192000], 0n]], [['00002', [0, 96], [0, 192000], 0n]]]);
  expect(plans[0].chapters).toEqual([{ title: 'Chapter 1', startNs: 0n }, { title: 'Chapter 2', startNs: 2002000000n }]);
  expect(plans[0].frameCount).toBe(96);
  expect(plans[0].durationNs).toBe(4004000000n);
});
it('spans two clips when an episode crosses an item boundary', async () => {
  // spec '1-3,4-' → episode 1 = item 0 whole + item 1 frames [0,48); episode 2 = item 1 frames [48,96)
  const plans = planEpisodes(p, probes, parseEpisodeSpec('1-3,4-', 4), 4352);
  expect(plans[0].segments.map((s) => [s.item.clipId, s.videoFrames])).toEqual([['00001', [0, 96]], ['00002', [0, 48]]]);
  expect(plans[1].segments.map((s) => [s.item.clipId, s.videoFrames, s.audioSamples])).toEqual([['00002', [48, 96], [96000, 192000]]]);
  expect(plans[0].chapters.map((c) => c.startNs)).toEqual([0n, 2002000000n, 4004000000n]);
});
it('audio starting 20 ms after video becomes an audio offset, not a trim', () => {
  // synthetic probe: audio firstPts90 = 900000 + 1800
  const late = { ...probe00001, audio: [{ ...probe00001.audio[0], firstPts90: 901800 }] };
  const [ep] = planEpisodes(p, new Map([['00001', late], ['00002', probe00002]]), parseEpisodeSpec('1-2', 4), 4352);
  expect(ep.segments[0].audioSamples).toEqual([0, 191040]);
  expect(ep.segments[0].audioOffsetNs).toBe(20000000n);
  const early = { ...probe00001, audio: [{ ...probe00001.audio[0], firstPts90: 898200 }] };
  const [ep2] = planEpisodes(p, new Map([['00001', early], ['00002', probe00002]]), parseEpisodeSpec('1-2', 4), 4352);
  expect(ep2.segments[0].audioSamples).toEqual([960, 192960]);
  expect(ep2.segments[0].audioOffsetNs).toBe(0n);
});
it('rounds a mark to the nearest frame', () => {
  // a Playlist with one item and a second chapter at time45 = 451000 (0.53 frames in): chapter startNs = framesToNs(1)
  expect(plansFor('1-', [450000, 451000])[0].chapters[1].startNs).toBe(41708333n);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/plan`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `timing.ts` and `episodes.ts`**

`plansFor` in the test is a local helper building a `Playlist` with one item (`inTime45 450000`, `outTime45 630000`) and the given chapter times; write it in the test file.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run tests/plan`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/plan tests/plan && git commit -m "feat(plan): episode plan from chapter ranges"
```

### Task 5: VapourSynth script generation

**Files:**
- Create: `src/pipeline/vpy.ts`
- Test: `tests/pipeline/vpy.test.ts`

**Interfaces:**
- Consumes: `EpisodePlan`, `Segment` (Task 4).
- Produces:
  ```ts
  export interface VpyOptions { cacheDir: string }
  export function buildVideoScript(plan: EpisodePlan, opts: VpyOptions): string
  export function buildAudioScript(plan: EpisodePlan, opts: VpyOptions): string
  ```
  Video script, exactly this shape (paths through Python raw strings, `repr`-escaped):
  ```python
  import vapoursynth as vs
  core = vs.core
  parts = []
  c = core.bs.VideoSource(r'<m2tsPath>', cachepath=r'<cacheDir>')
  parts.append(c[<start>:<end>])
  # one c = ... / parts.append per segment
  clip = parts[0]
  for p in parts[1:]:
      clip = clip + p
  clip = core.resize.Point(clip, format=vs.YUV420P10)
  clip.set_output(0)
  ```
  Audio script: same structure with `core.bs.AudioSource(r'<m2tsPath>', track=-1, cachepath=r'<cacheDir>')`, slices in samples, no format conversion, `clip.set_output(0)`. (M1 takes the first audio track; PID-to-track mapping is M2.)

- [ ] **Step 1: Write the failing tests**

```ts
it('emits the video script for a two-segment episode', () => {
  const s = buildVideoScript(planWithSegments([['/d/00001.m2ts', 0, 96], ['/d/00002.m2ts', 0, 48]]), { cacheDir: '/c' });
  expect(s).toBe([
    'import vapoursynth as vs', 'core = vs.core', 'parts = []',
    "c = core.bs.VideoSource(r'/d/00001.m2ts', cachepath=r'/c')", 'parts.append(c[0:96])',
    "c = core.bs.VideoSource(r'/d/00002.m2ts', cachepath=r'/c')", 'parts.append(c[0:48])',
    'clip = parts[0]', 'for p in parts[1:]:', '    clip = clip + p',
    'clip = core.resize.Point(clip, format=vs.YUV420P10)', 'clip.set_output(0)', ''].join('\n'));
});
it('emits the audio script with sample slices', () => {
  expect(buildAudioScript(planWithSegments([['/d/00001.m2ts', [0, 96], [0, 192000]]]), { cacheDir: '/c' }))
    .toContain("c = core.bs.AudioSource(r'/d/00001.m2ts', track=-1, cachepath=r'/c')\nparts.append(c[0:192000])");
});
describe.skipIf(!haveTools)('with vspipe', () => {
  it('reports 96 frames of YUV420P10 and 192000 samples for disc1 episode 1', async () => {
    // write both scripts to a temp dir, run `vspipe --info <script> -`
    expect(videoInfo).toMatch(/Frames: 96\b/); expect(videoInfo).toMatch(/Format Name: YUV420P10/);
    expect(audioInfo).toMatch(/Samples: 192000\b/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/pipeline/vpy.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/pipeline/vpy.ts`**

Escape single quotes and backslashes in paths for Python raw strings (reject paths containing `'`).

- [ ] **Step 4: Run the tests and verify they pass; check the index location**

Run: `npx vitest run tests/pipeline/vpy.test.ts`
Expected: PASS. Then: `ls .cache` after the vspipe test shows BestSource index files there and `ls fixtures/disc1/BDMV/STREAM` shows only the two `.m2ts`; if an index landed beside the disc, add the `cachemode` argument BestSource documents for "always use cachepath" to both `VideoSource` and `AudioSource` calls and update the snapshot test.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/vpy.ts tests/pipeline/vpy.test.ts && git commit -m "feat(pipeline): VapourSynth script generation for episode ranges"
```

### Task 6: Process chains

**Files:**
- Create: `src/pipeline/chain.ts`
- Modify: `tests/helpers/tools.ts` (import `ToolPaths` from `src/pipeline/chain.ts` instead of declaring it)
- Create: `tests/fake-bin/vspipe`, `tests/fake-bin/SvtAv1EncApp`, `tests/fake-bin/opusenc` (executable shell scripts)
- Test: `tests/pipeline/chain.test.ts`

**Interfaces:**
- Consumes: `ToolPaths` (Task 1 helper shape, re-declared in `chain.ts` as the canonical type).
- Produces:
  ```ts
  export interface ToolPaths { vspipe: string; svt: string; opusenc: string }
  export class ChainError extends Error { constructor(public tool: string, public code: number | null, public signal: NodeJS.Signals | null, public stderrTail: string) }
  export interface Chain { stream: Readable; done: Promise<void>; abort(reason: Error): void }
  export function videoChain(tools: ToolPaths, scriptPath: string, svtArgs: string[]): Chain   // vspipe <script> - -c y4m | SvtAv1EncApp -i stdin -b stdout <svtArgs>
  export function audioChain(tools: ToolPaths, scriptPath: string, opusArgs: string[]): Chain  // vspipe <script> - -c wav | opusenc <opusArgs> - -
  ```
  `stream` is the last process's stdout. `done` resolves when both processes exited 0 and `stream` ended; it rejects with `ChainError` for the first process that exits non-zero or on signal, after killing the other with `SIGTERM`; `stderrTail` keeps the last 4096 bytes of that process's stderr. `abort(reason)` kills both and rejects `done` with `reason`. A failure of the first process after the second has already exited 0 is still an error.

- [ ] **Step 1: Write the fake binaries and the failing tests**

`tests/fake-bin/vspipe`: `#!/bin/sh` that writes the script file (`$1`) to stdout, exits `${FAKE_VSPIPE_EXIT:-0}`. `tests/fake-bin/SvtAv1EncApp` and `opusenc`: copy stdin to stdout (`cat`), print `fake stderr line` to stderr, exit `${FAKE_ENC_EXIT:-0}`; when `FAKE_SLEEP` is set, `sleep "$FAKE_SLEEP"` before reading. `chmod +x` all three and commit them executable.

```ts
const fake = { vspipe: 'tests/fake-bin/vspipe', svt: 'tests/fake-bin/SvtAv1EncApp', opusenc: 'tests/fake-bin/opusenc' };
it('pipes vspipe output through the encoder', async () => {
  const c = videoChain(fake, 'tests/fixtures/hello.vpy', []);
  expect(Buffer.concat(await collect(c.stream)).toString()).toBe(readFileSync('tests/fixtures/hello.vpy', 'utf8'));
  await c.done;
});
it('rejects with the failing tool, code and stderr', async () => {
  process.env.FAKE_ENC_EXIT = '3';
  const c = videoChain(fake, 'tests/fixtures/hello.vpy', []);
  await expect(c.done).rejects.toMatchObject({ tool: 'SvtAv1EncApp', code: 3, stderrTail: expect.stringContaining('fake stderr line') });
});
it('rejects when vspipe fails even if the encoder exited 0', async () => {
  process.env.FAKE_VSPIPE_EXIT = '2';
  await expect(videoChain(fake, 'tests/fixtures/hello.vpy', []).done).rejects.toMatchObject({ tool: 'vspipe', code: 2 });
});
it('abort kills both processes', async () => {
  process.env.FAKE_SLEEP = '5';
  const c = audioChain(fake, 'tests/fixtures/hello.vpy', []);
  c.abort(new Error('user cancel'));
  await expect(c.done).rejects.toThrow('user cancel');   // and resolves within 1 s
});
describe.skipIf(!haveTools)('real tools', () => {
  it('produces an IVF stream for disc1 episode 1', async () => {
    const c = videoChain(toolPaths()!, videoScriptPath, ['--preset', '8', '--crf', '40', '--progress', '0']);
    const bytes = Buffer.concat(await collect(c.stream)); await c.done;
    expect(bytes.subarray(0, 4).toString()).toBe('DKIF');
  });
});
```
`tests/fixtures/hello.vpy` is any short text file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/pipeline/chain.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/pipeline/chain.ts`**

Use `child_process.spawn` with `stdio: ['ignore'|'pipe', 'pipe', 'pipe']`, pipe the first stdout into the second stdin, handle `EPIPE` on the first process when the second dies first, and settle `done` once both `exit` events and the stream `end` have fired.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run tests/pipeline/chain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/chain.ts tests/pipeline/chain.test.ts tests/fake-bin tests/fixtures/hello.vpy && git commit -m "feat(pipeline): vspipe→encoder process chains with failure propagation"
```

### Task 7: IVF reader and AV1 keyframe and av1C parsing

**Files:**
- Create: `src/mux/ivf.ts`, `src/mux/av1.ts`, `src/mux/bit-reader.ts`, `scripts/make-av1-fixture.ts`
- Create: `fixtures/small.ivf` (generated once by the script; committed)
- Test: `tests/mux/ivf.test.ts`, `tests/mux/av1.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // bit-reader.ts
  export class BitReader { constructor(bytes: Uint8Array, bitOffset?: number); f(n: number): number; uvlc(): number; leb128(): number; bitPosition: number }
  // av1.ts
  export interface Obu { type: number; header: Uint8Array; payload: Uint8Array }   // header includes the size field
  export const ObuType = { SEQUENCE_HEADER: 1, TEMPORAL_DELIMITER: 2, FRAME_HEADER: 3, TILE_GROUP: 4, METADATA: 5, FRAME: 6, REDUNDANT_FRAME_HEADER: 7, PADDING: 15 } as const;
  export function splitObus(temporalUnit: Uint8Array): Obu[]
  export interface SequenceHeaderInfo { seqProfile: number; seqLevelIdx0: number; seqTier0: number; highBitdepth: boolean; twelveBit: boolean; monoChrome: boolean; subsamplingX: number; subsamplingY: number; chromaSamplePosition: number; reducedStillPictureHeader: boolean }
  export function parseSequenceHeader(payload: Uint8Array): SequenceHeaderInfo   // AV1 spec §5.5.1–5.5.2 up to and including color_config
  export function isKeyframe(temporalUnit: Uint8Array, seq: SequenceHeaderInfo): boolean
  export function buildAv1C(seqObu: Obu, seq: SequenceHeaderInfo): Uint8Array   // 4 bytes + the whole sequence header OBU (header and payload)
  // ivf.ts
  export interface IvfHeader { fourcc: string; width: number; height: number; fpsNum: number; fpsDen: number; frameCount: number }
  export interface Av1Packet { index: number; data: Uint8Array; keyframe: boolean }
  export interface IvfStream { header: IvfHeader; packets: AsyncIterable<Av1Packet>; sequenceHeader: Promise<{ obu: Obu; info: SequenceHeaderInfo; av1C: Uint8Array }> }
  export function readIvf(stream: Readable): Promise<IvfStream>
  ```
  `isKeyframe`: find the first OBU of type FRAME_HEADER or FRAME in the temporal unit; if `seq.reducedStillPictureHeader` it is a keyframe; else read `show_existing_frame = f(1)`; if 1 return false; `frame_type = f(2)`; return `frame_type === 0`. `buildAv1C` bytes: `0x81`; `(seqProfile << 5) | seqLevelIdx0`; `(seqTier0 << 7) | (highBitdepth ? 0x40 : 0) | (twelveBit ? 0x20 : 0) | (monoChrome ? 0x10 : 0) | (subsamplingX << 3) | (subsamplingY << 2) | chromaSamplePosition`; `0x00`; then `seqObu.header` and `seqObu.payload`. `sequenceHeader` resolves from the first packet that contains a SEQUENCE_HEADER OBU (SVT writes one in the first temporal unit). IVF: 32-byte file header (`DKIF`, version u16, header size u16, fourcc, width u16, height u16, fps den u32, fps num u32, frame count u32, unused u32), then per frame u32 size + u64 pts + data; parse incrementally from a Node `Readable` without buffering the whole stream.

- [ ] **Step 1: Write `scripts/make-av1-fixture.ts` and generate the fixture**

The script writes a 64x64, 10-frame, `C420p10` y4m of flat grey (all planes mid value) to a temp file and runs `SvtAv1EncApp -i <y4m> -b fixtures/small.ivf --preset 8 --crf 30 --keyint 4 --progress 0`.
Run: `npx tsx scripts/make-av1-fixture.ts && ls -la fixtures/small.ivf`
Expected: a file of a few KB.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/mux/ivf.test.ts
it('reads header, packets and keyframes of small.ivf', async () => {
  const ivf = await readIvf(createReadStream('fixtures/small.ivf'));
  expect(ivf.header).toMatchObject({ fourcc: 'AV01', width: 64, height: 64 });
  const packets = await collect(ivf.packets);
  expect(packets.map((p) => p.index)).toEqual([0,1,2,3,4,5,6,7,8,9]);
  expect(packets.filter((p) => p.keyframe).map((p) => p.index)).toEqual([0, 4, 8]);
});
// tests/mux/av1.test.ts
it('parses the sequence header and builds av1C', async () => {
  const { info, av1C } = await (await readIvf(createReadStream('fixtures/small.ivf'))).sequenceHeader;
  expect(info).toMatchObject({ seqProfile: 0, highBitdepth: true, twelveBit: false, monoChrome: false, subsamplingX: 1, subsamplingY: 1 });
  expect(av1C[0]).toBe(0x81);
  expect(av1C[1]).toBe(info.seqLevelIdx0);                  // profile 0 in the top bits
  expect(av1C[2]).toBe((info.seqTier0 << 7) | 0x40 | 0x08 | 0x04 | info.chromaSamplePosition);
  expect(av1C[3]).toBe(0);
  expect(av1C.length).toBeGreaterThan(8);
});
it('bit reader: f, uvlc, leb128', () => {
  expect(new BitReader(new Uint8Array([0b10100000])).f(3)).toBe(5);
  expect(new BitReader(new Uint8Array([0b00100000])).uvlc()).toBe(3);   // 2 leading zeros, then 1, then bits 00 → (1<<2)-1+0 = 3
  expect(new BitReader(new Uint8Array([0xe5, 0x8e, 0x26])).leb128()).toBe(624485);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/mux`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `bit-reader.ts`, `av1.ts`, `ivf.ts`**

`parseSequenceHeader` follows the spec text at https://aomediacodec.github.io/av1-spec/av1-spec.pdf §5.5.1 (`sequence_header_obu`), §5.5.2 (`color_config`), including `timing_info`, `decoder_model_info`, the operating points loop and `frame_id_numbers_present_flag`; stop after `color_config` (`separate_uv_delta_q` and `film_grain_params_present` are not needed).

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run tests/mux`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mux scripts/make-av1-fixture.ts fixtures/small.ivf tests/mux && git commit -m "feat(mux): IVF reader with AV1 keyframe detection and av1C"
```

### Task 8: Ogg Opus reader

**Files:**
- Create: `src/mux/ogg.ts`, `scripts/make-opus-fixture.ts`
- Create: `fixtures/tone.opus` (generated once; committed)
- Test: `tests/mux/ogg.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OpusHead { channels: number; preSkip: number; inputSampleRate: number; outputGain: number; mappingFamily: number; raw: Uint8Array }
  export interface OpusPacket { data: Uint8Array; pts48: number; durationSamples: number }   // pts48 cumulative from 0 over packets, pre-skip not subtracted
  export interface OggOpusStream { head: OpusHead; packets: AsyncIterable<OpusPacket>; end: Promise<{ totalSamples: number; lastGranule: number; discardPadding48: number }> }
  export function readOggOpus(stream: Readable): Promise<OggOpusStream>
  export function opusPacketDuration(packet: Uint8Array): number   // samples at 48 kHz
  ```
  `opusPacketDuration`: TOC byte `config = toc >> 3`, `code = toc & 3`. Frame size by config: 0–11 (SILK) `[480, 960, 1920, 2880][config & 3]`; 12–15 (hybrid) `[480, 960][config & 1]`; 16–31 (CELT) `[120, 240, 480, 960][config & 3]`. Frames: code 0 → 1, code 1 or 2 → 2, code 3 → `packet[1] & 0x3f`. Duration = frames × frame size. Ogg: pages (`OggS`, version, header type, granule u64, serial, sequence, checksum, segment count, lacing table), packets continue across pages with 255-byte lacing. First packet `OpusHead` (channels at byte 9, pre-skip u16 LE at 10, input rate u32 LE at 12, gain i16 at 16, mapping family at 18), second `OpusTags` (skipped). `discardPadding48 = totalSamples - lastGranule` where `totalSamples` is the sum of packet durations and `lastGranule` the granule position of the last page (RFC 7845 §4.5: the final granule position includes pre-skip and excludes trailing padding).

- [ ] **Step 1: Write `scripts/make-opus-fixture.ts` and generate the fixture**

The script writes 0.5 s of a 440 Hz stereo 16-bit 48 kHz WAV to a temp file and runs `opusenc --bitrate 64 <wav> fixtures/tone.opus`.
Run: `npx tsx scripts/make-opus-fixture.ts && ls -la fixtures/tone.opus`
Expected: a file of a few KB.

- [ ] **Step 2: Write the failing tests**

```ts
it('computes packet durations from the TOC byte', () => {
  expect(opusPacketDuration(new Uint8Array([0b11111000]))).toBe(960);        // CELT config 31, code 0: 20 ms
  expect(opusPacketDuration(new Uint8Array([0b00000001]))).toBe(960);        // SILK config 0, code 1: two 10 ms frames
  expect(opusPacketDuration(new Uint8Array([0b01100011, 0x03]))).toBe(1440); // config 12 (hybrid 10 ms) code 3, three frames
});
it('reads tone.opus: head, packets, end trimming', async () => {
  const ogg = await readOggOpus(createReadStream('fixtures/tone.opus'));
  expect(ogg.head.channels).toBe(2);
  expect(ogg.head.preSkip).toBeGreaterThan(0);
  const packets = await collect(ogg.packets);
  expect(packets.every((p) => p.durationSamples === 960)).toBe(true);
  expect(packets[1].pts48).toBe(960);
  const end = await ogg.end;
  expect(end.lastGranule - ogg.head.preSkip).toBe(24000);
  expect(end.discardPadding48).toBeGreaterThanOrEqual(0);
  expect(end.discardPadding48).toBeLessThan(960);
  expect(end.totalSamples).toBe(packets.length * 960);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/mux/ogg.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/mux/ogg.ts`**

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run tests/mux/ogg.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mux/ogg.ts scripts/make-opus-fixture.ts fixtures/tone.opus tests/mux/ogg.test.ts && git commit -m "feat(mux): Ogg Opus reader with pre-skip and end trimming"
```

### Task 9: Matroska writer

**Files:**
- Create: `src/mux/ebml.ts`, `src/mux/mkv-ids.ts`, `src/mux/mkv-writer.ts`
- Create: `tests/helpers/ebml-reader.ts`
- Test: `tests/mux/ebml.test.ts`, `tests/mux/mkv-writer.test.ts`

**Interfaces:**
- Consumes: `Av1Packet` (Task 7), `OpusPacket` (Task 8).
- Produces:
  ```ts
  // ebml.ts
  export function vint(n: number | bigint): Uint8Array          // shortest EBML size encoding, 1–8 bytes; vint(8n) === [0x88]
  export function vintFixed8(n: number | bigint): Uint8Array    // 8-byte size, for patching
  export function uint(id: number, v: number | bigint): Uint8Array
  export function float64(id: number, v: number): Uint8Array
  export function ascii(id: number, s: string): Uint8Array
  export function utf8(id: number, s: string): Uint8Array
  export function binary(id: number, b: Uint8Array): Uint8Array
  export function master(id: number, children: Uint8Array[]): Uint8Array
  export function voidElement(size: number): Uint8Array         // total size including id and vint
  // mkv-ids.ts: the element ids used, as `export const Id = { EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac, Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741, Title: 0x7ba9, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, CodecDelay: 0x56aa, SeekPreRoll: 0x56bb, DefaultDuration: 0x23e383, Language: 0x22b59c, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f, Chapters: 0x1043a770, EditionEntry: 0x45b9, EditionUID: 0x45bc, EditionFlagDefault: 0x45db, ChapterAtom: 0xb6, ChapterUID: 0x73c4, ChapterTimeStart: 0x91, ChapterFlagEnabled: 0x4598, ChapterDisplay: 0x80, ChapString: 0x85, ChapLanguage: 0x437c, Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, DiscardPadding: 0x75a2, Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1, Void: 0xec }`
  // mkv-writer.ts
  export interface VideoTrackInfo { width: number; height: number; fpsNum: number; fpsDen: number; codecPrivate: Uint8Array }
  export interface AudioTrackInfo { channels: number; sampleRate: number; codecPrivate: Uint8Array; codecDelayNs: bigint; seekPreRollNs: bigint; startOffsetNs: bigint; language: string }
  export interface MkvChapter { title: string; startNs: bigint }
  export interface MkvInput { title?: string; video: VideoTrackInfo; audio: AudioTrackInfo; videoPackets: AsyncIterable<Av1Packet>; audioPackets: AsyncIterable<OpusPacket>; audioEnd: Promise<{ discardPadding48: number }>; chapters: MkvChapter[] }
  export interface MkvResult { durationNs: bigint; videoPackets: number; audioPackets: number; clusters: number }
  export function writeMkv(path: string, input: MkvInput): Promise<MkvResult>
  ```
  Layout: EBML header (`EBMLVersion 1, EBMLReadVersion 1, EBMLMaxIDLength 4, EBMLMaxSizeLength 8, DocType "matroska", DocTypeVersion 4, DocTypeReadVersion 2`); `Segment` with an 8-byte size patched at the end; `SeekHead` reserved as a 160-byte Void and patched at the end with entries for Info, Tracks, Chapters, Cues; `Info` with `TimestampScale 1000000`, `Duration` as float64 placeholder patched at the end (ms), `MuxingApp`/`WritingApp` `"encoding-tools"`; `Tracks`: video `TrackNumber 1, TrackType 1, CodecID "V_AV1", CodecPrivate av1C, DefaultDuration = frameDurationNs, Video{PixelWidth, PixelHeight}`; audio `TrackNumber 2, TrackType 2, CodecID "A_OPUS", CodecPrivate OpusHead, CodecDelay, SeekPreRoll, Language, Audio{SamplingFrequency, Channels}`; `Chapters` with one `EditionEntry` (`EditionFlagDefault 1`) of `ChapterAtom`s (`ChapterTimeStart` ns, `ChapterFlagEnabled 1`, `ChapterDisplay{ChapString, ChapLanguage "und"}`); clusters: a new `Cluster` at every video keyframe (`Timestamp` = that frame's ms); blocks interleaved by timestamp (video first on ties) as `SimpleBlock` (track vint, i16 relative ms, flags `0x80` for keyframes else `0x00`); the last audio packet goes in a `BlockGroup` with `DiscardPadding` (signed, ns: `discardPadding48 * 1_000_000_000 / 48000`) when `discardPadding48 > 0`; `Cues` after the clusters with one `CuePoint` per keyframe (`CueTime` ms, `CueTrack 1`, `CueClusterPosition` relative to the first byte after the Segment size). Timestamps: video `round(index * fpsDen * 1000 / fpsNum)`; audio `round((pts48 * 1000) / 48000 + startOffsetNs / 1e6)`. Write with `fs.open` and positional `write` calls so patches go to known offsets; never hold the whole file in memory.

- [ ] **Step 1: Write the failing EBML tests**

```ts
it('encodes vints and elements', () => {
  expect([...vint(8)]).toEqual([0x88]);
  expect([...vint(127)]).toEqual([0x40, 0x7f]);
  expect([...vint(300)]).toEqual([0x41, 0x2c]);
  expect([...vintFixed8(5)]).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0x05]);
  expect([...uint(Id.TrackNumber, 1)]).toEqual([0xd7, 0x81, 0x01]);
  expect([...ascii(Id.CodecID, 'V_AV1')]).toEqual([0x86, 0x85, 0x56, 0x5f, 0x41, 0x56, 0x31]);
  expect(voidElement(10)).toHaveLength(10);
});
```

- [ ] **Step 2: Run it to verify it fails, implement `ebml.ts` and `mkv-ids.ts`, run again**

Run: `npx vitest run tests/mux/ebml.test.ts` → FAIL; implement; run → PASS.

- [ ] **Step 3: Write `tests/helpers/ebml-reader.ts` and the failing writer test**

The helper parses an MKV file into a tree `{ id, size, offset, children?, bytes? }` with masters expanded for Segment, SeekHead, Info, Tracks, TrackEntry, Video, Audio, Chapters, EditionEntry, ChapterAtom, ChapterDisplay, Cluster, BlockGroup, Cues, CuePoint, CueTrackPositions, and helpers `uintOf`, `floatOf`, `stringOf`, `find(tree, id)`, `findAll`, `segmentDataStart(tree)` (offset of the first byte after the Segment size), `firstBlockIsVideoKeyframe(cluster)` (first SimpleBlock has track 1 and flag `0x80`), `countVideoBlocks(tree)` (SimpleBlocks and Blocks with track 1).

```ts
describe('writeMkv', () => {
  it('writes AV1 + Opus with chapters, clusters at keyframes, cues and patched duration', async () => {
    const ivf = await readIvf(createReadStream('fixtures/small.ivf')); const seq = await ivf.sequenceHeader;
    const ogg = await readOggOpus(createReadStream('fixtures/tone.opus'));
    const out = join(tmpdir(), 'w.mkv');
    const r = await writeMkv(out, {
      video: { width: 64, height: 64, fpsNum: 24000, fpsDen: 1001, codecPrivate: seq.av1C },
      audio: { channels: 2, sampleRate: 48000, codecPrivate: ogg.head.raw, codecDelayNs: BigInt(ogg.head.preSkip) * 1_000_000_000n / 48000n, seekPreRollNs: 80_000_000n, startOffsetNs: 0n, language: 'und' },
      videoPackets: ivf.packets, audioPackets: ogg.packets, audioEnd: ogg.end,
      chapters: [{ title: 'Chapter 1', startNs: 0n }, { title: 'Chapter 2', startNs: 166_833_333n }] });
    expect(r).toMatchObject({ videoPackets: 10, clusters: 3 });
    const t = parseMkv(readFileSync(out));
    expect(stringOf(find(t, Id.DocType))).toBe('matroska');
    expect(findAll(t, Id.CodecID).map(stringOf)).toEqual(['V_AV1', 'A_OPUS']);
    expect(uintOf(find(t, Id.CodecDelay))).toBe(BigInt(ogg.head.preSkip) * 1_000_000_000n / 48000n);
    expect(findAll(t, Id.ChapterTimeStart).map(uintOf)).toEqual([0n, 166_833_333n]);
    expect(findAll(t, Id.Cluster)).toHaveLength(3);
    expect(findAll(t, Id.CuePoint)).toHaveLength(3);
    expect(findAll(t, Id.CueClusterPosition).map(uintOf)).toEqual(findAll(t, Id.Cluster).map((c) => BigInt(c.offset - segmentDataStart(t))));
    for (const cluster of findAll(t, Id.Cluster)) expect(firstBlockIsVideoKeyframe(cluster)).toBe(true);
    expect(floatOf(find(t, Id.Duration))).toBeCloseTo(Number(r.durationNs) / 1e6, 3);
    expect(find(t, Id.Segment).size).toBe(statSync(out).size - segmentDataStart(t));
    expect(findAll(t, Id.DiscardPadding)).toHaveLength((await ogg.end).discardPadding48 > 0 ? 1 : 0);
  });
  describe.skipIf(!haveFfprobe)('ffprobe oracle', () => {
    it('sees two streams and two chapters', () => {
      const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_chapters', '-of', 'json', out]).toString());
      expect(j.streams.map((s: any) => s.codec_name)).toEqual(['av1', 'opus']);
      expect(j.chapters).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run tests/mux/mkv-writer.test.ts`
Expected: FAIL, `writeMkv` not found.

- [ ] **Step 5: Implement `src/mux/mkv-writer.ts`**

`durationNs` = max(last video block ms end, last audio end) as ns from the packet data: `framesToNs`-style for video using `fpsNum/fpsDen`, audio `(pts48 + duration - discardPadding48) * 1e9 / 48000 + startOffsetNs`.

- [ ] **Step 6: Run the tests and verify they pass; play it**

Run: `npx vitest run tests/mux` → PASS. Then `mpv --no-config /tmp/w.mkv` if mpv is installed: it plays without demuxer warnings (manual check, note the result in the commit message).

- [ ] **Step 7: Commit**

```bash
git add src/mux tests/mux tests/helpers/ebml-reader.ts && git commit -m "feat(mux): Matroska writer for AV1 + Opus with chapters and cues"
```

### Task 10: Episode encoder and CLI

**Files:**
- Create: `src/encode.ts`, `src/cli.ts`, `src/tools.ts`
- Modify: `package.json` (add `"bin": { "encoding-tools": "src/cli.ts" }` is not runnable without a build; instead keep `npm run cli -- ...`), `README.md` (usage)
- Test: `tests/encode.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 2–9 as named above.
- Produces:
  ```ts
  // tools.ts
  export function findTools(env?: NodeJS.ProcessEnv): ToolPaths          // PATH search; env overrides ENCODING_TOOLS_VSPIPE / _SVT / _OPUSENC; throws ToolsError listing what is missing and the brew line
  // encode.ts
  export interface EncodeOptions { discDir: string; playlistId: string; episodes: string; outDir: string; namePattern: string /* default 'episode-{n}', {n} zero-padded to 2 */; crf: number /* 25 */; preset: number /* 4 */; extraSvtArgs: string[]; opusBitrate?: number; cacheDir: string /* default '.cache/bestsource' under outDir */; tools: ToolPaths; title?: string }
  export function svtArgs(o: Pick<EncodeOptions, 'crf' | 'preset' | 'extraSvtArgs'>): string[]   // the Global Constraints defaults, then extraSvtArgs
  export function opusArgs(channels: number, bitrate?: number): string[]                            // ['--bitrate', String(bitrate ?? (channels <= 2 ? 160 : 320)), '--ignorelength']
  export interface EncodeEvent { kind: 'episode-start' | 'episode-done' | 'log'; episode: number; message: string; path?: string }
  export function encodeEpisodes(o: EncodeOptions, onEvent: (e: EncodeEvent) => void): Promise<string[]>   // output paths in order
  ```
  Per episode: write `video.vpy` and `audio.vpy` to a fresh `fs.mkdtemp` directory, start both chains, `readIvf`/`readOggOpus` their streams, `writeMkv` to `<outDir>/<name>.mkv` with `audio.startOffsetNs = segments[0].audioOffsetNs`; await both `done`; delete the temp directory. On any error: abort both chains, delete the partial `.mkv`, rethrow. Episodes run one after another.
  CLI (`src/cli.ts`, parsed with `node:util` `parseArgs`): `plan <disc> [--playlist ID]` prints playlists (id, duration mm:ss, clips) or, with `--playlist`, a chapter table, one line per chapter: index right-aligned to width 2, two spaces, playlist time as `mm:ss.mmm`, two spaces, clip id; `encode <disc> --playlist ID --episodes SPEC --out DIR [--name PATTERN] [--crf N] [--preset N] [--svt-args "..."] [--opus-bitrate N] [--title T]`. Exit codes: 0 ok, 2 usage or `EpisodeSpecError`, 3 `ToolsError`, 1 encode failure (prints the `ChainError` tool and stderr tail).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/encode.test.ts
it('builds encoder argument lists from the spec defaults', () => {
  expect(svtArgs({ crf: 25, preset: 4, extraSvtArgs: ['--lp', '4'] })).toEqual(['--preset', '4', '--crf', '25', '--enable-variance-boost', '1', '--tf-strength', '1', '--film-grain', '4', '--tile-columns', '1', '--keyint', '-2', '--color-primaries', '1', '--transfer-characteristics', '1', '--matrix-coefficients', '1', '--color-range', '0', '--progress', '0', '--lp', '4']);
  expect(opusArgs(2)).toEqual(['--bitrate', '160', '--ignorelength']);
  expect(opusArgs(6)).toEqual(['--bitrate', '320', '--ignorelength']);
});
describe.skipIf(!haveTools)('end to end on disc1', () => {
  it('encodes two episodes with chapters and no leftover files', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const paths = await encodeEpisodes({ discDir: 'fixtures/disc1', playlistId: '00000', episodes: '1-2,3-4', outDir: out, namePattern: 'ep-{n}', crf: 40, preset: 8, extraSvtArgs: [], cacheDir: join(out, 'cache'), tools: toolPaths()! }, () => {});
    expect(paths.map(basename)).toEqual(['ep-01.mkv', 'ep-02.mkv']);
    const t = parseMkv(readFileSync(paths[0]));
    expect(findAll(t, Id.ChapterTimeStart).map(uintOf)).toEqual([0n, 2002000000n]);
    expect(countVideoBlocks(t)).toBe(96);
    expect(floatOf(find(t, Id.Duration))).toBeCloseTo(4004, 0);
    expect(readdirSync(out).sort()).toEqual(['cache', 'ep-01.mkv', 'ep-02.mkv']);
  }, 600_000);
  it('deletes the partial file when the encoder fails', async () => {
    // tools with svt replaced by tests/fake-bin/SvtAv1EncApp and FAKE_ENC_EXIT=3
    await expect(encodeEpisodes({ ...opts, tools: { ...toolPaths()!, svt: 'tests/fake-bin/SvtAv1EncApp' } }, () => {})).rejects.toMatchObject({ tool: 'SvtAv1EncApp', code: 3 });
    expect(existsSync(join(out, 'ep-01.mkv'))).toBe(false);
  });
});
// tests/cli.test.ts
it('plan prints the chapter table of disc1', () => {
  const text = execFileSync('npx', ['tsx', 'src/cli.ts', 'plan', 'fixtures/disc1', '--playlist', '00000']).toString();
  expect(text).toContain('1  00:00.000  00001');
  expect(text).toContain('4  00:06.000  00002');
});
it('rejects a bad episode spec with exit code 2', () => {
  expect(() => execFileSync('npx', ['tsx', 'src/cli.ts', 'encode', 'fixtures/disc1', '--playlist', '00000', '--episodes', '3-2', '--out', '/tmp/x'])).toThrow(/status 2/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/encode.test.ts tests/cli.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `tools.ts`, `encode.ts`, `cli.ts`; update `README.md` usage**

README gains the two commands with the disc1 example and the output layout.

- [ ] **Step 4: Run the whole suite and verify it passes**

Run: `npm test`
Expected: PASS, the end-to-end test included when the tools are installed.

- [ ] **Step 5: Encode a real disc by hand and check sync**

Run: `npm run cli -- encode <a decrypted BDMV folder> --playlist <id> --episodes "<spec>" --out /tmp/real` and play an episode in mpv; confirm lip sync at the start and after the last chapter, and that chapter marks in mpv land on the scene changes. Record the disc name and the result in the commit message.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: encode command producing per-episode AV1+Opus MKVs from a playlist"
```
