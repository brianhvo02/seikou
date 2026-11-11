# Milestone 5e: Every BD-J Disc in the Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every one of the 166 BD-J discs in the user's NAS library works as well as the two local discs (menu appears, arrows move it, Enter starts a playlist, as libbluray does), MPEG-2/VC-1 discs run their menus without a picture, BD-Live fails cleanly, and what discs save lasts between viewings, per person on the NAS.

**Architecture:** A committed, name-free library-check tool boots every BD-J disc (start-up files copied from the NAS into a private folder outside the repo) in our player and in libbluray with the same generic key script and compares settled planes and calls. Fixes follow its findings: a wider class library, a Player that plays an undecodable-video playlist without a picture, clean network failure, and a `BdjStore` behind the JVM's `/persistent` and `/buda` mounts (IndexedDB first, the NAS session's per-person store last).

**Tech Stack:** TypeScript (strict), the BD-J JVM in `src/engine/bdj`, `src/bdj-classlib` (Docker build), the libbluray harness `tools/bdj-trace` (Docker), Vitest (`fake-indexeddb` already a dev dependency), Playwright, SSH to the NAS (read-only).

**Spec:** `docs/superpowers/specs/2026-10-18-m5e-bdj-library-coverage-design.md`

## Global Constraints

- The repo is public: no real disc, series, folder or file names in any committed file, commit message, CI log or test name; made-up names only (BDJ_DISC_A, BDJ_DISC_B, HDMV_DISC_A may stay). Library results, the id→path map and copied disc files live only under `$BDJ_LIBRARY_DIR` (default `~/.cache/bluray-web/bdj-library`, outside the repo).
- The NAS is read-only for 5e: `ssh your-nas`, `ionice -c3 nice -n19` on every find/copy, never read `STREAM/*.m2ts` (stub streams), copies one at a time; never touch the `bluray-server` container or Caddy.
- `src/engine/disc/nas-api.ts`, `src/ui/nas/nas-client.ts`, `server/`, `rendezvous/`, `src/engine/disc/cors-policy.ts` belong to the NAS session: change only with its agreement.
- Artifacts only through their scripts (`npm run bdj-classlib:build`, `bdj-trace:golden`, `vm-trace:golden`, `wasm:build`), CI diffs them; goldens never edited by hand; a divergence from libbluray is a porting bug.
- Licensing per CLAUDE.md: OpenJDK-derived classes and intrinsics stay in `src/bdj-classlib/` (GPLv2+CE plus any third-party notice), libbluray-derived code in `src/engine` (NOTICE entry), no UI imports in `src/engine`.
- Storage scopes (agreed with the NAS session): `persistent/<orgId>` and `buda/<orgId>/<discId>` (orgId 8 lowercase hex, discId 32 lowercase hex, from the BDJO and `CERTIFICATE/id.bdmv`); whole-scope snapshots; quotas 16 MB per scope, 256 MB per person; over quota → the JVM sees an `IOException` (no space).
- Writes: debounced 2 s after the last file write, plus a flush on BD-J stop; `keepalive` bodies ≤ 64 KB.
- Notice for undecodable video (exact copy): "This disc's video can't be played here yet, so it will play without a picture."
- E2E ports 4183–4189 (`E2E_PORT`); 4191/4192 belong to the NAS stand-in; devices only after checking with the NAS session.
- 5e is not merged to main until Task 8 passes against the NAS session's live store.

## Review Focus

1. Two devices of one person save the same scope at once → one gets 412, re-reads, merges per file by mtime; no file is lost (Task 8).
2. A disc fills its quota mid-write → Java gets an `IOException`, the disc carries on, the stored scope stays the last complete snapshot (Task 5).
3. The page closes seconds after a save (pagehide on iOS) → the save is on disk next time (Task 5).
4. An undecodable-video disc plays several playlists in a row → the notice shows once per disc, not per playlist, and a new disc shows it again (Task 3).
5. A disc without `CERTIFICATE/id.bdmv`, or with an all-zero disc id → its scopes fall back exactly as libbluray's do, and two such discs don't share a BUDA scope by accident (Task 5).

---

### Task 1: The library check

**Files:**
- Create: `tools/bdj-library/README.md`, `tools/bdj-library/sync.ts` (find BD-J discs on the NAS, copy start-up files), `tools/bdj-library/check.ts` (run ours and libbluray per disc), `tools/bdj-library/classify.ts`, `tools/bdj-library/generic.keys`, `tools/bdj-library/check.test.ts`
- Modify: `package.json` (`bdj-library:sync`, `bdj-library:check`)

**Interfaces:**
- Produces: `npm run bdj-library:sync -- [--roots auto]` → `$BDJ_LIBRARY_DIR/discs/<id>/` (id = first 10 hex of sha1(NAS path); `map.tsv` id→path stays in `$BDJ_LIBRARY_DIR`); `npm run bdj-library:check -- [--only <id>…] [--ours-only]` → `$BDJ_LIBRARY_DIR/results/<id>.json` and `$BDJ_LIBRARY_DIR/summary.md`; `type DiscVerdict = 'works' | 'libbluray-fails-too' | 'missing-class' | 'unsupported-video' | 'stall' | 'diverges' | 'error'`; `classify(ours: RunRecord, lib: RunRecord | null): { verdict: DiscVerdict; detail: string }`.
- Generic script (`generic.keys`): `wait still 1500`, `key right`, `wait still 1000`, `key down`, `wait still 1000`, `key ok`, `wait playlist any` (add `any` to the harness's and `tests/bdj/key-script.ts`'s `wait playlist` if missing).

- [ ] **Step 1: Failing tests** in `check.test.ts`: `classify` returns `works` when ours reached a visible plane, the arrow steps changed the settled hash, `ok` led to a playlist or title change, and libbluray's settled hashes and calls equal ours; `libbluray-fails-too` when libbluray also never reaches step 1; `missing-class` with the class name when the Java log has `NoClassDefFoundError`; `unsupported-video` when `selectPlaylist` returned 0 on an MPEG-2/VC-1 playlist; `diverges` with the first differing step otherwise; ids never contain path characters.
- [ ] **Step 2: Run** `npx vitest run tools/bdj-library` → FAIL.
- [ ] **Step 3: Implement** from the scan's scripts (`recon5e/scripts` in the 5e session's scratchpad: SSH find with `ionice`, tar over SSH for paths with spaces/non-ASCII, stub `.m2ts`, one child process per disc with a 150 s kill, 6 in parallel, libbluray via `tools/bdj-trace/run.sh --keys`). Re-runs are incremental (skip discs whose copy is unchanged; `--only` re-runs a subset).
- [ ] **Step 4: Run** tests → PASS; then `npm run bdj-library:sync && npm run bdj-library:check` on the real library; record the baseline verdict counts (no names) in the SDD ledger. Expected near the scan: works ≈ 69, missing-class ≈ 49, unsupported-video ≈ 44, libbluray-fails-too ≈ 4.
- [ ] **Step 5: Commit** `test(bdj): the library check`.

### Task 2: The class library covers the library

**Files:**
- Modify: `tools/bdj-classlib/collect.sh` (accept `$BDJ_LIBRARY_DIR/discs/*` and run `tools/bdj-library/generic.keys` on each), `src/bdj-classlib/classes.txt`, `src/bdj-classlib/rt-bdj.jar` (built), `src/bdj-classlib/NOTICE` (+ any third-party notice), natives/intrinsics a new class needs (`src/engine/bdj/jvm/natives/*.ts` or `src/bdj-classlib/intrinsics/*.ts`), `tests/bdj/conformance/*.java` (+ `.out` via the build)
- Test: `tests/bdj/conformance.test.ts`

**Interfaces:**
- Consumes: Task 1's `$BDJ_LIBRARY_DIR/discs/*` and `bdj-library:check --only`.

- [ ] **Step 1: Failing conformance programs** for the scan's top classes, run in our JVM and HotSpot (`pack.sh run_twice`): `FileWriter` writes and reads back a file under `/persistent`; a `jar:` URL's `JarURLConnection` reads an entry; `TreeSet` ordering and `subSet`; `java.rmi.registry.Registry` interface load; a static float field read through reflection (`UnsafeStaticFloatFieldAccessorImpl`); `DateFormat.getDateInstance()` formatting a fixed date; `IndexColorModel` pixel lookup; `Polygon.contains`. Each prints a deterministic line equal to HotSpot's.
- [ ] **Step 2: Run** `npx vitest run tests/bdj/conformance.test.ts` → FAIL (`NoClassDefFoundError`).
- [ ] **Step 3: Collect:** `npm run bdj-classlib:collect -- $BDJ_LIBRARY_DIR/discs/*` (with the generic script), then `npm run bdj-classlib:build`; add a whole package only where a disc's use is open-ended (record which and why in NOTICE comments); implement any native/intrinsic a new class needs; repeat `bdj-library:check --only <missing-class discs>` until none reports `missing-class` except where libbluray also fails.
- [ ] **Step 4: Run** conformance → PASS; `npm test`, `bdj-trace:golden` and `vm-trace:golden` → no diff; report the jar's size before/after (precached for every visitor) in the commit message.
- [ ] **Step 5: Commit** `feat(bdj): the class library covers the library`.

### Task 3: Playlists play without a picture when the video can't be decoded

**Files:**
- Modify: `src/engine/player.ts` (`chooseStreams` path around the `isSupportedVideoCoding` check; `selectPlaylist` for BD-J; the HDMV navigator path), `src/engine/protocol.ts` (`unsupported` event `kind: 'video'`), `src/player/player-controller.ts` (once-per-disc notice), `scripts/make-fixture-disc.ts` or a new `scripts/make-mpeg2-disc.ts`, `package.json` (`fixture:synthetic` adds `disc-mpeg2`), `fixtures/synthetic/disc-mpeg2/**` (generated)
- Test: `src/engine/player.test.ts`, `src/engine/player-bdj.test.ts`, `src/player/player-controller.test.ts`, `tests/e2e/unsupported-video.spec.ts`

**Interfaces:**
- Produces: `EngineEvent` `{ type: 'unsupported'; kind: 'video'; codec: string; message: string }` with the Global Constraints copy; the playlist reaches `state: 'playing'` with the master clock on audio (or wall clock without audio), PG/IG/BD-J planes composited over black.

- [ ] **Step 1: Failing tests:** an MPEG-2 (`codingType 0x02`) and a VC-1 (`0xEA`) playlist → `state: 'playing'`, clock advances, no `VideoDecoder` created, one `unsupported`/`video` event; a second playlist of the same disc emits no second notice; opening another disc emits it again (Review Focus 4); BD-J `selectPlaylistN` on such a playlist returns 1 and Java gets its playlist events (`player-bdj.test.ts`); HDMV disc-menu over MPEG-2 shows its IG menu (`player.test.ts`); E2E opens `disc-mpeg2` (made with `ffmpeg -c:v mpeg2video`) and sees the notice and a running clock.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (mirror of the existing audio-unsupported path; keep `UnsupportedCodecError` for streams with nothing playable at all).
- [ ] **Step 4: Run** → PASS; `vm-trace:golden` no diff; HDMV E2E (`menus.spec.ts`) unchanged; `bdj-library:check --only <unsupported-video discs>` → each `works` or `libbluray-fails-too`.
- [ ] **Step 5: Commit** `feat: undecodable video plays without a picture, with a notice`.

### Task 4: BD-Live fails cleanly

**Files:**
- Modify: `src/engine/bdj/jvm/natives/net.ts` (connect/lookup failures as libbluray offline), `tests/bdj/conformance/Net.java` (+ `.out`)
- Test: `tests/bdj/conformance.test.ts`

- [ ] **Step 1: Failing conformance:** `new URL("http://bdlive.example/x").openConnection().getInputStream()` throws an `IOException` subclass whose class name equals HotSpot's in the offline harness (`UnknownHostException` for a name, `ConnectException`/`NoRouteToHostException` for an address), and the program continues to its next line.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `net.ts` (no real network). **Step 4: Run** → PASS; `bdj-library:check --only <BD-Live discs>` (Java log shows an http attempt) → no new failures. **Step 5: Commit** `fix(bdj): BD-Live connections fail as they do offline`.

### Task 5: `BdjStore` and the browser backend

**Files:**
- Create: `src/engine/bdj/store/bdj-store.ts`, `src/engine/bdj/store/idb-store.ts`, `src/engine/bdj/store/scopes.ts`, tests beside them
- Modify: `src/engine/bdj/jvm/vfs.ts` (`persistent`/`buda` mounts backed by a loaded snapshot; write hook), `src/engine/bdj/runtime.ts` / `bdj-worker.ts` (load scopes before the xlet starts; debounced flush; flush on stop), `src/engine/bdj/worker-protocol.ts`, `src/engine/protocol.ts` (store events if any cross the boundary), `src/engine/NOTICE`

**Interfaces:**
- Produces: `interface BdjStore { load(scope: string): Promise<Snapshot>; save(scope: string, snapshot: Snapshot, etag: string | null): Promise<{ etag: string } | { conflict: Snapshot & { etag: string } }> }`; `interface Snapshot { readonly files: ReadonlyArray<{ path: string; mtime: number; bytes: Uint8Array }> }`; `scopesFor(bdjo, bdid): { persistent: string; buda: string }` (`persistent/<orgId>`, `buda/<orgId>/<discId>`, libbluray's fallbacks for a missing/zero id); `class IdbBdjStore implements BdjStore` (database `bdj-store`, keyed by `<source>|<scope>` where source is `nas:<nasDiscId>` or `local`); `SCOPE_QUOTA_BYTES = 16 * 1024 * 1024`.

- [ ] **Step 1: Failing tests:** `scopesFor` with BDJ_DISC_B-like ids and with a missing/all-zero `id.bdmv` (Review Focus 5, values as libbluray's `bdj.c`/`BDJLoader` derive them); `IdbBdjStore` (fake-indexeddb) round-trips a snapshot and keeps sources apart; the VFS mounts a loaded snapshot so Java's `File.exists`/`FileInputStream` see it; a write marks the scope dirty and a save follows 2 s after the last write (fake timers) and on stop; a write past 16 MB in a scope throws `IOException` in Java, and the stored snapshot stays the previous complete one (Review Focus 2); the JVM boots only after both scopes are loaded.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; goldens no diff (the store is empty on the golden runs); `bdj-library:check` no regression.
- [ ] **Step 5: Commit** `feat(bdj): what discs save lasts, in the browser`.

### Task 6: Saved data across sessions, end to end

**Files:**
- Create: `tests/bdj/xlets/src/bdjweb/store/StoreXlet.java` (reads a counter from `/persistent/<org>/<app>/count`, draws it, writes it +1), `scripts/make-bdj-store-disc.ts`, `fixtures/synthetic/disc-bdj-store/**` (generated), `tests/e2e/bdj-store.spec.ts`
- Modify: `tools/bdj-classlib/pack.sh` (xlet jar), `package.json` (`fixture:synthetic`), `tools/bdj-trace/golden.sh` (golden for the new disc)

- [ ] **Step 1: Failing E2E:** open `disc-bdj-store` → the plane shows 0; close and reopen → 1; reload the page → 2; a page closed 0.5 s after the write (pagehide) → the next open shows the write (Review Focus 3); a different source (`local` vs `nas:…`) keeps its own count. libbluray golden for one open matches ours.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** what Task 5 left (e.g. pagehide flush through the engine/BD-J worker, ≤ 64 KB `keepalive`, earlier plain flush otherwise). **Step 4: Run** on chromium, firefox, webkit, mobile-chromium → PASS. **Step 5: Commit** `test(bdj): saved data lasts across sessions`.

### Task 7: Library pass

**Files:** whatever the remaining verdicts point at (each fix with its own failing test first; no new real names).

- [ ] **Step 1:** `npm run bdj-library:check` on all discs; list every disc not `works`/`libbluray-fails-too` with its detail (ids only).
- [ ] **Step 2:** For each distinct cause (most discs first): reproduce with `--only`, write a failing test (conformance program, unit test, or a synthetic disc), fix the port, re-run its discs. Causes that need architecture changes come back to the controller.
- [ ] **Step 3:** Full check again → every disc `works` or `libbluray-fails-too`; goldens no diff; `npm test`, E2E all projects green; `LOCAL_DISCS=1` local specs green; desktop BDJ_DISC_A warm ≤ 5,000 ms.
- [ ] **Step 4: Commit** fixes as `fix(bdj): …` per cause; record the final counts (no names) in the ledger.

### Task 8: The NAS backend (waits for the NAS session's step-3 API)

**Files:**
- Create: `src/engine/bdj/store/nas-store.ts` (+ test)
- Modify: `src/engine/bdj/store/bdj-store.ts` (backend choice by disc source), `src/engine/bdj/bdj-worker.ts` (token relay as for RemoteSource), `tests/e2e/bdj-store.spec.ts` (NAS stand-in, with the NAS session's agreement on `tests/e2e/nas-server.ts`)

**Interfaces:**
- Consumes: the NAS session's API section (endpoints, body format, auth) — copy it into this task's brief when it arrives; `BdjStore` from Task 5.
- Produces: `class NasBdjStore implements BdjStore`; `migrateBrowserScopes(idb, nas, nasDiscId)` (first NAS boot of a scope merges the browser copy per file by mtime, marks it migrated, deletes it only after the NAS write succeeds).

- [ ] **Step 1: Failing tests:** load/save with etags; 412 → re-read, merge per file by newer mtime, retry, no file lost (Review Focus 1); 507 → `IOException` in Java; token refresh mid-save; migration moves a browser scope once and keeps it until the NAS confirms; local-folder discs stay on `IdbBdjStore`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; E2E against the NAS stand-in; then on the live NAS with the user: two people, two devices each — one person's iPad and iPhone share the count on `disc-bdj-store` and a real disc that saves; the other person's devices don't see it.
- [ ] **Step 5: Commit** `feat(bdj): saved data per person on the NAS`.

### Task 9: Devices, docs and final verification

- [ ] **Step 1:** Device check with the user (after checking with the NAS session): a few library discs from each former failure category on the iPhone over the NAS (menus, arrows, Enter, the MPEG-2/VC-1 notice, saved data shared with the iPad).
- [ ] **Step 2:** Docs: CLAUDE.md (5e done; `tools/bdj-library`; `BdjStore`), `docs/known-issues.md` (BD-J section: library verdict counts, libbluray-fails-too discs by cause, no real names), the 5e spec's status line and §9 deviations, the NAS session told that the MPEG-2/VC-1 change has merged (step 4 may start on playback).
- [ ] **Step 3:** Verify: `npm run typecheck && npm test`, `npm run build`, E2E all four projects, `wasm:build` / `bdj-classlib:build` / `bdj-trace:golden` / `vm-trace:golden` / `ass-trace:golden` + diff, `LOCAL_DISCS=1` local specs, full `bdj-library:check`.
- [ ] **Step 4: Commit** `docs(bdj): milestone 5e`.
