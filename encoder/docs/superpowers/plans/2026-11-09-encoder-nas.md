# Encoder and the NAS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The encoder app pairs with Seikou's NAS, encodes the NAS's discs by fetching only the clips each episode needs, writes named chapters and AniList tags into every MKV, and uploads finished episodes into the NAS's Encodes library.

**Architecture:** A NAS disc becomes a *mirror folder* in the data directory: every metadata file whole, and every `.m2ts` a sparse file of its true size holding only the byte ranges fetched so far (a `fetch.json` beside it says which). To the rest of the encoder a mirror is an ordinary disc folder, so the planner, BestSource, `discKeyOfFolder` (the same names and sizes give the NAS's own key), the record and the disc routes keep working; a fetch step fills the clips an episode needs before it is encoded and empties them after. A NAS client (pairing, session tokens, range reads, the resumable upload) lives in `encoder/src/nas/`, and the job runner gains fetch and upload steps for jobs whose destination is the NAS. Chapter names and per-episode AniList choices move to a per-disc-and-playlist file the Episodes page edits, and `encodePlan` writes them as chapter titles and Matroska tags.

**Tech Stack:** TypeScript (strict), Node 24 (`fetch`, `webcrypto`, `fs.statfs`), React 19 + Vite for the page, Vitest, Playwright; Seikou's NAS server (`server/src`) in-process for integration tests; `@seikou/matroska`, `@seikou/nas`, `@seikou/titles`.

**Spec:** `encoder/docs/superpowers/specs/2026-11-08-encoder-nas-design.md` (with its sibling `docs/superpowers/specs/2026-11-08-encodes-library-design.md`, already implemented: the NAS's upload API and the tags it reads).

## Global Constraints

- New files: `// SPDX-License-Identifier: LGPL-3.0-or-later`. No ffmpeg in `encoder/src`; tools stay subprocesses.
- The NAS's API is the only way in: no SMB, no ssh. Pairing is an owner device pairing (`pair/redeem`, then `session/challenge` + `session` signed with the device's P-256 key), as `scripts/verify-level.ts` does.
- The device key and session token never appear in logs, a job's `cli`, an error message or any answer to the page. `<data>/nas.json` is written with mode `0600`.
- Uploads go over HTTPS only (the NAS answers 403 `https-only` otherwise). A NAS address is `https://…/api/` or, for tests only, `http://127.0.0.1:<port>/api/` / `http://localhost:<port>/api/`.
- Tag names, exactly: `ANILIST_ID`, `EPISODE`, `EPISODE_TITLE`, `SEIKOU_DISC_KEY`, `SEIKOU_PLAYLIST`, `SEIKOU_EPISODE_START_MS`, `ENCODER`. Segment-level (`MkvInput.tags`).
- Chapter name picker values, exactly: `Avant`, `Opening`, `Part A`, `Part B`, `Ending`, `Part C`, `Preview`, plus Custom (free text).
- The record's `anilist.episodeOffset` is the fansub release's numbering and is never used as an AniList episode number.
- A fetched disc never fills the drive: free space is checked before a fetch, and a job holds at most the clips of the episode being encoded and the next one.
- The encoder never marks an episode uploaded before the NAS's `complete` answer.
- The repo is public: made-up names in tests and fixtures (AniList ids from 990000 up, as `fixtures/encodes` uses).
- Strict TS, `import type` for types, no unused locals. The encoder's tests are the `encoder` Vitest project (`npx vitest run --project encoder <file>`); the page's typecheck is `tsconfig.encoder-web.json`.
- Any UI task loads the `frontend-design` skill first and keeps the app's existing look (`encoder/web/src/styles.css` tokens).

## Review Focus

1. **The NAS drops away mid-fetch or mid-upload** (Wi-Fi gone, the Mac sleeps, the NAS restarts): the job shows "Waiting for the NAS", retries every minute, and resumes from the ranges already stored or sent, never re-fetching stored bytes or re-encoding an episode. Pinned in Task 6 (fetch resume) and Task 9 (upload resume, waiting).
2. **The disc on the NAS changed or vanished after it was queued** (re-ripped, moved, a file size differs): the fetch refuses with `disc-changed` naming the disc, the job fails with that message, and no clip of the old disc is mixed with the new one. Pinned in Task 6.
3. **Not enough room on the Mac** for the next episode's clips: the job fails before fetching, saying how much room it needs. Pinned in Task 6.
4. **The app quits mid-upload and the job is retried a day later**: the stored upload id resumes it; when the NAS has swept it (404), a new upload starts from the kept MKV, with no re-encode. Pinned in Task 9.
5. **An episode was already uploaded and is re-encoded**: the NAS replaces it after the new file is whole; a 409 `in-progress` for the same name from this job's own earlier upload resumes that upload rather than failing. Pinned in Task 9.

---

## File map

| Path | Responsibility | Task |
| --- | --- | --- |
| `encoder/src/plan/episode-info.ts` | `EpisodeInfoStore`: chapter names and per-episode AniList choices per disc and playlist (`<data>/chapters/<disc key>/<playlist>.json`); migration of a record's chapter names | 1 |
| `encoder/src/server/episode-info-routes.ts` | `GET`/`PUT /api/discs/<key>/playlists/<id>/info` | 1 |
| `encoder/src/plan/episodes.ts` | `EpisodeChapter.playlistChapter` | 2 |
| `encoder/src/encode.ts`, `encoder/src/mux/episode-tags.ts` | chapter titles and tags in each MKV | 2 |
| `encoder/src/server/anilist-routes.ts` | app-level AniList search, entry with sequel, episode titles, cover | 3 |
| `encoder/web/src/app/EpisodesPage.tsx`, `ChapterList.tsx`, `ChapterNamePicker.tsx`, `EpisodeAniList.tsx`, `episode-info-model.ts` | chapter names and AniList per episode on the Episodes page | 4 |
| `encoder/src/nas/client.ts`, `encoder/src/nas/pairing.ts`, `encoder/src/nas/nas-store.ts`, `encoder/src/server/nas-routes.ts`, `encoder/web/src/app/NasPairing.tsx` | NAS client, pairing, `nas.json`, Settings | 5 |
| `encoder/src/nas/mirror.ts`, `encoder/src/nas/fetch.ts` | mirror folders, sparse clips, range fetch with holders, free space | 6 |
| `encoder/src/nas/nas-library.ts`, `encoder/src/server/library.ts`, `sessions.ts`, `disc-routes.ts`, `encoder/web/src/app/LibraryPage.tsx` | NAS discs in the library, opened through mirrors, unfetched ranges read through from the NAS | 7 |
| `encoder/src/encode.ts`, `encoder/src/server/disc-routes.ts`, `align-routes.ts` | probe only the clips of wanted episodes; the line-up fetches its episode's clips | 8 |
| `encoder/src/nas/upload.ts`, `encoder/src/server/jobs.ts`, `profiles.ts` | NAS destination, fetch and upload steps | 9 |
| `encoder/web/src/app/QueueDialog.tsx`, `QueuePage.tsx`, `SettingsPage.tsx`, `job-model.ts` | destination control, step progress | 10 |
| `encoder/src/cli.ts` | `nas:<key>` discs, `--nas`, `nas pair|status|unpair` | 11 |
| docs, `encoder/tests/e2e/nas.spec.ts` | README, CLAUDE.md, `docs/nas.md`, the end-to-end check | 12 |

---

### Task 1: The episode info store

Chapter names and AniList choices live in one file per disc and playlist, keyed so that regrouping episodes keeps them.

**Files:**
- Create: `encoder/src/plan/episode-info.ts`, `encoder/src/server/episode-info-routes.ts`
- Modify: `encoder/src/server/server.ts` (route table), `encoder/src/subs/record.ts` and `encoder/src/server/record-routes.ts` (stop writing chapter names; migrate on load), `encoder/web/src/metadata/metadata-model.ts`, `MetadataPanel.tsx` (read and write names through the new route), `encoder/web/src/api-types.ts`, `encoder/web/src/app/app-api.ts`, `encoder/web/src/api.ts`
- Test: `encoder/tests/plan/episode-info.test.ts`, `encoder/tests/server/episode-info-routes.test.ts`, existing record and metadata-model tests

**Interfaces:**
- Produces (backend, `episode-info.ts`):
  ```ts
  export const CHAPTER_NAMES = ['Avant', 'Opening', 'Part A', 'Part B', 'Ending', 'Part C', 'Preview'] as const;
  /** AniList's place for one episode, keyed in the file by the playlist chapter the episode starts at. */
  export interface EpisodeAniList { readonly anilistId: number; readonly episode: number; readonly title: string | null }
  export interface EpisodeInfo {
    /** Playlist chapter number (1-based, as a string key) → name; a chapter with no entry keeps the encoder's naming. */
    readonly chapterNames: Readonly<Record<string, string>>;
    /** First playlist chapter of an episode (as a string key) → its AniList entry and number. */
    readonly anilist: Readonly<Record<string, EpisodeAniList>>;
    /** ISO 8601, set by the store on save. */
    readonly savedAt: string;
  }
  export class EpisodeInfoError extends Error { constructor(readonly code: 'bad-info' | 'info-unreadable', message: string) }
  export class EpisodeInfoStore {
    constructor(dataDir: string);
    read(discKey: string, playlistId: string): Promise<EpisodeInfo | null>;      // null when no file
    save(discKey: string, playlistId: string, info: Omit<EpisodeInfo, 'savedAt'>): Promise<EpisodeInfo>; // atomic (tmp + rename)
  }
  export function parseEpisodeInfo(value: unknown): Omit<EpisodeInfo, 'savedAt'>; // throws EpisodeInfoError('bad-info')
  /** The name chapter `n` (1-based, playlist numbering) gets, or null for the encoder's own. */
  export function chapterName(info: EpisodeInfo | null, n: number): string | null;
  /** Moves a record's per-episode chapter names into `info` (first time only: names already in `info` win). */
  export function migrateRecordChapters(info: EpisodeInfo | null, record: SubtitleRecord, episodeSpec: string, chapters: number): Omit<EpisodeInfo, 'savedAt'> | null; // null when nothing to move
  ```
- Produces (routes): `GET /api/discs/<discKey>/playlists/<id>/info` → `{ info: EpisodeInfo | null }`; `PUT` same path, body `{ chapterNames, anilist }` → `{ info }`. Errors: 404 `disc-changed` (unknown key, as `knownDisc`), 400 `bad-request` (playlist id not five digits), 400 `bad-info` (with `message`), 413 `too-large` (body over 64 KiB), 500 `info-unreadable`.
- Produces (page): `AppApi.episodeInfo(discKey, playlistId): Promise<EpisodeInfo | null>` and `AppApi.saveEpisodeInfo(discKey, playlistId, info): Promise<EpisodeInfo>`; the same two on the helper's session API client for the metadata panel, calling the same routes with the session's `discKey` and `playlistId`.

Validation rules (`parseEpisodeInfo`): keys are decimal integers ≥ 1 without leading zeros; a chapter name is trimmed, 1–100 characters, no control characters; `anilistId` and `episode` are integers ≥ 1; `title` is null or a string of at most 300 characters; at most 999 entries in each map.

- [ ] **Step 1: Write the failing store tests** in `encoder/tests/plan/episode-info.test.ts`:
  - `saves and reads back, stamping savedAt` (a temp data dir; `read` before any save is `null`; the file is at `<data>/chapters/<key>/<playlist>.json`).
  - `refuses a bad name, key or number` (`'0'` key, `'01'` key, empty name, `episode: 0`, `anilistId: 1.5` each throw `EpisodeInfoError` with code `bad-info`).
  - `an unreadable file is info-unreadable` (write `{` to the file; `read` rejects with code `info-unreadable`).
  - `chapterName` returns the stored name for a chapter and null for one without.
  - `migrateRecordChapters maps episode-local names onto playlist chapters`: spec `1-3,4-6` on 6 chapters, a record whose episode 2 `metadata.chapters` is `['Opening', '', 'Ending']` gives `chapterNames` `{ '4': 'Opening', '6': 'Ending' }`; names already in `info` are kept; a record with no non-empty, non-`Chapter n` name gives null.
- [ ] **Step 2: Run** `npx vitest run --project encoder tests/plan/episode-info.test.ts` — expected FAIL (module missing).
- [ ] **Step 3: Implement `episode-info.ts`** to the interface above.
- [ ] **Step 4: Write the failing route tests** (`encoder/tests/server/episode-info-routes.test.ts`, on the helper server over `encoder/fixtures/disc-speech` as the other route tests start it): GET with nothing saved is `{ info: null }`; PUT then GET round-trips; PUT with a bad name is 400 `bad-info`; an unknown disc key is 404 `disc-changed`; a 70 KiB body is 413.
- [ ] **Step 5: Implement the routes** and register them in `server.ts`'s app routes.
- [ ] **Step 6: Record migration.** The record keeps its `metadata.chapters` field in the file format (older encoders read it) but the backend no longer writes names there: on `PUT …/record` it saves `chapters: []` for every episode; on `GET …/record`, when the saved record has chapter names, it first calls `migrateRecordChapters` and saves the result into the episode info file (only when that file is missing or lacks those chapters), then answers. Add tests to the existing record-routes test: saving a record with chapter names stores `[]`; loading an old record with names moves them into the info file once.
- [ ] **Step 7: Metadata panel.** `metadata-model.ts` and `MetadataPanel.tsx` read chapter names from `episodeInfo` and write them with `saveEpisodeInfo` (same picker values as Task 4 are not needed here: the panel keeps its free-text fields, mapping each episode-local field to its playlist chapter by the session's episodes). Update the model's tests for the new source.
- [ ] **Step 8: Run** `npx vitest run --project encoder` and `npx tsc -p tsconfig.encoder.json --noEmit && npx tsc -p tsconfig.encoder-web.json --noEmit` — expected all pass.
- [ ] **Step 9: Commit** `feat(encoder): keep chapter names and AniList choices per disc and playlist`.

---

### Task 2: Chapter names and tags in every MKV

**Files:**
- Modify: `encoder/src/plan/episodes.ts` (add `playlistChapter` to `EpisodeChapter`), `encoder/src/encode.ts`
- Create: `encoder/src/mux/episode-tags.ts`
- Test: `encoder/tests/plan/episodes.test.ts`, `encoder/tests/mux/episode-tags.test.ts`, `encoder/tests/encode.test.ts`

**Interfaces:**
- Consumes: `EpisodeInfoStore`, `chapterName` (Task 1); `firstFramePlaylistUs(playlist, plan)` (`plan/episodes.ts`); `discKeyOfFolder` (`disc/disc-key.ts`).
- Produces:
  ```ts
  // plan/episodes.ts
  export interface EpisodeChapter { title: string; startNs: bigint; /** The playlist's chapter number (1-based) this chapter is. */ playlistChapter: number }
  // mux/episode-tags.ts
  export const ENCODER_TAG: string; // `seikou-encode <version of the root package.json>`, e.g. 'seikou-encode 0.1.0'
  export function episodeTags(o: { discKey: string; playlistId: string; startMs: number; anilist: EpisodeAniList | null }): Record<string, string>;
  // encode.ts — EncodeOptions gains:
  /** Chapter names and AniList choices; when left out, `encodeEpisodes` reads them from `<dataDir>/chapters/…`. `null` writes none. */
  episodeInfo?: EpisodeInfo | null;
  // PlanEncodeOptions gains:
  tags?: Readonly<Record<string, string>>;
  ```
- `episodeTags` always sets `SEIKOU_DISC_KEY`, `SEIKOU_PLAYLIST`, `SEIKOU_EPISODE_START_MS` (integer milliseconds, `Math.round(firstFramePlaylistUs / 1000)`) and `ENCODER`; with `anilist` it adds `ANILIST_ID`, `EPISODE` (decimal strings) and `EPISODE_TITLE` when `title` is non-empty.
- Chapter titles: `chapterName(info, chapter.playlistChapter)` when set, else the record's `metadata.chapters[i]` when non-empty (records not yet migrated), else `Chapter n` as today. The episode's AniList choice is `info.anilist[String(firstChapterOfEpisode)]`.

- [ ] **Step 1: Failing test** in `episodes.test.ts`: `planEpisodes` on the existing test playlist with spec `2-3` gives chapters whose `playlistChapter` is `[2, 3]`.
- [ ] **Step 2: Failing tests** in `episode-tags.test.ts`: without AniList the four always-present tags; with `{ anilistId: 990001, episode: 3, title: 'The Lighthouse' }` all seven; `title: null` leaves `EPISODE_TITLE` out; `ENCODER_TAG` matches `/^seikou-encode \d+\.\d+\.\d+/`.
- [ ] **Step 3: Failing test** in `encode.test.ts` (tool-gated like its neighbours): encode `encoder/fixtures/disc-speech` playlist `00000` episodes `1-2,3-4` with `onlyEpisodes: [2]` and `episodeInfo` `{ chapterNames: { '3': 'Opening' }, anilist: { '3': { anilistId: 990001, episode: 2, title: null } } }`; `readMkv` of the result has first chapter title `Opening`, second `Chapter 2`, tags `ANILIST_ID '990001'`, `EPISODE '2'`, `SEIKOU_PLAYLIST '00000'`, `SEIKOU_DISC_KEY` equal to `discKeyOfFolder(disc).key`, and `SEIKOU_EPISODE_START_MS` equal to `Math.round(firstFramePlaylistUs(playlist, plan) / 1000)`.
- [ ] **Step 4: Run** the three files — expected FAIL.
- [ ] **Step 5: Implement**: set `playlistChapter` where `planEpisodes` pushes each chapter; `episode-tags.ts`; in `encodeEpisodes`, compute the disc key once, read the info when `episodeInfo` is undefined, and pass `tags` and the chapter titles into `encodePlan`, which forwards `tags` to `writeMkv`.
- [ ] **Step 6: Run** `npx vitest run --project encoder` — expected PASS (the `scripts/make-encode-fixture.ts` script still type-checks: it passes its own tags).
- [ ] **Step 7: Commit** `feat(encoder): write chapter names and AniList tags into each episode`.

---

### Task 3: AniList routes for the app

The helper's AniList routes are session-scoped; the Episodes page has no session. These are the same lookups at app level, plus an entry's next season.

**Files:**
- Create: `encoder/src/server/anilist-routes.ts`
- Modify: `encoder/src/server/title-routes.ts` (share the search, cover and episode-title code instead of duplicating it), `encoder/src/server/server.ts`, `encoder/src/server/README.md` (route table), `encoder/web/src/api-types.ts`, `encoder/web/src/app/app-api.ts`
- Test: `encoder/tests/server/anilist-routes.test.ts`

**Interfaces:**
- Consumes: `AppContext` sources (AniList through `@seikou/titles`, `SEIKOU_ENCODE_FIXTURE` recorded answers in tests), `rememberCover`/cover fetch in `title-routes.ts`.
- Produces routes (all behind the token):
  - `GET /api/anilist/search?q=` → `{ candidates: TitleHit[] }`, `poster` pointing at `/api/anilist/<id>/cover`; 400 `empty-query`.
  - `GET /api/anilist/<id>` → `{ entry: { alId, title, nativeTitle, year, format, episodes, poster, sequel: TitleHit | null } }`; `sequel` is the entry's `SEQUEL` relation with a series format (`TV`, `TV_SHORT`, `ONA`), the earliest by start date when there are several, else null; 404 `not-found` for an unknown id; 503 `source-unavailable` (`anilist`).
  - `GET /api/anilist/<id>/episodes` → `{ titles: { [episode]: title } }`.
  - `GET /api/anilist/<id>/cover` → as the session cover route.
- Page: `AppApi.searchAniList(q)`, `AppApi.aniListEntry(id)`, `AppApi.aniListEpisodes(id)`.

- [ ] **Step 1: Failing tests** with the recorded AniList answers (add made-up entries 990010 "Starfall Wanderer" with a `SEQUEL` 990011 "Starfall Wanderer 2" (TV) and a `SEQUEL` 990012 (MOVIE) to `encoder/tests/fixtures/fansubs`' AniList recordings): search finds 990010; entry 990010's `sequel.alId` is 990011 (the movie is passed over); an unknown id is 404; episodes answers the recorded titles; a blank `q` is 400.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, moving the shared bodies out of `title-routes.ts` into functions both tables call; the session routes answer exactly as before (their tests stay green).
- [ ] **Step 4: Run** `npx vitest run --project encoder tests/server` — PASS.
- [ ] **Step 5: Commit** `feat(encoder): AniList lookups for the app's pages`.

---

### Task 4: Chapter names and AniList on the Episodes page

Load `frontend-design` first.

**Files:**
- Create: `encoder/web/src/app/ChapterNamePicker.tsx`, `encoder/web/src/app/EpisodeAniList.tsx`, `encoder/web/src/app/episode-info-model.ts` (pure)
- Modify: `encoder/web/src/app/EpisodesPage.tsx`, `encoder/web/src/app/ChapterList.tsx`, `encoder/web/src/styles.css`
- Test: `encoder/web/src/app/episode-info-model.test.ts`, `encoder/web/src/app/EpisodesPage.test.tsx` (jsdom, as the page's other component tests)

**Interfaces:**
- Consumes: Task 1's `episodeInfo`/`saveEpisodeInfo`, Task 3's AniList calls, the page's `Grouping` (`grouping.ts`: `episodesOf(grouping, chapters)` gives each episode's chapter range), `PlaylistDetail`. The helper's saved record AniList choice is in `GET /api/discs/<key>/playlists/<id>` — extend `PlaylistDetail.record` to `{ episodeSpec, anilist: { id, title } | null }` (backend `library-routes.ts` reads it from the record).
- Produces (`episode-info-model.ts`):
  ```ts
  export interface EpisodeRow { readonly index: number; readonly firstChapter: number; readonly anilist: EpisodeAniList | null; readonly prefilled: boolean }
  /** One row per episode of the grouping: the saved choice for its first chapter, else a prefill. */
  export function episodeRows(episodes: readonly { readonly index: number; readonly first: number }[], info: EpisodeInfo | null, recordShow: { readonly id: number } | null): EpisodeRow[];
  /** Renumbers from `row` on: that row gets `entryId` and `first`, each later row of the same entry run the next number, until a row whose entry was set by hand to another one. */
  export function renumberFrom(rows: readonly EpisodeRow[], row: number, entryId: number, first: number): EpisodeRow[];
  /** What a NAS encode lacks: the episode indices with no AniList entry and number. */
  export function missingAniList(rows: readonly EpisodeRow[]): number[];
  export function toInfo(rows: readonly EpisodeRow[], chapterNames: Readonly<Record<string, string>>): Omit<EpisodeInfo, 'savedAt'>;
  ```
- Prefill rule: with no saved choice for any episode, the entry is the record's AniList show (else none) and numbers run 1, 2, 3… in episode order; rows from a saved choice keep it; `prefilled` marks rows the user has not confirmed (shown as such until saved).

UI decisions (layout left to the frontend-design pass): each chapter row of `ChapterList` gets a name control (a select of `CHAPTER_NAMES`, "No name", and "Custom…" revealing a text field); each episode of the episode list gets its AniList entry (poster, name) with "Change" (a search like the helper's title step), its episode number (editable; editing renumbers the following rows of the same entry), and "Next season" offered first in the change dialog from `aniListEntry(id).sequel`. Episode titles are filled from `aniListEpisodes` when AniList has them. Changes save on their own (debounced 500 ms, last write wins) with a quiet saved/failed line; a failed save keeps the edits and says "Not saved: <message>" with Retry.

- [ ] **Step 1: Failing model tests**: `episodeRows` prefill from the record show numbers 1..n; a saved row is kept and not `prefilled`; `renumberFrom(rows, 2, 990011, 1)` on 4 rows of 990010 gives row 3 = 990011 #1, row 4 = 990011 #2, rows 1–2 unchanged; a row set by hand to a third entry stops the run; `missingAniList` lists rows with no entry; `toInfo` keys by `firstChapter`.
- [ ] **Step 2: Run** `npx vitest run encoder/web/src/app/episode-info-model.test.ts` — FAIL; **Step 3: Implement** the model; **Step 4:** PASS.
- [ ] **Step 5: Failing component test**: the page with a fake `AppApi` saves `{ chapterNames: { '1': 'Opening' } }` after the first chapter's picker is set to Opening; picking Custom and typing "Cold open" saves that; an episode's "Change" → search → pick saves its AniList choice and renumbers the rows after it.
- [ ] **Step 6: Implement** the components; **Step 7:** run the component test, `npx tsc -p tsconfig.encoder-web.json --noEmit`, and look at the page in the browser against `encoder/fixtures/disc-speech` (`npm run seikou-encode -- app --root <copy>`), phone and desktop widths, light and dark.
- [ ] **Step 8: Commit** `feat(encoder): name chapters and pick each episode's AniList entry`.

---

### Task 5: The NAS client and pairing

**Files:**
- Create: `encoder/src/nas/client.ts`, `encoder/src/nas/pairing.ts`, `encoder/src/nas/nas-store.ts`, `encoder/src/nas/README.md`, `encoder/src/server/nas-routes.ts`, `encoder/web/src/app/NasPairing.tsx`
- Modify: `encoder/src/server/http.ts` (`AppContext.nas`), `encoder/src/server/server.ts`, `encoder/src/cli.ts` (load the client for `app` and `serve`), `encoder/web/src/app/SettingsPage.tsx`, `api-types.ts`, `app-api.ts`
- Test: `encoder/tests/nas/client.test.ts`, `encoder/tests/nas/pairing.test.ts`, `encoder/tests/nas/nas-test-server.ts` (helper), `encoder/tests/server/nas-routes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // nas-store.ts — <data>/nas.json, mode 0600, atomic
  export interface NasPairingFile { readonly base: string; readonly deviceId: string; readonly personId: string; readonly personName: string; readonly privateKeyJwk: JsonWebKey; readonly pairedAt: string }
  export function readNasPairing(dataDir: string): Promise<NasPairingFile | null>;
  export function writeNasPairing(dataDir: string, p: NasPairingFile): Promise<void>;
  export function removeNasPairing(dataDir: string): Promise<void>; // also removes <data>/fetch and <data>/nas-library.json
  // pairing.ts
  /** A typed code with an address, or a pairing link (`?pair=<code>&nas=<base>` or `&rv=<worker>`; the Worker's `POST codes/lookup` gives the base). */
  export function parsePairingInput(input: { code?: string; base?: string; link?: string }): { code: string; base: string } | { code: string; rendezvous: string };
  export function checkNasBase(base: string): string; // normalises to end in '/api/'; throws NasError('bad-address') unless https, or http on 127.0.0.1/localhost
  export function pairWithNas(dataDir: string, input: …, deviceName: string, fetchImpl?: typeof fetch): Promise<NasPairingFile>; // throws NasError('not-owner') for a non-owner code
  // client.ts
  export class NasError extends Error { constructor(readonly code: 'unreachable' | 'unauthorized' | 'not-owner' | 'bad-address' | 'http', readonly status: number | null, message: string) }
  export class NasClient {
    static load(dataDir: string, fetchImpl?: typeof fetch): Promise<NasClient | null>;
    readonly base: string; readonly personName: string;
    /** `path` under the API base with a session token; a 401 renews the token once. Network failures throw NasError('unreachable'). */
    request(path: string, init?: RequestInit): Promise<Response>;
    json<T>(path: string, init?: RequestInit): Promise<T>; // non-2xx throws NasError('http') with status and the body's `error`
    me(): Promise<{ owner: boolean; personName: string }>;
  }
  ```
- `AppContext.nas: { client: NasClient | null }` (mutable holder, replaced on pair/unpair).
- Routes: `GET /api/nas` → `{ paired: false }` or `{ paired: true, host, personName, reachable: boolean, encodes: 'ready' | 'not-configured' | 'unknown' }` (`host` is the base's host name; `encodes` from `GET encodes/status`, 404 → `not-configured`); `POST /api/nas/pair` body `{ code, base }` or `{ link }` → the same answer; errors 400 `bad-address`, 400 `bad-code` (the NAS refused the code), 409 `not-owner`, 502 `unreachable`; `DELETE /api/nas` → `{ paired: false }` (unpairs this app only: the device stays listed in Seikou's admin screen until the owner removes it — the page says so).
- Settings page: a "Your NAS" section: unpaired, a form with the pairing code and NAS address (`https://…/bluray/api/` placeholder) or a pasted pairing link; paired, "Paired with <host> as <personName>", the encodes state (`ENCODES_MOUNT` not set → a line saying so), and Unpair (with a confirm).
- The NAS's name (spec: "shows the NAS's name") is its host name: the NAS has no name of its own (ruling recorded in the ledger).

- [ ] **Step 1: Test helper** `encoder/tests/nas/nas-test-server.ts`: starts Seikou's NAS handlers in-process on `127.0.0.1:0` the way `server/src/routes/encodes.test.ts` does (`appHandlers`, `Auth`, `Library` over a temp copy of `fixtures/synthetic`, `EncodeIndex` over a temp encodes folder), exposes `{ base, ownerCode(): Promise<string>, guestCode(): Promise<string>, encodesDir, close() }`.
- [ ] **Step 2: Failing tests**: `parsePairingInput` reads both link forms and a typed code; `checkNasBase` refuses `http://nas.example/api/` and accepts `http://127.0.0.1:4192/api` (normalised with the slash); `pairWithNas` with an owner code writes `nas.json` with mode `0600` and no token field; a guest code throws `not-owner` and writes nothing; `NasClient.request` after the server forgets sessions (restart the stand-in's `Auth` session map) renews once and succeeds; a closed port throws `unreachable`; no thrown message or `nas.json` contains the session token (scan for the token string).
- [ ] **Step 3: Run** — FAIL; **Step 4: Implement** `nas-store.ts`, `pairing.ts`, `client.ts` (port `Device` from `scripts/verify-level.ts`: extractable key saved as JWK, session renewed 60 s before expiry).
- [ ] **Step 5: Failing route tests** for `GET/POST/DELETE /api/nas` against the stand-in, including `encodes: 'ready'` when the stand-in has an encodes folder and `not-configured` without one; no answer body contains `privateKeyJwk` or a token.
- [ ] **Step 6: Implement** routes; load the client at `app`/`serve` start.
- [ ] **Step 7: Settings UI** (load `frontend-design`); component test: pairing posts `{ code, base }` and shows "Paired with 127.0.0.1"; Unpair asks first.
- [ ] **Step 8: Run** `npx vitest run --project encoder` and both typechecks — PASS. **Commit** `feat(encoder): pair with the NAS as an owner device`.

---

### Task 6: Mirror folders and fetching

The heart of "fetch what the job needs".

**Files:**
- Create: `encoder/src/nas/mirror.ts`, `encoder/src/nas/fetch.ts`
- Test: `encoder/tests/nas/mirror.test.ts`, `encoder/tests/nas/fetch.test.ts`

**Interfaces:**
- Consumes: `NasClient` (Task 5), `DiscManifest` and `discKeyOf` (`@seikou/nas`), `loadPlaylist` (`disc/playlist.ts`), `parseEpisodeSpec`/`planEpisodes` segment clip ids.
- Layout: `<data>/fetch/<disc key>/` holds the disc's files at their manifest paths (`BDMV/…`, `CERTIFICATE/…`) and `fetch.json`: `{ discId, discKey, label, files: { [path]: size }, ranges: { [streamPath]: [start, endExclusive][] }, heads: string[] }`.
- Produces:
  ```ts
  export const HEAD_BYTES = 4 * 1024 * 1024;   // what probes and PMT reads need of each clip
  export const CHUNK_BYTES = 32 * 1024 * 1024; // one range request
  export const ROOM_MARGIN_BYTES = 1024 ** 3;  // free space kept beyond what is fetched
  export class FetchError extends Error { constructor(readonly code: 'disc-changed' | 'no-room' | 'unreachable', message: string) }
  /** Makes or refreshes the mirror of NAS disc `discId`: metadata files whole (inlined ones from the manifest), every .M2TS a sparse file of its manifest size. Throws `disc-changed` when an existing mirror's sizes differ (the old one is removed first) or when `discKeyOf(discId, manifest.files)` is not `expectedKey` (when given). Returns the mirror folder. */
  export function ensureMirror(dataDir: string, client: NasClient, discId: string, expectedKey?: string): Promise<{ dir: string; key: string; label: string }>;
  export function mirrorDirOf(dataDir: string, key: string): string;
  export function isMirror(dir: string): Promise<boolean>; // has fetch.json
  export class ClipFetcher {
    constructor(o: { dataDir: string; client: NasClient; key: string; signal?: AbortSignal; onProgress?: (p: { bytesDone: number; bytes: number }) => void; sleep?: (ms: number) => Promise<void> });
    /** Fetches the first HEAD_BYTES of each clip a playlist names (what probing reads). */
    heads(playlistId: string): Promise<void>;
    /** Fetches `clips` (stream file names such as '00001.M2TS') whole for `holder`; resumes from `fetch.json`; checks room first (throws `no-room` naming the bytes needed). */
    hold(holder: string, clips: readonly string[]): Promise<void>;
    /** Drops `holder`'s claim; a clip no holder claims is emptied back to a sparse file keeping its head. */
    release(holder: string, clips?: readonly string[]): Promise<void>;
  }
  /** The stream files episode `index` of `episodeSpec` reads (its plan's segments' clips). */
  export function clipsOfEpisode(discDir: string, playlistId: string, episodeSpec: string, index: number): Promise<string[]>;
  /** Reads `[start, end]` of a mirror file: local bytes where fetched, else from the NAS (not stored). */
  export function readMirrorRange(dataDir: string, client: NasClient, key: string, path: string, start: number, end: number): Promise<Uint8Array>;
  ```
- Holders are kept in memory per app (`Map<key, Map<clip, Set<holder>>>`); at app start nothing is held, so `ClipFetcher` empties every whole clip no holder claims when the runner starts (the start sweep), keeping heads.
- Network rules: each range request retries 1 s, 2 s, 4 s, 8 s on a network error or 5xx, then throws `FetchError('unreachable')`; the runner (Task 9) turns that into waiting. A 404 for the disc, or a `Content-Range` total that differs from the manifest size, is `disc-changed`.
- Sparse files: create with `open(…,'w')` + `ftruncate(size)`; empty a clip by reading its head, truncating to 0, truncating to size and writing the head back. Writes go to the mirror file in place at their offsets and are recorded in `fetch.json` after each chunk is flushed (`fsync`), so a crash loses at most one chunk.

- [ ] **Step 1: Failing mirror tests** against the stand-in (Task 5 helper) with `fixtures/synthetic/disc1`: `ensureMirror` writes `BDMV/INDEX.BDMV` byte-identical to the fixture, each `.M2TS` with the fixture's size and (on APFS/ext4) `stat.blocks * 512` far below its size; `discKeyOfFolder(mirror)` equals `discKeyOf(discId, manifest.files)`; a second call with a changed manifest size (stand-in copy edited) throws `disc-changed` and removes the old mirror; `expectedKey` mismatch throws `disc-changed`.
- [ ] **Step 2: Failing fetch tests**: `heads('00000')` makes each clip's first 4 MiB (or whole clip when smaller) equal to the fixture's bytes; `hold('job-1', ['00001.M2TS'])` makes the clip byte-identical to the fixture; an abort mid-fetch then a new `hold` fetches only the missing ranges (count the stand-in's range requests); `release` empties the clip back to its head (head bytes still equal, rest zero, blocks small) while another holder's clip stays; a fake `statfs` reporting too little room throws `no-room` with the needed byte count in the message and fetches nothing; a stand-in that drops connections throws `unreachable` after the four retries (inject `sleep`); `readMirrorRange` over a fetched and an unfetched range equals the fixture's bytes; `clipsOfEpisode` on disc1's playlist gives the clips its plan reads.
- [ ] **Step 3: Run** `npx vitest run --project encoder tests/nas` — FAIL. **Step 4: Implement.** **Step 5:** PASS.
- [ ] **Step 6: Commit** `feat(encoder): mirror NAS discs and fetch only the clips an episode needs`.

---

### Task 7: NAS discs in the library

**Files:**
- Create: `encoder/src/nas/nas-library.ts`
- Modify: `encoder/src/server/library.ts`, `library-routes.ts`, `sessions.ts` (`discDirOf` resolves NAS keys through `ensureMirror`), `disc-routes.ts` (`serveDiscFile` on a mirror reads through `readMirrorRange` for stream files), `jobs.ts` (`findMovedDisc` uses `discDirOf`), `encoder/web/src/api-types.ts`, `encoder/web/src/app/LibraryPage.tsx`, `DiscPage.tsx`
- Test: `encoder/tests/nas/nas-library.test.ts`, `encoder/tests/server/library-routes.test.ts`, `encoder/tests/server/disc-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces:
  ```ts
  export interface NasDisc { readonly discId: string; readonly key: string; readonly label: string; readonly relPath: string; readonly playlistCount: number; readonly sizeBytes: number }
  export class NasLibrary {
    constructor(app: AppContext);
    /** Walks `GET library?path=` from the top, fetching each disc's manifest once (cached in <data>/nas-library.json by disc id and sizeBytes), at most 4 manifests at a time. */
    scan(): Promise<void>;
    readonly scanning: boolean;
    readonly reachable: boolean | null; // null before the first scan
    discs(): readonly NasDisc[];
    byKey(key: string): NasDisc | null;
  }
  ```
- `LibraryDiscInfo` gains `source: 'local' | 'nas'`; NAS discs have `root: 'NAS'` and `relPath` the NAS path; `LibraryAnswer` gains `nas: { paired: boolean; scanning: boolean; reachable: boolean | null }`. A key on both the Mac and the NAS is listed once, as the local copy, with the NAS path in `otherPaths` (root `NAS`).
- The library scan runs the NAS scan beside the local one when paired; an unreachable NAS keeps the last listing (marked `reachable: false`).
- `discDirOf(key)` order: a session's folder, a local library folder, then a NAS disc's mirror (`ensureMirror(…, discId, key)`).
- Disc routes on a mirror: `manifest` as for any folder (it equals the NAS's: same paths and sizes); a file read of a stream file goes through `readMirrorRange` (reads up to 8 MiB per request, as the engine asks); a metadata file is served locally.
- Page: the Library lists NAS discs with a "NAS" mark and a line under the list while the NAS can't be reached ("The NAS can't be reached; its discs are from the last listing."). Opening a NAS disc works as any other.

- [ ] **Step 1: Failing tests**: `NasLibrary.scan` against the stand-in lists every synthetic disc with its key equal to the stand-in's `discKeyOf`; a second scan fetches no manifest whose disc id and size are unchanged; the stand-in closed → `reachable: false`, last listing kept.
- [ ] **Step 2: Failing route tests**: `GET /api/library` with a paired stand-in lists NAS discs with `source: 'nas'`; `GET /api/discs/<nas key>/manifest` equals the stand-in's manifest files; `GET /api/discs/<nas key>/files/BDMV/STREAM/00001.M2TS` with `Range: bytes=0-1023` and a range past the head both equal the fixture bytes; `POST /api/sessions` on a NAS key works and its `GET …/episodes` plans (heads fetched by then: `SessionStore.create` calls `ClipFetcher.heads(playlistId)` for a mirror).
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** (load `frontend-design` for the page change). **Step 5:** PASS, both typechecks.
- [ ] **Step 6: Commit** `feat(encoder): list and open the NAS's discs`.

---

### Task 8: Probing only what an episode needs, and the line-up's fetch

Today `encodeEpisodes` and the helper's `planTimes` probe every clip of the playlist and read every clip's PMT; on a mirror only heads are present, which is enough for probing, but the planner must not depend on clips outside the wanted episodes for anything beyond their heads, and the line-up must fetch its episode's clips before BestSource decodes them.

**Files:**
- Modify: `encoder/src/encode.ts`, `encoder/src/server/disc-routes.ts` (`planTimes`), `encoder/src/server/align-routes.ts` (or the module that decodes an episode's audio: `encoder/src/audio/episode-audio.ts`)
- Test: `encoder/tests/encode.test.ts`, `encoder/tests/server/align-routes.test.ts`

**Interfaces:**
- `encodeEpisodes` probes and reads the PMT of only the clips of the wanted episodes' plans (find them from the specs' play items before probing; `planEpisodes` is then given only those probes). Behaviour on local discs is unchanged.
- The line-up: before decoding episode `n`'s audio for a session whose disc is a mirror, `ClipFetcher.hold('session:<id>', clipsOfEpisode(…, n))`; the session keeps them until the server stops (released by the start sweep next run). Progress is reported through the line-up's existing status as "Fetching from the NAS (x of y MB)".
- A clip that is only a head when BestSource is about to read it is a bug guard: before any vspipe chain starts on a mirror, `assertFetched(dir, clips)` throws `Error('Clip <name> is not fetched from the NAS yet')`.

- [ ] **Step 1: Failing test**: on a local copy of disc1 with one clip of a playlist replaced by a file of the same size full of zeros, `encodeEpisodes` with `onlyEpisodes` for an episode not on that clip plans and starts without error (tool-gated part only for the encode; the planning part runs without tools by stubbing `encodePlan`'s chain through the existing test seams).
- [ ] **Step 2: Failing test**: a line-up request on a NAS session (stand-in) fetches the episode's clips (they become byte-identical) and a second request fetches nothing.
- [ ] **Step 3: Run** — FAIL; **Step 4: Implement**; **Step 5:** PASS.
- [ ] **Step 6: Commit** `feat(encoder): read only an episode's own clips, and fetch them for the line-up`.

---

### Task 9: The NAS destination in the queue runner

**Files:**
- Create: `encoder/src/nas/upload.ts`
- Modify: `encoder/src/server/profiles.ts` (`EncodeSettings.destination`), `encoder/src/server/jobs.ts`, `encoder/src/server/job-routes.ts`, `encoder/src/server/README.md`
- Test: `encoder/tests/nas/upload.test.ts`, `encoder/tests/server/jobs-nas.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5, 6, 8.
- Settings: `EncodeSettings.destination: 'folder' | 'nas'`, default `'folder'` (an old profile or job without it reads as `'folder'`). With `'nas'`, `web` is forced false and `outDir` is ignored; the job writes to `<data>/nas-out/<jobId>/`.
- Upload:
  ```ts
  export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
  export interface UploadState { id: string | null; sha256: string | null; size: number; sent: number }
  export class UploadError extends Error { constructor(readonly code: 'unreachable' | 'no-room' | 'bad-tags' | 'folder-unavailable' | 'not-configured' | 'refused', message: string) }
  /** Uploads `path` as `<anilistId>-<episode>.mkv`: hashes once (kept in `state`), creates or resumes the upload (a stored id whose GET is 404 starts over), PUTs the missing ranges in order, completes. Resolves with the NAS's encode id (`entry.id`, or `filed`'s id when `entry` is null). */
  export function uploadEpisode(client: NasClient, path: string, name: string, state: UploadState, o: { signal?: AbortSignal; onProgress?: (sent: number, size: number) => void; onState?: (s: UploadState) => void }): Promise<string>;
  ```
  NAS answers: 409 `in-progress` with a stored id → resume that id; without one → `refused` ("Another upload of this episode is open on the NAS; it is removed after 24 hours unused."); 422 `hash-mismatch` → start over once, then `refused`; 422 `bad-tags` → `bad-tags`; 507 `no-room` → `no-room` with the NAS's message; 503 `encodes-folder-unavailable` → `folder-unavailable`; 404 `not-configured` → `not-configured`; network errors and 5xx after the 1/2/4/8 s retries → `unreachable`.
- Job model (`jobs.ts` and the page's `api-types.ts` mirror it):
  - `JobEpisode` gains `step: 'fetching' | 'encoding' | 'uploading' | null`, `stepDone: number`, `stepTotal: number` (bytes for fetch and upload), `upload?: UploadState`, `encodeId?: string`.
  - `EpisodeState` gains `'upload-failed'` (the MKV kept; Retry uploads again without encoding).
  - `Job` gains `waiting: string | null` ("Waiting for the NAS" while a step is retried every 60 s after `unreachable` or `folder-unavailable`; cancel stops it).
  - `jobs.json` from before loads with `destination: 'folder'`, `step: null`, `waiting: null`.
- Queue checks for `destination: 'nas'` (`add`): 409 `nas-not-paired`; 409 `nas-needs-anilist` with `episodes: number[]` (from `EpisodeInfoStore` and `missingAniList`'s rule on the backend: every episode's first chapter needs an entry); 409 `nas-encodes-off` when `GET encodes/status` is 404 `not-configured`; an unreachable NAS queues anyway. Test jobs on a NAS disc (a mirror): 409 `nas-test-unsupported` ("Test encodes need the disc on this Mac") — ruling, deferred.
- Runner per episode of a NAS-disc job: fetch (`hold('job:<id>', clips of this episode and the next)`, the next one's fetch running in the background while this one encodes), encode, release this episode's clips no later episode needs. Per episode with `destination: 'nas'`: after the MKV is complete, upload; on the NAS's confirmation delete the MKV, set `encodeId`, mark done. A failed upload marks `upload-failed`, keeps the MKV and fails the job; retry uploads again (state kept). A job that is cancelled or fails releases all its holds. The job's `cli` gains `--nas` and names the disc `nas:<key>` for a NAS disc (never a token).

- [ ] **Step 1: Failing upload tests** against the stand-in: a 3-chunk upload of a made-up tagged MKV (`fixtures/encodes/990001/1.mkv` re-tagged as 990002 episode 1 into a temp file) lands in the stand-in's encodes index; abort after the first chunk then resume sends only the rest (count PUTs); a stored id the stand-in forgot (delete its `.uploads/<id>.*`) starts over; an MKV without `ANILIST_ID` gives `bad-tags`; the stand-in with no encodes folder gives `not-configured`.
- [ ] **Step 2: Failing runner tests** (`jobs-nas.test.ts`, fake `encode` dep that writes a tagged MKV copy, the stand-in as NAS): a two-episode NAS-disc job with destination NAS fetches episode 1's clips, encodes, uploads, deletes the local MKV, and ends `done` with both `encodeId`s; the fake `encode` sees episode 2's clips already fetched when it starts episode 2; after the job no clip of the mirror is more than its head; the stand-in stopped during episode 2's upload sets `waiting` and the job finishes once the stand-in is back (inject a 10 ms retry interval); queueing with an episode lacking AniList is 409 `nas-needs-anilist` with `episodes: [2]`; an interrupted job's retry resumes the upload id it stored; an old `jobs.json` without the new fields loads.
- [ ] **Step 3: Run** — FAIL; **Step 4: Implement**; **Step 5:** PASS and `npx vitest run --project encoder` all green.
- [ ] **Step 6: Commit** `feat(encoder): fetch NAS discs and upload episodes to the NAS from the queue`.

---

### Task 10: Destination and steps on the page

Load `frontend-design` first.

**Files:**
- Modify: `encoder/web/src/app/QueueDialog.tsx`, `SettingsPage.tsx` (profile editor), `QueuePage.tsx`, `job-model.ts`, `job-events.ts`, `api-types.ts`, `styles.css`
- Test: `encoder/web/src/app/job-model.test.ts`, `QueueDialog.test.tsx`

**Interfaces:**
- Consumes: Task 9's job and settings fields and errors; Task 4's `missingAniList`.
- The queue dialog's destination: "A folder on this Mac" (the output folder field as today) or "The NAS (Encodes library)", offered only when paired (otherwise disabled with "Pair with your NAS in Settings"). With the NAS chosen the dialog says what is missing before Queue is enabled: episodes without an AniList entry (linking to the Episodes page), or encodes not set up on the NAS. The profile editor gains the same choice as the profile's default.
- `job-model.ts`: an episode's line reads "Fetching from the NAS · 1.2 of 4.0 GB", "Encoding · …" (as today), "Uploading episode 2 of 6 · 45%", "Uploaded" (with the NAS's encode id kept for a later link), "Upload failed: <message>"; a job with `waiting` shows "Waiting for the NAS" with its retry.

- [ ] **Step 1: Failing model tests** for each line above, from job fixtures.
- [ ] **Step 2: Failing dialog tests**: unpaired → NAS option disabled with the Settings hint; paired with a missing episode → Queue disabled listing "Episode 2 has no AniList entry"; a 409 `nas-needs-anilist` from the backend shows the same.
- [ ] **Step 3: Run** — FAIL; **Step 4: Implement**; **Step 5:** PASS, typecheck, a look in the browser at both widths and themes.
- [ ] **Step 6: Commit** `feat(encoder): queue encodes to the NAS and follow their fetch and upload`.

---

### Task 11: The CLI

**Files:**
- Modify: `encoder/src/cli.ts`, `encoder/README.md` (usage)
- Test: `encoder/tests/cli.test.ts`

**Interfaces:**
- `seikou-encode nas pair --code <code> --base <url>` or `--link <url>` prints `Paired with <host> as <person>`; `nas status` prints the same or `Not paired`; `nas unpair`.
- `encode nas:<disc key> --playlist ID --episodes SPEC (--out DIR | --nas)`: a `nas:` disc is mirrored and each episode's clips fetched before it is encoded and released after (one episode ahead, as the runner); `--nas` uploads each episode after it is encoded and deletes it once confirmed (into a temporary folder under the data directory when `--out` is not given). Exit codes: 2 for usage, unpaired, an unknown key or missing AniList choices (naming the episodes); 1 for a failed fetch, encode or upload. `plan nas:<key>` works too.
- `jobCli` (Task 9) produces exactly this syntax.

- [ ] **Step 1: Failing tests** with the stand-in: `nas pair` writes `nas.json`; `plan nas:<key>` prints the playlists of the NAS disc; `encode nas:<key> … --nas` without AniList choices exits 2 naming the episodes; the full encode-and-upload is tool-gated.
- [ ] **Step 2: Run** — FAIL; **Step 3: Implement**; **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(encoder): NAS discs and the NAS destination on the command line`.

---

### Task 12: Docs and the end-to-end check

**Files:**
- Modify: `encoder/README.md`, `encoder/src/server/README.md`, `encoder/src/nas/README.md`, `CLAUDE.md` (the `seikou-encode` bullet: pairing, NAS discs, the NAS destination, `nas:` and `--nas`, the data directory's new files), `docs/nas.md` (the Encodes section: how episodes arrive from Seikou encoder), `playwright.encoder.config.ts`
- Create: `encoder/tests/e2e/nas.spec.ts`

**Interfaces:**
- A third Playwright project `nas`: its `webServer` builds the server bundle if needed and runs the NAS server (`server/dist/server.mjs`) on port 4198 over a temporary copy of `fixtures/synthetic` with a temporary `ENCODES_DIR`, plus `app` on port 4199 with its own data directory; an owner code is minted with `node server/dist/server.mjs owner-code` against the same data dir (as `tests/e2e/nas-server.ts` does).
- The test: Settings → pair with the code and `http://127.0.0.1:4198/api/` → the Library shows the NAS discs marked NAS → open `disc-speech`'s copy (add `encoder/fixtures/disc-speech` to the stand-in's root) → Episodes: name chapter 1 "Opening", pick the made-up AniList entry from the recorded answers, numbers 1 and 2 → Queue with the NAS destination → (tool-gated) the job fetches, encodes, uploads; the NAS's `GET encodes/shows` lists the show with two episodes; `<data>/nas-out` is empty and the mirror holds no whole clip.

- [ ] **Step 1: Write the spec**, run `npx playwright test -c playwright.encoder.config.ts --project nas` — PASS (or the tool-gated part skipped with its reason where the tools are missing).
- [ ] **Step 2: Docs**: every statement above reflected; `npm run licence-check` passes.
- [ ] **Step 3: Full check**: `npm run typecheck`, `npm test`, `npx playwright test -c playwright.encoder.config.ts` — all pass.
- [ ] **Step 4: Commit** `docs: the encoder and the NAS` and `test(e2e): pair, fetch, encode and upload to the NAS`.

---

## Decisions made in this plan (for the ledger)

- **Mirror folders with sparse clips** instead of teaching every reader (probe, PMT, BestSource, the record's key) about the NAS: the same names and sizes give the NAS's own disc key, and an unfetched range reads as zeros, which the M2TS sync-byte check and `assertFetched` turn into errors rather than silent garbage. Cost if wrong: a filesystem without sparse files would allocate full clip sizes (APFS and ext4 support them).
- **Clip heads of 4 MiB** for a playlist's clips when it is opened, so the planner probes without fetching whole clips. Cost: a probe that needs more than 4 MiB of a clip fails with a clear error.
- **Mirror metadata and heads stay** after a job (a cache, a few MB per playlist); whole clips never outlive their holders. Unpairing removes `<data>/fetch` entirely.
- **AniList choices keyed by an episode's first playlist chapter**, so regrouping keeps them where it can.
- **The NAS's "name" is its host name**: the NAS has none of its own.
- **Unpair is local**: the device stays in Seikou's admin list until the owner removes it.
- **Test encodes of NAS discs are refused** (`nas-test-unsupported`) for now.
- **One wait rule** for fetch and upload: after four quick retries, "Waiting for the NAS", retried every 60 s until it answers or the job is cancelled.
- **Upload name** `<anilistId>-<episode>.mkv` (the NAS files by tags; the name only spots a duplicate open upload).
- **`ENCODER` tag** is `seikou-encode <root package.json version>`.
