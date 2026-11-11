# Developer Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer reference for the eight `@seikou` packages at `bluray.pages.dev/developers`, generated from the code, with a tested example for every public function, constructor and method.

**Architecture:** Each package's `index.ts` is narrowed to the API integrators use. TypeDoc (TypeScript 5.9, in its own `tools/devsite/` folder) writes a JSON model; a Vite plugin beside `vite/markdown.ts` turns the model, the READMEs, `docs/integrating.md` and the example files into static pages under `dist/developers/`. Examples are small programs in `packages/<name>/examples/`, run by Vitest (Node) or Playwright (browser), and a test fails when a public function has none.

**Tech Stack:** TypeScript 7 (repo), TypeScript 5.9 + TypeDoc (tool folder only), Vite, marked (already used by `/help`), Vitest, Playwright, rolldown's oxc parser (as `scripts/doc-check.ts` uses it).

**Spec:** `docs/superpowers/specs/2026-11-07-developer-site-design.md` (§7 and §7.1 override earlier sections).

## Global Constraints

- Eight packages: `bdmv`, `nas`, `pg`, `ass`, `engine`, `titles`, `fansubs`, `matroska`. The encoder, app, server and Worker are not documented.
- Public API rule (owner's decision, revised): a package's public API is the entry points its README presents (Modules and Usage sections), the types those take and return, and every name `docs/integrating.md` uses; nothing code outside the package (`src/`, `server/`, `rendezvous/`, `encoder/`, `tools/`) imports from the package root may be dropped. The list lives in `packages/<pkg>/public-api.txt`, one name per line. Everything else leaves the barrel, stays importable through `./*`, is not on the site and needs no example. Tests do not count as consumers.
- Every function, class constructor and public method in a barrel gets an example; interfaces, types and constants are documented and link to the examples that use them.
- URLs: `/developers`, `/developers/<package>`, `/developers/<package>/<export>` (class members are anchors), `/developers/integrating`.
- Pages are pre-rendered static HTML readable without JavaScript; only search needs JavaScript. The developer entry never imports the player app, never starts the engine, and imports nothing from `src/ui` except the shared tokens stylesheet.
- The player's service worker does not precache `developers/**` and its navigation route does not answer `/developers/` paths. `dist/developers/404.html` answers unknown developer URLs.
- The repository's typecheck and build stay on TypeScript 7; TypeScript 5.9 and TypeDoc live only in `tools/devsite/` (own `package.json`, own lockfile).
- Look: Seikou's palette and Instrument Sans; light and dark follow the player's theme switch (`bluray-web:theme`); readable at 375 px; keyboard navigable with visible focus; reduced motion respected. Designed with the `frontend-design:frontend-design` skill.
- Licensing: new files carry `SPDX-License-Identifier: LGPL-3.0-or-later`; every new export has a doc comment (`tests/documentation.test.ts` enforces it); no ruling or task numbers in comments.
- Public repo: examples use only the synthetic fixtures and made-up names.

## Review Focus

1. A barrel narrowing that drops a name some consumer imports from the package root (typecheck catches TS imports, but a `.tsx` or a script outside `tsc -b`'s projects may not be checked): Task 1's test computes consumers from every tracked file, not from tsconfig projects.
2. An example that passes its test but shows code a reader cannot paste (imports from a subpath or a relative path into the package's `src/`): Task 5's runner test fails an example that imports anything but its package's root (and other packages' roots).
3. The player's offline shell answering a `/developers/...` link (a stale service worker serving `index.html`): Task 9's E2E checks a developer deep link and an unknown developer URL with the service worker active.
4. A doc comment's Markdown or a type with `<`/`>` breaking the page or injecting HTML: Task 8's renderer test renders an export whose comment holds `<script>`, `Array<string>` and a code span, and expects escaped output.
5. A stale model (packages changed, model not regenerated) building a site that disagrees with the code: Task 3's model carries a hash of the packages' sources, and the plugin fails the build when it differs.

---

### Task 1: The public API rule as a test

**Files:**
- Create: `scripts/public-api.ts`
- Create: `tests/public-api.test.ts`

**Interfaces:**
- Produces: `rootImports(): Map<string, Set<string>>` (package name such as `bdmv` → names imported from `@seikou/<name>` by tracked files outside `packages/` and outside test files, including `import type`), `guideNames(): Map<string, Set<string>>` (the same from the TypeScript code blocks of `docs/integrating.md` and `docs/integrating/minimal-player.ts`), `barrelNames(pkg: string): Set<string>` (the names `packages/<pkg>/src/index.ts` exports, following `export *` and `export { … } from` with the oxc parser), `publicApi(pkg: string): Set<string>` (`rootImports ∪ guideNames` for that package). Parsing reuses `parseSource` from `scripts/doc-check.ts`.

- [ ] **Step 1: Write the test.** For each of the eight packages: `expect([...barrelNames(p)].sort()).toEqual([...publicApi(p)].sort())`, plus a unit case on temp files that `export * from './a'` exports `a`'s names and that `import { x as y }` counts `x`.
- [ ] **Step 2: Run it.** `npx vitest run tests/public-api.test.ts`. Expected: FAIL for the packages with wider barrels; record each package's extra names in the report (this is the narrowing worklist for Task 2).
- [ ] **Step 3: Implement `scripts/public-api.ts`** until the unit cases pass; mark the eight per-package cases `it.fails` for now, so the file is green and Task 2 flips them.
- [ ] **Step 4: Commit.** `test: the public API rule, a barrel exports what integrators and the repo import from its root`

### Task 2: Narrow the eight barrels

**Files:**
- Modify: `packages/*/src/index.ts`
- Modify: any test file that imported a dropped name from a package root (move it to the `@seikou/<pkg>/<module>` subpath)
- Modify: file headers of modules none of whose exports stay public (add the line `Internal to @seikou/<pkg>: not part of its public API; importable through the package's subpath for Seikou's own use.`), and a `@internal` tag on each dropped export of a module that keeps others
- Modify: `tests/public-api.test.ts` (flip `it.fails` to `it`)

**Interfaces:** Consumes Task 1's `publicApi`.

- [ ] **Step 1:** Replace every `export *` and every barrel line whose names are not all public with named exports of exactly `publicApi(pkg)`, grouped by module, each group with a one-line comment saying what it is for.
- [ ] **Step 2:** `npx vitest run tests/public-api.test.ts` — PASS for all eight. `npm run typecheck && npm test && npm run package-smoke` — PASS (fix test imports, never widen a barrel to satisfy a test).
- [ ] **Step 3:** Record `BASE=$(git rev-parse HEAD)` before Step 1; `npx tsx scripts/doc-check.ts unchanged $BASE $(git diff --name-only $BASE)` lists only `index.ts` files, moved test imports and the new tests (comments and tags elsewhere must not count as code).
- [ ] **Step 4: Commit.** `refactor(packages): each barrel exports the API integrators use, the rest is internal`

### Task 3: TypeDoc model in `tools/devsite/`

**Files:**
- Create: `tools/devsite/package.json` (private; devDependencies `typescript` `~5.9`, `typedoc` latest that supports 5.9), `tools/devsite/package-lock.json`, `tools/devsite/tsconfig.json` (the packages' sources, `moduleResolution: bundler`, `allowImportingTsExtensions`, `noEmit`, the `vite/client` types from the repo), `tools/devsite/model.mjs`, `tools/devsite/README.md`
- Modify: root `package.json` (scripts `devsite:install` → `npm ci --prefix tools/devsite`, `devsite:model` → `node tools/devsite/model.mjs`, `prebuild` → `npm run devsite:model`)
- Test: `tests/devsite-model.test.ts` (skips with a reason when `.cache/devsite/model.json` is absent)

**Interfaces:**
- Produces: `.cache/devsite/model.json`: TypeDoc's JSON output for the eight entry points (`packages/<p>/src/index.ts`, `entryPointStrategy: "expand"` off, one project with eight modules named by package), plus a top-level `seikouSourceHash` (SHA-256 over every tracked file under `packages/*/src`, `packages/*/README.md` and `packages/*/examples`, sorted by path).

- [ ] **Step 1: Write the test:** the model has a module `bdmv` with a function reflection `parseMpls` whose comment summary is non-empty and whose signature has a parameter; a module `engine` with a class `PlayerController` with a method `open`; `seikouSourceHash` equals a fresh hash computed by the test the same way.
- [ ] **Step 2:** FAIL (no model). **Step 3:** Implement `model.mjs` (TypeDoc `Application.bootstrapWithPlugins`, `excludeInternal: true`, `excludePrivate: true`, `skipErrorChecking: true` since the repo typechecks with TS 7, then `app.convert()` and `app.generateJson()`, then add the hash). **Step 4:** `npm run devsite:install && npm run devsite:model && npx vitest run tests/devsite-model.test.ts` — PASS.
- [ ] **Step 5: Commit.** `feat(devsite): TypeDoc writes the packages' model from its own TypeScript 5.9 tool folder`

### Task 4: The site's data from the model

**Files:**
- Create: `vite/devsite/model.ts`, `vite/devsite/model.test.ts` (with a small hand-written TypeDoc JSON fixture in `vite/devsite/__fixtures__/model.json`)

**Interfaces:**
- Produces:
  ```ts
  export interface DevExample { readonly file: string; readonly code: string; readonly region?: string }
  export interface DevParam { readonly name: string; readonly type: string; readonly doc: string; readonly optional: boolean }
  export interface DevSignature { readonly text: string; readonly params: readonly DevParam[]; readonly returns: { type: string; doc: string }; readonly throws: readonly string[] }
  export interface DevMember { readonly name: string; readonly kind: 'method' | 'property' | 'accessor' | 'constructor'; readonly summary: string; readonly signatures: readonly DevSignature[]; readonly example?: DevExample }
  export interface DevExport { readonly pkg: string; readonly name: string; readonly kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum'; readonly summary: string; readonly body: string; readonly signatures: readonly DevSignature[]; readonly members: readonly DevMember[]; readonly example?: DevExample; readonly usedBy: readonly string[]; readonly source: { file: string; line: number } }
  export interface DevPackage { readonly name: string; readonly readme: string; readonly exports: readonly DevExport[] }
  export function loadSite(modelPath: string, repoRoot: string): DevPackage[]
  export function needsExample(e: DevExport): readonly string[] // export or member names that must have an example
  ```
  `summary` is the comment's first paragraph as Markdown; `body` the rest; `@throws` tags feed `throws`; `@example <path>` resolves relative to the source file and, with `#<region>`, to the `// #region <name>` … `// #endregion` block; `usedBy` lists the exports whose examples mention this name (for interfaces and types).
- [ ] **Step 1: Tests** against the fixture: a function's signature text, a param's doc, a `@throws`, an `@example ../examples/parse.ts` resolved to the file's code, `@example ../examples/player.ts#open` resolved to the region, `needsExample` listing a class's constructor and public methods but not an interface, `loadSite` throwing `stale model: run npm run devsite:model` when the hash differs.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit.** `feat(devsite): the site's packages, exports and examples from the TypeDoc model`

### Task 5: Example runner and the example check (warn mode)

**Files:**
- Create: `tests/examples.test.ts` (Node examples), `tests/e2e/examples.spec.ts` (browser examples, `chromium` project only), `vite/devsite/examples-page.ts` (builds `dist/developers/_examples/index.html` that imports every `*.browser.ts` example and records `{ file, ok, error }` on `window.__examples`)
- Create: `packages/bdmv/examples/parse-mpls.ts` as the first example (proves the runner)

**Interfaces:**
- An example file exports `export default async function example(): Promise<void>` and throws on failure; a browser example is named `*.browser.ts`. A Node example reads fixtures by `import.meta.url`-relative paths into `fixtures/synthetic/`; a browser example fetches `/developers/_examples/fixtures/<path>` (the examples page copies the fixtures the browser examples list).
- Produces: `exampleProblems(site: DevPackage[]): string[]` in `vite/devsite/model.ts` — every `needsExample` name without an example, every example file under `packages/*/examples/` no export names, and every example that imports anything other than a `@seikou/<pkg>` root.

- [ ] **Step 1: Tests:** `tests/examples.test.ts` runs each non-browser example (one `it` per file) and has `it('every public function has an example', …)` that logs `exampleProblems` and passes while `DEVSITE_EXAMPLES_STRICT` is unset (warn mode), failing when it is `1`; a unit case that an example importing `@seikou/bdmv/mpls-parser` is reported.
- [ ] **Step 2–4:** FAIL, implement, PASS (the first example runs; the check lists the rest).
- [ ] **Step 5: Commit.** `test(devsite): examples run as tests, and a check lists the functions without one`

### Task 6: Shared tokens and the theme for both entries

**Files:**
- Create: `src/ui/tokens.css` (the `:root` and `:root[data-theme='light']` custom properties moved out of `src/ui/styles.css`, unchanged)
- Modify: `src/ui/styles.css` (imports `./tokens.css`), `src/ui/theme-contrast.test.ts` (reads tokens from the new file)
- Create: `vite/devsite/theme-boot.ts` exporting `THEME_BOOT_SCRIPT: string` (the same logic as `index.html`'s `#theme-boot`), and extend `src/ui/theme-boot.test.ts` to run both scripts against the same cases

- [ ] **Step 1:** Extend the boot test (both scripts set the same `data-theme` and `theme-color` for each stored choice and scheme). **Step 2:** FAIL. **Step 3:** Move the tokens; write `THEME_BOOT_SCRIPT`. **Step 4:** `npm run typecheck && npx vitest run src/ui/theme` PASS, and `npx playwright test theme.spec --project=chromium` PASS (the player looks the same).
- [ ] **Step 5: Commit.** `refactor(ui): the colour tokens in one stylesheet the developer pages share`

### Task 7: The look (frontend-design)

**Files:**
- Create: `docs/superpowers/specs/2026-11-10-developer-site-look.md` (the design plan), `vite/devsite/site.css`

- [ ] **Step 1:** Load `frontend-design:frontend-design`. Write the design plan in the skill's form (palette from `tokens.css`, type scale, layout with ASCII wireframes for the index, a package page, an export page and phone width, the one memorable element, principles), review it against the skill's list of defaults and record what was revised and why.
- [ ] **Step 2:** Write `site.css` from the plan; a static mock (`vite/devsite/__fixtures__/mock.html`) of an export page with a long signature, a parameter table, a throws list and an example, screenshotted headlessly (Playwright, `channel: 'chrome'`, headless) at 1280 and 375 px in dark and light; attach the screenshot paths in the report. Never open a headed browser.
- [ ] **Step 3: Commit.** `feat(devsite): the developer site's look`

### Task 8: Page templates and search

**Files:**
- Create: `vite/devsite/render.ts`, `vite/devsite/render.test.ts`, `vite/devsite/search.ts` (the client script, plain TS bundled by the plugin), `vite/devsite/search-index.ts`

**Interfaces:**
- Produces: `renderIndex(site: DevPackage[]): string`, `renderPackage(p: DevPackage, site: DevPackage[]): string`, `renderExport(e: DevExport, site: DevPackage[]): string`, `renderGuide(markdown: string): string`, `render404(): string`, `searchIndex(site: DevPackage[]): { pkg: string; name: string; kind: string; summary: string; href: string }[]`. Every page: `<!doctype html>`, `lang="en"`, title `"<name> · @seikou/<pkg> · Seikou developers"` (index: `Seikou developers`), the theme boot script inline in `<head>`, `site.css`, a header with the package list and the search box, a footer link to GitHub. Type names in signatures link to their export pages when they are public exports of any package.
- [ ] **Step 1: Tests:** an export page escapes `<script>` in a comment and `Array<string>` in a signature; a code span renders as `<code>`; a type that is a public export links to `/developers/<pkg>/<name>`; a class page has an anchor per member (`#open`); the guide page keeps the guide's example block verbatim; `searchIndex` has one entry per public export; HTML passes a well-formedness check (parse with `DOMParser` in jsdom, no parser errors).
- [ ] **Step 2–4:** FAIL, implement (Markdown through `marked`, the same options as `vite/markdown.ts`), PASS.
- [ ] **Step 5: Commit.** `feat(devsite): page templates and the search index`

### Task 9: The plugin, the build and the service worker

**Files:**
- Create: `vite/devsite/plugin.ts`
- Modify: `vite.config.ts` (add the plugin; `globIgnores` gains `developers/**`), `src/sw.ts` (navigation `denylist` gains `/^\/developers(\/|$)/`), `scripts/ci-changes.sh` (`SITE` and the unit group include `tools/devsite/`), `.github/workflows/ci.yml` (the jobs that run `npm run build` run `npm run devsite:install` first)
- Test: `tests/e2e/developers.spec.ts`

**Interfaces:** Consumes Tasks 4, 5 (`examples-page`), 8. The plugin's `generateBundle` emits `developers/index.html`, `developers/<pkg>/index.html`, `developers/<pkg>/<export>/index.html`, `developers/integrating/index.html`, `developers/404.html`, `developers/search.json`, `developers/site.css`, `developers/search.js`, `developers/_examples/…`; it calls `loadSite`, which fails the build on a stale model.

- [ ] **Step 1: E2E** (chromium and mobile-chromium): `/developers` lists eight packages; `/developers/bdmv/parseMpls` shows its signature and example with no request to the engine worker or `audio.wasm` (record requests); search for `mpls` offers `parseMpls` and Enter goes there; with the player's service worker installed (visit `/` first, wait for `navigator.serviceWorker.ready`), `/developers/bdmv/parseMpls` still returns the developer page and `/developers/nope` returns the 404 page; the theme switch on a developer page sets `data-theme` and survives a reload; axe-free basics: every page has one `h1` and a visible focus ring on links.
- [ ] **Step 2–4:** FAIL, implement, PASS: `npm run build && npx playwright test tests/e2e/developers.spec.ts --project=chromium --project=mobile-chromium`, and `npx playwright test tests/e2e/examples.spec.ts --project=chromium` (the browser examples page loads and reports none failed; with only the bdmv example so far it has no browser examples, so the spec asserts an empty list without errors).
- [ ] **Step 5:** `npx playwright test offline.spec --project=chromium` still PASS (the player's offline behaviour is unchanged).
- [ ] **Step 6: Commit.** `feat(devsite): /developers is built with the site, outside the player's service worker`

### Tasks 10–14: Examples, package by package

Each: write an example for every name `needsExample` lists for the package (`npx vitest run tests/examples.test.ts` prints them), add `@example` tags to the doc comments, run `npx vitest run tests/examples.test.ts` and, for browser examples, `npm run build && npx playwright test tests/e2e/examples.spec.ts --project=chromium`; expected: the package's names gone from the check's list and every example passing. Examples are short, use only the package roots, read only `fixtures/synthetic/` (or a few bytes built in the example), and each starts with one comment line saying what it shows. Commit per task: `docs(<pkg>): an example for every public function`.

- **Task 10:** `bdmv` (parsers on `fixtures/synthetic/disc1`, the demuxer on its clip, `readUdf` on `fixtures/synthetic/disc1.iso`).
- **Task 11:** `pg` and `ass` (PG segments from `fixtures/synthetic/disc-subs`; `parseAss` on a short script; the renderer as a browser example, since it needs Canvas2D and FontFace).
- **Task 12:** `matroska` and `nas` (write then read a tiny MKV in memory; the wire contract's pure functions).
- **Task 13:** `titles` and `fansubs` (pure functions on made-up names; network clients with an injected `fetch` answering recorded fixtures).
- **Task 14:** `engine` (the controller and worker as browser examples on `fixtures/synthetic/disc1`; pure helpers in Node).

### Task 15: The check fails the build, and the docs

**Files:**
- Modify: `tests/examples.test.ts` (strict always; remove `DEVSITE_EXAMPLES_STRICT`), `CLAUDE.md` (Commands: `devsite:install`, `devsite:model`, the developer E2E; Architecture: the site and the public API rule), `docs/integrating.md` and every `packages/*/README.md` (link `/developers/<pkg>`), `docs/README.md`
- [ ] **Step 1:** Make the check strict; `npx vitest run tests/examples.test.ts` PASS (nothing missing).
- [ ] **Step 2:** `npm run typecheck && npm test && npm run build && npm run licence-check && npm run package-smoke && npx playwright test tests/e2e/developers.spec.ts tests/e2e/examples.spec.ts --project=chromium` — all PASS.
- [ ] **Step 3:** Humanizer pass (`humanizer:humanizer`) over the README and CLAUDE.md text this plan added.
- [ ] **Step 4: Commit.** `docs: every public function has an example, and the check now fails without one`
