# BD-J feasibility spike: findings (2026-10-15)

Evidence for `2026-10-15-m5b-bdj-jvm-core-design.md`. The probe code was throwaway and is not committed; the M5b
trace harness (`tools/bdj-trace/`) replaces it.

Setup: libbluray `448f896` with BD-J (OpenJDK 8u, j2se stack, freetype) in Docker on arm64 (native, not emulated);
a headless probe played each disc, read no faster than real time, logged events, dumped ARGB overlay frames, and
pressed Enter at a set time. Two quirks to get the JVM loaded: `jre/lib/arm -> aarch64` (libbluray maps aarch64 to
`arm`) and `LIBBLURAY_CP=/usr/local/share/java/`.

## 1. Does libbluray's BD-J work on these discs? Yes.

| | BDJ_DISC_A | BDJ_DISC_B |
|---|---|---|
| Framework | `com.uni.radius` | `com.dis.radius` |
| First Play | title 6, playlist `00833` (logos, 23 s); first ARGB frame at 0.23 s | title 2, playlist `01611` (26 s) |
| Menu | title 0, playlist `00149` as the menu background; PLAY/CHAPTERS/SETUP/BONUS drawn with disc fonts | language picker over `01355` |
| Enter | PLAY: title 6, playlist `01048` after 1.75 s | English: `01535`, then title 0 with `00149` |

`00149`, which `disc/main-title.ts` skips as a decoy loop, is the menu background loop on both discs.

Non-fatal noise: missing JDK Lucida fonts (the headless JDK ships none), `StreamNotAvailableException` printed by
the app, `BDRootWindow` `sync(): not visible`.

## 2. What runtime would a port need?

- Classes loaded: about 1,510 from OpenJDK 8 `rt.jar` (java.util 150, java.lang 115, java.awt 100, sun.misc 76,
  java.io 75, sun.security.* about 140 for disc JAR signature checks, java.lang.invoke 59, java.time about 50),
  280 from libbluray's stack, and 300 to 430 from the disc JAR.
- Bytecode versions: disc apps 47 (Java 1.3), libbluray stack 48/49 (built as 1.4/1.5 under JDK 8). OpenJDK 8's own
  classes are version 52 and use invokedynamic/LambdaForms internally.
- Natives: libbluray declares 37 (26 in `org.videolan.Libbluray`/`Logger` plus the FileInputStream overrides, and 11
  font/text natives in `BDFontMetrics`/`BDGraphicsBase`). With JNI linking logged, 309 distinct natives were linked
  (134 dynamically on first call, 175 bulk-registered, 83 of them `sun.misc.Unsafe`). So the JDK natives actually
  called are somewhere between about 150 and 250.

## 3. Is an interpreter fast enough? Very likely.

| Run | CPU over the run | Wall clock |
|---|---|---|
| BDJ_DISC_A, JIT | 2.5 s user | 45 s |
| BDJ_DISC_A, `-Xint` | 5.2 s user | 45 s |
| BDJ_DISC_B, JIT | 2.1 s user | 70 s |
| BDJ_DISC_B, `-Xint` | 3.7 s user | 70 s |

These include JVM startup and libbluray's C stream reading. Pure interpretation costs about 2x the JIT, and
Enter-to-playlist latency was unchanged (it's the app's animation). The one CPU-bound moment seen: BDJ_DISC_B's
title change after Enter took 1.4 s longer under `-Xint`. A TS interpreter 5 to 10 times slower than HotSpot's
assembly interpreter would average roughly 0.5 to 1 core over these runs, with multi-second bursts at boot and title
changes. Acceptable in a worker; boot time is the number to watch.

## Recommendation: go, with these changes to the plan

1. **Class library: OpenJDK 8's, not Classpath, Harmony or phoneME.** It's the library libbluray's j2se stack is
   built and tested against (it subclasses `sun.awt`/`java.awt.peer` internals), it's GPLv2 with the Classpath
   Exception, and this spike shows it running both discs. The cost is that the interpreter must handle version-52
   bytecode including invokedynamic, plus about 150 to 250 JDK natives. Ship a trimmed `rt.jar` subset of the about
   1,500 classes, not the whole JDK. Fallback if trimming fails: libbluray's j2me variant on a PBP-level library.
2. **Interpreter: TS, green threads.** Look at DoppioJVM (TypeScript, MIT, ran the OpenJDK 8 class library in the
   browser; unmaintained) as a reference or starting point before writing one from scratch.
3. **Skip JAR signature verification** (the sun.security.* load) behind a flag. Real players need it; we don't.
4. **Fonts:** the 11 font/text natives need a FreeType replacement (WASM FreeType or canvas text), plus fallback
   system fonts, since the discs ask for Lucida by name.
5. **First real-disc gate:** reproduce this spike's event sequence (playlists `00833` then `00149` on BDJ_DISC_A)
   and its first menu frame, and compare against these traces, as `tests/vm-trace/` does for HDMV.
6. **Wording only:** `docs/known-issues.md` calls `00149` a maze/decoy playlist; it is the menu background loop.
   Skipping it for main-feature choice is still right. Correct the note after M4b merges.
