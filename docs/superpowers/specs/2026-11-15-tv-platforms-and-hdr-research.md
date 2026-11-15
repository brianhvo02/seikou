# TV platforms and HDR: research notes

Status: research only, nothing decided. Written 2026-11-15 after trying Seikou on a Samsung TV. It records what was
learned about Samsung Tizen TVs, Apple TV and HDR output, so a later design starts from it. Sources are at the end;
claims marked *unverified* came from a single community source or from inference.

## 1. What Seikou needs from a TV's web engine

The player needs, in order of how hard they are to replace: cross-origin isolation (SharedArrayBuffer, for the
audio ring, the BD-J registers and graphics plane), WebCodecs `VideoDecoder` (and `AudioDecoder` for Opus encodes),
an AudioWorklet (the master clock), OffscreenCanvas in a worker (presentation), workers started from workers (BD-J),
WebGL2 (shaders), IndexedDB, and modern JavaScript (the build targets ES2022). A TV without these can't run the player
at all, whatever its decoder can do.

## 2. Samsung Tizen

### Web engine by model year

Samsung's Web Engine Specifications page: the engine is fixed per model year and never moves to a newer Chromium in a
firmware update.

| Year | Tizen | Chromium | Seikou |
|---|---|---|---|
| 2026 | 10.0 | M130 | every API present; Service Worker and WebRTC listed |
| 2025 | 9.0 | M120 | every API present; WebRTC "partially" |
| 2024 | 8.0 | M108 | APIs present; no WebRTC, no Service Worker |
| 2023 | 7.0 | M94 | WebCodecs just arrived (M94); `:has()` rules (M105) break layout |
| 2022 and older | ≤ 6.5 | ≤ M85 | no WebCodecs: cannot run |

Samsung's OS upgrade programme (up to seven years of Tizen upgrades) starts with 2023 models; 2018–2022 sets keep
their engine. A 2023 set is being upgraded to Tizen 8.0.

Samsung's model codes carry the year: a 2018 set ends in `N` (`QN65Q6FNA`, the Q6FN), a 2025 set in `FA`
(`QN65Q6FAAFXZA`, the Q6F), a 2026 set in `HA` (`QN65S90HAEXZA`, the S90H). Check the code's year and the user agent
before planning around a TV: a 2018 Q6FN was first misread as the 2025 Q6F here.

### What happened on a 2018 TV (Tizen 4.0)

- `sdb capability` reports `platform_version:4.0`; the app's user agent is `SMART-TV; LINUX; Tizen 4.0`, the
  Chromium 56 generation. It has no optional chaining (the page's script fails to parse, so the app shows black), no
  SharedArrayBuffer, WebCodecs, AudioWorklet or OffscreenCanvas, rejects the `strict-origin-when-cross-origin`
  referrer policy, and its inspector refuses `awaitPromise` on a plain value. The player can't run there.
- Installing a signed widget took three fixes, now in `tools/tizen/` (README there):
  - The TV refused every package signed for it (`install failed[118012]`, Samsung's own empty template included)
    until the certificate's `device-profile.xml` was pushed to its `sdk_toolpath`
    (`/home/owner/share/tmp/sdk_tools`); `/home/developer`, where older guides put it, is refused. The rule (TVs
    reporting platform 4.0 or lower) comes from the Apps2Samsung installer's source.
  - `required_version="6.0"` made the TV refuse to parse `config.xml` (`118019`); Samsung's templates use 2.3.
  - The TV's installer splits a package file name at its spaces.
- The certificate must be a Samsung one (author: "Samsung VD Author CA", from Samsung Certificate Extension 2.0.75;
  distributor: "VD DEVELOPER Public CA", Public privilege) naming the TV's DUID (`sdb shell 0 getduid`). A new TV
  needs a new distributor certificate.
- Debugging works through `sdb shell 0 debug <app id>` (prints a port), `sdb forward`, and the Chrome DevTools
  protocol on that port.

### Expectations for a 2026 TV (S90H, NQ4 AI Gen3, Tizen 10, Chromium M130), untested

| Part | Expectation |
|---|---|
| Engine and APIs | all present |
| Cross-origin isolation in a hosted app | unknown; decides everything (the probe's first row) |
| 1080p H.264 Blu-ray | likely fine: Kodi's WebCodecs work used the hardware decoder on a 2025 Samsung OLED of the same chip family (*unverified* that the chip matches) |
| 4K HEVC (UHD discs) through WebCodecs | doubtful: Kodi saw repeated 4K H.264 decoder failures; its decoder gives RGBX frames and holds at most 16 buffers, reusing a frame's buffer while it is still open |
| HDR | lost on the canvas path (§4) |
| AV1 encodes | hardware AV1 is in the TV; whether WebCodecs uses it is unknown |
| Audio | Seikou decodes to PCM: no bitstream passthrough; multichannel over eARC unknown |
| BD-J menus, animated ASS | processor-bound; likely work, may be slow against the 0.2 s menu bar |
| Anime4K shaders | probably too slow on a TV GPU |
| Remote control | the player needs D-pad focus and remote keys (`tizen.tvinputdevice`); not built |

The probe (`probe.html` with the NAS route, `tools/tizen/make-wgt.sh`) answers the unknown rows within an hour of
setting a TV up.

### Other Samsung routes

- **Tizen WASM Player** (Tizen 6.0+): `ElementaryMediaStreamSource` takes the app's demuxed elementary streams and
  decodes them on the hardware video plane under an `HTMLMediaElement` (normal-latency mode: platform clock, seeks,
  DRM), or into a WebGL texture. C++ through Emscripten only. A Samsung-only version of the MSE route in §4.
- **AVPlay** (every Tizen TV, 2018 included): the native player, by URL. A small ES5 client playing NAS-served
  H.264 or HLS would run even on Tizen 4.0, without menus, BD-J or Seikou's subtitles.
- Samsung's 2026 video spec lists HEVC Main and Main10 at 4K (Level 5.2), AV1 at 4K in WebM, and the note "MSE
  supports resolutions up to FHD; it does not support UHD" under H.264 UHD. Read as: 4K H.264 can't go through MSE;
  HEVC and AV1 at 4K through MSE need checking on a TV.

## 3. Apple TV

tvOS has no WebKit for apps (`WKWebView` is not available on tvOS), so Seikou can't run there as a web app. Routes:

1. **AirPlay** from Safari on a Mac, iPhone or iPad: works today with everything (menus, BD-J, subtitles,
   shaders); re-compressed picture, no HDR, the sender stays on.
2. **A native client over the NAS**: `AVPlayer` plays HLS with hardware decoding, HDR and Dolby audio; the NAS would
   package its quality levels and encodes as HLS. No disc menus or BD-J. The A15 Apple TV 4K (2022) has no AV1
   hardware; a 2026 model with an A19 is reported to have it (*unverified*).
3. **A full port**: JavaScriptCore exists on tvOS but without WebCodecs, canvas, workers or a JIT, so the engine
   would have to be rewritten natively (VideoToolbox, `AVSampleBufferDisplayLayer`, Metal). Very large.

Sideloading needs an Apple Developer account (a year per install; 7 days with a free account).

## 4. HDR

### How YouTube does it

YouTube never draws video on a canvas. In a browser it feeds a `<video>` element through Media Source Extensions
(VP9 Profile 2, AV1 or HEVC at 10 bits with HDR metadata). The browser's own media pipeline decodes it and hands the
frames to the system compositor as a video overlay with their colour space and HDR metadata, which is how they reach
the display in HDR (Windows in HDR mode, macOS EDR, iOS, TVs). On TVs YouTube runs in Cobalt, Google's own app
runtime, which decodes on the platform decoder straight onto the TV's video plane; the page's graphics are drawn on a
plane above it with a transparent hole where the video shows ("punch-out"). The same holds for Netflix and every TV
streaming app.

### Why Seikou's picture is SDR today

Seikou decodes with WebCodecs and draws each `VideoFrame` onto an OffscreenCanvas with Canvas 2D `drawImage`. A 2D
canvas is an SDR surface (sRGB or Display P3): the WebCodecs spec converts a frame to the canvas's colour space when
drawn, so PQ or HLG frames are tone-mapped or clipped to SDR. WebKit has been reported to label decoded HDR frames
as BT.709 and to throw on a `rec2100-pq` 2D canvas, which gives a flat, washed-out picture. On a TV the canvas also
goes through the browser's graphics plane, not the video plane the TV processes and displays in HDR.

### HDR canvas: not a route today

Chrome 129 added WebGPU's `toneMapping: { mode: 'extended' }` with an `rgba16float` canvas, which can show values
brighter than SDR white on an HDR display. It does not make video HDR by itself: `importExternalTexture` converts a
frame to sRGB or Display P3 (P3 since Chrome 121), so a player would have to undo PQ itself, and nothing documents an
end-to-end HDR video path this way. Safari's support is partial and reported inconsistently, Firefox has none, and
whether a TV's browser composites an extended canvas in HDR is unknown. Not a basis for a design.

### The route: the video element with overlays above it

Feed the disc's video to a `<video>` element through MSE, and keep drawing everything else (PG, IG, BD-J's
graphics plane, text and ASS subtitles) on a transparent canvas above it. This is the standard way, and it gives HDR
wherever the browser plays HDR video, plus the TV's hardware video plane and picture processing on TVs.

What it would take:

- **Remux, not decode**: the demuxer already yields the H.264 and HEVC access units; they go into fragmented MP4
  (`avc1`/`hvc1` sample entries built from the SPS, PPS and VPS, which `@seikou/bdmv/codecs` already parses),
  carrying the colour description (`colr` nclx: BT.2020, PQ or HLG) and the static HDR metadata (`mdcv` and `clli`
  boxes, filled from the stream's mastering-display and content-light-level SEI). Chrome had trouble with HEVC static
  metadata before Chrome 123 (*unverified*); the boxes are the reliable signal.
- **The clock**: the video element plays on its own clock. Either the video becomes the master clock (read through
  `requestVideoFrameCallback`, whose `mediaTime` is the presented frame's time, and the AudioWorklet follows it), or
  the audio stays master and the video's `playbackRate` is nudged to follow it. Feeding audio to MSE too would make
  the browser keep sync, but MSE takes no PCM, and passthrough codecs (AC-3, E-AC-3) are platform-dependent.
- **Play items and seeks**: `timestampOffset` per play item places each clip on the playlist timeline; a seek
  becomes `remove` plus appending from the new EP-map entry.
- **Overlays**: they are already drawn on their own planes; they would go to a canvas positioned over the video,
  timed by `requestVideoFrameCallback`, so subtitles stay frame-accurate.
- **What stays on WebCodecs**: shaders need the decoded frame (WebGL2), so a player with Anime4K on keeps the canvas
  path (SDR). Browsers whose MSE can't play the stream (Firefox has no HEVC through MSE in most setups) keep it too.
  So this is a second presentation backend, chosen per stream, not a replacement.
- **Where it helps most**: UHD HDR discs on Safari (Mac, iPhone, iPad), Chrome on HDR displays, and TVs, where it
  also takes 4K decode off the canvas path that the TV struggles with.

To check on a TV before any design: `MediaSource.isTypeSupported` and `navigator.mediaCapabilities.decodingInfo`
(with `hdrMetadataType`, `colorGamut` and `transferFunction`) for 4K HEVC Main10 PQ, and a short fragmented MP4 of
a real UHD clip appended to a `<video>`. Both fit in the probe.

## Sources

- Samsung, Web Engine Specifications: https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html
- Samsung, 2026 TV Video Specifications: https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html
- Samsung, Tizen WASM Player: https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/tizen-wasm-player/overview.html
- Samsung, TV Device (Developer Mode): https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html
- Samsung, OS upgrades: https://www.samsung.com/us/support/answer/ANS10003894
- Kodi, WebCodecs decoder tested on a 2025 Samsung OLED: https://github.com/xbmc/xbmc/pull/29800
- Apps2Samsung, permit-install rule: https://github.com/Apps2Samsung/Apps2Samsung (`Apps2Samsung.Core/Sdb/TizenInstallSupport.cs`)
- Apple, WKWebView availability: https://developer.apple.com/documentation/webkit/wkwebview
- YouTube, HDR uploads: https://support.google.com/youtube/answer/7126552
- Chrome, HDR video in Chrome 63/64: https://developer.chrome.com/blog/media-updates-in-chrome-63-64
- Chrome, WebGPU extended tone mapping (Chrome 129): https://developer.chrome.com/blog/new-in-webgpu-129
- Chrome, HDR external textures (Chrome 121): https://developer.chrome.com/blog/new-in-webgpu-121
- W3C, WebCodecs (colour conversion when drawn): https://www.w3.org/TR/webcodecs/
- libmedia, PQ frames flat in Safari: https://github.com/zhaohappy/libmedia/issues/70
- Google, Cobalt: https://support.google.com/youtube/answer/14005097
- webOS Brew, video plane punch-out: https://www.webosbrew.org/develop/guides/media-basics/
- Chromium HEVC notes: https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding
