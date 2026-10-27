# Milestone 5e: every BD-J disc in the library — design

Date: 2026-10-18
Status: Done; merged to main via PR #9 (32dd53e) 2026-10-22 (approved 2026-10-18); the device check passed on a real iPhone on 2026-10-22 (§9, R27, R33, R34)
Builds on: `2026-10-17-m5d-bdj-menus-design.md` (5d, merged as PR #7), `2026-10-16-m5c-bdj-playback-design.md`, `2026-10-15-m5b-bdj-jvm-core-design.md`. Parent: `2026-10-12-bluray-web-player-design.md`. Depends in part on the NAS session's step 3 (people and a per-person store; `2026-10-17-nas-server-design.md` and its step-3 successor).

## 1. Intent

After 5d, the user's two local BD-J discs work "as if using a Blu-ray player" on computer, iPhone and iPad, and the user is happy with how they behave. The user's NAS library holds 2,340 discs, 166 of them BD-J. 5e makes **every one of those 166 work as well as the two local discs** (the user: "every one"). "Storage, network, speed" in CLAUDE.md was a placeholder label; the real goal is library coverage.

What a disc saves between viewings (resume points, settings, progress) is kept **on the NAS, per person** (the user), so one person's devices share it and other people's stay separate. People on the NAS are built by the NAS session (step 3); 5e builds the BD-J side on top.

## 2. Where we start: the library scan (2026-10-18)

A read-only scan (over SSH, `ionice`, no video read; results and the id→path map kept outside the repo) booted each BD-J disc's start-up files in our player headlessly, with stub video so every playlist ends at once and no keys pressed, and compared failures with libbluray (`tools/bdj-trace`) on a sample of 30.

| Outcome | Discs |
|---|---|
| Selects a playlist and draws (as the local discs do in this setup) | 69 |
| Selects a playlist, draws nothing (libbluray the same on all 4; probably needs real playback) | 4 |
| Java stops on a JDK class missing from `rt-bdj.jar` | 49 |
| Our player refuses an MPEG-2 video playlist (`selectPlaylist` → 0), Java stalls | 26 |
| Our player refuses a VC-1 video playlist, Java stalls | 18 |
| Missing native, interpreter crash, hang, storage failure | 0 |

Missing classes (first blocker / any): `java.io.FileWriter` 14/19, `sun.net.www.protocol.jar.JarURLConnection` 11/11, `sun.net.www.protocol.http.Handler` 6/12 (BD-Live), `java.rmi.registry.Registry` 5/5, `java.util.TreeSet` 3/10, `sun.reflect.UnsafeStaticFloatFieldAccessorImpl` 3/3, `sun.util.locale.provider.DateFormatProviderImpl` 2/3, `sun.awt.image.ByteArrayImageSource` 2/2 (libbluray also stalls on that disc), `sun.awt.image.URLImageSource` 0/7, and single discs on `IndexColorModel`, `DontCareFieldPosition`, `UnsafeLongFieldAccessorImpl`, `ImageFormatException`, `FileFilter`, `Polygon`. libbluray got further on every sampled missing-class disc except the `ByteArrayImageSource` one. 12 discs try BD-Live HTTP. 9 write files under `/persistent`; 94 look for saved files that don't exist yet (a first run). No ISO in the library is BD-J.

## 3. Decisions

| Topic | Decision | Whose |
|---|---|---|
| Goal | Every BD-J disc in the NAS library works as well as the two local discs | User |
| What "works" means | The automatic check of §5 on every BD-J disc, plus a few discs checked by hand on the iPhone | User agreed (my proposal) |
| MPEG-2 / VC-1 video | 5e makes those discs' menus work and says the video can't play here yet; playing the film is NAS step 4 (Quick Sync re-encode), a separate track | User |
| Saved data | On the NAS, per person; per-browser only for discs opened from a local folder | User |
| People on the NAS | Built by the NAS session in its step 3 ("separate users when pairing"); 5e builds on its API | User; NAS session agreed |
| Speed, JIT | Out of scope: the user is happy with how discs feel; the cold-start deviation stays as accepted in 5d §9 | User ("it behaves fine") |
| Finish line | 5e is done only when saved data works per person on the NAS: the milestone (and its merge to main) waits for the NAS session's step-3 store; the rest of 5e is built meanwhile, with the browser backend first | User ("hold") |

## 4. What 5e builds

### 4.1 The class library covers the library

- Widen `src/bdj-classlib/classes.txt` (and so `rt-bdj.jar`) with what the 166 discs need, collected the way the current list was: from HotSpot's `-verbose:class` in the libbluray harness, run over the library's BD-J discs (copied start-up files, as the scan did), with key scripts that reach their menus. Whole packages may be added where a disc's use is open-ended (for example `java.util` collections), as long as the jar stays reproducible and licensed (GPLv2+CE, with any third-party notices, as 5d did for Xerces).
- Repeat until no disc stops on a missing class: fixing one class often reveals the next.
- Any class that needs natives or intrinsics our JVM lacks is implemented (libbluray-derived in `src/engine`, OpenJDK-derived only in `src/bdj-classlib/intrinsics/`).
- Size: the jar is precached by the service worker for every visitor; growth is measured and reported, and kept proportionate (no whole-JDK import).

### 4.2 MPEG-2 and VC-1 discs

- `selectPlaylist` on a playlist whose video the browser can't decode **succeeds**, as in libbluray: the playlist "plays" with audio, subtitles, IG/BD-J graphics and the clock, without a picture. The disc's Java carries on (its menus, its events, its timers).
- The user sees a clear, once-per-disc notice: this disc's video can't play here yet (wording settled in the plan; no codec jargon needed in the main line).
- No video decoding is added. NAS step 4 later makes the picture appear; until then nothing pretends to show video.
- HDMV discs with MPEG-2/VC-1 get the same behaviour (my call, for consistency): today `UnsupportedCodecError` stops the Player (`state: 'error'`); after 5e the playlist runs without a picture (audio, PG, IG menus, the clock) with the same notice. The change sits in the shared Player path, not only in `PlayerBdjHost`, and is checked against the vm-trace and navigator goldens (no diff) and the HDMV E2E.

### 4.3 BD-Live and other network use

- The HTTP (and any other) URL handler classes exist, so a disc's online check runs; the connection then **fails cleanly**, as libbluray's does offline ("No route to host"-class `IOException`), and the disc carries on. No real network access from BD-J in 5e (BD-Live servers are long gone; anti-goal below).

### 4.4 Saved data that lasts

- BD-J's two storage areas, as libbluray mounts them: `/persistent/<orgId>/<appId>/…` (shared by apps of one organisation) and `/buda/<orgId>/<discId>/…` (one disc).
- The unit of storage is a **scope**, one whole subtree read and written as a snapshot: `persistent/<orgId>` and `buda/<orgId>/<discId>` (ids from the disc's BDJO and `id.bdmv`).
- One `BdjStore` interface with two backends:
  - **NAS** (discs from the NAS, once step 3's API exists): per person, behind the device token. The sketch sent to the NAS session: `GET bdj-store/<scope>` → `{etag, files}` + bytes; `PUT` with `If-Match` replaces atomically; 412 on a stale etag → re-read, merge per file by mtime, retry; proposed quotas 16 MB per scope, 256 MB per person; over quota → the JVM sees "no space" (IOException), as on a full disk. The NAS session's step-3 spec owns the final API.
  - **Browser** (IndexedDB): discs from a local folder, and every disc until the NAS API exists.
  - **Moving to the NAS when it goes live** (my call): a paired device belongs to one person, so the browser's saves for NAS discs belong to that device's person. On the first boot of a scope with the NAS backend, a browser copy of that scope is merged into the person's NAS scope (per file, newer mtime wins, as on a 412), then marked migrated (kept, not deleted, until the NAS write succeeds). Saves for local-folder discs stay in the browser. The IndexedDB layout records each scope's disc source (NAS id or local) from the start, so this works.
- Reads: once per scope at BD-J boot, before the xlet starts (on the start-up path, so an empty scope must answer at once). Writes: debounced (about 2 s after the last file write) and on BD-J stop (title change, close, `pagehide`/`visibilitychange` with `keepalive`). Browsers cap `keepalive` bodies at 64 KB, so a scope bigger than that is flushed with a plain request while the page is still up (the debounce keeps the final flush small or empty); the NAS session agreed the sketch (scopes, etags, 412, quotas, 507 over quota, fast empty GET) and settles body format, atomic replace and the admin "clear saved data" action in its spec.
- The disc's Java sees exactly libbluray's file semantics; only where the bytes live changes. The constrained memory budget for these mounts (5d R16) still applies.

## 5. How "works" is checked

An automatic **library check**, run over every BD-J disc (start-up files copied from the NAS as in the scan, with real or stub video as the step needs), in our player and in libbluray (`tools/bdj-trace`) with the same inputs:

1. The disc reaches its menu (a visible plane, or a playlist with drawing).
2. Arrow keys visibly change the menu.
3. Enter starts a playlist (or a title change).
4. libbluray, given the same presses, does the same (settled-plane hashes and control calls compared as in 5d, R3; where libbluray itself fails, the disc is reported as "libbluray fails too", not as ours).

Plus a few discs checked by hand on the iPhone over the NAS (the user), chosen to cover each failure category the scan found.

Results stay outside the repo (disc names are private: the repo is public). The check's tooling (scripts, reductions) is committed with made-up names only.

## 6. Goals, non-goals, anti-goals

Goals:
1. Every BD-J disc in the library passes the §5 check, or is shown to fail in libbluray too (documented as such).
2. MPEG-2 and VC-1 BD-J discs reach and use their menus, with the notice.
3. Saved data survives between viewings, per person on the NAS, verified with two people on two devices each (one person's iPad and iPhone share saves; the other person's don't see them); browser-local for local folders. 5e is not finished, and not merged, until this works against the NAS session's live store.
4. No regression: the two local discs, the synthetic discs, all goldens (bdj-trace, vm-trace, local), the device-gate behaviour and the desktop 5 s bar stay as they are.

Non-goals:
- Playing MPEG-2 or VC-1 video (NAS step 4).
- Start-up speed work and the JIT.
- Building people/accounts on the NAS (NAS session, step 3).
- Real BD-Live network access.

Anti-goals:
- A disc's saved data leaking to another person, or being lost silently (a failed write is logged and retried, never dropped without a trace).
- Real disc, series or folder names anywhere in the repo, commits or CI logs.
- Load on the NAS drives from checks (read-only, `ionice`, no video reads unless a step truly needs playback, sequential copies).
- Pretending video plays (a black picture with no explanation).

## 7. Constraints

- All of CLAUDE.md: licensing per directory, `src/engine` without UI imports, strict TypeScript, no user-agent sniffing, cross-origin isolation, artifacts rebuilt only by their scripts with CI diffs, goldens never hand-edited, a divergence from libbluray is a porting bug.
- The NAS is touched read-only by 5e; the NAS server code belongs to the NAS session (5e builds against its API; any change to `nas-api.ts`, `nas-client.ts`, `server/` is agreed with that session first).
- Devices: coordinate with the NAS session before using the iPhone/iPad.

## 8. Left to the builder

- How the library check copies, caches and re-runs discs (keep it incremental; the scan's scripts are a starting point, in the scratchpad).
- How classes are collected (harness runs per disc vs whole packages), within §4.1's size and licence rules.
- The exact notice wording for MPEG-2/VC-1, the IndexedDB layout, and the merge on a 412.
- Order of work, except: §4.4's NAS backend waits for the NAS session's API (the plan's last phase; everything else proceeds first, and the branch is not merged before that phase passes); the MPEG-2/VC-1 change lands before NAS step 4 touches playback (tell the NAS session when it has merged).

## 9. Deviations

Where the build departs from this spec or from its plan (`docs/superpowers/plans/2026-10-18-m5e-bdj-library-coverage.md`). The rulings are numbered as in the build's ledger.

**The library check (§5).**
1. **Stub streams, with real menu video where they can't decide (R4).** The check runs from copied start-up files, with a stub clip per clip. For the discs whose menu the stubs can't show (libbluray-fails-too, stall, unconfirmed, diverges), `bdj-library:sync --video` copied the real clips of the playlists Java selected up to its menu: about 43 GB, read once, sequentially, under `ionice`, at most 2 GB a disc. Four discs whose menu playlist is the feature stay on stubs.
2. **How a step is judged (R2, R3, R5).** The script's first wait is `wait menu` (a visible plane that has stopped flushing, or one that keeps animating for 30 s, whose hash is then not compared), and each key is followed by `wait quiet`, so a key that changes nothing still moves the script on. Steps compare settled planes and the set of calls that start something, not register writes, rates or call counts, which move with stub timing. A key neither player reacts to counts as agreement.
3. **A seventh verdict, `unconfirmed` (R6).** A disc whose menu shows and agrees with libbluray wherever both ran, but where a key step was never compared (libbluray stopped first) and ours showed no reaction, is neither `works` nor a failure: it is listed for the check by hand. 14 discs end there.
4. **The harness runs offline (R7).** libbluray's harness had network access during the first collection and checks, so disc xlets reached real BD-Live servers. It now runs with `--network none` by default, the classes were collected again offline, and the discs that tried the network were re-checked.

**The class library (§4.1) and network (§4.3).**
5. **No HTTPS (R13).** JSSE (about 267 classes, +25% jar) was left out for the one disc that asks for an `https:` URL; its BD-Live client catches the failure and carries on. The check doesn't count a class lookup that platform code catches and survives (`caughtGaps`).
6. **Thread hand-off and access control, beyond the spec (R19, R20).** Two causes outside the class library held discs back: at a monitor hand-off that wakes a waiter the releasing green thread now yields (closer to HotSpot's parallel threads), and `AccessController` walks the interpreter's frames against the protection domains and the JDK's `java.policy`, so the denials HotSpot makes under libbluray's security manager happen here too. Both were gated on the goldens, the A_NEW_ERA start-up bar and a full library check.

**MPEG-2 and VC-1 (§4.2).**
7. **A playlist with nothing playable still plays (R12).** The plan kept `UnsupportedCodecError` for a playlist with undecodable video and nothing else to play; it now runs silent and black on the wall clock to its end, as libbluray does and as some HDMV programs expect. `UnsupportedCodecError` is left for a decoder that fails to configure.
8. **Pacing and end (R8, R10, R11).** A no-picture playlist's reads are paced by the clock on the data delivered, through the clip's EP map, never faster than real time; it ends at EOF once what was delivered has played, or at its duration.
9. **The notice once per disc (R9).** It shows at the first playlist without a picture and clears for good when a playlist with a picture starts.

**Saved data (§4.4).**
10. **A third scope, `buda/<orgId>` (R14).** Some discs write files directly under `/buda/<orgId>/`, outside any disc folder; libbluray keeps them, so they are a scope of their own (only the loose files). The NAS session added it to its store.
11. **A disc without a disc ID (R15).** Its BUDA scope is keyed by a fingerprint of its BDMV file list, so two such discs of one organisation don't share it; Java still sees libbluray's 32 zeros.
12. **The browser saves after 100 ms, not 2 s (R16).** Chrome and Safari drop both the worker's pagehide flush and IndexedDB work started in pagehide, so the debounce is the only reliable path; the NAS keeps 2 s.
13. **No `keepalive` put on pagehide; a write-ahead copy instead (R17).** The spec's pagehide flush to the NAS is replaced: a NAS disc's writes go to IndexedDB first, marked pending, then to the NAS on the 2 s debounce, on stop and when the page is shown again, and a pending copy is merged and put at the next boot. A page closed early loses nothing on that device; another device may miss the last seconds until it opens again.
14. **The quota is counted as the NAS counts it (R24).** 16 MB per scope is the size of the scope's ustar archive (headers and padding included), so the write that crosses it is an IOException at once instead of a later 507.
15. **The person guard (R25).** Every NAS write carries `X-Bdj-Person` (the NAS answers 409 when the device now belongs to someone else) and `GET me` is checked before each put. Against a server without the guard's CORS header a write falls back once, without it, after a person check; once the header has worked the session never falls back. The flag is per session, not persisted.
16. **Where the backend is chosen.** In the BD-J worker (`nas-store.ts`, `NasDiscStore`), from the disc's source; the browser's `nas:<discId>` records from before move into the person's scopes once, and a server with no people (the dev disc server) keeps them in the browser.
17. **A slow NAS at boot keeps the session's saves (R28).** The NAS's part of the boot has 12 s (the plan's store had 2.5 s inside ScopeSync's 3 s), set through `BdjStore.loadTimeoutMs`, with the person check after each GET inside it. A scope the NAS misses with no copy in the browser starts empty, and its writes are kept as a pending copy marked `unmerged`, merged at the next boot with the NAS's files winning on every path both have, so only the paths the NAS lacks are added (R29: Java wrote it without seeing the saved data); when `GET me` itself misses, the session starts empty (never with earlier such saves) and only adds to a copy kept apart under the person last confirmed for the device, given to that person only when the NAS names them again, and removed when the NAS names someone else or after 30 days (R30). A put that took files from the NAS also folds them into the browser's copy whatever was saved meanwhile, so another device's files are never dropped by the next put (final review, Important 1).
18. **The viewer is told when saved data won't last (R32).** Failures stay logged as before, and the player also shows a notice, at most once per disc open (code `bdj-storage`): "This disc's saved data can't be kept right now, so progress you make may be lost." It shows at Java's first write into a scope kept in memory only with no copy anywhere (no IndexedDB, IndexedDB refusing, a device never confirmed in this browser; at the write, never at boot, R32a), a write refused for room (16 MB per scope, the NAS's 507, IndexedDB's quota, the VFS's memory cap, R16) and a NAS put refused for good (a 4xx other than a conflict or a request to wait, a 401 included). It does not show for a boot that missed the NAS but keeps an unmerged copy (R28, R29), a 412 that merges, or a put still being tried again (unreachable, timed out, 5xx). The BD-J worker sends `storageLost` once per session and never after a stop; the player keeps the once-per-open rule across sessions.

**Player behaviour outside the spec.**
19. **Player settings at disc open (the user, 2026-10-20; f08eb01).** The 5c rule wrote the locale's player settings only on BD-J entry. One library disc's HDMV First Play copies the menu language into a register its BD-J menu reads, so the settings are now written when a disc whose index names a BD-J object opens, as libbluray does at `bd_open`; discs without BD-J keep the defaults.
20. **The start-up timeout counts active time only (R22, R26).** The 20 s fallback (5d R7) now counts only while the page is visible and the host awake (1 s ticks; a tick 5 s late restarts the budget), and not while the BD-J worker waits on its own reads, for at most 120 s of such waits per boot. A cold first open over the NAS spent most of its 20 s waiting on JAR and resource reads and fell back with nothing hung.
21. **The clock holds at the target while audio loads (Task 7d).** A stale clock from the previous playlist fired marks early after a seek or open; it now holds at the seek or open target, which also changes paused seeks on HDMV discs (vm-trace goldens unchanged).

**Finish line (§3, §5, §6).**
22. **The device check ran late, on one real device (R27, R33, R34).** The user could not run the devices when the rest was done, so the check became the last gate before the merge, and when it ran (2026-10-22) only the iPhone was at hand: `tools/devices/live-check.ts` ran on the iPhone over the live NAS with the iPad Simulator as the person's second device. Two made-up test people, two devices each: each person's count was kept apart and shared by their own devices. All 14 unconfirmed discs opened on the iPhone and 13 reached their menu. The tool's real touches miss on the iPhone's player screen (a probe showed the phone places touches exactly, so it is the tool's timing), so the arrows and Enter of the 14 were checked in desktop Chrome: 13 react (a sub-menu or a playlist; the MPEG-2/VC-1 one with its notice), and one plays a long opening video before any menu, in libbluray too, left for a check by hand.
23. **The result is not "every disc works".** The latest full check: works 134, unconfirmed 14, libbluray-fails-too 18, missing-class 0, unsupported-video 0, stall 0, diverges 0, error 0, of 166. The libbluray-fails-too discs show no menu in libbluray's harness either (§5's own exception); the unconfirmed ones wait for the check by hand. `docs/known-issues.md` (BD-J) groups them by cause.
