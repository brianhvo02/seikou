# HDR overlays at graphics white

Status: first slice built on 2026-11-24 (branch `hdr-overlays`): over an HDR stream on the element path, on a display
that reports HDR, PG, text, IG and BD-J graphics are presented through a WebGPU canvas in extended range at a gain of
2.03 over SDR white, where the browser offers that from a worker; everywhere else they are drawn as before. The gain is
a fixed assumption (below) that the owner should judge by eye on the iPhone and tune with `?hdrgain=`; no device check
of the brightness was possible tonight.

## Why

On the element path (spec `2026-11-15-hdr-video-element-design.md`) an HDR stream plays in the page's `<video>`, and the
engine draws subtitles and menus on its transparent 2D canvas above it. That canvas is SDR: its white is the display's
SDR white. On an HDR display the video's diffuse white sits well above SDR white, so white subtitles and menus look
dim and grey next to the picture. BT.2408 puts graphics, subtitles included, at "graphics white", 203 cd/m² (PQ code
0.58, or 75% HLG on a 1000 cd/m² display).

## Goals

- Over HDR video on an HDR display, draw every overlay (PG, text, IG, the BD-J plane, the BD-J background still that
  shows until the element's first frame) with its white at graphics white instead of SDR white.
- Do it from the engine worker, where the overlays are drawn today, on the browsers that can.
- Detect the capability; anything less falls back to today's SDR drawing, and SDR playback (the canvas path, SDR
  streams on the element, an SDR display) is never changed.

## Non-goals

- The canvas path's HDR (known issue "HDR on the canvas path stays flat"): video drawn by WebCodecs stays SDR.
- Tone mapping, or matching each display's headroom: a gain past the headroom clips at the display's peak, which for
  white graphics is what a TV's own subtitles do.
- A user-facing setting for the brightness (the owner's call once it has been seen on a device).

## What browsers offer (measured 2026-11-24)

Probed with a script in the page (`navigator.gpu`, a WebGPU `OffscreenCanvas` context in a page and in a worker, 2D
contexts with `colorType` and `colorSpace`, `copyExternalImageToTexture`):

| | Safari 27.2, iPhone 17 Pro (HDR display) | Chrome 158 headless (Mac) | Playwright WebKit (Mac) | Playwright Firefox (Mac) |
| --- | --- | --- | --- | --- |
| `(dynamic-range: high)` | true | false | true | false |
| 2D `colorType: 'float16'` | ignored (reads 8-bit) | stores > 1 | ignored | – |
| 2D `colorSpace: 'rec2100-pq'/'-hlg'/'-linear'` | TypeError | TypeError | TypeError | – |
| 2D `toneMapping` / `configureHighDynamicRange` | absent | ignored / absent | absent | – |
| WebGPU `rgba16float` + `toneMapping: { mode: 'extended' }` | kept, in a worker too | kept, in a worker too | kept, in a worker too | no adapter |
| `copyExternalImageToTexture` from a 2D `OffscreenCanvas` | works | works | works | – |
| A PQ `VideoFrame` copied into an `srgb` float texture | passed through unconverted | tone mapped to SDR | passed through | – |

So the one HDR route the target browsers share from a worker is a WebGPU canvas configured `rgba16float` with extended
tone mapping, where a value of 1.0 is the display's SDR white and values above it are brighter.
*(My call: WebGPU, not a float16 2D canvas. Safari ignores `colorType`, so a float16 2D canvas would leave the iPhone,
the device with the problem, as it is, and Chrome's float16 2D canvas has no extended mode to show values above 1.)*

## Approach

Approaches considered:

1. **A float16 2D canvas** for the overlays. Rejected above.
2. **Make the engine's one canvas a WebGPU canvas.** The whole canvas path draws with 2D (`drawImage` of decoded
   frames, the ASS renderer's Canvas2D runs, `putImageData` planes), and a canvas's context type is fixed at its first
   `getContext`. Rewriting the compositor on WebGPU is a large change to the SDR path, which must not change.
3. **A second, page-owned canvas for HDR overlays (chosen).** The page stacks another canvas over the video canvas and
   hands it to the engine as an `OffscreenCanvas`, untouched until needed (a canvas with no context costs nothing and
   shows nothing). While an HDR stream plays on the element and the display reports HDR, the compositor draws its
   overlays exactly as today, but onto a 2D layer canvas of its own instead of the visible one, and a WebGPU presenter
   copies the layer onto the HDR canvas with the gain applied. The visible 2D canvas is cleared to transparent.
   *(My call: approach 3 — the SDR path keeps its code, the HDR route is one extra copy and draw per repaint, and the
   overlays' own drawing (PG, ASS, IG, BD-J) stays one implementation.)*

## Design

### Colour maths (`packages/engine/src/render/hdr-overlay.ts`, pure)

- `pqEotf(code)` gives cd/m² from a PQ code (SMPTE ST 2084), and `hlgDisplayLuminance(signal, peak = 1000)` the
  luminance of an achromatic HLG signal on a display of that peak (BT.2100's OETF⁻¹ and OOTF, system gamma 1.2 at 1000
  cd/m²). They document and test where 203 comes from: PQ 0.5806 → 203 cd/m², 75% HLG on 1000 cd/m² → 203 cd/m².
- `GRAPHICS_WHITE_NITS = 203` (BT.2408).
- `graphicsWhiteGain(sdrWhiteNits = 100)` = 203 / sdrWhiteNits: the linear factor that takes SDR white to graphics white
  when the browser shows its extended-range 1.0 at `sdrWhiteNits`. *(My call: one default gain of 2.03 for PQ and HLG
  alike, which assumes the browser presents PQ and HLG absolutely with SDR white at 100 cd/m², BT.2408's reference
  for SDR and, as far as known, Apple's EDR mapping of HDR10 (an output scale of 100 cd/m² at 1.0). No web API gives
  the display's SDR white in cd/m², and the measurement tried tonight (a PQ `VideoFrame` copied into an extended
  texture) does not reflect the browser's mapping: Safari passes the code through and headless Chrome tone maps to SDR.
  On Windows Chrome reads the system's "SDR content brightness", so the right gain there is 203 over that setting;
  the default is a guess the owner should judge by eye, which `?hdrgain=` makes easy.)*
- `scalePremultiplied([r, g, b, a], gain)`: the presenter's shader in TypeScript, for tests: unpremultiply, decode
  sRGB, multiply by the gain, encode with the extended sRGB transfer (sign-preserving, CSS Color 4), premultiply.
  White at gain 2.03 encodes to about 1.362; black and transparent stay 0; a half-transparent white keeps its alpha
  and gives 0.681.
- `clampGain(n)`: a gain from the page's `?hdrgain=` is kept within 1 to 10 (never dimmer than SDR; 10 is far beyond
  any display's headroom); anything not a finite number gives the default.

### The presenter (`packages/engine/src/render/hdr-presenter.ts`)

`HdrOverlayPresenter` is the interface the compositor uses: `present(source: OffscreenCanvas, gain)`, `clear()`,
`resize(width, height)`, `dispose()`. `createWebGpuHdrPresenter(canvas, gpu, onLost)` builds it and answers null (with
the reason, for telemetry) when anything is missing:

- no `navigator.gpu` in the worker, no adapter, no device;
- `getContext('webgpu')` is null, or `configure` throws;
- the context's `getConfiguration()` doesn't report `toneMapping.mode === 'extended'` (a browser that doesn't know the
  member drops it silently, and would clamp at SDR white).

It configures `rgba16float`, `alphaMode: 'premultiplied'`, `colorSpace: 'srgb'`, extended tone mapping. `present`
copies the layer into a texture (`copyExternalImageToTexture`, premultiplied) recreated when the size changes, and draws
one full-screen triangle with the WGSL form of `scalePremultiplied` (gain in a uniform). `clear` presents a cleared
texture. A lost device calls `onLost`, after which the engine stops using it (the overlays go back to the 2D canvas)
and doesn't try again for the disc. *(My call: no retry after a lost device — the SDR fallback is what plays today,
and a device lost twice is likelier than a fix.)*

### Compositor

`CompositorLike` gains `setHdrPresenter?(presenter, gain)` (null to stop), `startPlaylist`'s element option gains
`hdr`, and `present?()`, which the player calls at the end of every paint that drew. The compositor is in HDR overlay
mode while it is in element mode for an HDR stream and has a presenter. In that mode its drawing target is a 2D layer
canvas of the visible canvas's size instead of the visible canvas (which it clears once, so nothing SDR stays over the
video), and `present()` hands the layer to the presenter. Leaving the mode (the next playlist, the element failing over
to the canvas path, the presenter taken away) clears the HDR canvas and draws on the visible canvas again.

### Engine

- Protocol: `attachHdrCanvas { canvas: OffscreenCanvas; displayHdr: boolean; gain: number }` (transferred) and
  `setDisplayHdr { displayHdr }`.
- `PlayerDeps.createHdrPresenter?(canvas, onLost)`: the engine worker's default builds the WebGPU presenter from
  `navigator.gpu`; tests inject fakes, and without it the engine never presents in HDR.
- The presenter is made lazily, the first time an HDR element session starts while the display reports HDR, so a
  WebGPU device is never opened on an SDR display or for SDR discs. It is handed to the compositor while the display
  reports HDR and taken back when it stops (an iPhone dimmed into low power, a window dragged to an SDR monitor).
- `Telemetry.hdrOverlay`: `{ displayHdr, presenter: 'none' | 'pending' | 'webgpu' | 'unavailable' | 'lost', reason,
  active, gain }`, null until the page attached an HDR canvas.

### Page

`PlayerController.attachHdrCanvas(canvas, { gain? })` transfers the canvas once (as `attachCanvas` does), reads
`matchMedia('(dynamic-range: high)')` and sends its changes. `PlayerScreen` renders `<canvas data-testid=
"hdr-overlay-canvas">` over the video canvas, never taking pointer events, and passes `?hdrgain=` (owner tuning). The
test-only `?displayhdr=1` makes the controller report an HDR display, so the route can be tested in a headless browser.
*(My call: the controller, not the app, watches `(dynamic-range: high)`, as it already asks the page's media
capabilities for the element path: an embedder gets the right behaviour from one call.)*

## Constraints

- SDR playback is untouched: the mode needs the element path, an HDR stream, a display reporting HDR and a working
  presenter. The visible canvas keeps its 2D context and alpha.
- The presenter's work happens only on a repaint that drew (the player already skips frames where nothing over the
  video changed), so a feature with no subtitle on screen costs one cleared present.
- No new resources across origins (`require-corp` unaffected).

## How it is tested

- Unit: the maths on known values (PQ 0.5806 → 203, HLG 0.75 → 203, gain 2.03, encoded white 1.362, alpha and black),
  `clampGain`; the presenter's detection with fake GPUs (each failure answers null with its reason; extended kept gives
  a presenter; `present` copies, sets the gain and draws; a lost device calls back); the compositor's mode switch with
  fake canvases (draws go to the layer, the visible canvas is cleared, `present` hands over the layer, leaving clears);
  the player's lazy creation, display changes and fallback with a fake presenter; the controller's matchMedia wiring.
- Browser (Playwright, Chromium with real WebGPU, `?displayhdr=1`): disc-hdr on the element path shows its PG subtitle
  through the HDR canvas (telemetry `hdrOverlay.active`, presenter `webgpu`, gain 2.03; the visible canvas transparent
  where the subtitle is); without `?displayhdr=1` nothing changes (presenter `none`).
- Device (iPhone 17 Pro, Safari 27.2): the probe above. Brightness can only be judged by eye; screenshots don't keep
  HDR. What to look at is in the night report.

## Left open

- The right gain per browser and platform (above), and whether the owner wants a setting.
- Firefox: no WebGPU adapter in Playwright's Firefox on the Mac; it falls back.
