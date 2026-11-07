# Packages: Design Spec

Date: 2026-11-07
Status: Draft; plan `docs/superpowers/plans/2026-11-07-packages.md`.
Why: the encoding app (`~/encoding-tools`, design `docs/superpowers/specs/2026-11-07-subtitle-helper-design.md` there) embeds Seikou's player engine, fansub pipeline and title matcher. Those have to exist as packages it can import. This spec fixes the package boundaries; Seikou's behaviour does not change.

## 1. Goal

Cut the repo into npm workspace packages under `packages/`, each importable by name from another repository, with Seikou's app, server and rendezvous importing them the same way. Every test, golden-trace harness, build and deploy that is green today is green afterwards, and `dist/` serves the same app.

Non-goals: publishing to a registry (the encoding app links the packages with `file:` through its `vendor/seikou` symlink until the delivery milestone); changing any package's behaviour beyond the two seams below; moving BD-J out of the app.

Anti-goals: a package that reaches outside its directory with `../../src/...`; a package whose tests or assets stay behind in the app; a "shared" package that becomes a dumping ground.

## 2. Packages

Packages ship TypeScript source, no build step: every consumer (Vite, Vitest, tsc with `moduleResolution: bundler`, esbuild, tsx) reads `.ts` through `package.json` `exports`. Each package has `name`, `version 0.1.0`, `type: module`, `license: LGPL-2.1-or-later`, `exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }` plus an exact entry per asset (fonts, wasm), its own `LICENSE` (LGPL-2.1 text) and `NOTICE` (the ported files it holds, split out of `src/engine/NOTICE`), and its tests beside its sources.

| Package | Holds (today's paths) | Depends on |
|---|---|---|
| `@seikou/bdmv` | `src/engine/bdmv/*`, `src/engine/demux/*`, `src/engine/disc/udf.ts`, `src/engine/disc/byte-source.ts`, `src/engine/util/byte-reader.ts`, `src/engine/decode/{nal,h264,hevc}.ts` (pure bitstream parsers the server also uses) | nothing |
| `@seikou/nas` | `src/engine/disc/{nas-api,disc-key,content-hash,title-text,place-rules,pairing-code,cors-policy,rtc-wire}.ts`: the types and small pure helpers the server, the rendezvous Worker and the UI share | nothing |
| `@seikou/pg` | `src/engine/graphics/{pg-decoder,pg-renderer,segments,composition,overlay-plane,rle,palette}.ts`, `tests/helpers/pg-builders.ts` | bdmv (byte reader) |
| `@seikou/ass` | `src/engine/ass/*` including `default-font.ttf` and `LICENSE-DejaVu.txt` | nothing |
| `@seikou/engine` | the rest of `src/engine` except `bdj/`: disc (transports, open-disc, disc-spec, caches, profile, settings, paths, file-source, main-title), decode, audio, playback, nav, hdmv, graphics (IG, graphics-controller), render, shaders, subs, clock, util, memory-profile, protocol, player, worker; plus `src/player/*` (the controller), `src/ui/entry-walk.ts`, and `src/wasm/audio/` (the audio decoder wasm with its build script) | bdmv, nas, pg, ass |
| `@seikou/titles` | `server/src/titles/*` except `evidence.ts`, `folder-cover.ts`, `service.ts` (they bind to the NAS library, manifest and ISO reader); plus `server/src/atomic-json.ts` | nas |
| `@seikou/fansubs` | `server/src/fansubs/{seadex,tosho,tracks,fetch-cache,archive,episode-files,choose,dialogue,disc-audio,speech,align,retime,semaphore,pick-store}.ts` and their tests and `__fixtures__` | titles, bdmv, nas, ass (parse), `7z-wasm` |

Stays in the app and server: `src/engine/bdj/*` and `src/bdj-classlib/*` (BD-J), `src/wasm/freetype/`, `src/ui/*`, `server/src/{main,library,manifest,iso,levels,routes,...}`, `server/src/fansubs/{service,state,picks,units,disc-lookup,fixture-sources}.ts`, `server/src/titles/{evidence,folder-cover,service}.ts`, `rendezvous/`, `tools/`, `tests/`.

## 3. The two seams

**BD-J becomes an optional provider of the engine.** `@seikou/engine` declares `BdjProvider`: the constructors and functions `player.ts`, `worker.ts` and `render/compositor.ts` take from `bdj/` today (background stills, the BD-J host and session, the early worker, graphics plane and status block, input helpers, the register word count, the unsupported-message text, `bdjMissing`), typed against interfaces the engine owns (the shapes bdj implements: `BdjSessionLike`, `GraphicsPlaneReader`, `StatusBlockWriter`, `ShownStill`, the `FromBdj` message union, `JvmMemoryStats`, `ClassLibrarySource`, `BdjMemoryBudgets`, `BdjFailureCode`, `WorkerLike`). `PlayerDeps.bdj?: BdjProvider` replaces the static imports; `PLANE_WIDTH`/`PLANE_HEIGHT` move to the engine. Seikou's app assembles the provider from `src/engine/bdj` and passes it from its own worker entry; the package's worker entry passes none. Without a provider, a BD-J disc or title opens to the playlist picker with the existing notice path, the missing requirement named `BD-J runtime`. BD-J code keeps importing engine internals through `@seikou/engine/<path>`.

**PG rendering stops reading registers.** `PgRendererDeps.regs: RegisterFile` becomes `displayFlag(): boolean`; `nav/subtitles.ts` passes `() => (regs.psrRead(PSR.PG_STREAM) >>> 31) === 1`. Nothing else in `@seikou/pg` touches hdmv or nav.

Two type-only edges are reversed so `@seikou/ass` stands alone: `Rect`, `TextRendererLike` and `TextRenderOptions` are declared in `@seikou/ass` (`host-types.ts`) and the engine's compositor and text renderer import them from there; `AssRendererLimits` names its four cache-size fields itself instead of picking them from `MemoryProfile`.

The worker entry is split so both hosts can start the engine: `@seikou/engine/worker-main` exports `startEngineWorker(options)` (the body of today's `worker.ts`, with the BD-J provider and the asset URLs as options); the package's `worker.ts` calls it with no provider, and exports `createEngineWorker(name)`; Seikou's `src/engine-worker.ts` calls it with the provider and the class-library jar URLs. `createController` takes the worker factory and the chosen memory profile as options instead of reaching into `src/ui`.

The fansub line-up stops spawning ffmpeg itself: `episodeAudio` and `align` take an `AudioDecoder` function (bytes of one clip's audio PES in, 16 kHz mono `Int16Array` with its first PTS out); `server/src/fansubs/ffmpeg-decoder.ts` keeps today's spawn and semaphore and is what Seikou's server passes. `LevelDiscSource` is replaced in the package by `FansubDiscSource` (`readFile`, `clip`), which the server's level disc sources already satisfy.

## 4. Build, tests, CI

- Root `package.json` gains `workspaces: ["packages/*"]`; dependencies a package needs (`7z-wasm`) are declared in that package and hoisted by npm.
- `tsconfig.app.json` includes `packages/*/src`; the server and rendezvous projects keep import-driven compilation (they compile what they import, as today).
- Vitest's `unit` project includes `packages/**/*.test.ts`; the `local` project is unchanged.
- `scripts/ci-changes.sh` path groups cover `packages/`; `wasm.yml`, `bdj-trace.yml` and the `tools/bdj-trace` scripts follow the moved audio wasm and default font.
- `server/build.mjs` is unchanged (esbuild follows `exports`); the Docker image gains nothing.
- A consumer outside the repo is proven by `scripts/package-smoke.sh`: a temporary project with `file:` dependencies on the packages that parses `fixtures/synthetic/disc1` through `@seikou/bdmv` and loads `@seikou/ass`'s parser with tsx.

## 5. Order of extraction

bdmv, nas, pg, ass first (leaves of the graph, small), then the BD-J seam in place, then engine (the big move), then titles, then fansubs, then documentation and the smoke test. Each step leaves typecheck, unit tests, the Vite build and the server build green.

## 6. Left to the builder

Internal file layout inside each package, barrel contents, whether `tests/helpers` keeps thin re-exports for helpers that moved (it does for `pg-builders`; others move with their only users), the wording of the `BD-J runtime` notice, and the exact `BdjProvider` member list, which the plan pins from today's imports.
