# Known issues and open items

Items left open on purpose. Each one says why it was left and
what would change that decision.

## Performance

- **Rejected: demux PID peek.** Skipping unwanted PIDs before parsing measured
  103 ms vs 105 ms per 400 MB, which is no gain, so it was not kept.

## Video

- **Interlaced H.264 (1080i) is decoded in software and shown without deinterlacing.** Chrome's hardware decoders
  fail on streams with `frame_mbs_only_flag` 0 ("Decoding error"; TSURUNE's 1080i logo is MBAFF), so those streams
  are configured with `prefer-software`. Frames come out as woven fields, so motion shows combing. *Revisit if* a
  disc has long interlaced content (a deinterlacing shader in the compositor would fix it).
- **H.264 that redefines a PPS id switches to software decoding, dropping up to one GOP once.** Some encoders resend
  PPS 0 with other content on nearly every picture. Chrome's hardware decoder on macOS fails on such a stream every
  few seconds ("Decoding error", then frames lost to the next keyframe); ffmpeg and Chrome's software decoder decode
  it cleanly. The first PPS only shows up after `configure()`, so the decoder reopens with `prefer-software` when it
  sees the redefinition and resumes at the next key unit. That costs about a second of frames at the start of each
  playlist. *Revisit if* that gap shows (holding the first GOP until the PPS pattern is known would remove it).
- **MPEG-2 and VC-1 video plays without a picture (5e).** The player decodes only H.264 and HEVC. A playlist with
  MPEG-2 or VC-1 video, HDMV or BD-J, plays as libbluray plays it, with audio, subtitles and IG or BD-J menus over
  black, its reads paced by the clock, and a notice once per disc ("This disc's video can't be played here yet, so it
  will play without a picture"), cleared when a playlist with a picture starts and not shown again for that disc (R9).
  A playlist with such video and nothing else playable still runs, silent and black on the wall clock, to its end
  (ruling R12): libbluray does the same, and some HDMV programs rely on it; a user who picks such a playlist sees the
  notice, not an error. `UnsupportedCodecError` is left for a decoder that fails to configure. On a NAS disc the
  quality levels (cross-browser step 4) play them with a picture, re-encoded on the NAS; a local folder still plays
  them without one. *Revisit if* the browsers gain MPEG-2 or VC-1 decoding.

## Menus (HDMV)

- **Menu sounds are verified on synthetic data only.** `disc-menu` carries a `sound.bdmv`; none of the local discs
  has one. *Revisit when* a disc with menu sounds is available.
- **`composition_timeout_pts` and `selection_timeout_pts` are not implemented**, as in libbluray (it only logs them).
  The user timeout is. *Revisit if* a disc relies on them.
- **Initial PSRs are libbluray's `bd_psr_init` defaults**, including region B and profile 2, so traces match
  libbluray. *Revisit if* a disc's program branches on region or profile in a way that matters.
- **Menu keys are not checked against UO masks at libbluray's default restriction level (RELAXED)** inside the
  navigator, as in libbluray; the player refuses masked keys and controls one layer up with a notice.
- **IG in sub-paths is read whole when its playlist opens** (`_preload_ig_subpath`), which reads the whole sub-path
  clip; clips over the preload limit show no menu. *Revisit if* a disc carries a large IG sub-path.

## Subtitles

- **HDMV TextST streams (stream type 0x92) are not decoded.** No local disc carries one. *Revisit when* a disc does.
- **PG carried in sub-paths is not decoded**, as in libbluray (it decodes main-path PG only); such tracks are left out
  of the subtitle menu. *Revisit if* a disc carries its only subtitles in a sub-path.
- **After a seek or a stream switch, the subtitle on screen comes back only if its display set lies after the keyframe
  the read starts at;** otherwise the next subtitle is the first one shown (libbluray behaves the same). *Revisit if*
  this is noticeable on real discs (reading PG from a few seconds earlier would fix it).
- **Subtitle files are not remembered per disc**, and a file dropped on the player before a playlist plays is ignored
  (the file belongs to the open disc).
- **SRT is verified on synthetic data only** (unit tests and `tests/e2e/subtitles.spec.ts`); no real-world SRT corpus
  is tested. Encodings other than UTF-8 need the user's choice in the encoding prompt (no detection).

## ASS subtitles

- **Not loaded yet: subtitles and fonts inside `.mkv` files, and installed system fonts (`queryLocalFonts()`).**
  Both are a later milestone. Fonts come from files picked or dropped with the script and from its `[Fonts]`
  section; a family that is still missing is replaced and named in a notice.
- **WOFF2 fonts are not accepted** (Brotli and table transforms); `.ttf`, `.otf`, `.ttc` and `.woff` are. Fansub
  fonts are TTF/OTF. *Revisit if* a release ships WOFF2.
- **Legacy `Effect` field effects (`Banner`, `Scroll up`, `Scroll down`) are ignored**, and `Comment`, `Picture`,
  `Sound`, `Movie` and `Command` events are skipped. *Revisit if* a real file uses them.
- **Right-to-left text is reordered by Chrome within a style run only**; libass's FriBidi reordering across runs is
  not ported, so mixed-direction lines that change style mid-word can order differently.
- **Lines break as libass does without libunibreak** (spaces and ZWSP only), which is what most ffmpeg builds do.
  CJK text without spaces therefore wraps only at the frame edge, as in those builds.
- **Fonts without TrueType hinting instructions space their glyphs slightly differently from libass.** libass's
  shaper loads glyphs hinted, so FreeType runs its auto-hinter on such fonts and the advances follow the snapped stem
  edges: about 1 px per glyph at the 256 px shaping size, up to ~1 px across a short title on screen. Porting the
  auto-hinter is out of scope. In the TSURUNE corpus this is Chalk Board (the episode title card); it is recorded in
  that fixture's `exceptions.json` and is the only difference left (57 layout differences and 3 frames, all in 2
  events). Glyph shapes are unaffected.
- **Small text keeps up to 1/16 px of Chrome's glyph snapping.** Chrome draws text under about 256 device px from a
  glyph cache that snaps the baseline to whole pixels, so masks are supersampled until text reaches that size, at
  most 8×. Text animated in shape every frame (the direct path) is drawn the same way on the GPU but blurred by the
  canvas filter with one deviation for both axes.
- **Not drawn as libass does:** BorderStyle 4 (libass's background box) is not drawn; vertical `@font` glyphs are
  drawn unrotated; `\be` is folded into the Gaussian (variance 0.5 per pass); a rotated border with `\xbord` ≠
  `\ybord` is dilated axis-aligned in device space. *Revisit if* a real file shows the difference.
- **Verified against one real script so far** (TSURUNE episode 1, its 18 fonts, 2340 sampled times; local gate
  `ASS_LOCAL=1`). The 15 committed synthetic fixtures cover the tag set. *Revisit* by adding scripts to
  `fixtures/local/ass/`.

- **`src/engine/ass/trace.ts` imports its types from `tests/ass-trace/format.ts`.** The import is type-only and the
  module is used only by the trace page, so nothing from `tests/` reaches the player bundle. *Revisit if* the trace
  format moves into the engine (it would then belong in `src/engine/ass/`).
- **The local corpus gate needs Docker and the developer's files**, so CI runs only the synthetic fixtures. *Revisit*
  if a freely licensed real-world script with fonts becomes available to commit.

## Video shaders

- **The final scaler is bilinear (the canvas draw), not mpv's Lanczos.** Anime4K does the real upscaling; what is
  left is a small resize to the window. *Revisit if* the difference is visible.
- **PREKERNEL runs in gamma light**, as the video is delivered; mpv's linear-light option is not implemented.
- **Shaders are compiled as GLSL ES 3.00, which rejects desktop-GLSL habits** such as implicit int to float
  conversion, so some non-Anime4K shaders fail to compile (the error shows in the menu). *Revisit if* a wanted
  shader needs a rewrite pass.
- **Unsupported directives are rejected when the file is added:** `COMPUTE`, `TEXTURE`, `PARAM`, `BUFFER` and
  `OFFSET` (the Anime4K files use none of them), more than 16 `BIND`s per pass, and files over 4 MiB.
- **No in-memory fallback when IndexedDB is unavailable:** the menu opens but sets cannot be chosen that session
  (errors are logged). Chrome's private windows still provide IndexedDB, so this is rare. *Revisit if* users with
  blocked site storage need shaders.
- **`unavailable` is discovered only when a set is first chosen:** the engine creates the WebGL2 backend lazily, so
  until then the menu lists sets as usual, and only after the first choice does it show the unavailable message.
  *Revisit if* users on such browsers find the late message confusing (probe at startup).
- **A pass skipped for an error mid-chain lets later passes bind a same-named texture saved earlier by another
  file,** where libplacebo fails the whole hook. Not reachable with Anime4K.
- **A transient render error (for example a closed `VideoFrame`) turns the set to `error` until it is selected
  again,** instead of costing one frame. *Revisit if* it shows up in practice (treat `InvalidStateError` as per-frame).
- **Resolved: GitHub CI runs the shader E2E tests.** `ubuntu-latest` Chrome provides WebGL2 float render targets
  (SwiftShader) with no extra flags; the fixture-shader tests ran and passed on PR #1 (2026-10-16). The tests still
  skip with a logged reason if a runner lacks them, and the Anime4K and sync tests stay behind `SHADERS_GPU=1`.
- **Note (behaviour, not an issue): `MAIN` is the visible size,** for example 1440x1080 for an anamorphic frame
  (coded 1440x1088, display 1920x1080), as `texImage2D` of a `VideoFrame` gives; confirmed by the Task 1 spike.

## BD-J (milestones 5b-5e)

- **5c timings (Chrome, production build, this machine).** Time from opening the disc to the first frame of the
  title's playlist, as `bdj.firstFrameMs`:

  | Disc | Warm | Cold |
  |---|---|---|
  | A_NEW_ERA | 4,934-4,988 ms (5 runs) | 5,006-5,013 ms |
  | RENTAL_FAMILY | 843-884 ms | 875-916 ms |

  The margin to the 5 s target on A_NEW_ERA is 12-66 ms. About 4.0 s of its time is the disc's own animation and a
  `Thread.sleep(3000)`; about 0.7 s is interpretation. On a slower machine the local 5 s check may fail. 5e left
  the JIT (spec 5c section 4.7, stage 2) out, by the user's choice (start-up behaves fine); it stays the lever if the
  margin is needed. Stage 1 (intrinsics) replaced the 5b figure of about 26 s in Node.
- **5d responsiveness and start-up (Task 11; Chrome, production build, this machine).** Menu responsiveness is
  telemetry `bdj.inputLatencyMs` (last, max, count): from a key press or click reaching the engine worker to the next
  presented frame whose BD-J plane holds a publication made after it. The first publication presented after an input
  answers it (and any earlier one still waiting): BD-J cannot say which flush answers which input, so on a menu that
  animates by itself an input that changes nothing is answered by the next animation frame; one unanswered for 5 s is
  dropped. The main thread to engine worker hop is not included, and the measure ends at the OffscreenCanvas draw,
  so up to one vsync of display after it is not counted either. Arrows and Enter on A_NEW_ERA's main menu and on
  RENTAL_FAMILY's picker and main menu show in 3-23 ms (bar 200 ms; `local-bdj-menus.spec.ts`). A_NEW_ERA's menu has no
  mouse handling: a click is forwarded and the ignored-tap rule opens the remote. Its buttons lie along the bottom edge,
  under the player's control bar while that shows, so a click there hits the bar. Pointer moves stay forwarded for the
  whole BD-J title as spec §4.2 says: about 4.7k bytecodes (well under 0.1 ms) of Java per move, so not gated.
  Start-up: A_NEW_ERA warm `firstFrameMs` went from median 4,966 ms (max 4,997, 5 runs) to median 4,790-4,828 ms (max
  4,800-4,916, three sets of 7 runs) through intrinsics and loop hooks for the start-up path. Most of A_NEW_ERA's Java
  time before its animation is the JDK opening its signed jar again and again: each `JarFile` parses the 32 KB
  manifest and verifies the signature file (PKCS7 parse, RSA), about a third of the interpreted time. That count
  matches HotSpot (ruling R10): up to the first `selectPlaylistN`, libbluray on HotSpot constructs a `ZipFile` on
  `00000.jar` 5 times (a JVMTI breakpoint on `ZipFile(File, int, Charset)` in the bdj-trace image), and so does our
  JVM (5 `ZipFile.open` calls), in the same order. No cross-open cache was added: JDK 8 keeps verifier state per
  `JarFile`. About 4.0 s of the 4.8 s is the disc's own animation and `Thread.sleep(3000)`.
- **Open on purpose in the JVM core.** Weak and soft references hold strongly, reference queues stay empty and
  finalizers never run. `long` is a `bigint`. A failed `invokedynamic` call site re-links on each execution (JDK 8
  behaviour, not JVMS §5.4.3). Deep method-handle nesting (about 60k) can overflow the JS stack. There is no network
  (5e): the URL handlers and socket classes are in `rt-bdj.jar`, and every connection fails as it does in HotSpot with
  no network (`natives/net.ts`: an unknown host, then "Network is unreachable"; `localhost` resolves and refuses), so
  a disc's BD-Live check fails cleanly and the disc carries on. The libbluray harness runs offline too (5e ruling R7).
  `SecureRandom` has no entropy source (no `/dev/urandom`), so its first use fails. Signed disc JARs are checked as on
  HotSpot: the JDK's `JarVerifier` and `SignatureFileVerifier` check the signature block and the entry digests, and
  libbluray's `VFSCache.isJarVerifiable` strips the signature of a JAR that fails, which then runs unsigned. libbluray
  itself enforces no BD-J authentication: the signer is never checked against the disc's root certificate
  (`BDMV/CERTIFICATE/app.discroot.crt` is not read), the permission request files (`bluray.*.perm`) are mounted but
  not used to grant anything (`BDJSecurityManager` applies one fixed sandbox to every xlet), and
  `DSMCCObject.getSigners` is unimplemented. We run the same code, so the same holds here. There is no bytecode
  verifier and there are no access checks: no `IllegalAccessError`, no `IncompatibleClassChangeError` for
  `invokevirtual` on a static method, no check that a final method is not overridden.
- **Player settings come from the browser's locale, on discs that use BD-J (5c ruling R9, narrowed in 5e).** The
  engine worker derives `bd_set_player_setting_str`'s audio, PG and menu languages and the country from
  `navigator.language` (`playerSettingsForLocale`): the language as ISO 639-2/B (`fre`, `ger`, `chi`, the codes discs
  label streams with), the region in lowercase (`us`); anything it cannot map stays unset. They are written to the
  program's registers when a disc whose index names a BD-J object opens, as libbluray writes them at `bd_open`, so a
  mixed disc's HDMV First Play and HDMV titles read them too (one disc's First Play copies the menu language into a GPR
  that its BD-J menu reads to pick its language). Until 5e they were written only on BD-J entry. Discs without BD-J keep
  the registers' defaults (PSR16-19) and their first stream choice is unchanged; libbluray applies the settings for
  every disc. There is no settings UI yet.
- **Open on purpose in 5c.** A new BD-J worker and JVM start for every BD-J entry, where libbluray keeps one JVM
  across HDMV and BD-J handoffs (deviation 5). The HDMV Navigator is dropped, not suspended, while BD-J runs, so
  libbluray's resume of a suspended object across a BD-J title is lost on mixed discs (deviation 6). The mixed
  HDMV/BD-J synthetic disc has no vm-trace golden, because that harness's libbluray has no JVM (deviation 12).
  SEEK and PSR8 report the requested position, not the EP-map-aligned one, and END_OF_PLAYLIST fires once per
  presentation end where libbluray fires once per open (deviation 13). JVM timers run on the real clock while the
  Node replay's player uses a virtual clock (no effect seen). The intrinsics' loop hooks are pinned by checksum to the
  committed jars: a rebuilt class library fails loudly until the hooks are re-checked. `openDisc` and `loadClips`
  have no read-concurrency cap.
- **Disc directory listings are sorted (5c).** `listBdFilesN` (and the VFS's other directory listings, `vfs.ts`)
  return names in sorted order, where libbluray returns readdir order. A folder the browser hands over has no
  canonical readdir order, so sorted is the one order that is the same on every run and machine.
- **BD-J input (5d).** Keys, clicks and taps reach Java as libbluray sends them (`bd_user_input`,
  `bd_mouse_select`), and 5c's "menu isn't shown yet" notice is gone. While the BD-J plane shows anything, a tap or
  click on the video goes to the disc; on an empty plane it shows or hides the controls (desktop: play/pause). A tap
  on a shown menu that brings no reaction within 0.2 s (constrained profile 0.5 s) opens the on-screen remote, with a
  notice once per menu. A reaction is a plane publication or anything Java sends (a call or a background still), so
  a menu that animates on its own counts every tap as taken. Deviations: libbluray's `bd_user_input` blocks until
  Java has taken an event; ours does not, so the BD-J worker's event queue merges a held key's repeats (and pointer
  moves) beyond 8 pending, never other events. Pointer moves are not logged, like PTS. Escape/Back is not sent to
  Java: libbluray defines no Back key (`keys.h`) and Java drops unknown codes; Escape stays with the player UI. The
  remote opens by itself once per menu, with the notice; one the user closes stays closed until the next menu.
- **Touch over a disc menu, HDMV or BD-J (5d, rulings R12-R15).** A tap on the picture goes to the disc; a tap off
  it (any letterbox or pillarbox band), an HDMV tap that hits no button, a BD-J tap Java ignores (remote too), or a
  long press (500 ms, at most 10 px of movement; never sent to the disc) brings up the controls. In a menu, empty
  control-bar space passes clicks through, a pointer move wakes the bar only near the bottom edge, and keys that go to
  the disc don't wake it (R9, R11). The long press is tested only through CDP touch in Chrome and in the gate's unit
  tests, not on real iPhone or iPad hardware: the device gate never needed it (its fallback taps a letterbox band
  instead).
- **Local BD-J discs against libbluray (5d).** `tests/local/bdj-menus.test.ts` drives A_NEW_ERA (main menu to PLAY,
  and to CHAPTERS, chapter 2) and RENTAL_FAMILY (language picker, English, main menu, PLAY) to the feature and compares
  the control calls and the plane at every settled point with libbluray's committed runs (`tests/bdj/golden/local/`).
  One check is restricted: RENTAL_FAMILY saves its playback position in GPR 518/519 about once a second during the
  feature, and the values depend on when that timer fires, so its writes after the feature's playlist starts are left
  out on both sides; that both sides made some is still checked, and its start-up writes of 0 are compared
  (`#! vary gpr 518 519 after playlist 800` in its script). Intermediate animation frames are not compared (ruling R3). At rest with no input,
  neither disc's menus flush: 0 flushes in 15 s in libbluray on A_NEW_ERA's main menu and on RENTAL_FAMILY's picker
  (43 s) and main menu, and in ours one repeat of the settled frame in 10 s, so animated menus do not defeat the
  ignored-tap rule on these discs (ruling R6). Found on the way and fixed: `java.awt.event.ContainerEvent` and ten other
  classes were missing from the class library; a still play item did not hold under BD-J (RENTAL_FAMILY's picker plays
  over an infinite still); a mark at the first play item's IN time never reached Java (`_find_next_playmark` works on
  packets, and the first item starts at packet 0, before that mark's EP map entry).
- **BD-J file budget on phones and tablets (5d, ruling R16).** Under the constrained memory profile, the BD-J file
  system's memory mounts (`/tmp/` with libbluray's copies of the disc's JARs and the files it extracts from them,
  `/persistent/`, `/buda/`) hold at most `bdjVfsCacheBytes` (64 MB; the device gate measured 4.6 MB on the iPhone,
  so it stayed). A write beyond it fails as on a full disk (IOException "No space left on device", logged once with the path and the budget),
  so a disc whose BD-J files exceed it fails to mount its app and falls back to the picker. libbluray has no such limit,
  and desktop has none. The local discs use 4.4 MB (A_NEW_ERA) and 1.4 MB (RENTAL_FAMILY).
- **5d start-up and the device gate (2026-10-18).** `bdj.firstFrameMs` for A_NEW_ERA (RENTAL_FAMILY is under
  1 s on desktop and about 4.6-5.3 s on the iPhone and iPad):

  | Where | Warm | Cold | Bar |
  |---|---|---|---|
  | Desktop Chrome (local files and disc server) | about 4.8-4.96 s (medians 4.8-4.92 s) | 4,976-5,034 ms | 5 s warm |
  | Mac Safari 26.6.2 (disc server) | 4,888-4,964 ms | 5,039 ms | 5 s warm |
  | iPhone 17 Pro, iOS 27.2 (disc server, solo) | 8.3-9.0 s | 10.8 s | 10 s target, 15 s blocker |
  | iPad Pro 12.9" 5th gen, iPadOS 27.0.1 (disc server) | 9.5 s | 11.6 s | 10 s target, 15 s blocker |

  Desktop passes with a thin margin (tens of ms; a loaded machine goes over, 5,441 ms seen). The iPhone meets the
  10 s target warm and misses it cold by 0.8 s, well under the blocker; the iPad misses it by up to 1.6 s cold. Most
  of A_NEW_ERA's time is its own animation and `Thread.sleep(3000)`; about a third of the interpreted part is the JDK
  re-verifying the signed `00000.jar`, as HotSpot does (R10). With the iPhone and iPad gate run concurrently on one
  disc server the iPhone took 12.7-20.3 s; that was the shared connection, not the player. A JIT (5c spec
  section 4.7, stage 2) is the lever; 5e left it out by the user's choice. Menu responsiveness: at
  most 68 ms on every device (bars 0.2 s computer, 0.5 s iPhone). Ten minutes in the menus (200 inputs) brought no
  reload on the iPhone, the iPad, the iPad Simulator or Mac Safari; desktop Chrome and Firefox stayed 120 s.
  Measured device memory stayed well under the constrained budgets (class bytes 1.33 of 4 MB, VFS 4.6 of 64 MB,
  stills 0 of 16 MB), so none was changed. The Java heap (about 38 MB of `int[]` on A_NEW_ERA) and the JVM's
  own JS structures (about 95 MB, mostly parsed constant pools) are not budgeted; a compact constant-pool form is the
  next lever if a phone needs it. Firefox ran RENTAL_FAMILY only (no HEVC, spec 4.5).
- **Buffering behind a BD-J menu over the disc server (Task 14c).** On the iPhone the menu playlist (A_NEW_ERA's
  `00149`) sat in `buffering` at 0:00 for several seconds after the menu was drawn, while `RemoteSource`'s read-ahead
  filled, with the spinner over a still menu. Taps now pass through the spinner, so the menu works, but the wait
  itself is a start-up and read-ahead question for the remote route that 5d did not address.
- **BD-J text (5d).** FreeType 2.13.2 is built to WASM from Ubuntu's patched source, the version libbluray links in the
  harness, and `freetype-golden.json` / `text-golden.json` (`tests/bdj/fonts/`) hold its glyphs and what libbluray's
  compiled font and text natives return and draw. Those two goldens cover TrueType fonts only; CFF outlines are
  covered by the synthetic menu disc, whose disc font is Source Sans 3 (OpenType CFF, OFL) and whose plane hashes are
  in the bdj-trace golden. No CI job regenerates `freetype-golden.json` or `text-golden.json`
  (`npm run bdj-trace:freetype-golden` / `bdj-trace:text-golden` by hand): CI rebuilds `freetype.wasm` and checks it
  against them through Vitest only.
- **HAVi background stills (5d).** libbluray never draws `HStillImageBackgroundConfiguration.displayImage`; we draw
  the still under the video, decoded by the browser. Gaps, as in libbluray: no `HPermissionDeniedException`,
  `HConfigurationException` or `IOException` is raised, the background colour is not drawn, and the scaling flag is
  ignored. A failed decode clears the still, but a missing file keeps the previous one, and a still survives a title
  change inside one BD-J entry. `HBackgroundImage(byte[])` and `HBackgroundImage(URL)` work since 5e (Task 2):
  `sun.awt.image.ByteArrayImageSource` and `URLImageSource` are in the class library, and `natives/havi.ts` reads the
  bytes or a `file:`/`jar:file:` URL inside the BD-J file system (library discs use both).
- **JPEG decoded in Java is unsupported (5d).** The class library has no `JPEGImageDecoder` and there is no libjpeg
  in WASM, so a JPEG image Java loads (an AWT image, or a JPEG `HBackgroundImage` on `load()`) fails to load where
  HotSpot decodes it, even though `displayImage` itself would let the browser decode the same bytes. Neither local disc
  loads a JPEG (both use PNG). *Revisit if* a disc needs it: build libjpeg through the FreeType WASM pipeline, matching
  the JRE's libjpeg.
- **Annotation reflection is unsupported in the class library.** `rt-bdj.jar` has no
  `sun.reflect.annotation.AnnotationParser` (nor `MethodRepository`), so `getAnnotation` and friends throw
  `NoClassDefFoundError`. BD-J targets Java 1.3/1.4, which has no annotations; the JVM itself keeps the attributes,
  and a TypeScript test checks their bytes.
- **The class library is collected from traced runs (5d, Task 14b).** `bdj-classlib:collect` lists the classes
  HotSpot loads while running the synthetic and local discs, plus a constant-pool scan. A class reached only on a
  path those runs never took is missing: `ThreadLocalRandom`, reached only when a `ConcurrentHashMap` CAS race was
  lost, stalled about one boot in 60 until it was added, and Xerces error and validation paths may still miss
  classes. The scan follows constant-pool references only, not reflection. A missing class fails loudly
  (`NoClassDefFoundError` in the log), and a boot that stalls on one dumps every Java thread at the 20 s timeout.
  5e collected again over the start-up files of every BD-J disc in the NAS library (offline, ruling R7), with a
  keep-list of classes added by hand: `rt-bdj.jar` went from 4,619,640 to 4,919,980 bytes (+6.5%; `classes.txt` from
  1,870 to 2,085 entries), precached by the service worker for every visitor. The license check found one third-party
  family the notice did not name: `sun/text/normalizer/**`, behind `java.text.Normalizer`, derives from ICU4J;
  `pack.sh` now writes the JDK's ICU notice as `THIRD_PARTY_ICU`, and `NOTICE` lists it.
- **Ignored taps on the iPhone gate (Task 14c, 2026-10-18).** On the iPhone, A_NEW_ERA's tap on the menu centre was
  never counted as ignored. The cause was not the reaction window: idling in A_NEW_ERA's main menu for about 45 s through the
  real Player (local replay, playlist 00149 behind it) brings no control call, no register write and no plane change
  after the menu settles, so the 0.5 s window has nothing to catch and the reaction rule is unchanged. The tap never
  reached the engine: the disc server's read-ahead held the menu playlist in `buffering` on the iPhone, and the
  buffering spinner, centred on the picture, took the tap, so it only woke the controls. The spinner now passes taps
  through (`pointer-events: none`). The gate's fallback (tap Remote when the first tap opens nothing) tapped an
  idled-out control bar, so the tap fell through to the picture; it now shows the controls first and records what lay
  under the first tap (`firstTap.tapTarget`).
- **Replays across a host sleep (5e, Task 7e).** Node's clock on macOS counts the time the machine sleeps. A replay
  (`replayPlayerBdj`, the local menu tests, the library check's runs) that the host slept through found every wait
  and timeout expired when it woke, and failed as a step or run timeout after about 1,000 s. That caused the ~1,100 s
  A_NEW_ERA runs and the four local tests that failed at ~1,000 s during 5e Tasks 7b and 7c: each run's wall time
  matches a lid-closed sleep in `pmset -g log`, and 120 loaded runs (76 of them jittered) never stalled. A turn of the
  replay loop over 20 s (`LOOP_GAP_MS`) now ends the run at once as void, naming the gap and the CPU used in it; a busy
  gap is reported as a blocked event loop instead. Keep the machine awake (`caffeinate -i`, lid open) for long local
  runs.
- **The BD-J start-up timeout counts only visible, awake time (5e, Task 7f, ruling R22).** The 20 s timeout (ruling
  R7: no playlist selected, no visible plane and no background still since the boot) is spent in ticks of at most 1 s
  (`STARTUP_TICK_MS`, `session.ts`) on the wall clock (`PlayerDeps.wallMs`, `Date.now`). While the page is hidden
  (the `visibility` command, sent at start and on every `visibilitychange`) no time is counted and no tick runs; a page
  shown again sets a fresh tick, since browsers throttle a hidden page's timers. A tick that comes 5 s or more later
  than it was set for (`STARTUP_SLEEP_GAP_MS`: the host slept, or the engine worker did not run) restarts the 20 s and
  logs `BD-J start-up timeout restarted`. A hang while visible and awake still falls back at 20 s, after the thread
  dump. *Revisit if* a blocked engine worker (not a sleep) turns out to hold a hung boot past 20 s for long: each
  restart needs a 5 s gap, so only a worker that keeps stalling for 5 s at a time would delay the fallback.
- **The BD-J start-up timeout does not count time the BD-J worker waits on its own I/O (5e, Task 7g).** A disc opened
  from the NAS had Java waiting on its JAR and resource reads (shared with the engine's clip read-ahead) for about
  87% of the counted time, about 10 s on a good link, so a slower link went past 20 s and fell back to the picker
  with nothing hung. The worker now sends `io` (pending or not) when it starts or stops waiting on a disc read, the
  storage scopes or FreeType and the fallback font (`IoWatch`, `bdj-worker.ts`). A change is sent at the next event
  loop turn only if it still holds, so reads answered from memory send nothing. While a read is pending the session
  counts nothing. The class library was never counted: the timeout is armed once it has arrived. The first
  playlist's log line gives the time counted and the time spent waiting on reads. A hang with no read pending still
  falls back at 20 s. The first `selectPlaylist` of a warm open over the NAS came about 11 s after Play; *revisit if*
  that matters: Java's disc reads could go ahead of the engine's clip read-ahead on NAS sources.
  - **No single timeout bounds a wait.** One HTTP read can take about 70 s or more: 30 s (`REQUEST_TIMEOUT_MS`), then a
    401 and a token refresh of up to 10 s, then another 30 s, and a 503 can add one more request. Each scope load
    can take 3 s (12.5 s on a NAS disc, ruling R28). The FreeType wait includes compiling it. Java may also retry a
    read that keeps failing, or read in a loop as its way of hanging.
  - **The ceiling is the real bound (ruling R26).** Waiting on I/O pauses the timeout for at most 120 s in all per
    boot (`IO_PAUSE_CEILING_MS`, `session.ts`). Past that it counts as usual and is logged once, so such a disc
    falls back 20 s of counted time later, with the thread dump. The legitimate waits measured on the NAS were
    8–18 s.
  - **After the timeout is disarmed or has fired,** the worker sends no more `io`. A selected playlist, a visible
    plane or a still disarms it (`StartupWatch`); the thread-dump request marks it as fired.
  - A worker that dies without an `onerror` while a read is pending falls back only through the ceiling.
  - *Revisit if* a disc needs more than 2 minutes of reads before it shows anything: it would fall back.
- **A context passed to doPrivileged is always honoured (5e, Ruling R20).** Our `doPrivileged(action, context)` keeps a
  caller-supplied `AccessControlContext` as the privileged context whoever made it. HotSpot honours one that is not
  authorized only when the caller's domain implies `SecurityPermission "createAccessControlContext"`; otherwise it
  replaces it with a single domain that has no code source and no permissions, so every check inside fails. Ours is the
  more permissive of the two, and only for xlet code that builds its own context and passes it to doPrivileged; no disc
  in the library check does. The conformance program `Security` avoids the case with a trusted caller.
- **BD-J worker slow-read log (Task 14b).** The BD-J worker logs a slow disc read only at RemoteSource's waiting threshold (`WAITING_AFTER_MS`, 3 s), with how long it waited; reads from picked files (FileSource) are not timed.
- **The BD-J library check (5e, `tools/bdj-library`).** Every BD-J disc in the developer's NAS library (166 of 2,340
  discs) runs one generic key script (`wait menu`, right, down, ok, `wait playlist any`) in our player and in
  libbluray's harness, from copied start-up files, with the real clips of the menu playlists where stub streams could
  not decide (about 43 GB read once, gently; four discs whose menu playlist is the feature stay on stubs). The latest
  full check (2026-10-21, no verdict changed from the check before): works 134, unconfirmed 14, libbluray-fails-too
  18, missing-class 0, unsupported-video 0, stall 0, diverges 0, error 0, of 166. The discs are named only by hashed
  ids, and the results stay outside the repo. What the verdicts can't say:
  - **libbluray fails too (18 discs).** libbluray in the harness (HotSpot under amd64 emulation, offline, with these
    keys) shows no menu, and neither do we. By cause: on 14 both players flush their plane but nothing on it is
    visible within 60 s (one of them on stub video, its menu playlist being the feature); on 2 neither draws at all;
    on 1 libbluray flushes an invisible plane while ours draws nothing (after the disc's failed BD-Live request its
    own UI code throws in ours); on 1 HotSpot crashes in libzip under emulation on every run, while ours flushes
    nothing visible. Some may be harness artefacts (emulation, no network, stub video on the capped disc) or need
    input the generic script doesn't give; only a native amd64 libbluray run or a check by hand on the device can
    tell.
  - **Unconfirmed (14 discs).** The menu shows and ours agrees with libbluray wherever both ran, but a key step
    was never compared: on 13 of them libbluray stops at its first step drawing nothing (with real video
    on most), and ours shows the menu but no reaction to a key libbluray never got to; on one, both menus keep
    repainting, so no key was tried (ruling R6). They are the list for the check by hand. On the real iPhone all 14 opened
    and 13 reached their menu; in Chrome 13 react to the arrows and Enter, and one plays a long opening video before any
    menu (in libbluray too), left for a check by hand (rulings R27, R34).
  - The check compares settled planes and the calls that start something (5d R3), so a difference in animation
    frames, timing or register writes in between is not caught. A key that changes nothing in both players counts as
    agreement (R5).
- **The device check of 5e ran on one real device (rulings R27, R33, R34).** It ran on 2026-10-22 on the user's
  iPhone over the live NAS, with the iPad Simulator as the second device (no iPad at hand): the two-person saved-data
  check passed, and the 14 unconfirmed discs opened. `tools/devices/live-check.ts`'s real touches miss on the
  iPhone's player screen (a probe showed the phone places touches exactly, so it is the tool's timing, likely a touch
  sent while Safari still scrolls), so arrows and Enter were checked in desktop Chrome. *Revisit* the tool's touch
  timing before the next device gate.
- **No HTTPS for BD-J (5e, ruling R13).** The class library has no JSSE (about 267 classes and 1.2 MB, a quarter
  more jar) for the one library disc that asks for an `https:` URL: Java finds no handler, the disc's BD-Live client
  catches the `MalformedURLException` and carries on, where HotSpot offline would fail later with another exception.
  The library check doesn't count that lookup as a missing class (`caughtGaps`). *Revisit if* a disc needs https to
  reach its menu.
- **Disc file names in the BD-J file system use a conventional spelling (5e, Task 7d).** `Vfs.discList` returns
  each disc file's name as an upper-case base name with a lower-case extension (`FileSource` upper-cases paths, and
  `Vfs`'s `originalNames` option is never passed), where libbluray lists the disc's own spelling
  (`MenuComposite1.png`, not `MENUCOMPOSITE1.png`). On the library disc where this showed, VFSCache then cached the
  file under the listed name, the disc's own `new File(dir, "...")` missed the cache and read from the disc
  instead, with no visible difference (patched to the real spelling, it behaved the same). *Revisit if* a disc
  compares listed names with its own constants: the original names would have to travel from the folder pick, the
  NAS and the WebRTC sources into the BD-J worker.
- **Playlist marks reach Java at presentation time (5e, Task 7d).** Ours reports a mark when playback presents it;
  libbluray's harness reports it at the read position, a few seconds earlier with stub or fast reads. A menu that
  waits for a mark appears a few seconds later in ours than in the harness. Not new in 5e. On one library disc
  libbluray also draws a First Play composite at about 0.9 s, before its BD-J title, that ours skips (`sync()
  ignored (overlay not open)`); the check doesn't compare that pre-menu plane, and it was not looked into.
- **Saved data (5e, `bdj/store/`): what can still be lost or late.**
  - **Browser store (ruling R16).** IndexedDB saves 100 ms after the last write (the plan said 2 s), the only way
    to keep a save made just before the page closes in Chrome and Safari, which drop the worker's pagehide flush and
    IndexedDB work started in pagehide. A write in the last 100-200 ms before closing can still be lost there.
    Firefox keeps the pagehide flush.
  - **NAS store (ruling R17).** A NAS disc's write goes to IndexedDB first (100 ms) and to the NAS 2 s later. There
    is no `keepalive` put on pagehide, so another device can miss the last seconds of a session until this device
    opens the disc again; this device loses nothing.
  - **The stop snapshot is what Java left.** On a stop (title change, close) the scope is saved as Java's files
    stand when it halted, possibly in the middle of a write.
  - **Merges keep the newer file, never a deletion.** A 412, or a pending copy pushed at the next boot, merges per
    file by mtime, so a file one side deleted comes back if the other still has it (inherent to the NAS contract).
    A boot that falls back to this browser's copy (NAS slow or unreachable) can show Java older data, and its later
    writes then win.
  - **A device moved to another person.** Saves made for person A that are still pending stay in that browser under
    A (`nas-person:<A>`) and are pushed only if the device is A's again: not lost, not pushed, never put into B's
    store. Every put checks `GET me` first and carries `X-Bdj-Person`, so a move mid-session is caught (409
    `person-changed`).
  - **The person header falls back once per session (ruling R25).** Servers from before the guard refuse
    `X-Bdj-Person` at the CORS preflight, so a write that fails that way is retried once without it, after a person
    check, and logged. Once a write with the header has succeeded, that BD-J session never falls back; the flag is
    kept per session, not persisted (that would need an IndexedDB version bump), so a new session's first write on a
    network failure can still fall back once after a person check.
  - **Quotas.** 16 MB per scope is counted as the NAS counts it, the ustar archive with headers and padding (ruling
    R24), so the write that crosses it fails in Java at once. The NAS's 256 MB per person is only seen as a 507 after
    the put, so Java gets the IOException on its next write; the write-ahead copy is kept.
  - **A slow or silent NAS at boot (ruling R28).** A NAS disc's boot gives the NAS 12 s for `GET me`, each scope's
    GET and the person check after it (three requests one after another, so about 4 s each); the wait counts as I/O
    for the start-up timer, whose 120 s ceiling bounds it. A slow link is not a dead one: each of the disc's own
    reads may wait 30 s or more (above), so a boot can go on while the store misses its budget. A scope the NAS
    doesn't answer in time loads this browser's copy. With none, the disc starts with no saved data, and what it saves
    is kept here as a pending copy marked `unmerged` (logged as an error at the miss). That copy is not put on the NAS
    in the same session; the next boot merges it with the NAS's files winning at every path both have (ruling R29),
    so only the files the NAS lacks are added, and logs how many of this browser's files it dropped. Java wrote it
    without seeing the saved data, so a fresh progress or settings file never replaces real saved progress; what
    Java changed in such a file that session is lost. An ordinary pending copy still merges newest-wins. A flush
    asks the NAS nothing for such a copy (no `GET me`), so a dead link logs only the miss.
  - **`GET me` not answering at boot (rulings R28, R30).** The disc starts with no saved data, never with what earlier
    such sessions kept, and the session only adds to a copy kept apart (`nas-unconfirmed:<API base>#<person>`) under
    the person the NAS last named for this device in this browser (`nas-device`, by API base). That copy goes into
    the person's own (onto an empty base when theirs is already on the NAS, so files deleted elsewhere don't come back)
    only at a boot where the NAS names the same person again, and then merges with the NAS's files winning (R29). A
    boot that names another person removes this NAS's copies kept for anyone else, and any other such copy last saved
    more than 30 days ago is removed at boot (the confirmed person's own is attached however old): those saves are
    lost, never given to someone else. The cleanup runs in the background and reads only keys and the age notes
    (`nas-unconfirmed-age`), never the files. If the device moves and its new person's first boot also misses `GET
    me`, their saves are added to the copy kept for the previous person, and go to that person only if the NAS names
    them again before it names anyone else. A device never confirmed in this browser (or on that route: HTTPS and
    WebRTC have their own API bases) keeps that session's saved data in memory only. After an attach onto an empty
    base, the person's copy in this browser holds only the attached files, so if that same boot's GET then misses,
    Java sees only those, not the older picture of the NAS (round 2, M2; the NAS loses nothing, and the next boot's
    merge restores what Java sees).
  - **A conflict's merge keeps Java's file only where Java changed it (review N7).** When a save meets a newer stored
    version, the stored file replaces Java's unless Java changed that file since the snapshot being saved (or Java's
    is newer). Under an open writable handle it is replaced in place, so the handle writes on into the live file; a
    write past the replaced length extends it, and one inside it overwrites part of the stored file.
  - **The stop waits 3 s for the save (`STOP_SAVE_WAIT_MS`).** On a stop (a title change, the disc closed) the engine
    waits at most 3 s for the BD-J worker's `stopped`, then terminates it (logged). The write-ahead copy in IndexedDB
    normally lands well within that, so a stop past 3 s usually loses only the NAS put of that last save, which goes
    at the next open (the copy is pending). Only if IndexedDB itself takes longer, as a strict commit on a busy iPhone
    might, are the writes since the last 100 ms save lost.
  - **What the viewer is told (rulings R32, R32a).** The notice "This disc's saved data can't be kept right now, so
    progress you make may be lost." (`bdj-storage`, once per disc open) shows at Java's first write (a file created,
    written or deleted) into a scope kept in memory only with no copy anywhere, never at boot, so a disc that never
    writes doesn't see it; and for a write refused for room (16 MB per scope, the NAS's 507, IndexedDB's quota, the
    VFS's memory cap) and a NAS put refused for good (a 4xx that is not a conflict or a request to wait; 401
    included). A missed boot that keeps an unmerged copy (R28), a 412 that merges, a put still being retried
    (unreachable, timed out, 5xx) and a device moved to another person (its saves stay in this browser) are log-only,
    since those saves last. What can still be lost without the notice:
    - **Writes outside the disc's scopes** (`/persistent/` or `/buda/` paths no BDJO or `id.bdmv` names) last only
      the session and are logged once as an error.
    - **A put the NAS refuses for good is retried every 30 s** (`NAS_PUSH_RETRY_MS`) for the rest of the session;
      the notice shows once, and the write-ahead copy stays pending in this browser.
    - **A loss found only by the stop's save** (the session has ended, so the worker sends nothing) shows no notice;
      it is logged, and the next open meets the same condition again if it persists.
  - **A disc without a disc ID** keys its BUDA scope by a fingerprint of its BDMV file list (ruling R15), so a
    re-ripped copy with other files starts with an empty BUDA scope.

## Audio

- **TrueHD and DTS-HD play through their lossy cores.** The output is a stereo 48 kHz downmix,
  so decoding MLP or XLL would not be audible. *Revisit if* multichannel or high-resolution output is added.
- **A play item without the selected audio stream** gets no audio units. The audio clock then behaves as for any gap
  in the audio (it can drop to buffering until video read-ahead fills). Blu-ray discs carry every stream in every
  play item, so nothing fills the gap. *Revisit if* a real disc shows it.
- **The last E-AC-3 access unit before the end of input is not played** (32 ms), because a group is emitted when
  the next one starts.
- **AC-3 at 44.1 or 32 kHz is ignored** (treated as no sync). Blu-ray AC-3 is always 48 kHz.

## Browsers and devices

- **BD-J on real discs is verified on every supported device class (5d gate, 2026-10-18).** Both local BD-J discs went from their first menu to the feature, by keys and by touch, matching libbluray's planes, on desktop Chrome, Mac Safari, Firefox (RENTAL_FAMILY only: no HEVC), iPhone 17 Pro and iPad Pro 12.9" 5th gen; the cross-browser spec's §3.9 is covered. Numbers are in the BD-J section. Chrome Android was not part of the gate (only Chrome's mobile emulation). A failed BD-J boot still falls back to the playlist picker.
- **No USB route for iOS in the 5d gate (ruling R18).** Folder picks on iOS copy every file first (below), so the iPhone and iPad gate ran over HTTP (the disc server, the NAS route's client path); Blob slicing beyond 4 GiB from a picked folder stays untested on iOS.
- **iPhone has no element fullscreen.** Use the installed app (Add to Home Screen); WebKit bug 206854.
- **No background audio on iOS.** Playback pauses when the platform suspends audio.
- **If WebKit reports the AudioContext `suspended` only after the page is visible again,** no pause happens and audio stays suspended while the engine plays, until the user acts.
- **Firefox Android is unsupported.**
- **Android HEVC and USB OTG are unverified.**
- **The iPadOS detection is the one user-agent exception.** `navigator.platform === 'MacIntel'` with touch points in `src/ui/memory-profile.ts`, because iPadOS reports a Mac.
- **Constrained memory profile: IG sub-paths over 64 MB don't preload.** The user sees "This disc's menus need more memory than this device allows." and the disc plays without menus.
- **Canvas-to-`<video>` fullscreen/PiP experiment, left open.** Capturing the canvas into a `<video>` might give iPhone fullscreen and Picture-in-Picture; not tried.
- **Full discs can't practically be opened from a folder on iPhone or iPad.** Safari copies every picked file out of the Files provider before the page sees it: measured on iPadOS 27, a 0.40 GiB clip from a USB drive took 61 s (about 7 MB/s), so a full disc takes an hour or more on every open. No web API avoids it. The landing screen explains the wait after 1.5 s; iOS watching goes through the NAS (spec steps 2–3).
- **Offline when the network answers with an error page (fixed).** Found in the tailnet offline test: an origin that had stopped serving still answered the reload with "404 page not found" over the open connection, and the service worker passed it through. A 404 or 5xx answer to a navigation now gets the cached app, as a network failure does (`src/sw.ts`, `tests/e2e/offline.spec.ts`).
- **Touch pointerup at (0, 0) on the iPad (fixed).** Under remote automation, iPadOS 27 Safari reported a touch's `pointerup` at clientX/clientY 0,0 while `pointerdown` and the synthesized `click` had the real position; taps on menu buttons missed and double taps all fell in the left third. Taps now take their position from the matching `pointerdown` (`tapPoint` in `src/ui/touch.ts`). Whether real fingers do the same is unconfirmed; the fix holds either way.
- **Probe-dependent steps: none needed on the iPad.** It runs the AudioContext at 48 kHz, has worker `requestAnimationFrame` (p95 18.9 ms) and canvas `letterSpacing`, so no resampling, main-thread frame tick or letter-spacing fallback was built. It lacks canvas `filter`, so ASS blur takes the mask path (Task 13). Re-check on the iPhone when convenient.
- **Playwright reuses a running preview server on :4173 locally** (`reuseExistingServer`); stop a stale one after changing source.
- **WebKit on Linux CI runs no real-time playback tests.** On GitHub's GPU-less runners, Playwright's Linux WebKit missed a different set of timing windows on every run (frames presented, remote presses, pauses landing), even on a runner of its own. Tests that need real-time playback skip there (`LINUX_WEBKIT_REALTIME` in `tests/e2e/support.ts`); the landing, capability, folder-picking, layout and offline tests still run. They all run in WebKit on macOS, and real Safari is covered by the real-device test.

### Device probe results

Fill in from `probe.html` on each device.

| Device | Browser/OS | blob-slice-over-4gib | audio-sample-rate | audio-session | worker-raf | hevc | webgl2-float | canvas-filter | letter-spacing | fullscreen | webkitdirectory | relative-path |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| iPad (2026-10-17) | Safari 27.0.1 (iPadOS, desktop UA) | untested (no clip over 4 GiB handed over) | 48000 | present | rAF, p95 18.9 ms | Main and Main 10 (5d gate, 2026-10-18) | float and half-float | **missing** | works | yes | yes | paths kept |
| iPhone 17 Pro (2026-10-18, 5d gate, not the probe page) | Safari 27.2 (iOS 27.2) | untested (disc server route) | untested | untested | untested | Main and Main 10 | untested | untested | untested | untested (no element fullscreen, above) | untested | untested |

## NAS server and title library (step 2)

- **The Caddy Tailscale certificate is manual.** The certificate behind the owner's Tailscale address was issued by hand on Aug 31 and may lapse around late November; when it does, every site behind Caddy stops, not only this app. *Revisit* before then: renew it, or let Caddy fetch and renew its own Tailscale certificate.
- **A drive that is gone for good keeps showing its last discs.** A root whose folder is missing or empty keeps the discs of its last scan, so a drive that is briefly unmounted doesn't empty the library; a drive that is removed for good is never dropped. *Revisit if* that confuses the owner (a "remove this drive" action would fix it).
- **A drive mounted late is writable inside the container.** `read_only: true` in the compose file covers only the binds present when the container starts; a late `nofail` mount that appears through `rslave` propagation is not read-only. The server only ever writes `/data`, so nothing is written there, but the guarantee is by code, not by the mount.
- **An iPhone Home Screen web app has its own storage,** so it needs its own pairing (a pairing made in Safari does not carry over). Pairing links open in Safari, not in the installed app: type the code in the app instead.
- **TheDiscDB covers few releases.** About 7% of the library's folder discs are in it, and almost no Japanese releases, so most episode lists are guessed from playlist lengths (`titles/episodes.ts`). A season whose guess doesn't add up (the total isn't the season's episode count, or a disc can't be ordered) shows its discs only, with no Episodes tab.
- **The first matching run takes hours.** AniList's rate limit (30 requests a minute) paces the first pass over a library of about 2,300 discs. The service checkpoints as it goes and resumes after a restart, and the catalogue is served meanwhile.
- **The lookup limits are per device and kept in memory.** They reset when the server restarts.
- **Residual matching risks, accepted after review and covered by the owner's spot-check:** an animated series that is not on AniList but shares its base name with an entry that is, with enough seasons for the season number to fit, can be filed under the wrong entry; and a box set whose box 1 is missing its last disc can have its later discs placed one slot off. *Revisit if* the spot-check finds either.
- **Playwright 1.64's `setInputFiles` race.** Passing a folder to `setInputFiles` or `FileChooser.setFiles` can miss the input's event in Firefox and hang; `setFolder()` in `tests/e2e/support.ts` works around it. *Revisit when* Playwright 1.65 is adopted (drop the helper if it is fixed there).
- **Local Network Access (spike, 2026-10-17; `docs/superpowers/specs/2026-10-17-nas-lna-results.md`).** The tailnet address counts as private, so browsers apply local-network checks. Chrome 155 and Firefox 158 ask once per origin and hold the first fetch until it is answered (Chrome was still pending after 70 s, Firefox waits up to 300 s); a Block looks like an unreachable server (`TypeError`), and headless Chrome is denied at once unless `grantPermissions(['local-network-access'])` is given. Safari 26.6.2 on the Mac and Safari on the iPad show no prompt. Remote reads run in the module worker (`transport: 'worker'`): the worker's own request raises the prompt. How long a grant lasts across sessions wasn't measured, and the iPhone wasn't measured (safaridriver couldn't connect).
- **A hostile client can lock a NAS's devices out of signalling for a minute at a time.** The rendezvous Worker allows 100 device connection attempts a minute per NAS (`rendezvous/src/signalling.ts`) and 10 a minute per client address. A client with more than ten addresses can fill the NAS's window, and then that NAS's devices get 429 until the minute passes; it can repeat this. The NAS's own socket isn't counted, so the NAS stays connected. *Revisit if* it happens (for example, give paired devices a separate allowance by proving their device id).
- **The local-network prompt can send a device on the LAN to WebRTC (deliberate).** For a pairing that knows its NAS's WebRTC id, the route choice (`src/ui/nas/route-choice.ts`) gives HTTPS 2 s to answer `GET health` before it picks WebRTC. Chrome and Firefox hold that request behind their Local Network Access prompt (see above), so a device whose prompt is still open after 2 s connects over WebRTC, across the LAN, and keeps that route until the page is reloaded or the connection breaks. That costs a WebRTC setup, not a failure, and the HTTPS-first 2 s rule is the plan's. Pairings stored before WebRTC have no id until their first `me` gives it (`nasId`, stored on the pairing); until then they keep step 2's 20 s first-request wait. *Revisit if* devices on the LAN end up on WebRTC often (for example, wait for the prompt's answer before choosing).
- **The read-ahead cache is one per origin, not per tab.** OPFS is shared by every tab of the app, and a sync access handle is exclusive. A second tab that opens another NAS disc clears the first tab's cache folder when it opens (`clearOthers`); while the first tab holds handles on its files the removal fails and is skipped, but the folder can be removed between its writes, and its next write then fails. Two tabs on the same disc compete for the same files: the second one's writes fail (`NoModificationAllowedError`). In both cases that tab's fill treats the failed writes as a flap and retries them (1 s, 2 s, 4 s, then every 10 s), playing with pauses meanwhile; after two minutes of failures without a break it ends with `stopped: 'failed'` and the player says "Couldn't buffer on this device, so it will play with pauses." Nothing is served wrong, because reads only return ranges that tab's own index says it holds. *Revisit if* people buffer in two tabs at once (a Web Lock per disc, or a folder per tab, would fix it).

- **The WebRTC route has been measured across continents only through a VPN.** On 2026-10-19 (the step 3 spec's status line) an iPhone on mobile data paired and played over WebRTC (18 Mbps at pre-flight), and through a VPN exit in Tokyo a Mac on home internet measured 17 Mbps at a 222 ms round trip, while the iPhone on mobile data through the same VPN got 2 Mbps, the limit of that path rather than the route. No friend abroad has played from the NAS yet. *Revisit when* one does: record their throughput and start-up there.
- **The relay's usage is an estimate.** The NAS counts bytes per ICE pair from werift and classifies relayed pairs by the device's relay candidates, so the monthly allowance can differ from what Cloudflare bills. TURN credentials the Worker mints stay usable for an hour outside a session, and the NAS never sees that use. The allowance is a guard, not a bill.
- **Deploy the NAS right after the Worker (deploy order).** Once CI deploys a Worker whose `POST /codes/lookup` answers `routes.webrtc`, every code advertises the WebRTC route, but a NAS still on the release before it keeps no signalling socket, so a device that picks WebRTC gets `nas-offline`. Run `npm run server:deploy` as soon as CI has deployed the Worker; the gap is the minutes between the two.
- **The answer SDP shows the NAS's addresses to anyone holding its nasId.** A device that opens signalling with a NAS id gets an answer listing the NAS's public IPv4 and its LAN address (`RTC_LAN_ADDRESS`) as host candidates, before any pairing or session; the id travels in every code lookup and pairing. *Revisit if* that matters (for example, answer only offers that carry a device proof or a live code's hash).
- **The server image grew from 82 MB to about 730 MB unpacked for the quality levels' ffmpeg.** It installs Debian 13's own `ffmpeg` (7.1, built with oneVPL), `intel-media-va-driver-non-free` (the iHD driver) and `libmfx-gen1.2` (the oneVPL GPU runtime), which the NAS's N150 (Alder Lake-N) needs for Quick Sync; `ffmpeg` pulls in about 500 MB of libraries, most of them (SDL, PulseAudio, X11, codecs the levels never use) for `libavdevice` and features the server doesn't touch. Until 2026-10-27 the image used jellyfin-ffmpeg7 instead, because Debian 12's ffmpeg (5.1, legacy Media SDK) can't drive that GPU; that build linked libfdk-aac, whose licence the FSF considers GPL-incompatible, so the published image would not have been redistributable. Debian's build links no non-free codec. On the NAS GPU it passed the encoder self-tests and every level pipeline (scaling, HEVC 10-bit, MPEG-2 deinterlacing, HDR passthrough and tonemapping to SDR, software decode with upload), its tonemapped pixels match jellyfin-ffmpeg's within 0.6% mean luma, and its QSV filters move PTS exactly as jellyfin-ffmpeg's did. A slimmer ffmpeg (a build of our own with only what the levels use) would cut the size; not done.
- **Continuity-counter jumps on level streams are expected noise in the `continuityErrors` telemetry.** A level keeps an audio track's core (`server/src/levels/audio-core.ts`): the counters of a kept PES run on from its source packets, so where TrueHD's MLP units or a dropped DTS-HD extension sat between two kept PES, the counter jumps at the next PES start. Every Blu-ray audio PES declares its length, so the demuxer has already handed the PES over before the jump and loses nothing, but it counts the jump in `continuityErrors`. The re-encoded video's counters don't jump: each interval's video takes a multiple of 16 packets (`server/src/levels/remux.ts`), so they run on from one interval to the next. *Revisit if* the telemetry is used to judge a level's stream (renumber the kept PIDs' counters per interval, or ignore jumps at a unit start).
- **Quality levels: a forced keyframe misses its EP entry if a build's PTS rounding comes within about a tick of a whole frame.** ffmpeg 7.1's QSV filters (`scale_qsv`, `vpp_qsv`; Debian's build and Jellyfin's alike) round every frame's PTS down to their frame-rate grid counted from 0 (a 23.976 frame at 378 000 000 becomes 377 998 871), which no ffmpeg option undoes; software decoding or encoding on either side of them keeps the PTS, and so do other builds. The encoder (`server/src/levels/encoder.ts`) gives every encoded frame back its source frame's PTS (the smallest source PTS at or after it, from the bytes it pipes to ffmpeg), so the levels stay on the source clock. ffmpeg also forces keyframes on the rounded PTS, so each EP entry's keyframe is forced one microsecond after its exact frame PTS less the clip's shortest frame time (the scan probe's, at most the CLPI rate's). That lands on the entry's frame unless the rounding takes off nearly a whole frame: source PTS are whole 90 kHz ticks against a 3753.75-tick grid at 23.976, so the band where it misses is about 1 to 1.5 ticks (11 to 17 µs) wide, and a clip whose PTS origin is a whole number of 23.976 frames from 0 (an origin derived from a timecode) is certain to land in it. 29.97 sources and deinterlaced 1080i (a whole-tick grid of 3003) are immune. Such a run gets its keyframe a frame late and fails loudly ("doesn't start with an IDR") rather than serve a wrong stream. *Revisit if* a run fails that way on a real disc: scale such clips in software, or `hwdownload` before scaling, so the QSV filters never round the PTS.
- **Quality levels: a level's EP entries are at least 2 s apart, and an overflowing interval loses subtitles.** The plan merges EP intervals under 2 s (`MIN_INTERVAL_45` in `server/src/levels/levels.ts`), so a seek at a level lands up to 2 s before where it would on the original, and keyframes are forced only at the kept entries. A merged-away entry that was an angle change point (multi-angle clips) is gone from the level too; the engine plays angle 0 only, so nothing uses it today, but an angle switch at a level would wait for the next kept entry once angles are supported. When an interval's kept packets still don't fit its budget with its video at the floor rate, the re-mux drops whole PES from it, PG streams first from the highest stream number and IG (menus) only once every PG stream is gone (`shedGraphics`; PG drops logged once per clip, IG drops every time), then tries 250 kbps; an interval that fits at no rate answers 500 (remembered until a restart); on 12 sampled discs no interval needed the drop. *Revisit if* the log shows it on real viewings (raise `PG_EXTRA_BPS` or `GRAPHICS_BURST_BYTES`), or seeks at a level feel coarse.
- **Quality levels: VC-1 is decoded in software on the NAS.** jellyfin-ffmpeg 7.1's `vc1_qsv` decoder dropped frames (not measured again with Debian's ffmpeg, which the image uses since 2026-10-27) (140 of 144 in a 6 s run of a progressive 23.976 disc, the first I-frame among them), so a run never reached its next interval. The encoder (`server/src/levels/encoder.ts`) decodes VC-1 with ffmpeg's `vc1`, uploads the frames (`format=nv12,hwupload`) to the QSV scaler and encoder, and runs that ffmpeg at nice 10 so the decode yields the N150's four cores to the server. Measured on the NAS: 2.5 to 2.9× real time per viewing at 1080p, about 1.35 cores while it runs (QSV decode was 9.4×). Two VC-1 viewings at once at Phone kept ahead (3.5× and 4.3×); three or more may fall behind. *Revisit if* a jellyfin-ffmpeg update fixes `vc1_qsv` (the decode test in `encoder.test.ts` names the decoder), or VC-1 viewings stall under load.
- **Safari can't say a connection is metered, so an iPhone on mobile data loads every poster over HTTPS.** The library loads posters on screen first, then within two screens of scrolling, then the rest (`src/ui/nas/load-queue.ts`); the rest only over HTTPS on a connection the browser doesn't report as Data Saver, cellular or 3G and below (`poster-reach.ts`). Only Chrome reports the connection, so Safari on mobile data, reaching the NAS over HTTPS through Tailscale, loads them all (about 75–140 KB each). Over WebRTC or the relay posters always wait until they come within scroll range.
- **The gojūon bar reads kanji titles through their romaji.** A title's reading is its kana native name, else its AniList romaji read as kana (`src/ui/nas/title-index.ts`); a romaji with English words in it, or a reading that differs from the romaji, sorts a little off within its row, and a title with no kana and no romaji (most TMDB titles) goes to 他.
- **On iOS 27.2 beta a finger on the alphabet bars sends the tap's click but not its pointer pick, so dragging along a bar doesn't scroll through the keys there.** The bars jump on `pointerdown` and follow a drag with pointer capture (`src/ui/nas/AlphabetRail.tsx`); on an iPhone 17 Pro on iOS 27.2 beta a tap did nothing until each key also jumped on its click (when no pointer pick came in the last 700 ms). The iOS 26 Simulator gets the pointer events, after scripted and finger scrolls alike. `?touchlog=1` shows what a phone delivers. Taps work everywhere; the drag needs a later iOS build to be checked again.
- **Resume of an HDMV title is an approximation.** A place restores the registers (PSRs and GPRs) and the playlist time, and starts the title at its playlist (`Navigator.resumeTitle`); it does not restore the VM's exact program counter or the IG page. After the resumed playlist ends, the program continues after the PLAY_PL it was matched to (pc + 1, the first PLAY_PL in the title's movie object that names the playlist), not from the title's entry, so a disc whose program reached that playlist another way, or whose code depends on state the VM held, may show a menu or run its code a little differently than where you stopped. BD-J discs resume directly at the playlist, with BD-J off.
- **Subtitle store: cancelling the encoding prompt of a stored pick still shows the failure notice after 10 s.** `StoredSubtitlePicker` waits for the text set to report the file; when the user cancels the encoding prompt it never does, so the "couldn't add" notice appears once the wait (`TEXT_WAIT_MS`, 10 s, restarted after the prompt is answered) times out. Harmless, and the menu stays usable.
- **Subtitle store: a chapter upload stored without its title is on no owner screen once its disc is gone.** The title screens list a title's uploads by `titleId` (`GET /api/subtitles?titleId=`): an attachment's stored title id, and the title's disc keys for chapter uploads and for episode uploads whose own title id is gone (a rematch gave the disc another id; they show as not attached, so Edit re-attaches them). A chapter upload stored without a title id whose disc is no longer listed matches neither, so the owner can't see it from the app; viewers don't get it either, since it is not attached. *Revisit if* that happens in practice: add an owner screen of every upload.
- **Subtitle store: an episode upload whose season id changed is listed to owners as not attached, though viewers still get it.** An episode attachment names a season id as well as the disc key and playlist it resolved to. If a rescan or an owner's change gives the season a new id, the NAS still marks the upload `attached` (its disc and playlist resolve, so it stays in the player's Subtitles menu for everyone), but it matches no season screen; the owner's title screens (`ownerListing` in `src/ui/nas/subtitle-model.ts`) list it under "Not attached" on each of the title's screens, marked so that Edit attaches it again. It isn't re-attached by guessing, and the episode language tags leave it out.
- **Quality levels: a disc program's own audio choice at a level is ignored.** When PSR1 names an audio track the level doesn't carry, the level's track keeps playing. Audio changes at a level go through the player's Audio menu, which reopens the level with that audio. A switch back to Original keeps the track heard at the level (the `setLevel` command's `audio`) and sets the program's PSR1 to it, as an Audio menu pick would.
- **Quality levels: the level Audio menu doesn't honour the disc's `primaryAudioChange` UO mask.** A level audio switch reopens the disc, so it is not a stream change the mask can block.
- **Quality levels: "phone" in the auto rule is a size, not a device type.** It means the constrained memory profile or a screen whose shorter side is under 600 CSS px (phones are 320-440; 1280x800 and 1440x900 laptops are not phones).
- **Quality levels: the levels request waits up to 10 s,** then the pre-flight offers Original only.
- **Quality levels: a level switch during a BD-J time still restarts the still's timer.** The switch restarts the playlist session (`setLevel`), which lets the still go and meets it again, so a play-item time still lasts up to its `stillTime` longer; nothing hangs and Java sees no second report (HDMV programs are told once). Carrying the remaining time across the restart would remove it.
- **Quality levels: the play route is pushed when the disc opens, not at the click.** At a level the pre-flight first fetches the level's manifest; a busy refusal then leaves the address bar where it was. Original opens push it after the session round trip, just before the open.

- **Music shelf: a folder scan over 5 MB is skipped.** `titles/folder-cover.ts` takes no image over 5 MB and the NAS resizes nothing, so a release whose only scan is larger shows the Cover Art Archive or Discogs image, else the ♪ tile. *Revisit if* many releases fall back to ♪ for this reason.
- **Music shelf: MusicBrainz knew about two thirds of the library's music by catalogue number** (43 of 67 when designed). The rest are named from their folders (grouped by artist name, kind from the folder hint) and the owner can set an artist by hand. Discogs (with `DISCOGS_TOKEN`) fills some of the gap. *Revisit if* the shelf has many name-only artists the owner has to fix.
- **Music shelf: a rejected match lasts until the owner undoes it.** "Not this release" stores `rejectMatch` for the disc's group, so a later, better MusicBrainz or Discogs entry is never tried for it, and a rename keeps it. *Revisit if* owners reject matches they would want retried.
- **Music shelf: a concert's name shows on its artist-page card, the release title elsewhere.** Recently added and the title page use the release title (`displayName`); the artist card shows `concertName` for a concert. Search finds a release by either. *Revisit if* the two names confuse.
- **Music shelf: the browser's (or the system's) Back from a pre-flight opened on an artist page returns to the shelf,** not the artist page. The pre-flight's own Cancel returns to the artist page. *Revisit if* it annoys on a long grid.
- **Music shelf: moving an artist's last release away returns to the shelf.** Set artist and Not this release leave the artist page open (`ArtistPage` only closes the form and refreshes), but when the moved or rejected release was the artist's last one its group no longer exists, and `MusicScreen` calls `onArtistGone`, which goes back to the shelf. *Revisit if* owners expect to land on the release's new artist.

- **Fansubs: alignment reads sampled stretches of the audio,** so a cut between two sampled stretches can be missed.
- **Fansubs: with real fansub timing (lead-in and lead-out), split alignment rarely fires,** so an episode with a cut usually comes out "couldn't line up · set by hand".
- **Fansubs: font packs are fetched through `animetosho.net/download/`,** which its robots.txt asks crawlers to avoid. The owner approved fetching each pack once, paced and cached.
- **Fansubs: Anime Tosho skips most torrents over 25 GB and never mirrors private trackers,** so many of SeaDex's best Blu-ray batches have nothing there. When the best release isn't on Anime Tosho, the NAS falls back to the WEB release SeaDex lists for the title (the streaming-service release fansubbers often start from), then to SeaDex's other releases; the WEB release is usually there.
- **Fansubs: both services are volunteer-run.** animetosho.org stopped in May 2026 and .net is its successor. The base URLs are settings (`SEADEX_URL`, `TOSHO_FEED_URL`, `TOSHO_URL`). *Revisit if* either moves again.
- **Fansubs: resuming after the NAS dropped a viewer's Anime Tosho pick is bounded by 15 s,** while rebuilding it (fetch and line up) can take longer. The first resume may say it couldn't load the subtitle; the next works.
- **Fansubs: the `mobile-chromium` Playwright project doesn't run `tests/e2e/nas.spec.ts`,** so the player search's phone layout was checked by hand once.
- **Local fonts (`queryLocalFonts`) were dropped** by the owner's choice; fonts come from Anime Tosho or are added by hand.

## Resolved (for reference)

- **Resolved: Music shelf: library-wide search didn't match a looked-up title (2026-10-22).** `searchNames` (`src/ui/nas/title-model.ts`) now reads a release's title, concert name and artist names as well as the folder-derived ones.
- **Resolved: Music shelf: Various artists was not last in the 五十音 alphabet order (2026-10-22).** `artistIndex` (`src/ui/nas/artist-model.ts`) keeps it last after `japaneseOrder`, as in A–Z.

- **Resolved: the quality levels reached the UI (phase 2, 2026-10-22).** The pre-flight picks a level, the player's Quality menu switches it, and the owner's admin screen lists what the GPU is encoding.
- **Resolved: a place saved at a pause trailed by up to 250 ms (2026-10-21).** The engine reported time every 250 ms, so a pause saved the last report. A pause now sends the stopped clock's exact time before the `paused` state (`Player.pause`).
- **Resolved: an upload whose title id changed was hidden from the owner's title screens (2026-10-21).** A title's listing now includes episode uploads by its disc keys when the title id they name is gone (`routes/subtitles.ts`); they show under "Not attached", where Edit re-attaches them.
- **Resolved: subtitle upload progress was reported only at the end (2026-10-21).** fetch can't report a body's progress and Safari can't stream one, so an HTTPS upload goes through XMLHttpRequest's upload events, and over WebRTC the body is counted as the channel reads it (`src/ui/nas/upload-progress.ts`).
- **Resolved: two flaky server tests (2026-10-21).** `server/src/rtc/peer.test.ts` ("refuses a fifth offer…") waited
  on the internet: werift falls back to `stun.l.google.com` when a peer connection has no STUN server, and
  `setLocalDescription` waits for that query, so every answer took a round trip to Google, and on a slow network the
  answers outlasted the test's 300 ms `unopenedMs` ("the peer closed while answering"). The tests now run a loopback
  STUN server. `server/src/auth.test.ts` ("lets an owner list, mint, delete and revoke") ended while the rescan it
  started was still writing `library.json` under the temp folder, so `afterEach`'s `rmSync` sometimes failed with
  `ENOTEMPTY`; the test now waits for the scan.
- **Resolved: large animated text missed the libass pixel budget without GPU canvas rasterization (2026-10-16).**
  The cause was not glyph rasterization but the direct path for runs reshaped every frame: it shrank its
  supersampled canvas with `drawImage` at `imageSmoothingQuality = 'high'`, which Chrome filters differently on CPU
  and GPU canvases (`anim` at 2500/2999 ms gave 736 and 526 differing pixels against 326 and 381 with
  `--disable-gpu`, plus the spin at 5000/5500 ms). The factor is now a power of two halved in bilinear 2:1 steps,
  the same 2×2 box filter as the mask path, so all fixtures pass with and without the GPU on macOS Chrome. The
  `ass` CI job passes on the Linux runners and gates the deploy again; `ASS_BUDGET_SCALE=8` still covers the runners'
  draw time.
- **M4b porting bugs found by the TSURUNE gate (fixed in the port, 2026-10-15).** Runs were snapped to 1/8 px by
  each glyph origin instead of libass's rounding of the first inked glyph's box centre; TrueType fonts that force an
  integer ppem had their ascender and outline size rounded too (only hinted advances are), which put whole lines
  1/32 px high; a fade counted as a shape change, sending the first opaque frame through the 1× direct path. The gate
  went from 66 layout and 112 pixel failures to only the auto-hinter exception above.
- **M4b review fixes (2026-10-15).** The cached coloured layers left the shadow offset out of their key, so two runs
  differing only in `\shad`/`\xshad` (or a `\t` on the shadow distance) drew the shadow at the first one's offset;
  the static event cache was bounded by count only (64 full-frame drawings could hold ~530 MB) and is now also
  bounded to 128 MiB; the controller imported its file sorting from `src/ui` (moved to `src/player/drop-files.ts`);
  subtitle rows were keyed by file name, which collides for same-named files from different folders.
- **ASS rendering differences from Chrome's canvas, found by the TSURUNE gate.** Canvases created with
  `willReadFrequently` (CPU) approximate `blur()` with box passes: deviations under 0.8 px do nothing and larger ones
  step, so mask blurs are a Gaussian in JS. Both CPU and GPU canvases snap the baseline of text under ~256 px to whole
  device pixels (see above). Canvases that are only drawn into are GPU-backed: read-backs of the composited output
  were most of the animated draw time (p95 15 ms → 4 ms).
- **"Underruns" at the end of a playlist were the stream ending, not dropouts.** The output keeps running until the
  last video frame (plus 100 ms) so the clock can finish the picture, and every silent quantum after the audio ran out
  counted as an underrun (about 50 per playlist end; TSURUNE showed 57 from its First Play logo ending). Once all of
  a stream's audio is written the ring is marked draining and that silence is not counted; starting playback clears
  it. The local-disc gate now requires 0 underruns.

- **Milestone 3 real-disc gate passed (2026-10-15).** TSURUNE_TSUNAGARI_1 (HDMV) boots through First Play (a logo,
  then the 119 min feature); Top Menu opens its menu, Enter starts the feature, and its three LPCM tracks play in
  sync with 0 decoder errors. `npm run vm-trace` matches libbluray on TSURUNE for menu → feature (113 entries) and
  pop-up open → close (65 entries), plane hashes included. A_NEW_ERA and RENTAL_FAMILY (BD-J) still open to the
  picker (5c: no longer) with their main features, all tracks in sync.
- **Main-path menus muxed at a clip's start now show.** Playback started the first play item at its first EP map
  entry, skipping an IG display set muxed ahead of the first keyframe, and a PES was only complete at the next unit
  start on its PID, so a menu's last segment waited for the end of the clip. Both now follow libbluray (`_fill_clip`
  packet 0 for first and seamless items; `m2ts_demux` completion by `PES_packet_length`).

- **Looping playlists are no longer picked as the main feature.** BD-J discs can carry playlists that play one
  segment hundreds of times (A_NEW_ERA and RENTAL_FAMILY: `00149`, about 250 min). That one is the BD-J menu's
  background loop (seen in the BD-J spike and the 5b traces), not a decoy maze as first assumed; skipping it for the
  main feature remains right. The main feature is now chosen
  as libbluray's title list does (`disc/main-title.ts`, from `navigation.c`): loops (any segment more than twice)
  and exact duplicates are skipped, then chapters, video, HD audio, duration and stream count decide. The main
  feature is listed first, loops last. Differences: HD audio is judged by coding type (libbluray compares the
  channel-layout field there, which never matches), BD-J "known playlist" hints are not used, and a full tie goes
  to the lower playlist number. The local-disc tests now play `00040` and `00800`.

- **Milestone 2 real-disc gate passed (2026-10-13).** All 10 playable tracks of A_NEW_ERA `00040` (TrueHD core,
  3× AC-3; HEVC video) and RENTAL_FAMILY `00800` (DTS-HD MA core, 5× AC-3) played in Chrome at the local bounds
  (worst 16.9 ms mean / 34.5 ms max), with 0 decode errors and no underruns; each also decoded cleanly in Node
  at 0% and 30% into the film. Since the main-title fix, `LOCAL_DISCS=1 npx playwright test local-discs` covers
  these tracks directly. Not covered by a real disc yet: E-AC-3 and plain DTS (synthetic only for DTS).

- **File version checks** now match libbluray's `bdmv_parse_header`
  (`0100`, `0200`, `0240`, `0300`), checked against a libbluray clone at 448f896.
- **CLPI coding type `0xa0`** reads a stream language, as libbluray does.
- **Case-colliding disc file names** (for example `00001.m2ts` and `00001.M2TS` in one folder)
  are now refused with a `case-collision` error that names both files.
  Before, one of the two was dropped silently.
- **Open-GOP leading-picture skip is verified on the real disc.**
  78 of 123 sampled entry points on `TSURUNE_TSUNAGARI_1` are non-IDR recovery points with leading pictures.
  In Chrome (which reports hardware H.264 support on this machine), 8 seeks all started on open-GOP keyframes
  and skipped 15 leading pictures, with 0 decoder errors and 0 audio underruns.
  The decoder now reports `openGopStarts` and `leadingPicturesSkipped` in telemetry,
  and `LOCAL_DISCS=1 npx playwright test local-discs` repeats the check.
- **The audio worklet's BigInt counter write was measured.** The BigInt load and store take about 21 ns (Node, Apple silicon).
  A whole `renderQuantum` takes under 0.4 µs (this figure includes the writer's work).
  That is under 0.02% of the 2.67 ms budget per 128-frame quantum at 48 kHz, so the counter was kept.
- **The fake `VideoDecoder` can deliver output late** (`asyncOutput` and `deliver()`, with `reset()` leaving
  queued output in place). The fake exposed a real gap: a frame from before a seek that arrived after `reset()`
  would have been presented. `WebCodecsVideoDecoder` now passes on only frames whose chunks it fed since the last reset.
- **The chapter guard is checked directly.** Tests cover skipping a chapter that starts under 0.5 s ahead.
  They also check that "next chapter" on the last chapter leaves the clock advancing,
  with no state change and no seek.
- **The `fsevents` install-script warning** is silenced (`"fsevents": false` in `allowScripts`).
- **Abandoned prefetch reads are cancelled.** `ByteSource.read` takes an `AbortSignal`.
  With a signal, `FileSource` reads through `Blob.stream()`, which measured as fast as `arrayBuffer()` in Chrome
  (200 MB in 84–98 ms vs 83–97 ms on the local disc). `PlaybackPipeline.stop()` and each new item cancel the old reader.
- **Holding or slowly dragging the seek bar snapped back.** On release Chrome can fire a trailing `change`
  after `pointerup`. Once the drag value had been cleared, it carried the old playback time, which seeked back there.
  The seek bar now holds the committed target until the engine reports reaching it, and ignores that repeat.
  Holding a control also keeps the controls from hiding.
- **E2E A/V sync bounds on CI.** The tests stay at 20 ms mean and 50 ms max offset locally (macOS: 11–15 ms and 21 ms).
  Ubuntu 24.04 containers with a PulseAudio null sink measured up to 15 ms mean and 41 ms max on native arm64,
  and up to 19 ms mean and 41 ms max on emulated amd64, which is close to the bounds.
  CI (`.github/workflows/ci.yml`) therefore runs with `SYNC_TOLERANCE_SCALE=1.5` (30 ms / 75 ms).
  *Revisit if* GitHub runs log `sync stats` well inside 20/50 ms, then drop the scale back to 1.
- **A stalled audio output now recovers by itself.** With two Chromes starting audio on one PulseAudio null sink
  (CI's two Playwright workers), the output took over 500 ms to start (heartbeat 8 after 1.2 s), so the stall
  detector moved playback to the wall clock. Audio came back only on the user's next seek or resume, which
  failed the disc3 audio E2E on CI. When the heartbeat moves again during playback, the player now queues a seek
  to the current time, which puts the clock back on the audio output. Reproduced and verified in an Ubuntu 24.04
  container (`--workers=2`): 4 of 4 runs pass with the fix, and the test fails without it.
