# HDR Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "DV", "HDR10+" and "HDR10" badges on the NAS library's title tiles, disc rows, folder listing and pre-flight, read from each disc's CLPI.

**Architecture:** `@seikou/bdmv`'s CLPI parser reads `dynamic_range_type` and `hdr_plus_flag`, and a small classifier turns a main title's clips into `'dv' | 'hdr10plus' | 'hdr10' | null`. The NAS evidence scan records it per disc (kept out of the match key), the catalogue puts it on `DiscRef` and `TitleSummary`, and the app shows it. Screens that already read the disc's manifest (folder listing, pre-flight) compute it from the inlined CLPIs, as they do UHD.

**Tech Stack:** TypeScript, Vitest (jsdom for components), React.

**Spec:** `docs/superpowers/specs/2026-11-16-hdr-labels-design.md`

## Global Constraints

- New files: `SPDX-License-Identifier: LGPL-3.0-or-later`. The parser change ports libbluray `clpi_parse.c` `_parse_stream_attr`; `clpi-parser.ts` already carries its LGPL-2.1 porting header, keep it.
- `DynamicRange` is exactly `'dv' | 'hdr10plus' | 'hdr10'`; "none" is `null`. Order of preference: `dv` over `hdr10plus` over `hdr10`.
- Badge text exactly: `dv` → `DV`, `hdr10plus` → `HDR10+`, `hdr10` → `HDR10`. Text badges in the existing `.badge` style; no logos.
- Classification over the main title's clips: `dv` if any HEVC stream has `dynamic_range_type` 2; else `hdr10plus` if one has 1 with `hdr_plus_flag`; else `hdr10` if one has 1; else `null`. Non-HEVC streams never count.
- The title service's `evidenceKey` must not change for a disc whose other evidence is unchanged: adding `dynamicRange` must cause no re-match.
- A server or cached evidence without the field reads as `null`; nothing crashes.
- Every export has a doc comment; no comment names tasks, rulings or this plan. Change `@seikou/nas` types (the wire contract) before the server and app code that use them. `npm run devsite:model` after changes under `packages/*/src`; keep `public-api.txt` equal to each barrel (`npx tsx scripts/public-api.ts`).
- The repo is public: no real disc titles anywhere.

## Review Focus

1. A Dolby Vision disc whose enhancement-layer stream is only in some clips of the main title, or whose base layer comes first: still `dv` (Task 1 test).
2. A CLPI that is missing, too large or fails to parse: the disc's `dynamicRange` is `null` and the rest of its evidence is unchanged; the scan never fails for it (Task 2 test).
3. A `library.json` written before this change: its discs' evidence is read again once, and their `evidenceKey` is the same as before (Task 2 test).
4. An older NAS that sends no `dynamicRange`: tiles and rows show no badge and don't throw (Task 4 test).
5. A title with an HDR10 UHD copy and an SDR Blu-ray copy, or discs of different kinds across seasons: the tile shows the best (Task 3 test).

---

### Task 1: The CLPI parser reads dynamic range, and a classifier

**Files:**
- Modify: `packages/bdmv/src/clpi-parser.ts` (`ProgramStream`, its attribute parsing)
- Create: `packages/bdmv/src/dynamic-range.ts`, `packages/bdmv/src/dynamic-range.test.ts`
- Modify: `packages/bdmv/src/clpi-parser.test.ts`, `tests/helpers/bdmv-builders.ts`

**Interfaces:**
- Produces: `ProgramStream.dynamicRange: number` (CLPI `dynamic_range_type`, 0 for non-HEVC) and `ProgramStream.hdrPlus: boolean`.
- Produces: `export type DynamicRange = 'dv' | 'hdr10plus' | 'hdr10'` and `export function dynamicRangeOf(clips: readonly Clpi[]): DynamicRange | null` in `dynamic-range.ts`, marked `@internal` and imported by others as `@seikou/bdmv/dynamic-range` (so it needs no example and stays off the barrel).
- Produces: `writeCodingInfo` and `ClpiSpec`/`StreamSpec` stream options `dynamicRange?: number; colorSpace?: number; hdrPlus?: boolean` (HEVC only: after the format/rate byte, one byte of aspect, 2 skipped bits, oc_flag, cr_flag written as zero, then `dynamic_range_type` 4 bits, `color_space` 4 bits, `hdr_plus_flag` 1 bit, 7 reserved bits; other video codings keep 3 zero bytes).

- [ ] **Step 1: Failing tests.** In `clpi-parser.test.ts`: `parses dynamic_range_type and hdr_plus_flag of an HEVC stream` builds a CLPI with an HEVC stream `{ dynamicRange: 1, colorSpace: 2, hdrPlus: true }` and an H.264 stream, and expects `{ dynamicRange: 1, hdrPlus: true }` and `{ dynamicRange: 0, hdrPlus: false }`. In `dynamic-range.test.ts`: `null` for SDR HEVC and for H.264; `'hdr10'` for 1; `'hdr10plus'` for 1 with hdrPlus; `'dv'` when a second clip's second HEVC stream (the enhancement layer, PID 0x1015) says 2 and the first clip's base layer says 1; `'dv'` over `'hdr10plus'` across clips; `null` for an empty list.
- [ ] **Step 2:** `npx vitest run packages/bdmv/src/clpi-parser.test.ts packages/bdmv/src/dynamic-range.test.ts` — FAIL.
- [ ] **Step 3:** Implement the parser fields (libbluray reads them only for coding type 0x24) and `dynamicRangeOf`; extend the builder.
- [ ] **Step 4:** Same command — PASS; then `npm run typecheck`, `npm run devsite:model`, `npx vitest run packages/bdmv tests/public-api.test.ts tests/documentation.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(bdmv): the CLPI parser reads an HEVC stream's dynamic range`.

### Task 2: The NAS scan records each disc's dynamic range

**Files:**
- Modify: `packages/titles/src/disc-evidence.ts` (`DiscEvidence`)
- Modify: `server/src/titles/evidence.ts` (`evidenceOf`), `server/src/library.ts` (`validEvidence`), `server/src/titles/service.ts` (`evidenceKey`)
- Test: the existing tests beside those files (`server/src/titles/evidence.test.ts`, `server/src/library.test.ts`, `server/src/titles/service.test.ts`); fix any other `DiscEvidence` literal typecheck flags (tests, fixtures) by adding `dynamicRange: null`.

**Interfaces:**
- Consumes: `dynamicRangeOf`, `DynamicRange` from `@seikou/bdmv/dynamic-range`; `chooseMainTitle` from `@seikou/engine/disc/main-title` (libbluray's main-title rule, the one the app's pre-flight uses).
- Produces: `DiscEvidence.dynamicRange: DynamicRange | null` (required; `@seikou/titles` takes the union from `@seikou/nas` once Task 3 adds it, so in this task declare it in `disc-evidence.ts` as `'dv' | 'hdr10plus' | 'hdr10' | null` and Task 3 replaces it with the `@seikou/nas` type).

- [ ] **Step 1: Failing tests.**
  - evidence: a folder disc built with the test builders whose main title's clip has an HEVC HDR10 stream gives `dynamicRange: 'hdr10'`; an H.264 disc gives `null`; a disc whose main title's CLPI is corrupt gives `null` with its playlists and other fields unchanged; the same for an ISO (use the existing ISO evidence test's setup).
  - library: a cached entry whose evidence lacks `dynamicRange` is not valid (so the next scan reads it); one with `null` or `'dv'` is valid; one with `'hdr'` is not.
  - service: `evidenceKey` of an evidence with `dynamicRange: 'dv'` equals that of the same evidence with the field removed.
- [ ] **Step 2:** run those three test files — FAIL.
- [ ] **Step 3:** In `evidenceOf`, after the playlists, choose the main title with `chooseMainTitle` over the playlists with video (as `mainTitle` in `src/ui/nas/library-model.ts` does), read the CLPI (`BDMV/CLIPINF/<clip>.CLPI`, under `MAX_READ_BYTES`) of each of its distinct clips through the same `read`, parse them (a clip that fails to read or parse is skipped), and set `dynamicRange: dynamicRangeOf(...)`. `evidenceKey` hashes the evidence without `dynamicRange`.
- [ ] **Step 4:** the three files, then `npx vitest run --project server` (or the server tests by path) and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(server): the library scan records a disc's dynamic range, outside the match key`.

### Task 3: The wire contract and the catalogue

**Files:**
- Modify: `packages/nas/src/nas-api.ts` (`DynamicRange`, `DiscRef`, `TitleSummary`), `packages/nas/public-api.txt`, its barrel
- Modify: `packages/titles/src/disc-evidence.ts` (use the `@seikou/nas` type), `packages/titles/src/catalogue.ts`
- Test: `packages/titles/src/catalogue.test.ts`

**Interfaces:**
- Produces: `export type DynamicRange = 'dv' | 'hdr10plus' | 'hdr10'` from `@seikou/nas`'s root; `DiscRef.dynamicRange?: DynamicRange | null` and `TitleSummary.dynamicRange?: DynamicRange | null` (optional on the wire, because older servers send neither; the server always sends it); `export function bestDynamicRange(ranges: Iterable<DynamicRange | null | undefined>): DynamicRange | null` in `@seikou/nas` (`dynamic-range.ts`, root export with an `@example` in `packages/nas/examples/`), used by the catalogue and the app.

- [ ] **Step 1: Failing tests.** catalogue: a title with an HDR10 copy and an SDR copy of disc 1 has `dynamicRange: 'hdr10'` and each `DiscRef` its own; a series with a DV disc in season 2 and HDR10+ in season 1 is `'dv'`; an extra counts; a title with no HDR disc is `null`; Unsorted and Hidden refs carry theirs; a related-title summary from `entrySummary` (no discs) is `null`. `bestDynamicRange` unit test with the order and `undefined`.
- [ ] **Step 2:** `npx vitest run packages/titles/src/catalogue.test.ts packages/nas` — FAIL.
- [ ] **Step 3:** Implement; `discRef` copies `e.dynamicRange`; the summary takes `bestDynamicRange` over the placed discs (seasons' discs and extras, and the title's extras).
- [ ] **Step 4:** same, plus `npm run devsite:model`, `npx vitest run tests/public-api.test.ts tests/examples.test.ts tests/documentation.test.ts`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(titles): discs and titles carry their dynamic range`.

### Task 4: Badges in the app, and the docs

**Files:**
- Modify: `src/ui/nas/title-model.ts` (or `library-model.ts`): `export function dynamicRangeBadge(range: DynamicRange | null | undefined): string | null`
- Modify: `src/ui/nas/library-model.ts`: `DiscFacts.dynamicRange: DynamicRange | null` from the manifest's inlined CLPIs of the main title (`dynamicRangeOf`); `discBadges(disc, facts)` adds the dynamic range badge after `UHD`
- Modify: `src/ui/nas/TitleLibrary.tsx` (`TitleCard`, `TitleRow`), `src/ui/nas/SeasonScreen.tsx` (disc rows, from the slot's first copy), `src/ui/nas/LibraryScreen.tsx` and `src/ui/nas/Preflight.tsx` (through `discBadges`), and wherever else a `TitleSummary` card renders (related titles; the builder checks `ContinueRow`)
- Modify: `src/ui/styles.css` only if a card needs placement for the badge
- Modify: `docs/nas.md` (the help page's library section: the badges and that HDR10+ and DV come from the disc), `CLAUDE.md` (one sentence in the NAS server paragraph: evidence includes `dynamicRange`, kept out of the match key; one in the client part: the badges)
- Test: `src/ui/nas/library-model.test.ts`, `src/ui/nas/title-model.test.ts`, and a jsdom component test for `TitleCard`/`TitleRow` (`// @vitest-environment jsdom`)

- [ ] **Step 1: Failing tests.** `dynamicRangeBadge`: `'dv'` → `'DV'`, `'hdr10plus'` → `'HDR10+'`, `'hdr10'` → `'HDR10'`, `null`/`undefined` → `null`. `discFacts` over a manifest whose inlined main-title CLPI says HDR10 → `dynamicRange: 'hdr10'`; `discBadges` gives `['ISO', 'UHD', 'HDR10']` in that order. A `TitleCard` for a summary with `dynamicRange: 'dv'` shows a `.badge` with text `DV`; one whose summary lacks the field shows none.
- [ ] **Step 2:** run them — FAIL.
- [ ] **Step 3:** Implement; badges carry `data-testid="dynamic-range-badge"`.
- [ ] **Step 4:** the tests, `npm test`, `npm run typecheck`, `npm run build`, and `npx playwright test tests/e2e/nas.spec.ts --project=chromium` (no HDR disc in the stand-in's fixtures, so it proves nothing regressed) — PASS.
- [ ] **Step 5: Commit** `feat(ui): DV, HDR10+ and HDR10 badges in the NAS library`.
