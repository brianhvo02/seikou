# Milestone 5b: BD-J JVM Core — Design Spec

Date: 2026-10-15
Status: Implemented (2026-10-16); plan `docs/superpowers/plans/2026-10-15-m5b-bdj-jvm-core.md`. See §9 for where the implementation differs.
Parent spec: `2026-10-12-bluray-web-player-design.md` (which listed BD-J as "Not planned"; this milestone series changes
that, and Task 17 updated the parent spec and `docs/known-issues.md`). Evidence: `2026-10-15-bdj-spike-findings.md`.

## 1. Goal and scope

BD-J discs are meant to boot into their own Java menus, as HDMV discs already do. That takes five milestones:

| Milestone | Delivers |
|---|---|
| **5b (this spec)** | A JVM in TypeScript that boots libbluray's unmodified BD-J Java stack and a disc's xlet, in Node, against a recording host |
| 5c | The real `BdjHost`: the JVM in its own worker, driving `Player` (playlists, seeks, registers, UO masks, titles, events back to Java) |
| 5d | ARGB graphics plane, key and mouse input, fonts |
| 5e | Persistent storage, network and BD-Live stubs, performance; real-disc gate from menu to feature |

The originally planned "5a" (BDJO parsing to improve the playlist picker) was dropped. Both local BD-J discs' BDJO
files have no playlist table (`access_to_all_flag` set, `num_pl = 0`), so they carry nothing for the picker. The BDJO
parser is part of 5b, because Java receives the BDJO through a native.

In scope for 5b:

- The BDJO parser and its Java object builder.
- A JVM: class-file parser (versions 45 to 52), bootstrap class loading from jars, a bytecode interpreter including
  `invokedynamic`, green threads, the JDK natives the traced runs actually call, an in-memory file system.
- Built artifacts: a trimmed OpenJDK 8 class library and libbluray's Java stack, built in Docker, committed, checked in CI.
- `BdjRuntime` (a port of `bdj.c`), the `BdjHost` interface, and `RecordingHost`.
- Testing: a JVM conformance suite against HotSpot, a libbluray native-call trace harness, a synthetic BD-J disc
  with golden traces, and a live trace comparison on local discs.

Out of scope: running in a worker or in the browser at all, the real host, graphics output, input, real font
rendering, persistent storage across sessions, JAR signature verification, network access, any UI or protocol change.
The player's behaviour is unchanged: BD-J titles still open the playlist picker.

Decisions taken during brainstorming:

| Question | Decision |
|---|---|
| End goal | Full BD-J menus, built over milestones 5b to 5e |
| Before the spec | A feasibility spike (done; see the findings) |
| Java stack | libbluray's own, unmodified (its j2se variant, as built by libbluray against JDK 8) |
| Class library | A trimmed OpenJDK 8 class library, not GNU Classpath, Apache Harmony or phoneME |
| Class library licence | Committed as a built artifact in its own directory with OpenJDK's licence files |
| JVM | Own strict-TS interpreter and loader; hard JDK natives ported from DoppioJVM (MIT) where useful |
| 5b gate | Boot each local BD-J disc in Node until its first playlist selection, matching libbluray's native-call trace |

## 2. Components

Ported code (libbluray at `448f896`, DoppioJVM at a pinned commit) lives under `src/engine/`, is LGPL-2.1-or-later
with SPDX headers, and records its source files in `src/engine/NOTICE`. DoppioJVM's MIT notice is reproduced there.
Original code follows the same licence as the rest of `src/engine/`.

| File | Source | Responsibility |
|---|---|---|
| `bdmv/bdjo-parser.ts` | `bdj/bdjo_parse.c` | `parseBdjo(bytes)` returns `Bdjo` (terminal info, app cache, accessible playlists, app management table, key interest table, file access info), with the field names of `bdjo_data.h`. |
| `bdj/jvm/classfile.ts` | original (JVM spec §4) | Parses a class file: constant pool, fields, methods, `Code`, `Exceptions`, `BootstrapMethods`, `InnerClasses`, `Signature`, `ConstantValue`. Rejects versions above 52. |
| `bdj/jvm/zip.ts` | original | Reads a jar's central directory and inflates entries (stored and deflate). Shared by the loader and `java.util.zip` natives. |
| `bdj/jvm/loader.ts` | original | `ClassPath` over an ordered list of jars. Bootstrap class loading, linking, and `<clinit>` per JVM spec §5. Classes defined from Java (`ClassLoader.defineClass1`, libbluray's `BDJClassLoader`) go through the same linker. |
| `bdj/jvm/heap.ts` | original | Object and array representation (§3.3), string interning, JS string conversion. |
| `bdj/jvm/interpreter.ts` | original | Executes frames: all JVM 8 opcodes, exception tables, monitors, `invokedynamic` via `bdj/jvm/natives/invoke.ts`. |
| `bdj/jvm/threads.ts` | original | Green-thread scheduler (§3.2): Java threads, monitors, `wait`/`notify`, `sleep`, `join`, `interrupt`, parking for `LockSupport`. |
| `bdj/jvm/natives/*.ts` | DoppioJVM where noted per function; OpenJDK native sources as reference | One file per area: `lang`, `reflect`, `invoke`, `unsafe`, `io`, `zip`, `security`, `awt`, `misc`. A table maps `class.name(descriptor)` to an implementation. |
| `bdj/jvm/natives/libbluray.ts` | `bdj/native/org_videolan_Libbluray.c`, `bdj/native/bdjo.c`, `java_awt_BDFontMetrics.c`, `java_awt_BDGraphics.c` | The 37 libbluray natives (§3.5). Converts Java objects to and from `BdjHost` calls, builds `Bdjo`, `TitleInfo` and `PlaylistInfo` Java objects as the C builders do. |
| `bdj/jvm/vfs.ts` | original | The file system `java.io` sees (§3.4). |
| `bdj/runtime.ts` | `bdj/bdj.c` | `BdjRuntime`: system properties and boot class path as `_bdj_init` and `_create_jvm` set them, `Libbluray.init(...)`, `start(title)` and `stop()` via `Libbluray.processEvent`, shutdown. |
| `bdj/host.ts` | original | The `BdjHost` interface and `RecordingHost` (§3.6). |
| `bdj/errors.ts` | original | `BdjError` with codes (§4). |

Outside `src/engine/`:

| Path | Licence | Contents |
|---|---|---|
| `src/bdj-classlib/rt-bdj.jar` | GPLv2 with the Classpath Exception | The OpenJDK 8 classes listed in `classes.txt`, plus the `lib/` resources the JDK reads during startup. |
| `src/bdj-classlib/libbluray-j2se.jar`, `libbluray-awt-j2se.jar` | LGPL-2.1-or-later | libbluray's Java stack at `448f896`, built unmodified. |
| `src/bdj-classlib/classes.txt` | n/a | The class list, generated by `tools/bdj-classlib/collect.sh` (§5). |
| `src/bdj-classlib/LICENSE`, `ASSEMBLY_EXCEPTION`, `NOTICE` | n/a | OpenJDK's licence files and the build provenance (OpenJDK package version, libbluray commit). |
| `tools/bdj-classlib/` | n/a | Dockerfile and scripts for `npm run bdj-classlib:build`. |
| `tools/bdj-trace/` | n/a | The libbluray BD-J trace harness (§6.3). |
| `tests/bdj/` | n/a | Conformance programs, trace comparison and replay. |

`src/engine/` still imports nothing from `src/ui/` or `src/player/`. The jars are loaded as bytes through an
injected `ClassLibrarySource`, so the engine never imports a file path.

## 3. Runtime behaviour

### 3.1 Class path and boot

The boot class path is, in order, `libbluray-j2se.jar`, `libbluray-awt-j2se.jar`, `rt-bdj.jar`, the order
`-Xbootclasspath/p:` gives in `_create_jvm`. libbluray's classes that replace JDK ones (`java.io.FileInputStream`,
`java.awt.BDToolkit` and others) therefore win. Disc jars are loaded by libbluray's own Java class loader from the VFS,
not by the bootstrap loader.

`BdjRuntime.boot()` follows `bdj_open`: it sets the system properties `_create_jvm` passes (`awt.toolkit`,
`java.awt.graphicsenv`, `java.awt.headless=false`, `java.home=/jdk`, and the rest of that function's list), runs
the JDK's `System.initializeSystemClass` path, then calls `org.videolan.Libbluray.init` with the arguments
`_bdj_init` passes (disc ID, disc root `/disc/`, persistent root `/persistent/`, cache root `/cache/`). `start(title)`
calls `processEvent(BDJ_EVENT_START, title)`. `stop()` sends `BDJ_EVENT_STOP` and waits for the xlet threads, as
`bdj_process_event` and `bdj_close` do.

### 3.2 Threads and scheduling

All Java threads are green threads on one JS thread.

- The scheduler runs the current thread for a slice of 10,000 bytecodes, or until it blocks, then picks the next
  runnable thread in round-robin order. Java thread priorities are ignored.
- Monitors are counters with an owner and a wait set. Nothing is shared between JS threads, so there are no atomics.
- `Thread.sleep`, timed `wait` and `LockSupport.parkNanos` use the injected clock (`nowMs`, `setTimer`). Tests use a
  virtual clock that advances when every thread is blocked on time.
- A native that has to wait (for example, a disc JAR read through `ByteSource`) returns `suspend(promise)`. That
  thread parks until the promise settles; the others keep running. The scheduler yields to the JS event loop
  between slices.
- `run()` resolves when no thread is runnable and none is waiting on time or I/O, or when `stop()` completes.

### 3.3 Heap representation

- An object is a JS object holding its class and a fixed array of field values; field slots are assigned at link
  time.
- Primitive arrays are typed arrays (`Int8Array` for `byte[]` and `boolean[]`, `Uint16Array` for `char[]`,
  `Int16Array`, `Int32Array`, `Float32Array`, `Float64Array`). `long` values, and `long[]` elements
  (`BigInt64Array`), are `bigint`. Profiling in 5e decides whether `long` moves to a faster representation.
- The JS garbage collector reclaims Java objects. In 5b, `WeakReference` and `SoftReference` hold strongly, reference
  queues stay empty, and finalizers never run. The heap has no size limit.
- `java.lang.String` keeps the JDK 8 layout (a `char[]` value). Literals are interned per JVM.

### 3.4 File system

`vfs.ts` backs `java.io.UnixFileSystem`, `FileInputStream`, `FileOutputStream` and `RandomAccessFile` natives, and
libbluray's own `FileInputStream` natives. It has four mounts:

| Mount | Backing | Notes |
|---|---|---|
| `/disc/` | the disc's `ByteSource`, read-only | Paths as `FileSource` normalises them (`BDMV/...`, `CERTIFICATE/...`) |
| `/cache/` | memory | libbluray's VFS cache: `cacheBdRomFileN` copies disc files here, as `_bdj_cache_*` does |
| `/persistent/` | memory | Discarded on close in 5b; 5e persists it |
| `/jdk/` | `rt-bdj.jar`'s `lib/` entries, read-only | `java.home` |

### 3.5 Natives

- The set implemented is the union of natives linked in the spike's `-verbose:jni` runs on the synthetic disc and
  both local discs, recorded in `tests/bdj/natives.txt` by `tools/bdj-classlib/collect.sh`. A unit test fails if
  `natives.txt` lists a method with no implementation.
- Any other native throws `UnsatisfiedLinkError` with the class, name and descriptor.
- JAR signatures: libbluray's Java code does not verify them, but the JDK's `java.util.jar.JarFile` checks signed
  disc JARs on its own (the `sun.security.*` classes in the spike's class list). That is ordinary JDK Java code and
  runs unchanged on our interpreter. If profiling in 5e shows the RSA work costs too much at boot, 5e decides whether
  to bypass it.
- libbluray's 37 natives:
  - Playback and registers (26): `getAacsDataN`, `getTitleInfosN`, `getPlaylistInfoN`, `seekN`,
    `selectPlaylistN`, `selectTitleN`, `selectAngleN`, `soundEffectN`, `getUOMaskN`, `setUOMaskN`,
    `setKeyInterestN`, `tellTimeN`, `selectRateN`, `writeRegN`, `readRegN`, `setVirtualPackageN`,
    `cacheBdRomFileN`, `listBdFilesN`, `getBdjoN`, `updateGraphicN`, `Logger.logN`, and the five `FileInputStream`
    natives libbluray overrides. These forward to `BdjHost`, the VFS or the BDJO parser.
  - Fonts and text (11): `BDFontMetrics.*` and `BDGraphicsBase.drawStringN`. In 5b they return fixed metrics (each
    glyph 0.6 em wide, ascent 0.8 em, descent 0.2 em) and draw nothing; 5d replaces them.

### 3.6 Host interface

`BdjHost` has one method per libbluray native that reaches the player, with TS types in place of JNI ones:

```ts
interface BdjHost {
  selectTitle(title: number): number;
  selectPlaylist(playlist: number, playitem: number, playmark: number, time: bigint): number;
  seek(playitem: number, playmark: number, time: bigint): bigint;
  selectAngle(angle: number): number;
  selectRate(rate: number, reason: number): number;
  tellTime(): bigint;
  readReg(isPsr: number, num: number): number;
  writeReg(isPsr: number, num: number, value: number, psrValueMask: number): number;
  getUOMask(): bigint;
  setUOMask(menuCall: boolean, titleSearch: boolean): void;
  setKeyInterest(mask: number): void;
  soundEffect(id: number): number;
  getTitleInfos(): readonly TitleInfo[];
  getPlaylistInfo(playlist: number): PlaylistInfo | null;
  getAacsData(type: number): Uint8Array | null;
  setVirtualPackage(vpPath: string | null, psrBackup: boolean): number;
  updateGraphic(width: number, height: number, argb: Int32Array | null, x0: number, y0: number, x1: number, y1: number): void;
  log(file: string, line: number, msg: string): void;
}
```

Names, argument meanings and return codes follow the `native` declarations in `Libbluray.java` and their
implementations in `org_videolan_Libbluray.c` exactly (the `long np` handle is dropped); the plan lists each one.

`RecordingHost` is the only host in 5b:

- Titles and playlists come from the parsed disc (`DiscModel`), registers from a real `RegisterFile` initialised with
  libbluray's PSR defaults (as the navigator's is).
- `selectTitle` does what libbluray's `_play_title` does. For a BD-J title it returns success and queues
  `BdjRuntime.start(title)` to run after the native returns (`_play_bdj`, then `bdj_process_event(BDJ_EVENT_START)`);
  the Java side stops the old title's xlets itself. For an HDMV title it returns success and the run ends, since 5b
  has no HDMV handoff. (The original draft claimed that First Play selects a BD-J title before the first playlist on
  both local discs; that is wrong, see §9 item 4.)
- Every other playback call returns libbluray's success value; `tellTime` returns 0; `getAacsData` returns null
  (decrypted discs); `updateGraphic` is counted, not drawn.
- Each call is appended to a trace in the format of §6.3.

## 4. Errors

| Code | When | Effect |
|---|---|---|
| `class-not-found` | A class the boot path needs is missing from the jars | `boot()` rejects; the message names the class and the class that referenced it |
| `unsatisfied-link` | A native with no implementation is called | Thrown in Java as `UnsatisfiedLinkError`; if uncaught it ends that thread like any exception |
| `verify` | A class file is malformed or above version 52 | `ClassFormatError` or `UnsupportedClassVersionError` in Java |
| `internal` | An interpreter invariant fails (stack underflow, bad constant pool index) | The runtime stops; `run()` rejects with the Java stack of the thread at fault |

Uncaught exceptions in xlet threads are printed through `Logger.logN`, the way libbluray's thread groups print
them, and do not stop the runtime. `System.out` and `System.err` go to the host's `log`.

## 5. Built artifacts

- `npm run bdj-classlib:build` runs `tools/bdj-classlib/build.sh` in Docker (ubuntu 24.04 pinned by digest,
  `linux/amd64` as `tools/vm-trace` uses; OpenJDK 8 pinned by package version; libbluray at `448f896`; DoppioJVM is
  not part of the build).
- It builds libbluray's jars with meson (`-Dbdj_jar=enabled`), then writes `rt-bdj.jar` from the JDK's `rt.jar`, plus
  three classes from `jsse.jar` and `jce.jar`, with exactly the classes in `classes.txt` plus `lib/` resources. Entries are sorted and timestamps fixed, so the output
  is byte-identical across runs.
- `tools/bdj-classlib/collect.sh` regenerates `classes.txt` and `tests/bdj/natives.txt` by running real libbluray with
  `-verbose:class` and `-verbose:jni` on the synthetic BD-J disc and, when present, the local discs. Local runs add
  class and method names only; no disc content is committed. Classes HotSpot generates at run time
  (`java.lang.invoke.LambdaForm$*` and similar) are excluded, because our `invoke` natives implement method handles
  directly instead of generating bytecode.
- `.github/workflows/bdj-classlib.yml` rebuilds the jars from the committed `classes.txt` and fails on any diff, as
  `wasm.yml` does for `audio.wasm`. CI does not run `collect.sh`, since it has no local discs; a developer reruns it
  when a disc needs a class or native the lists lack, and commits the result.
- `public/_headers` and COOP/COEP are unaffected; the jars are same-origin static assets once 5c loads them in a
  browser.

## 6. Testing

### 6.1 JVM conformance suite

`tests/bdj/conformance/*.java` are small programs, each printing to stdout. They cover:

- arithmetic and conversions on every primitive type, including `long` and floating-point edge cases;
- arrays, multi-dimensional arrays, `arraycopy`;
- exceptions: catch, finally, rethrow, stack traces;
- `synchronized`, `wait`/`notify`, thread start and join, interruption;
- strings, `StringBuilder`, `String.format`, interning;
- collections and `java.util.concurrent` basics;
- reflection and dynamic proxies;
- lambdas, method references, default methods (`invokedynamic`);
- `java.util.zip`, `java.io` against the VFS.

The build image compiles them with `javac -source 1.8` into `tests/bdj/conformance.jar` and records HotSpot's
output per program as `tests/bdj/conformance/<name>.out`; both are committed. Vitest runs each program on our JVM
and compares stdout exactly. Programs that read time or hash codes print only derived, deterministic values.

### 6.2 Unit tests

Class-file parser (every class in the three jars parses), zip reader, BDJO parser (against libbluray's parse of the
synthetic disc's BDJO and, when present, the local discs'), VFS, scheduler on a virtual clock, and the native table
against `natives.txt`.

### 6.3 Native-call traces

`tools/bdj-trace/` builds libbluray with BD-J in Docker from the same pinned image. `trace.patch` changes one file,
`bdj/native/org_videolan_Libbluray.c`: each native writes a JSONL entry with its name, arguments and return value.
`run.sh <disc> [--until selectPlaylist]` runs a disc headless, as the spike did, and prints the trace. The image
is `linux/amd64` like `tools/vm-trace`, so libbluray finds the JDK 8 `libjvm` under `jre/lib/amd64/server` (on
arm64 it looks under `jre/lib/arm/`, which JDK 8 does not have), and `LIBBLURAY_CP` points at the built jars.

The comparison (`tests/bdj/compare.ts`) covers control calls in order and by value: `selectTitle`, `selectPlaylist`,
`seek`, `selectAngle`, `selectRate`, `writeReg`, `setUOMask`, `setKeyInterest`, `soundEffect`, `setVirtualPackage`.
Polled reads (`readReg`, `tellTime`, `getUOMask`, `getTitleInfos`, `getPlaylistInfo`) and `log` are excluded from the
order because how often an xlet polls depends on timing; the comparison reports them for diagnosis only.

### 6.4 Synthetic BD-J disc

`fixtures/synthetic/disc-bdj` is generated by `npm run fixture:synthetic` like the other synthetic discs. Its index
has a BD-J First Play and one BD-J title. It has one short playlist and clip from the existing builders, and its
BDJOs name `JAR/00000.jar`. The xlet source is in `tests/bdj/xlets/`; `npm run bdj-classlib:build` compiles it into
the committed `tests/bdj/xlets/00000.jar`, which `fixture:synthetic` copies into the disc.

- The First Play xlet reads PSRs, writes a GPR, sets the UO mask and key interest, then selects title 1.
- Title 1's xlet selects playlist `00000`.

This covers the same title switch the local discs go through before their first playlist.
`tests/bdj/golden/disc-bdj.jsonl` is generated by `npm run bdj-trace:golden`, never edited by hand, and CI
(`.github/workflows/bdj-trace.yml`) regenerates it and fails on any diff.

### 6.5 Local discs

`npm run bdj-trace -- fixtures/local/<disc>` runs libbluray and our JVM on the disc until the first
`selectPlaylist` and prints the first divergence. `tests/local/bdj-boot.test.ts` does the same in Vitest and skips
when no BD-J disc is present.

## 7. Exit criteria

1. The conformance suite matches HotSpot's output for every program.
2. The synthetic disc's trace matches `tests/bdj/golden/disc-bdj.jsonl` in CI.
3. BDJ_DISC_A's control calls match libbluray's up to and including `selectPlaylist(833)`, and BDJ_DISC_B's up to
   and including `selectPlaylist(1611)`.
4. The time from `boot()` to that call in Node is recorded for both discs in `docs/known-issues.md`. The target is
   15 s or less on the developer's machine. It is tracked, not enforced in CI.
5. `npm run typecheck`, `npm test` and the existing E2E suite pass, and the player's behaviour on every disc is
   unchanged.

## 8. Follow-ups outside this spec

All done in Task 17:

- Change the parent spec's BD-J row from "Not planned" to the milestone 5 series.
- Correct `docs/known-issues.md`: `00149` on both local BD-J discs is the menu's background loop, not a decoy maze
  (skipping it for main-feature choice remains right).
- Add `npm run bdj-classlib:build`, `bdj-trace` and `bdj-trace:golden` to `CLAUDE.md`, and the new licence boundary
  (`src/bdj-classlib/`) to its constraints.

## 9. Deviations (recorded during planning and implementation)

1. **Mounts.** `/tmp/` (java.io.tmpdir, where libbluray's CacheDir lives) and `/buda/` replace `/cache/`; `/app/` (read-only, test jars) is added. `Libbluray.init` takes a BUDA root, not a cache root.
2. **Disc ID** comes from `CERTIFICATE/id.bdmv` (then `BACKUP/`), as libbluray's `bdid_get` does; 32 zeros when absent.
3. **`BdjHost` return types** are the JNI types of the `native` declarations (int is a number, long a bigint), not the booleans of the §3.6 sketch. Builder-driven additions: `getTitleInfos` null entries, a `videoStreams` array, `StreamInfo.charCode`, a log error flag, an optional `record()`.
4. **Title selection.** libbluray's Java calls `selectTitleN` only for HDMV titles (`BDJLoader` to `Libbluray.selectHdmvTitle`); BD-J to BD-J title changes stay in Java. §3.6's sentence that First Play selects title 6 (BDJ_DISC_A) or 2 (BDJ_DISC_B) before the first playlist is wrong: real libbluray makes no `selectTitleN` call before the first playlist on either disc. `RecordingHost.selectTitle` follows `bdpriv_play_title_internal`.
5. **Constructor and deps.** `RecordingHost(disc, clips, opts)` needs the CLPI data. `BdjRuntimeDeps` has no `model`; `deps.host` is `(startTitle, onTrace) => BdjHost`; `deps.disc` is a `ByteSource` with `paths()` (a `FileSource`).
6. **Events are serialised**: one Java thread per event, and the next starts when the previous returns, as `bdj_process_event` is synchronous. Event threads share the `main` `java.lang.Thread` (libbluray attaches a fresh one).
7. **Class library sources.** Three classes come from the JDK's `jsse.jar` and `jce.jar` (the same OpenJDK GPLv2+CPE package). `classes.txt` also lists VM-internal error classes the interpreter throws.
8. **Natives that call Java** return an `Invoke` continuation. LambdaForms are interpreted (`LambdaForm.compileToBytecode` is replaced by a native); BoundMethodHandle species classes are still spun by the JDK's factory (they are data holders).
9. **`Scheduler.run()`** returns `'idle'` while timers are pending; `BdjRuntime.run` loops until truly idle.
10. **The golden trace holds control calls only**, because `cacheBdRomFileN` carries a random cache directory name.
11. **The synthetic disc is BD-J only** (no HDMV title), so it does not exercise `selectTitleN`.
12. **Maths.** `StrictMath` is bit-exact for `exp` and `IEEEremainder` (fdlibm ports); other functions use JS `Math`. `sun.reflect.inflationThreshold=2147483647`, so no generated reflection accessors.
13. **`RecordingHost` also applies libbluray's UHD/3D player profile switch** (`register.c` `psr_init_UHD`/`psr_init_3D`) and the harness's player settings (country us, languages eng) for parity.
