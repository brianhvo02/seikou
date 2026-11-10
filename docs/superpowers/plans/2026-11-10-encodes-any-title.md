# Encodes Library: Titles Beyond AniList Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The NAS's Encodes library files, lists, groups and plays encodes whose show is a TMDB title or an owner's own title, not only an AniList entry, so the encoder can encode shows AniList doesn't have.

**Architecture:** An encode's show becomes an `EncodeTitle` (AniList entry, TMDB TV season, TMDB film, or own title with an optional season), written as Matroska tags and turned into an id string, a place key and a folder name by one module in `@seikou/nas`. AniList encodes keep exactly today's tags, ids, place keys and folders, so existing files, places and links keep working. The index, uploads, catalogue, places, routes and the player's Encodes tab take the title instead of an AniList id.

**Tech Stack:** TypeScript (strict), Node 24 server, React 19 player, Vitest, Playwright.

**Spec:** `encoder/docs/superpowers/specs/2026-11-10-library-by-show-design.md` §2 ("Shows not on AniList": "this means encodes are no longer AniList-only … a change to the Encodes library"), with the Encodes library's own spec `docs/superpowers/specs/2026-11-08-encodes-library-design.md`.

## Global Constraints

- Backward compatibility is absolute: an MKV tagged `ANILIST_ID` + `EPISODE` (every encode so far) keeps its id `<anilistId>-<episode>`, place key `e.<anilistId>.<episode>`, folder `<anilistId>/<episode>.mkv`, and its show grouping by AniList relations.
- New tags, exactly: `SEIKOU_TITLE` (a NAS title id: `tmdb-tv:<n>`, `tmdb-movie:<n>` or `own:<uuid>`), `SEASON` (positive integer; required for `tmdb-tv`, optional for `own`, absent for `tmdb-movie`), `TITLE_NAME` (display name, used when the NAS has no metadata for the title), with the existing `EPISODE`. `ANILIST_ID` wins when both it and `SEIKOU_TITLE` are present.
- The title part of ids, keys and folders, exactly: AniList `<anilistId>`; TMDB TV `tv<tmdbId>s<season>`; TMDB film `mv<tmdbId>`; own `own<32 lower-case hex, the uuid without dashes>` plus `s<season>` when it has a season. Encode id `<titlePart>-<episode>`; place key `e.<titlePart>.<episode>`; folder `<titlePart>/<episode>.mkv`. A film's episode is `1`.
- The NAS never fetches TMDB without `TMDB_API_KEY`: without it a TMDB show is named from `TITLE_NAME`, else `TMDB <id>`.
- Everything in `CLAUDE.md` holds (the server writes only `/data` and `/encodes`; made-up names in tests; LGPL-3.0-or-later headers).

## Review Focus

1. **Existing AniList encodes after the upgrade**: the same ids, place keys, resume points, Continue watching and links as before. Pinned in Task 1 (id/key round-trips of today's strings) and Task 2 (an index built from the committed `fixtures/encodes` gives today's ids).
2. **A TMDB encode on a NAS without `TMDB_API_KEY`**: listed under its `TITLE_NAME`, never an error. Pinned in Task 3.
3. **Two own titles with the same name**: kept apart by their uuid. Pinned in Task 3.
4. **Next episode across TMDB seasons**: season 1's last episode goes to season 2's first, never into a film. Pinned in Task 3.
5. **A malformed `SEIKOU_TITLE` or a `tmdb-tv` without `SEASON`**: the file is "Not filed" and an upload of it is refused with 422 `bad-tags`. Pinned in Task 2.

---

### Task 1: `EncodeTitle` in `@seikou/nas`

**Files:**
- Create: `packages/nas/src/encode-title.ts`, `packages/nas/src/encode-title.test.ts`
- Modify: `packages/nas/src/encode-id.ts` (built on `encode-title.ts`), `packages/nas/src/place-key.ts`, `packages/nas/src/index.ts`, `packages/nas/src/encode-id.test.ts`, `packages/nas/src/place-key.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EncodeTitle =
    | { readonly source: 'anilist'; readonly anilistId: number }
    | { readonly source: 'tmdb-tv'; readonly tmdbId: number; readonly season: number }
    | { readonly source: 'tmdb-movie'; readonly tmdbId: number }
    | { readonly source: 'own'; readonly ownId: string /* uuid with dashes */; readonly season: number | null };
  export function titlePart(t: EncodeTitle): string;              // '990001', 'tv1399s2', 'mv603', 'own0f…e1s1'
  export function parseTitlePart(s: string): EncodeTitle | null;
  export function sameTitle(a: EncodeTitle, b: EncodeTitle): boolean;
  /** The NAS title id the show is filed under: 'anilist:<n>', 'tmdb-tv:<n>', 'tmdb-movie:<n>', 'own:<uuid>'. */
  export function nasTitleId(t: EncodeTitle): string;
  /** The tags that name the title (not EPISODE): { ANILIST_ID } or { SEIKOU_TITLE, SEASON? }. */
  export function titleTags(t: EncodeTitle): Record<string, string>;
  /** The title the tags name, or null (malformed, or a tmdb-tv without SEASON). ANILIST_ID wins. */
  export function titleFromTags(tags: Readonly<Record<string, string>>): EncodeTitle | null;
  // encode-id.ts, now generic (the AniList forms unchanged):
  export function encodeId(title: EncodeTitle, episode: number): string;
  export function parseEncodeId(id: string): { title: EncodeTitle; episode: number } | null;
  export function encodePlaceKey(title: EncodeTitle, episode: number): string;
  export function parseEncodePlaceKey(key: string): { title: EncodeTitle; episode: number } | null;
  // place-key.ts: ParsedPlaceKey's encode variant becomes { kind: 'encode'; title: EncodeTitle; episode: number }
  ```
- [ ] **Step 1: Failing tests**: round trips for each source (`{anilist 990001}` ↔ `'990001'`; `{tmdb-tv 1399, season 2}` ↔ `'tv1399s2'`; `{tmdb-movie 603}` ↔ `'mv603'`; `{own '0f0e…', season 1}` ↔ `'own0f0e…s1'`, and season null without `s`); `encodeId({anilist 990001}, 3) === '990001-3'` and `encodePlaceKey(…) === 'e.990001.3'` (today's strings); `parseEncodeId('tv1399s2-5')`; refusals: `'tv1399-5'` (no season), `'own…'` with 31 hex, `'0-1'`, `'990001-0'`, upper-case hex; `titleFromTags({ ANILIST_ID: '7', SEIKOU_TITLE: 'tmdb-tv:1', SEASON: '1' })` is AniList 7; `titleFromTags({ SEIKOU_TITLE: 'tmdb-tv:1' })` is null; `nasTitleId` of each.
- [ ] **Step 2: Run** `npx vitest run packages/nas/src/encode-title.test.ts packages/nas/src/encode-id.test.ts packages/nas/src/place-key.test.ts` — FAIL.
- [ ] **Step 3: Implement**; fix every compile error the signature change causes in the repo by passing `{ source: 'anilist', anilistId }` at today's call sites (behaviour unchanged; Tasks 2–4 generalise them).
- [ ] **Step 4: Run** the three files and `npm run typecheck` — PASS. **Step 5: Commit** `feat(nas): encode titles beyond AniList`.

### Task 2: The index, uploads and routes take any title

**Files:**
- Modify: `server/src/encodes/index-store.ts`, `server/src/encodes/uploads.ts`, `server/src/routes/encodes.ts`, `server/src/playback-store.ts`, `packages/nas/src/nas-api.ts` (`EncodeEntry`, `EncodeDetail`, `EncodeEpisode` doc comments)
- Test: `server/src/encodes/index-store.test.ts`, `server/src/encodes/uploads.test.ts`, `server/src/routes/encodes.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `EncodeEntry` gains `title: EncodeTitle` and `titleName: string | null` (the `TITLE_NAME` tag); `anilistId` becomes `number | null` (the title's AniList id, else null) and stays in `EncodeDetail` for old clients. The canonical file of an entry is `<titlePart>/<episode>.mkv`. New route `GET /api/encodes/ids` → `{ ids: string[] }` (every listed encode id, sorted; same gate, token and 503 `indexing` rules as `encodes/shows`).
- [ ] **Step 1: Failing tests**: the index lists a `SEIKOU_TITLE: 'tmdb-tv:990101', SEASON: '1', EPISODE: '2'` file (made by re-tagging a copy of `fixtures/encodes/990001/1.mkv` with `writeMkv`) with id `tv990101s1-2`; two files of the same title and episode keep the one at `tv990101s1/2.mkv`; `fixtures/encodes/990001/{1,2}.mkv` still give `990001-1`, `990001-2`; a `SEIKOU_TITLE: 'tmdb-tv:5'` without `SEASON` is unfiled; an upload of a TMDB file is filed at `tv…s…/<n>.mkv` and answers its entry; an upload with a malformed `SEIKOU_TITLE` is 422 `bad-tags`; `GET encodes/ids` lists both kinds; a place `PUT me/playback/e.tv990101s1.2/mkv` is accepted and an `e.tvX.2` (no season) is 404 `bad-key`; `DELETE encodes/tv990101s1-2` deletes it.
- [ ] **Step 2: Run** the three server test files — FAIL. **Step 3: Implement.** **Step 4:** PASS, `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(server): file and serve encodes of any title`.

### Task 3: The catalogue groups and names any title

**Files:**
- Modify: `packages/titles/src/encode-catalogue.ts`, `packages/titles/src/encode-next.ts`, `packages/titles/src/up-next.ts`, `server/src/titles/service.ts` (names for TMDB and own titles), `server/src/routes/encodes.ts` (`shows`, `shows/<id>`), `packages/nas/src/nas-api.ts` (`EncodeSeason`, `EncodeShow`, `EncodeShowSummary`)
- Test: `packages/titles/src/encode-catalogue.test.ts`, `encode-next.test.ts`, `up-next.test.ts`, `server/src/titles/service.test.ts`, `server/src/routes/encodes.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `EncodeSeason` gains `title: EncodeTitle`; `anilistId` becomes `number | null`. `EncodeShowSummary.anilistIds` stays (AniList ids only) and gains `titles: string[]` (the `titlePart`s of its seasons).
  - Show ids: AniList shows keep today's ids (the root entry's id as a string); a TMDB TV show is `tv<tmdbId>`, a TMDB film `mv<tmdbId>`, an own title `own<32 hex>`.
  - Grouping: a TMDB TV show holds its seasons ordered by season number (`kind: 'season'`, `number` = season); a TMDB film or own film is one `kind: 'film'` row; an own title with seasons groups them by season, one with season null is one `kind: 'other'` row named after the title.
  - `buildEncodeCatalogue(encodes, anilist, names)` takes a third argument `names: (title: EncodeTitle) => { name: string; poster: string | null } | null` (TMDB entries the title service holds, own titles from `owner.json`); a title with no name uses the encodes' `TITLE_NAME`, else `TMDB <id>` / `Own title`.
  - `TitleService.encodeNames(titles)` fetches missing TMDB entries in the background (only with `TMDB_API_KEY`, paced as today) and keeps them with the AniList ones in `encode-entries.json`.
  - `nextInShow`: the next episode of the same season, then the first of the next season by number; never into a film or another row.
- [ ] **Step 1: Failing tests**: catalogue with AniList 990001 eps 1–2, TMDB TV 990101 season 1 eps 1–2 and season 2 ep 1, a TMDB film 990102, and two own titles both named "Starfall Wanderer" (different uuids) → five shows, the TMDB TV show with seasons 1 and 2 in order, the two own titles apart; with `names` returning null for the TMDB show, its name is its encodes' `TITLE_NAME`, then `TMDB 990101` without one; `nextInShow(tvShow, 'tv990101s1-2')` is `tv990101s2-1`; `nextInShow` of the film is null; `continueWatchingEncodes` includes a TMDB episode's place; the route test lists the five shows and serves `shows/tv990101` with its seasons; a service test shows no TMDB request without the key.
- [ ] **Step 2: Run** the listed tests — FAIL. **Step 3: Implement.** **Step 4:** PASS, `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(titles): group, name and order encodes of any title`.

### Task 4: The player's Encodes tab takes any id

**Files:**
- Modify: `src/ui/nas/nas-route.ts` (`/nas/encodes/play/<id>` and `/nas/encodes/show/<id>` accept the new id forms), `src/ui/nas/encodes-model.ts`, `src/ui/nas/EncodeShowScreen.tsx`, `src/ui/nas/encode-launch.ts`, `src/ui/PlayerScreen.tsx`, `src/ui/place-saver.ts` / `place-apply.ts` where they build encode keys
- Test: `src/ui/nas/nas-route.test.ts`, `encodes-model.test.ts`, `EncodeShowScreen.test.tsx`, `encode-launch.test.ts`, `src/ui/PlayerScreen.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 (`EncodeTitle`, `encodeId`, `parseEncodeId`, `encodePlaceKey`, the new `EncodeSeason.title`).
- Produces: no new API; every place the UI turned an `anilistId` into an id or key uses `EncodeTitle`.
- [ ] **Step 1: Failing tests**: `parseNasPath('/nas/encodes/play/tv990101s1-2')` and `/nas/encodes/show/own0f…` round-trip; the show screen lists a TMDB show's seasons by number with their episodes; launching `tv990101s1-2` saves its place under `e.tv990101s1.2`; Next episode from `tv990101s1-2` opens `tv990101s2-1`; AniList ids behave as before (existing tests stay green).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4:** PASS; `npm test` for the touched folders and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(ui): play and resume encodes of any title`.

### Task 5: End to end and docs

**Files:**
- Modify: `tests/e2e/encodes.spec.ts`, `tests/e2e/fixtures/nas-metadata.json` (a made-up TMDB TV entry 990101 if the stand-in's metadata fixture needs one), `CLAUDE.md` (the Encodes paragraph: titles, tags, id forms), `docs/nas.md` (Encodes: shows from AniList, TMDB or your own titles), `docs/known-issues.md` if a decision is left open
- [ ] **Step 1:** Extend the Chrome-only upload test: upload a copy of episode 1 re-tagged `SEIKOU_TITLE: 'tmdb-tv:990101', SEASON: '1', EPISODE: '1', TITLE_NAME: 'Lantern Harbour'`; the Encodes tab lists "Lantern Harbour" as its own show; opening it plays (where AV1 plays); delete it after, under the same lock as the existing upload test.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/encodes.spec.ts` (all desktop projects) — PASS; `npm test`, `npm run typecheck`, `npm run licence-check`.
- [ ] **Step 3: Commit** `test(e2e): an encode of a TMDB show` and `docs: encodes of any title`.
