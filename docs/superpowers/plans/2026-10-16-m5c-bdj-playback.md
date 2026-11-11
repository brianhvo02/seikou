# Milestone 5c: BD-J Titles Drive Playback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening a BD-J disc runs its Java code in a dedicated worker, that code drives real playback (intro, then menu-background loop on both local discs), and BDJ_DISC_A's first logo frame appears within about 5 s.

**Architecture:** The engine worker keeps owning playback and the `RegisterFile`, now backed by a `SharedArrayBuffer` the BD-J worker reads synchronously. A `BdjSession` on the engine side spawns the BD-J worker, routes Java's playback calls to a `PlayerBdjHost` (ported `bdpriv_*`) and feeds BD-J events (ported from `bluray.c`) back. The Java side's `WorkerBdjHost` answers reads locally and turns state-changing calls into round trips that park the Java thread on a `Suspend`. Start-up speed comes from JS intrinsics for libbluray's hot Java methods and interpreter fast paths; a JIT is a conditional second stage.

**Tech Stack:** TypeScript (strict), Web Workers, SharedArrayBuffer, Vitest, Playwright (Chrome), Docker (libbluray harness).

**Spec:** `docs/superpowers/specs/2026-10-16-m5c-bdj-playback-design.md`. Also read `docs/superpowers/specs/2026-10-15-m5b-bdj-jvm-core-design.md` §9 and `docs/known-issues.md` "BD-J (milestone 5b)". libbluray at `448f896` is in `.cache/libbluray/src/libbluray/` (run `scripts/fetch-libbluray.sh` if absent).

## Global Constraints

- Port function by function from libbluray `448f896`; every ported/derived file listed in `src/engine/NOTICE`; LGPL-2.1-or-later SPDX header on new `src/engine/` files.
- `src/engine/` must not import React, `src/ui/` or `src/player/`; new browser APIs go behind injectable deps (`PlayerDeps` pattern).
- TypeScript strict, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax`, readonly interface fields; few comments, explaining why.
- COOP/COEP stay intact; the three class-library jars are same-origin assets loaded with Vite `?url` + `fetch` (pattern of `audio.wasm` in `src/engine/worker.ts`).
- Build artifacts (`src/bdj-classlib/`, `tests/bdj/golden/`, `tests/vm-trace/golden/`, conformance outputs) change only through their scripts.
- UO rules under BD-J titles: libbluray's default `BLURAY_PLAYER_SETTING_UO_RESTRICTION_RELAXED`: only menu call and title search are checked; pause/play, seek, chapter skip never refused.
- Start-up bar: BDJ_DISC_A open → first presented frame of the first Java-selected playlist ≤ 5,000 ms in Chrome, production build, warm HTTP cache; cold open recorded.
- Fallback: boot failure, `BdjError`, JVM halt, or no `selectPlaylist` within 20,000 ms of `start` → BD-J worker terminated, picker shown, notice naming the failure.
- Register file layout shared with the BD-J worker: `Int32Array` of 128 PSRs then 4096 GPRs (4,224 words).
- HDMV playback, non-menu playlists, audio and subtitles unchanged, except the two named fixes: UHD/3D profile switch on every disc; scheduler throw-path continuation.
- The JVM's conformance suite and `tests/bdj/golden/disc-bdj.jsonl` keep matching byte for byte after every task.

## Review Focus

1. Closing a disc or opening another while the BD-J worker is busy: the worker is terminated and no late message from it touches the new disc's player state. (Task 7 test.)
2. Choosing a playlist from the picker during a BD-J title: BD-J stops, the playlist plays normally, Java makes no further playback calls. (Task 8 test.)
3. Pausing, seeking or skipping a chapter under a BD-J title is never refused, and Java receives RATE / SEEK. (Task 8 test.)
4. The JVM crashes or hangs after the first playlist started: playback continues, the user can still reach the picker, a notice explains; no black-screen lock. (Task 7 test.)
5. Java selects a new playlist while the previous one is still opening: the last selection wins and events carry the right playlist number. (Task 6 test.)

---

## File map

| File | Status | Task |
|---|---|---|
| `src/engine/bdj/jvm/threads.ts` | modify | 1 |
| `src/engine/hdmv/registers.ts`, `src/engine/bdj/shared-registers.ts` | modify / create | 2 |
| `src/engine/disc/open-disc.ts`, `src/engine/player.ts` (disc open), `src/engine/bdj/host.ts` | modify | 3 |
| `src/engine/bdj/events.ts` | create | 4 |
| `src/engine/bdj/worker-protocol.ts`, `src/engine/bdj/status-block.ts`, `src/engine/bdj/worker-host.ts`, `src/engine/bdj/jvm/natives/libbluray.ts`, `src/engine/bdj/host.ts` (`BdjHost` returns), `src/engine/bdj/disc-info.ts` | create / modify | 5 |
| `src/engine/bdj/player-host.ts`, `src/engine/player.ts` (BD-J port) | create / modify | 6 |
| `src/engine/bdj/bdj-worker.ts`, `src/engine/bdj/session.ts`, `src/engine/worker.ts`, `src/engine/player.ts` (`PlayerDeps`) | create / modify | 7 |
| `src/engine/player.ts`, `src/engine/protocol.ts`, `src/player/player-controller.ts` (`reduceEvent`), `src/ui/PlaylistPicker.tsx` | modify | 8 |
| `tools/bdj-trace/*`, `tests/bdj/replay-player.ts`, `tests/bdj/*`, `tests/local/bdj-boot.test.ts` | modify / create | 9 |
| `scripts/make-bdj-mixed-disc.ts`, `fixtures/synthetic/disc-bdj-mixed/**`, `tests/bdj/xlets/**`, goldens | create | 10 |
| `src/engine/bdj/jvm/natives/intrinsics/*.ts`, `src/engine/bdj/jvm/interpreter.ts`, `src/engine/bdj/session.ts` | create / modify | 11 |
| `tests/e2e/bdj.spec.ts`, `tests/e2e/local-discs.spec.ts` | create / modify | 12 |
| `src/engine/bdj/jvm/jit/*.ts` | create (conditional) | 13 |
| docs, `CLAUDE.md` | modify | 14 |

---

### Task 1: Scheduler throw path keeps its continuation

**Files:** Modify `src/engine/bdj/jvm/threads.ts` (`step()`, ~446-449). Test: `src/engine/bdj/jvm/threads.test.ts`.

**Interfaces:** no API change.

- [ ] **Step 1: Failing test** `step() runs a stored continuation when the resumed result throws`: a native reached through an `Invoke` chain whose continuation has an `onThrow` that records the exception and releases a monitor (use `withMonitor` from `natives/util.ts`); the inner call throws a Java exception after a contended monitor wait. Assert the `onThrow` ran once with that exception and the monitor's owner is null afterwards.
- [ ] **Step 2: Run** `npx vitest run src/engine/bdj/jvm/threads.test.ts -t "throws"` → FAIL (onThrow not run / monitor still owned).
- [ ] **Step 3: Fix** in `step()`: when `result()` throws a `JavaThrowable` and a continuation `k` is stored, `r = k(new ThrowResult(e.obj))`; otherwise keep `new ThrowResult(e.obj)`.
- [ ] **Step 4: Run** threads, interpreter, conformance and runtime tests → PASS.
- [ ] **Step 5: Commit** `fix(bdj): scheduler throw path runs the stored continuation`.

### Task 2: Shared register buffer

**Files:** Modify `src/engine/hdmv/registers.ts`. Create `src/engine/bdj/shared-registers.ts`. Tests: `registers.test.ts`, `shared-registers.test.ts`.

**Interfaces:**
- Produces: `RegisterFile` constructor option `new RegisterFile({ shared?: SharedArrayBuffer })`; when given, every PSR/GPR store (including `saveState`/`restoreState`, `psrInit*`, `resetBackupRegisters`) writes through to `Int32Array(shared)` at PSR `i` → index `i`, GPR `i` → index `128 + i`, using `Atomics.store`. `export const REGISTER_WORDS = 4224`. `createRegisterBuffer(): SharedArrayBuffer` (initialised from the current PSR defaults).
- Produces: `class SharedRegisterView { constructor(buffer: SharedArrayBuffer); psrRead(i: number): number; gprRead(i: number): number }` with the same out-of-range results as `RegisterFile` (`psrRead` → `0xffffffff`, `gprRead` → 0), reading with `Atomics.load` as unsigned.

- [ ] **Step 1: Failing tests:** a `RegisterFile` with `shared` mirrors `gprWrite(100, 42)`, `psrSettingWrite(20, 2)`, `psrWriteBits(102, 0x12, 0xff)`, `saveState`/`restoreState` round trip, into a `SharedRegisterView` over the same buffer; out-of-range reads match; values ≥ 2^31 read back unsigned; a `RegisterFile` without `shared` behaves exactly as before (existing tests unchanged).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run src/engine/hdmv src/engine/bdj/shared-registers.test.ts` and the vm-trace tests → PASS.
- [ ] **Step 5: Commit** `feat(bdj): register file shared with the BD-J worker`.

### Task 3: Disc ID and player profile on every disc

**Files:** Modify `src/engine/player.ts` (disc open: where `pgRegs`/`navRegs` are created), `src/engine/bdj/host.ts` (`RecordingHost` uses the shared helper). Possibly create `src/engine/disc/disc-profile.ts`. Tests: `player.test.ts`, `host.test.ts`.

**Interfaces:**
- Consumes: `readBdid(source)` (`open-disc.ts`), `initDiscProfile` (currently in host.ts — move it to `src/engine/disc/disc-profile.ts` as `applyDiscProfile(regs: RegisterFile, index: IndexBdmv): void`, ported from `_fill_disc_info`'s `psr_init_UHD`/`psr_init_3D` calls).
- Produces: the player's register files (`navRegs` and `pgRegs`) get `applyDiscProfile` at disc open; `Player` keeps the disc ID (`readBdid`) for BD-J (read only when `indexUsesBdj`, never failing the open — `readBdid` already returns null on any failure).

- [ ] **Step 1: Failing tests:** opening a synthetic disc whose index version is `0300` sets PSR31/PSR29 as `psrInitUhd(true)` does (assert the values `register.c` gives); a `0200` disc with the 3D content flag gets `psrInit3D`; an ordinary disc's PSRs are unchanged from today (snapshot of PSR29/31/30 before the change). `RecordingHost` tests still pass using the moved helper.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS (vm-trace goldens unchanged: synthetic discs are `0200` without 3D).
- [ ] **Step 5: Commit** `fix(player): libbluray's UHD/3D player profile on every disc`. Add a NOTICE line if the helper moves files.

### Task 4: BD-J events from playback

**Files:** Create `src/engine/bdj/events.ts`. Test: `events.test.ts`.

**Interfaces:**
- Consumes: `RegisterFile.onPsrEvent` (`PsrEvent { type: 'write'|'change'|..., psr, oldValue, newValue }`), `BdjEvent` constants (`runtime.ts`).
- Produces:

```ts
export interface BdjEventSink { (ev: number, param: number): void }
/** Ported from bluray.c _process_psr_write_event / _process_psr_change_event (BD-J part). */
export function bindBdjPsrEvents(regs: RegisterFile, sink: BdjEventSink): () => void;
/** The playback-side events bluray.c sends outside PSR callbacks. */
export interface BdjPlaybackEvents {
  endOfPlaylist(playlist: number): void;   // bd_read_ext: once per end
  markReached(mark: number): void;          // _playmark_reached, per mark index
  seeked(mediaTime45: number): void;        // _seek_internal: media time per bluray.c
  rate(rate: number): void;                 // bd_set_rate → BDJ_EVENT_RATE (rate as bluray.c passes: 0 pause, 90000 normal)
  uoMasked(uoIndex: number): void;          // _bdj_event(BDJ_EVENT_UO_MASKED, idx)
}
export function bdjPlaybackEvents(sink: BdjEventSink): BdjPlaybackEvents;
```

- [ ] **Step 1: Failing tests** (one per `bluray.c` case, citing its line in the test name): PSR3 write → ANGLE, PSR6 → PLAYLIST, PSR7 → PLAYITEM, PSR8 → PTS, PSR102 → PSR102 (write events); PSR5 change → CHAPTER, PSR1 change → AUDIO_STREAM, PSR2 change → SUBTITLE, PSR14 (secondary streams) change → SECONDARY_STREAM; a PSR write with an unchanged value raises write-events but not change-events, as `register.c` distinguishes; unbinding stops events; `endOfPlaylist`, `markReached`, `seeked`, `rate`, `uoMasked` emit the right `BdjEvent` codes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, NOTICE line (`bdj/events.ts from bluray.c (_process_psr_write_event, _process_psr_change_event, BD-J event sites)`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(bdj): BD-J events from register writes and playback`.

### Task 5: Worker protocol and the Java-side host

**Files:** Create `src/engine/bdj/worker-protocol.ts`, `status-block.ts`, `worker-host.ts`, `disc-info.ts`. Modify `src/engine/bdj/host.ts`, `src/engine/bdj/jvm/natives/libbluray.ts`. Tests: `worker-host.test.ts`, `status-block.test.ts`, existing `libbluray.test.ts`/`host.test.ts`.

**Interfaces:**
- Modify `BdjHost`: each method that may need the engine returns `T | Promise<T>` (`selectTitle`, `selectPlaylist`, `seek`, `selectAngle`, `selectRate`, `writeReg`, `soundEffect`, `setVirtualPackage`, `setUOMask`, `setKeyInterest`); `natives/libbluray.ts` turns a returned Promise into `new Suspend(promise)` (the promise resolves to a plain number/bigint/undefined — never an Invoke). `RecordingHost` keeps returning plain values.
- Move `getTitleInfos`/`getPlaylistInfo` builders out of `RecordingHost` into `disc-info.ts`: `titleInfos(disc: DiscModel): (TitleInfo|null)[]`, `playlistInfo(disc: DiscModel, clips: ReadonlyMap<string, Clpi>, playlist: number): PlaylistInfo | null` (unchanged behaviour; RecordingHost uses them).
- `status-block.ts`: `createStatusBlock(): SharedArrayBuffer`; `class StatusBlockWriter { setTime45(t: bigint): void; setUoMask(bits: bigint): void; setPlaylistOpen(open: boolean): void }`; `class StatusBlockReader { time45(): bigint; uoMask(): bigint; playlistOpen(): boolean }` (BigInt64Array + Int32Array views; `Atomics`).
- `worker-protocol.ts`:

```ts
export type ToBdj =
  | { readonly type: 'boot'; readonly registers: SharedArrayBuffer; readonly status: SharedArrayBuffer; readonly discFiles: readonly (readonly [string, Blob])[]; readonly discId: string | null; readonly classLibrary: ClassLibrarySource; readonly titles: readonly (TitleInfo|null)[]; readonly playerSettings?: unknown }
  | { readonly type: 'start'; readonly title: number }
  | { readonly type: 'event'; readonly ev: number; readonly param: number }
  | { readonly type: 'reply'; readonly id: number; readonly value: number | string }   // bigint sent as decimal string
  | { readonly type: 'stop' };
export type FromBdj =
  | { readonly type: 'booted'; readonly bootMs: number }
  | { readonly type: 'call'; readonly id: number; readonly name: BdjCallName; readonly args: readonly (number | string | boolean | null)[] }
  | { readonly type: 'log'; readonly line: string; readonly error: boolean }
  | { readonly type: 'failed'; readonly code: BdjErrorCode | 'halted' | 'timeout'; readonly message: string };
export type BdjCallName = 'selectTitle' | 'selectPlaylist' | 'seek' | 'selectAngle' | 'selectRate' | 'writeReg' | 'soundEffect' | 'setVirtualPackage' | 'setUOMask' | 'setKeyInterest' | 'getPlaylistInfo';
```

  (The disc's files cross as Blobs; the BD-J worker builds its own `FileSource`. `getPlaylistInfo` may be answered from a disc model the worker builds itself instead of a round trip — decide and note it.)
- `worker-host.ts`: `class WorkerBdjHost implements BdjHost { constructor(opts: { regs: SharedRegisterView; status: StatusBlockReader; call: (name: BdjCallName, args: readonly (number|string|boolean|null)[]) => Promise<number | string>; disc: DiscModel; clips: ReadonlyMap<string, Clpi>; log: (line: string, error: boolean) => void }) }`. `readReg`, `getUOMask`, `tellTime`, `getTitleInfos`, `getPlaylistInfo`, `getAacsData` (null) answer locally; the rest call the engine and return the promise. For each native, the plan's implementer records in the report which `bdpriv_*` result the engine computes.

- [ ] **Step 1: Failing tests:** `WorkerBdjHost` reads registers and time synchronously from shared buffers written by a `RegisterFile`/`StatusBlockWriter` in the same test; `writeReg` returns a promise resolved by a fake `call` and `readReg` afterwards sees the value once the fake engine applied it; a native invoking `writeRegN` through the JVM parks the Java thread and resumes with the engine's return value (use `BdjRuntime` with disc-bdj and a host whose `writeReg` resolves after a timer; assert the golden still matches — `tests/bdj/bdj-trace.test.ts` with an async-returning wrapper host); bigint replies round-trip as decimal strings.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run src/engine/bdj tests/bdj` → PASS, golden unchanged.
- [ ] **Step 5: Commit** `feat(bdj): worker protocol and the Java-side host`.

### Task 6: `PlayerBdjHost` — Java drives the player

**Files:** Create `src/engine/bdj/player-host.ts`. Modify `src/engine/player.ts` (a narrow `BdjPlaybackPort`, like `navigationPort()`). Test: `src/engine/bdj/player-host.test.ts` using the player test setup with fake decoders (see `src/engine/player.test.ts`).

**Interfaces:**
- Produces in `player.ts`: `bdjPort(): BdjPlaybackPort` with `playPlaylist(id: string, at: PlayAt): Promise<boolean>`, `seekPlayItem(item)`, `seekMark(mark)`, `seekTime45(t: number)`, `stopPlaylist()`, `setRate(rate: number): void` (pause/play), `currentClipTime45(): number | undefined`, `playlistOpen(): boolean`. Reuse the Navigator's port code paths (`playPlaylist(id, at, viaNavigator)`, `enqueueNavSeek`, `setHold`) rather than duplicating them.
- Produces: `class PlayerBdjHost { constructor(deps: { port: BdjPlaybackPort; regs: RegisterFile; disc: DiscModel; source: ByteSource; events: BdjPlaybackEvents; startTitle(title: number): void; playHdmvTitle(title: number): boolean; uoMaskChanged(bits: bigint): void }); handle(name: BdjCallName, args): Promise<number | string> }` — ports `bdpriv_play_playlist_at` (incl. `_open_playlist`'s 99999 check before closing, PSR updates via `updatePlaylistPsrs`-equivalent writes to PSR 6/7/5/3/8 as `bluray.c` does when a playlist opens and advances), `bdpriv_seek`, `bd_set_rate` (+RATE event), `bdpriv_play_title_internal` (HDMV → `playHdmvTitle`; BD-J → `startTitle`), `bdpriv_reg_write`, `bdpriv_sound_effect` with lazy sound loading as `bd_get_sound_effect`, `bdpriv_set_uo_mask`/`_update_uo_mask` (combined title/playlist/Java masks → `uoMaskChanged`), `bd_select_angle`, `_bd_set_virtual_package`.
- The playlist generation rule: a `selectPlaylist` while a previous open is pending supersedes it (the player's `openGeneration`), and events after it carry the newest playlist.

- [ ] **Step 1: Failing tests:** `selectPlaylist(833…)`-style call on a synthetic disc opens that playlist, writes PSR6/PSR7/PSR8 as playback starts and raises PLAYLIST/PLAYITEM via Task 4 bindings; reaching the end raises END_OF_PLAYLIST once; passing a mark raises MARK with the mark index; `seek` raises SEEK with media time; `selectRate(0)` pauses and raises RATE; `selectPlaylist(100000)` returns 0 without closing the current playlist; two quick `selectPlaylist` calls → only the second plays, events carry its number (Review Focus 5); `soundEffect(id ≥ num_sounds)` returns 0 before sounds are loaded, as libbluray; `selectTitle` on an HDMV title calls `playHdmvTitle`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, NOTICE line (`bdj/player-host.ts from bluray.c (bdpriv_*, _open_playlist, bd_set_rate, _play_title, _update_uo_mask)`). **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(bdj): BD-J host backed by the player`.

### Task 7: BD-J worker and session

**Files:** Create `src/engine/bdj/bdj-worker.ts` (worker entry), `src/engine/bdj/session.ts`. Modify `src/engine/worker.ts` (production deps), `src/engine/player.ts` (`PlayerDeps`). Tests: `session.test.ts` (in-process worker over `MessageChannel`).

**Interfaces:**
- `PlayerDeps` gains `readonly createBdjWorker?: () => WorkerLike` (`postMessage`, `onmessage`, `terminate`) and `readonly loadClassLibrary?: () => Promise<ClassLibrarySource>` (production: three `?url` imports of `src/bdj-classlib/*.jar`, fetched with the 20 s timeout the audio wasm uses; started as soon as a BD-J disc is detected at open).
- `bdj-worker.ts`: on `boot`, builds `FileSource` + `openDisc` + `loadClips`, `BdjRuntime` with `WorkerBdjHost`, real clock (`performance.now`, `setTimeout`), runs `rt.run()` continuously (re-running when idle and a message arrives); posts `booted`/`call`/`log`/`failed`. Factor the logic into `runBdjWorker(port: { postMessage; onmessage })` so tests run it in-process.
- `session.ts`: `class BdjSession { constructor(deps: { worker: WorkerLike; host: PlayerBdjHost; regs: SharedArrayBuffer; status: StatusBlockWriter; …; onFailed(code, message): void; nowMs; setTimer }); boot(files, discId, classLibrary, titles): Promise<void>; start(title: number): void; event(ev: number, param: number): void; stop(): void /* terminate */ }`. It enforces the 20,000 ms first-`selectPlaylist` timeout, ignores messages after `stop()` (Review Focus 1), and reports `failed`.

- [ ] **Step 1: Failing tests:** in-process session on disc-bdj boots, starts First Play, receives the golden's control calls in order and answers them through a fake `PlayerBdjHost`; a class library missing a class → `onFailed('class-not-found', …)`; a worker that never selects a playlist → `onFailed('timeout', …)` after 20,000 ms (virtual timers); messages arriving after `stop()` are ignored and `terminate()` was called; a JVM `halt` mid-title → `onFailed('halted', …)` without throwing in the engine (Review Focus 4).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(bdj): BD-J worker and engine-side session`.

### Task 8: The player runs BD-J titles

**Files:** Modify `src/engine/player.ts`, `src/engine/protocol.ts`, the snapshot reducer (`reduceEvent` in `src/player/player-controller.ts`), `src/ui/PlaylistPicker.tsx`, `src/engine/nav/navigator.ts` (`bdjTitle` path unchanged, handled by player). Tests: `player.test.ts`, reducer test, UI component test if one exists for the picker.

**Interfaces:**
- `NoticeCode` gains `'bdj-menu-hidden'` and `'bdj-failed'`; `'bdj'` remains for builds without BD-J deps. Copy: `bdj-menu-hidden` → "This disc's menu isn't shown yet. The disc is playing on its own; choose a playlist to take over."; `bdj-failed` → "BD-J couldn't start this disc (<code>: <message>). Choose a playlist to play."
- Behaviour: at open, BD-J First Play (`disc.index.firstPlay.kind === 'bdj'`) + deps present → `BdjSession` boots and `start(0xffff)`; Navigator `bdjTitle` → `start(title)`; `playTitle(n)` on a BD-J title → `start(n)`; menu call under a BD-J title → UO check (menu call) then `start(top menu title)` per `_try_menu_call`; title search UO check for `playTitle`. Under a BD-J title, `pause`/`play`/`seek`/chapter commands are never refused (RELAXED) and send RATE/SEEK through Task 4. `playPlaylist` from the picker and `close`/`open` stop the session (Review Focus 2). On `onFailed` → picker state + `bdj-failed` notice; playback already running continues. `indexTitles` stays as is; the picker no longer disables BD-J titles when the engine reports BD-J support (add `bdjSupported: boolean` to the `titles` event).
- [ ] **Step 1: Failing tests:** (player, fake decoders, in-process BD-J worker on disc-bdj) opening disc-bdj plays playlist 00000 without showing the picker and emits `bdj-menu-hidden`; `pause` under the BD-J title is not refused and the session receives RATE; `seek` is not refused and the session receives SEEK; menu call with Java's menu-call mask set is refused with `uo-masked` and the session receives UO_MASKED; choosing a playlist from the picker stops the session and no later host call reaches the player (Review Focus 2); a failing boot shows the picker with `bdj-failed`; reducer handles the new notices and `bdjSupported`; the picker enables BD-J titles when `bdjSupported`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test`, `npx playwright test menus playback` → PASS (HDMV behaviour unchanged).
- [ ] **Step 5: Commit** `feat(bdj): BD-J titles drive playback in the player`.

### Task 9: Trace parity beyond the first playlist

**Files:** Modify `tools/bdj-trace/` (`--until <call>#<n>`: stop at the n-th occurrence), `tools/bdj-trace/golden.sh`, `tests/bdj/replay.ts` or create `tests/bdj/replay-player.ts`, `tests/bdj/run.ts`, `tests/local/bdj-boot.test.ts`, `tests/bdj/golden/disc-bdj.jsonl`.

**Interfaces:**
- `replayPlayerBdj(discDir, { until: string; occurrence: number; timeoutMs }): Promise<{ trace: TraceEntry[]; firstPlaylistMs: number }>` — runs the real `Player` with fake decoders and a virtual clock that fast-forwards playback, `BdjSession` with the in-process worker, and records Java's control calls (same `TraceEntry` format).
- [ ] **Step 1:** Extend the harness's `--until` to `<call>#<n>`; regenerate the synthetic golden so it reaches TitleXlet's playlist ending and the next selection (extend `TitleXlet` to select playlist 00000 again on END_OF_PLAYLIST via a `ControllerListener`, rebuild with `npm run bdj-classlib:build`, `npm run fixture:synthetic`, `npm run bdj-trace:golden`).
- [ ] **Step 2: Failing test:** `tests/bdj/bdj-trace.test.ts` replays disc-bdj through `replayPlayerBdj` to `selectPlaylistN#2` and matches the new golden.
- [ ] **Step 3: Implement** `replayPlayerBdj`. **Step 4:** Run local discs: `npm run bdj-trace -- fixtures/local/BDJ_DISC_A --until selectPlaylistN#2` (expect 833 then 149) and BDJ_DISC_B (1611 then the second selection libbluray makes; the spike saw 01355); fix divergences in the port with regression tests; `tests/local/bdj-boot.test.ts` asserts both selections.
- [ ] **Step 5: Commit** `test(bdj): control calls match libbluray through the menu-background playlist`.

### Task 10: Synthetic HDMV↔BD-J disc

**Files:** Create `scripts/make-bdj-mixed-disc.ts`, `fixtures/synthetic/disc-bdj-mixed/**`, xlet sources under `tests/bdj/xlets/src/bdjweb/mixed/`, goldens (`tests/bdj/golden/disc-bdj-mixed.jsonl`, and `tests/vm-trace/golden/disc-bdj-mixed.*.jsonl` if the vm-trace harness can drive it). Modify `package.json` `fixture:synthetic`, `tools/bdj-classlib/pack.sh` (compile the new xlets).

- [ ] **Step 1:** Disc: First Play BD-J (xlet selects HDMV title 1 through `TitleContext.start`); title 1 HDMV movie object plays playlist 00000 then `JumpTitle 2`; title 2 BD-J (xlet selects playlist 00001). Generate, build, golden.
- [ ] **Step 2: Failing tests:** the player on this disc plays 00000 (HDMV, via Navigator) then 00001 (BD-J), with `selectTitleN [1]` in the BD-J trace and the HDMV VM trace matching its golden.
- [ ] **Step 3: Implement** whatever the handoff needs in `player.ts` / `PlayerBdjHost` (`_stop_bdj` on HDMV title, `_play_bdj` on JumpTitle to BD-J). **Step 4: Run** → PASS; CI workflows' triggers cover the new fixture.
- [ ] **Step 5: Commit** `test(bdj): HDMV and BD-J titles hand over in both directions`.

### Task 11: Start-up speed, stage 1

**Files:** Create `src/engine/bdj/jvm/natives/intrinsics/*.ts`; modify `interpreter.ts`, `session.ts` / `player.ts` (start-up overlap). Tests: one equivalence test per intrinsic; conformance; a timing report test.

**Interfaces:** each intrinsic is registered with `NativeTable.replace('<class>.<method>(<desc>)', fn)` and listed in `src/engine/bdj/jvm/natives/intrinsics/index.ts`.

- [ ] **Step 1: Profile** `npm run bdj-trace -- fixtures/local/BDJ_DISC_A` under `node --cpu-prof` and record the top 20 self-time entries (Java methods via a per-method bytecode counter added behind a debug flag) in the report.
- [ ] **Step 2: For each hot Java method chosen** (expected: `java/awt/BDGraphicsBase.applyComposite`, the `drawImage`/fill loops it sits in, `java/awt/image/DirectColorModel` getters): a failing equivalence test that runs the Java method (intrinsics off) and the intrinsic (on) on the same randomized inputs (seeded) and compares the resulting `int[]` pixel buffers and return values exactly; then the intrinsic.
- [ ] **Step 3: Interpreter fast paths** the profile justifies (e.g. caching resolved `invokevirtual` targets per call site, trivial getter/setter inlining), each covered by the conformance suite.
- [ ] **Step 4: Start-up overlap:** class-library fetch starts at disc open when `indexUsesBdj`; JVM boot runs while the disc model loads.
- [ ] **Step 5: Measure** Node replay untilMs for both discs and the browser figure (Task 12's test); record both. Conformance and goldens unchanged. Commit `perf(bdj): intrinsics and interpreter fast paths`.

### Task 12: Browser tests

**Files:** Create `tests/e2e/bdj.spec.ts` (CI, synthetic disc-bdj: opens, plays playlist 00000 under BD-J, notice shown, picker reachable). Modify `tests/e2e/local-discs.spec.ts` (BD-J discs: first Java-selected playlist frame time ≤ 5,000 ms warm, cold recorded; menu-background playlist reached; forced failure via a test-only `?bdjfail=1` hook that injects a broken class library through deps → picker + `bdj-failed`). Telemetry gains `bdj: { bootMs, firstPlaylistMs } | null`.

- [ ] **Step 1: Failing tests** as above. **Step 2: Implement** telemetry fields and the test hook (guarded like `?telemetry=1`). **Step 3: Run** `npm run build && npx playwright test bdj` and `LOCAL_DISCS=1 npx playwright test local-discs` → record times.
- [ ] **Step 4: Decision point:** if BDJ_DISC_A warm > 5,000 ms, do Task 13; otherwise skip it (record "not needed" in the ledger and the spec's deviations).
- [ ] **Step 5: Commit** `test(bdj): BD-J discs in the browser`.

### Task 13 (conditional): JIT, stage 2

Only if Task 12 measured > 5,000 ms. Files: `src/engine/bdj/jvm/jit/*.ts`. Requirements are spec §4.7 stage 2 verbatim: hot-method threshold; interpreter fallback for unsupported constructs; yield checks in loops and calls; `Suspend`/`Invoke` continuations; exceptions with exact handler ranges; stack traces with line numbers; `StackOverflowError` depth; class-init triggers; monitors; `new Function` in the BD-J worker with clean disable when code generation is unavailable (CSP). Tests: conformance with JIT forced on for every method; goldens unchanged; local timings. Commit `perf(bdj): JIT for hot methods`. If still > 5,000 ms, record time and profile in known-issues.

### Task 14: Docs and final verification

- [ ] Update `CLAUDE.md` (5c done; BD-J worker in the architecture; new deps), `docs/known-issues.md` (5c timings; what 5d picks up: graphics, keys, fonts; any open items), the spec's status and a "Deviations" section, the parent spec's BD-J row.
- [ ] Verify: `npm run typecheck && npm test`, `npm run build`, `npm run test:e2e`, `npm run bdj-classlib:build` + diff, `npm run bdj-trace:golden` + diff, `npm run vm-trace:golden` + diff, `LOCAL_DISCS=1 npx playwright test local-discs`.
- [ ] Commit `docs(bdj): milestone 5c`.
