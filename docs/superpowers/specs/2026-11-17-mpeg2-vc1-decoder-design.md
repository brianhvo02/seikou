# MPEG-2 and VC-1 pictures in the browser

Status: design, approach chosen by the owner 2026-11-17 (a decoder worker of its own; NAS discs offered at Original).
Roadmap item "MPEG-2 and VC-1 pictures in the browser" (`docs/roadmap.md`, Next).

## Why

No browser decodes MPEG-2 or VC-1, so today a playlist with either plays without a picture: sound, subtitles and IG
or BD-J graphics over black, with the `no-picture` notice (5e, ruling R12; `isSupportedVideoCoding` in
`packages/engine/src/decode/video-decoder.ts`). NAS discs get a picture only by having the NAS re-encode them on its
GPU at a lower quality level, never at Original (`UNPLAYABLE_VIDEO` in `server/src/levels/levels.ts`). The owner's
library has many such discs: of the BD-J discs with local copies alone, 57 have MPEG-2 and 36 VC-1 video, and 45 and
8 of them have interlaced clips, which the new deinterlacer (spec `2026-11-17-deinterlacing-design.md`) is waiting to
take. A speed test on 2026-11-17 (FFmpeg n9.0.2's decoders as WASM, one thread, SIMD, real disc excerpts) found it
viable: iPhone 17 Pro over HTTPS about 280 fps MPEG-2 1080, 117 fps VC-1 1080i (field pairs), 100 fps VC-1 1080p; an
M5 Max 320 / 135 / 112.

## Goals

- MPEG-2 and VC-1 video (and MPEG-1, which the same decoder covers; my call) plays with a picture on every supported
  browser (Safari 26 on macOS, iOS and iPadOS; Chrome and Firefox desktop; Chrome Android), from local folders, the
  dev disc server and the NAS.
- Interlaced pictures go to the deinterlacer as planes with the stream's field flags (MPEG-2 `top_field_first`,
  `progressive_frame`, `repeat_first_field`; VC-1 TFF and RFF), so they are deinterlaced, film reassembled and soft
  pulldown evened out exactly as for H.264.
- Progressive pictures play like H.264 frames today: the same presenter, clock, seek, pause, subtitles, menus, BD-J
  planes and shader sets.
- A/V sync within today's bounds (20 ms mean, 50 ms max offset).
- **NAS discs at Original** (owner's call): a NAS disc with MPEG-2 or VC-1 video is offered at Original to a browser
  that can decode it here, at full quality and with no GPU work on the NAS; the re-encoded levels stay for slow
  connections and for clients that can't.
- The `no-picture` path stays for what still can't be decoded (no workers, the decoder failing to load), with its
  notice.

## Non-goals

- H.264 or HEVC through this decoder (WebCodecs does both; Safari decodes interlaced H.264, checked 2026-11-17).
- The `<video>` element path for these codecs: MSE plays neither, so they always take the canvas path.
- Changes to the NAS's quality levels beyond offering Original.
- Hardware decoding of any kind.
- The encoder app (`encoder/`), which reads discs through BestSource and is unaffected.

## Anti-goals

- A disc that played (sound, menus, subtitles) without a picture now failing to play at all because the decoder is
  slow, missing or broken: the fall-back is today's no-picture playback, never a dead player.
- Decoding on the engine worker's thread, starving the clock, the deinterlacer and BD-J (the reason approach B was
  declined).
- Loading the decoder for discs that don't need it.
- An older client (a cached service worker) offered Original for an MPEG-2 disc it can't decode.

## Approaches considered

- **Chosen: a decoder worker of its own.** The engine worker starts a dedicated worker (as it starts the BD-J
  worker) that runs FFmpeg's decoders in WASM; the engine sends it access units and receives pictures. Decoding
  (about 8.5 ms a VC-1 1080i frame on the iPhone) never competes with the engine's own work. It costs a worker's
  start-up and one plane copy a picture between threads (about 3 MB at 1080, transferred).
- Decoding in the engine worker: simpler, no extra worker, but the decode time lands on the thread that keeps time
  and feeds the deinterlacer; on a phone VC-1 at field rate leaves little room. Declined.
- Re-encoding on the NAS only (today's levels): no help for local folders or the dev disc server, loses quality, and
  costs GPU time. It stays as the slow-connection option.

## Design

### The WASM module

- `packages/engine/wasm/video/`: `video.wasm` built from FFmpeg n9.0.2 (the tag `audio.wasm` uses) with
  `--enable-decoder=mpeg1video,mpeg2video,vc1 --enable-parser=mpegvideo,vc1`, compiled `-O3 -msimd128` (as the speed
  test was; every supported browser has WASM SIMD), plus an LGPL-2.1-or-later `shim.c` (stated reason: it links
  FFmpeg, as the audio shim) exposing open, decode, flush/reset, close and a way to read a decoded picture's planes,
  timestamps and field flags. Built reproducibly in the pinned emsdk image by `build.sh`, run from `npm run
  wasm:build` (a new `wasm:build:video`), committed with its `.sha256`, and rebuilt and diffed by CI's `wasm.yml`
  like the other two modules. Listed in the engine's `NOTICE`.
- Single-threaded (no pthreads, so no SharedArrayBuffer inside the module and no extra COOP/COEP needs).
- The parsers split the PES payloads the demux hands over into pictures (Blu-ray PES boundaries are not guaranteed
  to fall on pictures), so the shim takes bytes with their PES timestamps and gives back pictures with theirs.
- VC-1 on Blu-ray is Advanced Profile, whose sequence and entry-point headers are in the stream; the shim opens the
  decoder from them (the speed test found VC-1 needs them as extradata to open).
- Fetched only when a playlist with MPEG-1, MPEG-2 or VC-1 video first opens, from the build's asset URL, with the
  same timeout as `audio.wasm`, and kept by the service worker in a runtime cache (as the Anime4K shaders are), not
  the precache.

### The decoder worker

- A module worker entry in the engine package (`packages/engine/src/decode/` or a `wasm-video/` folder; builder's
  call) that loads `video.wasm` and decodes. One per disc open, started at the first playlist that needs it and
  stopped when the disc closes (or kept idle across playlists; builder's call, but not one per playlist start if
  that costs visible start-up).
- The engine worker reaches it through an injected factory on `PlayerDeps` (like `createAudioDecoder`, and BD-J's
  `createWorker`), so `Player` tests use a fake and no engine file names a browser `Worker` directly. The app's
  `src/engine-worker.ts` and the package's own `worker.ts` both pass the real one.
- Messages: configure (codec, the CLPI's size and rate), decode (an access unit's bytes and playlist time, and its
  `discard` flag), flush, reset, close; back: a picture (planes as an `ArrayBuffer` transferred, layout, playlist time,
  field flags), errors, and flush done. Bounded in flight, so a slow decoder exerts backpressure on the pipeline as
  WebCodecs' `decodeQueueSize` does today.
- `discard` units (before a seek target, outside the play item) are decoded for reference and never sent back.

### In the engine

- A `WasmVideoDecoder` implementing the engine's `Decoder<VideoUnit, VideoFrame>` with `onFieldInput`, exactly the
  surface `WebCodecsVideoDecoder` offers, chosen in `Player` for MPEG-1, MPEG-2 and VC-1 coding types.
  `isSupportedVideoCoding` becomes "decodable here": true for these codings when the decoder worker can be started.
- **Interlaced streams** (CLPI format 480i, 576i, 1080i): pictures go to `onFieldInput` as `FieldInput` (planes as
  I420, the stream's flags), with no `VideoFrame` made, so the deinterlacer gets them as it gets H.264's planes.
- **Progressive streams**: each picture becomes a `VideoFrame` built from its I420 planes (`new VideoFrame(buffer,
  { format: 'I420', … })`, with the colour space from the sequence header's matrix, else by height as today) and
  goes to the presenter like a WebCodecs frame, so shaders, capture and every other frame consumer are unchanged.
- **Field flags and soft pulldown**: MPEG-2 soft pulldown (progressive frames with `repeat_first_field`, common on
  480i extras) and VC-1 RFF map onto `FieldFlags` as H.264's `pic_struct` does; the detector's soft-pulldown path
  then evens them to 1001/24000 s.
- **Too slow**: when the decoder falls behind the clock, the worker skips non-reference pictures (B pictures) until it
  catches up, counted in telemetry; pictures still late are dropped by the presenter as today. A skip in an interlaced
  stream is a cadence break for the detector (it restarts its cycle there, as at a cut), never a gap it misreads as a
  different pattern. No notice. If the
  worker or the module fails (load, a crash, an error it can't recover from), the playlist goes on without a picture
  through today's path, with the `no-picture` notice and the reason in telemetry.
- **No workers** (`?nonestedworkers=1`, or a browser that can't start one from a worker): today's no-picture
  playback.
- Telemetry gains the decoder in use for the playing playlist (`webcodecs` or `wasm`), its decode time per picture,
  and pictures skipped.

### NAS discs at Original

- `levelsFor` offers `original` for MPEG-1, MPEG-2 and VC-1 video when the client says it decodes them, a new
  query parameter on `GET discs/<id>/levels` beside `hevc=`, `hevc10=` and `hdr=` (my call: e.g. `mpeg2=1&vc1=1`),
  and not otherwise, so an older client never gets an Original it can't play.
- `src/ui/video-caps.ts` reports these codings as playable when the decoder can run here **and is fast enough**
  (below), and the pre-flight sends the parameter; the auto choice then prefers Original as it does for H.264 discs.
- **Fast enough** (my call): the speed test measured only an M5 Max and an iPhone 17 Pro, and an older phone may
  decode VC-1 1080i slower than real time. The first time a device needs it, the decoder times a short committed
  clip of each codec (MPEG-2 and VC-1, from the committed fixtures) and keeps the result in `localStorage` with the module's hash, so a new build measures
  again. A codec counts as playable at Original when it decodes 1080 at 1.5× its frame rate or better (field pairs for
  interlaced). Below that a NAS disc's auto choice takes a re-encoded level, Original stays in the list as available,
  and a local disc still plays through the decoder (there is nothing better), with skipping as below.
- **Original failing on a NAS disc** (my call): when the WASM decoder fails, or keeps skipping for more than 10 s of
  playback, on a NAS disc opened at Original with a re-encoded level available, the player switches to the auto level
  through the existing level switch (`setLevel`, same place, the level notice), instead of playing on without a
  picture. A local disc falls back to no picture as above.
- This needs a NAS server deploy, which the owner runs.

### Edge cases

- A seek or a play item change: reset or flush as the WebCodecs decoder does; the first picture after a reset is from
  the next sequence header and I picture.
- An MPEG-2 sequence or VC-1 entry point that changes size mid-stream: the deinterlacer ring and presenter already
  handle a size change at a play item; within one, the decoder reports the new size and the session restarts its
  ring.
- A broken picture: FFmpeg conceals it; a decode error is counted like a WebCodecs one (the existing fatal limit).
- BD-J and HDMV menus over MPEG-2 or VC-1 motion menus (common on MPEG-2 discs) draw over the picture as over H.264.
- Discs with an MPEG-2 or VC-1 video and the `no-picture` notice today lose the notice; the 5e library check's
  `unsupported-video` verdict becomes a normal verdict for those discs.

## Testing

- Unit: the `WasmVideoDecoder` against a fake worker (ordering, discard, reset, flush, backpressure, failure falling
  back to no picture), the field-flag mapping, and the `levelsFor` and video-caps rules.
- Module: a Node test runs `video.wasm` on committed fixtures and checks pictures, timestamps and flags against
  ffprobe's reading of the same stream.
- Fixtures, generated, never from the owner's discs: MPEG-2 progressive and interlaced (top and bottom field first),
  and MPEG-2 soft pulldown, from `scripts/` with ffmpeg's mpeg2video encoder (`disc-mpeg2-menu` already exists).
  VC-1 from a licensed third-party sample (see "VC-1 fixture").
- E2E: an MPEG-2 disc plays with a picture and in sync in every Playwright project; the interlaced one deinterlaces
  (modes as in `deinterlace.spec.ts`); the Off switch; the fall-back with the module made to fail (a test flag like
  `?bdjfail=1`); the NAS stand-in offers Original for an MPEG-2 disc only with the new parameter.
- Local discs: `LOCAL_DISCS=1` plays the owner's MPEG-2 and VC-1 discs and seeks; the BD-J library check reruns.
- Device check: an MPEG-2 1080i and a VC-1 1080i disc on the owner's iPhone 17 Pro over HTTPS, as the deinterlacer's
  check was run.

## VC-1 fixture (owner's call)

ffmpeg can't encode VC-1, so the VC-1 fixture is a third-party sample committed to the repo (the owner's choice over
covering VC-1 with local discs only). The first task finds one: a VC-1 Advanced Profile stream, ideally interlaced
1080i and a progressive one, from FFmpeg's FATE suite, SMPTE's or Microsoft's conformance material, or another public
source, whose licence is stated and allows redistribution in this public LGPL repository. The licence and source are
recorded beside the file (a README in its fixture folder and the `NOTICE` that covers fixtures), and the stream is
muxed into a small synthetic disc by `scripts/` like the others. A file with no stated licence is not committed. If
no suitable sample is found, the work stops there and asks the owner, rather than committing anything doubtful or
quietly dropping VC-1 from CI. Never a clip from the owner's discs.

## Left to the builder

The shim's API, the worker's message shapes and in-flight bound, whether the worker is kept across playlists, the
skip policy's thresholds, the picture buffer layout (one buffer per picture, or a pool returned by the engine), the
telemetry field names and the test flag's name.
