# M2 Subtitle Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run seikou-encode -- serve <disc> --playlist ID --episodes SPEC` opens a local helper page where the user picks a fansub release (SeaDex-ranked, Anime Tosho search, or their own files), matches its tracks to the disc's episodes named from AniList, lines each episode up against the disc's audio while watching it play in Seikou's engine with a live nudge, sets title, stream names and languages, and saves one record per disc and playlist for the encoder to read in milestone 3.

**Architecture:** The encoder gains a local HTTP backend (`encoder/src/server/`) that serves the BDMV folder with the NAS disc API (manifest and range reads, reusing `server/src/manifest.ts` and `server/src/ranges.ts` as `tools/disc-server` does), wraps `@seikou/titles` and `@seikou/fansubs`, decodes an episode's audio for alignment through the existing vspipe/BestSource chain (no ffmpeg), and keeps the saved record under the app data directory. The helper page (`encoder/web/`) is a Vite-built React page that embeds `@seikou/engine`'s controller and worker and talks only to that backend. Two small package changes make this possible: `@seikou/fansubs` gains a PCM-level alignment entry point (`alignAudio`), and `@seikou/titles` gains AniList episode titles.

**Tech Stack:** Node 24 (as CI), TypeScript strict ESM, Vitest (`encoder` project; jsdom + `@testing-library` for components), Vite + React (already root dependencies), Playwright for one end-to-end spec. External processes only: `vspipe` with BestSource. Workspace packages `@seikou/bdmv`, `@seikou/nas`, `@seikou/titles`, `@seikou/fansubs`, `@seikou/engine`.

**Spec:** `encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md` (milestone 2 of its section 7); parent `encoder/docs/superpowers/specs/2026-11-06-encoding-tools-design.md`. Read both, and `encoder/README.md` and the root `CLAUDE.md`.

## Scope

In: the documentation pass over milestone 1 code (spec §4), the two package changes, the backend (spec §5.2), the helper page with its three steps and the metadata panel (spec §3, §5.3), the saved record (spec §6), the `serve` command.

Out (milestone 3): anything in the MKV (ASS tracks, fonts, names, languages, PGS), the `encode` command reading the record, its mismatch rule and `--no-subtitles`, mapping playlist PIDs to BestSource track indices, more than the first audio stream in the encode, the static web directory. The record written here carries everything milestone 3 needs.

Decisions this plan makes where the spec leaves the builder a choice (spec §8):
- **SRT becomes ASS on arrival.** A user's own `.srt` file is converted to ASS once when it is added (`srtToAss`), so alignment, retiming, preview and the milestone 3 mux have one code path (`S_TEXT/ASS` only).
- **One timing per episode.** Alignment runs on the episode's track with the most dialogue (`mostDialogue` from `@seikou/fansubs/tracks`, as Seikou does: a release file's tracks share timing), and the found shift and the user's nudge apply to every track of that episode. The record still writes `shiftMs`, `split` and `nudgeMs` per track, all equal within an episode.
- **Preview shows one track at a time**, with a switch between the episode's chosen tracks (the engine's text set shows one file at a time).
- **Data directory:** `~/Library/Application Support/seikou-encode/` on macOS, `$XDG_DATA_HOME/seikou-encode/` (default `~/.local/share/seikou-encode/`) elsewhere, `SEIKOU_ENCODE_DATA` overrides both (tests). Record file: `<data>/subtitles/<discKey>/<playlist>.json`. Paths inside the record are relative to the data directory.
- **BestSource index cache** moves to `<data>/bestsource/` for both `serve` and `encode` (`encode --cache DIR` overrides), so the line-up's indexing is reused by the encode (spec §5.1).
- **Disc key:** `discKeyOf(id16, manifest.files)` from `@seikou/nas/disc-key`, where `id16` is the first 16 hex digits of the SHA-256 of the disc folder's real path.
- **Nudge keys:** `[` and `]` move 42 ms, `{` and `}` (Shift) move 10 ms; buttons do the same.
- **Local server security:** listens on 127.0.0.1 only, a fresh token per run (`Authorization: Bearer` or `?t=`), `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard), paths with empty, `.` or `..` segments refused.
- **The show is picked by hand:** step 1 starts with an AniList search bar; the user searches, picks an anime, and SeaDex is asked for that AniList id. Nothing is looked up automatically from the disc. A restored record sets the show from its `anilist.id` and asks SeaDex again for it.
- **Offline fixtures:** `SEIKOU_ENCODE_FIXTURE=<dir>` makes the backend read SeaDex, Anime Tosho and AniList answers from recorded files instead of the network (tests and E2E only).

## Global Constraints

- License: every new file starts with `// SPDX-License-Identifier: LGPL-3.0-or-later` (or the HTML/CSS comment equivalent). Files in `packages/` that are ported keep their LGPL-2.1-or-later headers; `npm run licence-check` stays green.
- No ffmpeg anywhere in `encoder/` (spec: "nothing in this app ever runs ffmpeg"). Tools run as subprocesses only.
- The repo is public: only made-up show names, groups and release titles in fixtures, tests, docs and commit messages (this plan uses "Lantern Harbor", AniList id 900101, groups `GroupA` and `GroupB`).
- Documentation standard (spec §4), a requirement of every task and checked in every review: every exported function, class, interface, type and constant has a doc comment saying what it is for and what a caller must know (units, ownership, failure behaviour); exported interface fields have one when the name does not say it; format and protocol code names each field's meaning and cites the specification section; comments explain why in their own words and never cite rulings, task numbers, milestone labels or internal spec section numbers; each top-level area (`disc/`, `plan/`, `pipeline/`, `mux/`, `audio/`, `subs/`, `server/`, `web/`) has a README: concepts, then API, then where to look. Task 1's doc check enforces the first and third rule mechanically for `encoder/src` and `encoder/web/src`.
- Timing units are named in identifiers: `*45` (45 kHz), `*90` (90 kHz), `*Ms`, `*Us` (engine microseconds), `*Ns` (bigint ns), `*16k` (16 kHz samples).
- Look (spec §4): one typeface, Instrument Sans (`@fontsource-variable/instrument-sans`, already a root dependency), tabular numerals for times; colours base `#0F1B2D`, panel `#17273D`, ink `#E9EFF7`, muted `#8FA1BC`, accent `#4D9BFF` (chosen item, alignment marks), amber `#F0B45B` only for the nudge; left aligned single column under a step bar, 16 px side gutters, usable at 375 px width; no uppercase labels; no numbered markers except the step bar.
- Every UI task loads the `frontend-design:frontend-design` skill before writing UI code.
- No new npm dependencies.
- Commands: `npx vitest run --project encoder` (encoder tests), `npm run typecheck`, `npm test` before the last commit of a task that touches `packages/` or `server/`. Tests needing `vspipe` + BestSource use `describe.skipIf(!haveTools)` from `encoder/tests/helpers/tools.ts`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VgtGbXVjADUNZTpv1LrJbZ
  ```
- Never push.

## Review Focus

1. **A SeaDex release that cannot be fetched**: a private-tracker release (`infoHash: null`) or one Anime Tosho does not have. Expected: it is listed with SeaDex's notes, marked "not on Anime Tosho" or "private tracker", and cannot be picked; the others still work. Test in Task 10 (`seadex route marks unfetchable releases`).
2. **An episode that will not line up** (too little dialogue, or low confidence). Expected: step 3 says why, previews at original timing, the nudge still works, and the saved record has `shiftMs: 0, split: null`. Test in Task 11 (`episode 2 of the fixture answers none with no-speech`) and Task 17 (`shows the reason and keeps original timing when alignment is none`).
3. **A saved record whose cached files are gone** (cache cleared, data dir copied without `releases/`). Expected: `GET /api/record` returns the record with `missing` naming the release, and the page asks to fetch that release again rather than failing to load. Test in Task 12 (`reports missing cache files by release`).
4. **Release batches with extras, versions and no numbers** (`NCOP`, `v2` beside `v1`, a file with no episode number, episode numbers continuing from an earlier season). Expected: extras and unnumbered files land in "unmatched", the highest version wins, and the AniList episode offset maps continuing numbers. Test in Task 5 (`matchRelease` cases).
5. **Requests the local server must refuse**: no token, a foreign `Host`, `..` in a file path, a range past the end. Expected: 401, 403, 400, 416. Test in Task 9 (`refuses ...` cases).

---

### Task 1: Bring milestone 1 code up to the documentation standard

**Files:**
- Create: `encoder/scripts/doc-check.ts`, `encoder/tests/docs.test.ts`
- Create: `encoder/src/disc/README.md`, `encoder/src/plan/README.md`, `encoder/src/pipeline/README.md`, `encoder/src/mux/README.md`
- Modify: every file under `encoder/src/` (doc comments only; no behaviour change), `encoder/README.md` (link the area READMEs)

**Interfaces:**
- Produces: `undocumentedExports(files: readonly string[]): { file: string; name: string; line: number }[]` and `privateHistoryComments(files: readonly string[]): { file: string; line: number; text: string }[]` in `encoder/scripts/doc-check.ts`; later tasks rely on `encoder/tests/docs.test.ts` covering their new files automatically (it globs `encoder/src/**/*.ts` and `encoder/web/src/**/*.{ts,tsx}`, test files excluded).

- [ ] **Step 1: Write the failing test**

`encoder/tests/docs.test.ts`:
- `every export in encoder/src and encoder/web/src has a doc comment`: `expect(undocumentedExports(files)).toEqual([])`.
- `no comment points at private planning history`: `expect(privateHistoryComments(files)).toEqual([])`.
- `the checker finds what it should` (on inline fixture sources written to a temp dir): an undocumented `export function f()`, an undocumented `export interface I { a: number }` and a documented `/** x */ export const c = 1` give exactly `f` and `I`; comments `// see Task 7`, `// M2 maps this`, `// ruling R12`, `// spec §4.2`, `// milestone 3` are each reported, `// RFC 9559 §5.1.4.1.28` and `// AV1 spec 5.5.1` are not.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project encoder encoder/tests/docs.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `encoder/scripts/doc-check.ts`**

Use the TypeScript compiler API (`typescript`, a root devDependency): parse each file with `ts.createSourceFile`, walk top-level statements carrying an `export` modifier (and `export { … }` re-exports are skipped), and require a JSDoc (`ts.getJSDocCommentsAndTags(node).length > 0`). Private history regex over comment text: `/\b(Task \d+|M\d+\b|milestone \d|ruling R?\d+|R\d{1,2}\b|spec §|§\d)/i`, applied only to comments (use `ts.getLeadingCommentRanges`/`getTrailingCommentRanges` over the source text), never to string literals.

- [ ] **Step 4: Run it; it now fails with the real list**

Run: `npx vitest run --project encoder encoder/tests/docs.test.ts`
Expected: the checker self-test passes; the two repository tests fail listing M1's undocumented exports (for example `svtArgs`, `opusArgs`, `encodeEpisodes`, `EncodeOptions`, `Segment`, `Obu`, the `ebml.ts` writers) and comments such as `M2 maps the planned PID to a track index` in `pipeline/vpy.ts`.

- [ ] **Step 5: Document every export and rewrite the flagged comments**

What each area's comments must carry, beyond the general rule:
- `mux/ebml.ts`, `mux/mkv-ids.ts`, `mux/mkv-writer.ts`: each element ID names the element and its RFC 9559 (Matroska) or RFC 8794 (EBML) section; the writer's layout (SeekHead, Info, Tracks, Chapters, Clusters, Cues; why the Void reserve) and timestamp scale.
- `mux/av1.ts`, `mux/ivf.ts`: OBU header fields and the sequence header fields read, citing the AV1 Bitstream specification sections (5.3, 5.5), the `av1C` layout from the AV1-in-ISOBMFF/Matroska codec mapping, and the IVF header layout.
- `mux/ogg.ts`: page header fields (RFC 3533 §6), OpusHead (RFC 7845 §5.1), packet duration from the TOC byte (RFC 6716 §3.1), granule position and pre-skip.
- `disc/playlist.ts`, `disc/probe.ts`, `disc/stream-codes.ts`: MPLS play item and mark fields, `connection_condition`, CLPI stream coding info codes, citing libbluray's `mpls_parse.c`/`clpi_parse.c` (the Blu-ray specification is not public) and PES timestamp layout (ISO/IEC 13818-1 §2.4.3.7).
- `pipeline/vpy.ts`, `pipeline/chain.ts`: what each BestSource argument does (`cachemode=4`, `cachepath` as a file prefix, `adjustdelay=-1`, `track=-1`) with the BestSource README as reference, and why the scripts raise or pad.
- `plan/`: the 45 kHz playlist time, how frames and samples are rounded, why audio samples count from the video's first PTS.
Replace every flagged history reference with the reason in plain words (for example the `vpy.ts` comment becomes "the first audio stream; choosing a stream by PID needs a PID-to-track mapping that BestSource does not provide").

- [ ] **Step 6: Write the four area READMEs**

Each: what the area is for and its concepts first, then the exported API in a short list, then which file holds what. Link them from `encoder/README.md`.

- [ ] **Step 7: Verify**

Run: `npx vitest run --project encoder && npm run typecheck`
Expected: all pass, `docs.test.ts` included, no behaviour test changed.

- [ ] **Step 8: Commit**

```bash
git add encoder
git commit -m "docs(encoder): document every export, cite the formats, add area READMEs"
```

---

### Task 2: `@seikou/fansubs`: align against PCM the host decodes, SeaDex notes, shared fixture sources

**Files:**
- Modify: `packages/fansubs/src/align.ts`, `packages/fansubs/src/index.ts`, `packages/fansubs/src/seadex.ts`
- Create: `packages/fansubs/src/fixture-sources.ts` (moved from `server/src/fansubs/fixture-sources.ts`, which is deleted; its importers switch to `@seikou/fansubs/fixture-sources`)
- Test: `packages/fansubs/src/align.test.ts` (extend), `packages/fansubs/src/seadex.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export type PlaylistAudioReader = (spans: readonly TimeWindow[] | 'whole', signal?: AbortSignal) => Promise<AudioWindow>` in `align.ts`: 16 kHz mono PCM of the given spans of the episode (one window covering them, `startMs` its first span's start; for `'whole'`, `startMs: 0`). It throws for audio it could not read.
  - `export async function alignAudio(read: PlaylistAudioReader, durationMs: number, ass: string, signal?: AbortSignal, options?: AlignOptions): Promise<FansubAlignment>`: the body of today's `align` with its disc reads replaced by `read`. `align(disc, playlistId, durationMs, ass, decode, signal, options)` keeps its signature and calls `alignAudio` with a reader built on `episodeAudio`; the skip-on-error and spawn-error rules stay in the shared `read` helper.
  - `SeaDexEntry` gains `notes: string` and `comparison: string` (PocketBase entry fields `notes` and `comparison`, empty string when missing) and `SeaDexRelease` gains nothing.
  - `fixtureFansubSources(dir: string): { seadex: SeaDex; tosho: Tosho }` exported from `@seikou/fansubs/fixture-sources` (unchanged behaviour).

- [ ] **Step 1: Write the failing tests**

- `align.test.ts`, `alignAudio finds the offset from a host reader`: build a reader over a synthetic 16 kHz mono PCM of 120 s with noise bursts at known spans (reuse the helpers the existing align tests use), an ASS whose dialogue is those spans moved by −1200 ms; `expect(await alignAudio(reader, 120_000, ass)).toMatchObject({ kind: 'offset' })` with `offsetMs` within 20 of 1200.
- `alignAudio passes a reader's spawn error on`: a reader that rejects with an error whose `syscall` is `spawn vspipe` makes `alignAudio` reject with it.
- `seadex.test.ts`, `entry carries notes and comparison`: a fake fetch answering `{ items: [{ alID: 1, notes: 'Best video; GroupB for signs', comparison: 'https://slow.pics/c/x', expand: { trs: [] } }] }` gives `notes` and `comparison` with those values; an item without them gives `''`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/fansubs/src/align.test.ts packages/fansubs/src/seadex.test.ts`
Expected: FAIL (`alignAudio` not exported; `notes` undefined).

- [ ] **Step 3: Implement**

Refactor as in Interfaces; move the fixture sources file and fix its importers (`grep -rn fixture-sources server tests`). Export `alignAudio`, `PlaylistAudioReader` and the fixture sources from `index.ts`. Doc comments on everything new.

- [ ] **Step 4: Run the package and server tests**

Run: `npx vitest run packages/fansubs server && npm run typecheck`
Expected: PASS, every existing align test unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/fansubs server
git commit -m "feat(fansubs): alignAudio on host-decoded PCM, SeaDex notes, shared fixture sources"
```

---

### Task 3: `@seikou/titles`: AniList episode titles

**Files:**
- Modify: `packages/titles/src/anilist.ts`, `packages/titles/src/index.ts`
- Test: `packages/titles/src/anilist.test.ts` (extend)

**Interfaces:**
- Produces: `export function createAniListEpisodes(fetch: typeof globalThis.fetch, pacer: Pacer): { titles(alId: number, opts?: PacedOptions): Promise<ReadonlyMap<number, string>> }`. It queries `Media(id) { streamingEpisodes { title } }` and keeps titles matching `/^Episode (\d+)\s*[-–:]\s*(.+)$/`, keyed by that number; an unknown id or no streaming episodes gives an empty map. Errors as the existing client (`SourceUnavailable`, `RateLimited`).

- [ ] **Step 1: Write the failing test**

`anilist episode titles parse the streaming list`: a fake fetch returning `streamingEpisodes: [{ title: 'Episode 2 - The Lighthouse' }, { title: 'Episode 1 - Arrival' }, { title: 'Recap' }]` gives a map `1 → 'Arrival'`, `2 → 'The Lighthouse'` (size 2). `null Media gives an empty map`. `HTTP 500 throws SourceUnavailable`.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run packages/titles/src/anilist.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** with the existing `query` helper's request shape (factor it so both clients share it).

- [ ] **Step 4: Run** `npx vitest run packages/titles && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/titles
git commit -m "feat(titles): AniList episode titles from the streaming episode list"
```

---

### Task 4: Episode audio for alignment through vspipe

**Files:**
- Create: `encoder/src/audio/wav.ts`, `encoder/src/audio/downsample.ts`, `encoder/src/audio/episode-audio.ts`, `encoder/src/audio/README.md`
- Modify: `encoder/src/pipeline/vpy.ts` (add `buildSpeechAudioScript`)
- Create: `encoder/fixtures/disc-speech/` (copy of `fixtures/synthetic/disc-speech`, patched with `npx tsx encoder/scripts/patch-fixture-pmt.ts encoder/fixtures/disc-speech`, so libavformat sees a PMT)
- Test: `encoder/tests/audio/wav.test.ts`, `encoder/tests/audio/downsample.test.ts`, `encoder/tests/audio/episode-audio.test.ts`

**Interfaces:**
- Consumes: `EpisodePlan`, `planEpisodes`, `parseEpisodeSpec` (`plan/episodes.ts`), `probeClip`, `loadPlaylist`, `ToolPaths` (`pipeline/chain.ts`), `PlaylistAudioReader` and `AudioWindow` from `@seikou/fansubs` (Task 2).
- Produces:
  - `readWav(stream: Readable): Promise<{ format: WavFormat; frames: AsyncIterable<Float32Array[]> }>` where `WavFormat = { channels: number; sampleRate: number; bitsPerSample: 16 | 24 | 32; float: boolean }`; accepts `WAVE_FORMAT_PCM`, `WAVE_FORMAT_IEEE_FLOAT` and `WAVE_FORMAT_EXTENSIBLE` with either subformat, and a `data` size of 0 or `0xFFFFFFFF` (streamed, read to EOF). `frames` yields per-channel planar chunks.
  - `class Downsampler16k { constructor(sourceRate: number); push(planar: Float32Array[]): Int16Array; flush(): Int16Array }`: averages channels to mono, then low-pass filters (windowed sinc, cutoff 7 kHz, at least 64 taps) and decimates by `sourceRate / 16000`; throws `RangeError` when that is not an integer (48, 96 and 192 kHz pass).
  - `buildSpeechAudioScript(plan: EpisodePlan, opts: VpyOptions): string`: the episode's audio as `buildAudioScript` builds it (same splicing and padding), output as is (no format conversion in VapourSynth).
  - `decodeEpisodeAudio16k(plan: EpisodePlan, tools: Pick<ToolPaths, 'vspipe'>, cacheDir: string, signal?: AbortSignal): Promise<Int16Array>`: runs `vspipe -c wav <script> -` and returns the whole episode as 16 kHz mono; the script file lives in a temp dir removed afterwards; a non-zero exit throws with vspipe's stderr tail.
  - `episodeReader(pcm16k: Int16Array): PlaylistAudioReader`: slices spans out of the decoded episode (one window from the first span's start to the last span's end, zeros where spans leave gaps).

- [ ] **Step 1: Write the failing tests**

- `wav.test.ts`: a 16-bit stereo PCM header with `data` size `0xFFFFFFFF` built in the test yields both channels' samples scaled to [-1, 1); an EXTENSIBLE float32 header with 6 channels yields 6 planes; a `RIFF` with an unknown format tag rejects naming the tag.
- `downsample.test.ts`: a 48 kHz stereo 1 kHz sine (amplitude 0.5) gives 16 kHz output whose length is a third of the input (± filter delay) and whose RMS is within 5% of 0.5/√2 × 32767; a 10 kHz sine comes out at less than 5% of that RMS; `new Downsampler16k(44100)` throws `RangeError`.
- `episode-audio.test.ts` (`describe.skipIf(!haveTools)`): plan `encoder/fixtures/disc-speech` playlist `00000` with spec `1-3`; the decoded PCM has 90 s ± 1 frame at 16 kHz; the mean absolute amplitude inside `SPEECH_BURSTS` spans (import from `tests/helpers/speech-bursts.ts`) under 90 s is over 10× the amplitude in the gaps. `episodeReader` test (no tools): a ramp PCM sliced with spans `[{fromMs: 1000, toMs: 2000}]` returns `startMs: 1000` and 16,000 samples equal to the ramp's.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project encoder encoder/tests/audio`
Expected: FAIL (modules missing).

- [ ] **Step 3: Copy and patch the fixture disc**

Run: `cp -R fixtures/synthetic/disc-speech encoder/fixtures/disc-speech && npx tsx encoder/scripts/patch-fixture-pmt.ts encoder/fixtures/disc-speech`
Expected: the script reports both clips patched. Note the copy's origin in `encoder/fixtures/README.md` (create it if missing).

- [ ] **Step 4: Implement** the four modules as in Interfaces; README for `audio/` (why audio is decoded once per episode for alignment, why 16 kHz mono, where the filter comes from).

- [ ] **Step 5: Run** `npx vitest run --project encoder encoder/tests/audio`. Expected: PASS (the tools test skips without vspipe; run it on the Mac where it is installed and report which ran).

- [ ] **Step 6: Commit**

```bash
git add encoder
git commit -m "feat(encoder): decode an episode's audio to 16 kHz mono for alignment"
```

---

### Task 5: Release-to-episode matching and SRT conversion

**Files:**
- Create: `encoder/src/subs/release-match.ts`, `encoder/src/subs/srt-to-ass.ts`, `encoder/src/subs/README.md`
- Test: `encoder/tests/subs/release-match.test.ts`, `encoder/tests/subs/srt-to-ass.test.ts`

**Interfaces:**
- Consumes: `episodeOfFile`, `fileVersion`, `isExtraFile` from `@seikou/fansubs`.
- Produces:
  - `type TrackKind = 'full' | 'signs'`; `trackKind(name: string): TrackKind` (`signs` when the track name matches `/sign|song|s&s|forced/i`, else `full`).
  - `interface ReleaseFileInfo { readonly id: string; readonly name: string; readonly tracks: readonly { readonly id: string; readonly name: string; readonly language: string }[] }` (ids are strings so local uploads and Tosho files share it).
  - `interface MatchRow { readonly episode: number; readonly fileId: string | null; readonly candidates: readonly string[] }` (file ids in preference order).
  - `matchRelease(files: readonly ReleaseFileInfo[], episodeNumbers: readonly number[], episodeOffset: number): { rows: MatchRow[]; unmatched: ReleaseFileInfo[] }`: a file's number is `episodeOfFile(name)`; release number `n` maps to disc episode `n - episodeOffset`; extras (`isExtraFile`) and files with no number or a number outside `episodeNumbers` are unmatched; among files for one episode the highest `fileVersion` comes first and is chosen.
  - `srtToAss(text: string): string`: a minimal ASS script (`PlayResX 1920`, `PlayResY 1080`, one `Default` style in `Arial`, so a missing font falls back the way players fall back for SRT) with one `Dialogue` per cue, `\N` for line breaks, `<i>`, `<b>`, `<u>` turned into `{\i1}`/`{\i0}`, `{\b1}`/`{\b0}`, `{\u1}`/`{\u0}`, other tags dropped.
  - `decodeSubtitleText(bytes: Uint8Array): string`: UTF-8 (BOM stripped) or UTF-16 LE/BE by BOM; otherwise a fatal UTF-8 decode, throwing `SubtitleEncodingError` ("not UTF-8 or UTF-16; save the file as UTF-8").

- [ ] **Step 1: Write the failing tests**

`release-match.test.ts`:
- `matches by number and prefers the newest version`: files `[GroupA] Lantern Harbor - 01 (BD).mkv`, `[GroupA] Lantern Harbor - 02 (BD).mkv`, `[GroupA] Lantern Harbor - 02v2 (BD).mkv` with episodes `[1, 2]`, offset 0 → row 2's `fileId` is the v2 file and `candidates` lists v2 then v1.
- `puts extras and unnumbered files in unmatched`: `- NCOP1`, `- NCED`, `Lantern Harbor (BD).mkv` → all three unmatched, rows' `fileId` null where nothing matched.
- `applies the AniList episode offset`: files numbered 13 and 14 with offset 12 → episodes 1 and 2.
- `numbers outside the disc's episodes are unmatched`: file 05 with episodes `[1, 2]` → unmatched.
- `trackKind`: `'Signs & Songs'` → signs, `'English'` → full, `'Forced'` → signs.

`srt-to-ass.test.ts`:
- `converts cues with italics and line breaks`: SRT `1\n00:00:01,500 --> 00:00:03,000\n<i>Hello</i>\nthere\n` → contains `Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\i1}Hello{\i0}\Nthere`.
- `decodes UTF-16 LE with BOM` and `rejects Shift-JIS bytes with SubtitleEncodingError`.

- [ ] **Step 2: Run to see them fail** — `npx vitest run --project encoder encoder/tests/subs`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces; README for `subs/` (concepts: release, file, track, episode match, kinds, the record; API; files).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): match release files to episodes, convert SRT to ASS"`

---

### Task 6: App data directory and the saved record

**Files:**
- Create: `encoder/src/subs/app-data.ts`, `encoder/src/subs/record.ts`
- Test: `encoder/tests/subs/record.test.ts`

**Interfaces:**
- Consumes: `replaceAtomically` from `@seikou/titles`.
- Produces:
  - `appDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string` (rules in Scope).
  - `interface SubtitleRecord` exactly as spec §6's JSON, with these types: `disc: { key: string; label: string }`, `playlist: string`, `episodeSpec: string`, `anilist: { id: number; title: string; episodeOffset: number } | null`, `release: { source: 'seadex' | 'tosho' | 'local'; id: string; group: string; label: string } | null`, `fonts: string[]`, `episodes: RecordEpisode[]`, `savedAt: string`. `RecordEpisode = { index: number; title: string; tracks: RecordTrack[]; metadata: RecordMetadata }`, `RecordTrack = { file: string; kind: TrackKind; language: string; name: string; shiftMs: number; nudgeMs: number; split: { fromMs: number; offsetMs: number }[] | null; included: boolean }`, `RecordMetadata = { title: string; video: { name: string; language: string }; audio: { pid: number; name: string; language: string; included: boolean }[]; chapters: string[] }`. Paths (`file`, `fonts`) are relative to the data directory. `included` on a track is the metadata panel's tick (the spec's "unticked" track).
  - `parseRecord(json: unknown): SubtitleRecord` throwing `RecordError` with the JSON path of the first bad field (languages must be ISO 639-2 three letters, `shiftMs`/`nudgeMs` finite, `index` 1-based and unique, paths relative with no `..`).
  - `class RecordStore { constructor(dataDir: string); path(discKey: string, playlist: string): string; read(discKey, playlist): Promise<SubtitleRecord | null>; write(record: SubtitleRecord): Promise<void>; missingFiles(record): Promise<{ release: string; files: string[] }[]> }`. `write` sets nothing itself (the caller sets `savedAt`) and replaces the file atomically; `read` of a corrupt file throws `RecordError`.

- [ ] **Step 1: Write the failing tests**: `appDataDir` for darwin, linux with and without `XDG_DATA_HOME`, and `SEIKOU_ENCODE_DATA`; `round-trips a record` (write then read equals); `rejects a bad language with its path` (`episodes[0].tracks[0].language`); `rejects a path that leaves the data dir`; `missingFiles groups by release` (one font and one track missing → one entry naming `release.label`).
- [ ] **Step 2: Run to see them fail** — `npx vitest run --project encoder encoder/tests/subs/record.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): the saved subtitle record and the app data directory"`

---

### Task 7: Recorded fansub and AniList answers for the speech disc

**Files:**
- Create: `encoder/scripts/make-fansub-fixtures.ts`, `encoder/tests/fixtures/fansubs/` (its output: `seadex.json`, `tosho.json`, `anilist.json`, `files/*.ass.xz`, `files/pack-<id>.7z`), `encoder/src/subs/fixture-anilist.ts`
- Test: `encoder/tests/subs/fixtures.test.ts`

**Interfaces:**
- Consumes: `fixtureFansubSources` (Task 2), `SPEECH_BURSTS` (`tests/helpers/speech-bursts.ts`).
- Produces: the fixture directory, and `fixtureAniList(dir: string): { source: MetadataSource; episodes: { titles(alId: number): Promise<ReadonlyMap<number, string>> } }` reading `anilist.json` (`{ entries: Entry[], episodes: Record<string, Record<string, string>> }`), searching entries by a case-insensitive substring of any name.

Content (all made up): AniList entry `anilist:900101` "Lantern Harbor" (2024, 2 episodes, titles "Arrival" and "The Lighthouse"). SeaDex entry 900101 with `notes: 'GroupA for video and full subs; GroupB has the better signs.'`, three releases: GroupA (best, Nyaa, hash `a…a`), GroupB (Nyaa, hash `b…b`), and a private-tracker release (`infoHash: null`). Tosho has GroupA and GroupB only. GroupA files: episode 01 with tracks `Full` (eng) and `Signs` (eng), episode 02 with `Full`; a font pack with `DejaVuSansMono.ttf` (`fixtures/ass/fonts/`). Episode 01's `Full` dialogue is every `SPEECH_BURSTS` span inside 0–90 s moved 1200 ms earlier (so the right shift is +1200 ms); episode 02's has 6 lines only (too little to align). GroupB's episode 01 is the same timing with a different style. Disc episodes for every test that uses it: spec `1-3,4-5` on `encoder/fixtures/disc-speech` playlist `00000`.

- [ ] **Step 1: Write the failing test** `fixtures.test.ts`: `fixtureFansubSources(dir).tosho.byHash('aaaa…')` has 2 files; `seadex.entry(900101)` has 3 releases and the notes above; `fixtureAniList(dir).source.search('lantern')` returns `anilist:900101`; `episodes.titles(900101)` has 2 entries.
- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Write the script** (mirror `tests/e2e/fixtures/fansubs/make-fixtures.ts`), run it with `npx tsx encoder/scripts/make-fansub-fixtures.ts`, implement `fixture-anilist.ts`.
- [ ] **Step 4: Run** `npx vitest run --project encoder encoder/tests/subs/fixtures.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(encoder): recorded fansub and AniList answers for the speech disc"`

---

### Task 8: The release cache

**Files:**
- Create: `encoder/src/subs/release-cache.ts`
- Test: `encoder/tests/subs/release-cache.test.ts`

**Interfaces:**
- Consumes: `Tosho`, `FetchCache`, `fetchTrack`, `fontsIn7z`, `NotFoundOnTosho` (`@seikou/fansubs`), `ReleaseFileInfo` (Task 5), `srtToAss`, `decodeSubtitleText` (Task 5).
- Produces:
  - `interface CachedRelease { readonly key: string; readonly source: 'tosho' | 'local'; readonly label: string; readonly group: string; readonly files: readonly (ReleaseFileInfo & { readonly tracks: readonly (ReleaseFileInfo['tracks'][number] & { readonly path: string; readonly kind: TrackKind; readonly dialogueLines: number })[] })[]; readonly fonts: readonly { readonly name: string; readonly path: string }[] }` (paths relative to the data dir).
  - `class ReleaseCache { constructor(dataDir: string, deps: { tosho: Tosho; fetchCache: FetchCache }); fetchTosho(toshoId: number, signal?: AbortSignal): Promise<CachedRelease>; addLocal(files: readonly { name: string; bytes: Uint8Array }[]): Promise<CachedRelease>; get(key: string): Promise<CachedRelease | null>; read(relPath: string): Promise<Uint8Array> }`.
  - Layout: `<data>/releases/<key>/release.json` and `<key>/<fileId>-<trackId>.ass`; fonts once each at `<data>/fonts/<sha256>.<ext>` (pooled across releases, since every file of a release carries the same pack). Keys: `tosho-<id>`, `local-<first 16 hex of sha256 over the sorted names and bytes>`. Only ASS/SSA tracks are fetched; SRT-format Tosho tracks are converted with `srtToAss`; other formats are skipped and listed in `release.json` as `skipped`. A second `fetchTosho` of the same id returns the stored release without network. Local uploads: `.ass`/`.ssa`/`.srt` at most 5 MB each, fonts (`.ttf`, `.otf`, `.ttc`, `.woff`, `.woff2`) at most 50 MB together, otherwise `UploadRejected` with the file name; local files are one `ReleaseFileInfo` per subtitle file with one track named after the file.

- [ ] **Step 1: Write the failing tests** (with Task 7's fixtures): `fetches GroupA's tracks and fonts` (2 files, 3 tracks, kinds full/signs/full, 1 font, files exist on disk); `a second fetch makes no download` (count `tosho.download` calls through a wrapper); `addLocal converts SRT and keeps fonts`; `addLocal rejects a 6 MB .ass with its name`; `a Tosho 404 rejects with NotFoundOnTosho`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** Write each file atomically (temp name then rename) so an interrupted fetch leaves no half release; `release.json` last.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): cache a release's tracks and fonts, and the user's own files"`

---

### Task 9: Backend skeleton: security, session and the disc routes

**Files:**
- Create: `encoder/src/server/server.ts`, `encoder/src/server/http.ts`, `encoder/src/server/disc-routes.ts`, `encoder/src/server/README.md`
- Modify: `tsconfig.encoder.json` (include `server/src/manifest.ts`, `server/src/ranges.ts` if the import needs it)
- Test: `encoder/tests/server/server.test.ts`

**Interfaces:**
- Consumes: `buildManifest` (`server/src/manifest.ts`), `parseRange` (`server/src/ranges.ts`), `resolveDiscFile`, `discKeyOf` (`@seikou/nas/disc-key`), `loadPlaylist`, `listPlaylists`, `parseEpisodeSpec`, `planEpisodes`, `probeClip`.
- Produces:
  - `interface HelperContext { readonly discDir: string; readonly playlistId: string; readonly episodeSpec: string; readonly dataDir: string; readonly token: string; readonly webDir: string | null; readonly tools: ToolPaths | null; readonly sources: HelperSources }` with `HelperSources = { seadex: SeaDex; tosho: Tosho; anilist: MetadataSource; episodes: { titles(alId: number): Promise<ReadonlyMap<number, string>> } }`.
  - `startHelperServer(ctx: HelperContext, port = 0): Promise<{ url: string; port: number; close(): Promise<void> }>` (listens on 127.0.0.1).
  - `type Route = (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray, ctx: HelperContext) => Promise<void>` and `json(res, status, body)` / `httpError(res, status, code, message?)` in `http.ts`; later route modules export `routes: readonly [method: string, pattern: RegExp, route: Route][]` that `server.ts` concatenates.
  - Routes: `GET /api/session` → `{ discKey, label, playlistId, episodeSpec, toolsReady: boolean }`; `GET /api/discs/<discKey>/manifest` → the NAS `DiscManifest`; `GET|HEAD /api/discs/<discKey>/files/<path>` with ranges; `GET /api/playlists` → `listPlaylists` as JSON; `GET /api/episodes` → per episode `{ index, startUs, durationUs, chapters: { startUs }[] }` in playlist time (startUs from the first chapter's `start45`), plus per audio stream of the first play item `{ pid, codingType, language }` and `pgCount`. Static: everything else under `webDir` (index.html for `/`), no token needed. Every response: COOP `same-origin`, COEP `require-corp`, CORP `same-origin`; API responses `Cache-Control: no-store`. Errors are JSON `{ error, message? }`.

- [ ] **Step 1: Write the failing tests** (start on port 0 with `encoder/fixtures/disc-speech`, spec `1-3,4-5`, fake sources):
  - `session names the disc and spec`; `manifest lists the disc's files and inlines the playlist`.
  - `serves a range`: `Range: bytes=0-191` of `BDMV/STREAM/00001.M2TS` → 206, 192 bytes, first byte `0x47` at offset 4.
  - `episodes give playlist times`: episode 2 `startUs` 90,000,000, `durationUs` 60,000,000 (± one frame).
  - `refuses without a token` (401 `unauthorized`); `refuses a foreign Host` (403 for `Host: evil.example:PORT`); `refuses .. in a path` (400); `answers 416 past the end`; `answers 404 disc-changed for another disc key`.
  - `sets the isolation headers on the page and the API`.
- [ ] **Step 2: Run to see them fail** — `npx vitest run --project encoder encoder/tests/server`.
- [ ] **Step 3: Implement**, following `tools/disc-server/server.ts` for range streaming and path checks. README for `server/`: what the helper backend is, its security model, the route table, files.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): helper backend with the disc routes"`

---

### Task 10: Title and fansub routes

**Files:**
- Create: `encoder/src/server/title-routes.ts`, `encoder/src/server/fansub-routes.ts`
- Modify: `encoder/src/server/server.ts` (register), `encoder/src/server/README.md` (route table)
- Test: `encoder/tests/server/title-routes.test.ts`, `encoder/tests/server/fansub-routes.test.ts`

**Interfaces:**
- Consumes: `HelperContext` (Task 9), `ReleaseCache` (Task 8), `matchRelease` (Task 5), `rankReleases` (`@seikou/fansubs`).
- Produces routes:
  - `GET /api/titles/search?q=` → `{ candidates: TitleHit[] }` with `TitleHit = { alId: number; title: string; nativeTitle: string | null; year: number | null; format: string | null; episodes: number | null; poster: string | null }`, AniList's answer in its own order; an empty or whitespace-only `q` answers 400 `empty-query`. There is no automatic lookup: the encoder's helper backend never guesses the show from the disc (no TheDiscDB, no folder-name parsing; Seikou's NAS server and its title matching are untouched); the user's search and pick are the only way the AniList id is set; `GET /api/titles/<alId>/episodes` → `{ titles: Record<number, string> }`.
  - `GET /api/fansubs/seadex?anilist=<id>` → `{ notes, comparison, url: 'https://releases.moe/<id>/', releases: { group, tracker, isBest, dualAudio, tags, toshoId: number | null, unavailable: null | 'private-tracker' | 'not-on-tosho' }[] }` in `rankReleases` order; `toshoId` from `tosho.byHash`.
  - `GET /api/fansubs/search?q=` → Tosho releases `{ toshoId, title, date }[]`.
  - `POST /api/fansubs/fetch` `{ toshoId }` → `CachedRelease` plus `match: { rows, unmatched }` against the session's episodes (episode offset from the query `offset`, default 0).
  - `PUT /api/uploads/<batch>/<name>` (raw body; batch is 16 hex chars from the page) and `POST /api/uploads/<batch>/commit` → `addLocal` of the batch, same answer shape as fetch. Bodies over the limits answer 413 with `Connection: close` before the body is read where `Content-Length` says so.
  - `GET /api/releases/<key>` → the `CachedRelease` with `match`; `GET /api/releases/<key>/fonts/<name>` → font bytes.
  - Upstream failures: `SourceUnavailable`/`RateLimited` → 503 `{ error: 'source-unavailable', source }`; `NotFoundOnTosho` → 404 `not-on-tosho`.

- [ ] **Step 1: Write the failing tests** with Task 7's fixtures through `fixtureFansubSources` and `fixtureAniList`:
  - `search finds by text` (`lantern` → `anilist:900101` with its year and episode count); `an empty query answers 400`; `episodes route gives titles`.
  - `seadex route marks unfetchable releases`: 3 releases; GroupA `toshoId` set and `unavailable: null`; the private one `private-tracker`; GroupB found; notes passed through.
  - `fetch returns the release with matches`: rows for episodes 1 and 2 point at GroupA's files.
  - `upload then commit adds a local release`; `an oversized upload answers 413`.
  - `a rate-limited source answers 503` (a SeaDex fake that throws `RateLimited`).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project encoder encoder/tests/server`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): AniList search, SeaDex, Anime Tosho and upload routes"`

---

### Task 11: Alignment and retimed-track routes

**Files:**
- Create: `encoder/src/server/align-routes.ts`, `encoder/src/audio/episode-audio-cache.ts`
- Test: `encoder/tests/server/align-routes.test.ts`

**Interfaces:**
- Consumes: `decodeEpisodeAudio16k`, `episodeReader` (Task 4), `alignAudio`, `dialogueIntervals`, `retime`, `Semaphore` (`@seikou/fansubs`), `speechMask` (`@seikou/fansubs/speech`), `mostDialogue` (`@seikou/fansubs/tracks`), `ReleaseCache`.
- Produces:
  - `class EpisodeAudioCache { constructor(load: (episode: number, signal?: AbortSignal) => Promise<Int16Array>, keep = 2); get(episode: number, signal?: AbortSignal): Promise<Int16Array> }`: one decode at a time, concurrent requests for the same episode share it, the least recently used beyond `keep` is dropped (a 24-minute episode is about 46 MB).
  - `POST /api/episodes/<n>/align` `{ release: string, fileId: string }` → `{ alignment: FansubAlignment, trackId: string, speech: Span[], dialogue: Span[] }` where `Span = { fromMs, toMs }`, `speech` the runs of `speechMask` over the whole episode (frames of 10 ms merged into spans, gaps under 200 ms joined), `dialogue` the chosen track's `dialogueIntervals` before any shift, `trackId` the track it aligned on (`mostDialogue`). Without tools: 503 `{ error: 'tools-missing', message: 'Alignment needs VapourSynth with BestSource (vspipe)' }`. A client that disconnects aborts the decode.
  - `GET /api/episodes/<n>/subtitle?release=&track=&timing=<base64url JSON FansubAlignment>` → `text/plain; charset=utf-8`, the track retimed with `retime(text, timing)`; `timing` absent means original.

- [ ] **Step 1: Write the failing tests** (`describe.skipIf(!haveTools)` for the first two, fixtures from Task 7):
  - `episode 1 lines up at +1200 ms`: `alignment.kind === 'offset'`, `offsetMs` within 30 of 1200; `speech` has at least 20 spans; `dialogue` has the track's line count.
  - `episode 2 of the fixture answers none with no-speech`.
  - `without tools align answers 503 tools-missing` (context with `tools: null`).
  - `the subtitle route applies the timing`: timing `{ kind: 'offset', offsetMs: 1200, confidence: 1 }` moves the first Dialogue's start by 1.20 s; no timing returns the original bytes.
  - `EpisodeAudioCache shares a decode and evicts the oldest` (fake loader counting calls).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS (report whether the tools tests ran).
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): line episodes up against the disc's audio and serve retimed tracks"`

---

### Task 12: Record routes

**Files:**
- Create: `encoder/src/server/record-routes.ts`
- Test: `encoder/tests/server/record-routes.test.ts`

**Interfaces:**
- Consumes: `RecordStore`, `parseRecord` (Task 6).
- Produces: `GET /api/record` → `{ record: SubtitleRecord | null, missing: { release: string; files: string[] }[] }` for the session's disc and playlist (404 is never used for "no record"); `PUT /api/record` validates with `parseRecord`, requires `disc.key`, `playlist` and `episodeSpec` to equal the session's (409 `session-mismatch` otherwise), sets `savedAt` to now, writes, and answers the stored record. Bodies over 2 MB answer 413.

- [ ] **Step 1: Write the failing tests**: `no record yet answers null`; `put then get round-trips and sets savedAt`; `put for another playlist answers 409`; `put with a bad language answers 400 naming the field`; `reports missing cache files by release` (write a record, delete one track file, get → `missing` names the release label).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): read and save the subtitle record over the helper API"`

---

### Task 13: The `serve` command

**Files:**
- Modify: `encoder/src/cli.ts`, `encoder/README.md` (usage, data directory, exit codes)
- Create: `encoder/src/server/sources.ts`
- Test: `encoder/tests/cli.test.ts` (extend), `encoder/tests/server/sources.test.ts`

**Interfaces:**
- Consumes: `startHelperServer` (Task 9), `appDataDir` (Task 6), `findTools`, `createSeaDex`, `createTosho`, `createAniList`, `createAniListEpisodes`, `Pacer`, `fixtureFansubSources`, `fixtureAniList`.
- Produces:
  - `createSources(env: NodeJS.ProcessEnv, fetch: typeof globalThis.fetch): HelperSources`: live clients (SeaDex `https://releases.moe`, Tosho feed `https://feed.animetosho.net` and site `https://animetosho.org`, both paced at one request per 2.5 s as Seikou paces them; AniList as Seikou's server paces it), User-Agent `seikou-encode (+https://github.com/brianhvo02/seikou)`; with `SEIKOU_ENCODE_FIXTURE=<dir>` the recorded sources instead.
  - CLI: `seikou-encode serve <disc> --playlist ID --episodes SPEC [--port N] [--no-open]`: checks the spec against the playlist (exit 2 on a bad spec), finds the tools (missing tools are not fatal for `serve`: the page says alignment is unavailable), requires `encoder/web/dist` (exit 3 with "run npm run encoder:web:build first" when absent), prints `Helper: http://127.0.0.1:<port>/?t=<token>`, opens it with `open` (macOS) or `xdg-open` unless `--no-open`, and runs until SIGINT. `encode` gains `--cache DIR`, its default becoming `<data>/bestsource`.

- [ ] **Step 1: Write the failing tests**: `serve rejects a bad episode spec with exit 2`; `serve without a built page exits 3 naming the build command` (point `webDir` lookup at an empty temp dir through an env override `SEIKOU_ENCODE_WEB_DIR`); `encode's default cache is under the data dir` (unit-test the option parsing helper); `fixture sources come from SEIKOU_ENCODE_FIXTURE`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project encoder`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): serve command starts the subtitle helper"`

---

### Task 14: Helper page scaffold, API client and state model

Load `frontend-design:frontend-design` first.

**Files:**
- Create: `encoder/web/index.html`, `encoder/web/vite.config.ts`, `encoder/web/src/main.tsx`, `encoder/web/src/App.tsx`, `encoder/web/src/StepBar.tsx`, `encoder/web/src/api.ts`, `encoder/web/src/helper-model.ts`, `encoder/web/src/metadata/metadata-model.ts`, `encoder/web/src/styles.css`, `encoder/web/README.md`
- Create: `tsconfig.encoder-web.json`; Modify: `tsconfig.json` (reference it), `tsconfig.encoder.json` (leave `encoder/web` out), `package.json` (scripts `encoder:web:build`: `vite build --config encoder/web/vite.config.ts`, `encoder:web:dev`), `vite.config.ts` (the `encoder` test project also includes `encoder/web/src/**/*.test.{ts,tsx}`; mirror how the `unit` project runs jsdom component tests), `.gitignore` (`encoder/web/dist`)
- Test: `encoder/web/src/helper-model.test.ts`, `encoder/web/src/metadata/metadata-model.test.ts`, `encoder/web/src/App.test.tsx`

**Interfaces:**
- Consumes: the API of Tasks 9–12.
- Produces:
  - `createApi(base: string, token: string): HelperApi` in `api.ts`, one typed method per route (`session()`, `episodes()`, `searchTitles(q)`, `episodeTitles(alId)`, `seadex(alId)`, `searchTosho(q)`, `fetchRelease(toshoId, offset)`, `upload(files: File[], offset)`, `release(key, offset)`, `align(episode, release, fileId)`, `subtitleUrl(episode, release, track, timing)`, `fontUrl(release, name)`, `record()`, `saveRecord(r)`), throwing `ApiError { status, code, message }`.
  - `helper-model.ts`: `HelperState` (`step: 1 | 2 | 3`, `title: TitleHit | null`, `episodeOffset`, `release: CachedRelease | null`, `match: MatchRow[]`, `choices: Record<number, { trackIds: string[] } | 'none'>`, `timing: Record<number, { alignment: FansubAlignment; nudgeMs: number; accepted: boolean }>`, `metadata: MetadataDraft`, `dirty: boolean`), `HelperAction` union, `reduce(state, action): HelperState` (pure), `canEnter(state, step): boolean` (step 2 needs a release, step 3 needs at least one episode with tracks or marked none), `toRecord(state, session, episodes): SubtitleRecord` and `fromRecord(record): HelperState`.
  - `encoder/web/src/metadata/metadata-model.ts`: `MetadataDraft` (per episode the `RecordMetadata` fields plus the subtitle tracks' order, names, languages and ticks, and a set of user-edited field paths) and `defaultMetadata(input: { show: string | null; episodes: { index: number; title: string | null; chapterCount: number }[]; audio: { pid: number; language: string }[]; tracks: Record<number, { name: string; kind: TrackKind; language: string; group: string }[]> }): MetadataDraft` with the spec §3 defaults: episode title `<Show> - <nn> - <episode title>` (dropping missing parts), video name `''` and language `und`, audio name from the language (`jpn` → `Japanese`, through `Intl.DisplayNames`: the page imports nothing at runtime from `@seikou/fansubs` or `encoder/src`, which need Node; type-only imports are fine) and its stream-table language (`und` when empty), subtitle name `<group> full` or `<group> signs`, chapter titles `Chapter n`.
  - `vite.config.ts`: root `encoder/web`, `react()`, `worker: { format: 'es' }`, the COOP/COEP headers and the 304 middleware as in the root `vite.config.ts`, dev proxy of `/api` to `SEIKOU_ENCODE_API` (the `serve` URL), `build.outDir` `encoder/web/dist`.
  - Page shell: the step bar (three named steps: "Release", "Episodes", "Line up"), a "Details" button opening the metadata panel from any step, "Save for encoding"; the token read from `?t=` and kept in memory only.

- [ ] **Step 1: Write the failing tests**: `defaultMetadata follows the spec` (Lantern Harbor, episode 1 "Arrival" → `Lantern Harbor - 01 - Arrival`; audio `jpn` → `Japanese`/`jpn`; GroupA signs → `GroupA signs`), `reduce` cases (`picking a release resets matches and timings`, `nudge accumulates and marks dirty`, `marking an episode none clears its tracks`), `canEnter` cases, `toRecord then fromRecord keeps choices, timings and metadata`, `toRecord writes shiftMs 0 and split null for alignment none and original`, and `App renders the step bar with the session's disc label` (jsdom, fake `HelperApi`).
- [ ] **Step 2: Run to see them fail** — `npx vitest run --project encoder encoder/web`.
- [ ] **Step 3: Implement**, applying the look in Global Constraints through CSS custom properties on `:root` (this page is dark only).
- [ ] **Step 4: Run** the tests, `npm run typecheck` and `npm run encoder:web:build`. Expected: PASS and `encoder/web/dist/index.html` exists.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): helper page shell, API client and state model"`

---

### Task 15: Step 1, pick a release

Load `frontend-design:frontend-design` first.

**Files:**
- Create: `encoder/web/src/steps/ReleaseStep.tsx`, `encoder/web/src/steps/release-model.ts`
- Test: `encoder/web/src/steps/release-model.test.ts`, `encoder/web/src/steps/ReleaseStep.test.tsx`

**Interfaces:**
- Consumes: `HelperApi`, `reduce` actions `setTitle`, `setRelease`, `setOffset`.
- Produces: `ReleaseStep({ api, state, dispatch })`. Layout top to bottom: an AniList search bar (submitted with Enter or a Search button; nothing is searched until the user submits) with its results as a list (cover, title, native title, year, format, episode count); picking a result sets the show, collapses the list to that one show with "Change" to search again, and only then asks `seadex(alId)` for that id, so SeaDex is never queried without a picked show; changing the show clears the SeaDex list and any fetched release. Before a show is picked the release area says to search for the show first, while the Anime Tosho search and "Add your own files" already work (they need no show). Then the AniList episode offset (number input, default 0, with a one-line explanation), SeaDex's notes as text with "Open on SeaDex" linking `url` (new tab, `rel="noreferrer"`), releases best first (group, tags such as dual audio, best mark; unfetchable ones disabled with "Private tracker" or "Not on Anime Tosho"), an Anime Tosho search box with results, and "Add your own files" (file input accepting `.ass,.ssa,.srt,.ttf,.otf,.ttc,.woff,.woff2`, multiple). After a fetch: tracks per episode, languages, font count, and the unmatched count; "Next" enables. Errors from the API show inline beside the control that caused them (`source-unavailable` says the service is not answering and to try again).
  - `release-model.ts`: `releaseSummary(release: CachedRelease, rows: MatchRow[]): { episodes: number; tracks: number; languages: string[]; fonts: number; unmatched: number }`.

- [ ] **Step 1: Write the failing tests**: `releaseSummary` on Task 7's GroupA release (2 episodes, 3 tracks, `['eng']`, 1 font, 0 unmatched); component: `searches AniList only when submitted` (typing calls nothing; Enter calls `searchTitles('lantern')` once), `asks SeaDex only after a show is picked, with its id` (`seadex` not called on render or search, called with 900101 on pick), `changing the show clears the SeaDex list and the release`, `lists SeaDex releases with the private one disabled`, `picking GroupA fetches and shows the summary`, `a 503 shows the retry message beside the release list`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project encoder encoder/web`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): helper step 1, pick a release"`

---

### Task 16: Step 2, match episodes

Load `frontend-design:frontend-design` first.

**Files:**
- Create: `encoder/web/src/steps/MatchStep.tsx`
- Test: `encoder/web/src/steps/MatchStep.test.tsx`

**Interfaces:**
- Consumes: `state.match`, `state.release`, episode titles (`api.episodeTitles`), actions `chooseFile(episode, fileId)`, `chooseTracks(episode, trackIds)`, `markNone(episode)`.
- Produces: `MatchStep({ api, state, dispatch })`: one row per disc episode (number and AniList title, "Episode n" when AniList has none), the chosen file in a select of the candidates and every unmatched file, its tracks as checkboxes labelled with name, kind and language (full tracks ticked by default, signs ticked too when the file has both), and "No subtitles" per row. Below, "Not matched" lists unmatched files by name. At 375 px each row stacks.

- [ ] **Step 1: Write the failing tests**: `rows show AniList titles`; `ticks full and signs by default`; `choosing an unmatched file for an episode moves it out of Not matched`; `No subtitles disables the row's tracks`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): helper step 2, match episodes"`

---

### Task 17: Step 3, line up and preview with the engine

Load `frontend-design:frontend-design` first.

**Files:**
- Create: `encoder/web/src/steps/LineUpStep.tsx`, `encoder/web/src/player/Player.tsx`, `encoder/web/src/player/use-controller.ts`, `encoder/web/src/strip/AlignmentStrip.tsx`, `encoder/web/src/strip/strip-geometry.ts`
- Test: `encoder/web/src/strip/strip-geometry.test.ts`, `encoder/web/src/steps/LineUpStep.test.tsx`

**Interfaces:**
- Consumes: `createController`, `createEngineWorker`, `PlayerController`, `RemoteDiscSpec` (`@seikou/engine`); `api.align`, `api.subtitleUrl`, `api.fontUrl`; actions `setTiming(episode, alignment)`, `nudge(episode, deltaMs)`, `accept(episode)`, `skip(episode)`, `useOriginal(episode)`.
- Produces:
  - `useController(api, session): PlayerController` (one controller for the page; `openRemote({ kind: 'remote', base: '<origin>/api/discs/<key>/', token, manifest }, undefined, undefined, undefined, start)` once, with `start = { playlistId, timeUs, hdmv: null, playback: null }`; later episodes `seek`).
  - `Player({ controller, episode })`: the canvas (`attachCanvas`), play/pause, a seek bar limited to the episode's range, time in tabular numerals. Audio starts on the first user click (`startAudio`).
  - `strip-geometry.ts`: `stripLanes(input: { speech: Span[]; dialogue: Span[]; alignment: FansubAlignment; nudgeMs: number; viewFromMs: number; viewToMs: number; widthPx: number }): { top: Rect[]; bottom: Rect[] }`, the bottom lane's spans moved by the alignment (each span by its split part's offset for `split`, by `offsetMs` for `offset`, by 0 otherwise) plus `nudgeMs`, clipped to the view and scaled to pixels. `AlignmentStrip` draws it on a canvas, top lane (disc speech) and bottom lane (subtitle lines) in the accent, a playhead, the view following ±15 s around the current time; the nudge amount shows in amber beside it.
  - `LineUpStep`: per episode with tracks: calls `align` (spinner with "Lining up episode n against the disc's audio"), shows the result in words ("Shifted +1.20 s, confident" / "Split at 12:04: +1.20 s, then +0.84 s" / "Could not line up: too little dialogue" / "…: not confident"), loads the retimed track plus the release's fonts as `File`s with `controller.loadSubtitleFiles`, places it with `setSubtitleStart(0, episode.startUs)`, seeks to the episode start plus the first dialogue line's retimed start, and maps the nudge to `shiftSubtitleFile(0, delta)` (`[`/`]` 42 ms, `{`/`}` 10 ms, and buttons). "Accept, next episode", "Use original timing" (refetches the track untimed, nudge kept), "Skip" (episode marked none). A track switch when the episode has several chosen tracks. With `toolsReady: false` or a `tools-missing` answer it says alignment needs VapourSynth with BestSource and previews at original timing.

- [ ] **Step 1: Write the failing tests**:
  - `strip-geometry`: an offset of +1200 and nudge −42 moves a dialogue span at 10,000–12,000 ms to 11,158–13,158 ms; a split `[{fromMs:0, offsetMs:1000},{fromMs:60000, offsetMs:500}]` moves a span at 70,000 by 500; spans outside the view are dropped and one crossing its edge is clipped; pixels scale linearly.
  - `LineUpStep` (jsdom, fake controller and API): `shows the shift and places the track at the episode start` (`setSubtitleStart(0, 0)` for episode 1, `loadSubtitleFiles` with one `.ass` and one font); `] nudges by 42 ms and { by -10 ms` (`shiftSubtitleFile` calls); `shows the reason and keeps original timing when alignment is none`; `without tools it previews at original timing with the VapourSynth message`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project encoder encoder/web && npm run typecheck && npm run encoder:web:build`. Expected: PASS. Then run `serve` on `encoder/fixtures/disc-speech` with `SEIKOU_ENCODE_FIXTURE=encoder/tests/fixtures/fansubs` and check by hand in Chrome that episode 1 plays with subtitles and the nudge moves them; report what you saw.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): helper step 3, line up and preview in Seikou's engine"`

---

### Task 18: Metadata panel and save

Load `frontend-design:frontend-design` first.

**Files:**
- Create: `encoder/web/src/metadata/MetadataPanel.tsx`, `encoder/web/src/SaveBar.tsx`
- Modify: `encoder/web/src/metadata/metadata-model.ts`
- Test: `encoder/web/src/metadata/metadata-model.test.ts`, `encoder/web/src/metadata/MetadataPanel.test.tsx`

**Interfaces:**
- Consumes: `MetadataDraft`, `defaultMetadata` (Task 14), `api.saveRecord`, `api.record`.
- Produces:
  - `metadata-model.ts` gains `move<T>(list: readonly T[], from: number, to: number): T[]` and `withUserEdit(draft: MetadataDraft, path: string, value: unknown): MetadataDraft`, marking the field user-set so a later `defaultMetadata` merge never overwrites it, and `mergeDefaults(draft, defaults): MetadataDraft`.
  - `MetadataPanel`: a sheet over the page with per-episode title fields, video name and language, audio and subtitle lists that drag to reorder (pointer drag plus Up/Down buttons and Alt+Arrow keys for keyboard users) with a tick to include, the first of each list marked "Default", and chapter titles. Languages are three-letter codes with the language name beside.
  - `SaveBar`: "Save for encoding" writes `toRecord(...)`; answers `Saved` with the time, or the server's message. On load, an existing record is restored with `fromRecord`; `missing` files show "Fetch <release> again" which re-runs the fetch (Review Focus 3).

- [ ] **Step 1: Write the failing tests**: `a user edit survives mergeDefaults`; `move` cases; panel: `reordering audio moves the Default mark`, `unticking a subtitle track leaves it out of the record` (`included: false`), `Alt+ArrowUp moves a track up`; save bar: `restores a saved record` and `offers to fetch a missing release again`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(encoder): helper metadata panel and save"`

---

### Task 19: End-to-end check and documentation

**Files:**
- Create: `playwright.encoder.config.ts`, `encoder/tests/e2e/helper.spec.ts`
- Modify: `encoder/README.md` (the helper: what it does, `serve`, the data directory, offline fixture mode, building the page), `CLAUDE.md` (the `seikou-encode` bullet gains `serve`, `encoder:web:build`, `playwright.encoder.config.ts`, and the encoder paragraph in Architecture names `encoder/src/server/` and `encoder/web/`), `encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md` (status line: milestone 2 done, with the date)

**Interfaces:**
- Consumes: everything above.
- Produces: `npx playwright test -c playwright.encoder.config.ts` (Chrome channel, as the root config's `chromium` project), whose `webServer` builds the page and runs `seikou-encode serve encoder/fixtures/disc-speech --playlist 00000 --episodes "1-3,4-5" --port 4195 --no-open` with `SEIKOU_ENCODE_FIXTURE=encoder/tests/fixtures/fansubs` and `SEIKOU_ENCODE_DATA` in a temp dir, and reads the URL with its token from the server's output.

- [ ] **Step 1: Write the spec** `helper.spec.ts`, one test walking the flow: typing `lantern` in the AniList search and picking Lantern Harbor loads SeaDex's list for 900101 (no SeaDex request before the pick, checked with `page.on('request')`); the private release is disabled; pick GroupA; step 2 shows both episodes with "Arrival" and "The Lighthouse"; step 3 on episode 1 shows "Shifted +1.2 s" (skipped with a reason when the server reports `toolsReady: false`), the video plays (telemetry `?telemetry=1` or the canvas changing), `]` changes the shown nudge to `+42 ms`; episode 2 shows "Could not line up"; open Details, rename the subtitle track, save; reload and the name and the nudge are restored; the record file exists under the temp data dir with `nudgeMs: 42` on episode 1.
- [ ] **Step 2: Run it** — `npx playwright test -c playwright.encoder.config.ts`. Expected: PASS (fix what fails in the task that owns it, and say so in the report).
- [ ] **Step 3: Update the documentation** listed under Files.
- [ ] **Step 4: Full verification** — `npm run typecheck && npm test && npm run licence-check && npx playwright test -c playwright.encoder.config.ts`. Expected: all pass. If `srt.test.ts` or the player/vm-trace timing tests fail under load and pass alone, record it in the report (known flake) instead of changing them.
- [ ] **Step 5: Commit** — `git commit -m "test(encoder): helper end-to-end check; document the subtitle helper"`
