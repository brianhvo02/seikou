# Subtitles from Picked MKV Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner picks release MKVs on a season screen and their text subtitle tracks and fonts go into the NAS's subtitle store, lined up with the disc audio; any viewer can also pick or drop an MKV on the player for one viewing.

**Architecture:** One reader in the browser (`@seikou/matroska` finds a text track's blocks through the Cues or by walking the clusters; the engine rebuilds each track as a whole `.ass` or `.srt` and lists the font attachments). The NAS store gains a release-upload kind (pooled fonts, a kept original, hidden until lined up) that `FansubService` lines up in its one-at-a-time queue. The player expands a picked MKV into ordinary subtitle and font `File`s before the existing pick path.

**Tech Stack:** TypeScript (strict), React, Vitest, Playwright, `@seikou/matroska`, `@seikou/ass`, `@seikou/fansubs`, the NAS server (Node, no native deps).

**Spec:** `docs/superpowers/specs/2026-11-24-mkv-subtitles-design.md`

## Global Constraints

- Packages don't import React or `src/`; `@seikou/matroska` stays free of `node:` and of `@seikou/ass`.
- New exports are `@internal` and imported by module path (`@seikou/<pkg>/<module>`), not from a package root, so `public-api.txt` and the examples are unchanged.
- New files carry `SPDX-License-Identifier: LGPL-3.0-or-later`; every export has a doc comment (`tests/documentation.test.ts`).
- Store limits stand: 2 GB in all, 5 MB a subtitle file, 50 MB of fonts an upload; a release upload and its original count toward the 2 GB; the 50 MB counts only fonts the pool doesn't hold.
- Owner writes only; reads open to every paired person under the `TITLE_LIBRARY` gate.
- Find fansubs leaves an episode with a release upload alone (no attach, replace or delete there), and a release upload counts as attached in its marks.
- A release upload is hidden from non-owners until lined up; an aligner answer of `none` shows it at the release's own timing and tells the owner.
- Made-up names only in fixtures, tests and docs (public repo).
- After any change under `packages/*/src`, run `npm run devsite:model` before `npm test`.

## Review Focus

1. **An MKV with no text tracks** (video, audio, PGS only): its row says "No text subtitles in this file" and nothing is uploaded for it; the rest of the pick goes on. (Task 6 test.)
2. **Cues that miss some subtitle blocks** (ReadOrder gaps): the reader falls back to walking the clusters and gives the same script as a full walk. (Task 1 test.)
3. **A season's files sharing fonts:** the second file's upload sends none of the fonts the first stored. (Task 4 and Task 6 tests.)
4. **A file that can't be read halfway** (the share drops: the `Blob` read rejects): that row shows the error, and the other rows still upload. (Task 7 test.)
5. **A file name with no episode number:** the row asks for an episode, and Upload stays disabled until every ticked row has one. (Task 6 test.)

---

### Task 1: Text-track blocks from an MKV (`@seikou/matroska`)

**Files:**
- Create: `packages/matroska/src/text-blocks.ts`
- Modify: `packages/matroska/src/playback.ts` (`cuesOf` also reads `CueRelativePosition`; export the internal `Cue` shape and the cluster scan for reuse, `@internal`)
- Test: `packages/matroska/src/text-blocks.test.ts`

**Interfaces:**
- Produces: `textTrackBlocks(reader: RangeReader, tracks: readonly number[], opts?: { onProgress?: (readBytes: number, totalBytes: number) => void; signal?: AbortSignal }): Promise<{ blocks: MkvBlock[]; via: 'cues' | 'walk' }>`, blocks of those track numbers only, sorted by time then file order.

- [ ] **Step 1: Write the failing tests** (files built with `writeMatroska` through `test-io.ts`; a video track with frames every 40 ms and one or two ASS tracks)
  - `reads every subtitle block through the Cues when each has a relative position` → `via === 'cues'`, blocks equal a full walk's, and the reader read under 5% of the file's bytes.
  - `walks the clusters when the Cues miss a subtitle block (a ReadOrder gap)` → Cues written for all but one ASS block: `via === 'walk'`, blocks equal the full walk's.
  - `walks the clusters when the Cues have no relative positions or no subtitle cues` → `via === 'walk'`.
  - `walks for an S_TEXT/UTF8 track` (no ReadOrder to check) → `via === 'walk'`.
  - `reports progress up to the file's size and stops on abort` → last `onProgress` call has `readBytes === totalBytes` on a walk; an aborted signal rejects with its reason.
- [ ] **Step 2: Run** `npx vitest run packages/matroska/src/text-blocks.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Cues path: for each cue point of a wanted track with `CueRelativePosition`, read the cluster's Timestamp (its first child) once per cluster and the block element at `clusterDataPos + relativePosition`. Accept the cue path only when every wanted track is ASS/SSA and its blocks' ReadOrder values (the block payload's first field) are exactly `0..n-1`; otherwise walk. Walk: read clusters in order in chunks of at most 8 MiB, parse block headers in memory, keep only wanted tracks' payloads.
- [ ] **Step 4: Run** the test file — Expected: PASS. Then `npx vitest run packages/matroska` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(matroska): find a text track's blocks through the Cues or by walking the clusters`

### Task 2: Rebuild an MKV's text tracks as files (engine)

**Files:**
- Create: `packages/engine/src/subs/mkv-extract.ts`
- Test: `packages/engine/src/subs/mkv-extract.test.ts`

**Interfaces:**
- Consumes: `textTrackBlocks` (Task 1); `openMatroska`, `blobRangeReader` from `@seikou/matroska`; `fontAttachments` from `../encode/mkv-subtitles`.
- Produces:
  - `interface MkvTextTrack { readonly number: number; readonly kind: 'ass' | 'srt'; readonly name: string | null; readonly language: string | null; readonly isDefault: boolean; readonly isForced: boolean; readonly dialogueLines: number; readonly text: string }`
  - `interface MkvTextExtract { readonly tracks: readonly MkvTextTrack[]; readonly fonts: readonly { readonly name: string; readonly data: Uint8Array }[]; readonly via: 'cues' | 'walk' | 'none' }`
  - `extractMkvText(reader: RangeReader, opts?: { onProgress?: (readBytes: number, totalBytes: number) => void; signal?: AbortSignal }): Promise<MkvTextExtract>` (`via: 'none'` with no text tracks; fonts are read only when there is a text track)
  - `mkvTrackFileName(fileName: string, track: MkvTextTrack): string` → `<file base> [<n>] <name or language>.ass|.srt`, a plain name of at most 255 bytes.

- [ ] **Step 1: Write the failing tests**
  - `rebuilds the ASS of an encoded episode as the script it was muxed from` → `fixtures/encodes/990001/` episode 1: one ASS track; its `text` parses with `@seikou/ass` to the same events (start, end, style, text) as the episode's packaged `subs/*.ass` (or the source script the fixture README names); `fonts` holds the fixture's font by name.
  - `orders Dialogue lines by ReadOrder and writes Start/End from the block time and duration` → hand-built MKV with three blocks out of ReadOrder.
  - `writes S_TEXT/UTF8 as numbered SRT cues` → two blocks → `1\n00:00:01,000 --> 00:00:02,500\n…`.
  - `answers no tracks and reads no attachment for a file without text tracks` → `via: 'none'`, `fonts: []`, attachment `data()` never called.
  - `mkvTrackFileName keeps names plain and short` → slashes and control characters replaced; a 300-byte base trimmed to fit.
- [ ] **Step 2: Run** `npx vitest run packages/engine/src/subs/mkv-extract.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in the order of the Interfaces block; the ASS block payload is `ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text` (the reverse of `@seikou/matroska`'s writer for `S_TEXT/ASS`), the header is the CodecPrivate as UTF-8, times as `H:MM:SS.cc`.
- [ ] **Step 4: Run** the test file, then `npx vitest run packages/engine/src/subs` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): rebuild an MKV's text subtitle tracks as files`

### Task 3: Release uploads on the wire (`@seikou/nas`)

**Files:**
- Modify: `packages/nas/src/nas-api.ts`
- Test: type-level only; `npx tsc -b` across the repo is this task's check.

**Interfaces:**
- Produces:
  - `interface ReleaseSource { readonly kind: 'release'; readonly group: string | null; readonly fileName: string; readonly fileSize: number; readonly track: number; readonly trackName: string; readonly alignment: FansubAlignment | null; readonly linedUpOn: { readonly discKey: string; readonly playlistId: string } | null }` (`alignment` null while waiting to be lined up)
  - `StoredSubtitle.source?: FansubSource | ReleaseSource`
  - The create body (`POST /api/subtitles`) gains optional `release?: Omit<ReleaseSource, 'kind' | 'alignment' | 'linedUpOn'>` and `fonts?: readonly { readonly name: string; readonly sha256: string; readonly size: number }[]`; its answer for a release gains `needFonts: readonly string[]` (names the pool doesn't hold).
  - `isRelease(s: StoredSubtitle): s is StoredSubtitle & { source: ReleaseSource }` and `isFansub(s)` likewise.

- [ ] **Step 1:** Add the types and guards; then run `npx tsc -b` — Expected: errors at every `s.source` use that reads Anime Tosho fields.
- [ ] **Step 2:** Narrow each of those uses with `isFansub` (server `fansubs/`, `routes/fansubs.ts`, `src/ui/nas/fansub-model.ts`, `FansubEpisodePanel`, `FansubLine`); where the UI shows group and rank, a release shows its group (or "Release") and no rank.
- [ ] **Step 3: Run** `npx tsc -b` and `npx vitest run server src/ui/nas` — Expected: PASS.
- [ ] **Step 4: Commit** `feat(nas): release uploads in the subtitle store's types`

### Task 4: The store keeps release uploads (server)

**Files:**
- Modify: `server/src/subtitle-store.ts`, `server/src/routes/subtitles.ts`
- Test: `server/src/subtitle-store.test.ts`, `server/src/routes/subtitles.test.ts`

**Interfaces:**
- Consumes: Task 3 types.
- Produces (store): `createRelease(meta: SubtitleMeta, release: ReleaseSource, fonts: readonly { name: string; sha256: string; size: number }[]): { stored: StoredSubtitle; needFonts: string[] }`; `putReleaseFile(id: string, name: string, body: Readable): Promise<StoredSubtitle>` writes `original/` and `sub/` alike; `putReleaseFont(id: string, name: string, body: Readable): Promise<StoredSubtitle>` checks the body's sha256 against the one declared and writes it to the pool; `setReleaseAlignment(id: string, data: Buffer, alignment: FansubAlignment, linedUpOn: { discKey: string; playlistId: string }): StoredSubtitle | null`.
- Produces (routes): `POST /api/subtitles` with `release` goes to `createRelease`; `PUT <id>/file/<name>` and `PUT <id>/fonts/<name>` go to the release methods for a release upload; after the file lands the route calls `fansubs.lineUpRelease(id)` (Task 5); the list leaves out, for non-owners, release uploads whose `alignment` is null.

- [ ] **Step 1: Write the failing tests**
  - `a release upload keeps its original and its fonts in the pool, counting toward the 2 GB` → total bytes include file and original.
  - `fonts the pool holds are not asked for again` → second `createRelease` declaring the same sha256 answers `needFonts: []`.
  - `a font whose bytes don't match its declared sha256 is refused` → 400 `bad-font`, nothing written.
  - `the 50 MB counts only fonts the pool doesn't hold` → declared new fonts over 50 MB → 413; the same over 50 MB all pooled → accepted.
  - `non-owners don't see a release upload until it is lined up` → list as a guest omits it; after `setReleaseAlignment` (also with `kind: 'none'`) it is listed.
  - `setReleaseAlignment replaces sub/ and keeps original/`.
- [ ] **Step 2: Run** `npx vitest run server/src/subtitle-store.test.ts server/src/routes/subtitles.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block; refused PUTs keep `Connection: close`; an unfinished release upload is swept after 1 h like other uploads.
- [ ] **Step 4: Run** the two files, then `npx vitest run server` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): the subtitle store keeps release uploads`

### Task 5: Lining up release uploads, and Find fansubs leaving them alone (server)

**Files:**
- Modify: `server/src/fansubs/service.ts`, `server/src/fansubs/state.ts` (marks), `server/src/routes/subtitles.ts` (wire `lineUpRelease`)
- Test: `server/src/fansubs/service.test.ts`

**Interfaces:**
- Consumes: Task 4 store methods.
- Produces: `FansubService.lineUpRelease(subtitleId: string): void` (queued in the one-at-a-time work, paused like it while a disc is read or a level encodes); `realign` and `useOriginal` accept release uploads; siblings are tracks from the same release file (`fileName` and `fileSize`) on the same disc key.

- [ ] **Step 1: Write the failing tests**
  - `a release upload is lined up after it lands and then shown` → fake aligner answers an offset; `alignment` set, `sub/` retimed, listed for guests.
  - `ASS tracks of one release file share the offset of the one with the most dialogue`.
  - `an aligner answer of none shows the release at its own timing and marks it for the owner` → `alignment.kind === 'none'`.
  - `Find fansubs leaves an episode with a release upload alone` → run a title whose episode 2 holds a release upload: episode 2's subtitles are unchanged and nothing new is attached there; episode 1 gets its fansub.
  - `a release upload counts as attached in the episode marks`.
  - `deleting a release upload doesn't mark an Anime Tosho track deleted` (`deleted()` ignores releases).
  - `an SRT release upload is not lined up and is shown at once` → `alignment.kind === 'none'` set without calling the aligner (the aligner reads ASS dialogue only).
- [ ] **Step 2: Run** `npx vitest run server/src/fansubs/service.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; the `earlier` filter in `episode()` takes fansubs only, and the episode is skipped before any download when a release upload is attached to it.
- [ ] **Step 4: Run** `npx vitest run server` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): line up release uploads; Find fansubs leaves their episodes alone`

### Task 6: The release form's model and upload (client, pure)

**Files:**
- Create: `src/ui/nas/release-model.ts`
- Modify: `src/ui/nas/nas-client.ts` (`createSubtitle` passes `release` and `fonts`, returns `needFonts`), `src/ui/nas/subtitle-model.ts` (`uploadRelease`)
- Test: `src/ui/nas/release-model.test.ts`, `src/ui/nas/subtitle-model.test.ts`

**Interfaces:**
- Consumes: `MkvTextExtract` (Task 2); `episodeOfFile`, `seasonEpisode` from `@seikou/fansubs`'s `episode-files`; Task 3 types.
- Produces:
  - `interface ReleaseRow { readonly file: File; readonly state: 'reading' | 'read' | 'failed'; readonly progress: number; readonly error: string | null; readonly extract: MkvTextExtract | null; readonly episode: number | null; readonly ticked: ReadonlySet<number> }`
  - `releaseRow(file: File, season: { count: number; before: number }): ReleaseRow` (episode guessed), `withExtract(row, extract, languages: readonly string[]): ReleaseRow` (ticks ASS tracks in `languages`, English always), `releaseGroup(fileName: string): string | null` (the leading bracketed group), `canUpload(rows: readonly ReleaseRow[]): boolean`.
  - `uploadRelease(nas: SubtitleWriter, row: ReleaseRow, target: SubtitleAttachment, tell: (sent: number) => void): Promise<StoredSubtitle[]>` — one subtitle a ticked track, named `<group> · <track name or language>`, sending only `needFonts`.

- [ ] **Step 1: Write the failing tests**
  - `guesses the episode from the file name and maps it onto the season` → `[Group] Show - 03 [1080p].mkv`, season before 12 → episode 3 (`seasonEpisode` rules).
  - `a file with no episode number waits for one, and Upload stays off` → `episode === null`, `canUpload === false` until set.
  - `ticks the ASS tracks in the fansub languages` → tracks `en` ASS, `ja` ASS, `en` SRT with languages `['en']` → only the `en` ASS ticked.
  - `a file with no text tracks offers nothing and doesn't block the others` → `canUpload` true with another ready row.
  - `uploadRelease sends only the fonts the NAS asks for` → `needFonts: ['B.ttf']` → one font PUT.
  - `releaseGroup reads the bracketed group` → `[Group] x.mkv` → `Group`; `x.mkv` → null.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/release-model.test.ts src/ui/nas/subtitle-model.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** the two files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the release form's model and upload`

### Task 7: The release form on season and movie screens (client UI)

**Files:**
- Create: `src/ui/nas/mkv-extract-worker.ts` (runs `extractMkvText` over `blobRangeReader(file)`, posts progress), `src/ui/nas/ReleaseUpload.tsx`
- Modify: `src/ui/nas/SubtitleUpload.tsx` (`accept` adds `.mkv`; one or more `.mkv` in a pick switch to `ReleaseUpload`), `src/ui/styles.css`
- Test: `src/ui/nas/ReleaseUpload.test.tsx` (jsdom, `@testing-library`, a fake extractor)

**Interfaces:**
- Consumes: Task 6 model and `uploadRelease`; `fansubLanguages()` from `NasClient`.
- Produces: `ReleaseUpload` props `{ nas; files: readonly File[]; season: { seasonId: string; titleId: string; count: number; before: number }; episodes: readonly { number: number; discKey: string; playlistId: string }[]; extract?: (file: File, onProgress: (p: number) => void) => Promise<MkvTextExtract>; onDone(): void }`; test ids `release-row` (with `data-state`), `release-episode`, `release-track` (checkbox), `release-upload`, `release-status`.

- [ ] **Step 1: Write the failing tests**
  - `reads each file, shows its tracks and uploads the ticked ones` → two files, both read, Upload sends two tracks.
  - `a file that fails to read shows why and the others still upload` (Review Focus 4) → the fake extractor rejects for one file.
  - `says when a file has no text subtitles` (Review Focus 1).
  - `after upload, says the tracks will show once lined up with the disc`.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/ReleaseUpload.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**; files are read one at a time in the worker; the screen stays usable while they read.
- [ ] **Step 4: Run** the file and `npx vitest run src/ui/nas` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): upload subtitles from release MKVs on the season and movie screens`

### Task 8: An MKV picked or dropped on the player

**Files:**
- Create: `src/ui/mkv-pick.ts` (`expandMkvPicks`, `MkvPickCache`)
- Modify: `packages/engine/src/controller/drop-files.ts` (`.mkv` taken by `splitPick` as a subtitle source), `src/ui/SubtitleMenu.tsx` (accept `.mkv`; list the picked MKV's other text tracks), `src/ui/ControlBar.tsx` and `src/ui/PlayerScreen.tsx` (expand before `loadSubtitleFiles` and the place saver's `addTextFiles`)
- Test: `src/ui/mkv-pick.test.ts`, `packages/engine/src/controller/drop-files.test.ts`

**Interfaces:**
- Consumes: Task 2 (`extractMkvText`, `mkvTrackFileName`), run in the Task 7 worker.
- Produces: `expandMkvPicks(files: readonly File[], prefs: { subtitleLanguage: string | null }, extract: (file: File) => Promise<MkvTextExtract>): Promise<{ files: File[]; tracks: readonly { source: string; track: MkvTextTrack }[] }>` — each `.mkv` becomes one subtitle `File` (its default track, else the first in `subtitleLanguage`, else the first) plus its fonts as `File`s; an MKV with no text track gives a notice and nothing; `MkvPickCache` keeps the extracts of this disc open so the menu can switch tracks without reading again.

- [ ] **Step 1: Write the failing tests**
  - `picks the default track, else the subtitle language, else the first`.
  - `turns the MKV's fonts into font files the pick carries`.
  - `an MKV without text tracks adds nothing and says so`.
  - `splitPick counts .mkv as a subtitle source` (drop-files).
- [ ] **Step 2: Run** `npx vitest run src/ui/mkv-pick.test.ts packages/engine/src/controller/drop-files.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; resume needs nothing new: the expanded files are what the place saver keeps (within its 5 MB a file and 50 MB a disc).
- [ ] **Step 4: Run** the two files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): subtitles from an MKV picked or dropped on the player`

### Task 9: End to end, and the documentation

**Files:**
- Create: `tests/e2e/mkv-subtitles.spec.ts`
- Modify: `tests/e2e/nas.spec.ts` only if the stand-in needs a hook for the aligner; `docs/known-issues.md` (replace "Not loaded yet: subtitles and fonts inside an `.mkv`" with what loads and what doesn't: PGS); `docs/roadmap.md` (remove the row); `docs/playing-discs.md` and `docs/nas.md` (picking an MKV; uploading from release MKVs; Find fansubs leaving those episodes alone); `CLAUDE.md` (the subtitle store and fansubs paragraphs)

- [ ] **Step 1: Write the E2E tests** (made-up names; the episode MKV from `fixtures/encodes/990001/`, copied under `test-results/` with a release-style name)
  - `a viewer drops an MKV on the player and its subtitle shows` → telemetry `textFile` names the extracted track; `ass` reports drawn events.
  - `an owner uploads a track from a release MKV and a viewer gets it once lined up` (NAS stand-in, Chrome) → the owner's form lists the track; after upload a guest's Subtitles menu shows it within the stand-in's line-up time; delete it after.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/mkv-subtitles.spec.ts --project=chromium` — Expected: PASS (after Tasks 1–8).
- [ ] **Step 3: Update the docs** listed above; run `npx vitest run tests/documentation.test.ts` — Expected: PASS.
- [ ] **Step 4: Run** `npm run devsite:model && npm test` and `npx playwright test tests/e2e/mkv-subtitles.spec.ts subtitles.spec ass-subtitles.spec` — Expected: PASS.
- [ ] **Step 5: Commit** `test(e2e): subtitles from MKVs; docs`
