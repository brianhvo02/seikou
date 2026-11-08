# Helper: Multiple Releases and Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The subtitle helper keeps a pool of releases (SeaDex picks, Anime Tosho search results and the user's own files) and lets each episode take its subtitles from any of them; and the helper can be navigated backwards: Back buttons, a previous episode in step 3, the browser's Back and Forward between steps, and a step bar that looks clickable.

**Architecture:** The page's state replaces its single release with an ordered pool and stores, per episode, which release and file it uses. The saved record replaces `release` with `releases` (old records with `release` still load) and names each track's release, so the encode and the missing-file check know where every file came from. The backend's routes already answer per release and need no change. Navigation is page-only: React state plus `history.pushState`/`popstate` for the steps.

**Tech Stack:** TypeScript strict ESM, React, Vitest (`encoder` project; jsdom + `@testing-library` for components), Playwright for the end-to-end check.

**Spec:** `encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md` (sections 3 and 6; this plan amends both, see Task 8). Decisions taken with the user on 2026-11-07: a pool of releases with per-episode file choice from any release, the record's `release` becoming a list with fonts pooled; Back buttons in steps 2 and 3, Previous episode in step 3, browser Back and Forward between steps, a visibly clickable step bar.

## Scope

In: the pool and per-episode release choice in steps 1–3 and the metadata defaults; the record format change and its readers (encode font names, missing-file grouping, restore and "Fetch again"); the four navigation changes.

Out: browser history for episodes inside step 3 (only steps get history entries); reordering the pool; per-episode episode offsets (one offset applies to every release).

Decisions this plan makes:
- **Pool order** is the order releases were added. When a release is added, every episode that has no file yet takes this release's matched file; episodes that already have one keep it.
- **Removing a release** clears the choices, timings and metadata tracks of the episodes that used it; they show as having no file.
- **A show change** drops the SeaDex-sourced releases from the pool (with the episodes that used them), keeps Anime Tosho and own-file releases: the existing rule applied per release.
- **An offset change** fetches every pooled release again at the new offset, keeping each episode's choice when its file still matches that episode, else falling back as when the release was added.
- **Record format:** `releases: { source, id, group, label }[]` (empty for none) replaces `release`; every `RecordTrack` gains `release: string` (the id of its release in `releases`). `parseRecord` still reads a record with the old `release` field (it becomes a one-item `releases`, and each track's `release` is that id; a `release: null` record becomes `releases: []`: the helper wrote `null` only when no release was picked, so such a record has no tracks), and writes only the new form.
- **Fonts** stay one pooled list (`fonts: string[]`), the union of every used release's fonts; an episode's MKV still carries every font of the record (a release's fonts are small, and a font another release's script names is then available too).
- **Missing files:** a missing track file is reported under its track's release; a missing font under every release in the record whose cached release lists it, or, when no cached release lists it, under all of the record's releases.
- **Step 2 select:** one `<optgroup>` per release (its label), the episode's matched candidates first in each, then that release's unmatched files; "No file" first. "Not matched" lists, per release, its files no episode uses.
- **Previous episode** goes to the previous episode in the step's order (any state), keeping that episode's timing and nudge; it is disabled on the first.
- **Back buttons:** "Back" in steps 2 and 3, left of the primary action, going to the previous step.
- **Browser history:** each step change the user makes pushes `{ step }` with the URL's search kept (the token stays in memory; the URL still carries `?t=` as it did); `popstate` moves to the stored step when `canEnter` allows it, else to the nearest earlier step it allows. The first load replaces the entry with step 1.
- **Step bar:** enabled, non-current steps get a pointer cursor and an underline on hover and focus; the current step is marked as now; disabled steps stay muted with the default cursor.

## Global Constraints

- License: every new file starts with `// SPDX-License-Identifier: LGPL-3.0-or-later`; `npm run licence-check` stays green.
- Documentation standard (`encoder/tests/docs.test.ts` and every review): every export documented (what it is for, what a caller must know); no ruling, task, milestone or internal spec-section references in comments; READMEs updated where an area changes.
- The page imports no runtime value or type from `encoder/src` or `@seikou/fansubs` (its wire types live in `encoder/web/src/api-types.ts`; type imports from `@seikou/nas/nas-api` are fine).
- Look (spec §4): Instrument Sans, tabular numerals for times; colours base `#0F1B2D`, panel `#17273D`, ink `#E9EFF7`, muted `#8FA1BC`, accent `#4D9BFF`, amber `#F0B45B` only for the nudge; single column, 16 px gutters, usable at 375 px; no uppercase labels.
- Every UI task loads the `frontend-design:frontend-design` skill before writing UI code.
- Made-up names only (the repo is public). No new dependencies.
- Commands: `npx vitest run --project encoder`, `npm run typecheck`, `npm run encoder:web:build`, `npx playwright test -c playwright.encoder.config.ts`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VgtGbXVjADUNZTpv1LrJbZ
  ```
- Never push.

## Review Focus

1. **A record saved before this change** (single `release`, or `release: null` with own files): it must load in the helper and encode exactly as before. Tests in Task 1 (`reads the old single-release form`) and Task 6 (`restores an old record`).
2. **Removing or re-fetching a release that episodes use**: no episode may keep a file id that no longer exists in the pool (that would align or mux nothing). Test in Task 2 (`removing a release clears the episodes that used it`, `an offset change keeps a choice only when the file still matches`).
3. **Two releases with the same file or track ids** (ids are only unique within a release; Tosho file ids are numbers, own files are names): every lookup must key on release and file together. Test in Task 2 (`two releases with the same file id stay apart`) and Task 4.
4. **Browser Back to a step that is no longer reachable** (the release was removed after visiting step 3): it must land on the nearest step `canEnter` allows, not a blank step. Test in Task 7.
5. **The encode's font names and the missing-file report across releases**: a font listed by two releases, a release whose cache folder is gone. Test in Task 1.

---

### Task 1: The record names its releases

**Files:**
- Modify: `encoder/src/subs/record.ts`, `encoder/src/subs/episode-subtitles.ts`, `encoder/src/subs/encode-record.ts` (if it reads `release`), `encoder/src/server/record-routes.ts` (if it reads `release`), `encoder/src/subs/README.md`
- Test: `encoder/tests/subs/record.test.ts`, `encoder/tests/subs/episode-subtitles.test.ts`, `encoder/tests/server/record-routes.test.ts`

**Interfaces:**
- Produces: `SubtitleRecord.releases: RecordRelease[]` with `RecordRelease = { source: 'seadex' | 'tosho' | 'local'; id: string; group: string; label: string }`; `RecordTrack.release: string` (an id in `releases`); `parseRecord` accepts the old form as described in Scope and rejects a track whose `release` is not in `releases` (`RecordError` naming `episodes[i].tracks[j].release`); `RecordStore.missingFiles(record)` returns one entry per release with missing files, by the Scope rule; `episodeSubtitleTracks` names fonts from every cached release in `record.releases` (first name found in pool order).

- [ ] **Step 1: Write the failing tests**: `reads the old single-release form` (a `release` record parses to one `releases` entry, tracks carry its id; `release: null` parses to `releases: []`); `writes only the new form`; `rejects a track naming an unknown release`; `missingFiles groups a missing track by its release and a missing font by the releases listing it`; `a font no cached release lists is reported under every release`; `font names come from any release in the pool`; the record route round-trips a two-release record.
- [ ] **Step 2: Run to see them fail** — `npx vitest run --project encoder encoder/tests/subs encoder/tests/server/record-routes.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the encoder project and `npm run typecheck`. Expected: PASS, every existing encode test unchanged.
- [ ] **Step 5: Commit** — `feat(encoder): the subtitle record names each track's release`

---

### Task 2: The page's state holds a pool of releases

**Files:**
- Modify: `encoder/web/src/helper-model.ts`, `encoder/web/src/api-types.ts` (the record's new fields), `encoder/web/src/metadata/metadata-model.ts` (subtitle names per episode's release), `encoder/web/src/steps/match-model.ts` (if it reads the single release), `encoder/web/README.md`
- Test: `encoder/web/src/helper-model.test.ts`, `encoder/web/src/metadata/metadata-model.test.ts`

**Interfaces:**
- Produces:
  - `HelperState.releases: readonly PooledRelease[]` with `PooledRelease = { release: ReleaseAnswer; source: ReleaseSource }` (pool order), replacing `release`/`releaseSource`/`match`;
  - `EpisodeChoice` becomes `'none' | { releaseKey: string; fileId: string; trackIds: readonly string[] }` (an episode with no file has no entry);
  - actions: `addRelease { release: ReleaseAnswer; from: ReleaseSource }` (adds, or replaces the pooled release with the same key, keeping choices whose file still matches), `removeRelease { key: string }`, `chooseFile { episode; releaseKey: string | null; fileId: string | null }`; `setRelease` is removed; `setTitle` drops SeaDex-sourced releases; `setOffset` unchanged (the page re-fetches each release and sends `addRelease` for each);
  - helpers: `releaseOf(state, key): PooledRelease | null`, `episodeFile(state, episode): { pooled: PooledRelease; file: CachedFile } | null`, `candidatesFor(state, episode): { releaseKey; fileId; matched: boolean }[]` (per release in pool order: matched candidates, then that release's unmatched files);
  - `toRecord` writes `releases` (only releases some episode uses, in pool order) and each track's `release`; `fromRecord(record, releases: ReleaseAnswer[], episodes)` restores choices per release;
  - metadata defaults: a subtitle track's default name is `<that episode's release group> full|signs`.

- [ ] **Step 1: Write the failing tests**: `adding a release fills only episodes without a file`; `re-adding a release keeps choices whose file still matches`; `removing a release clears the episodes that used it`; `a show change drops SeaDex releases and keeps Tosho and own files`; `an offset change keeps a choice only when the file still matches` (via re-`addRelease`); `two releases with the same file id stay apart` (choose release B's file `7101` for episode 1 while release A also has `7101`; `episodeFile` returns B's); `toRecord writes only used releases with each track's release`; `fromRecord restores per-release choices`; `subtitle default names follow each episode's release group`.
- [ ] **Step 2: Run to see them fail** — `npx vitest run --project encoder encoder/web/src/helper-model.test.ts encoder/web/src/metadata`.
- [ ] **Step 3: Implement**, updating the callers in the steps only as far as the build needs (the UI changes are the next tasks; keep the existing tests passing or adapt them to the new action names).
- [ ] **Step 4: Run** the encoder project, `npm run typecheck`, `npm run encoder:web:build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): the helper keeps a pool of releases`

---

### Task 3: Step 1 adds releases to the pool

Load `frontend-design:frontend-design` first.

**Files:**
- Modify: `encoder/web/src/steps/ReleaseStep.tsx`, `encoder/web/src/steps/release-model.ts`
- Test: `encoder/web/src/steps/ReleaseStep.test.tsx`, `encoder/web/src/steps/release-model.test.ts`

**Interfaces:**
- Produces: a "Releases in use" list above the SeaDex list (each: label, group, source, summary from `releaseSummary`, a "Remove" button); picking a SeaDex release, an Anime Tosho result or adding own files adds to the pool (`addRelease`), a release already pooled shows as added and picking it again re-fetches it; the offset change re-fetches every pooled release; "Next" is enabled when any episode has a file.

- [ ] **Step 1: Write the failing tests**: `picking two releases lists both in use`; `Remove drops a release and its episodes`; `an already pooled release shows as added`; `changing the offset fetches every pooled release again`; existing step 1 tests adapted.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project encoder encoder/web/src` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): helper step 1 adds releases to a pool`

---

### Task 4: Step 2 picks each episode's file from any release, with Back

Load `frontend-design:frontend-design` first.

**Files:**
- Modify: `encoder/web/src/steps/MatchStep.tsx`, `encoder/web/src/steps/match-model.ts`
- Test: `encoder/web/src/steps/MatchStep.test.tsx`

**Interfaces:**
- Produces: each row's select per Scope (one `<optgroup>` per release; option values encode release and file, e.g. `${releaseKey}\u0000${fileId}`, never the file id alone); the row's tracks are its chosen file's; "Not matched" per release; a "Back" button left of "Next" (`goTo` step 1).

- [ ] **Step 1: Write the failing tests**: `rows offer files from every pooled release, grouped`; `choosing another release's file swaps the tracks`; `same file id in two releases picks the right one`; `Back goes to step 1`; existing tests adapted.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): helper step 2 picks files from any release`

---

### Task 5: Step 3 uses each episode's release, with Previous episode and Back

Load `frontend-design:frontend-design` first.

**Files:**
- Modify: `encoder/web/src/steps/LineUpStep.tsx`, `encoder/web/src/steps/lineup-model.ts`
- Test: `encoder/web/src/steps/LineUpStep.test.tsx`

**Interfaces:**
- Produces: alignment, the retimed subtitle URL and the fonts use the shown episode's release (`episodeFile`); `previousEpisode(order, from): number | null`; a "Previous episode" button (disabled on the first) and a "Back" button (`goTo` step 2) beside the existing actions; the strip and the nudge keep each episode's own timing when moving back and forth.

- [ ] **Step 1: Write the failing tests**: `episode 2 from another release aligns and previews that release's file` (`api.align` and `api.subtitleUrl` called with release B's key); `Previous episode returns with its nudge kept`; `Previous episode is disabled on the first`; `Back goes to step 2`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): helper step 3 follows each episode's release; previous episode and back`

---

### Task 6: Restore and "Fetch again" for several releases

**Files:**
- Modify: `encoder/web/src/SaveBar.tsx`
- Test: `encoder/web/src/SaveBar.test.tsx` (or the App tests that cover SaveBar)

**Interfaces:**
- Produces: on load, every release in the record is fetched (`api.release(id, offset)`), the found ones restored with `fromRecord`; each missing release gets its own "Fetch <label> again" (own files: "add them again"); Save stays off while any release the record's episodes use is missing and not replaced.

- [ ] **Step 1: Write the failing tests**: `restores a two-release record`; `restores an old record` (single `release` form from the server); `offers to fetch each missing release`; `Save is off until every used release is back`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): the helper restores and re-fetches several releases`

---

### Task 7: Browser Back and Forward, and a step bar that looks clickable

Load `frontend-design:frontend-design` first.

**Files:**
- Create: `encoder/web/src/step-history.ts`
- Modify: `encoder/web/src/App.tsx`, `encoder/web/src/StepBar.tsx`, `encoder/web/src/styles.css`
- Test: `encoder/web/src/step-history.test.ts`, `encoder/web/src/App.test.tsx`

**Interfaces:**
- Produces: `useStepHistory(step: Step, canEnter: (s: Step) => boolean, goTo: (s: Step) => void): void` (pushes on a user step change, replaces on first load, listens to `popstate` per Scope, keeps `location.search`); the step bar styling per Scope.

- [ ] **Step 1: Write the failing tests**: `a step change pushes a history entry`; `popstate goes to the stored step`; `popstate to an unreachable step lands on the nearest allowed earlier one`; `the first load replaces rather than pushes`; `the URL's search is kept`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the encoder project and `npm run encoder:web:build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): browser Back and Forward move between the helper's steps`

---

### Task 8: End-to-end check and documentation

**Files:**
- Modify: `encoder/tests/e2e/helper.spec.ts`, `encoder/README.md`, `encoder/web/README.md`, `encoder/src/subs/README.md`, `encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md` (§3 step 1 and step 2: a pool of releases, per-episode choice from any; §3 navigation; §6 record: `releases` and each track's `release`; a dated amendment note)

- [ ] **Step 1: Extend the E2E**: pick GroupA, then add GroupB; in step 2 set episode 1 to GroupB's file and keep episode 2 on GroupA's; step 3 shows episode 1 lining up from GroupB (its timing is the same fixture timing, so "Shifted +1.20 s"); use Previous episode; press the browser Back button twice and land on step 1, Forward to step 2; save, reload, and both releases restore; the record on disk has two `releases` and per-track `release` ids.
- [ ] **Step 2: Run it** — `npx playwright test -c playwright.encoder.config.ts`. Expected: PASS.
- [ ] **Step 3: Update the documentation** listed under Files.
- [ ] **Step 4: Full verification** — `npm run typecheck && npx vitest run --project encoder && npm run licence-check && npx playwright test -c playwright.encoder.config.ts`, plus `npm test` (report `server/src/rtc/peer.test.ts` by name if it fails: it fails on this machine at earlier commits too).
- [ ] **Step 5: Commit** — `test(encoder): multiple releases and navigation end to end; docs`
