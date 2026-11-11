# bdj-library: the BD-J library check

This tool measures how many of the BD-J discs in the developer's NAS library work in our player as they do in libbluray. It exists because a BD-J disc is a Java program, and the only way to know our JVM and class library cover real discs is to run real discs. Every disc's start-up files are copied once, then each disc runs one generic key script in our player and in libbluray (`tools/bdj-trace`), and the two runs are compared at settled points (5d's Ruling R3). Each disc gets a verdict (`works`, `unconfirmed`, `libbluray-fails-too`, `missing-class`, `unsupported-video`, `stall`, `diverges` or `error`).

Privacy. The repo is public and disc names are private. Everything the tool learns about real discs stays in `$BDJ_LIBRARY_DIR` (default `~/.cache/bluray-web/bdj-library`, outside the repo): the copies, the id→path map, raw runs, results and the summary. Discs are named by id only: the first 10 hex digits of the SHA-1 of the disc folder's path on the NAS. The tool prints ids and counts, never paths. Tests use made-up runs.

## Commands

- `npm run bdj-library:sync -- [--roots auto|<dir>,<dir>...] [--host H] [--dry-run]` (`sync.ts`)
  - Finds the BD-J discs over ssh (`--host` or `$BDJ_LIBRARY_HOST`, no default): a folder with `BDMV/index.bdmv` and at least one `BDMV/BDJO/*.bdjo`. `--roots auto` (the default) searches every `/mnt/*` folder, where the server's library drives are mounted.
  - Read-only on the NAS: every `find` and `tar` runs under `ionice -c3 nice -n19`, `BDMV/STREAM` and `BDMV/BACKUP` are pruned from the search and `STREAM` from the copy (no clip is ever read), and discs are copied one at a time.
  - Copies `BDMV` (without `STREAM`) and `CERTIFICATE` with tar over ssh, the path going on stdin, because rsync skipped paths with spaces or non-ASCII characters. A copy goes to `discs/.tmp-<id>/` and replaces `discs/<id>/` only once its files match the NAS list.
  - Writes a stub `BDMV/STREAM/<clip>.m2ts` per `CLIPINF/<clip>.clpi`: one aligned unit (32 source packets) of null TS packets. The player's readability check passes and every playlist ends at once.
  - Incremental: the NAS file list of each disc (path, size, mtime; `manifests/<id>.tsv`) is compared with the one recorded at its last copy, and an unchanged disc is skipped. A copy with no recorded list (one seeded from elsewhere) is adopted when its file sizes match. A remote listing or a disc copy that takes over 10 minutes is killed and reported (`no answer within 10 min` / `copy not done within 10 min`).
  - Writes `map.tsv`: `id`, `bdj` (1 when `index.bdmv` names a BD-J object), `fingerprint` (hash of the NAS file list) and `path`.
- `npm run bdj-library:sync -- --video [--only <id>...] [--host H]` (`sync.ts`, Ruling R4): real menu video where the stub streams cannot decide. See [Real menu video](#real-menu-video).
- `npm run bdj-library:check -- [--only <id>...] [--ours-only] [--force] [--jobs N] [--lib-jobs N] [--no-run]` (`check.ts`)
  - Runs `generic.keys` on every disc of `map.tsv` with `bdj` 1. Our side runs `tests/bdj/replay-player.ts` (the real `Player`, BD-J in process) in one child process per disc (`check.ts --run-ours <dir> <out>`), killed at 150 s, `--jobs` at a time (default 6). libbluray's side runs `tools/bdj-trace/run.sh <dir> --keys generic.keys --seconds 140 --wait-timeout 60 --tail 5`, killed at 150 s, `--lib-jobs` at a time (default 3). Ours runs first, then libbluray, so the two phases don't slow each other (both wait in wall time).
  - Both sides use the same limits: each step may wait 60 s, a run ends at 140 s, and it goes on 5 s past the script's end.
  - Incremental: each phase writes `raw/<id>.ours.stamp` or `raw/<id>.lib.stamp` (`{ stamp, fingerprint }`) as soon as that disc's run is in, so an interrupted check resumes where it stopped. Our run is reused while the disc's fingerprint and the contents of `src/`, `tests/bdj/`, `tools/bdj-library/` and the script are unchanged, and libbluray's while the fingerprint, the `bluray-web-bdj-trace` image and the script are. `--only` re-runs the given discs, `--force` re-runs everything, `--ours-only` reuses libbluray's runs where present and runs none, and `--no-run` only reclassifies. `--jobs` and `--lib-jobs` take a whole number from 1 to 64.
  - Each libbluray run names its container `bdjlib-<id>-<attempt>` (`run.sh --name`), and the 150 s kill `docker kill`s it before killing the process group (the docker CLI dying would leave the container running). A crashed run, one with no script end line (HotSpot under amd64 emulation sometimes dies at once with a SIGSEGV in `libzip.so`, or the run was killed), is run once more, with `--jvm-option -Dsun.zip.disableMemoryMapping=true`: on some discs the libzip crash (in `ZipFile.getEntry`, on mapped memory under emulation) comes back on every run, and without mapped zip directories it does not. The option changes nothing else. On SIGINT or SIGTERM every running child is killed the same way.
  - Writes `raw/<id>.ours.json` (the RunRecord), `raw/<id>.ours.json.tmp.log` (the Java log), `raw/<id>.lib.jsonl`, `.lib.err` and `.lib.meta.json`, then `results/<id>.json` and `summary.md`.

## Real menu video

Stub streams end every playlist at once, so some discs never show their menu in either player. For those, `--video` copies the real clips of the menu's playlists.

- Which discs: by default those whose current verdict is `libbluray-fails-too` or `stall`; with `--only`, the discs named.
- Which clips (`video.ts`): `menuPlaylists` takes, over both run records, the distinct playlists Java selected (successfully, playlist ≥ 0) before the `wait menu` step held and the first one selected after it; when the step never held, only the first playlist selected. `playlistClips` maps each playlist to its clips through its `.mpls`: the main path's play items and angles, then the sub-paths' (IG, sounds). A clip id that is not five digits is dropped (`isClipId`), here and again before any read. No other clip is ever read.
- The cap: the NAS sizes are read with `stat` (no read). A disc whose clips come to over 2 GB is skipped and reported by id (`planVideo`).
- The copy: each clip is read with `ionice -c3 nice -n19 cat` over ssh (the path on stdin), one at a time, killed after 30 minutes. It goes to `<clip>.m2ts.part`, is checked against the NAS size, and then replaces that clip's stub in `discs/<id>/BDMV/STREAM/`. A failed or short copy deletes its `.part`.
- The record: `manifests/<id>.video.tsv` (`<clip>\t<size>\t<mtime>`) lists the real clips. It is written after each clip, so a re-run copies only clips that are new or changed. A fresh copy of the disc's start-up files (stubs only) deletes it.
- The check: `check.ts` runs both sides on whatever is in `STREAM`, real clips where present and stubs elsewhere. It adds the video record to the disc's fingerprint, so both sides re-run once real clips arrive, and it records `video: real|stub` in `results/<id>.json` and the summary.

## The generic script

`generic.keys` (the `.keys` syntax of `tools/bdj-trace/README.md`, Key scripts):

```
wait menu 1500
key right
wait quiet 1000
key down
wait quiet 1000
key ok
wait playlist any
```

`wait menu 1500` (Ruling R2) holds once the flushed plane is visible (a pixel with non-zero alpha: `GraphicsPlaneReader.visible()` in ours, the same test over the harness's plane at each flush) and has not flushed for 1500 ms, so a blank start-up frame never satisfies it. A menu that stays visible but keeps flushing for 30 s (an animation) satisfies it too: the step is marked `animated` and its hash is not compared, only that it was visible. An init or close, which clears the plane, makes it invisible at once.

`wait quiet 1000` (Ruling R5) holds once the plane has not flushed for 1000 ms since the later of its last flush and the key, so a key that changes nothing settles too: the script always goes on to the next key. Its hash is the settled plane, as for `wait still` (which still needs a flush and is unchanged for other scripts).

`wait playlist any` holds once any playlist starts after the previous step: a `BD_EVENT_PLAYLIST` in the harness (`bdj_trace.c`), a `chapters` event in our replay (`tests/bdj/key-script.ts`, `replay-player.ts`). `wait title any` works the same in the harness.

## RunRecord

One run of the script on one disc by one side (`classify.ts`):

| field | meaning |
|---|---|
| `side` | `ours` or `libbluray` |
| `end` | `done` (the script and its tail ran), `timeout` (a step's wait did not hold in 60 s; that step is the first one missing from `steps`), `limit` (the run reached 140 s), `bdj-failed` (our player gave up on BD-J), `error` (player or harness failure), `killed` (the 150 s kill), `no-output` (the process left no record) |
| `endDetail` | why it failed (a message, paths scrubbed) or null |
| `steps` | each step that ran: `n`, `step` (its text), `hash` for `wait menu` and `wait still` steps (the settled plane: the last flush before the step), `animated` for a `wait menu` step that held on an animated menu (no hash), and `calls`: how many control calls the run had made before the step ran |
| `calls` | the control calls (`tests/bdj/format.ts` `CONTROL_CALLS`) in order, through the run's tail (libbluray: up to the script's end line) |
| `endHash`, `flushes` | the last flushed plane, and the number of flushes |
| `missingClasses` | class-library gaps (Task 2's work): platform classes Java could not load (every `NoClassDefFoundError`, and every `ClassNotFoundException` of a platform class: `java.`, `javax.`, `sun.`, `org.dvb.`, ...; not `org.videolan.` probes, nor a disc's own obfuscated classes such as `org.w3c.dom.a`), missing natives (`UnsatisfiedLinkError`, as `native: <name>`) and methods missing from platform classes (`NoSuchMethodError`, as `method: <name>`). Ours catches them where the throwable is made (Java often swallows them); both sides also read them from the log (`gapOf`) |
| `caughtGaps` | entries of `missingClasses` whose every `ClassNotFoundException` died inside platform code (Ruling R13, `gaps.ts`): each gap throwable is followed as the interpreter unwinds it (`setUnwindObserver`), and it is exempt (`gapExempt`) only if it never unwound into a method of a class from the disc nor ended its thread, however often platform code caught and rethrew it. A designed lookup, such as `java.net.URL` asking for a protocol handler and carrying on without one. Not counted (`countedGaps`); listed apart in `summary.md` |
| `rejectedPlaylists` | `selectPlaylistN` calls that returned 0, with the playlist's first video codec from its `.mpls` |
| `wallMs` | the run's wall time |

`results/<id>.json` holds `{ id, fingerprint, oursStamp, libStamp, ours, lib, verdict, detail, checkedAt, video }` (`video`: `real` when the menu's clips were copied, otherwise `stub`).

## How a disc is judged

`progress(run)` says what a run achieved:

- menu: a settled plane (any `wait menu` or `wait still` step, or the end plane) is not the empty plane (`EMPTY_PLANE_HASH`), or the `wait menu` step held on an animated menu.
- arrows: a real change: the settled plane after `key right` differs from the one before, or the one after `key down` from the one after `key right`, both steps with a settled plane and one of the two visible. After an animated `wait menu` step (no settled plane), only the second (step 2 to 4) can count.
- ok: after `key ok`, a `selectTitleN`, a successful `selectPlaylistN` of a playlist other than the last one before it, or a `seekN` (a menu that plays its feature from a chapter of the playlist behind it).

`compareRuns(ours, lib)` compares the runs step by step:

- Up to `key ok`, for each step both ran: the set of distinct starting calls made since the step before (`selectPlaylistN` of a playlist ≥ 0 that succeeded, `selectTitleN`, `seekN`; Ruling R3), then the step's settled hash (not for an `animated` step, on either side). Only starting calls, and as a set, because everything else (register writes, rates, UO masks, key interest) and the number of times a menu loops its background playlist move with the stub streams' timing, which differs between the two sides.
- After `key ok`, where the disc plays and the two sides loop at their own pace: the first call that starts something (`selectTitleN`, `selectPlaylistN`, `seekN`).
- When both stopped at the same step before `key ok`: the starting calls since that step, then the plane each ended on, unless both timed out on the same `wait quiet` step: a wait quiet holds after 1000 ms without a flush, so the plane kept flushing to the end on both sides (an animated menu), and two frames of an animation are no difference. A `wait menu` timeout held nothing visible, and its planes are compared.
- When libbluray stopped first: it must agree on every step both ran, and the starting calls it made after its last step must be among ours up to our next step; then its run is a prefix of ours (`libPrefix`).

`classify(ours, lib)` gives the first verdict that applies:

1. error: our run failed hard (`bdj-failed`, `error`, `killed`, `no-output`), with the reason, so nothing hides it.
2. works (Rulings R3, R5, R6): ours showed a visible menu and agrees with libbluray on every step both ran (settled planes and starting calls): the runs are equal (`same as libbluray`), or libbluray stopped at an earlier step (stub streams) and its run is a prefix of ours (`libbluray stopped early (stub): ...`). A key that changed nothing on both sides is a valid outcome, noted `no reaction to <key> (libbluray neither)` (`noReaction`); arrows and ok are required only as far as libbluray's run shows them, because a reaction on one side only is a difference. Every key step must also be confirmed (R6): compared with libbluray (equal, including neither reacting), or, where libbluray never got that far, one ours reacted to (the arrow changed the plane, ok started something). Without a libbluray run, ours alone decides: menu, arrows and ok (`not compared`).
   - unconfirmed (R6): as works, but a key step was never compared and ours did not react there, or a key was never tried (`unconfirmedKeys`, for example both runs timing out at step 2 on a menu that keeps repainting). `summary.md` lists these ids with the reason, for a check by hand.
3. missing-class: a class-library gap (the first one named, `caughtGaps` left out), whatever libbluray did: libbluray never lacks a JDK class. When libbluray failed too, the detail adds `libbluray (stub) also: ...`.
4. unsupported-video: ours refused a playlist with MPEG-2 or VC-1 video (the same).
5. libbluray-fails-too: libbluray failed on its own (`libFailed`: its run ended in an error, a crash or no output, or it never selected a playlist, or never showed a visible plane), and ours showed no menu either.
6. stall: ours never showed a menu, or stopped at an earlier step than libbluray while agreeing on every step both ran (a difference at a common step, such as libbluray starting something after ok where ours does not, is diverges).
7. diverges: otherwise, with the first difference: a key one side reacted to and the other did not, another settled plane, other starting calls, or a libbluray run that never selects a playlist where ours does.

The settled-point rule is 5d's R3: settled hashes and calls, not flush counts. Stub streams make libbluray do less than it does with real video (one disc selects its menu playlist and draws nothing), which is why libbluray falling short is reported as such and never as ours.

## What's inside

- `sync.ts`, `check.ts`: the commands above.
- `classify.ts`: `RunRecord`, `discId`, `gapOf`, `parseLibblurayRun`, `missingClassesFromLog`, `progress`, `compareRuns`, `libFailed`, `classify`. No disc, file or process access.
- `gaps.ts`: `trackGaps`, the gap throwables of our run and where they unwound (R13). `lib-run.ts`: `libRunArgs`, run.sh's arguments for an attempt.
- `video.ts`: `menuPlaylists`, `playlistClips`, `planVideo`, `parseVideoManifest`, `markReal` (real menu video).
- `generic.keys`: the script.
- `check.test.ts`: `classify` on made-up runs, `discId`, `parseLibblurayRun` and the script. `video.test.ts`: clip selection, the cap and the video record.

## Documentation

- The commands are listed in the Commands section of `CLAUDE.md`.
- Design: `docs/superpowers/specs/2026-10-18-m5e-bdj-library-coverage-design.md` §5, which also holds the rulings (R3 to R6 and the others) this README cites.
- The harness for libbluray's side: `tools/bdj-trace/README.md`. The live check that opens the discs left unconfirmed: `tools/devices/README.md`.
- libbluray: https://www.videolan.org/developers/libbluray.html
