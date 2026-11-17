# Deinterlacing: live footage at field rate, film and anime reassembled

Status: design, approach chosen by the owner 2026-11-17 (the full version). Roadmap item "Deinterlacing for 1080i
discs" (`docs/roadmap.md`, Later).

## Why

A Blu-ray stores some video as interlaced: 1080i, and 480i or 576i on standard-definition extras. Each coded frame
is two fields captured 1/50 or 1/60 s apart, woven line by line. Seikou draws the woven frame as it comes, so
anything moving shows comb teeth. The owner's library has a lot of it: of the BD-J discs alone (the ones with local
copies), 26 of 125 H.264 discs, 45 of 57 MPEG-2 discs and 8 of 36 VC-1 discs have interlaced clips. The content is of
both kinds: live footage (concerts, TV shot on video), where each field is its own moment, and film or anime stored
as 1080i with 3:2 pulldown, where the original 24 frames a second were split into fields in a repeating pattern.

## Goals

- Interlaced video shows no combing.
- **Live footage** plays at field rate: every field becomes a full frame (59.94 or 50 frames a second), with full
  detail kept where nothing moves.
- **Film and anime** stored with 3:2 pulldown are detected and reassembled into their original progressive frames,
  exactly, and play at 23.976 frames a second, with no softening and no pulldown judder.
- The choice is automatic and follows the content as it plays: a concert disc's bonus film or an anime's live-action
  ending is handled as what it is. A switch is not visible as a glitch.
- Picture stays in sync with sound within today's bounds (20 ms mean, 50 ms max A/V offset) in every mode and across
  switches.
- Works on desktop browsers and recent iPhones and iPads (Safari) within the frame budget.
- Frames come through one interface from WebCodecs (H.264 today) and from the in-browser MPEG-2 and VC-1 decoder
  (next project), so those discs are deinterlaced the day they get a picture.

## Non-goals

- The MPEG-2 and VC-1 decoder itself: its own design next (speed test 2026-11-17: viable single-threaded on an M5
  Max and an iPhone 17 Pro).
- Deinterlacing in the NAS's quality levels (moot once the browser decodes those discs).
- The page's `<video>` element path: interlaced streams are SDR and go to the canvas path under Auto; with Video
  output set to "Video element" the browser does what it does.
- Upscaling 480i/576i beyond what the compositor already does, and Anime4K changes.
- Field-level editing artefacts beyond the cadences below (2:2:2:4, 3:3, VFR anime credits are handled as video).

## Anti-goals

- Film or anime made soft or juddery because it was treated as video when the cadence was clear.
- Live footage made to stutter because it was mistaken for film.
- Visible flips between modes on a cadence break (a scene cut, a pulldown phase change).
- Progressive discs touched at all.
- Sound drifting out of sync on interlaced discs.

## Approaches considered

- **Chosen: full version.** A WebGL2 stage in the engine worker deinterlaces motion-adaptively at field rate, and a
  cadence detector reassembles 3:2 film, both automatic.
- Field-rate deinterlacing only (no film detection): simpler, but film and anime come out soft with a stutter;
  offered as a first step and declined.
- The browser's own deinterlacing through the `<video>` element: whether and how well it happens depends on browser
  and hardware and can't be detected from the page.

## Design

### Which streams

A stream is interlaced when its CLPI video format is 1 (480i), 2 (576i) or 4 (1080i). Progressive streams (3, 5,
6, 7, UHD) skip the stage entirely. Within an interlaced stream individual pictures may be progressive (frame-coded
film, a progressive_frame flag); the detector handles them by their content, not by trusting flags alone.

Field order (which field is first in time) comes from the stream where it says so: H.264 `pic_struct` in picture
timing SEI, and MPEG-2 `top_field_first` and VC-1 `TFF` from the WASM decoder's frame flags. The H.264 part is new
work (my call to include it): the demux parses only recovery-point SEI today, so it needs the SPS VUI's
`pic_struct_present_flag` and HRD delay lengths, and a mapping from SEI in decode order to the frames WebCodecs
outputs in presentation order. Where it doesn't say, the detector measures it from motion (as FFmpeg's `idet` does), with
top field first as the starting assumption (the Blu-ray norm).

### Where it runs

A `Deinterlacer` in the engine worker (`packages/engine/src/deinterlace/`), on WebGL2 like the shader stage. Decoded
frames of an interlaced session go to it instead of the presenter:

1. **Field store.** Each decoded frame is copied into a ring of **YUV plane textures** (luma and 4:2:0 chroma, as
   the codec made them) and the `VideoFrame` closed at once, so the decoder's frame pool is never held by lookahead.
   The stage works on planes, never on the browser's RGB conversion, which treats an interlaced 4:2:0 frame as
   progressive and blends the two fields' chroma before any deinterlacing (my call, from the review): WebCodecs frames
   are read with `VideoFrame.copyTo` (a CPU copy of about 3 MB per 1080 frame) and uploaded; the WASM decoder hands its
   planes over directly, so planes plus field flags are the one interface both decoders feed. Conversion to RGB happens
   once, after deinterlacing, with the stream's matrix. The ring is sized to hold everything still referenced: the
   detector's lookahead, the deinterlacer's neighbours, and the source frames of every picture queued in the
   presenter (about 12 frames, 36 MB at 1080; 8 under the constrained profile). Decode-ahead is gated on the ring, not
   on the presenter's picture count (my call).
2. **Metrics.** On upload, a few GPU passes compute per-field statistics: field-to-field differences against the
   neighbouring frames' fields and a comb measure for each candidate field pairing, reduced on the GPU to a handful of
   numbers per frame and read back asynchronously (a pixel-pack buffer and a fence), never stalling the GPU.
3. **Cadence detector.** Pure TypeScript, fed the numbers, decides for each frame: woven as is (progressive), matched
   (film: which neighbouring field completes it), or deinterlaced (video), and which matched frames are the duplicates
   to drop. It works over a cycle of 5 frames with hysteresis: it locks onto 3:2 after a run of consistent cycles,
   keeps the lock through scene cuts and fades where the metrics are ambiguous, and leaves it only when combing appears
   that matching can't remove. It is the unit-tested heart of the feature.
4. **Pictures.** The detector's decisions become output pictures queued in the presenter in place of frames: each
   names its source textures, the operation (weave, match with a neighbour's field, or motion-adaptive interpolation of
   one field) and its timestamp. Video mode makes two pictures per frame, half a frame apart; film mode makes 4 per
   5-frame cycle at an even 1001/24000 s spacing; progressive makes one. **Soft pulldown** is film too (my call): 24p
   carried as progressive frames with repeat-field flags (MPEG-2 `repeat_first_field`, common on 480i extras; H.264
   `pic_struct` 5 and 6) decodes to progressive frames with an uneven 3:2 spacing of timestamps, which the detector
   evens out to 1001/24000 s, so those play without judder as well.
5. **Drawing.** When the presenter selects a picture, the deinterlacer renders it into its output canvas, which the
   compositor draws where it draws a frame today (and which the shader stage takes as input when a set is on, so
   Anime4K works on clean frames).

The detector's lookahead is a few frames (about 200 ms of decode ahead of presentation), which the decoder already
runs ahead by; a seek or a new play item restarts the detector, which shows interpolated pictures until it locks
again.

### Algorithms

- Motion-adaptive interpolation: a port of FFmpeg's `bwdif` (LGPL-2.1) to GLSL, which keeps the woven line where the
  temporal neighbours agree and interpolates where they don't.
- Field matching and decimation: an independent design, not a port (my call). The technique is well known (score the
  current, previous and next field pairings by combing and keep the cleanest; in each 5-frame cycle drop the frame
  most like its neighbour), and we write it from that description and our own tests. FFmpeg's `fieldmatch` and
  `decimate` are GPL, and VapourSynth's VIVTC, though LGPL, is described by FFmpeg as a light clone of the GPL TIVTC,
  so none of the three is ported, copied or followed line by line.
- Every ported file keeps `LGPL-2.1-or-later`, names its upstream and copyright lines in its first 15 lines, and is
  listed in the engine's `NOTICE` (the repo's licensing rules).

### Settings and telemetry

- The Video output menu gains "Deinterlacing: Auto / Off", a device setting like Video output itself
  (`localStorage`), applied at once. Off draws the woven frames as today.
- `Telemetry.deinterlace`: the stream's field order and where it came from, the current mode (progressive, film,
  video), cadence locks and breaks counted, the GPU time per picture, and the ring size.

### Performance

The budget is one picture per display refresh at field rate, plus the metrics passes per frame and the plane copy. On
a device that can't keep up, the stage falls back to its cheapest correct path: field matching stays, and
motion-adaptive interpolation becomes plain field interpolation. The trigger is frame pacing, which every browser can
see (pictures presented late or dropped across a window), not GPU timer queries, which Safari and Firefox lack. That
is logged in telemetry, with no notice; the telemetry's GPU time is null where the browser has no timer query.

### Edge cases

- Pause shows the current picture.
- A still at a play item's end (the held clock) shows the last picture.
- BD-J and HDMV menus over interlaced video draw over the deinterlaced picture as they draw over frames now.
- A play item change or seek clears the ring and restarts the detector.
- WebGL2 missing or its context lost: frames are drawn woven, as today, and telemetry says why.

## Open fact to settle first

Whether Safari's WebCodecs decodes interlaced H.264 (PAFF and MBAFF) at all, and what it outputs (one woven frame
per field pair with one timestamp, as Chrome's software decoder does; `video-decoder.ts` already sends interlaced AVC
to Chrome's software decoder). The first task checks it on Mac Safari and an iPhone with the 1080i fixture. If Safari
can't, interlaced H.264 on Safari waits for the in-browser decoder, which then gains FFmpeg's H.264 decoder for that
case alone (my call; its speed is measured then), and everything else here is unchanged.

## Testing

- Unit: the cadence detector over recorded metric sequences (clean 3:2, scene cuts mid-cycle, phase changes, video,
  mixed film with video titles, fades, static scenes), checking decisions exactly.
- Fixtures: generated, never from the owner's discs. `scripts/` builds 1080i H.264 clips with ffmpeg (libx264,
  interlaced, top and bottom field first) from moving synthetic content, and 3:2 telecined 24p clips (FFmpeg's
  `telecine` filter, LGPL, used only to make fixtures). Committed under `fixtures/synthetic/`.
- Fixtures also include soft pulldown (x264's `--pulldown 32`).
- Pixel checks on planes: our output against references computed by FFmpeg (`bwdif` on the same planes; for film, the
  untelecined source frames), by PSNR thresholds per mode.
- E2E: A/V sync on an interlaced fixture in video and film mode, the Off switch, telemetry modes; WebKit and Chrome
  as the element-path tests do.
- Device check: iPhone and iPad GPU time on a real 1080i disc (over HTTPS).

## Left to the builder

The ring and metric texture formats, the exact metric definitions and thresholds (tuned on the fixtures and checked
on real discs), the detector's lock and unlock counts, how the fall-back path is chosen, and the telemetry field
names.
