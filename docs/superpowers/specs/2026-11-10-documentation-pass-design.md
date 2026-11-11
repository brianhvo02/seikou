# Documentation pass

Status: design, 2026-11-10.

## 1. Why

Seikou's code is meant to be read by two kinds of people who were not there while it was built:

- **Readers learning the format.** Someone who wants to understand Blu-ray (BDMV, M2TS, HDMV, BD-J), PGS or ASS, or libbluray and libass, by reading Seikou's ports.
- **Integrators.** Someone who wants Seikou's player, or one of its packages, inside their own player or tool. (A Jellyfin plugin is a future example; it is not part of this pass.)

Today the code assumes the reader knows the history. Measured on 2026-11-10 with the encoder's doc checker (`encoder/scripts/doc-check.ts`):

| Area | Exports documented | Undocumented exports | Comments citing private history |
| --- | --- | --- | --- |
| `packages/bdmv` | 45% | 54 | 1 |
| `packages/pg` | 68% | 11 | 0 |
| `packages/ass` | 56% | 68 | 0 |
| `packages/engine` | 58% | 172 | 26 |
| `packages/nas` | 82% | 19 | 4 |
| `packages/titles` | 80% | 21 | 59 |
| `packages/fansubs` | 71% | 21 | 2 |
| `packages/matroska` | 100% | 0 | 0 |
| `src/` (the app) | 71% | 267 | 116 |
| `server/src` | 75% | 94 | 56 |
| `rendezvous/src` | 71% | 21 | 2 |
| `encoder/` | 100% | 0 | 0 |

In addition, 79 files under `packages/` name the old project ("Ported to TypeScript and modified for bluray-web, 2026", "Original code for bluray-web: …"). Parser fields often carry only libbluray's C name (`pi->angle_count`) or nothing (`connectionCondition`, `stcId`, `uoMask`, `stillMode` in `mpls-parser.ts`), and some comments describe a milestone's state ("M1 plays main-path streams only"). Every package has a README (30 to 90 lines), but only the engine's shows usage, and nothing walks an integrator through embedding the player end to end.

Success: a reader can open any file and understand what each export is for and what each format field means without reading the specs or the git history; an integrator can embed the player from one guide; and CI keeps it that way.

## 2. Scope

The whole repository: the eight packages, the app (`src/`), the NAS server (`server/src`), the rendezvous Worker (`rendezvous/src`). The encoder already meets the standard and only joins the repo-wide check.

Out of scope:
- `src/bdj-classlib/` (generated Java class library) and the committed WASM modules' C sources beyond their header lines.
- Specs, plans and `docs/known-issues.md`: they are the decision record and may cite rulings. `CLAUDE.md` likewise.
- Test files (`*.test.ts`, `tests/`, `tests/e2e/`): no doc-comment requirement and no history-comment rule. *(Builder's call whether a later pass covers them.)*
- Behaviour changes. This pass changes comments, READMEs and docs, the checker and CI wiring, and, as the one source change, adds exports to the packages' entry points (`index.ts`) where the guide needs something that is only reachable by an internal path today, such as `walkEntries` and `RemoteSource` (the owner's decision, 2026-11-10), so integrators never import internal file paths. Adding an export changes no behaviour. If documenting something reveals a bug, it goes into `docs/known-issues.md` or a separate fix, not this pass.
- The developer site (`docs/superpowers/specs/2026-11-07-developer-site-design.md`) stays queued after this pass; it will render the guide written here rather than a second copy.

## 3. The standard

The encoder's documentation standard (`encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md`, "Documentation standard") applies to the whole repository, with these specifics:

1. **Every export has a doc comment.** Every exported function, class, interface, type, enum and constant says what it is for and anything a caller must know: units (45 kHz, 90 kHz, µs, bytes), ownership (who closes, who transfers), failure behaviour (throws what, returns null when), threading context (main thread, engine worker, BD-J worker, AudioWorklet). Exported interface fields carry one when the name alone does not say it. Class methods and public fields follow the same rule where the meaning is not obvious from the name.
2. **Format fields say what they mean on the disc.** In code that reads or writes a format or protocol (BDMV files, M2TS/TS/PES, H.264/HEVC parameter sets, PG and IG segments, HDMV commands and registers, ASS, Matroska, UDF, Opus, the NAS wire contract, WebRTC framing), each field or step says in a plain sentence what it means, beside libbluray's (or libass's, libudfread's, FFmpeg's) C name where the code is ported, so a reader can find the original.
3. **Citations a reader can follow.** The BD-ROM specification is licensed and not public, so Blu-ray fields cite the upstream source they were ported from (file and function or struct, e.g. "libbluray `mpls_parse.c` `_parse_playitem`"), and a BD-ROM part or section only where it is known for certain. Never invent a section number. Public specifications are cited by section: ISO/IEC 13818-1 (TS, PES, PSI), ITU-T H.264 and H.265, ECMA-167 and UDF 2.50, RFC 9559 (Matroska), RFC 7845 (Ogg Opus), W3C WebCodecs. *(My call: an uncheckable citation is worse than none.)*
4. **Reasons, not references.** Comments never point at private planning history: ruling numbers (R12, T7h), task numbers, milestone labels (M1, 5e) used as a pointer, or section numbers of internal specs. Each such comment is rewritten to state the reason in its own words. Where the decision record is worth reading, the comment may also name the spec file (`docs/superpowers/specs/…md`), but the reason is always inline. A comment that only described a past state ("M1 plays main-path streams only") is rewritten to describe the current behaviour.
5. **Plain sentences beside upstream tags.** A comment that consists only of an upstream name (`/** pi->angle_count */`, "Ported from libbluray _parse_subpath (MPLS_SUB)") gains a plain sentence saying what the thing is.
6. **The name.** "bluray-web" in comments and headers becomes "Seikou" ("Ported to TypeScript and modified for Seikou, 2026", "Original code for Seikou: …"). The identifiers CLAUDE.md keeps on purpose stay: IndexedDB database and storage keys (`bluray-web`, `bluray-web:…`), the image `ghcr.io/brianhvo02/bluray-server` and its container and volume, the Worker `bluray-rendezvous`, the `/bluray` route, `~/.cache/bluray-web`, the harness Docker image names, and spec file names such as `2026-10-12-bluray-web-player-design.md`. The copyright holder is renamed too (the owner's decision, 2026-11-10: the project was renamed and the owner is its sole contributor): `Copyright (C) 2026  bluray-web contributors` becomes `Copyright (C) 2026  Seikou contributors` in every file, and the NOTICE files (`packages/*/NOTICE`, `src/bdj/NOTICE` and any other) say "modified for Seikou". `scripts/licence-check.sh` (`own_holder`) then accepts only "Seikou contributors". Licence headers otherwise stay as they are (SPDX identifier, upstream copyright lines, the "Ported from" line).
7. **Voice.** The existing docs' voice: plain declarative sentences, no dashes as punctuation, no bold labels in comments, no marketing words. A comment says what is true now, not what changed.

## 4. READMEs

- **Package READMEs** (`packages/*/README.md`) keep their shape (what it is, modules, what a consumer must provide, usage, documentation) and each gains a short usage example of its main entry points where it has none. The "Documentation" section links `docs/integrating.md` and keeps its upstream links. *(Builder's call on length; keep each one page.)*
- **Area READMEs** for the larger areas without one, concepts first, then the API, then where to look in the code: `src/ui/`, `src/ui/nas/`, `src/bdj/`, `server/src/` (and its `levels/`, `titles/`, `rtc/`, `encodes/`, `fansubs/` when the builder finds the area README too long to cover them), `rendezvous/`. The existing `src/README.md` is checked against this and extended. *(My call on the list; the builder may merge or split areas.)*

## 5. The integration guide

A new `docs/integrating.md` for someone embedding Seikou in their own page or tool. It covers, in this order:

1. What the packages are and which ones an integrator needs for what (a player, only parsing, only subtitles, a server).
2. Hosting: cross-origin isolation (COOP/COEP) and why (`SharedArrayBuffer`), the Vite requirement (`?url`, `?worker&url`, `vite/client` types), installing the unpublished packages as `file:` dependencies.
3. A minimal player: start the engine worker (`createEngineWorker`), create the controller (`createController`, the memory profile), attach a canvas, attach audio output, open a local folder (`walkEntries`), read the snapshot with `subscribe`/`getSnapshot`, send commands (play, pause, seek, tracks), close.
4. Opening discs from elsewhere: a server that speaks the disc API (`RemoteSource`, `HttpTransport`). ISOs: Seikou plays an ISO only through a server, which reads it with `readUdf` (`server/src/iso.ts`) and serves its files through the disc API; the browser cannot open a local ISO today (on the roadmap). The guide says so and does not show a browser ISO path; `readUdf` appears under item 8 as a parser. *(My call.)*
5. Subtitles: PG from the disc, adding SRT/ASS files and fonts.
6. BD-J: what an integrator gets without a provider (the playlist picker and the `bdj` notice), what a `BdjProvider` is, and, as a supported route (the owner's decision, 2026-11-10), how to use Seikou's own: which files to take (`src/bdj/`, `src/bdj-classlib/`, the FreeType WASM in `src/wasm/freetype/`, and whatever they import), how to write the engine worker entry that passes the provider (as `src/engine-worker.ts` does with `startEngineWorker`), and how the class library and FreeType assets are served. The builder checks these steps against the code; where taking the files needs more than copying (an import of app code, a build step), the guide says so plainly, and a change that would make it easier is noted in `docs/roadmap.md`, not made in this pass.
7. Licensing in one place: which licence each piece carries (LGPL-3.0-or-later for Seikou's code, LGPL-2.1-or-later for ported files, FFmpeg's and FreeType's terms for the WASM modules, GPLv2 with the Classpath Exception plus LGPL libbluray jars and the Apache-2.0, SAX and ICU parts for the class library), pointing at each `LICENSE` and `NOTICE`. It states the licences only and gives no interpretation of what combining them means for an integrator's code. *(My call.)*
8. Using the parsers alone (Node or browser): `@seikou/bdmv` on a folder, `@seikou/matroska` with a `RangeReader`.

Its one complete minimal-player example lives as a real file that `scripts/package-smoke.sh` typechecks and builds with Vite in its temporary project, and the guide shows that file's code, so the guide cannot drift from the packages. *(My call: the smoke script builds but does not run a browser; running the example belongs to the developer site's Playwright examples.)* The guide's prose goes through the humanizer review (§7). It is linked from the root README and every package README. It is not added to the in-app help (`HELP_PAGES`), which is for viewers.

## 6. Keeping it

- `encoder/scripts/doc-check.ts` moves to `scripts/doc-check.ts` (the encoder's test imports it from there) and gains the "bluray-web" check of §3.6, with the kept identifiers allowed.
- One Vitest test (`tests/docs/documentation.test.ts`, or the builder's equivalent) runs the three checks over every area in scope. An area joins the test once it is brought up to the standard, so the work can land area by area with CI green at every step; at the end every area is in it and no allowlist remains.
- The history pattern keeps the encoder's (`Task \d+`, `M\d+`, `milestone \d`, `ruling R?\d+`, `R\d{1,2}`, `spec §`), extended for the 5x milestone labels and the other ruling series used in Seikou (for example `T7h`), without matching real identifiers (`M2TS`, `R8` as a register name, PSR numbers). The builder tunes it against the real comments.
- CI's `changes` job (`scripts/ci-changes.sh`) runs the test whenever any source file in scope changes.

## 7. Humanizer review

The `humanizer:humanizer` skill reviews the longer prose only: each README written or changed, `docs/integrating.md`, and file-header paragraphs longer than about five lines. One-line doc comments are not run through it; the writers get §3.7 up front instead.

## 8. Order

1. The checker moves and the test exists, with no area enrolled yet except the encoder.
2. The packages, in dependency order: `bdmv`, `pg`, `ass`, `matroska` (check only), `nas`, `titles`, `fansubs`, `engine`. Each enrolls in the test when done.
3. `docs/integrating.md` with its smoke-checked example, and the package README updates.
4. `rendezvous/src`, `server/src`, then `src/` (the app). Each enrolls when done.
5. Area READMEs, then the humanizer pass over every README and the guide.

*(My call on the order: integrators touch the packages first, and the guide is written once their comments are right.)*

## 9. Left to the builder

- How to split the work into reviewable commits and subagent tasks.
- The wording of every comment, within §3.
- Whether a class method or interface field "says it by its name".
- The exact history pattern, against the real comments.
- Area README boundaries in §4.
