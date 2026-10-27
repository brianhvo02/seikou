# bdj-trace: libbluray BD-J native-call trace harness

Runs a disc through real libbluray with BD-J enabled (OpenJDK 8, the `j2se` stack) and prints every JNI native call that libbluray's Java stack makes, so the TypeScript JVM's calls can be compared against it.

- `Dockerfile`: ubuntu 24.04 (pinned by digest, linux/amd64) with apt pointed at snapshot `20261015T000000Z`, libbluray cloned at `448f896`, `trace.patch` applied, built with meson and `-Dbdj_jar=enabled`, and `bdj_trace.c` linked against the installed library. `ca-certificates` is installed from the live archive first, because the https snapshot service needs it and the base image has none.
- `trace.patch`: changes two files of libbluray and nothing else.
  - `src/libbluray/bdj/native/org_videolan_Libbluray.c`: each of the 20 `Java_org_videolan_Libbluray_*` functions computes its result into a local, then prints one trace line through `bdj_trace()` before returning. `bdj_trace()` prints the line, flushes, and, when `BDJ_TRACE_UNTIL` is `<call>` and this is that call's first line, or `<call>#<n>` and this is its n-th, calls `_exit(0)`. A mutex keeps the lines and the count whole across Java threads.
  - `src/libbluray/bdj/native/org_videolan_Logger.c`: `Java_org_videolan_Logger_logN` is traced too.
- `bdj_trace.c`: the harness, `bdj_trace <disc> [--seconds N] [--planes] [--keys FILE] [--tail S] [--wait-timeout S] [--dump-planes DIR]`. It calls `bd_open`, registers an ARGB overlay callback that keeps a copy of the BD-J plane (see [Planes](#planes)), sets country `us` and audio, PG and menu language `eng`, calls `bd_play`, and loops on `bd_read_ext`, reading no faster than real time (stream time from `bd_tell_time` against wall time since the last `BD_EVENT_PLAYLIST`, or since the last `BD_EVENT_SEEK` taken at its media time) and sleeping 40 ms when a read returns 0 bytes. The pacing waits in sleeps of at most 100 ms, checking the script and `--seconds` between them. Without the seek anchor, a chapter picked in A_NEW_ERA's menu (a seek far into the menu's playlist) left the harness asleep for minutes in one sleep. It stops after `--seconds` (default 60). Without `--planes` or `--keys` it prints nothing itself: stdout holds only the trace, as the golden files expect.
- `build.sh`: `npm run bdj-trace:build` builds the image `bluray-web-bdj-trace`. The build context is a temporary copy of this folder plus `src/engine/ass/default-font.ttf` (see [Fonts](#fonts)).
- `run.sh <disc> [--until <call>[#<n>]] [--seconds N] [--jvm-option OPT]... [--planes] [--keys FILE] [--tail S] [--wait-timeout S] [--dump-planes DIR] [--name NAME] [--online] [--storage VOLUME]`: runs the image with the disc mounted read-only at `/disc`. `<disc>` is a folder name under `fixtures/synthetic` or a path to a disc folder (the one holding `BDMV/`). The trace goes to stdout, libbluray's log and the JVM's own output to stderr.
  - `--until CALL` sets `BDJ_TRACE_UNTIL`: the run ends right after the first line for `CALL`, a JNI name without the `Java_org_videolan_Libbluray_` prefix (`selectPlaylistN`, `selectTitleN`, `logN`). `--until CALL#N` ends it after the N-th line for `CALL` (`selectPlaylistN#2`: after the playlist that follows the first one). The harness reads in real time, so a run past a playlist takes at least that playlist's duration.
  - `--jvm-option OPT` (repeatable) is joined into `JAVA_TOOL_OPTIONS`, for example `-verbose:class` or `-verbose:jni`.
  - `--planes` adds a `{"plane":"flush",...}` line at every ARGB overlay flush.
  - `--keys FILE` replays a key script (see [Key scripts](#key-scripts)) and implies `--planes`. The run ends `--tail` seconds (default 5) after the script's last step, or at `--seconds`. Raise `--seconds` for key runs: the default 60 is shorter than many discs take to reach their menu under emulation (A_NEW_ERA's menu playlist starts about 30 s in).
  - `--wait-timeout S` (default 30) bounds each script step: a step that has not held S seconds after it became current ends the run with a timeout (see [Key scripts](#key-scripts)). The first step counts from the harness start, so a disc whose first menu takes longer needs a larger value (A_NEW_ERA: `--wait-timeout 60`).
  - `--storage VOLUME` keeps libbluray's BD-J storage in the Docker volume `VOLUME`, mounted at `/storage` (`LIBBLURAY_PERSISTENT_ROOT=/storage/persistent/`, `LIBBLURAY_CACHE_ROOT=/storage/buda/`), so a later run with the same volume finds what an earlier one saved, as a player keeps it between viewings. Without it each run starts with empty storage.
  - `--name NAME` names the container, so a caller can `docker kill` it (killing the docker CLI leaves the container running).
  - The container runs with `--network none`, as libbluray runs on a machine with no network: a disc's BD-Live check fails at once (`UnknownHostException` for a host name, `SocketException` or `ConnectException` for an address) and never reaches a real server. `--online` gives the container a network, for a one-off comparison by hand only; nothing in the repo passes it, and goldens, the class collection and the library check are all made offline.
  - `--dump-planes DIR` writes `DIR/<k>.png` at flush `k` (created if missing, mounted at `/planes`; the files belong to root on Linux hosts). PNG compression slows the drawing thread, so a time-driven animation draws fewer frames than without it (see [Planes](#planes)). Never commit PNGs from local discs.
  - `BD_DEBUG_MASK` and `BD_DEBUG_FILE` pass through to libbluray.
  - `BDJ_TRACE_PLATFORM` (build.sh, run.sh, freetype-golden.sh and text-golden.sh) replaces `linux/amd64` as the Docker platform. It is for local runs only, in case HotSpot does not run under emulation on your host; leave it unset otherwise. It was not needed on an arm64 Mac with Docker Desktop.
- `freetype-golden.sh` (`npm run bdj-trace:freetype-golden`): compiles `freetype_golden.c` in the image against its system FreeType (libfreetype6 `2.13.2+dfsg-1ubuntu0.2`, the one libbluray links) and writes `tests/bdj/fonts/freetype-golden.json`: the bundled font's family and style, and at 12, 16, 24, 36, 40, 48 and 72 px its size metrics, four kerning pairs, and for printable ASCII plus six other characters (one missing from the font) the `FT_LOAD_DEFAULT` advance and the `FT_LOAD_RENDER` bitmap, made with the calls and shifts of libbluray's `loadFontN`, `charWidthN` and `drawStringN`. `src/engine/bdj/fonts/freetype.test.ts` checks `src/wasm/freetype/freetype.wasm` against it byte for byte. Never edit the file by hand.
- `text-golden.sh` (`npm run bdj-trace:text-golden`): links `text_golden.c` with the image's compiled libbluray objects for `bdj/native/java_awt_BDFontMetrics.c` and `java_awt_BDGraphics.c` (from `/src/libbluray/build`, the code in `libbluray.so`), calls those natives through their `JNINativeMethod` tables with a small fake `JNIEnv`, and writes `tests/bdj/fonts/text-golden.json`. Two fonts: the fallback font opened through the JRE path `LucidaSansRegular.ttf` (see [Fonts](#fonts)) and `fixtures/ass/fonts/DejaVuSerif.ttf` standing for a disc font. At 16, 24, 36, 40, 48 and 72 px the file records the `loadFontN` fields, `charWidthN` of characters 0–255 and four more, `stringWidthN` and `charsWidthN` cases (including out-of-bounds ones), and four `drawStringN` calls. For each draw it keeps the count and FNV-1a hash of the `drawPoint(x, y, argb)` calls (the full list for the first), and the hash of a 320×64 back buffer after those calls. The buffer step is a transliteration of `BDGraphicsBase.drawPoint` with the default `SrcOver` composite over a fixed four-band background. Also recorded: `getFontFamilyAndStyleN` of each font, and of a missing file and a non-font file. `src/engine/bdj/jvm/natives/fonts.test.ts` checks Seikou's natives against this golden exactly, and also runs libbluray's Java `drawString` in our JVM against the buffer hashes. Never edit the file by hand.

## Trace format

One JSON object per line: `{"call": "<name>", "args": [...], "ret": ...}`. `call` is the JNI name without the `Java_org_videolan_Libbluray_` prefix, `args` leave out the native pointer `np`.

- `jint` and `jboolean`: numbers and `true`/`false`. `jlong`: a quoted decimal string (`"-1"`). Strings: JSON-escaped, `null` for a null string. `void` returns `null`.
- Arrays and objects: `null` when null, otherwise a size. `getTitleInfosN` returns the array length (titles plus 2), `listBdFilesN` the number of names, `getBdjoN` `1`, `getAacsDataN` the byte count, `getPlaylistInfoN` the playlist number.
- `updateGraphicN` args are `width, height, x0, y0, x1, y1, rgbArrayIsNull`; the pixels are not traced.
- `logN` args are `file, line, message` (`error` is not traced).
- `writeRegN` args are `isPsr, num, value, mask`; `readRegN` args are `isPsr, num`.

Calls from several Java threads interleave in the order they reach `printf`.

## Planes

libbluray hands BD-J graphics to the harness as ARGB overlay operations (`bdpriv_bdj_osd_cb` in `bluray.c`, `BD_ARGB_OVERLAY_*` in `decoders/overlay.h`), all on the IG plane, from the Java thread that draws. The harness keeps one 1920×1080 plane of 32-bit ARGB words (non-premultiplied, as BD-J's `int[]` back buffer):

- `INIT` and `CLOSE` clear it to 0 (transparent black). An `INIT` smaller than 1920×1080 keeps its pixels at the top left.
- `DRAW` copies the `w`×`h` rectangle from `argb` (stride `stride`) to `(x, y)`, clipped to the plane.
- `FLUSH` counts flush `k` (1, 2, … from the start of the run) and prints `{"plane":"flush","n":<k>,"hash":"<8 hex>","t":<ms>}`, where `t` is wall-clock milliseconds since the harness started (informative only; it varies between runs). With `--dump-planes` it writes `<k>.png` (RGBA, 8 bits per channel, straight alpha).

**Hash.** FNV-1a, 32-bit, over the plane's 1920×1080 words in row-major order (row 0 first, left to right), each word fed as its 4 little-endian bytes (`B`, `G`, `R`, `A` for ARGB `0xAARRGGBB`): start at `h = 0x811c9dc5`, then for each byte `h = (h XOR byte) * 0x01000193 mod 2^32`. Printed as 8 lowercase hex digits. In TypeScript, over a `Uint32Array` of ARGB words:

```ts
let h = 0x811c9dc5;
for (const v of plane) for (let b = 0; b < 32; b += 8) h = Math.imul(h ^ ((v >>> b) & 0xff), 0x01000193) >>> 0;
const hex = h.toString(16).padStart(8, '0');
```

A fully transparent plane hashes to the same value every time, so an empty flush is recognisable. Flush counts are not stable during animations: libbluray's Java stack draws time-driven animations (A_NEW_ERA's logos and menu fade-in) with as many frames as it manages, so `n` differs between runs, but the settled planes do not (A_NEW_ERA's main menu settles on `4bc306b4` in every run). Compare hashes at settled points, which `wait still` reaches.

## Key scripts

`--keys FILE` replays a script in the `.keys` syntax of `tests/vm-trace/scripts/` (one step per line, `#` starts a comment), with these steps:

- `wait flush <k>`: until flush `k` has happened (the `n` of the flush lines).
- `wait still <ms>`: until the plane has flushed at least once since the previous step and then not again for `<ms>` milliseconds of wall time. This is the wait for a settled menu, after the disc's own start-up or after a key, because flush counts vary (see [Planes](#planes)).
- `wait quiet <ms>`: until the plane has not flushed for `<ms>` milliseconds since the later of its last flush and the moment the step became current. Unlike `wait still` it needs no flush, so a key that changes nothing settles too (`tools/bdj-library/generic.keys`); its settled hash is the last flush's.
- `wait menu <ms>`: until the last flushed plane is visible (a pixel with non-zero alpha; an `INIT` or `CLOSE` makes it invisible) and has not flushed for `<ms>` milliseconds, so a blank start-up frame never satisfies it; or until the plane has stayed visible for 30 s while flushing on (an animated menu), when the step line carries `"animated":true`. `settled.py` gives such a step no hash, and so does our replay.
- `wait playlist <n>`: until a `BD_EVENT_PLAYLIST` for playlist `n` has been seen since the previous step ran (for the first step, since the start). Any matching event in that window counts, even if later playlist events followed it before the wait was checked. `wait title <n>`: the same for `BD_EVENT_TITLE`. `wait playlist any` and `wait title any` hold for any such event (`tools/bdj-library/generic.keys`).
- `key <name>`: `bd_user_input(bd, -1, key)` with no flags, so libbluray sends pressed, typed and released. Names: vm-trace's `up`, `down`, `left`, `right`, `ok`, `topmenu`, `popup`, `0`…`9`, plus `red`, `green`, `yellow`, `blue`, or a `keys.h` name (`BD_VK_UP`, `BD_VK_ENTER`, `BD_VK_ROOT_MENU`, `BD_VK_POPUP`, `BD_VK_MOUSE_ACTIVATE`, `BD_VK_0`…`BD_VK_9`, `BD_VK_RED`, `BD_VK_GREEN`, `BD_VK_YELLOW` (libbluray spells it `BD_VL_YELLOW`, also accepted), `BD_VK_BLUE`).
- `mouse <x> <y>`: `bd_mouse_select(bd, -1, x, y)` (`BDJ_EVENT_MOUSE`). `click <x> <y>`: the same, then `bd_user_input(bd, -1, BD_VK_MOUSE_ACTIVATE)`. Coordinates are in 1920×1080 plane space.

A line starting `#!` is a comment to the harness and an option to the comparison in `tests/bdj/settled.ts`: `#! vary gpr <n>... [after playlist <p>]` leaves the `writeRegN` calls of those general-purpose registers (only those after Java selects playlist `<p>`, when given) out of the comparison (`settled.py <script>` drops them from the golden, `settled.ts` from our run), for a disc that writes timing-dependent values. Whether any such write happened is still compared: `settled.py` adds a `{"script":"vary","gpr":<n>,"after":<p>,"written":<bool>}` line per register. RENTAL_FAMILY saves its playback position in GPR 518/519 once the feature (00800) plays; its writes of 0 at start-up stay compared. Our replay also runs 1.5 s past the golden's call count, so a call libbluray did not make fails the comparison.

libbluray runs in real time, so a script never sleeps for a fixed time: the harness checks the current step's wait between reads and only then sends the next steps, and key and mouse steps run at once, one after another. There is no `wait ms`; `wait still` covered every case met so far. Each step that runs prints `{"script":"step","n":<i>,"step":"<line>","flushes":<count>,"t":<ms>}` (`n` counts from 0, `flushes` is the count at that moment), and the run ends with `{"script":"end","n":<steps run>,"why":"done"|"limit"|"error","flushes":<count>,"t":<ms>}`.

A wait that never holds fails the run instead of running out the clock: when the current step has not held `--wait-timeout` seconds after it became current, the harness prints `{"script":"end","why":"timeout","n":<step>,"text":"<step text>","flushes":<count>,"t":<ms>}`, names the step on stderr and exits with status 3. It also exits with status 3 (after a `"why":"limit"` or `"error"` end line and a stderr line) when `--seconds` or a read error ends the run with script steps left. A run with `"why":"done"` exits 0.

Example, A_NEW_ERA's main menu (playlist 00149 plays behind it; run with `--seconds 120 --wait-timeout 60`):

```
wait playlist 149
wait still 1500   # the menu has faded in
key right         # PLAY -> CHAPTERS: one flush
wait still 1000
key left          # back to PLAY
wait still 1000
```

## Fonts

libbluray is built with fontconfig off, so `java.awt.BDFontMetrics` resolves the JRE logical font names to files under `java.home/lib/fonts/` (`/usr/lib/jvm/java-8-openjdk-amd64/jre/lib/fonts/`), which the headless JDK does not ship. The image installs the bundled `src/engine/ass/default-font.ttf` as `/usr/local/share/fonts/default-font.ttf` and links every one of those files to it, so libbluray resolves them all to that font and prints no `Can't resolve font` errors (it printed 24 before):

| logical name (`<name>.<style>`, style 0 plain, 1 bold, 2 italic, 3 bold italic) | files (styles 0, 1, 2, 3) |
| --- | --- |
| `serif` | `LucidaBrightRegular.ttf`, `LucidaBrightDemiBold.ttf`, `LucidaBrightItalic.ttf`, `LucidaBrightDemiItalic.ttf` |
| `sansserif`, `dialog`, `default` | `LucidaSansRegular.ttf`, `LucidaSansDemiBold.ttf`, `LucidaSansOblique.ttf`, `LucidaSansDemiOblique.ttf` |
| `monospaced`, `dialoginput` | `LucidaTypewriterRegular.ttf`, `LucidaTypewriterBold.ttf`, `LucidaTypewriterOblique.ttf`, `LucidaTypewriterBoldOblique.ttf` |

So every logical name in every style is `default-font.ttf`, with no synthetic bold or italic beyond what libbluray's FreeType code does itself. A font a disc names that is not in this table falls back to `default.<style>` in `BDFontMetrics.getFontMetrics`, which is the same file. Fonts a disc ships (`dvb.fontindex`, a BDJO's default font) are read from the disc as before. Seikou's BD-J font natives resolve the same names to the same file.

## Notes

- A disc's first-play BD-J object starts through `bd_play` without a `selectTitleN`; that call appears after the title is chosen (menu input, `Libbluray.selectTitle` by an Xlet). The harness sends no keys unless `--keys` is given.
- The JVM prints `Picked up JAVA_TOOL_OPTIONS: ...` to stderr when `--jvm-option` is used.

## Golden trace

`golden.sh` (`npm run bdj-trace:golden`) writes `tests/bdj/golden/disc-bdj-menu.arrows.jsonl` and `disc-bdj-menu.mouse.jsonl` (see below), and `tests/bdj/golden/disc-bdj.jsonl`, the trace of `fixtures/synthetic/disc-bdj` up to the second `selectPlaylistN` (TitleXlet plays playlist 00000, and again when it ends), and `tests/bdj/golden/disc-bdj-mixed.jsonl`, the trace of `fixtures/synthetic/disc-bdj-mixed` up to its first `selectPlaylistN` (see below). Both are reduced to the control calls (`selectTitleN`, `selectPlaylistN`, `seekN`, `selectAngleN`, `selectRateN`, `writeRegN`, `setUOMaskN`, `setKeyInterestN`, `soundEffectN`, `setVirtualPackageN`). Diagnostic calls are left out because they vary between runs: `logN` carries timing and `cacheBdRomFileN` a random cache directory name. CI regenerates the files and fails on any diff (`.github/workflows/bdj-trace.yml`). Never edit it by hand.

The disc is BD-J only (First Play and title 1 are BD-J objects). `selectTitleN` is only reached for HDMV titles (`BDJLoader` to `Libbluray.selectHdmvTitle`), so this disc does not exercise it.

`disc-bdj-mixed` (`scripts/make-bdj-mixed-disc.ts`, xlets in `tests/bdj/xlets/src/bdjweb/mixed/`, packed into `tests/bdj/xlets/mixed.jar` by `tools/bdj-classlib/pack.sh`) hands over in both directions: First Play is BD-J (HdmvTitleXlet starts HDMV title 1 through its `TitleContext`: `selectTitleN(1)`, then libbluray's `_play_hdmv` and `_stop_bdj`), title 1's movie object plays playlist 00000 and then does `JumpTitle 2` (`_play_bdj`), and BD-J title 2 (PlaylistXlet) selects playlist 00001. The vm-trace harness cannot drive this disc: its libbluray is built without a JVM, so `bd_play` ends at once with `BD_EVENT_ERROR` on the BD-J First Play, before any HDMV title runs.

`disc-bdj-menu` (`scripts/make-bdj-menu-disc.ts`, MenuXlet in `tests/bdj/xlets/src/bdjweb/menu/`, packed with its logo `logo.png` and still `bg.png` into `tests/bdj/xlets/menu.jar` by `tools/bdj-classlib/pack.sh`) is a BD-J menu in a 1920×1080 plane (BDJO graphics resolution 1). It plays playlist 00001 (the 2 s clip 30 times, so it does not end while a script runs) behind an HScene with a PNG logo (`HStaticIcon`) and three `HTextButton`s: Play and Extras in the disc's font, Chapters in the fallback font. The disc font is `BDMV/AUXDATA/00000.otf`, listed in `BDMV/AUXDATA/dvb.fontindex` and read through `org.dvb.ui.FontFactory`. It is Source Sans 3 Regular, OpenType with CFF outlines under the SIL OFL 1.1, from `fixtures/bdj-fonts/` (`scripts/fetch-bdj-fonts.sh`); its licence is copied to the disc's root. Up and down move the focus, and Enter on Play hides the menu and plays playlist 00000. A click inside Play changes its text through a `MouseListener`; libbluray posts mouse events to the focus owner with plane coordinates. The menu also shows a background still, which libbluray does not draw. Its goldens come from two key scripts, `tests/bdj/scripts/disc-bdj-menu.arrows.keys` and `disc-bdj-menu.mouse.keys`. `golden.sh` runs each with `--keys` and reduces the run with `settled.py`:

- the control calls, in order;
- every script step, a `wait still` step with the hash of the last flush before it (the settled plane);
- the last flushed plane at the end.

`disc-bdj-store` (`scripts/make-bdj-store-disc.ts`, StoreXlet in `tests/bdj/xlets/src/bdjweb/store/`, packed into `tests/bdj/xlets/store.jar`) counts its own openings. It reads `/persistent/<org>/<app>/count` (built from `dvb.persistent.root` and the xlet properties `dvb.org.id` and `dvb.app.id`, as `BDJAppProxy.createStorage` makes the directory) and the lines of the organisation's loose BUDA file `bluray.bindingunit.root/<org>/x.log`, draws `count <c>  log <l>` in the fallback font at 36 px, writes `c + 1` and one more line, and then plays playlist 00000. `golden.sh` runs `tests/bdj/scripts/disc-bdj-store.open.keys` three times on one `--storage` volume (made for the runs and removed after) and writes `disc-bdj-store.open.<n>.jsonl`, reduced as the menu disc's: the planes for counts 0, 1 and 2. `tests/bdj/bdj-store.test.ts` replays the three openings on one store, and `tests/e2e/bdj-store.spec.ts` checks the same hashes in the browsers.

Flush lines are dropped because the menu draws without animation, yet the flushes still vary between libbluray runs. `BDRootWindow` flushes on a 40 ms timer, so the first paint and the focused button's repaint sometimes share a flush and sometimes do not. Control calls the harness prints after the script's end line come from `bd_close` stopping the title and are dropped too. `tests/bdj/bdj-menu.test.ts` replays the same scripts through the real Player (`replayPlayerBdj` with `script`, `tests/bdj/key-script.ts`) and compares the same reduction.

**Local discs.** `golden.sh` also writes `tests/bdj/golden/local/<script>.jsonl` for the key scripts `tests/bdj/scripts/a_new_era.play.keys`, `a_new_era.chapters.keys` and `rental_family.play.keys`, each run on the developer's disc in `fixtures/local/A_NEW_ERA` or `fixtures/local/RENTAL_FAMILY` (gitignored) and reduced by `settled.py` like the menu disc's: control calls and plane hashes, no disc content. A disc that is absent leaves its files as they are, so CI, which has no local discs, regenerates nothing for them and its diff stays clean. `tests/local/bdj-menus.test.ts` replays the same scripts through the real Player (no Docker) and skips when the disc is absent. `npm run bdj-trace -- <disc> --keys <script>` runs both sides of one script and prints the calls and settled hashes side by side (`--libbluray FILE` takes a saved run or reduction instead of Docker).

`disc-bdj-background` (`scripts/make-bdj-background-disc.ts`, BackgroundXlet in `tests/bdj/xlets/src/bdjweb/background/`, packed with its still `bg.png` into `tests/bdj/xlets/background.jar` by `tools/bdj-classlib/pack.sh`) loads that still as an `HBackgroundImage`, shows it with `HStillImageBackgroundConfiguration.displayImage` in the left half of the screen and then selects playlist 00000. libbluray leaves `displayImage` unimplemented (its log says `UNIMPLEMENTED`) and never draws the still, so this disc has no golden file; `tests/bdj/background-xlet.test.ts` checks our player shows it under the video (`src/engine/bdj/background.ts`).
