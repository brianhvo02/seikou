# Developer Site: Design Spec

Date: 2026-11-07
Status: Approved in conversation; queued after the encoder project, together with the packages documentation pass.
Related: `2026-11-07-packages-design.md` (the seven packages this site documents).

## 1. Intent

Seikou is being cut into seven packages (`@seikou/bdmv`, `nas`, `pg`, `ass`, `engine`, `titles`, `fansubs`) so other code can build on it, the encoder first. Someone writing code against them needs to find the right package quickly, understand its concepts, see the exact signature, units and failure behaviour of a function, and copy a working example. Today that knowledge lives in source comments of uneven depth and in planning records an outside reader will not read.

This project adds a developer reference to the existing site, at `bluray.pages.dev/developers`, generated from the packages' code so it cannot drift from it, with a tested usage example for every public function.

## 2. Goals, non-goals, anti-goals

Goals:
- A page per package: concepts first (what a playlist, a clip, a PG display set, an ASS event is), then the API, then where to look in the source.
- A page or anchored section per public export (function, class and its public members, interface, type, constant) showing its signature, the doc comment's description, parameters with units, return value, errors it throws, and a usage example.
- Every usage example is real code that the repository compiles and runs in its tests; the site shows that code.
- Search across packages and exports.
- Deep links: every package and export has a stable URL that can be pasted into an issue or a comment.
- The site's look is Seikou's own, designed with care (section 4).

Non-goals:
- The encoder, the player app, the NAS server and the rendezvous Worker are implementations, not libraries; they are not documented here. The player's user documentation stays at `/help`.
- Versioned documentation. The packages are unpublished; the site shows `main`.
- A tutorial series or blog. Package overview pages carry the concepts; anything longer is a later decision.

Anti-goals:
- An example that does not compile or no longer works, shown as if it did.
- Text on the site that disagrees with the code's signature (hand-written signatures, copied type definitions).
- A stock generator theme that looks like every other API site and nothing like Seikou.
- Making the player itself slower to load or larger to install because the reference exists.

## 3. How it is built

What counts as public (designer's call): a package's public API is what its `index.ts` exports. The documentation pass narrows each barrel to a deliberate API (no blanket `export *` of internals); everything else stays importable through the `./*` subpath export for Seikou's own use (BD-J, the app, the server) but is not documented on the site and is marked internal in its file header. Within the public API, every function, class constructor and public method has its own usage example, as the user asked ("usage examples for each function"); interfaces, type aliases and constants are documented (description, fields, units) and link to the examples that use them, without examples of their own.

Examples that need a browser (designer's call): examples for APIs that need a Worker, WebCodecs, OffscreenCanvas, FontFace or an AudioContext run in a real browser, not under stubs: a Playwright spec loads an examples page that imports each such example and fails on any thrown error, in the existing chromium E2E job. Every other example runs in the Vitest unit project.

Pages (designer's call): pre-rendered static HTML, one file per package and per export, readable without JavaScript and indexable; search is the only part that needs JavaScript. The pages are a separate Vite entry that never imports the player app, so they never start the engine. The service worker's precache glob and its navigation fallback exclude `/developers/**`, and a `_redirects` rule (or a `developers/404.html`) answers unknown developer URLs without falling back to the player shell.

- Source of truth: the packages' TypeScript and their doc comments. TypeDoc runs over `packages/*/src` (entry points: each package's `index.ts`) and emits its JSON model. A Vite plugin, beside the existing `vite/markdown.ts` that builds `/help`, turns that model plus each package's `README.md` into the site's pages. TypeDoc's HTML theme is not used.
- Examples: each public export's example lives in `packages/<name>/examples/<export>.ts` (one file per export; several small examples in one file are allowed), written as a short program against the package's public API only. A unit test per package imports and runs every example (with fixtures from `fixtures/synthetic` where an example needs a disc). A doc comment links its example with a TypeDoc `@example` tag that names the file (`@example ../examples/parse-mpls.ts`); the site inlines that file's code. A check fails the build when a public export has no example, or an example file names no export.
- URLs: `/developers` (index of packages and search), `/developers/<package>` (overview from the README), `/developers/<package>/<export>` (one export; class members are anchors on the class page).
- Hosting: the same Cloudflare Pages deploy as the player. The developer pages are not precached by the player's service worker (the player installs and runs offline without them), and they load without starting the player engine.
- Search: built at build time from the JSON model (package, export name, kind, first sentence), searched in the browser; no server.

## 4. Look

The site uses Seikou's own palette and typeface (Instrument Sans; the night, ice, mist and laser tokens in `src/ui/styles.css`), so it reads as part of Seikou rather than a separate product. Code is the main content of this site, so code blocks, signatures and type links get the most care. The visual design is done with the frontend-design skill when the site is built: the implementation plan's first UI task loads that skill and produces the design plan (tokens, type scale, layout, one memorable element) before any page is written, and the reviewer of that task checks the result against the skill's guidance. Quality floor: readable at phone width, keyboard navigable with visible focus, reduced motion respected, light and dark following the player's theme switch.

## 5. Order of work

Queued after the encoder project, as one effort with the packages documentation pass:
1. Site scaffolding: the TypeDoc model, the Vite plugin, the routes, search, the example runner and the "every export has an example" check (temporarily in warn mode).
2. The visual design (frontend-design skill) and the page templates.
3. The documentation pass, package by package: README overviews, a doc comment on every export, field meanings and specification citations in parsers, comments that give reasons instead of pointing at planning records, a plain sentence beside each libbluray cross-reference, the old "bluray-web" name fixed in headers, and an example per export.
4. The example check switches to failing the build.

Scope (from the conversation): by the time this work starts, all seven packages exist with their final layout (the packages plan is complete). The documentation pass covers all seven, package by package, and builds on the one-paragraph READMEs the packages plan writes. Step 4 (the check fails the build) comes only after every package is documented.

## 6. Left to the builder

The page templates' structure within section 4, the exact TypeDoc options, how class members and overloads are laid out, the search ranking, the example runner's harness, and how fixtures are made available to examples.
