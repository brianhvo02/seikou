# Encoder Library by Show Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The encoder's Library lists NAS discs by the NAS's own shows, seasons and films, shows what is already encoded, and gets a season from "To encode" to queued NAS encodes through one required step: checking each disc.

**Architecture:** The encoder reads the NAS's catalogue (`titles`, `titles/<id>`, `admin/unsorted`) and its Encodes library's ids (`encodes/ids`, from plan A) and joins them to its own mirror keys. A disc's per-episode choice becomes an `EncodeTitle` (plan A's type: AniList, TMDB TV season, TMDB film or own title) instead of an AniList id. The Episodes page is prefilled from the NAS, and marking a disc checked records it and, when the title changed, saves the owner's choice on the NAS. A season's Queue sends one NAS job per disc and playlist, encoding only the episodes still to do while keeping the disc's saved subtitles.

**Tech Stack:** TypeScript (strict), Node 24 backend (`encoder/src/server`), React 19 page (`encoder/web`), Vitest, Playwright.

**Spec:** `encoder/docs/superpowers/specs/2026-11-10-library-by-show-design.md` (approved 2026-11-10). **Depends on** `docs/superpowers/plans/2026-11-10-encodes-any-title.md` (plan A): run plan A first; this plan uses its `EncodeTitle`, `encodeId`, `titleTags`, `nasTitleId` and `GET encodes/ids`.

## Global Constraints

- Everything in the parent designs holds: the encoder is a local app on 127.0.0.1 with its token; the NAS's API is the only way in; no token or device key in the page, logs or a job's `cli`; LGPL-3.0-or-later headers; made-up names in tests (AniList and TMDB ids from 990000 up).
- The NAS is written only when the user marks a disc checked and only then for a disc whose episodes are all under one title that differs from the NAS's match (spec §2). Nothing else in this plan writes to the NAS's library.
- Queue for a season stays disabled until every disc with episodes to encode is checked (the user: "I need to check first").
- An episode already in the Encodes library is never queued.
- Title search uses the NAS's own lookup (`GET admin/lookup?q=&source=anilist|tmdb|own`, which holds the TMDB key) and offers entry by hand (`POST admin/titles`) when nothing matches; a disc can't be checked while an episode has no title.
- Any UI work loads the `frontend-design` skill first and keeps the app's look (dark only, `encoder/web/src/styles.css`); the accepted mockup is `.superpowers/brainstorm/25830-1794293197/content/library-by-show.html` (local).
- The encoder's tests are `npx vitest run --project encoder <file>`; page tests `npx vitest run <file>` (jsdom); typecheck `tsconfig.encoder.json`, `tsconfig.encoder-web.json`, `npm run typecheck`.

## Review Focus

1. **A season whose NAS episode list is wrong or missing** (the reason for checking): the Episodes page opens with no grouping filled in rather than a wrong one, and the user groups by hand. Pinned in Task 4.
2. **A disc whose episodes span two titles** (end of season 1, start of season 2): marking it checked writes nothing to the NAS and the page says so. Pinned in Task 4.
3. **Some of a disc's episodes already encoded, with saved subtitles**: only the rest are encoded, with their saved subtitles, and the queue does not refuse with `record-mismatch`. Pinned in Task 5.
4. **The NAS unreachable while browsing by show**: the last listing stays, marked, and nothing pretends to be checked or encoded. Pinned in Task 3.
5. **An AniList choice saved before this plan** (the `anilist` map from the previous plan): read as AniList titles, kept, and winning over the NAS's match. Pinned in Task 1.

---

### Task 1: Episode titles instead of AniList ids

**Files:**
- Modify: `encoder/src/plan/episode-info.ts` (`EpisodeAniList` → `EpisodeTitle`; `anilist` map → `titles`; read old files), `encoder/src/mux/episode-tags.ts`, `encoder/src/encode.ts`, `encoder/src/nas/destination.ts`, `encoder/src/nas/upload.ts` callers, `encoder/src/server/jobs.ts`, `encoder/src/cli.ts`, `encoder/src/server/episode-info-routes.ts`, the page (`encoder/web/src/api-types.ts`, `episode-info-model.ts`, `EpisodeAniList.tsx` renamed `EpisodeTitlePicker.tsx`, `QueueDialog.tsx`)
- Test: the files' existing tests, plus `encoder/tests/plan/episode-info.test.ts` cases below

**Interfaces:**
- Consumes: plan A's `EncodeTitle`, `encodeId`, `titleTags`, `sameTitle` from `@seikou/nas`.
- Produces:
  ```ts
  export interface EpisodeTitle { readonly title: EncodeTitle; readonly episode: number; readonly name: string | null }
  export interface EpisodeInfo {
    readonly chapterNames: Readonly<Record<string, string>>;
    /** First playlist chapter of an episode → its title and number. */
    readonly titles: Readonly<Record<string, EpisodeTitle>>;
    /** Set by Task 4; absent until then. */
    readonly checked?: CheckedMark;
    readonly savedAt: string;
  }
  ```
  An info file written by the previous plan (`anilist: { [chapter]: { anilistId, episode, title } }`) is read as `titles` with `{ source: 'anilist', anilistId }` and saved in the new form on its next save. Tags: `titleTags(title)` plus `EPISODE` and, when the title is not AniList, `TITLE_NAME` (the episode's show name) — `episodeTags` takes `EpisodeTitle | null`. Upload name and duplicate check use `encodeId(title, episode)`. The NAS queue checks (`missing titles`, `duplicates`) keep their codes (`nas-needs-anilist` is renamed `nas-needs-title`; the page shows it the same way).
- [ ] **Step 1: Failing tests**: an old-format info file reads as AniList titles and round-trips in the new form; `episodeTags` for a TMDB TV title writes `SEIKOU_TITLE`, `SEASON`, `EPISODE`, `TITLE_NAME` and no `ANILIST_ID`; for AniList it writes exactly today's tags; the queue refuses two episodes with the same `encodeId` (`nas-duplicate-episodes`) and an episode with no title (`nas-needs-title`); the upload name is `tv990101s1-2.mkv` for a TMDB episode.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (the Episodes page's picker keeps today's AniList search; Task 2 widens it). **Step 4:** PASS: `npx vitest run --project encoder`, page tests, typechecks.
- [ ] **Step 5: Commit** `feat(encoder): episode titles beyond AniList`.

### Task 2: Mixed title search and entry by hand

**Files:**
- Modify: `encoder/src/server/nas-routes.ts` (two routes), `encoder/web/src/app/EpisodeTitlePicker.tsx`, `encoder/web/src/app/app-api.ts`, `api-types.ts`, `styles.css`
- Test: `encoder/tests/server/nas-routes.test.ts`, `encoder/web/src/app/EpisodeTitlePicker.test.tsx`

**Interfaces:**
- Produces: `GET /api/nas/lookup?q=&source=anilist|tmdb|own` → `{ titles: TitleSummary[] }` (the NAS's `admin/lookup`, errors passed through: 503 `source-unreachable`, 429 when the NAS limits, 409 `nas-not-paired`); `POST /api/nas/own-titles` body `{ kind: 'series' | 'movie', name, seasons }` → the NAS's `OwnTitle` (`POST admin/titles`). The picker searches AniList and TMDB at once (two lookups, merged, AniList first), shows the user's own NAS titles too, asks for the season number when a TMDB TV or own series title is picked (prefilled from the NAS's match when there is one), and offers **Add by hand** (name, series or film, season) when nothing fits, creating the own title on the NAS. Unpaired, the picker keeps today's AniList-only search.
- [ ] **Step 1: Failing tests** against `encoder/tests/nas/nas-test-server.ts` (its `METADATA_FIXTURE`-style recorded AniList and TMDB answers; add made-up TMDB TV 990101 "Lantern Harbour" if missing): lookup by source answers the recorded titles; an own title is created and then found by `source=own`; unpaired is 409. Component: a search lists AniList then TMDB results; picking the TMDB show asks its season; Add by hand creates and picks an own title; the picker refuses to finish without a season for a series.
- [ ] **Step 2–4:** FAIL, implement (load `frontend-design` first), PASS.
- [ ] **Step 5: Commit** `feat(encoder): find a show on AniList or TMDB, or add it by hand`.

### Task 3: The NAS's catalogue in the encoder

**Files:**
- Create: `encoder/src/nas/nas-titles.ts`, `encoder/src/server/nas-title-routes.ts`
- Modify: `encoder/src/server/server.ts`, `encoder/src/nas/README.md`, `encoder/src/server/README.md`, `encoder/web/src/api-types.ts`, `app-api.ts`
- Test: `encoder/tests/nas/nas-titles.test.ts`, `encoder/tests/server/nas-title-routes.test.ts`

**Interfaces:**
- Consumes: `NasClient`, `NasLibrary` (disc id → mirror key), plan A's `GET encodes/ids`, `parseEncodeId`.
- Produces:
  ```ts
  /** A season id from the NAS → the title its encodes are tagged with, or null when the NAS doesn't know the entry yet. */
  export function seasonTitle(seasonId: string): EncodeTitle | null;
  // 'anilist:N#season' and 'anilist:N#discs' → anilist N; 'tmdb-tv:N#s<n>' → tmdb-tv N season n;
  // 'tmdb-movie:N#discs' → tmdb-movie N; 'own:<uuid>#s<n>' → own season n; 'own:<uuid>#discs' → own, season null;
  // anything else (e.g. 'anilist:N#s<n>' before the chain is loaded) → null
  ```
  Routes (behind the token; 409 `nas-not-paired`):
  - `GET /api/nas/shows` → `{ shows: [{ titleId, name, poster, kind, seasons, films, encoded, toEncode }], unsorted: [{ key, label, relPath }], reachable, stale }` — `encoded`/`toEncode` count the NAS's episodes of the show found / not found in `encodes/ids`; `unsorted` from `admin/unsorted` joined to mirror keys; while the NAS is unreachable, the last answer (kept in `<data>/nas-titles.json`) with `reachable: false`.
  - `GET /api/nas/shows/<titleId>` → `{ title, seasons: [{ id, label, number, title: EncodeTitle | null, discs: [{ key, discId, label, playlists: [{ id, episodes: [{ number, name, encoded }] }], checked: boolean }] }] }` (films are seasons with `number: null`). A disc's episodes come from the season's `episodes` (by disc id and playlist id); a disc with none listed has `playlists: []` and is checked like any other.
  - Posters through the backend (`/api/nas/art/<artId>`, passing the NAS's `art/<id>`), as covers are passed today.
- [ ] **Step 1: Failing tests**: `seasonTitle` for every form above; against the stand-in (synthetic discs filed under the made-up titles of `tests/e2e/fixtures/nas-metadata.json`, and one encode of AniList 990001 episode 1 in its encodes folder): `shows` lists them with counts, `unsorted` lists the unsorted synthetic discs, `shows/<id>` gives seasons → discs → playlists → episodes with `encoded: true` for 990001-1 only; the stand-in stopped → the last answer with `reachable: false`.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5: Commit** `feat(encoder): read the NAS's shows, seasons and encodes`.

### Task 4: Prefill, check and the NAS choice

**Files:**
- Modify: `encoder/src/plan/episode-info.ts` (`CheckedMark`), `encoder/src/server/episode-info-routes.ts` (prefill and check routes), `encoder/web/src/app/EpisodesPage.tsx`, `episode-info-model.ts`, `api-types.ts`, `app-api.ts`
- Test: `encoder/tests/server/episode-info-routes.test.ts`, `encoder/web/src/app/EpisodesPage.test.tsx`, `episode-info-model.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CheckedMark { readonly episodeSpec: string; readonly signature: string /* the titles map, canonical JSON */; readonly at: string }
  /** Checked while the grouping and titles are those it was marked with. */
  export function isChecked(info: EpisodeInfo | null, episodeSpec: string, chapters: number): boolean;
  ```
  - `GET /api/discs/<key>/playlists/<id>/nas-prefill` → `{ episodes: [{ number, name }], title: EncodeTitle | null, episodeSpec: string | null }`: the NAS's episodes on that disc and playlist, the season's title (`seasonTitle`), and a grouping only when the playlist's chapter count divides evenly by the episode count (`k` equal groups of consecutive chapters), else null.
  - `POST /api/discs/<key>/playlists/<id>/check` body `{ episodeSpec }` → `{ info, nasChoice: 'saved' | 'unchanged' | 'mixed' | 'failed', message? }`: refuses 409 `needs-title` while an episode lacks a title; writes `checked`; when every episode's title is the same and differs from the NAS's match, `PUT admin/discs/<discId>/choice` `{ choice: { kind: 'title', titleId: nasTitleId(title), season, disc: null } }` (`season` from the title for TMDB TV and own series, else null; the NAS's answer decides — a refusal is `failed` with its message and the disc stays checked); titles spanning two shows answer `mixed`.
  - The Episodes page: opened for a NAS disc whose info has no titles, applies the prefill (grouping when given, titles numbered from the NAS's episode numbers) as unsaved suggestions, as the existing prefill does; a saved choice wins (Review Focus 5). A **Mark checked** button shows the result line ("Checked. The NAS now files this disc under Lantern Harbour." / "Checked. The episodes span two shows, so the NAS was left as it is." / "Checked. The NAS refused the change: …").
- [ ] **Step 1: Failing tests**: prefill for 4 episodes over 8 chapters gives `1-2,3-4,5-6,7-8`; over 7 chapters gives `episodeSpec: null`; check refuses without titles; check with one changed title PUTs the choice to the stand-in and the NAS's `titles/<id>` then lists the disc under it; check with two titles writes nothing and answers `mixed`; regrouping after check makes `isChecked` false; the page applies a prefill only when no titles are saved.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5: Commit** `feat(encoder): prefill from the NAS, check a disc, file it on the NAS`.

### Task 5: Encoding only what's left, with the saved subtitles

**Files:**
- Modify: `encoder/src/server/jobs.ts`, `encoder/src/server/job-routes.ts`, `encoder/web/src/api-types.ts`, `encoder/web/src/app/job-model.ts`, `QueueDialog.tsx`
- Test: `encoder/tests/server/jobs.test.ts` (or `jobs-nas.test.ts`), `encoder/web/src/app/job-model.test.ts`, `QueueDialog.test.tsx`

**Interfaces:**
- Produces: `JobInput.only?: number[]` (1-based episodes of `episodeSpec` to encode; the rest are created `state: 'done'` with `skipped: true` and never encoded or uploaded); the record check stays against the full `episodeSpec`, so a record made for the whole disc still matches. `JobEpisode.skipped?: true`, shown as "Already encoded". The queue dialog accepts a list of jobs to queue with one profile (`QueueDialog` prop `batch: { discKey, playlistId, episodeSpec, only }[]`), sends them in order, and reports each refusal.
- [ ] **Step 1: Failing tests**: a 3-episode job with `only: [2, 3]` and a saved record for `1-…` queues without `record-mismatch`, encodes episodes 2 and 3 only (fake encoder), and episode 1 shows `skipped`; `only` with an index outside the list is 400 `bad-request`; the batch dialog queues two jobs with one profile and shows a refusal of the second.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5: Commit** `feat(encoder): queue only the episodes left to encode`.

### Task 6: The Library by show

**Files:**
- Create: `encoder/web/src/app/ShowsPage.tsx`, `ShowPage.tsx`, `shows-model.ts` (pure)
- Modify: `encoder/web/src/app/LibraryPage.tsx` (By show / By folder / This Mac switch; By show the default when paired), `router.ts` (`/shows/<titleId>`, `/shows/<titleId>/<seasonId>`), `styles.css`
- Test: `shows-model.test.ts`, `ShowPage.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces (`shows-model.ts`): `seasonState(season) → { toEncode: number; uncheckedDiscs: string[]; jobs: { discKey, playlistId, episodeSpec, only }[] }` — `only` from the episodes not encoded, mapped to the disc's checked grouping by episode number (a playlist whose episodes the NAS doesn't list queues the whole checked grouping).
- Layout per the accepted mockup: shows with poster, seasons and films, disc count and an encoded meter; the unsorted group under them; a season page, disc by disc, episodes marked Encoded / To encode, **Check episodes** opening the Episodes page (and returning to the season), **Queue N episodes to the NAS** disabled with the reason ("Check discs 2 and 3 first") until `uncheckedDiscs` is empty, opening the batch queue dialog. A show or season is reachable from its film rows too.
- [ ] **Step 1: Failing tests**: `seasonState` for a season where disc 1 is all encoded, disc 2 checked with eps 6–8 to encode, disc 3 unchecked → `toEncode: 7`, `uncheckedDiscs: ['Disc 3']`, one job for disc 2 with `only` for 6–8; the season page disables Queue with that reason, enables it once disc 3 is checked, and opens the batch dialog with both jobs.
- [ ] **Step 2–4:** FAIL, implement (load `frontend-design` first; check phone and desktop widths in the browser), PASS. **Step 5: Commit** `feat(encoder): the Library by show`.

### Task 7: End to end and docs

**Files:**
- Modify: `encoder/tests/e2e/nas.spec.ts`, `encoder/README.md`, `encoder/src/server/README.md`, `encoder/src/nas/README.md`, `CLAUDE.md` (the encoder bullet), `docs/known-issues.md` (decisions left open)
- [ ] **Step 1:** Extend the `nas` project: pair → Library opens By show → the made-up show → a season → Check episodes on its disc (prefilled; confirm) → back, the disc checked → Queue → (tool-gated) fetch, encode, upload → the season shows the episodes Encoded. A second disc changed to a TMDB title while checking is filed under it on the NAS (`titles` on the stand-in).
- [ ] **Step 2: Run** `npx playwright test -c playwright.encoder.config.ts --project nas` — PASS; `npx vitest run --project encoder`, page tests, `npm run typecheck`, `npm run licence-check`.
- [ ] **Step 3: Commit** `test(e2e): queue a season from the Library by show` and `docs: the encoder's Library by show`.
