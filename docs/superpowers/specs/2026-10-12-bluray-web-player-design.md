# Blu-ray Web Player — Design Spec

Date: 2026-10-12
Status: Approved design; v1 done: milestone 1 (2026-10-12), 2 (2026-10-13), 3 (2026-10-15), 4a and 4b (2026-10-15). Later work has its own specs in this folder.

## 1. Purpose and scope

A client-side-only Blu-ray player web app for end users, built with TypeScript, React, and Vite. It uses libbluray as the reference implementation (ported to TypeScript, not compiled), demuxes M2TS itself, and decodes with WebCodecs. Nothing is uploaded to a server.

### Success criteria for v1

A user on Chromium desktop can:

1. Open a decrypted BDMV folder (picker or drag-and-drop) or reopen a recent one.
2. See the disc's HDMV First Play / Top Menu and navigate it by keyboard, mouse, or on-screen remote.
3. Play the main feature with A/V sync within ±20 ms at steady state, with no drift over 10 minutes, and back within tolerance within 1 s after a seek.
4. Seek, skip chapters, switch audio tracks (LPCM, AC-3, and the AC-3 core of TrueHD) and PG subtitle tracks, and use pop-up menus.
5. Upload SRT or ASS subtitles, adjust their offset and size, and see them composited correctly.
6. Get a specific, actionable message for anything unsupported (BD-J, encrypted disc, unsupported codec, missing browser capability).

### In scope (v1)

- Input: decrypted BDMV folder via the File System Access API, with a `webkitdirectory` fallback.
- Parsing: `index.bdmv`, `MovieObject.bdmv`, `.mpls`, `.clpi`.
- HDMV navigation VM, IG menus (always-on and pop-up), and UO masks.
- M2TS demux; video in H.264 and HEVC via WebCodecs `VideoDecoder`.
- Audio: LPCM (TypeScript); AC-3 / E-AC-3, the AC-3 core of TrueHD, and the DTS core of DTS / DTS-HD (FFmpeg-derived WASM decoder); any other codec WebCodecs reports as supported.
- Audio-master clock via `AudioWorklet` and a `SharedArrayBuffer` ring buffer.
- PGS subtitles, including forced subtitles; SRT; a native TypeScript ASS renderer.
- React UI: transport controls, track menus, title list, menu controls, keyboard routing.

### Out of scope (v1), with planned phases

| Item | Phase |
|---|---|
| ISO input (UDF 2.5 reader as a `ByteSource`) | Done for NAS discs: the NAS server reads `.iso` files through a UDF reader (`2026-10-17-nas-server-design.md`, 2026-10-17). A folder picked in the browser must still be a BDMV folder. |
| Lossless TrueHD / DTS-HD decoding, VC-1, MPEG-2 via WASM decoders | Lossless audio: later ("codec gaps"). MPEG-2 and VC-1 play without a picture (5e); from the NAS they play at a quality level the NAS re-encodes (`2026-10-19-lower-quality-design.md`, 2026-10-22). No WASM video decoder is planned. |
| AACS / BD+ decryption (as a `ByteSource` decrypt stage with a user-supplied key DB and no bundled keys; legal review required before shipping) | Later |
| JASSUB/libass fallback for ASS | Only if golden-image tests show the native renderer is unacceptable |
| Safari / Firefox support | Done: cross-browser step 1 (`2026-10-16-cross-browser-and-remote-design.md`, 2026-10-17): Safari 26 on macOS, iOS and iPadOS, Chrome and Firefox desktop, Chrome Android. |
| BD-J | Milestone 5 series: 5b JVM core, 5c playback and 5d menus (graphics plane, keys, mouse and touch, FreeType text, on desktop browsers, iPhone and iPad; `2026-10-17-m5d-bdj-menus-design.md`) and 5e (every BD-J disc in the library, saved data per person; `2026-10-18-m5e-bdj-library-coverage-design.md`, merged 2026-10-22) done. |
| HDR tone mapping, 3D/MVC, multi-angle, PiP secondary video, mobile | Mobile: done with cross-browser step 1 (2026-10-17). HDR tone mapping only through the NAS's `h264-1080-sdr` level. The rest is not planned. |

## 2. Architecture

Three execution contexts:

```
Main thread (React)
  UI ── PlayerController ── typed postMessage protocol ──┐
  <canvas> transferred as OffscreenCanvas ───────────────┤
                                                         ▼
Engine worker (framework-free TypeScript)
  disc/      ByteSource: FileSource (path → File map); later UdfSource, AacsSource
  bdmv/      index.bdmv, MovieObject.bdmv, mpls, clpi parsers
  nav/       Navigator + playlist Timeline
  hdmv/      HDMV VM + RegisterFile (PSR/GPR)
  demux/     M2tsReader → PES → access units
  decode/    Decoder interface: WebCodecs video/audio, LPCM (TS), AC-3 (WASM)
  graphics/  PG decoder, IG decoder, GraphicsController
  subs/      SRT parser/renderer, ASS parser/renderer
  render/    Compositor (video → PG → text subs → IG)
  clock/     MasterClock (audio-driven, wall-clock fallback)
                                                         │ SharedArrayBuffer PCM ring
AudioWorklet ◄───────────────────────────────────────────┘
  plays PCM, atomically publishes framesPlayed
```

One engine worker holds navigation, the VM, demux, graphics, and rendering, because they share playback state tightly and VM commands change playback directly. WebCodecs decoding is already asynchronous and hardware-backed. Rendering on `OffscreenCanvas` keeps presentation timing independent of React.

### Repository layout

```
src/
  engine/   LGPL-2.1 (own LICENSE file); no React imports
  ui/       React app (license of the owner's choosing)
  wasm/     AC-3 decoder build output and build script (LGPL)
tests/
  e2e/      Playwright
  vm-harness/  native C harness linking libbluray
fixtures/
  synthetic/   committed; CI-safe
  local/       gitignored; excerpts from the developer's own discs
```

The tooling is Vite, Vitest, and Playwright. Deployment is a static host that sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; the same headers are configured for the Vite dev server.

### Core interfaces

```ts
interface ByteSource {
  size(path: string): number;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  exists(path: string): boolean;
  list(dir: string): string[];
}

interface Decoder<In, Out> {
  configure(config: StreamConfig): Promise<void>; // rejects with UnsupportedCodecError
  decode(unit: In): void;
  flush(): Promise<void>;
  reset(): void;
  onOutput: (out: Out) => void;
  readonly queueSize: number;
}

interface SubtitleRenderer {
  render(ctx: OffscreenCanvasRenderingContext2D, timeMs: number, videoRect: Rect): void;
  seek(timeMs: number): void;
}
```

The engine protocol is a discriminated union.

- **Commands:** `open`, `play`, `pause`, `seek`, `setVolume`, `selectAudio`, `selectSubtitle`, `addTextSubtitle`, `setSubtitleOffset`, `setSubtitleScale`, `playTitle`, `playPlaylist`, `nextChapter`, `prevChapter`, `menuKey`, `pointer`, `resize`.
- **Events:** `state`, `time`, `tracks`, `titles`, `chapters`, `uoMask`, `menuActive`, `notice`, `error`, `unsupported`, `telemetry`.

## 3. Disc input (`disc/`)

- `showDirectoryPicker({ mode: 'read' })` or `DataTransferItem.getAsFileSystemHandle()` returns a `FileSystemDirectoryHandle`. Either the disc root or `BDMV/` is accepted.
- The fallback is `<input type="file" webkitdirectory>`, which yields `File`s with `webkitRelativePath`.
- Both inputs normalize into a `path → File` map. `FileSource` wraps that map, so the rest of the engine never sees handles.
- Reads use `file.slice(off, off + len).arrayBuffer()`. Read-ahead happens in roughly 2 MB chunks that are multiples of 6144 bytes (one aligned unit is 32 × 192-byte packets). A seek discards the read-ahead.
- Recent discs: directory handles are stored in IndexedDB and reopened with `requestPermission({ mode: 'read' })`.
- A `NotReadableError` becomes an error event: "Disc folder changed; please reopen".
- Not used: `createSyncAccessHandle` (OPFS-only) and `FileReaderSync`.

## 4. Playback data flow

1. **Playlist to bytes.** The Navigator selects an `.mpls`, which is a list of play items (clip, in/out in 45 kHz ticks). Each `.clpi` supplies streams and PIDs, STC sequences, and the EP map. `Timeline` maps play items onto one continuous playlist time and handles 33-bit PTS wrap and per-item PTS discontinuities.
2. **Demux.** `M2tsReader` splits aligned units into 192-byte source packets (4-byte TP_extra_header with ATS, then a 188-byte TS packet) and filters by PID: video `0x1011`, primary audio `0x1100–0x111F`, PG `0x1200–0x121F`, IG `0x1400–0x141F`. It reassembles PES (90 kHz PTS/DTS) and emits access units with playlist-time PTS. Unselected PIDs are dropped early. Continuity-counter errors are logged and the affected PES is discarded.
3. **Decode.**
   - Video: Annex-B `EncodedVideoChunk`. The codec string is derived from the first SPS (`avc1.PPCCLL`, `hvc1.*`). Keyframes are IDR NAL units. Support is checked with `VideoDecoder.isConfigSupported`. MVC NAL units are dropped. VC-1 and MPEG-2 raise `unsupported`.
   - Audio: LPCM is decoded in TypeScript (Blu-ray LPCM header, big-endian 16/24-bit, channel mapping to Float32). AC-3 and E-AC-3 use the WASM decoder. For TrueHD, the demuxer extracts the interleaved AC-3 core frames for the AC-3 decoder. DTS and DTS-HD use the same decoder on the DTS core only (`core_only`). Other codecs are tried via `AudioDecoder.isConfigSupported`, otherwise `unsupported`. Output is resampled to the `AudioContext` rate when needed.
   - Backpressure: the demuxer pauses when decoder `queueSize` is high or about 8 decoded `VideoFrame`s are pending. Every `VideoFrame` is `close()`d after presentation or drop.
4. **Sync.** PCM goes into a `SharedArrayBuffer` ring; the `AudioWorklet` plays it and atomically increments `framesPlayed`.
   - `clock = basePts + framesPlayed / sampleRate − outputLatency`.
   - The worker render loop (`requestAnimationFrame` on `OffscreenCanvas`) presents the newest frame with `pts ≤ clock`, drops late frames, and holds early ones.
   - With no playable audio, the clock is driven by `performance.now()`. Pause suspends the worklet and freezes the clock.
   - Clock and A/V offset telemetry is emitted for tests and a debug overlay.
5. **Seek.** Playlist time → play item and clip PTS → EP map → SPN → byte offset `SPN × 192`, rounded down to an aligned unit. Decoders and queues are flushed, decoding restarts there, and frames before the target are discarded. Seamless connections (connection conditions 5 and 6) keep decoders configured with no flush.
6. **Composite.** Planes are 1920×1080 in the order video → PG → text subtitles → IG, letterboxed to the canvas. PG and IG objects are RLE- and palette-decoded (YCbCr BT.709 → RGBA) and cached as `ImageBitmap`s. The graphics planes are recomposited only when a display set or menu state changes.

## 5. Navigation, HDMV VM, and menus

Ported from libbluray `bluray.c`, `bdnav/`, `hdmv/`, `decoders/ig_decode.c`, and `decoders/graphics_controller.c`.

- **Navigator:** current title, playlist, play item, mark, and selected streams. API: `playTitle`, `playPlaylist(id, item, mark)`, `seek`, `nextChapter`, `prevChapter`, `selectStream(type, n)`. The VM and the UI both act only through it.
- **RegisterFile:** 4096 GPRs and 128 PSRs, with change events.
  - The UI mirrors PSR1 (audio), PSR2 (PG stream and display flag), PSR3 (angle), PSR4 (title), and PSR5 (chapter).
  - Profile and capability PSRs (15, 29, 31) report an HDMV-only player with no BD-J.
- **HDMV VM:** decodes 12-byte instructions in three groups.
  - Branch: `JUMP_OBJECT`, `JUMP_TITLE`, `CALL_OBJECT`, `CALL_TITLE`, `RESUME`, `PLAY_PL`, `LINK_PI`, `LINK_MK`, and so on.
  - Compare.
  - Set: `MOVE`, `SWAP`, arithmetic and bitwise operations, `SET_STREAM`, `SET_NV_TIMER`, `SET_BUTTON_PAGE`, `ENABLE_BUTTON`, `POPUP_OFF`, `STILL_ON`/`STILL_OFF`, and so on.

  Commands run in batches per tick with a step budget. `CALL` and `RESUME` semantics match libbluray (suspended playback position). If the budget is exceeded or an instruction is invalid, the title stops, the VM trace is logged, and the title list is shown.
- **Index entries:** First Play, Top Menu, and titles come from `index.bdmv`. A BD-J entry raises `bdjUnsupported`, and the UI shows the title list.
- **IG / GraphicsController:**
  - Parses the ICS (pages, BOGs, buttons with neighbor links, normal/selected/activated states and animations, navigation commands) along with PDS, ODS, and END.
  - Tracks the current page, the selected button per BOG, animation frames, and `user_timeout`/`selection_timeout`.
  - Input: keys (arrows, Enter, 0–9, popup, top menu); pointer hit-testing in normalized 1920×1080 coordinates (hover selects, click activates).
  - Activating a button runs its commands on the VM. Always-on and pop-up menus are both supported.
- **UO masks:** combined from the playlist, the play item, and the ICS, and emitted as `uoMask`. The UI disables forbidden controls and gives each a tooltip explaining why.

## 6. Subtitles

- **PGS** (ported from `pg_decode.c` and `graphics_processor.c`):
  - Segments: PCS `0x16`, WDS `0x17`, PDS `0x14`, ODS `0x15`, END `0x80`, grouped into display sets, honoring epoch start, acquisition point, and normal composition states so a seek resumes at the next acquisition point.
  - ODS fragments are reassembled, RLE-decoded, and palette-mapped, then cached as `ImageBitmap`s by object ID and version. Cropping and window clipping are applied.
  - Forced objects (`forced_on_flag`) display even when subtitles are off. The display flag and selected stream follow PSR2.
- **SRT:**
  - Encoding: BOM, then strict UTF-8, then a user-chosen fallback (windows-1252, Shift_JIS, GBK, and so on).
  - Supports `<i> <b> <u> <font color>` and `{\anN}`.
  - Drawn as text with outline and shadow, sized relative to the video rectangle's height.
- **ASS (native TypeScript):**
  - Parsing:
    - `[Script Info]`: PlayResX/Y, WrapStyle, ScaledBorderAndShadow.
    - `[V4+ Styles]`.
    - `[Events]`: Dialogue only.
    - `[Fonts]`: uuencoded.
    - Uploaded fonts load via `FontFace` in the worker. A missing font falls back to a system font, with one notice per family.
  - Layout: PlayRes → video rectangle scaling, `\an`, margins, WrapStyle 0–3, and libass-style collision stacking.
  - Tags: `\b \i \u \s \fn \fs \fscx \fscy \fsp \c \1c–\4c \alpha \1a–\4a \bord \xbord \ybord \shad \be \blur \pos \move \org \frz \fax \fay \fad \fade \clip \iclip` (rectangle and vector), `\k \kf \ko`, `\t(...)`, `\r`, `\p` (drawn with `Path2D`).
  - Rendering:
    - Glyphs: `fillText` and `strokeText` with round joins; `ctx.filter = blur()` for `\be` and `\blur`; the browser does text shaping.
    - Caching: static events are cached as `ImageBitmap`s. Events using `\move`, `\fad`, `\t`, or karaoke are redrawn every frame.
  - Unsupported: `\frx`/`\fry` (3D rotation), which render flat with a single "some effects not supported" notice.
  - Fallback rule: if ASS golden-image tests (Section 9) exceed the perceptual-diff threshold on real-world files, JASSUB is added behind `SubtitleRenderer`, selectable per file by a feature scan.
- **Text subtitle controls:** offset in ±100 ms steps, size scale, and the playlist the track is attached to (defaults to the current one). At most one PG stream and one text track display at a time.

## 7. UI

- **Landing screen:** capability check (`showDirectoryPicker`, `VideoDecoder`, `AudioWorklet`, `crossOriginIsolated`) with specific failure messages, an "Open disc folder" button, a drop zone, and recent discs.
- **Player screen:** the canvas plus an auto-hiding control bar.
  - Transport: play/pause, seek bar with chapter ticks, elapsed and total time, previous/next chapter.
  - Volume and mute.
  - Audio menu.
  - Subtitle menu: PG streams, uploaded tracks, Off, "Upload…", offset, size, encoding.
  - Titles list, Top Menu and Pop-up buttons, fullscreen.
  - Optional on-screen remote pad: arrows, OK, 0–9.
- **Keyboard routing:**
  - While an IG page is active, arrows, Enter, and digits go to the menu.
  - Otherwise: ←/→ seek ±10 s, ↑/↓ volume, Space play/pause, M top menu, P pop-up, F fullscreen, `[` and `]` subtitle offset.
- **State:** `PlayerController` is an external store over the worker protocol, consumed with `useSyncExternalStore`. There is no state library.

## 8. Error handling

| Situation | Behavior |
|---|---|
| Missing browser capability | Landing message naming the capability and the supported browsers |
| Not a BDMV folder, or required files missing | Inline error naming the missing paths |
| Encrypted disc (`AACS/` present and stream payload does not parse as TS/PES) | "This disc appears to be encrypted; only decrypted backups are supported" |
| BD-J First Play or title | Notice, then the title/playlist list |
| Unsupported video codec | Playback blocked; notice naming the codec |
| Unsupported audio codec | Video plays on the wall clock; notice; user may pick another audio track |
| Corrupt packets or continuity errors | Skip; on a decoder error, reset and resume at the next keyframe |
| VM step budget exceeded or invalid instruction | Stop the title, log the trace, show the title list |
| `NotReadableError` | "Disc folder changed; please reopen" |

## 9. Testing

- **Unit (Vitest):**
  - Parsers: `index.bdmv`, `MovieObject.bdmv`, mpls, clpi.
  - Demux and PES; PG, IG, LPCM, SRT, and ASS parsing; Timeline and EP-map seek math; the clock with a mocked frame counter.
  - Fixtures: synthetic ones (ffmpeg- and tsMuxeR-authored) are committed for CI. Excerpts from the developer's discs live in gitignored `fixtures/local/`, and their tests are skipped when that folder is absent.
- **VM conformance:** a native C harness links libbluray, plays a disc with a scripted key sequence, and dumps a trace of register writes, playlist starts, and button selections. The TypeScript VM must produce an identical trace for the same disc and keys.
- **ASS golden images:** reference frames come from libass via `ffmpeg -vf ass` and are compared with the native renderer's output using a perceptual-diff threshold.
- **End-to-end (Playwright, Chromium, with COOP/COEP):**
  - Open a synthetic disc, navigate its menu, play, seek, switch tracks, and upload an SRT.
  - Telemetry assertions: A/V offset within ±20 ms at steady state, no drift over 10 minutes (nightly), and recovery within 1 s after a seek.

## 10. Licensing

- `src/engine/` and `src/wasm/` contain code ported from libbluray and FFmpeg-derived AC-3/E-AC-3/DTS decoders. Both are LGPL-2.1, with their own `LICENSE` file and published source.
- The UI and the remaining app code are under a license of the owner's choosing.
- The AACS/BD+ phase requires a separate legal review (e.g. DMCA §1201) before any public release.

## 11. Implementation milestones

v1 is delivered as four sequential plans. Each one ends in a working, testable app.

1. **Core player:** scaffolding (Vite, COOP/COEP, Vitest, Playwright), `disc/`, `bdmv/` parsers, Navigator and Timeline, demux, WebCodecs video, LPCM audio, MasterClock and AudioWorklet, compositor (video plane only), and a basic UI with a playlist/title list and transport controls. Exit criterion: plays a chosen playlist in sync, with seek and chapters.
2. **Audio coverage:** the WASM AC-3/E-AC-3 and DTS core decoder (a reproducible build, with `audio.wasm` committed), TrueHD AC-3 core extraction, and audio track switching.
3. **Menus:** RegisterFile, HDMV VM, the libbluray VM trace harness, IG decoder, GraphicsController, UO masks, menu input routing, and the remote pad. Done (2026-10-15); details in `2026-10-14-m3-hdmv-menus-design.md`.
4. **Subtitles:** PGS (including forced subtitles), SRT, the native ASS renderer, subtitle controls, and the ASS golden-image tests. Split in two: 4a (PGS, SRT and the subtitle controls) is done (2026-10-15), details in `2026-10-15-m4a-pgs-srt-design.md`; 4b (the native ASS renderer, episode subtitle sets and the libass golden-image tests) is done (2026-10-15), details in `2026-10-15-m4b-ass-renderer-design.md`.

After v1, BD-J came as the milestone 5 series: 5b (the JVM core, `2026-10-15-m5b-bdj-jvm-core-design.md`), 5c (BD-J titles drive playback, `2026-10-16-m5c-bdj-playback-design.md`), 5d (BD-J menus on every device, `2026-10-17-m5d-bdj-menus-design.md`) and 5e (every BD-J disc in the library, `2026-10-18-m5e-bdj-library-coverage-design.md`) are done.

## 12. Decisions log

| Decision | Choice |
|---|---|
| Audience | Product for other people |
| Approach | TypeScript port of libbluray with a worker WebCodecs pipeline (not libbluray WASM, not MSE) |
| Input (v1) | Folder only; ISO later |
| Browsers (v1) | Chromium desktop first |
| Menus | HDMV only; BD-J falls back to the title list |
| Audio in v1 | LPCM, plus WASM AC-3/E-AC-3 (with the TrueHD AC-3 core) and DTS core (all DTS-HD flavours); lossless extensions later |
| ASS | Native TypeScript renderer; JASSUB only if the fidelity tests fail |
| Licensing | Engine isolated as LGPL-2.1 |
