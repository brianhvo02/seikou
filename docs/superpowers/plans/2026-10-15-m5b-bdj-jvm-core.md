# Milestone 5b: BD-J JVM Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript JVM that boots libbluray's unmodified BD-J Java stack and a disc's xlet in Node, against a recording host, and matches real libbluray's native-call trace up to the first playlist selection on the synthetic BD-J disc and both local BD-J discs.

**Architecture:** A non-recursive bytecode interpreter with explicit frame stacks and green threads (`src/engine/bdj/jvm/`), loading a trimmed OpenJDK 8 class library and libbluray's Java jars (built in Docker, committed in `src/bdj-classlib/`). Natives are TS functions in a table keyed by class, name and descriptor; libbluray's 37 natives forward to a `BdjHost`. `BdjRuntime` ports `bdj.c`. A patched libbluray in Docker (`tools/bdj-trace/`) produces the reference native-call traces.

**Tech Stack:** TypeScript (strict), Vitest 5, tsx; Docker with ubuntu 24.04, OpenJDK 8, meson, ant, libbluray `448f896`; DoppioJVM (MIT) as a porting reference for selected natives.

**Execution:** to be chosen by the user after review.

**Spec:** `docs/superpowers/specs/2026-10-15-m5b-bdj-jvm-core-design.md`. Evidence: `docs/superpowers/specs/2026-10-15-bdj-spike-findings.md`. Read both before starting.

## How port tasks are written

As in M3 and M4a, port tasks name the exact functions to translate; that source is the reference and is followed line by line. Interfaces, tests and acceptance checks are given in full. Original code (the interpreter, scheduler, VFS) is specified by its data structures, algorithms and tests.

- libbluray: `scripts/fetch-libbluray.sh` puts commit `448f896` in `.cache/libbluray`. Paths below are relative to `.cache/libbluray/src/libbluray/`.
- DoppioJVM: clone `https://github.com/plasma-umass/doppio` at the commit of its last push (2022-12-06; record the hash in `src/engine/NOTICE` in Task 10) into `.cache/doppio` (gitignored by `.cache/`). Only the files named in a task are ported; Doppio's architecture (callbacks, BrowserFS) is not.
- OpenJDK 8 sources for reference only (to read what a native must do): `jdk8u` on GitHub, `jdk/src/share/native/` and `hotspot/src/share/vm/prims/jvm.cpp`. Never copy HotSpot code; it is GPL without the Classpath Exception.

## Global Constraints

- `src/engine/` stays LGPL-2.1-or-later with the SPDX/copyright header used by `src/engine/bdmv/mpls-parser.ts`; ported files list their source in `src/engine/NOTICE`. Doppio-derived functions name the Doppio file in a comment and in `NOTICE`, which reproduces Doppio's MIT notice.
- `src/engine/` must not import React, `src/ui/` or `src/player/`, and must not read files by path; jars arrive as bytes through `ClassLibrarySource`.
- No new runtime dependencies. Inflate is our own code. Node built-ins (`node:zlib`) may be used in tests only.
- TypeScript strict, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`; `readonly` interface fields; few comments, explaining why.
- Class files of versions 45 to 52 are accepted; above 52 is `UnsupportedClassVersionError`.
- Green threads only: one JS thread, time slice 10,000 bytecodes, round-robin, priorities ignored.
- Maximum Java frame depth per thread: 4,000 (then `StackOverflowError`), standing in for `-Xss2048k`.
- `long` is `bigint`, always normalised with `BigInt.asIntN(64, x)`; `int` is a JS number normalised with `| 0`; `float` with `Math.fround`.
- Boot class path order: `libbluray-j2se.jar`, `libbluray-awt-j2se.jar`, `rt-bdj.jar`.
- File system mounts: `/disc/` (read-only, `ByteSource`), `/tmp/` (memory; `java.io.tmpdir`), `/persistent/` (memory), `/buda/` (memory), `/jdk/` (read-only, `rt-bdj.jar`'s `lib/`; `java.home`).
- Stub font metrics: glyph advance 0.6 em, ascent 0.8 em, descent 0.2 em; nothing drawn.
- Trace entries are JSONL objects `{"call": <JNI name without Java_org_videolan_Libbluray_>, "args": [...], "ret": ...}` with `long` values as decimal strings.
- Control calls compared in order and by value: `selectTitleN`, `selectPlaylistN`, `seekN`, `selectAngleN`, `selectRateN`, `writeRegN`, `setUOMaskN`, `setKeyInterestN`, `soundEffectN`, `setVirtualPackageN`. All other calls are diagnostic.
- Docker images: ubuntu 24.04 pinned by digest `534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55` (as `tools/vm-trace`), `--platform linux/amd64`, apt packages from Ubuntu snapshot `20261015T000000Z` so OpenJDK 8's version is fixed.
- The player's behaviour does not change in 5b. Every existing test keeps passing.
- Do not edit `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`, `docs/known-issues.md` or `CLAUDE.md` until Task 17 (which waits for M4b on main).

### Deviations from the spec (decided while planning)

1. **`/tmp/` instead of `/cache/`, plus `/buda/`.** `Libbluray.init` takes (native pointer, disc ID, disc root, persistent root, BUDA root); there is no cache-root argument. libbluray's `CacheDir` puts its cache under `java.io.tmpdir`. The VFS mounts `/tmp/` for that and `/buda/` for the BUDA root.
2. **Disc ID.** libbluray passes `"00000000000000000000000000000000"` when AACS gives no disc ID (`_bdj_init`); so do we.
3. **Natives can call back into Java.** `AccessController.doPrivileged`, `Method.invoke`, `Class.forName` with initialisation and others run Java code from inside a native. Natives return an `Invoke` result that the interpreter turns into a frame push with a continuation, so the interpreter stays non-recursive.
4. **A `Jvm` object** (`bdj/jvm/jvm.ts`) ties loader, heap, threads, natives and VFS together; the spec's units hang off it.
5. **Inflate is a generator** (`function*`) so `java.util.zip.Inflater` can feed it input in chunks, as the JDK does.

## Review Focus

1. **Disc file names in any case.** `FileSource` keys are upper-case (`BDMV/JAR/00000.JAR`) while Java asks for `BDMV/JAR/00000.jar` and lists directories expecting the disc's spelling. Lookups must be case-insensitive and listings must return the names Java expects. Task 9 has a test.
2. **Deep recursion in disc code.** A recursive xlet method must end in `StackOverflowError` that Java can catch, never a JS `RangeError` or a frozen tab. Task 7 has a test.
3. **An xlet thread that spins or deadlocks.** A busy loop must not starve other threads, a deadlocked pair must not make `run()` hang, and `stop()` must return within its timeout. Task 8 has a test.
4. **Exceptions in class initialisers.** A failing `<clinit>` gives `ExceptionInInitializerError` once and `NoClassDefFoundError` on every later use, and does not take down the runtime. Task 7 has a test.
5. **JVM arithmetic edge cases.** `Integer.MIN_VALUE / -1`, division by zero, `f2i`/`d2l` of NaN and out-of-range values, shifts by 32 or more, `lushr` on negatives, `fcmpl` vs `fcmpg` with NaN. Task 4's `Arith` conformance program prints all of them; Task 7's tests run it.

---

## File map

| File | Status | Task |
|---|---|---|
| `tools/bdj-trace/{Dockerfile,build.sh,run.sh,trace.patch,bdj_trace.c,README.md}` | create | 1 |
| `tools/bdj-classlib/{Dockerfile,build.sh,collect.sh,make-jar.py,resources.txt}`, `src/bdj-classlib/*`, `tests/bdj/natives.txt`, `.github/workflows/bdj-classlib.yml` | create | 2 |
| `tests/bdj/xlets/**`, `scripts/make-bdj-disc.ts`, `fixtures/synthetic/disc-bdj/**`, `tests/helpers/bdjo-builder.ts`, `tests/bdj/golden/disc-bdj.jsonl`, `tools/bdj-trace/golden.sh`, `.github/workflows/bdj-trace.yml`, `package.json` | create / modify | 3 |
| `tests/bdj/conformance/*.java`, `tests/bdj/conformance/*.out`, `tests/bdj/conformance.jar` | create | 4 |
| `src/engine/bdmv/bdjo-parser.ts` | create | 5 |
| `src/engine/bdj/jvm/zip.ts` | create | 6 |
| `src/engine/bdj/jvm/classfile.ts` | create | 6 |
| `src/engine/bdj/jvm/{jvm,loader,heap,interpreter,values}.ts` | create | 7 |
| `src/engine/bdj/jvm/threads.ts` | create | 8 |
| `src/engine/bdj/jvm/vfs.ts` | create | 9 |
| `src/engine/bdj/jvm/natives/{index,lang,reflect,unsafe,misc}.ts` | create | 10 |
| `src/engine/bdj/jvm/natives/invoke.ts` | create | 11 |
| `src/engine/bdj/jvm/natives/{io,zip,security,net,awt}.ts` | create | 12 |
| `src/engine/bdj/host.ts`, `src/engine/bdj/jvm/natives/libbluray.ts`, `src/engine/bdj/errors.ts` | create | 13 |
| `src/engine/bdj/runtime.ts` | create | 14 |
| `tests/bdj/{compare,format,replay}.ts`, `tests/bdj/bdj-trace.test.ts` | create | 15 |
| `tests/bdj/run.ts`, `tests/local/bdj-boot.test.ts` | create | 16 |
| `src/engine/NOTICE`, `CLAUDE.md`, `docs/known-issues.md`, parent spec, `vitest.config.ts` | modify | 7, 10, 17 |

---

### Task 1: libbluray BD-J trace harness

**Files:**
- Create: `tools/bdj-trace/Dockerfile`, `build.sh`, `run.sh`, `trace.patch`, `bdj_trace.c`, `README.md`
- Modify: `.gitignore` (add `tools/bdj-trace/out/`), `package.json` (scripts `bdj-trace:build`)

**Interfaces:**
- Produces: `tools/bdj-trace/run.sh <disc> [--until <call>] [--seconds N] [--jvm-option OPT]...` printing JSONL trace entries (Global Constraints format) to stdout, libbluray's log to stderr. `--jvm-option` is passed through `JAVA_TOOL_OPTIONS` (used by Task 2 for `-verbose:class` / `-verbose:jni`; that output goes to stderr).

- [ ] **Step 1: Dockerfile.** Base on the pinned ubuntu digest with `--platform linux/amd64`. Point apt at snapshot `20261015T000000Z` (`echo 'APT::Snapshot "20261015T000000Z";' > /etc/apt/apt.conf.d/50snapshot`). Install `build-essential meson ninja-build pkg-config git ca-certificates python3 patch openjdk-8-jdk-headless ant libfreetype-dev`. Clone libbluray at `448f896` with submodules, apply `trace.patch`, then:

```sh
JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64 meson setup build --buildtype=release -Dwrap_mode=nodownload \
  -Denable_tools=false -Denable_examples=false -Denable_devtools=false -Denable_docs=false \
  -Dbdj_jar=enabled -Dfreetype=enabled -Dfontconfig=disabled -Dlibxml2=disabled
ninja -C build && ninja -C build install && ldconfig
gcc -O1 -Wall -Wextra -Werror -o /usr/local/bin/bdj_trace /src/bdj_trace.c $(pkg-config --cflags --libs libbluray)
```

Set `ENV JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64 LIBBLURAY_CP=/usr/local/share/java/`. (On amd64, libbluray finds `jre/lib/amd64/server/libjvm.so` itself; the spike's arm64 symlink is not needed.)

- [ ] **Step 2: `trace.patch`.** Only `src/libbluray/bdj/native/org_videolan_Libbluray.c` changes. Add at the top:

```c
/* bdj-trace: one JSONL line per native call */
#include <stdio.h>
static void _trace(const char *call, const char *args, const char *ret)
{
    printf("{\"call\":\"%s\",\"args\":[%s],\"ret\":%s}\n", call, args, ret);
    fflush(stdout);
}
```

In each of the 20 `Java_org_videolan_Libbluray_*` functions, compute the result into a local, then call `_trace` with the arguments (excluding `np`) and the result before returning. Formats: ints with `%d`, `jlong` as a quoted decimal string (`"\"%lld\""`), booleans as `true`/`false`, strings JSON-escaped (write a 20-line `_json_str` helper that escapes `"`, `\` and control characters), arrays and objects as `null` when null and otherwise as their length (`getTitleInfosN` → number of titles, `listBdFilesN` → number of names, `getBdjoN` → `1`, `getAacsDataN` → length, `getPlaylistInfoN` → playlist number or `null`), `void` as `null`. `updateGraphicN` traces `width`, `height`, `x0`, `y0`, `x1`, `y1` and whether `rgbArray` was null. Also trace `Java_org_videolan_Logger_logN` in `org_videolan_Logger.c` as `{"call":"logN","args":[file,line,msg],"ret":null}` (same patch, second file).

- [ ] **Step 3: `bdj_trace.c`.** Adapt the spike harness (`docs/superpowers/specs/2026-10-15-bdj-spike-findings.md` describes it): `bd_open`, register an ARGB overlay callback that does nothing, set country `us` and audio/PG/menu language `eng`, `bd_play`, then loop `bd_read_ext` reading no faster than real time (stream time from `bd_tell_time` vs wall time since the last `BD_EVENT_PLAYLIST`), sleeping 40 ms on 0 bytes. It takes `--seconds N` (default 60) and stops after that time. The `--until` option is implemented in the patch: `_trace` checks `getenv("BDJ_TRACE_UNTIL")` and, when `call` equals it, prints the line and calls `_exit(0)`. Events are not printed (this trace is native calls only).

- [ ] **Step 4: `build.sh` and `run.sh`.** `build.sh` mirrors `tools/vm-trace/build.sh` (`docker build --platform linux/amd64 -t bluray-web-bdj-trace`). `run.sh` mirrors `tools/vm-trace/run.sh`: `<disc>` is a name under `fixtures/synthetic` or a path; it mounts the disc read-only at `/disc` and runs `bdj_trace /disc`, passing `-e JAVA_TOOL_OPTIONS` built from `--jvm-option` values and `-e BDJ_TRACE_UNTIL`. Add `"bdj-trace:build": "tools/bdj-trace/build.sh"` to `package.json`.

- [ ] **Step 5: Verify on a local disc.** Run:

```sh
npm run bdj-trace:build
tools/bdj-trace/run.sh fixtures/local/BDJ_DISC_A --until selectPlaylistN > /tmp/ane.jsonl
grep -E '"call":"(selectTitleN|selectPlaylistN)"' /tmp/ane.jsonl
```

Expected: a `selectTitleN` with `"args":[6]` and the last line a `selectPlaylistN` whose first argument is `833`. (If `fixtures/local` is absent, skip; Task 3 verifies on the synthetic disc.)

- [ ] **Step 6: README and commit.** `README.md` documents the files, the patch, the trace format and the options, in the style of `tools/vm-trace/README.md`.

```bash
git add tools/bdj-trace .gitignore package.json
git commit -m "test(bdj): libbluray BD-J native-call trace harness"
```

### Task 2: class library build and lists

**Files:**
- Create: `tools/bdj-classlib/Dockerfile`, `build.sh`, `collect.sh`, `make-jar.py`, `resources.txt`; `src/bdj-classlib/{rt-bdj.jar,libbluray-j2se.jar,libbluray-awt-j2se.jar,classes.txt,LICENSE,ASSEMBLY_EXCEPTION,NOTICE}`; `tests/bdj/natives.txt`; `.github/workflows/bdj-classlib.yml`
- Modify: `package.json` (`bdj-classlib:build`, `bdj-classlib:collect`)

**Interfaces:**
- Consumes: `tools/bdj-trace/run.sh` with `--jvm-option` (Task 1).
- Produces: `src/bdj-classlib/rt-bdj.jar` (sorted entries, fixed timestamps), the two libbluray jars, `classes.txt` (one binary class name per line, `java/lang/Object` form, sorted), `tests/bdj/natives.txt` (one `class.name(descriptor)` per line, `java/lang/Object.hashCode()I` form, sorted).

- [ ] **Step 1: Dockerfile.** Same base, snapshot and packages as Task 1 (it can `FROM bluray-web-bdj-trace`; do that, so libbluray's jars are the ones the trace harness uses). Add `zip` and `unzip`.

- [ ] **Step 2: `make-jar.py`.** Run with `python3 -I`. Arguments: output path, source jar or directory, a file of entry names. It writes a zip with entries sorted by name, every timestamp `1980-01-01 00:00:00`, `ZIP_DEFLATED` level 9, no extra fields, external attributes `0o644 << 16`. Also used to re-pack libbluray's two jars (all entries) so they are byte-reproducible.

- [ ] **Step 3: `resources.txt`.** The non-class entries of `rt-bdj.jar`, taken from `$JAVA_HOME/jre/`: `lib/currency.data`, `lib/tzdb.dat`, `lib/calendars.properties`, `lib/content-types.properties`, `lib/logging.properties`, `lib/net.properties`, `lib/security/java.security`, `lib/security/blacklist`, `lib/security/trusted.libraries`, `lib/security/cacerts`, `lib/flavormap.properties`, `lib/psfont.properties.ja`, `lib/psfontj2d.properties`, `lib/sound.properties`, `lib/meta-index`. `build.sh` stores them under `lib/` in the jar (the VFS serves them at `/jdk/lib/`). Add to this list whenever Task 10–12 tests show the JDK opening a missing `/jdk/` file.

- [ ] **Step 4: `collect.sh`.** For `fixtures/synthetic/disc-bdj` (once Task 3 exists) and every `fixtures/local/*` with a `BDMV/BDJO` directory, run `tools/bdj-trace/run.sh <disc> --until selectPlaylistN --jvm-option -verbose:class --jvm-option -verbose:jni` and collect stderr. From `[Loaded X from .../rt.jar]` lines take `X` (convert `.` to `/`), excluding names containing `$$Lambda$`, `LambdaForm$`, `$Proxy` or starting with `java/lang/invoke/LambdaForm$`; merge with the existing `classes.txt` (never remove names), sort, write. From `[Dynamic-linking native method C.m ... JNI]` and `[Registering JNI native method C.m]` lines take class and method; resolve each to its descriptor with `javap -s -p` inside the image; exclude `org/videolan/*`, `java/awt/BDFontMetrics.*`, `java/awt/BDGraphicsBase.*` and libbluray's `java/io/FileInputStream` natives (those are Task 13's table); merge, sort, write `tests/bdj/natives.txt`. Add `"bdj-classlib:collect": "tools/bdj-classlib/collect.sh"`.

- [ ] **Step 5: `build.sh`.** In the image: re-pack `/usr/local/share/java/libbluray-j2se-1.5.1.jar` and `libbluray-awt-j2se-1.5.1.jar` to `src/bdj-classlib/libbluray-j2se.jar` and `libbluray-awt-j2se.jar`; write `rt-bdj.jar` from `$JAVA_HOME/jre/lib/rt.jar` with the classes in `classes.txt` plus every nested class of each listed class (`X$*.class`; the JDK loads them lazily and runs differ), plus `resources.txt`; copy `$JAVA_HOME/jre/../LICENSE`-equivalent files from `/usr/share/doc/openjdk-8-jre-headless/copyright` into `LICENSE` and the Classpath Exception text into `ASSEMBLY_EXCEPTION` (extract both from the copyright file: the GPLv2 text and the "CLASSPATH" exception paragraph); write `NOTICE` with the OpenJDK package version (`dpkg-query -W openjdk-8-jre-headless`), the libbluray commit and the snapshot date. Add `"bdj-classlib:build": "tools/bdj-classlib/build.sh"`.

- [ ] **Step 6: Seed and build.** The first `classes.txt` comes from the local discs (no synthetic BD-J disc yet). Run `npm run bdj-trace:build && npm run bdj-classlib:collect && npm run bdj-classlib:build`. Expected: `wc -l src/bdj-classlib/classes.txt` about 1,500; `wc -l tests/bdj/natives.txt` between 150 and 300; `rt-bdj.jar` a few MB. Run `npm run bdj-classlib:build` a second time and `git status --porcelain src/bdj-classlib` shows nothing changed (reproducible).

- [ ] **Step 7: CI workflow.** `.github/workflows/bdj-classlib.yml`, modelled on `wasm.yml`, on `tools/bdj-classlib/**`, `tools/bdj-trace/**` and `src/bdj-classlib/**`: `npm run bdj-trace:build && npm run bdj-classlib:build && git diff --exit-code src/bdj-classlib/`.

- [ ] **Step 8: Commit.**

```bash
git add tools/bdj-classlib src/bdj-classlib tests/bdj/natives.txt .github/workflows/bdj-classlib.yml package.json
git commit -m "build(bdj): trimmed OpenJDK 8 class library and libbluray Java stack"
```

### Task 3: synthetic BD-J disc and its golden trace

**Files:**
- Create: `tests/bdj/xlets/src/bdjweb/test/FirstPlayXlet.java`, `TitleXlet.java`, `tests/bdj/xlets/00000.jar`, `tests/helpers/bdjo-builder.ts`, `scripts/make-bdj-disc.ts`, `fixtures/synthetic/disc-bdj/**`, `tools/bdj-trace/golden.sh`, `tests/bdj/golden/disc-bdj.jsonl`, `.github/workflows/bdj-trace.yml`
- Modify: `tools/bdj-classlib/build.sh` (compile the xlets), `package.json` (`fixture:synthetic`, `bdj-trace:golden`)

**Interfaces:**
- Produces: `buildBdjo(spec: BdjoSpec): Uint8Array<ArrayBuffer>` in `tests/helpers/bdjo-builder.ts`:

```ts
export interface BdjoAppSpec {
  readonly controlCode: 1 | 2; // 1 autostart, 2 present
  readonly orgId: number;
  readonly appId: number;
  readonly name: string;
  readonly baseDir: string; // "00000"
  readonly classpathExtension?: string;
  readonly initialClass: string;
  readonly params?: readonly string[];
}
export interface BdjoSpec {
  readonly version?: '0100' | '0200' | '0300';
  readonly jars: readonly string[]; // app cache items, type 1 (JAR), lang "*.*"
  readonly accessToAll?: boolean; // default true, num_pl 0
  readonly playlists?: readonly string[];
  readonly autostartFirstPlaylist?: boolean;
  readonly apps: readonly BdjoAppSpec[];
  readonly keyInterest?: number; // 32-bit key interest table, top 11 bits used
  readonly fileAccess?: string; // default "."
}
```

The layout is the inverse of `bdj/bdjo_parse.c` (`_parse_header` with the section start addresses as in the hex dumps in the findings, `_parse_terminal_info`, `_parse_app_cache_info`, `_parse_accessible_playlists`, `_parse_app_management_table`/`_parse_bdjo_app`, `_parse_key_interest_table`, `_parse_file_access_info`). Profile descriptor: one profile `{profile_number: 2, major 1, minor 0, micro 0}`; `priority 1`, `binding 3`, `visibility 1`; default font `*****`; `initial_havi_config_id` 6 (1920x1080).

- [ ] **Step 1: The xlets.** Java 1.3-compatible source (no generics), `package bdjweb.test`, implementing `javax.tv.xlet.Xlet`. `FirstPlayXlet.startXlet` does, in order, through the public BD-J APIs (`org.bluray.ti`, `org.dvb.*`, `org.bluray.system.RegisterAccess`, `org.bluray.ui.event.HRcEvent` key interest via `org.havi.ui.event`/`UserEventRepository`, `org.bluray.ti.selection.TitleContext`):
  1. `RegisterAccess.getInstance().getPSR(4)` and `getPSR(20)` (reads, diagnostic only);
  2. `RegisterAccess.getInstance().setGPR(100, 42)`;
  3. register a `UserEventRepository` with `HRcEvent.VK_ENTER` and `VK_UP` through `EventManager.getInstance().addUserEventListener` (this is what makes libbluray call `setKeyInterestN`; confirm by running the harness);
  4. `TitleContext`'s `start(TitleManager.getInstance().getTitle(1), true)` via `ServiceContextFactory` to select title 1.

  `TitleXlet.startXlet` creates a JMF player for `bd://PLAYLIST:00000` (`Manager.createPlayer(new MediaLocator("bd://PLAYLIST:00000"))`) and starts it, which calls `selectPlaylistN`. Both xlets print one line through `System.out` at start. If any of these APIs does not reach the expected native in the libbluray trace, replace it with the API libbluray's own `bdj/java` code maps to that native (read `org/videolan/Libbluray.java` callers), and note the change in the xlet's header comment.

- [ ] **Step 2: Compile in the class-library image.** Extend `tools/bdj-classlib/build.sh`: `javac -source 1.3 -target 1.3 -bootclasspath <libbluray jars>:$JAVA_HOME/jre/lib/rt.jar -d /tmp/xlets tests/bdj/xlets/src/...` (JDK 8's `javac` accepts 1.3 with an "obsolete" warning; class version 47, as the local discs' apps), then `make-jar.py` it to `tests/bdj/xlets/00000.jar`.

- [ ] **Step 3: Write the BDJO builder.** `tests/helpers/bdjo-builder.ts`, following the layout above. The script needs it now; its round-trip test is Task 5's parser test, and the harness run in Step 5 is its first check (libbluray must accept the file: an error from `bdjo_parse` shows on stderr).

- [ ] **Step 4: `scripts/make-bdj-disc.ts`.** Like `scripts/make-vm-disc.ts`: `buildSyntheticDisc` with one 2-second clip `00000` and playlist `00000`, then replace `BDMV/index.bdmv` with `buildIndex({ firstPlay: { kind: 'bdj', name: '00000' }, topMenu: { kind: 'bdj', name: '00000' }, titles: [{ kind: 'bdj', name: '00001' }] })`, add `BDMV/BDJO/00000.bdjo` (app `FirstPlayXlet`, org `0x7fff0001`, app `0x4001`), `BDMV/BDJO/00001.bdjo` (app `TitleXlet`, app `0x4002`), `BDMV/JAR/00000.jar` (bytes of `tests/bdj/xlets/00000.jar`), and an empty `CERTIFICATE/app.discroot.crt` and `CERTIFICATE/bu.discroot.crt` (libbluray tolerates empty ones; confirm with the harness). Write with `writeFixture`. Append `&& tsx scripts/make-bdj-disc.ts fixtures/synthetic/disc-bdj` to `fixture:synthetic`.

- [ ] **Step 5: Golden trace.** `tools/bdj-trace/golden.sh` runs `run.sh disc-bdj --until selectPlaylistN > tests/bdj/golden/disc-bdj.jsonl`, then filters out `logN` lines (their text includes timing). Add `"bdj-trace:golden": "tools/bdj-trace/golden.sh"`. Run `npm run fixture:synthetic && npm run bdj-trace:golden`. Expected: the file contains, among diagnostic reads, `writeRegN` with `[0,100,42,...]`, `setKeyInterestN`, `selectTitleN` `[1]`, and ends with `selectPlaylistN` whose first argument is `0`. Run `bdj-trace:golden` twice; the control calls are identical both times (diagnostic reads may differ in count; if the whole file differs between runs, filter diagnostic calls in `golden.sh` too and record that in the README).

- [ ] **Step 6: Re-collect classes.** `npm run bdj-classlib:collect && npm run bdj-classlib:build` (now including the synthetic disc).

- [ ] **Step 7: CI workflow.** `.github/workflows/bdj-trace.yml`, modelled on `vm-trace.yml`, on `tools/bdj-trace/**`, `scripts/make-bdj-disc.ts`, `fixtures/synthetic/disc-bdj/**`, `tests/bdj/xlets/**`, `tests/bdj/golden/**`, `tests/helpers/bdjo-builder.ts`: `npm run bdj-trace:build && npm run bdj-trace:golden && git diff --exit-code tests/bdj/golden/`.

- [ ] **Step 8: Commit.**

```bash
git add tests/bdj/xlets tests/helpers/bdjo-builder.ts scripts/make-bdj-disc.ts fixtures/synthetic/disc-bdj tools/bdj-trace tools/bdj-classlib tests/bdj/golden .github/workflows/bdj-trace.yml package.json src/bdj-classlib tests/bdj/natives.txt
git commit -m "test(bdj): synthetic BD-J disc and libbluray golden trace"
```

### Task 4: JVM conformance programs

**Files:**
- Create: `tests/bdj/conformance/{Bare,Arith,Arrays,Exceptions,Init,Threads,Strings,Collections,Reflect,Lambdas,Zip,Io,Recursion}.java`, their `.out` files, `tests/bdj/conformance.jar`
- Modify: `tools/bdj-classlib/build.sh`

**Interfaces:**
- Produces: `tests/bdj/conformance.jar` (classes in package `conformance`), and `tests/bdj/conformance/<Name>.out` (HotSpot's stdout of `java -cp conformance.jar conformance.<Name>`). `Bare` has no `main`; it has `public static int` methods taking no arguments, used before the JDK can boot (Task 7).

- [ ] **Step 1: Write the programs.** Each `main` prints one result per line with a label, e.g. `System.out.println("idiv-min " + (Integer.MIN_VALUE / -1));`. Contents:
  - `Bare`: `sum()` (loop 1..100, returns 5050), `fib()` (recursive fib(20) = 6765), `arrays()` (int[] fill and sum, returns 45), `longs()` (returns `(int) ((1L << 40) / 3 % 1000)` = 25), `fields()` (static and instance fields, returns 7), `virtual()` (two subclasses overriding a method, returns 21), `iface()` (interface dispatch, returns 3), `tableswitch()` and `lookupswitch()` (return 2 and 30), `catches()` (throws and catches a user exception subclass of `RuntimeException`, returns 1; needs `Throwable`'s constructor, see Task 7). No `String` use.
  - `Arith`: every Review Focus item 5 case, plus `Long.MIN_VALUE / -1`, `%` with negatives, `(int) 3.9e10f`, `(long) Double.NaN`, `(int) -0.0`, `1 << 33`, `-1 >>> 28`, `-1L >>> 60`, `Float.compare(NaN, 1)`, `0.1f + 0.2f`, `Math.round(-2.5)`, `Double.toString(1e21)`, `Float.toString(1.0e-5f)`, `Integer.toHexString(-1)`, `Long.parseLong("-9223372036854775808")`, `(char) -1` as int, `(byte) 200`, `(short) 70000`, `StrictMath.sin(1.0)`, `StrictMath.exp(1.0)`, `Math.sqrt(2.0)`.
  - `Arrays`: multi-dimensional `new int[3][4][5]`, `System.arraycopy` overlapping, `ArrayStoreException`, `ArrayIndexOutOfBoundsException` message, `NegativeArraySizeException`, `clone()`, `java.util.Arrays.sort` on ints and objects.
  - `Exceptions`: try/catch/finally ordering, return inside finally, rethrow, nested, `getStackTrace()[0].getMethodName()`, `printStackTrace` to a `StringWriter` (first line only), `NullPointerException` from a field read, a `ClassCastException` message.
  - `Init`: a class whose `<clinit>` throws: first access prints `ExceptionInInitializerError`, second prints `NoClassDefFoundError` (Review Focus 4); initialisation order of a superclass and an interface with a non-constant field.
  - `Threads`: two threads incrementing a shared counter 10,000 times each under `synchronized` (prints 20000), `wait`/`notify` handshake, `join`, `interrupt` of a sleeping thread (prints `InterruptedException`), `Thread.currentThread().getName()` of `main`, a `java.util.concurrent.CountDownLatch` and `ExecutorService` with two tasks, a daemon thread left running at exit.
  - `Strings`: `StringBuilder`, `String.format("%5.2f|%x|%s", ...)`, `intern()` identity, `hashCode()` of a long string, `split` with a regex, `toUpperCase` of `ß`, UTF-8 encode/decode of `"日本語"` byte counts, `String.valueOf(char[])`.
  - `Collections`: `HashMap` iteration of 100 Integer keys (sorted before printing), `TreeMap`, `ArrayList`/`LinkedList`/`Vector`/`Hashtable` basics, `Collections.sort` with a comparator, `Properties.load` from a `StringReader`.
  - `Reflect`: `Class.forName`, `getDeclaredMethods()` names sorted, `Method.invoke`, `Constructor.newInstance`, `Field.set` on a private field after `setAccessible`, `java.lang.reflect.Proxy` for an interface, array `Class` names.
  - `Lambdas`: a `Runnable` lambda, a `Function` method reference, `stream().map().filter().collect()`, a capturing lambda, a default method, `String.join`.
  - `Zip`: write a zip into a `ByteArrayOutputStream` with `ZipOutputStream` (one stored, one deflated entry), read it back with `ZipInputStream`, print names and contents; `CRC32` of a known string; `Inflater`/`Deflater` round trip of 100 KB of patterned bytes.
  - `Io`: in `java.io.tmpdir`: create a directory, write a file with `FileOutputStream`, read it with `FileInputStream` and `RandomAccessFile` (seek), `File.list()` sorted, `length()`, `delete()`, `renameTo`, `exists()`; `BufferedReader` over `InputStreamReader` UTF-8.
  - `Recursion`: recurse until `StackOverflowError`, catch it, print `caught` (Review Focus 2); then recurse 1,000 deep and print the depth.

- [ ] **Step 2: Build in Docker.** Extend `tools/bdj-classlib/build.sh`: `javac -source 1.8 -target 1.8 -d /tmp/conf tests/bdj/conformance/*.java`, `make-jar.py` to `tests/bdj/conformance.jar`, then for each class with `main`, `java -Xint -cp tests/bdj/conformance.jar conformance.<Name> > tests/bdj/conformance/<Name>.out`. `Threads` and `Collections` must print only deterministic values (sort before printing; no timing). Run the build twice; the `.out` files must not change.

- [ ] **Step 3: Commit.**

```bash
git add tests/bdj/conformance tests/bdj/conformance.jar tools/bdj-classlib/build.sh
git commit -m "test(bdj): JVM conformance programs with HotSpot output"
```

### Task 5: BDJO parser

**Files:**
- Create: `src/engine/bdmv/bdjo-parser.ts`, `src/engine/bdmv/bdjo-parser.test.ts`
- Modify: `src/engine/NOTICE`

**Interfaces:**
- Consumes: `ByteReader`, `ParseError` (`src/engine/util/byte-reader.ts`), `checkVersion` (`bdmv/version.ts`), `buildBdjo` (Task 3).
- Produces:

```ts
export interface BdjoTerminalInfo { readonly defaultFont: string; readonly initialHaviConfigId: number; readonly menuCallMask: number; readonly titleSearchMask: number }
export interface BdjoAppCacheItem { readonly type: number; readonly refToName: string; readonly langCode: string }
export interface BdjoAccessiblePlaylists { readonly accessToAllFlag: number; readonly autostartFirstPlaylistFlag: number; readonly playlists: readonly string[] }
export interface BdjoAppProfile { readonly profileNumber: number; readonly majorVersion: number; readonly minorVersion: number; readonly microVersion: number }
export interface BdjoAppName { readonly lang: string; readonly name: string }
export interface BdjoApp {
  readonly controlCode: number; readonly type: number; readonly orgId: number; readonly appId: number;
  readonly profiles: readonly BdjoAppProfile[]; readonly priority: number; readonly binding: number; readonly visibility: number;
  readonly names: readonly BdjoAppName[]; readonly iconFlags: number; readonly iconLocator: string; readonly baseDir: string;
  readonly classpathExtension: string; readonly initialClass: string; readonly params: readonly string[];
}
export interface Bdjo {
  readonly version: string;
  readonly terminalInfo: BdjoTerminalInfo;
  readonly appCache: readonly BdjoAppCacheItem[];
  readonly accessiblePlaylists: BdjoAccessiblePlaylists;
  readonly apps: readonly BdjoApp[];
  readonly keyInterestTable: number; // the 32 bits as read; libbluray's bitfield order is bit 31 = vk_play
  readonly fileAccessInfo: string;
}
export function parseBdjo(bytes: Uint8Array): Bdjo;
```

- [ ] **Step 1: Failing tests.**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBdjo } from '../../../tests/helpers/bdjo-builder';
import { ParseError } from '../util/byte-reader';
import { parseBdjo } from './bdjo-parser';

describe('parseBdjo', () => {
  it('reads what the builder wrote', () => {
    const bdjo = parseBdjo(buildBdjo({
      jars: ['00000'],
      apps: [{ controlCode: 1, orgId: 0x7fff0001, appId: 0x4001, name: 'FirstPlayXlet', baseDir: '00000', classpathExtension: '/00001', initialClass: 'bdjweb.test.FirstPlayXlet', params: ['a', 'bc'] }],
      keyInterest: 0xc0000000,
    }));
    expect(bdjo.appCache).toEqual([{ type: 1, refToName: '00000', langCode: '*.*' }]);
    expect(bdjo.accessiblePlaylists).toEqual({ accessToAllFlag: 1, autostartFirstPlaylistFlag: 0, playlists: [] });
    expect(bdjo.apps[0]).toMatchObject({ controlCode: 1, orgId: 0x7fff0001, appId: 0x4001, baseDir: '00000', classpathExtension: '/00001', initialClass: 'bdjweb.test.FirstPlayXlet', params: ['a', 'bc'], names: [{ lang: 'eng', name: 'FirstPlayXlet' }] });
    expect(bdjo.keyInterestTable >>> 0).toBe(0xc0000000);
    expect(bdjo.fileAccessInfo).toBe('.');
  });

  it('reads playlist tables', () => {
    const bdjo = parseBdjo(buildBdjo({ jars: ['00000'], accessToAll: false, playlists: ['00001', '00800'], autostartFirstPlaylist: true, apps: [] }));
    expect(bdjo.accessiblePlaylists).toEqual({ accessToAllFlag: 0, autostartFirstPlaylistFlag: 1, playlists: ['00001', '00800'] });
  });

  it('rejects other signatures and truncated files', () => {
    const bytes = buildBdjo({ jars: [], apps: [] });
    const bad = bytes.slice(); bad[0] = 0x58;
    expect(() => parseBdjo(bad)).toThrow(ParseError);
    expect(() => parseBdjo(bytes.subarray(0, 40))).toThrow(ParseError);
  });

  it.skipIf(!existsSync('fixtures/local/BDJ_DISC_A/BDMV/BDJO/00000.bdjo'))('reads BDJ_DISC_A as the findings describe', () => {
    const bdjo = parseBdjo(readFileSync('fixtures/local/BDJ_DISC_A/BDMV/BDJO/00000.bdjo'));
    expect(bdjo.version).toBe('0300');
    expect(bdjo.appCache.map((c) => c.refToName)).toEqual(['00000', '55555', '44444']);
    expect(bdjo.accessiblePlaylists).toEqual({ accessToAllFlag: 1, autostartFirstPlaylistFlag: 0, playlists: [] });
    expect(bdjo.apps.map((a) => a.initialClass)).toEqual(['com.uni.radius.xlet.MenuXlet', 'com.uni.radius.TitleBoundXlet']);
    expect(bdjo.apps[0]!.classpathExtension).toBe('/55555;/44444');
  });
});
```

- [ ] **Step 2: Run, expect failure.** `npx vitest run src/engine/bdmv/bdjo-parser.test.ts` fails (module missing).

- [ ] **Step 3: Port.** From `bdj/bdjo_parse.c`: `_parse_header` (signature `BDJO`, `checkVersion('bdjo', version)` with the versions `bdmv_parse_header` accepts, then the start addresses), `_parse_terminal_info`, `_parse_app_cache_item`/`_parse_app_cache_info`, `_parse_accessible_playlists`, `_parse_app_profile`, `_count_app_strings`, `_parse_app_name`, `_parse_app_param`, `_read_app_string`, `_parse_bdjo_app`, `_parse_app_management_table`, `_parse_key_interest_table`, `_parse_file_access_info`. Strings are read as UTF-8 (`TextDecoder`) like `_read_string`. Every libbluray failure path (`bs_avail` checks, bad lengths) throws `ParseError` with `bdjo:` and the section name. Add the NOTICE line `bdmv/bdjo-parser.ts  from src/libbluray/bdj/bdjo_parse.c`.

- [ ] **Step 4: Run, expect pass**, plus `npm run typecheck`.

- [ ] **Step 5: Commit.** `git commit -m "feat(bdj): BDJO parser"` with the three files.

### Task 6: zip reader, inflate and class-file parser

**Files:**
- Create: `src/engine/bdj/jvm/zip.ts`, `zip.test.ts`, `classfile.ts`, `classfile.test.ts`

**Interfaces:**
- Produces (zip):

```ts
export interface ZipEntry { readonly name: string; readonly method: 0 | 8; readonly compressedSize: number; readonly size: number; readonly crc: number; readonly localHeaderOffset: number; readonly time: number }
export class ZipArchive {
  static open(bytes: Uint8Array): ZipArchive; // throws ZipError on a bad central directory
  readonly entries: ReadonlyMap<string, ZipEntry>; // central-directory order is kept in `names`
  readonly names: readonly string[];
  read(name: string): Uint8Array | null; // inflated bytes, CRC checked
  dataOffset(entry: ZipEntry): number; // start of the entry's compressed data
}
export class ZipError extends Error {}
/** Raw DEFLATE (RFC 1951). Yields when it needs more input; returns when the final block ends. */
export function inflateRaw(): InflateCoroutine;
export interface InflateCoroutine {
  push(input: Uint8Array): void;
  /** Writes up to out.length bytes; returns bytes written. */
  pull(out: Uint8Array, offset: number, length: number): number;
  readonly finished: boolean;
  readonly needsInput: boolean;
  /** Bytes of pushed input not consumed (valid after finished). */
  readonly remaining: number;
}
export function inflateAll(data: Uint8Array, expectedSize?: number): Uint8Array;
export function crc32(data: Uint8Array, start?: number, end?: number, seed?: number): number;
```

- Produces (classfile):

```ts
export type CpEntry =
  | { readonly tag: 'utf8'; readonly value: string }
  | { readonly tag: 'int'; readonly value: number } | { readonly tag: 'float'; readonly value: number }
  | { readonly tag: 'long'; readonly value: bigint } | { readonly tag: 'double'; readonly value: number }
  | { readonly tag: 'class'; readonly name: number } | { readonly tag: 'string'; readonly utf8: number }
  | { readonly tag: 'fieldref' | 'methodref' | 'imethodref'; readonly cls: number; readonly nat: number }
  | { readonly tag: 'nat'; readonly name: number; readonly desc: number }
  | { readonly tag: 'mhandle'; readonly kind: number; readonly ref: number }
  | { readonly tag: 'mtype'; readonly desc: number }
  | { readonly tag: 'indy'; readonly bsm: number; readonly nat: number }
  | null; // index 0 and the slot after long/double
export interface ExceptionHandler { readonly startPc: number; readonly endPc: number; readonly handlerPc: number; readonly catchType: number }
export interface CodeAttr { readonly maxStack: number; readonly maxLocals: number; readonly code: Uint8Array; readonly handlers: readonly ExceptionHandler[]; readonly lineNumbers: readonly (readonly [pc: number, line: number])[] }
export interface MemberInfo { readonly access: number; readonly name: string; readonly desc: string; readonly code: CodeAttr | null; readonly constantValue: number | null; readonly exceptions: readonly string[]; readonly signature: string | null }
export interface BootstrapMethod { readonly ref: number; readonly args: readonly number[] }
export interface ClassFile {
  readonly major: number; readonly minor: number; readonly cp: readonly CpEntry[];
  readonly access: number; readonly name: string; readonly superName: string | null; readonly interfaces: readonly string[];
  readonly fields: readonly MemberInfo[]; readonly methods: readonly MemberInfo[];
  readonly bootstrapMethods: readonly BootstrapMethod[]; readonly sourceFile: string | null;
  readonly innerClasses: readonly { readonly inner: string; readonly outer: string | null; readonly name: string | null; readonly access: number }[];
  readonly signature: string | null;
}
export class ClassFormatError extends Error {}
export class UnsupportedClassVersionError extends Error {}
export function parseClassFile(bytes: Uint8Array): ClassFile;
export function decodeModifiedUtf8(bytes: Uint8Array): string; // JVM spec §4.4.7
```

- [ ] **Step 1: Failing zip tests** (`zip.test.ts`): build zips with `node:zlib` (`deflateRawSync`) and a small writer in the test; check `ZipArchive.open(...).read(name)` for stored and deflated entries, `ZipError` on a truncated central directory, CRC mismatch rejected; `inflateAll` against `deflateRawSync` for 1 MB of random bytes, empty input, and level 0/1/9; `inflateRaw()` fed 1 byte at a time gives the same output; `crc32('123456789') === 0xcbf43926`; open each of the three `src/bdj-classlib/*.jar` and `tests/bdj/conformance.jar` and read every entry without error.

- [ ] **Step 2: Implement zip.** End-of-central-directory search from the end (max comment 65,535 bytes), central directory records, local header to find data offset. `inflateRaw` is a generator-based state machine: stored, fixed Huffman and dynamic Huffman blocks, a 32 KB window, an output queue `pull` drains; it yields when it needs bits it does not have. `crc32` is the table method.

- [ ] **Step 3: Failing class-file tests** (`classfile.test.ts`): every class in the four jars parses without throwing; `java/lang/Object.class` has methods including `hashCode()I` with the native flag `0x0100` and no code; `conformance/Bare.class` has `sum()I` with a `Code` attribute; `conformance/Lambdas.class` has `BootstrapMethods`; changing a test copy's major version to 53 throws `UnsupportedClassVersionError`; a truncated file throws `ClassFormatError`; `decodeModifiedUtf8` decodes `C0 80` as `\u0000` and a surrogate pair written as two 3-byte sequences.

- [ ] **Step 4: Implement classfile** per JVM spec §4 (tags 1, 3–12, 15, 16, 18). Unknown attributes are skipped.

- [ ] **Step 5: Run both test files, typecheck, commit:** `git commit -m "feat(bdj): zip, inflate and class-file parsing"`.

### Task 7: loader, heap and interpreter

**Files:**
- Create: `src/engine/bdj/jvm/values.ts`, `heap.ts`, `loader.ts`, `interpreter.ts`, `jvm.ts`, `interpreter.test.ts`, `tests/bdj/conformance.test.ts` (first part)
- Modify: `vitest.config.ts` (include `tests/bdj/**/*.test.ts`)

**Interfaces:**
- Produces (values/heap):

```ts
export type JValue = number | bigint | JObject | null; // int/short/byte/char/boolean/float/double: number; long: bigint
export interface JObject { readonly cls: JClass; readonly fields: JValue[]; monitor: Monitor | null; hash: number; nativeData: unknown }
export interface JArray extends JObject { readonly data: Int8Array | Uint16Array | Int16Array | Int32Array | Float32Array | Float64Array | BigInt64Array | (JObject | null)[] }
export class JavaThrowable extends Error { constructor(readonly obj: JObject) } // carries a Java exception through JS frames
export class Heap {
  constructor(jvm: Jvm);
  newObject(cls: JClass): JObject;
  newArray(cls: JClass, length: number): JArray; // cls is an array class
  newString(s: string): JObject; // java/lang/String with char[] value
  intern(s: string): JObject;
  jsString(str: JObject | null): string | null;
  identityHash(o: JObject): number;
}
```

- Produces (loader):

```ts
export type ClassState = 'loaded' | 'linked' | 'initializing' | 'initialized' | 'erroneous';
export interface JField { readonly cls: JClass; readonly name: string; readonly desc: string; readonly access: number; readonly slot: number; readonly isStatic: boolean }
export interface JMethod { readonly cls: JClass; readonly name: string; readonly desc: string; readonly access: number; readonly code: CodeAttr | null; readonly argSlots: number; readonly argTypes: readonly string[]; readonly returnType: string; vtableIndex: number }
export class JClass {
  readonly name: string; // 'java/lang/String', '[I', '[Ljava/lang/Object;'
  readonly file: ClassFile | null; // null for array and primitive classes
  readonly superClass: JClass | null; readonly interfaces: readonly JClass[];
  readonly loader: JObject | null; // null = bootstrap
  state: ClassState; initThread: JThread | null; initError: JObject | null;
  readonly instanceFields: readonly JField[]; readonly staticValues: JValue[];
  readonly vtable: JMethod[]; readonly methods: ReadonlyMap<string, JMethod>; // key name+desc
  mirror: JObject | null; // java/lang/Class instance
  readonly componentType: JClass | null; readonly isInterface: boolean;
  isSubclassOf(other: JClass): boolean; // assignability incl. interfaces and arrays
  findMethod(name: string, desc: string): JMethod | null; // class, then superclasses, then superinterfaces (JVM §5.4.3.3)
  findField(name: string, desc: string): JField | null;
}
export class ClassPath { constructor(jars: readonly ZipArchive[]); find(classFileName: string): Uint8Array | null; findResource(name: string): Uint8Array | null }
export class Loader {
  constructor(jvm: Jvm, bootPath: ClassPath);
  loadBoot(name: string): JClass | null; // bootstrap loading; null if absent
  define(name: string, bytes: Uint8Array, loader: JObject | null, protectionDomain: JObject | null): JClass;
  arrayOf(component: JClass): JClass;
  primitive(code: 'I' | 'J' | 'F' | 'D' | 'Z' | 'B' | 'C' | 'S' | 'V'): JClass;
}
```

- Produces (interpreter/jvm):

```ts
export interface Frame { readonly method: JMethod; pc: number; readonly locals: JValue[]; readonly stack: JValue[]; sp: number; then?: (ret: JValue | undefined, thrown: JObject | null) => NativeResult }
export type NativeResult = JValue | undefined | Suspend | Invoke | ThrowResult;
export class Suspend { constructor(readonly promise: Promise<JValue | undefined>) }
export class Invoke { constructor(readonly method: JMethod, readonly args: readonly JValue[], readonly then: (ret: JValue | undefined) => NativeResult) }
export class ThrowResult { constructor(readonly exception: JObject) }
export type ExitReason = 'budget' | 'blocked' | 'finished';
export function execute(jvm: Jvm, thread: JThread, budget: number): ExitReason;
export interface JvmOptions { readonly bootJars: readonly Uint8Array[]; readonly nowMs: () => number; readonly setTimer: (ms: number, fn: () => void) => () => void; readonly stdout: (s: string) => void; readonly stderr: (s: string) => void; readonly vfs?: Vfs; readonly systemProperties?: ReadonlyMap<string, string> }
export class Jvm {
  constructor(opts: JvmOptions);
  readonly heap: Heap; readonly loader: Loader; readonly threads: Scheduler; readonly natives: NativeTable;
  /** Runs a static method on a new Java thread to completion; rejects with the uncaught exception's toString(). */
  callStatic(cls: string, name: string, desc: string, args?: readonly JValue[]): Promise<JValue | undefined>;
  /** JDK startup: System.initializeSystemClass and the main thread group (Task 10). */
  boot(): Promise<void>;
  throwNew(cls: string, message?: string): ThrowResult;
}
```

`Scheduler`, `JThread`, `NativeTable` and `Vfs` are defined in Tasks 8, 10 and 9; in this task use a minimal `Scheduler` that runs one thread until it finishes, and a `NativeTable` with only the natives `Bare` needs (`java/lang/Object.registerNatives()V`, `java/lang/Object.<init>` has code, `java/lang/Object.hashCode()I`, `java/lang/Object.getClass()Ljava/lang/Class;`, `java/lang/Throwable.fillInStackTrace(I)Ljava/lang/Throwable;`, `java/lang/System.registerNatives()V`, `java/lang/Class.registerNatives()V`, `java/lang/Class.desiredAssertionStatus0(Ljava/lang/Class;)Z`), plus whatever further natives the `Bare` tests reach (the `UnsatisfiedLinkError` names them), implemented as Task 10 specifies them so Task 10 only adds to this set.

- [ ] **Step 1: Failing tests.** `interpreter.test.ts` loads `rt-bdj.jar` and `conformance.jar` bytes from disk and, without `boot()`, calls each `Bare` method through `callStatic('conformance/Bare', name, '()I')`, expecting 5050, 6765, 45, 25, 7, 21, 3, 2, 30, 1. Further tests:
  - a class file assembled in the test (write a 60-line `assembleClass` helper in the test file that emits a minimal class with one static method from raw bytecode) for `idiv` by zero → `callStatic` rejects with `java.lang.ArithmeticException: / by zero`; `Integer.MIN_VALUE / -1` → `-2147483648`; `ldiv` `Long.MIN_VALUE / -1L`; `f2i` of NaN → 0 and of `1e20f` → 2147483647; `d2l` of `-1e30` → `Long.MIN_VALUE`; `ishl` by 33 = shift by 1; `lushr` of `-1L` by 60 → 15; `fcmpl`/`fcmpg` with NaN → -1 / 1 (Review Focus 5).
  - a method that recurses without end: the thread ends with `StackOverflowError` at depth 4,000, and a version that catches it returns normally (Review Focus 2).
  - a class whose `<clinit>` throws `RuntimeException`: first `getstatic` throws `ExceptionInInitializerError`, the second `NoClassDefFoundError`, and the class state is `erroneous` (Review Focus 4).

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.**
  - **Loader** (JVM spec §5.3–5.5): `loadBoot` searches the `ClassPath` in order; `define` parses, resolves super and interfaces (loading through the same loader: bootstrap via `loadBoot`, a Java loader via `Invoke` of `loadClass` in Task 10; in this task only bootstrap), lays out instance fields after the superclass's (one slot per field regardless of width), builds the vtable (override by name+desc with access checks for package-private), allocates `staticValues` with `ConstantValue` initial values. Initialisation follows §5.5 exactly (steps 1–12 including the recursive-request and other-thread-initialising cases; the other-thread case waits via the scheduler in Task 8).
  - **Heap**: objects as in the interface; `fields` pre-filled with `0`, `0n` or `null` by descriptor.
  - **Interpreter**: a `switch` over all JVM 8 opcodes reading `frame.method.code.code`, operating on `frame.stack`. Invocations push a new `Frame` on `thread.frames` (no JS recursion); returns pop and push the value on the caller's stack. Native methods: look up `natives.get(cls.name + '.' + name + desc)`; missing → throw `UnsatisfiedLinkError` with that key; call with `(ctx, ...args)`; `Suspend` parks the thread (Task 8), `Invoke` pushes the target's frame with `then` stored on it, `ThrowResult` throws. Exceptions: on throw, walk the handler table of the current frame (catch type resolved and checked with `isSubclassOf`), else pop and repeat; a frame with `then` receives `thrown`. Constant-pool resolution is cached per class in a `resolved: unknown[]` array. `invokedynamic` throws `UnsatisfiedLinkError('invokedynamic')` until Task 11. `monitorenter`/`monitorexit` call the scheduler's monitor functions (no-ops in this task's single-thread scheduler). Each executed instruction decrements the budget; at 0 return `'budget'`.
  - `Jvm.throwNew(cls, msg)` allocates the exception without running Java constructors (sets `detailMessage` and fills the stack trace natively), so natives can throw cheaply.

- [ ] **Step 4: Run, expect pass.** Add `tests/bdj/conformance.test.ts` now with only the `Bare` cases above moved into it if that reads better; `interpreter.test.ts` keeps the assembled-class cases. Typecheck.

- [ ] **Step 5: Commit:** `git commit -m "feat(bdj): class loader, heap and bytecode interpreter"`.

### Task 8: green threads and monitors

**Files:**
- Create: `src/engine/bdj/jvm/threads.ts`, `threads.test.ts`
- Modify: `interpreter.ts`, `jvm.ts`, `loader.ts` (class-init waits)

**Interfaces:**
- Produces:

```ts
export type ThreadState = 'runnable' | 'blocked-monitor' | 'waiting' | 'timed-waiting' | 'sleeping' | 'parked' | 'suspended-native' | 'terminated';
export class JThread {
  readonly id: number; readonly frames: Frame[]; state: ThreadState;
  javaThread: JObject | null; interrupted: boolean; uncaught: JObject | null;
}
export interface Monitor { owner: JThread | null; count: number; readonly entrySet: JThread[]; readonly waitSet: JThread[] }
export class Scheduler {
  constructor(jvm: Jvm, opts: { readonly slice: number; readonly nowMs: () => number; readonly setTimer: (ms: number, fn: () => void) => () => void });
  spawn(javaThread: JObject | null, method: JMethod, args: readonly JValue[]): JThread;
  monitorEnter(t: JThread, o: JObject): boolean; // false: thread blocked, retry the instruction later
  monitorExit(t: JThread, o: JObject): void; // IllegalMonitorStateException if not owner
  wait(t: JThread, o: JObject, ms: number): NativeResult; // ms 0 = forever
  notify(o: JObject, all: boolean, t: JThread): void;
  sleep(t: JThread, ms: number): NativeResult;
  park(t: JThread, absolute: boolean, time: bigint): NativeResult; unpark(t: JThread): void;
  interrupt(t: JThread): void;
  suspendOn(t: JThread, p: Promise<JValue | undefined>): void;
  /** Runs until no thread can make progress; resolves 'idle' or 'deadlock' (every live thread blocked on a monitor or untimed wait). */
  run(signal?: AbortSignal): Promise<'idle' | 'deadlock' | 'aborted'>;
  readonly live: readonly JThread[];
}
```

- [ ] **Step 1: Failing tests** (`threads.test.ts`, using assembled classes or `conformance.jar` classes, with a virtual clock: `nowMs` returns a counter; `setTimer` stores callbacks; the test advances the clock when `run()` resolves `'idle'` with timers pending):
  - two threads each `synchronized` incrementing a static 10,000 times → 20,000;
  - `wait`/`notify` handshake completes; `wait(100)` returns after the virtual clock advances 100;
  - `Thread.sleep(50)` in one thread does not block another thread's progress;
  - `interrupt` of a sleeping thread → `InterruptedException`;
  - a thread in `while (true) {}` and a second thread that increments a counter 1,000 times: the second finishes (time slicing; Review Focus 3);
  - two threads taking two monitors in opposite order: `run()` resolves `'deadlock'` instead of hanging (Review Focus 3);
  - `run(signal)` with an aborted signal resolves `'aborted'` even with a spinning thread;
  - `monitorexit` by a non-owner throws `IllegalMonitorStateException`.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** Round-robin queue of runnable threads; `run()` loops: take next runnable, `execute(jvm, t, slice)`, requeue on `'budget'`, and between slices `await` a resolved promise every 50 slices so I/O promises settle (use `setTimeout(0)` from the injected `setTimer` with 0 ms in production; a microtask in tests). Blocked-monitor threads become runnable on `monitorExit`. Timed states register timers. `suspendOn` sets `suspended-native`, and on settle pushes the value onto the top frame's stack (or, for a frame with `then`, calls it) and makes the thread runnable. `'idle'` = no runnable threads and none suspended; `'deadlock'` = live threads exist but all are `blocked-monitor`/`waiting`/`parked` with no timers and no suspensions. Class initialisation by another thread (loader step 2 of §5.5) waits on the class's own monitor.

- [ ] **Step 4: Run, expect pass**, rerun Task 7's tests, typecheck.

- [ ] **Step 5: Commit:** `git commit -m "feat(bdj): green-thread scheduler and monitors"`.

### Task 9: virtual file system

**Files:**
- Create: `src/engine/bdj/jvm/vfs.ts`, `vfs.test.ts`

**Interfaces:**
- Consumes: `ByteSource` (`src/engine/disc/byte-source.ts`).
- Produces:

```ts
export interface VfsStat { readonly kind: 'file' | 'dir'; readonly size: number; readonly mtimeMs: number }
export interface VfsHandle { readonly path: string; position: number; readonly size: () => number; readonly writable: boolean }
export class Vfs {
  constructor(opts: {
    readonly disc: ByteSource | null;
    readonly jdkLib: ZipArchive; // rt-bdj.jar; its lib/ entries appear under /jdk/lib/
    readonly nowMs: () => number;
    /** Disc paths as the disc spells them, keyed by FileSource's upper-case path. */
    readonly originalNames?: ReadonlyMap<string, string>;
    /** Read-only files outside the mounts, for tests (e.g. '/app/conformance.jar'). */
    readonly extraFiles?: ReadonlyMap<string, Uint8Array>;
  });
  stat(path: string): VfsStat | null;
  list(dir: string): string[] | null; // names, sorted
  mkdir(path: string): boolean; delete(path: string): boolean; rename(from: string, to: string): boolean;
  open(path: string, mode: 'r' | 'w' | 'a' | 'rw'): VfsHandle | null;
  /** Sync for memory and /jdk/ files; disc files return a promise. */
  read(h: VfsHandle, out: Uint8Array, offset: number, length: number): number | Promise<number>;
  write(h: VfsHandle, data: Uint8Array, offset: number, length: number): void; // memory mounts only
  close(h: VfsHandle): void;
  canonicalize(path: string): string; // resolves '.', '..', duplicate '/'
  readonly mounts: readonly string[]; // ['/disc/', '/tmp/', '/persistent/', '/buda/', '/jdk/']
}
```

- [ ] **Step 1: Failing tests.**
  - `/disc/` over a `syntheticSource` (from `tests/helpers/synthetic-disc.ts`) whose keys are upper-case: `stat('/disc/BDMV/JAR/00000.jar')` and `stat('/disc/bdmv/jar/00000.JAR')` both find the file; `list('/disc/BDMV/JAR')` returns `['00000.jar']`. With `originalNames` (built from the picked entries, since `FileSource` keeps only upper-case keys) listings use the disc's own spelling; without it, BD-ROM's conventional spelling: directory names upper-case, file extensions lower-case (`00000.jar`, `00000.bdjo`, `index.bdmv`). Review Focus 1.
  - `extraFiles` entries are readable at their paths and listed in their directory.
  - reading a disc file returns a promise with the right bytes; reading past the end returns -1 (EOF); writes to `/disc/` fail.
  - `/tmp/`: `mkdir`, nested files, `rename` across directories, `delete` of a non-empty directory fails, `list` sorted, `stat` sizes after writes, `'a'` mode appends.
  - `/jdk/lib/tzdb.dat` is served from `rt-bdj.jar`'s `lib/tzdb.dat`.
  - `canonicalize('/tmp/a/../b//c/.')` is `/tmp/b/c`; paths outside the mounts (`/etc/passwd`) do not exist.

- [ ] **Step 2: Run, expect failure. Step 3: Implement** (memory mounts are a tree of `Map<string, Node>` with `Uint8Array` buffers grown by doubling). **Step 4: Run, expect pass, typecheck. Step 5: Commit:** `git commit -m "feat(bdj): virtual file system for java.io"`.

### Task 10: core JDK natives and JDK boot

**Files:**
- Create: `src/engine/bdj/jvm/natives/index.ts`, `lang.ts`, `reflect.ts`, `unsafe.ts`, `misc.ts`; extend `tests/bdj/conformance.test.ts`
- Modify: `jvm.ts` (`boot()`), `loader.ts` (Java class loaders), `src/engine/NOTICE`

**Interfaces:**
- Produces:

```ts
export interface NativeContext { readonly jvm: Jvm; readonly thread: JThread; readonly method: JMethod }
export type NativeFn = (ctx: NativeContext, ...args: JValue[]) => NativeResult;
export class NativeTable {
  register(entries: Readonly<Record<string, NativeFn>>): void; // key 'java/lang/Object.hashCode()I'
  get(key: string): NativeFn | undefined;
  readonly keys: readonly string[];
}
export function registerJdkNatives(table: NativeTable): void; // lang, reflect, unsafe, misc, invoke, io, zip, security, net, awt
```

- [ ] **Step 1: Failing tests.** In `tests/bdj/conformance.test.ts`, a helper `runMain(name)` creates a `Jvm` with the three boot jars, a `Vfs` whose `extraFiles` holds `/app/conformance.jar`, and the system property `java.class.path=/app/conformance.jar`; calls `boot()`; then, without `sun.launcher.LauncherHelper`, loads `conformance.<name>` through `ClassLoader.getSystemClassLoader().loadClass` and invokes `main(new String[0])`, capturing stdout. Tests: `Arith`, `Arrays`, `Exceptions`, `Init`, `Strings`, `Collections`, `Reflect` output equals the `.out` file exactly. (`Threads`, `Lambdas`, `Zip`, `Io` come in Tasks 11–12.) Also: `boot()` completes in under 10 s in Node (log the time).

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement natives**, each key from `tests/bdj/natives.txt` in these packages:
  - `lang.ts`: `java/lang/Object` (`hashCode`, `getClass`, `clone` for objects and arrays, `notify`, `notifyAll`, `wait`), `java/lang/Class` (`forName0`, `getPrimitiveClass`, `isInstance`, `isAssignableFrom`, `isInterface`, `isArray`, `isPrimitive`, `getName0`, `getSuperclass`, `getInterfaces0`, `getComponentType`, `getModifiers`, `getDeclaredFields0`, `getDeclaredMethods0`, `getDeclaredConstructors0`, `getDeclaringClass0`, `getEnclosingMethod0`, `getGenericSignature0`, `getRawAnnotations`, `getConstantPool`, `getProtectionDomain0`, `desiredAssertionStatus0`, `getSigners`/`setSigners`), `java/lang/System` (`arraycopy` with all JDK checks, `currentTimeMillis`, `nanoTime`, `identityHashCode`, `initProperties`, `setIn0`, `setOut0`, `setErr0`, `mapLibraryName`), `java/lang/Thread` (`currentThread`, `start0` → `scheduler.spawn` of `run()`, `sleep`, `yield`, `isAlive`, `holdsLock`, `interrupt0`, `isInterrupted`, `setPriority0`, `getThreads`, `dumpThreads` minimal), `java/lang/Throwable` (`fillInStackTrace` from the frames, `getStackTraceDepth`, `getStackTraceElement`), `java/lang/String.intern`, `java/lang/Float`/`Double` bit conversions, `java/lang/StrictMath` (port fdlibm via Doppio's `natives/java_lang.ts` `StrictMath` functions; JS `Math` is not bit-exact), `java/lang/Runtime` (`availableProcessors` 1, memory figures 256 MB), `java/lang/ClassLoader` (`defineClass1`, `findBootstrapClass`, `findLoadedClass0`, `findBuiltinLib`, `registerNatives`), `java/lang/ClassLoader$NativeLibrary.load` (records, no-op), `java/lang/Shutdown` (`halt0`, `runAllFinalizers`), `java/lang/ref/Reference`/`Finalizer` as no-ops (spec §3.3), `java/security/AccessController.doPrivileged*` and `getStackAccessControlContext` (null) / `getInheritedAccessControlContext`.
  - `initProperties`: `java.home=/jdk`, `java.io.tmpdir=/tmp`, `user.dir=/`, `user.home=/tmp`, `user.name=bdj`, `file.separator=/`, `path.separator=:`, `line.separator=\n`, `file.encoding=UTF-8`, `sun.jnu.encoding=UTF-8`, `os.name=Linux`, `os.arch=amd64`, `os.version=0`, `java.vm.name=bluray-web`, `java.vm.version=5b`, `java.vm.specification.version=1.8`, `java.version=1.8.0`, `java.specification.version=1.8`, `java.class.version=52.0`, `sun.boot.class.path=/boot/libbluray-j2se.jar:/boot/libbluray-awt-j2se.jar:/boot/rt-bdj.jar`, `java.class.path=` (empty, or the test's), `sun.arch.data.model=64`, `java.awt.headless=false`, plus `JvmOptions.systemProperties` (runtime-supplied ones: `awt.toolkit`, `java.awt.graphicsenv`, `javax.accessibility.assistive_technologies= `).
  - `reflect.ts`: `sun/reflect/Reflection` (`getCallerClass`, `getClassAccessFlags`), `sun/reflect/NativeMethodAccessorImpl.invoke0` and `NativeConstructorAccessorImpl.newInstance0` (unbox arguments, `Invoke`, box the result; exceptions wrapped in `InvocationTargetException`), `java/lang/reflect/Array` (`newArray`, `multiNewArray`, `getLength`, `get`, `set`), `java/lang/reflect/Proxy.defineClass0` (`define`), `sun/reflect/ConstantPool` getters used by annotations.
  - `unsafe.ts`: `sun/misc/Unsafe` per Doppio's `natives/sun_misc.ts` (`objectFieldOffset` → slot, `arrayBaseOffset` 0, `arrayIndexScale` 1, `compareAndSwap*`, `get*/put*` (+ `Volatile`, `Ordered`), `allocateMemory`/`freeMemory`/`putLong(address)`/`getByte(address)` on a `Map<bigint, DataView>` of malloc'd blocks, `addressSize` 8, `pageSize` 4096, `ensureClassInitialized`, `shouldBeInitialized`, `defineClass`, `defineAnonymousClass` (Task 11 needs it), `allocateInstance`, `throwException`, `park`/`unpark`, `staticFieldBase`/`staticFieldOffset`, `getLoadAverage` -1, `fullFence` and friends no-ops).
  - `misc.ts`: `sun/misc/VM.initialize`, `sun/misc/Signal` (`findSignal` -1, `handle0` 0), `sun/misc/Version` getters, `sun/misc/Perf` (`createLong` returns a `ByteBuffer` of 8 bytes), `sun/misc/URLClassPath.getLookupCacheURLs` (null), `java/io/FileDescriptor.initIDs`/`set` (stdout/stderr fds 1/2 wired to `stdout`/`stderr`), `sun/nio/cs`-related none.
  - Java class loaders: `Loader.loadVia(loader: JObject, name)` returns `Invoke` of `loader.loadClass(name)`; resolution from a class defined by a Java loader goes through it (JVM §5.3.2).
  - `Jvm.boot()`: create the main thread group and `main` thread objects as HotSpot's `create_initial_thread` does (allocate `ThreadGroup` with the no-arg constructor, `Thread` with `(ThreadGroup, String)`), initialise `java/lang/String`, `System`, `ThreadGroup`, `Thread`, `Class`, then call `System.initializeSystemClass()` and wait for it.
  - NOTICE: add each Doppio-derived function's file and DoppioJVM's MIT notice; record the Doppio commit hash.

- [ ] **Step 4: Run, expect pass**; also every `tests/bdj/natives.txt` key that falls in these packages is registered (a test in `natives/index.test.ts` that lists missing keys per package; it may still list keys owned by Tasks 11–13, which are allow-listed by package prefix until then). Typecheck.

- [ ] **Step 5: Commit:** `git commit -m "feat(bdj): core JDK natives; the JDK boots"`.

### Task 11: method handles and `invokedynamic`

**Files:**
- Create: `src/engine/bdj/jvm/natives/invoke.ts`
- Modify: `interpreter.ts` (`invokedynamic`, `invokehandle` for signature-polymorphic `MethodHandle.invoke*`), `conformance.test.ts` (`Lambdas`)

- [ ] **Step 1: Failing test:** `Lambdas` output equals `Lambdas.out`; plus a test that `java.time.LocalDate.of(2026, 10, 15).plusDays(30).toString()` is `2026-11-14` (the JDK uses lambdas internally there).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Port** from Doppio `src/natives/java_lang_invoke.ts` and its `invokedynamic`/`invokebasic`/`linkTo*` handling in `src/opcodes.ts` and `src/methods.ts`: `MethodHandleNatives.init`, `resolve`, `getConstant`, `objectFieldOffset`, `staticFieldOffset`, `staticFieldBase`, `getMembers`, `setCallSiteTargetNormal`; `MethodHandle.invokeBasic`, `linkToStatic`, `linkToVirtual`, `linkToSpecial`, `linkToInterface`; call-site bootstrap per JVM §6.5 `invokedynamic` (resolve the bootstrap method handle and static arguments, `Invoke` `MethodHandleNatives.linkCallSite`, cache the resulting `CallSite` target per instruction). LambdaForms are interpreted, not compiled to bytecode (this is why `classes.txt` excludes `LambdaForm$*`).
- [ ] **Step 4: Run, expect pass; typecheck. Step 5: Commit:** `git commit -m "feat(bdj): method handles and invokedynamic"`.

### Task 12: I/O, zip, security, network and AWT natives

**Files:**
- Create: `src/engine/bdj/jvm/natives/io.ts`, `zip.ts`, `security.ts`, `net.ts`, `awt.ts`
- Modify: `conformance.test.ts` (`Threads`, `Zip`, `Io`), `natives/index.test.ts` (no allow-list left except Task 13's packages)

- [ ] **Step 1: Failing tests:** `Threads`, `Zip`, `Io` outputs equal their `.out`; a `URLClassLoader` over a jar written to `/tmp/` loads a class from it (assemble the jar in the test with `ZipArchive`'s inverse or reuse `conformance.jar` copied into `/tmp/`); the native-coverage test reports no missing key outside `org/videolan`, `java/awt/BDFontMetrics`, `java/awt/BDGraphicsBase`.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement:**
  - `io.ts`: `java/io/UnixFileSystem` (`canonicalize0`, `getBooleanAttributes0`, `checkAccess`, `getLastModifiedTime`, `getLength`, `setPermission`, `createFileExclusively`, `delete0`, `list`, `createDirectory`, `rename0`, `setLastModifiedTime`, `setReadOnly`, `getSpace`) over `Vfs`; `java/io/FileInputStream` (JDK's: `open0`, `read0`, `readBytes`, `skip`, `available`, `close0`; disc reads return `Suspend`), `FileOutputStream` (`open0`, `write`, `writeBytes`, `close0`; fd 1 and 2 go to `stdout`/`stderr`, line-buffered), `RandomAccessFile` (`open0`, `read0`, `readBytes`, `write0`, `writeBytes`, `seek0`, `getFilePointer`, `length`, `setLength`), `FileDescriptor` sync no-op, `java/io/ObjectStreamClass.initNative`/`hasStaticInitializer`, `java/io/Console.istty` false. File descriptors are integers in a `Map<number, VfsHandle>` stored in `FileDescriptor.fd`.
  - `zip.ts`: `java/util/zip/ZipFile` natives (`initIDs`, `open` → `ZipArchive` from a `/…` path read fully (disc files via `Suspend`), `getTotal`, `startsWithLOC`, `getEntry`, `getNextEntry`, `getEntryBytes`, `getEntryTime`, `getEntryCrc`, `getEntryCSize`, `getEntrySize`, `getEntryMethod`, `getEntryFlag`, `freeEntry`, `read` (raw compressed bytes at the entry's data offset), `close`, `getCommentBytes`, `getZipMessage`), `Inflater` (`initIDs`, `init` → handle to an `inflateRaw()` coroutine in a `Map<bigint, InflateCoroutine>`, `setDictionary` unsupported → `IllegalArgumentException`, `inflateBytes` (sets `needDict`, `finished`, `off`, `len` fields as the JDK's C does), `getAdler` 1, `reset`, `end`), `Deflater` (stored blocks only: valid DEFLATE that `inflateAll` and HotSpot both read; enough for `Zip`'s round trip), `CRC32` (`update`, `updateBytes`, `updateByteBuffer`), `Adler32`.
  - `security.ts`: `sun/security/provider/NativeSeedGenerator` none; `java/security/AccessController` already in Task 10; anything `natives.txt` lists under `java/security` or `sun/security`.
  - `net.ts`: `java/net/InetAddress.init`, `Inet4Address.init`, `Inet6Address.init`, `InetAddressImplFactory.isIPv6Supported` false, `PlainSocketImpl.initProto` no-op; `Inet4AddressImpl.getLocalHostName` `localhost`; connections throw `java.net.ConnectException: network disabled` (5e decides network).
  - `awt.ts`: every `initIDs` in `natives.txt` under `java/awt` and `sun/awt` as no-ops; `sun/java2d/Disposer.initIDs`; `java/awt/Toolkit.initIDs`; `sun/awt/image` none beyond `initIDs`.
- [ ] **Step 4: Run, expect pass; typecheck. Step 5: Commit:** `git commit -m "feat(bdj): I/O, zip, network and AWT natives"`.

### Task 13: libbluray natives, `BdjHost` and `RecordingHost`

**Files:**
- Create: `src/engine/bdj/host.ts`, `host.test.ts`, `src/engine/bdj/errors.ts`, `src/engine/bdj/jvm/natives/libbluray.ts`, `libbluray.test.ts`
- Modify: `src/engine/NOTICE`

**Interfaces:**
- Consumes: `parseBdjo` (Task 5), `DiscModel` and `openDisc` (`src/engine/disc/open-disc.ts`), `RegisterFile` (`src/engine/hdmv/registers.ts`), `Vfs` (Task 9).
- Produces: `BdjHost` exactly as spec §3.6 (with `getTitleInfos(): readonly TitleInfo[]` and `getPlaylistInfo(n): PlaylistInfo | null` where:

```ts
export interface TitleInfo { readonly number: number; readonly objectType: 'hdmv' | 'bdj'; readonly playbackType: number; readonly bdjoName: string | null; readonly hdmvObjectId: number | null }
export interface PlaylistInfo { readonly playlist: number; readonly durationTicks: bigint; readonly angleCount: number; readonly marks: readonly { readonly type: number; readonly playItem: number; readonly startTicks: bigint; readonly durationTicks: bigint; readonly offsetTicks: bigint }[]; readonly clips: readonly { readonly clipId: string; readonly inTicks: bigint; readonly outTicks: bigint; readonly videoStreams: number; readonly audioStreams: readonly StreamInfo[]; readonly pgStreams: readonly StreamInfo[]; readonly igStreams: readonly StreamInfo[]; readonly secondaryAudioStreams: readonly StreamInfo[]; readonly secondaryVideoStreams: readonly StreamInfo[] }[] }
export interface StreamInfo { readonly codingType: number; readonly format: number; readonly rate: number; readonly lang: string; readonly pid: number; readonly aspect: number; readonly subpathId: number }
export interface TraceEntry { readonly call: string; readonly args: readonly (number | string | boolean | null)[]; readonly ret: number | string | boolean | null }
export class RecordingHost implements BdjHost {
  constructor(disc: DiscModel, opts: { readonly startTitle: (title: number) => void; readonly onTrace?: (e: TraceEntry) => void });
  readonly trace: readonly TraceEntry[];
  readonly registers: RegisterFile;
}
export type BdjErrorCode = 'class-not-found' | 'unsatisfied-link' | 'verify' | 'internal';
export class BdjError extends Error { constructor(readonly code: BdjErrorCode, message: string, readonly javaStack: readonly string[] = []) }
```

(Time fields are 90 kHz ticks as `bd_get_playlist_info` reports them.)

- [ ] **Step 1: Failing tests.**
  - `host.test.ts`: on `syntheticSource` of `disc-bdj` files: `getTitleInfos()` lists title 1 as BD-J `00001`; `getPlaylistInfo(0)` has one clip `00000` with duration 2 s in ticks (180000n); `getPlaylistInfo(999)` is null; `writeReg(0, 100, 42, 0xffffffff)` returns 0 and `readReg(0, 100)` is 42; `writeReg(1, 102, 0x12, 0xff)` goes through `RegisterFile.psrWriteBits` as `bdpriv_reg_write` does (`bd_psr_write_bits`; no extra restriction at this level) and `readReg(1, 102)` is `0x12`; `writeReg(1, 200, 1, 0xffffffff)` returns -1 (out of range); `selectTitle(1)` returns libbluray's success value and calls `startTitle(1)` after the call returns (queued with `queueMicrotask`); every call appears in `trace` in the Global Constraints format with `long` values as strings.
  - `libbluray.test.ts`: the native table has every key of `org/videolan/Libbluray`'s 20 natives, `Logger.logN`, the five `java/io/FileInputStream` natives libbluray overrides, and the 11 font/text natives (37). `getBdjoN` for `/disc/BDMV/BDJO/00000.bdjo` returns an `org.videolan.bdjo.Bdjo` whose `getAppTable()[0].getInitialClass()` (call through `Invoke` in a small Java-side check, or read fields directly) is `bdjweb.test.FirstPlayXlet`. `cacheBdRomFileN('BDMV/JAR/00000.jar', '/tmp/x/00000.jar')` copies the bytes into `/tmp/` and returns 0. `BDFontMetrics.stringWidthN` of `"abc"` at size 20 returns 36 (3 × 0.6 × 20).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Port.**
  - `host.ts`: `RecordingHost` methods ported from the `bdpriv_*` functions they reach in `bluray.c` (`bdpriv_play_playlist_at`, `bdpriv_play_title_internal`, `bdpriv_seek`, `bdpriv_reg_write`, `bdpriv_get_uo_mask`, `bdpriv_sound_effect`, `bd_select_angle`, `bd_tell_time`) for their argument checks and return values only (no playback). `getTitleInfos` follows `bd_get_disc_info`'s title list and `_make_title_info` (which fields Java reads); `getPlaylistInfo` follows `bd_get_playlist_info` + `_fill_title_info` in `bluray.c` over our `Mpls`/`Clpi`.
  - `natives/libbluray.ts`: one function per native in `bdj/native/org_videolan_Libbluray.c` (`_make_title_info`, `_make_title_infos`, `_make_stream_array`, `_make_playlist_info` build the same Java objects with the same constructor descriptors through `Invoke` of `<init>`), `bdj/native/bdjo.c` (`_make_terminal_info`, `_make_app_cache_info`, `_make_accessible_playlists`, `_make_app_management_table`, `_make_key_interest_table`, `bdj_make_bdjo`), `cacheBdRomFileN` and `listBdFilesN` over the VFS as `_bdj_cache_*`/`disc_open_dir` do, `Logger.logN` → `host.log`, libbluray's `java/io/FileInputStream` natives (from `java-j2se/java/io/FileInputStream.java` declarations; implement like the JDK's in Task 12 but on libbluray's field names), and the stub font/text natives (Global Constraints values; `resolveFontN` returns the requested name, `loadFontN` returns a handle counter, `drawStringN` returns without drawing).
  - NOTICE lines for `host.ts` (from `bluray.c` `bdpriv_*`, `bd_get_playlist_info`) and `natives/libbluray.ts` (from `bdj/native/*.c`).
- [ ] **Step 4: Run, expect pass; typecheck. Step 5: Commit:** `git commit -m "feat(bdj): libbluray natives and recording host"`.

### Task 14: `BdjRuntime`

**Files:**
- Create: `src/engine/bdj/runtime.ts`, `runtime.test.ts`
- Modify: `src/engine/NOTICE`

**Interfaces:**
- Produces:

```ts
export interface ClassLibrarySource { readonly rt: Uint8Array; readonly libbluray: Uint8Array; readonly libblurayAwt: Uint8Array }
export interface BdjRuntimeDeps {
  readonly disc: ByteSource; readonly model: DiscModel; readonly classLibrary: ClassLibrarySource;
  readonly host: (startTitle: (title: number) => void) => BdjHost; // the runtime passes its own start
  readonly nowMs: () => number; readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly log: (line: string) => void;
}
export class BdjRuntime {
  constructor(deps: BdjRuntimeDeps);
  readonly host: BdjHost;
  boot(): Promise<void>; // bdj_open + _bdj_init; rejects with BdjError
  start(title: number): void; // _start_bdj: processEvent(BDJ_EVENT_START, title)
  processEvent(ev: number, param: number): void;
  run(opts?: { readonly signal?: AbortSignal; readonly until?: (e: TraceEntry) => boolean }): Promise<'idle' | 'until' | 'aborted' | 'deadlock'>;
  stop(timeoutMs?: number): Promise<void>; // BDJ_EVENT_STOP, then Libbluray.shutdown(); default timeout 5000
}
export const BdjEvent = { NONE: 0, START: 1, STOP: 2, PSR102: 3, PLAYLIST: 4, PLAYITEM: 5, CHAPTER: 6, MARK: 7, PTS: 8, END_OF_PLAYLIST: 9, SEEK: 10, RATE: 11, ANGLE: 12, AUDIO_STREAM: 13, SUBTITLE: 14, SECONDARY_STREAM: 15, VK_KEY: 16, UO_MASKED: 17, MOUSE: 18 } as const;
```

- [ ] **Step 1: Failing tests** (on `disc-bdj` with `RecordingHost`, virtual clock):
  - `boot()` resolves and the log contains libbluray's `Using Java 1.8` line from `Libbluray.initOnce`;
  - `start(0xffff)` (First Play, as `_play_title` passes `BLURAY_TITLE_FIRST_PLAY`) then `run({ until: (e) => e.call === 'selectPlaylistN' })` resolves `'until'`; the trace's control calls are `writeRegN [0,100,42,…]`, `setKeyInterestN`, `selectTitleN [1]`, `selectPlaylistN [0,…]` in that order;
  - stdout lines of both xlets reached `log`;
  - a host whose `selectPlaylist` throws a JS error: `run()` rejects with `BdjError('internal')`;
  - a class library whose `libbluray-j2se.jar` lacks `org/videolan/Libbluray.class` (rebuild the jar in the test with that entry dropped): `boot()` rejects with `BdjError('class-not-found')` naming `org/videolan/Libbluray`;
  - an xlet thread that throws an uncaught `RuntimeException` (a test class started through `callStatic` on a new Java thread): the exception's text reaches `log` and `run()` continues to `'until'` on the synthetic disc;
  - `stop()` with a spinning xlet thread still resolves within its timeout (Review Focus 3; use a test xlet assembled in the test, or start `TitleXlet` and inject a spinning thread through `callStatic`).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Port** `bdj_open` (minus JVM discovery), `_create_jvm`'s property list (Global Constraints; class path order), `_bdj_init` (`Libbluray.init(J, String, String, String, String)` with pointer `1n`, the zero disc ID, `/disc/`, `/persistent/`, `/buda/`), `bdj_process_event` (`processEvent(II)Z` on a fresh Java thread so the caller never blocks; drop `PTS` logging as libbluray does), `bdj_close` (`Libbluray.shutdown()V`), and `_start_bdj`/`_stop_bdj` from `bluray.c`. `run()` drives `jvm.threads.run(signal)`, checking `until` from the host's `onTrace` and aborting the scheduler when it matches. NOTICE line: `bdj/runtime.ts  from src/libbluray/bdj/bdj.c (bdj_open, _create_jvm properties, _bdj_init, bdj_process_event, bdj_close) and bluray.c (_start_bdj, _stop_bdj)`.
- [ ] **Step 4: Run, expect pass; typecheck. Step 5: Commit:** `git commit -m "feat(bdj): BD-J runtime boots and starts titles"`.

### Task 15: trace comparison and the synthetic-disc parity test

**Files:**
- Create: `tests/bdj/format.ts`, `tests/bdj/compare.ts`, `tests/bdj/compare.test.ts`, `tests/bdj/replay.ts`, `tests/bdj/bdj-trace.test.ts`

**Interfaces:**
- Produces: `parseBdjTrace(text: string): TraceEntry[]`; `CONTROL_CALLS: ReadonlySet<string>` (Global Constraints list); `compareBdjTraces(golden: readonly TraceEntry[], ours: readonly TraceEntry[]): void` (throws an `Error` naming the index and both entries of the first divergence among control calls; extra trailing calls on our side after the golden's last entry are ignored); `replayBdj(discDir: URL | string, opts?: { until?: string; timeoutMs?: number }): Promise<{ trace: TraceEntry[]; bootMs: number; untilMs: number }>`.

- [ ] **Step 1: Failing tests:** `compare.test.ts` (identical traces pass; a different `selectPlaylistN` argument fails naming index and call; differing counts of `readRegN` pass; a missing control call fails). `bdj-trace.test.ts`: `replayBdj('fixtures/synthetic/disc-bdj', { until: 'selectPlaylistN' })` matches `tests/bdj/golden/disc-bdj.jsonl` (timeout 120 s).
- [ ] **Step 2: Run, expect failure. Step 3: Implement** (`replay.ts` builds a `FileSource` from the directory with `directoryEntries` and `normalizeDiscPaths`, `openDisc`, reads the three jars from `src/bdj-classlib/`, creates `BdjRuntime` with `RecordingHost`, boots, `start(0xffff)`, `run({ until })`, records timings with `performance.now()`). **Step 4: Run, expect pass. Step 5: Commit:** `git commit -m "test(bdj): synthetic BD-J disc matches libbluray"`.

### Task 16: local discs and the CLI

**Files:**
- Create: `tests/bdj/run.ts`, `tests/local/bdj-boot.test.ts`
- Modify: `package.json` (`"bdj-trace": "tsx tests/bdj/run.ts"`)

- [ ] **Step 1: `tests/bdj/run.ts`:** `npm run bdj-trace -- <disc> [--until selectPlaylistN]` runs `tools/bdj-trace/run.sh` and `replayBdj` on the same disc, prints both control-call sequences side by side and the first divergence, then `bootMs` and `untilMs`. Exit code 1 on divergence.
- [ ] **Step 2: `tests/local/bdj-boot.test.ts`:** for each `fixtures/local/*` with `BDMV/BDJO`, `replayBdj(dir, { until: 'selectPlaylistN', timeoutMs: 120_000 })`; expected first `selectPlaylistN` argument per disc in a small table (`BDJ_DISC_A: 833`, `BDJ_DISC_B: 1611`; unknown discs only require that some `selectPlaylistN` happens); control calls before it include `selectTitleN` with `6` (BDJ_DISC_A) or `2` (BDJ_DISC_B); prints `bootMs`/`untilMs`. Skips when no BD-J disc is present.
- [ ] **Step 3: Run on both discs.** `npm run bdj-trace -- fixtures/local/BDJ_DISC_A --until selectPlaylistN` and the same for BDJ_DISC_B: no divergence. When there is one, it is a porting bug (or a missing class/native: rerun `npm run bdj-classlib:collect && npm run bdj-classlib:build` and implement any new native), fixed in the port, never by loosening the comparison. Then `npx vitest run tests/local/bdj-boot.test.ts`. Record `untilMs` for both discs; the target is ≤ 15,000 ms. If it is over, profile (`node --cpu-prof`) and fix the top items before finishing, or record the numbers and the top profile entries for Task 17.
- [ ] **Step 4: Commit:** `git commit -m "test(bdj): local BD-J discs boot to their first playlist"`.

### Task 17: docs and final verification

Precondition: milestone 4b is merged into `main`. Rebase `spec/bdj` onto `main` first (`git rebase main`), resolve conflicts, rerun `npm test`.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md` (BD-J row: "Milestone 5 series: 5b JVM core done; 5c–5e planned"), `docs/known-issues.md` (`00149` is the menu background loop on both BD-J discs; record 5b boot times; record open items: weak references strong, no finalizers, `long` as `bigint`), `CLAUDE.md` (commands `bdj-trace:build`, `bdj-trace`, `bdj-trace:golden`, `bdj-classlib:build`, `bdj-classlib:collect`; architecture paragraph for `src/engine/bdj/`; constraint for `src/bdj-classlib/` (GPLv2 + Classpath Exception, rebuilt only with `npm run bdj-classlib:build`, CI diff check); milestone list adds 5b), the M5b spec's status line and a "Deviations" section listing this plan's deviations.

- [ ] **Step 1: Write the doc changes above.**
- [ ] **Step 2: Full verification:** `npm run typecheck && npm test && npm run build && npm run test:e2e` (all existing suites pass; the player's behaviour is unchanged), `npm run bdj-classlib:build && git diff --exit-code src/bdj-classlib/`, `npm run bdj-trace:golden && git diff --exit-code tests/bdj/golden/`, `LOCAL_DISCS=1 npx playwright test local-discs`.
- [ ] **Step 3: Commit:** `git commit -m "docs(bdj): milestone 5b"`.
