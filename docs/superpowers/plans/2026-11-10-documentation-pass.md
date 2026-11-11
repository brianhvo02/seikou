# Documentation Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every source area of the repository up to the encoder's documentation standard, rename the project's own copyright holder to Seikou, add the package exports the integration guide needs, write `docs/integrating.md`, and make CI keep it that way.

**Architecture:** The encoder's doc checker moves to `scripts/doc-check.ts` and gains two checks (old-name comments, and "only comments changed" against a base commit). One Vitest test, `tests/documentation.test.ts`, runs the checks over a list of enrolled areas. Each area task enrolls its area first (the test fails), writes the comments (the test passes), and proves with the code-unchanged check that no code moved. The last task replaces the list with the whole scope.

**Tech Stack:** TypeScript (strict), Vitest, rolldown's oxc parser (`rolldown/utils` `parseSync`, already used by the checker), bash (`scripts/package-smoke.sh`, `scripts/licence-check.sh`), Vite.

**Spec:** `docs/superpowers/specs/2026-11-10-documentation-pass-design.md`

## Global Constraints

- Scope: `packages/*/src`, `src/` (not `src/bdj-classlib/`), `server/src`, `rendezvous/src`, and `encoder/src` with `encoder/web/src` (already at the standard). Test files (`*.test.ts`, `*.test.tsx`, `tests/`) are out of scope; so are specs, plans, `docs/known-issues.md` and `CLAUDE.md` as decision records.
- No behaviour changes. Only comments, READMEs, docs, the checker, CI wiring and package entry-point exports change. A bug found while documenting goes into `docs/known-issues.md`, not a fix.
- Standard (spec §3): every export has a doc comment (units, ownership, failure behaviour, threading context); format fields say what they mean on the disc beside the upstream C name; Blu-ray fields cite the upstream file and function ("libbluray `mpls_parse.c` `_parse_playitem`") and a BD-ROM section only where known for certain; never invent a section number; public specs cited by section (ISO/IEC 13818-1, ITU-T H.264 and H.265, ECMA-167 and UDF 2.50, RFC 9559, RFC 7845, W3C WebCodecs).
- No comment points at private history (ruling numbers such as R12 or T7h, task numbers, milestone labels such as M1 or 5e used as a pointer, internal spec section numbers); the reason is written inline; a spec file may be named in addition.
- A comment that is only an upstream name gains a plain sentence saying what the thing is. A comment that describes a past state is rewritten to describe current behaviour.
- "bluray-web" in comments becomes "Seikou". `Copyright (C) 2026  bluray-web contributors` becomes `Copyright (C) 2026  Seikou contributors` everywhere; NOTICE files say "modified for Seikou". Kept identifiers stay exactly as they are: IndexedDB database and storage keys (`bluray-web`, `bluray-web:…`, `bluray-web.fullscreen-hint-dismissed`), `ghcr.io/brianhvo02/bluray-server` and its container and volume, the Worker `bluray-rendezvous`, the `/bluray` route, `~/.cache/bluray-web`, the harness Docker image names (`bluray-web-*-trace`, `bluray-web-bdj-classlib`, `bluray-web-iso-fixture`, `bluray-web-bdj-golden-`), `bluray-web.pages.dev` in the CORS policy, and spec file names such as `2026-10-12-bluray-web-player-design.md`. In a comment a kept identifier is written in backticks.
- Voice: plain declarative sentences, no dashes as punctuation, no bold labels in comments, no marketing words, present tense.
- Licence headers keep their SPDX identifier, upstream copyright lines and "Ported from" line. New files carry `SPDX-License-Identifier: LGPL-3.0-or-later`.
- The repo is public: no real titles, series, films, artists or catalogue numbers from the owner's library in any comment, README or example.

## Review Focus

1. A comment edit that silently changes code (a deleted token, a string literal reworded, a kept `bluray-web` identifier renamed, which would lose users' IndexedDB data): every area task runs `npx tsx scripts/doc-check.ts unchanged <base> <files…>`, which must print nothing.
2. A doc comment that states behaviour the code does not have (wrong unit, wrong failure mode, a "returns null" that throws): the reviewer of each area task reads the code under every changed comment in at least the parser and protocol files, not only the comment.
3. An invented or unverifiable citation (a BD-ROM section number, a libbluray function that does not exist at commit `448f896`): the reviewer checks each new libbluray or libass name against `.cache/libbluray` (`scripts/fetch-libbluray.sh`) or the libass 0.17.5 source, and each BD-ROM section is dropped unless its source is named.
4. The history pattern flagging real identifiers (`M2TS`, `PSR22`, hex like `0x5e`, `T` in a type parameter list) or missing a real pointer (`(5e)`, `T9h`, `M2b`): the checker tests in Task 1 pin both lists.
5. The guide's example drifting from the packages or from the guide: the example is built by `package-smoke` (Task 8) and the guide's code block is compared byte for byte with the file by `tests/documentation.test.ts`.

---

### Task 1: The repo-wide checker and its test

**Files:**
- Create: `scripts/doc-check.ts` (moved from `encoder/scripts/doc-check.ts` with `git mv`)
- Create: `tests/doc-check.test.ts` (the checker's own cases, moved from `encoder/tests/docs.test.ts` and extended)
- Create: `tests/documentation.test.ts` (the enrolled areas)
- Delete: `encoder/tests/docs.test.ts`
- Modify: `encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md` only if it names the checker's path (update the path)

**Interfaces:**
- Produces, in `scripts/doc-check.ts`:
  - `undocumentedExports(files: readonly string[]): UndocumentedExport[]` (unchanged behaviour)
  - `privateHistoryComments(files: readonly string[]): HistoryComment[]` (extended pattern)
  - `oldNameComments(files: readonly string[]): HistoryComment[]`: comments containing `bluray-web` outside a backtick code span
  - `codeChanges(base: string, files: readonly string[]): string[]`: the files whose source with comments removed differs from `git show <base>:<file>`; a file new since `base` is listed only if it is not a `.md`; a file deleted since `base` is listed
  - `parseSource(file: string, source: string): Parsed` (the existing `parse` split so that it takes text; `parse(file)` reads the file and calls it)
  - A CLI: `npx tsx scripts/doc-check.ts check <file…>` prints every finding of the three checks as `<file>:<line> <kind> <name or text>` and exits 1 if any; `npx tsx scripts/doc-check.ts unchanged <base> <file…>` prints each file of `codeChanges` and exits 1 if any. With no files, both read the file list from `git ls-files` over the scope globs below.
- Produces, in `tests/documentation.test.ts`: `const ENROLLED: readonly string[]` (glob patterns relative to the repo root) and the exported helper `scopeFiles(globs: readonly string[]): string[]` (tracked `.ts`/`.tsx` files matching the globs, minus `*.test.ts`, `*.test.tsx`, `*.d.ts` and `src/bdj-classlib/**`, sorted). Later tasks add their globs to `ENROLLED`; Task 15 adds the completeness test.

- [ ] **Step 1: Move the checker and its test**

`git mv encoder/scripts/doc-check.ts scripts/doc-check.ts`. Move the "the checker finds what it should" case into `tests/doc-check.test.ts` (Vitest's `unit` project already includes `tests/*.test.ts`), importing from `../scripts/doc-check`. Delete `encoder/tests/docs.test.ts`.

- [ ] **Step 2: Write the failing checker tests**

In `tests/doc-check.test.ts`, beside the moved case (temp files written with `mkdtempSync`):

```ts
it('flags Seikou history labels and leaves identifiers alone', () => {
  const flagged = ['// ruling T7h', '// as 5e decided', '// the M4b renderer', '// (R22)', '// M2b covers it', '// spec §7'];
  const fine = ['// reads M2TS packets', '// PSR22 holds the mode', '// byte 0x5e', '// RFC 9559 §5.1', '// type T1 = number', '// ISO/IEC 13818-1 §2.4.3.6'];
  // one file holding all of them; expect privateHistoryComments(...).map(c => c.text) toEqual(flagged)
});

it('flags the old name in comments, not in strings or code spans', () => {
  const flagged = ['// Original code for bluray-web: x', ' * Copyright (C) 2026  bluray-web contributors'];
  // plus fine lines: "// the `bluray-web` IndexedDB database", "const db = 'bluray-web';"
  // expect oldNameComments(...).map(c => c.text) toEqual the two flagged comments
});

it('codeChanges sees code edits and ignores comment edits', () => {
  // in a temp git repo (git init, commit a.ts = "/** a */\nexport const a = 'x  y';\n" and b.ts = "export const b = 1;\n"),
  // rewrite a.ts's comment and b.ts's value to 2, then:
  // expect(codeChanges('HEAD', [aPath, bPath])).toEqual([bPath]);
  // and changing the string literal 'x  y' to 'x y' in a.ts is reported too.
});
```

The flagged line for the copyright is a block-comment line; write it inside a `/* … */` block in the temp file and compare against the whole comment's text as the existing checker reports it.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/doc-check.test.ts`
Expected: FAIL (`oldNameComments` and `codeChanges` are not exported; the history cases T7h, 5e, M4b, M2b are not flagged).

- [ ] **Step 4: Implement the checks**

History pattern: the encoder's alternatives plus `T\d+[a-z]\b` (Seikou's titles rulings always carry a letter), `\b5[a-e]\b`, and `M\d+[ab]?\b` in place of `M\d+\b`; keep `R\d{1,2}\b` but not after `PS` (`(?<!PS)R\d{1,2}\b`). Tune it against `npx tsx scripts/doc-check.ts check` over the whole scope until every hit you read is a real history pointer; record any deliberate exclusion in the pattern's doc comment.

`oldNameComments`: in each comment's text, remove backtick spans (`` `[^`]*` ``), then test `/bluray-web/`.

`codeChanges`: for each file, take the new text from disk (missing means deleted) and the old from `git show <base>:<file>` (missing means new); strip each text's comment ranges (from `parseSource`), collapse runs of whitespace outside string, template and regex literals to one space, and compare. Collapsing inside literals is not allowed: `'x  y'` to `'x y'` is a code change. Use the parser's token ranges for literals, or, if oxc's AST is the simpler route, compare the ASTs with `start`/`end` and comment fields dropped.

- [ ] **Step 5: Write `tests/documentation.test.ts`**

```ts
export const ENROLLED: readonly string[] = ['encoder/src/**', 'encoder/web/src/**'];

describe('documentation standard', () => {
  const files = scopeFiles(ENROLLED);
  it('finds the enrolled files', () => expect(files.length).toBeGreaterThan(10));
  it('every export has a doc comment', () => expect(fmt(undocumentedExports(files))).toEqual([]));
  it('no comment points at private planning history', () => expect(fmt(privateHistoryComments(files))).toEqual([]));
  it('no comment uses the old name', () => expect(fmt(oldNameComments(files))).toEqual([]));
});
```

`fmt` turns findings into `<file>:<line> <name or text>` strings so a failure lists them.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/doc-check.test.ts tests/documentation.test.ts`
Expected: PASS (the encoder is already clean).

CI needs no change: `scripts/ci-changes.sh` runs the `unit` job for every change outside Markdown, and the `unit` project includes `tests/*.test.ts`. Confirm by reading `UNIT_SKIP` there; if that no longer holds, add `tests/documentation.test.ts`'s inputs to the unit group.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`. Expected: no errors (check `scripts/` is covered by a tsconfig the way `encoder/scripts` was; if `encoder/scripts` was in `tsconfig.encoder.json`, add `scripts/doc-check.ts` to the tsconfig that already holds `scripts/*.ts`).

```bash
git add -A scripts/doc-check.ts encoder/scripts encoder/tests/docs.test.ts tests/doc-check.test.ts tests/documentation.test.ts
git commit -m "test: the doc checker covers the whole repository, flags the old name and proves only comments changed"
```

---

### Task 2: Seikou as the copyright holder and in headers

**Files:**
- Modify: every tracked file (outside `docs/superpowers/`, `encoder/docs/` and `src/bdj-classlib/`) whose comments or NOTICE text name `bluray-web` as the project: about 77 files under `packages/`, 77 under `src/`, 21 under `tools/`, and some in `scripts/`, `server/`, `rendezvous/`, `index.html`; `packages/*/NOTICE`, `src/bdj/NOTICE` and any other NOTICE.
- Modify: `scripts/licence-check.sh:16` (`own_holder`)

**Interfaces:** none produced.

- [ ] **Step 1: List the occurrences**

Run: `git grep -n "bluray-web" -- ':!docs/superpowers' ':!encoder/docs' ':!src/bdj-classlib'`
Sort each hit into: (a) copyright holder `bluray-web contributors`, (b) project wording ("modified for bluray-web", "Original code for bluray-web", "bluray-web's", "the bluray-web player"), (c) kept identifier (Global Constraints list), (d) `CLAUDE.md`, which is out of scope and keeps its explanation of the kept names.

- [ ] **Step 2: Replace (a) and (b)**

(a) becomes `Seikou contributors`; (b) becomes the same sentence with `Seikou`. Leave every (c) byte for byte. Where a comment mentions a kept identifier, put it in backticks.

- [ ] **Step 3: Tighten the licence check**

`own_holder='seikou (authors|contributors)'` (matching stays case-insensitive as today).

- [ ] **Step 4: Verify**

Run: `npm run licence-check && npx tsx scripts/doc-check.ts unchanged HEAD $(git diff --name-only HEAD -- '*.ts' '*.tsx')`
Expected: `licence-check` passes, `unchanged` prints nothing.
Run: `git grep -n "bluray-web" -- ':!docs/superpowers' ':!encoder/docs' ':!src/bdj-classlib' ':!CLAUDE.md'` and read every remaining hit: each is a kept identifier.
Run: `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "chore: Seikou is the copyright holder and the name in headers and NOTICE files"
```

---

### Tasks 3 to 14: one area each

Every area task has the same steps; each task's **Files** and **Focus** say what is particular to it. Record the base before starting: `BASE=$(git rev-parse HEAD)`.

- [ ] **Step 1: Enroll the area.** Add the task's globs to `ENROLLED` in `tests/documentation.test.ts`.
- [ ] **Step 2: Run the test to see it fail.** `npx vitest run tests/documentation.test.ts`. Expected: FAIL, listing the area's undocumented exports and history comments.
- [ ] **Step 3: Write the comments.** Every listed export; then every exported interface field, class method and public field whose name does not say it; then the task's Focus. Rewrite each history comment with its reason (read the cited spec section in `docs/superpowers/specs/` to find the reason; never guess it).
- [ ] **Step 4: Run the test to see it pass.** Same command. Expected: PASS.
- [ ] **Step 5: Prove no code changed.** `npx tsx scripts/doc-check.ts unchanged $BASE $(git diff --name-only $BASE)`. Expected: prints nothing (Task 8 alone may list its barrel and `package.json` changes).
- [ ] **Step 6: Typecheck and test.** `npm run typecheck && npx vitest run <the area's directories>`. Expected: PASS.
- [ ] **Step 7: Commit.** `git commit -am "docs(<area>): <what a reader can now find>"`.

### Task 3: `@seikou/bdmv`

**Files:** `packages/bdmv/src/**` (globs `packages/bdmv/src/**`).
**Focus:** this is the format reference. In `index-parser.ts`, `mpls-parser.ts`, `clpi-parser.ts`, `mobj-parser.ts`, `bdjo-parser.ts`, `sound-parser.ts` and `bdid-parser.ts` every field of every exported interface says what it means on the disc, its unit (45 kHz clip time, SPN, bytes) and its libbluray name (for example `PlayItem.connectionCondition`: how this item joins the previous one, 1 for a non-seamless join, 5 and 6 for seamless joins; libbluray `MPLS_PI.connection_condition`). Each interface names the libbluray struct and parse function it mirrors in a plain sentence. `demux/` cites ISO/IEC 13818-1 sections for TS packets, adaptation fields, PES headers and PTS/DTS; `codecs/` cites ITU-T H.264 and H.265 sections for the parameter sets it reads; `udf.ts` cites ECMA-167 and UDF 2.50 sections and libudfread's function names. Remove milestone-state wording such as "M1 plays main-path streams only".

### Task 4: `@seikou/pg` and `@seikou/ass`

**Files:** globs `packages/pg/src/**`, `packages/ass/src/**`.
**Focus:** PG segments (PCS, WDS, PDS, ODS, END) name what each field controls and the libbluray `pg_decode.c` / `graphics_processor.c` name. ASS: each ported function names its libass 0.17.5 counterpart (file and function) in a plain sentence; override tags and style fields say what they do as libass applies them; `device-fonts.ts` says plainly that it is an addition to the port and why.

### Task 5: `@seikou/nas`, `@seikou/titles`, `@seikou/fansubs`, `@seikou/matroska`

**Files:** globs `packages/nas/src/**`, `packages/titles/src/**`, `packages/fansubs/src/**`, `packages/matroska/src/**` (matroska is already clean and only enrolls).
**Focus:** `titles` holds 59 of the packages' history comments (matching rulings T3e … T11h): each becomes the rule it stands for, in words. `nas` wire types say which side sends each field, its unit and what an absent field means; `rtc-wire.ts` says the frame layout byte by byte. Use only made-up titles in any example.

### Task 6: `@seikou/engine`, part 1

**Files:** globs `packages/engine/src/controller/**`, `packages/engine/src/disc/**`, `packages/engine/src/nav/**`, `packages/engine/src/hdmv/**`, `packages/engine/src/graphics/**`, `packages/engine/src/playback/**`, `packages/engine/src/audio/**`, `packages/engine/src/encode/**`.
**Focus:** say each class's threading context (main thread, engine worker, AudioWorklet). HDMV: each command and register comment names what it does and the libbluray `hdmv_vm.c` / `register.c` name; PSR comments say what the register holds. `PlayerController` methods say what each sends to the worker and what the snapshot shows afterwards.

### Task 7: `@seikou/engine`, part 2

**Files:** globs `packages/engine/src/*.ts`, `packages/engine/src/decode/**`, `packages/engine/src/render/**`, `packages/engine/src/subs/**`, `packages/engine/src/shaders/**`, `packages/engine/src/util/**` (and any engine directory Task 6 did not list; after this task `packages/engine/src/**` replaces the engine globs in `ENROLLED`).
**Focus:** `protocol.ts` is the integrator's contract: every `EngineCommand` and `EngineEvent` variant and every field says what it does and when it is sent. `bdj-types.ts` and `bdj-provider.ts` hold 23 ruling references (R7, R22, R26, R32…): each becomes its reason. Shader parsing cites mpv's user shader format by its documentation section names.

### Task 8: Package exports, the integration guide and its checked example

**Files:**
- Modify: `packages/engine/src/index.ts` (export `walkEntries` and its `EntryLike`, `FileEntryLike`, `DirEntryLike` types from `./controller/entry-walk`; `RemoteSource`, `RemoteSourceOptions`, `RangeTransport` from `./disc/remote-source`)
- Modify: `packages/engine/package.json` (add an explicit `"./worker-main": "./src/worker-main.ts"` entry before `"./*"`, so the BD-J worker entry route is a declared entry point and not an internal path)
- Modify: `packages/bdmv/src/index.ts` only if `readUdf`/`UdfImage` are not already exported (the README says they are; check)
- Create: `docs/integrating/minimal-player.ts` and `docs/integrating/index.html` (the guide's example)
- Create: `docs/integrating.md`
- Modify: `scripts/package-smoke.sh` (copy the example into the temp project, typecheck it with the strict tsconfig, build it with Vite)
- Modify: `packages/*/README.md` (link the guide; a short usage example where a README has none), `README.md` (link the guide), `docs/README.md` (index it)
- Modify: `tests/documentation.test.ts` (the drift test)

**Interfaces:**
- Consumes: `createEngineWorker(name: string): Worker`, `createController(options: CreateControllerOptions): PlayerController`, `PlayerController.attachCanvas`, `startAudio`, `open(entries, start?)`, `openRemote(spec: RemoteDiscSpec, …)`, `play`, `pause`, `seek(timeUs)`, `selectAudio`, `selectSubtitle`, `subscribe`, `getSnapshot`; `walkEntries(entries, maxDepth)`.
- Produces: the exports above; `docs/integrating.md` with the example between `<!-- example:minimal-player -->` and `<!-- /example -->` markers.

- [ ] **Step 1: Write the drift test**

In `tests/documentation.test.ts`: read `docs/integrating.md`, take the fenced code block between the markers, and expect it to equal `docs/integrating/minimal-player.ts` with its first SPDX line removed.

- [ ] **Step 2: Run it to see it fail.** `npx vitest run tests/documentation.test.ts -t "guide"`. Expected: FAIL (no guide).

- [ ] **Step 3: Add the exports.** Then extend `package-smoke.sh`'s `barrels.ts` with a line that imports `walkEntries` and `RemoteSource` from `@seikou/engine` and `startEngineWorker` from `@seikou/engine/worker-main`, so the strict tsc proves they resolve.

- [ ] **Step 4: Write the example.** `minimal-player.ts` imports only from `@seikou/engine`: a button that picks a folder (`webkitdirectory` input), a canvas, `createController({ worker: () => createEngineWorker('engine'), profile: 'desktop' })`, `attachCanvas`, `startAudio` on the click (a user gesture), `open` with the picked files as `[relativePath, File]` pairs, a play/pause button, and a line of status from `subscribe`/`getSnapshot`. `index.html` loads it. Keep it under 80 lines.

- [ ] **Step 5: Build it in the smoke test.** `package-smoke.sh` copies both files into the temp project, adds `minimal-player.ts` to the strict tsconfig's `files`, and replaces the current one-line `index.html` with the example's; the existing asset checks stay.

Run: `npm run package-smoke`. Expected: `package-smoke: ok`.

- [ ] **Step 6: Run the example once by hand.** In the smoke script's temp project (or a copy), `npx vite --port 5180` with COOP/COEP headers (copy `vite.config.ts`'s `isolate-every-response` plugin into a small config there), open it in Chrome with the chrome-devtools MCP, pick `fixtures/synthetic/disc1`, and confirm the status line reaches playing and the canvas shows frames. Note what you did in the commit message. This step is manual and is not added to CI.

- [ ] **Step 7: Write `docs/integrating.md`.** The eight sections of spec §5 in order, the example block between the markers, and the BD-J route checked against the code: the integrator takes `src/bdj/`, `src/bdj-classlib/`, `src/wasm/freetype/` and `src/fonts/` if `src/bdj` imports it (run `git grep -h "from '" -- src/bdj` and follow every import that leaves `src/bdj`), writes a worker entry like `src/engine-worker.ts` (`startEngineWorker` from `@seikou/engine/worker-main`, `seikouBdjProvider` with `missing`, `loadClassLibrary` and the font and FreeType URLs), and passes it to `createController` as the worker factory. Say plainly that the copied BD-J files import package internals through `@seikou/engine/*` and `@seikou/bdmv/*` paths, and add a `docs/roadmap.md` row "BD-J as a package" (size M). The licensing section lists each piece's licence and points at its `LICENSE` and `NOTICE` files, with no interpretation. Do not add the guide to `src/ui/help/help-pages.ts`.

- [ ] **Step 8: Run the tests.** `npx vitest run tests/documentation.test.ts && npm run typecheck && npm run package-smoke`. Expected: PASS and `package-smoke: ok`.

- [ ] **Step 9: Commit.**

```bash
git commit -am "docs: an integration guide with a built example, and the engine exports it needs"
```

### Task 9: `rendezvous/src` and the server's levels and titles

**Files:** globs `rendezvous/src/**`, `server/src/levels/**`, `server/src/titles/**`.
**Focus:** `levels/` holds 28 history comments and writes formats (CLPI, MPLS, PMT, TS): each written field cites what it means and the libbluray parse function that reads it back. The Worker's routes say who may call them and what each refusal code means.

### Task 10: The rest of the server

**Files:** globs `server/src/**` (replacing Task 9's server globs).
**Focus:** each route handler says its method, path, who may call it (token, owner, HTTPS only) and its error codes, as `CLAUDE.md` lists them. `rtc/` cites RFC 8489 (STUN) and RFC 8445 (ICE) sections where it handles them.

### Task 11: The app's UI outside the NAS screens

**Files:** globs `src/*.ts`, `src/*.tsx`, `src/ui/*.ts`, `src/ui/*.tsx`, `src/ui/help/**`, `src/probe/**`, `src/wasm/**`, `src/fonts/**` (if it exists), and any `src/ui/` subdirectory other than `nas/`.
**Focus:** test-only query flags (`?telemetry=1`, `?bdjfail=1` …) say what they do where they are read. React components say what they show and which props drive it.

### Task 12: The NAS screens

**Files:** glob `src/ui/nas/**`.
**Focus:** each pure model file (`*-model.ts`) says what decision it makes and from what inputs; the 29 history comments become reasons.

### Task 13: The JVM

**Files:** glob `src/bdj/jvm/**`.
**Focus:** the class-file parser and interpreter cite the Java Virtual Machine Specification (Java SE 8 edition) by chapter and section (for example §4.4 for the constant pool, §6.5 for an instruction); natives name the Java method they implement and, where ported, the libbluray native.

### Task 14: BD-J playback and menus

**Files:** glob `src/bdj/**` (replacing Task 13's glob).
**Focus:** 54 history comments, most of them 5c to 5e rulings (R5, R7, R16, R17, R20, R22, R24, R26, R28 to R32): each becomes its reason; `CLAUDE.md`'s BD-J sections give most of them in words. Threading context on every class (engine worker or BD-J worker).

---

### Task 15: Area READMEs, the whole scope, the humanizer pass

**Files:**
- Create: `src/ui/README.md`, `src/ui/nas/README.md`, `src/bdj/README.md`, `server/src/README.md`, `rendezvous/README.md` (or `rendezvous/src/README.md`, beside the code)
- Modify: `src/README.md` (check against the standard: concepts, API, where to look)
- Modify: `tests/documentation.test.ts` (whole scope and completeness)
- Modify: `CLAUDE.md` (the Commands section names `tests/documentation.test.ts` and `scripts/doc-check.ts`, and "What this is" points integrators at `docs/integrating.md`)

- [ ] **Step 1: Write the completeness test.** In `tests/documentation.test.ts`, `const SCOPE = ['packages/*/src/**', 'src/**', 'server/src/**', 'rendezvous/src/**', 'encoder/src/**', 'encoder/web/src/**']`, and a test that `scopeFiles(SCOPE)` equals `scopeFiles(ENROLLED)`.
- [ ] **Step 2: Run it.** `npx vitest run tests/documentation.test.ts`. Expected: FAIL only if an area was missed; if so, document that area as in Tasks 3 to 14 until it passes. Then replace `ENROLLED` by `SCOPE` and remove the completeness test, which no longer says anything.
- [ ] **Step 3: Write the area READMEs.** Concepts first, then the API, then where to look in the code; one page each.
- [ ] **Step 4: Humanizer pass.** Run the `humanizer:humanizer` skill over each README written or changed in this plan (`packages/*/README.md`, the five new ones, `src/README.md`, `README.md`'s changed section), `docs/integrating.md`, and every file header longer than five lines changed in Tasks 3 to 14 (`git diff $FIRST_BASE --stat` to find them). Apply only its prose changes; never let it change a code block, an identifier or a fact.
- [ ] **Step 5: Verify everything.** `npm run typecheck && npm test && npm run licence-check && npm run package-smoke && npx tsx scripts/doc-check.ts unchanged $FIRST_BASE $(git diff --name-only $FIRST_BASE)` where `FIRST_BASE` is the commit before Task 1. Expected: all pass, and `unchanged` lists only tooling and tests (`scripts/doc-check.ts`, `encoder/scripts/doc-check.ts`, `encoder/tests/docs.test.ts`, `tests/doc-check.test.ts`, `tests/documentation.test.ts`, `docs/integrating/minimal-player.ts`) and the one source change, `packages/engine/src/index.ts` (plus `packages/bdmv/src/index.ts` if Task 8 touched it). Any other file listed is a code change to undo.
- [ ] **Step 6: Commit.**

```bash
git commit -am "docs: area READMEs, and the documentation check covers the whole repository"
```
