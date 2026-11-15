# HDR video through the browser's video element: design

Status: design, for review. Background: `2026-11-15-tv-platforms-and-hdr-research.md` §4.

## 1. Intent

UHD Blu-rays (HEVC Main10 with HDR10) should play in real HDR in the browser: highlights brighter than SDR white on
an HDR display, the picture tone-mapped by the browser and system on an SDR one. Today every frame is decoded with
WebCodecs and drawn on a 2D canvas, which is an SDR surface, so HDR discs look flat and dim. Browsers show HDR only
for a `<video>` element, whose frames go to the system compositor with their colour space and metadata; that is how
YouTube and every streaming site do it.

So Seikou gets a second way to show video, the **element path**: the engine remuxes the disc's video, without
decoding it, into fragmented MP4, the page plays it in a `<video>` element through Media Source Extensions, and
everything else (PG, text and ASS subtitles, IG menus, the BD-J plane) is drawn as now on the canvas, which becomes
transparent and sits on top. The audio output stays the master clock, and the video element is kept in step with it.

The path is built to carry any stream the browser's MSE can play. It starts on for HDR streams only, with a setting
and a test flag that force it for everything else; making it the default for all streams is a later decision, once
it has proven itself (the owner's aim). A Samsung TV playing HDR this way is a welcome side effect, not a goal.

## 2. Goals, non-goals, anti-goals

Goals:

- HDR10 discs play in HDR in Safari (macOS with an XDR or HDR display; iPhone and iPad) and in Chrome or Edge (macOS
  with an HDR display; Windows with HDR mode on), wherever the browser's MSE plays HEVC Main10.
- HLG streams are carried the same way (the colour description says HLG); they are rare on discs and cost nothing extra.
- Every feature that works on the canvas path works on the element path, at the same timing: chapters, seeks, play
  items and multi-clip playlists, angles' clip changes, audio track switches, PG and text subtitles, IG and BD-J
  menus, places and resume, quality levels on the NAS, the no-audio wall clock.
- A/V sync on the element path meets the same bounds as now: mean offset within 20 ms, largest within 50 ms.
- Any stream the browser's MSE plays (H.264, SDR HEVC) can be forced onto the element path, for testing and for the
  later decision to widen it.

Non-goals:

- Dolby Vision: its enhancement layer (a second video PID on UHD discs) is ignored; the HDR10 base layer plays.
- Promising HDR10+: its dynamic metadata stays in the bitstream's SEI and reaches the decoder; whether a browser
  honours it is the browser's business.
- HDR with Anime4K shaders: shaders need the decoded frames, so a stream with shaders on stays on the canvas path.
- HDR in Firefox, which has no HEVC through MSE in most setups: it keeps the canvas path.
- Encoded episodes (AV1 in MKV) and MPEG-2 or VC-1 discs: not on the element path in this work.
- Audio through MSE (approach C below): only if approach A fails.
- MSE in a worker, TV-specific work, user control over tone mapping.

Anti-goals (failure even if HDR shows):

- Any regression of the canvas path, which stays the default for SDR and must pass every existing test unchanged.
- Visible lip-sync drift, or video that stutters from clock correction.
- Subtitles or menus out of place over the picture, or out of time with it.
- A disc that played before failing to play: when the element path can't play a stream, playback falls back to the
  canvas path at the same place.

## 3. Constraints

From CLAUDE.md: LGPL-3.0-or-later headers on new files; the packages don't import React or anything from `src/`;
`protocol.ts` changes first when a feature crosses the worker boundary; no user-agent sniffing (capabilities are asked
of the browser: `MediaSource.isTypeSupported`, `navigator.mediaCapabilities.decodingInfo`); cross-origin isolation
stays (the video element plays from a `blob:` URL of a MediaSource, which `require-corp` allows); browser APIs stay
behind injectable interfaces so unit tests run on fakes; supported browsers are Safari 26, Chrome and Firefox stable
and stable−2, Chrome Android.

## 4. Approaches

Which streams go on the new path (decided): (a) HDR only, (b) everything MSE can play, or (c) HDR by default with a
switch to force everything. The owner wants (b) in the end and starts with (c): the path is built general, on by
default for HDR.

Who keeps time (decided: A, with C if A fails):

- **A. The audio output stays master; the video element follows it** (chosen). The page plays the element muted,
  compares the media time of each presented frame with the engine's clock, nudges `playbackRate` for small offsets and
  re-seeks for large ones; when the element runs out of data the engine holds its clock. Everything that follows the
  clock today keeps doing so, and the existing A/V sync bounds apply. Risk: correction must not be visible.
- **B. The video element becomes master; the audio follows it.** Perfect frame pacing, but it rebuilds the audio path
  (stretching or trimming samples) and costs audio quality. Rejected.
- **C. Audio and video both through MSE; the browser keeps them in sync.** Decoded audio re-encoded losslessly (FLAC
  in MP4) and appended beside the video; the element's clock becomes the master. Smoothest, with the browser's own
  output latency handling, but close to a rewrite of playback. The fallback if A can't meet the sync bounds or plays
  visibly jerky on a supported browser.

What happens if A works on some browsers and not others (that browser keeps the canvas path, through a session that
watches its own sync and falls back, or everything moves to C) is left open on purpose: the owner decides once A's sync
has been seen on real devices. The work is ordered so that happens first (§5.10).

## 5. Design

### 5.1 Which path a playlist takes

The engine decides per playlist when the session starts (and again on a reopen, §5.8), from:

- **The stream:** HDR when the clip's CLPI says so (`dynamic_range_type`: 1 HDR10, 2 Dolby Vision with an HDR10 base,
  read by libbluray's `_parse_stream_attr`, which `@seikou/bdmv` currently skips: keep it, with `color_space`), or,
  for streams without it, when the first SPS's VUI says PQ (transfer 16) or HLG (18).
- **The setting:** `videoPath: 'auto' | 'element' | 'canvas'` in the player settings, sent as a command like the
  memory profile. `auto` takes the element path for HDR streams only; `element` for every stream the element can
  play; `canvas` never. The test flag `?videopath=element|canvas` sets it at load.
- **Shaders:** a playlist with a shader set on takes the canvas path.
- **The page's answer:** only the page can ask MSE. The engine sends the stream's codec string and HDR facts
  (`videoElementQuery`), and the page answers from `isTypeSupported` and `decodingInfo` (with `transferFunction`,
  `colorGamut` and `hdrMetadataType: 'smpteSt2086'`) whether it can play it and whether the display is HDR. A refusal
  takes the canvas path. The answer is cached per codec string for the page's life.
- **The display** doesn't change the path (designer's call): on an SDR display an HDR stream still takes the element
  path in `auto`, because the browser's tone mapping, uneven as it is, beats the canvas path's flat picture. Whether the
  display is HDR (`matchMedia('(dynamic-range: high)')`, re-read when it changes) only decides the HDR badge (§5.7).

The engine's no-picture case (MPEG-2, VC-1) is unchanged.

### 5.2 Remux: fragmented MP4 in the engine worker

A new module (`packages/engine/src/element/`) turns the pipeline's video units into fragmented MP4, in place of the
WebCodecs decoder for an element-path session:

- **Init segment:** `ftyp`, then `moov` with one video track: `hvc1` with `hvcC` (or `avc1` with `avcC`) built from the
  stream's VPS, SPS and PPS, which `@seikou/bdmv/codecs` already finds; `colr` (`nclx`) from the SPS's VUI
  (primaries, transfer, matrix, full range); and for HDR10 `mdcv` and `clli`, filled from the stream's
  mastering-display-colour-volume (SEI payload 137) and content-light-level (144) SEI. `pasp` carries the sample aspect
  ratio, so anamorphic streams show at their display size. A change of parameter sets (a play item with other video, a
  clip change) produces a new init segment (§5.4).
- **Media segments:** `moof` and `mdat` per GOP (each EP-map entry starts one), samples converted from Annex B to
  length-prefixed NAL units, with decode times from the PES DTS (the pipeline passes `dtsUs` for PG and IG units but
  not yet for video: its video sink gains it) and composition
  offsets from the PTS, sync-sample flags on IRAP pictures, and `tfdt` on the playlist timeline: the units' times are
  already playlist times, so no `timestampOffset` is needed.
- **H.264 with MVC** keeps its base view only, as the decoder path does.
- The MP4 boxes are written by original code; nothing here is ported.

### 5.3 Between the worker and the page

New protocol members, transferring segment bytes:

- Events: `videoElementQuery` (codec, HDR facts), `videoInit` (bytes, codec string, display size), `videoSegment`
  (bytes, start and end time), `videoReset` (a seek or a new session: drop what is buffered, the next init and
  segments start at a time), `videoEnded`, `videoElementStop` (back to the canvas path).
- Commands: `videoElementAnswer`, `videoBuffered` (the buffered end, after each append), `videoStalled` and
  `videoResumed` (the element has run dry or recovered), `videoElementFailed` (an append or decode error).
- Backpressure: the pipeline's `isFull` for an element session counts the element's buffered lead from `videoBuffered`
  instead of the decoded-frame queue: at most a lead of about 10 s, less on the constrained memory profile (UHD runs up
  to about 100 Mb/s, and browsers cap a SourceBuffer at 100–300 MB); the page removes what lies more than about 10 s
  behind the playhead.

### 5.4 The page side: `ElementVideoOutput`

In `packages/engine/src/controller/` beside the audio output (page-side, no React), with the `<video>` element handed
to it by the UI as the canvas is (`attachVideoElement`):

- Owns a `MediaSource`, or Safari's `ManagedMediaSource` where only that exists (iPhone), and its one `SourceBuffer`,
  with an append queue. A new init segment with another codec goes through `changeType`.
- Sets the element muted, `playsInline`, no controls, `disableRemotePlayback`, and keeps it hidden while no element
  session plays.
- Reports `videoBuffered`, `waiting` and `playing` (as stalled and resumed), errors and `QuotaExceededError` (after
  removing what is behind and retrying once).

### 5.5 Sync (approach A)

- **A shared clock block:** the engine already derives its clock from the audio ring's played-frame count; it
  publishes, in a small `SharedArrayBuffer` block, its clock time, whether the clock runs, and the `performance.now()`
  of that reading (made comparable across the worker and page through `performance.timeOrigin`). The page reads it
  without messages.
- **Every presented frame** (`requestVideoFrameCallback`, with `mediaTime` and `expectedDisplayTime`), the page
  computes the offset between the frame's media time and the engine clock at that display time:
  - under about 10 ms: `playbackRate` 1;
  - up to about 100 ms: `playbackRate` 1 ± a small correction proportional to the offset, at most 0.5%, so the gap
    closes over a second or two without visible speed change;
  - beyond that, or after a pause, seek or stall: set `currentTime` to the clock time.
  The thresholds are the builder's to tune against the sync tests.
- **Catch-up (added in the end-to-end checks, for the owner to judge at the sync checkpoint):** by the time the page
  sees the clock move it is already one audio step in, and `play()` takes a display frame or more to start the element,
  so a start, resume or seek leaves it 10 to 60 ms behind, which the 0.5% correction would take seconds to close. A
  start begins with a catch-up planned from the lag the page expects (how far the clock is past the element, plus
  15 ms for `play()`); the first frame measured after it re-plans that catch-up from what it shows, or drops it within
  10 ms. For the rest of the second after a start, resume, seek or reset only, two frames' offsets averaging beyond
  10 ms (measured afresh once a catch-up has ended) run another, since an element can keep slipping while it starts
  (Chrome under load presents its first frames late). A catch-up is 8% to 25% faster or slower, set so the offset goes in about 0.12 s of media, for exactly
  the media time that removes it, then the 0.5% correction again. In steady state the correction is the 0.5% one
  alone; only a slip of more than 20 ms (averaged over eight frames, well above the measurement's ±10 ms band at a
  60 Hz refresh) runs a catch-up. Telemetry counts them (`elementCatchUps`), so the checkpoint can tell catch-ups from
  the steady correction.
- **The clock the page reads** is the line through the audio clock's steps (the audio clock moves once per audio
  callback, 21 to 43 ms in Chrome), published as not running until it first moves, and the element starts only then.
- **Display times:** a frame's `expectedDisplayTime` when it is on the page's clock; WebKit's is not, and the
  callback's time plus one display refresh (measured from animation frames) stands in for it.
- **Pause, play, seek** follow the engine's state; the element plays only while the engine's clock runs.
- **Stalls:** when the element runs dry while the engine plays, the engine holds (as it does for a read stall) until
  the element has data again, so audio doesn't run ahead.
- **Telemetry:** the existing `avOffsetMeanUs` and `avOffsetMaxAbsUs` come from these offsets on the element path;
  presented and dropped frames from `getVideoPlaybackQuality()`; a new `videoPath` field (`canvas` or `element`, and
  `hdr`).

### 5.6 Overlays over the element

- The canvas sits over the element, both filling the player area; the element uses `object-fit: contain`. The
  compositor gets a transparent mode: its context is created with alpha, and on the element path it clears to
  transparent instead of black and draws no video. Overlay placement uses the stream's display size (from the SPS and
  `pasp`, sent with `videoInit`) through the same `fitRect`, so PG, text and IG land where the picture is.
- Overlays are drawn by the engine's clock, as now; the element follows that clock, so they stay in time.
- A BD-J background still is drawn under the video on the canvas path; on the element path it would cover the video,
  so it is drawn only while no element frame shows. Discs show such stills in menus without video; the edge case is
  noted in `docs/known-issues.md`.

### 5.7 What the user sees

- A setting, **Video output**, in the player's Settings menu: Auto (HDR through the browser's video player), Always the
  video player, Always the canvas; kept per device with the other player settings.
- An **HDR** badge beside the level badge while an HDR stream plays on the element path on an HDR display (designer's
  call: on an SDR display the picture is tone-mapped, so no badge).
- When an element session fails (an append or decode error, a stall that never recovers), the engine reopens the
  playlist at the same time on the canvas path, shows a notice once per disc ("HDR video couldn't play in this
  browser, so it shows without HDR and its colours may look flat"), and keeps the canvas path for that disc.
- **HDR on the canvas path stays as it is** (designer's call): no tone mapping is added there in this work, so an HDR
  disc in Firefox, or after a fallback, looks flat as today. Proper PQ and HLG to SDR conversion on the canvas would be
  a WebGL step in the canvas path, whose anti-goal is no regression; it is a follow-up, noted in `docs/known-issues.md`.

### 5.8 Interactions

- **Shaders:** turning a set on during an element session reopens the playlist at the same time on the canvas path,
  and turning it off reopens on the element path (as a level switch reopens: §5.9 of the quality levels spec).
- **Quality levels and the NAS pre-flight** (designer's call): a NAS level is a disc like any other, and an HDR level
  (`hevc-1080-hdr`) takes the element path. `src/ui/video-caps.ts` today probes WebCodecs alone; it also asks MSE
  (`isTypeSupported` for HEVC Main and Main10, cached like the WebCodecs answer), and reports a codec playable when
  either path plays it, so the pre-flight enables Original and the HEVC levels for a browser whose MSE plays HEVC
  though its WebCodecs doesn't. The `hevc`, `hevc10` and `hdr` flags the pre-flight sends to `discs/<id>/levels`
  keep their meaning, so the server and its level rules don't change; the auto level choice is unchanged.
- **Seeks:** `videoReset` at the target; the pipeline reads from the EP entry as now; the element shows the first frame
  at or after the target when paused, as the canvas path does.
- **Places** need nothing new: they come from the engine's clock.

### 5.9 Tests

- Unit (Vitest, fakes): the MP4 boxes against hand-checked bytes; SPS VUI and the two HDR SEI parsers; Annex B to
  length-prefixed; the path choice; the sync controller's corrections on a fake clock and fake element; backpressure.
- A fixture: `fixtures/synthetic/disc-hdr`, a short HEVC Main10 PQ disc with mastering metadata (libx265
  `master-display` and `max-cll`), audio and a PG stream, made by a script beside the others; its CLPI says HDR10.
- E2E (Playwright): with `?videopath=element`, `disc1` (H.264) plays on the element path with the A/V sync bounds,
  seeks, PG and IG placement, pause and resume, in Chrome and WebKit where their MSE plays H.264; `disc-hdr` plays on
  the element path where the browser's MSE plays HEVC Main10, and skips with a reason elsewhere (Chromium on Linux CI);
  the fallback to the canvas path when the element fails (a test flag that makes appends fail); the canvas path's
  tests unchanged.
- By eye, by the owner: Safari on a Mac with an HDR display, Safari on an iPhone or iPad, Chrome on a Mac with an HDR
  display, Chrome or Edge on Windows in HDR mode: highlights brighter than the UI's white, subtitles in place, no
  visible stutter. A short checklist goes in the plan.

### 5.10 Order of the work

Sync is the risk that could change the approach, so it is settled before anything that approach C would make wasted
work:

1. **Sync first.** The fragmented MP4 writer for H.264 and HEVC (without the HDR boxes), the protocol members, the
   page's `ElementVideoOutput`, the shared clock block and the sync controller, with the path forced by
   `?videopath=element`: `disc1` and the HDR fixture play on the element path with the A/V sync telemetry. The owner
   watches it on the three setups (Safari on a Mac, on an iPhone or iPad, Chrome on a Mac or Windows) while the sync
   E2E tests measure it, then decides: carry on with A everywhere, A with a per-session fallback for a browser that
   can't hold the bounds, or C.
2. **Then the rest**, on the approach chosen: the HDR boxes and SEI, the path choice and the CLPI fields, the
   transparent compositor and overlay placement, seeks, play items and resets, the fallback and its notice, the setting
   and badge, `video-caps.ts`, the remaining tests and the documentation.

### 5.11 Documentation

`docs/playing-discs.md` (HDR and the Video output setting), `docs/troubleshooting.md` (HDR looks dim: the display or
system HDR setting; Firefox), `docs/known-issues.md` (the background still, Dolby Vision, HDR10+), CLAUDE.md's
architecture section.

## 6. Left to the builder

The exact sync thresholds and correction gain; segment sizes and buffer leads per memory profile; how the shared clock
block is laid out; whether the element's `playbackRate` corrections need smoothing per browser; the fixture's length
and bitrate.
