# Milestone 5c: BD-J Titles Drive Playback — Design Spec

Date: 2026-10-16
Status: Implemented (2026-10-17); plan `docs/superpowers/plans/2026-10-16-m5c-bdj-playback.md`. See §9.
Builds on: `2026-10-15-m5b-bdj-jvm-core-design.md` (the JVM, `BdjHost`, `BdjRuntime`; see its §9 deviations) and
`2026-10-14-m3-hdmv-menus-design.md` (Navigator, register file, UO masks). Parent: `2026-10-12-bluray-web-player-design.md`.

## 1. Intent

Today a BD-J disc opens to the playlist picker with a "BD-J isn't supported" notice. After 5c, opening a BD-J disc
runs the disc's own Java code in the player, and that code decides what plays, exactly as a Blu-ray player would:
on BDJ_DISC_A the studio logos play with sound, then the menu's looping background video starts; on BDJ_DISC_B its
intro plays, then the language picker's background. The menu itself is still invisible (graphics, keys and fonts are
5d), but the disc is "running", not being driven by our picker.

It must start quickly. The user's bar: **about 5 seconds from opening BDJ_DISC_A to its first logo frame**, faster if
we can. M5b measured 26 s in Node to the first playlist selection, nearly all of it in libbluray's per-pixel menu
compositing (`BDGraphicsBase.applyComposite`, `DirectColorModel` getters: about 100M interpreted calls). Speed work
on that path is therefore part of 5c, not deferred.

Player controls during a BD-J title behave as libbluray does (the user's instruction: "whatever the default is for
libbluray/Blu-ray players"): the disc's UO mask decides what is allowed, and menu calls go to the disc.

### Goals

1. A disc whose First Play (or a chosen title) is BD-J boots the JVM in the player and plays what the Java code selects.
2. Playback events reach Java as libbluray sends them, so the disc's own logic advances (logos end → menu loop).
3. Both local discs reach their menu-background playlist, with the control calls matching libbluray's beyond the first
   playlist.
4. BDJ_DISC_A's first logo frame appears within 5 s of opening the disc in Chrome on the developer's machine.
5. Player controls follow libbluray's rules for BD-J titles (UO masks, rate, seek, chapter skip, menu call).
6. If the BD-J runtime fails, the player falls back to today's picker with a clear notice. It never sits on a black
   screen.

### Non-goals (5d / 5e)

- Showing BD-J graphics (`updateGraphicN` output), remote/keyboard/mouse keys to Java (`BDJ_EVENT_VK_KEY`,
  `BDJ_EVENT_MOUSE`), the pop-up menu key, real fonts — 5d.
- Persistent storage across sessions, BD-Live/network, BUDA/virtual package content, JAR signature policy — 5e.
- Angle switching (the player has no angle support; PSR3 stays 1).

### Anti-goals (would make 5c a failure even if it technically works)

- A long black screen after opening a BD-J disc (the 5 s bar), or the video stuttering because Java is busy.
- A BD-J failure that leaves the user stuck with no picker and no message.
- HDMV discs, non-menu playlist playback, subtitles or audio behaving any differently than today, except where this
  spec names a libbluray-faithful fix (§4.6).

## 2. Constraints

- Everything ported keeps the project's rule: function by function from libbluray at `448f896`, recorded in
  `src/engine/NOTICE`; `src/engine/` stays LGPL and free of UI imports; TypeScript strict as configured.
- The JVM stays the 5b JVM (`src/engine/bdj/`); its conformance suite and the synthetic-disc golden keep passing.
- Cross-origin isolation (COOP/COEP) stays intact; the class-library jars are same-origin static assets.
- New browser APIs go behind injectable interfaces (`PlayerDeps` pattern) so the player stays unit-testable in Node.
- Build artifacts (`src/bdj-classlib/`, goldens) change only through their scripts.

## 3. Decisions taken in the conversation

| Question | Decision (whose) |
|---|---|
| Next milestone | 5c (user) |
| What "done" looks like | Both discs play intro then menu-background loop, driven by Java; picker fallback on failure (user agreed to the proposal) |
| Start-up time | About 5 s from open to BDJ_DISC_A's first logo frame, faster if possible (user) |
| Player controls during BD-J titles | libbluray's defaults (user) |
| Speed work in 5c | Yes, because of the 5 s bar (follows from the user's answer) |
| If intrinsics and fast paths miss 5 s | Build a JIT (bytecode → JS) as a second stage; only if stage 1 falls short (user) |
| Player controls, precisely | libbluray's default RELAXED restriction level: only menu call and title search are checked (from the user's "libbluray defaults") |

## 4. Design

### 4.1 Where the JVM runs (my call)

The JVM runs in a **dedicated BD-J worker** started by the engine worker when a disc needs BD-J, as the 5b spec
planned. Reason: the JVM's work arrives in long bursts (menu compositing), and on the engine worker those would stall
video presentation and audio feeding; a dedicated worker also gets its own core, which the 5 s bar needs.

The engine worker stays the owner of playback and of the **register file**. Java's view of it must be synchronous
(`readRegN`, `getUOMaskN`, `tellTimeN` are called often and must return a value at once):

- PSRs and GPRs live in a `SharedArrayBuffer` (`Int32Array`, 128 PSRs + 4096 GPRs), owned by the engine-side
  `RegisterFile`, which writes through to it. The BD-J worker reads it directly.
- Java's writes (`writeRegN`) are a round trip (my call): the calling Java thread parks on a `Suspend` until the engine
  has applied the write through the real `RegisterFile` (so PSR callbacks, stream selection and BD-J events happen in
  libbluray's order, as `bd_psr_write_bits`/`bd_gpr_write` do under the mutex) and returned its result. A later
  `readRegN` therefore always sees the write, as in libbluray. Other Java threads keep running while one waits.
- `tellTimeN` and the UO mask read from a small shared status block the engine updates each tick (presentation time
  as 45 kHz ticks, current UO mask bits, playlist/clip state).
- Calls that change playback (`selectPlaylistN`, `seekN`, `selectRateN`, `selectTitleN`, `soundEffectN`,
  `setUOMaskN`, `setKeyInterestN`, `selectAngleN`, `setVirtualPackageN`) are messages to the engine. Those whose
  libbluray return value depends on engine state return through a `Suspend` on the Java side until the engine answers
  (green threads park; other Java threads run). Which calls need a real round trip and which can answer locally is
  decided per native from `bluray.c` (the plan lists each).
- Engine → BD-J messages carry BD-J events (§4.3) and title starts; the BD-J worker feeds them to
  `BdjRuntime.processEvent`/`start` in order (5b already serialises events).

If measurement shows the dedicated worker is not needed for smooth playback and the 5 s bar, the builder may propose
keeping the JVM in the engine worker instead; that is a change to bring back, not to make silently.

### 4.2 The real host

A new `PlayerBdjHost` (engine side) implements the playback half of `BdjHost` against the live player; a thin
`WorkerBdjHost` (BD-J side) implements `BdjHost` for the natives by reading the shared buffers and messaging the
engine. Behaviour is ported from the `bdpriv_*` functions `RecordingHost` already follows, but on real state, and
without RecordingHost's known shortcuts (5b known-issues): playback PSRs 3/5/6/7/8 are written as playback really
progresses; `listBdFilesN` order follows libbluray's directory order rule (decide from `disc_open_dir`/the UDF and
file-system readers — sorted is acceptable only if libbluray's readers sort); sound effects load lazily as
`bd_get_sound_effect` does; HDMV `titleOf` and `selectPlaylist`'s range check follow the C exactly.

The disc ID (`readBdid`) and libbluray's UHD/3D player-profile switch (`_fill_disc_info` → `psr_init_UHD`/`psr_init_3D`,
done in 5b's `RecordingHost`) move into the engine's disc-open path and apply to the shared register file, so they
hold for HDMV and BD-J alike (§4.6).

### 4.3 Events to Java (ported from `bluray.c`)

- PSR writes/changes on the shared register file raise BD-J events exactly as `_process_psr_write_event` /
  `_process_psr_change_event` do: PSR3 → ANGLE, PSR6 → PLAYLIST, PSR7 → PLAYITEM, PSR8 → PTS, PSR102 → PSR102,
  PSR5 → CHAPTER (change), PSR1 → AUDIO_STREAM, PSR2 → SUBTITLE, secondary stream PSRs → SECONDARY_STREAM.
- END_OF_PLAYLIST when a BD-J title's playlist ends (`bd_read_ext` path: once per end, with PSR6's value).
- MARK for each play mark passed (`_playmark_reached`), SEEK after a seek with the media time (`_seek_internal`).
- RATE on pause/play/rate changes (`bd_set_rate` path), after the UO check.
- UO_MASKED when a user operation is refused under a BD-J title (the `_bdj_event(BDJ_EVENT_UO_MASKED, …)` sites).
- PTS events are frequent (every PSR8 update); they are sent at libbluray's granularity but may be coalesced to the
  latest value per engine tick if profiling shows message cost (the Java side only needs the newest PTS).

### 4.4 Titles and the HDMV/BD-J handoff

- Disc open: if the First Play object is BD-J, the engine starts the BD-J worker, boots the runtime and sends
  `start(0xffff)`; if HDMV, the Navigator starts as today.
- A BD-J title selected from the picker's title list (today disabled with "Needs BD-J") starts through the same path
  (`_play_title` semantics, incl. the title UO mask from the BDJO's terminal info).
- HDMV → BD-J: the Navigator's existing `bdjTitle` event (`playBdj`) starts the BD-J title instead of showing the
  notice. BD-J → HDMV: `selectTitleN` on an HDMV title stops BD-J playback (`_stop_bdj`) and hands the title to the
  Navigator, as `bdpriv_play_title_internal` → `_play_title` does. Neither local disc mixes the two, so this path is
  covered by a synthetic disc (§6).
- Menu call (Top Menu button) under a BD-J title: UO check, then `_play_title(TOP_MENU)` — on these discs a BD-J top
  menu object, i.e. `start(top menu title)`.
- Leaving BD-J (playlist picked from the picker, disc closed): `stop()`, BD-J worker terminated.

### 4.5 Player controls under a BD-J title

Exactly libbluray's rules at its default restriction level, `BLURAY_PLAYER_SETTING_UO_RESTRICTION_RELAXED`
(`bluray.c:1505`):

- Only **menu call** and **title search** are checked against the effective UO mask (title mask from the BDJO
  terminal info, Java's `setUOMaskN`, the playlist's mask) (`bluray.c:3684`, `3721`). A refused one shows the existing
  "not allowed" notice and sends UO_MASKED to Java.
- **Pause/play, seek and chapter skip are never refused** under a BD-J title: at RELAXED, `_seek_time` does no UO
  check (`bluray.c:1791`), `bd_seek_chapter` checks only above SAFE (`:1829`), and `_get_rate_uo_index` ignores pause
  and still-off (`:3976-3997`). So the BD-J path must not reuse the player's stricter HDMV `refused()` checks for these.
- Allowed pause/play/rate changes send RATE; seeks and chapter skips seek the playlist and send SEEK (and MARK/CHAPTER
  as crossed).
- The pop-up key and arrow/enter keys do nothing new in 5c (they become VK_KEY events in 5d).

### 4.5a What the user sees while the menu is invisible (my call)

- A notice when a BD-J title starts: the disc's own menu isn't shown yet in this version; playback is the disc's.
- The playlist picker and the title list stay reachable during a BD-J title, so the user can leave (choosing a playlist
  stops BD-J, as in §4.4). BD-J titles in the title list are enabled.
- The screen is black whenever Java has no playlist open (before its first selection, between playlists); that is
  expected, not the anti-goal, as long as the first playlist starts within the §1 bar.

### 4.6 Libbluray-faithful fixes that touch HDMV (named exceptions to "nothing else changes")

- The UHD/3D player-profile switch in `_fill_disc_info` applies to the player's register file for every disc
  (known-issues from 5b: the HDMV Navigator lacks it). This changes PSR29/31 on UHD and 3D discs to libbluray's values.
- The parked 5b scheduler fix: `Scheduler.step()`'s throw path must run a stored continuation (`k(new ThrowResult(…))`)
  instead of skipping it, before the real host drives Invoke chains that can throw.

### 4.7 Start-up speed

The bar is measured in Chrome from the `open` command to the first presented video frame of the first playlist Java
selects (telemetry already reports frames), on a production build (the Playwright preview server), with the HTTP cache
warm (second open of the disc in the same browser profile); the first, cold open is recorded too (my call). Expected work, guided by profiles (Chrome DevTools in the worker, and
`node --cpu-prof` on the Node replay):

- JS intrinsics for the hottest libbluray Java methods (the compositing loops in `BDGraphicsBase`, colour-model
  getters), installed with the existing `NativeTable.replace` mechanism. Each intrinsic must produce identical results
  to the Java method it replaces; a test runs both on the same inputs (pixel buffers compared exactly).
- Interpreter fast paths where profiles show them (e.g. trivial getters/setters, field access, invoke dispatch).
- Start-up overlap: fetch and open the class-library jars while the disc is being opened, and boot the JVM before
  First Play needs it.
- Anything that changes Java-visible behaviour is out of bounds; the conformance suite and the synthetic golden must
  still pass byte for byte.

The work is staged (user's decision):

1. **Stage 1:** the intrinsics, fast paths and start-up overlap above. Then measure against the bar.
2. **Stage 2, only if stage 1 falls short of 5 s:** a bytecode-to-JavaScript compiler (a JIT) for hot methods. It
   compiles a method once it has run often enough, falls back to the interpreter for anything it doesn't handle, and
   keeps the JVM's semantics: green-thread time slicing (yield checks in loops and calls), parking on `Suspend`,
   native `Invoke` continuations, exceptions and handler ranges, stack traces with line numbers, `StackOverflowError`
   depth, class initialisation triggers, and monitors. Compiled code is produced with `new Function` inside the BD-J
   worker; it must be checked against the page's CSP, and switched off cleanly (interpreter only) if code generation
   is unavailable. The conformance suite runs with the JIT forced on for every method, as well as normally.
3. If stage 2 still misses the bar, record the measured time and the profile in known-issues; 5c is then done at that
   time (no further stages without a new decision).

## 5. Errors and fallback

- Boot failure, a `BdjError`, the JVM halting, or no playlist selected within a timeout after `start` (default 20 s,
  configurable) → stop the BD-J worker, show the picker as today, and a notice naming what failed (code from
  `BdjError`, e.g. "BD-J couldn't start this disc (unsatisfied-link: …). Choose a playlist to play.").
- Uncaught Java exceptions in xlets are logged (5b behaviour) and do not trigger fallback by themselves.
- The engine never blocks on the BD-J worker; a hung JVM cannot stall playback.

## 6. Testing

- **Unit (Node):** `PlayerBdjHost` against the existing fake-decoder `Player` test setup; the shared register buffer
  (write-through, synchronous reads, write validity matching `bd_psr_write_bits`); event mapping from PSR writes,
  end-of-playlist, marks, seeks, rate, UO masks (each against the `bluray.c` behaviour named in §4.3).
- **Trace parity beyond the first playlist (Node):** extend the libbluray harness (`tools/bdj-trace/`) and the replay
  so both run until a later control call (e.g. `--until selectPlaylistN#2`), with the replay host simulating playback
  (playlists end after their duration on a virtual clock, PSR/mark/end events as above). Synthetic disc golden extends
  to a second playlist; local discs must match libbluray through BDJ_DISC_A's `selectPlaylistN(149)` and
  BDJ_DISC_B's menu-background selection (whatever libbluray selects second: the spike saw `01355`).
- **Synthetic HDMV↔BD-J disc:** a small committed disc with a BD-J title that selects an HDMV title and an HDMV title
  that jumps to a BD-J title, with a golden trace (both vm-trace and bdj-trace views where applicable).
- **Browser (Playwright, local discs, `LOCAL_DISCS=1`):** opening BDJ_DISC_A and BDJ_DISC_B plays the first Java-
  selected playlist and then the menu-background playlist; time to first frame of the first playlist is reported and
  must be ≤ 5,000 ms for BDJ_DISC_A (enforced in this local test; not in CI, which has no discs). A forced BD-J failure
  (e.g. a broken class library injected through deps) shows the picker and the notice.
- **Regression:** all existing unit, vm-trace, ass-trace and E2E tests pass; HDMV discs behave as before apart from
  §4.6.

## 7. Exit criteria

1. Both local discs, opened in Chrome, play intro then menu-background playlist under Java control, with A/V sync
   within the existing bounds.
2. Control calls match libbluray through the menu-background playlist selection on both discs; synthetic goldens
   (BD-J, HDMV↔BD-J) match in CI.
3. BDJ_DISC_A: ≤ 5 s from open to first logo frame in Chrome on the developer's machine (warm cache, production build;
   record the number and the cold-open number; better is welcome), or, if stage 2 of §4.7 also falls short, the
   measured time and profile recorded in known-issues.
4. Player controls under BD-J titles follow §4.5; fallback per §5 demonstrably works.
5. All existing tests pass; docs (CLAUDE.md, known-issues, this spec's status and deviations) updated.

## 8. Left to the builder

- The exact message protocol between the engine and BD-J workers, and which natives answer locally vs round-trip
  (from `bluray.c`, per native).
- The shared status block's layout and update cadence.
- Which intrinsics and interpreter fast paths reach the 5 s bar (profile first; keep each one tested against the Java
  it replaces).
- The fallback timeout's default if 20 s proves wrong.

## 9. Deviations (recorded during planning and implementation)

1. **No RATE event from Java's own `selectRateN`.** libbluray's `bdpriv_select_rate` only queues `BD_EVENT_STILL`; RATE comes only from app or user pause and play (the `bd_set_rate` path).
2. **Java-selected playlists open paused** until Java's `selectRate(START)`, as libbluray's `bdj_wait_start` does.
3. **Playback PSR updates are shared with the Navigator** (`src/engine/nav/playback-psrs.ts`).
4. **The 20 s fallback timer** covers boot start to the first `selectPlaylist`, so a hung boot falls back too. A new `BdjSession` is made per BD-J entry, and the timer arms on a session's first start.
5. **A new BD-J worker and JVM per BD-J entry**, where libbluray keeps one JVM across HDMV and BD-J handoffs.
6. **The HDMV Navigator is dropped, not suspended,** while BD-J runs. libbluray's resume of a suspended object across a BD-J title is lost on mixed discs.
7. **`getPlaylistInfo` is answered inside the BD-J worker** from its own disc model; the boot message carries no title list.
8. **Player languages and country come from the browser locale** (ISO 639-2/B, two-letter country) and are written only when a BD-J title is entered; HDMV discs keep the default PSR16-19. New `PlayerDeps.playerSettings` (a port of `bd_set_player_setting_str`). *Changed in 5e (Task 7d):* they are written when a disc that uses BD-J opens, as libbluray does at `bd_open`, so a mixed disc's HDMV First Play reads them; discs without BD-J still keep the defaults.
9. **Java's `System.currentTimeMillis` is wall-clock** (`performance.timeOrigin + now`).
10. **Start-up speed.** Intrinsics are registered with `NativeTable.intrinsify` and `hookLoops`, keeping the bytecode fallback. Three OpenJDK-derived intrinsics (`DirectColorModel.getRGB`, `Rectangle.intersection`, the `PNGImageDecoder` row loop) live in `src/bdj-classlib/intrinsics/` under GPLv2+Classpath Exception and are injected through `JvmOptions.extraIntrinsics`. Intrinsics of a specified algorithm stay in `src/engine`.
11. **Stage 2 (JIT) was not built.** Stage 1 met the bar: BDJ_DISC_A warm 4,934-4,988 ms over 5 runs, cold 5,006-5,013 ms; BDJ_DISC_B warm 843-884 ms, cold 875-916 ms. A speculative pre-boot before disc open gained at most 25 ms and was not built; disc-model and clip reads were parallelised instead.
12. **No vm-trace golden for the mixed HDMV and BD-J disc,** because the vm-trace harness's libbluray has no JVM. Parity rests on its bdj-trace golden and a player test.
13. **SEEK and PSR8 report the requested position,** not the EP-map-aligned one. END_OF_PLAYLIST fires once per presentation end (libbluray: once per open).
