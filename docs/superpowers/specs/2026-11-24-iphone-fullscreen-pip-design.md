# Picture in Picture and video fullscreen through the element path: design

Status: built on branch `iphone-fullscreen-pip` (2026-11-24, unattended night run), with text subtitles in Picture in
Picture added after the first slice (§4.5) once the iPhone showed it draws a video's WebVTT cues there. Decisions
marked *(My call: …)* are for the owner to review. Roadmap row: "iPhone fullscreen and PiP through a `<video>`".
Device results are in §7.

## 1. What we found first (on the owner's iPhone 17 Pro, iOS 27.2, 2026-11-24)

The roadmap row assumed that an iPhone can only make a `<video>` fullscreen. That is no longer true on this phone:

- `document.fullscreenEnabled` and `webkitFullscreenEnabled` are both true, and the player's own Fullscreen button
  (`toggleFullscreen` on the player root) put the whole player fullscreen: canvas, subtitles, menus and controls. So
  the "Add to Home Screen to watch fullscreen" hint no longer shows on it, and the known issue "iPhone has no element
  fullscreen" is stale for iOS 27.2 (it may still hold on iOS 26, which the supported-browser list includes; not
  checked: no iOS 26 device or Simulator runtime here).
- The element path plays on the phone (`?videopath=element`, disc1: `ManagedMediaSource`, no `MediaSource`).
- `video.webkitEnterFullscreen()` works from a tap and refuses without one (`InvalidStateError`).
- `video.requestPictureInPicture()` works on the element path's muted MSE video from a tap (`enterpictureinpicture`
  fires, `webkitPresentationMode` becomes `picture-in-picture`), and is refused about a second after the tap
  (measured: called 0.9 s after the tap it worked; at 2.5 s and 5 s it failed with `NotAllowedError: The request is
  not triggered by a user activation`).

So what an iPhone lacks is **Picture in Picture**, not fullscreen. Native video fullscreen still matters for a
browser that has a video's fullscreen but no element fullscreen (older iOS), so the slice keeps it as the fallback.

## 2. Goals and non-goals

Goals (this slice):

- A **Picture in Picture** control in the player wherever the browser can put a `<video>` in PiP (Safari on iPhone,
  iPad and Mac; Chrome), working on the element path in one tap.
- On the canvas path, the same control moves the playing playlist to the element path (where the stream can go there:
  H.264 or HEVC, not an encode, the page plays it) and enters PiP; if the switch takes longer than the browser's
  activation window, the button asks for one more tap.
- The system's controls in PiP (and in native video fullscreen) reach the player: play, pause, and a seek, so the
  sound (the AudioWorklet, not the muted video) follows them; the video stays on the audio clock.
- **Native video fullscreen as the fallback** where the document has no fullscreen API but the video has
  `webkitEnterFullscreen` (the Fullscreen button then uses it on the element path, with the same switch on the canvas
  path).
- Leave PiP and native fullscreen when the element path stops (a canvas playlist, a menu loop in MPEG-2, the disc
  closing), so the system never shows a dead picture; leave native fullscreen when a disc menu appears, so it can be
  used.

Non-goals (left for later, in the roadmap row):

- PG subtitles, ASS styling and signs, and menus inside PiP or native fullscreen. PiP and native fullscreen show the
  video's own pixels and its text tracks only: PG, IG and BD-J graphics are not there, and text subtitles come along as
  plain text (§4.5). *(My call: first planned as a non-goal; built once the iPhone showed WebVTT cues in its Picture in
  Picture window, because added ASS files are the owner's main subtitles. Signs are left out rather than shown
  out of place.)*
- PiP for canvas-only video (MPEG-2, VC-1, AV1 encodes, a playlist with a shader set on): no `captureStream()` of the
  transferred canvas. The control is disabled there with the reason. *(My call: the roadmap says start from the
  element path; a canvas capture is a second experiment.)*
- Automatic PiP when Safari goes to the background, and background audio (iOS suspends the AudioContext; the known
  issue "No background audio on iOS" stands, and PiP while the page is hidden is exactly that case, so it needs the
  owner's check).
- Changing what `auto` picks on an iPhone (every SDR H.264 stays on the canvas). *(My call: a one-tap PiP on every
  stream would need the element path by default on phones; its sync on a phone is measured in this run but deciding
  the default is the owner's, as for the HDR element path.)*

## 3. Approaches considered

1. **Element path only, switch on demand** (chosen). PiP and native fullscreen use the page's existing `<video>`. A
   canvas playlist moves to the element path when asked, the way a shader set moves it back and forth (a reopen at
   the same time, no notice). Cheap, uses tested machinery, and keeps the default paths as they are.
2. **Element path by default on PiP-capable phones.** One tap always, but changes playback for every iPhone user on
   the strength of one night's measurements. Rejected for now (see My call above).
3. **Canvas `captureStream()` into a second `<video>`.** Works for every codec, but the canvas is transferred to the
   worker (`transferControlToOffscreen`), WebKit's capture of such a canvas is unproven, and it would carry the
   overlays only as burnt-in pixels. Left as a later experiment.

## 4. Design

### 4.1 Engine: `preferElement`

New command `{ type: 'preferElement' }`: the page wants the playing playlist on the element path. The engine answers
with `elementPreference { outcome }`:

- `element`: the playlist already plays on the element path.
- `reopening`: it plays on the canvas, the stream may take the element path (H.264 or HEVC, not an encode, the element
  has not failed on this disc, the page has not refused this stream, no shader set holds the canvas), so the disc's
  sessions take the element path from now until the disc closes (`elementPreferred`, as if the video path were
  `element` for this disc) and the playlist reopens at the same time (`restart` with `restartPoint`, as a shader set
  does), with no notice.
- `unavailable` with `reason`: `no-playlist`, `codec` (MPEG-1/2, VC-1, AV1), `encode`, `shaders`, `element-failed`,
  `refused` (the page said it can't play this stream), `canvas` (the device setting is Canvas).

*(My call, revised after review: the preference outlasts a playlist — a feature with several playlists, or a chapter
jump, should not drop back to the canvas while the user is in PiP — but ends with the presentation: the page sends
`preferElement { on: false }`, and a playlist on the element only for the preference (`Session.byPreference`) reopens
at the same time on the canvas, so an interlaced stream is deinterlaced again. Another disc opening ends it too.)*

### 4.2 Page: transport from the system's controls (`ElementVideoOutput`)

The output already plays, pauses and seeks the element itself. It now counts its own `play()`, `pause()` and
`currentTime` writes, and an event it did not cause while the element is **presented** (PiP or native fullscreen,
from a `presented()` dep) is the user's:

- a `pause` it didn't cause while the engine plays → `onTransport('pause')`;
- a `play` it didn't cause while the engine is paused → the element is paused again at once (the engine starts it on
  its clock) and `onTransport('play')`;
- a `seeking` to a time it didn't set → `onTransport({ seekUs })` in playlist time (media time minus the 10 s offset).

`PlayerController` maps them to `togglePlay()` (only when the state differs) and `seek()`. A `pause` the output didn't
cause while the element is not presented (WebKit pausing it, say on leaving native fullscreen) is answered by starting
it again on the clock, since the engine still plays. *(My call: outside a presentation the engine is the only
authority; inside one the user is.)*

The 10 s media offset (`ELEMENT_TIME_OFFSET_US`) shows in the PiP and native player's clock (a playlist's start reads
0:10). *(My call: left as it is in this slice — removing the offset touches the remuxer's edit lists and every
element test; noted in known issues.)*

### 4.3 Page: the presentation model (`src/ui/video-presentation.ts`)

Pure functions and a small class over an injected video and document:

- `pipSupport(doc, video)`: `standard` (`document.pictureInPictureEnabled` and `requestPictureInPicture`), `webkit`
  (`webkitSupportsPresentationMode('picture-in-picture')`), or null.
- `videoFullscreenSupport(video)`: whether `webkitEnterFullscreen` exists (the fallback).
- `presented(doc, video)`: PiP or native fullscreen now.
- `enterPip`, `exitPip`, `enterVideoFullscreen`, `exitVideoFullscreen`.
- `PresentationRequest`: the canvas-path flow. On a tap it sends `preferElement`; on `reopening` it waits for the
  element's metadata (`loadedmetadata`) and enters at once if still within `ACTIVATION_MS` (900 ms, inside the
  measured window); after that it shows "Tap Picture in Picture again" (`pip-again` notice), and the next tap enters at
  once since the element now plays.

`capabilities.ts` gains `pip` (`standard` | `webkit` | null). The fullscreen adapter gains kind `video`: chosen when
the document has no fullscreen API and the video has `webkitEnterFullscreen`; the hint ("Add to Home Screen") then no
longer shows, since the Fullscreen button works. `?fullscreen=video` is test-only and forces that kind on a browser
that has element fullscreen, so the fallback can be tried on this iPhone and in WebKit.

### 4.4 UI

- Control bar: a **Picture in Picture** button (`data-testid="pip-button"`, `aria-label="Picture in Picture"`) beside
  Fullscreen where `pip` is supported. Disabled, with the reason as its title, while the playlist can't go to the
  element (the last `elementPreference` said `unavailable`, or the snapshot says the playlist's video is canvas-only).
- Leaving: when the snapshot's `videoElement` turns false, or the disc closes, while presented → `exitPip` /
  `exitVideoFullscreen` (no gesture needed). When the snapshot shows an active disc menu (IG `menuActive` or a BD-J
  plane with pixels) in native video fullscreen → `exitVideoFullscreen`. PiP stays when a menu appears: the user is
  away from the page; the menu waits for them.
- A notice the first time PiP is entered while subtitles are on: "Subtitles and menus don't show in Picture in
  Picture." (once per disc open).

### 4.5 Text subtitles on the video's text track

While the element is presented, `ElementVideoOutput` posts `setTextCues { on: true }` (and `false` when it ends); the
engine then sends `textCue { text }` whenever the plain text of what shows changes. `TextRendererLike.plainText` gives
it: SRT cues' text with styles dropped, and `AssRenderer.plainText` (`@seikou/ass`'s `plain-text.ts`): override blocks
dropped, `\N` as a line break, `\h` as a space, events with `\pos`, `\move`, `\org`, `\clip` or a drawing left out,
one entry per distinct text in file order. The page keeps one `VTTCue` spanning all media time on the element's own
text track (`showing` only while presented, so the page's inline video never shows it under the canvas), replaced on
every change. *(My call: one "what shows now" cue rather than the file's cue list — it follows offsets, episode
placement and file changes the engine already handles, and costs one event per change.)*

### 4.6 Media Session

`PlatformSession` also handles `seekto` (a system scrubber's seek to a time) and tells the Media Session the
playlist's length and position (`setPositionState`, with `playbackState`) when they change beyond what it reckons
itself, so the lock screen and the PiP window's ±10 s buttons (which iOS draws from the Media Session's
`seekbackward` and `seekforward` handlers) stay right.

## 5. Constraints

- No user-agent sniffing: everything is feature-detected.
- Browser APIs stay behind injectable interfaces (the video and document likes), as the project's testability pattern
  asks.
- The engine still never imports BD-J; the protocol changes first (`preferElement`, `elementPreference`).

## 6. Testing

- Unit: the engine's `preferElement` outcomes and reopen (`player-element.test.ts` harness, fake page); the output's
  transport detection with a fake video (own vs. foreign play/pause/seek, presented or not); the presentation model
  with fake video and document (support detection, the activation window, the again notice); the fullscreen kind
  choice and the hint.
- E2E (`tests/e2e/pip.spec.ts`, every project): the button shows where the browser has PiP; on the canvas path a tap
  moves disc1 to the element path (telemetry `videoPath`), and where `requestPictureInPicture` resolves (headed Chrome,
  WebKit) PiP is entered and pause/play from the element reaches the engine. Feature-detected; skips with a reason.
- Device (the owner's iPhone, through `tools/devices`-style safaridriver taps, which deliver a real activation when
  the pointer action has no pause): PiP from the element path and from the canvas path, `?fullscreen=video`, sync on
  the element path with audio, screenshots. What a script can't reach (the PiP window's own buttons, the system
  player's scrubber, backgrounding Safari) is on the owner's morning list.

## 7. Results on the owner's iPhone 17 Pro (iOS 27.2, 2026-11-24, safaridriver over the disc server)

- Element fullscreen of the player root works (the old known issue is stale for this iOS).
- Picture in Picture from the element path opens on one tap; from the canvas path it opened on one tap for disc3 and
  needed the second tap for disc-speech (the reopen took longer than Safari's activation window, about a second).
- In Picture in Picture the video stayed on the audio clock: A/V offset mean within 5 ms, largest under 11 ms
  (disc3 640×360 and disc-speech).
- `pause()`, `play()` and a `currentTime` seek on the presented element (what the system controls call) paused,
  played and sought the player; a seek reached 100 s of a 150 s playlist once the media source's duration spanned it
  (before that fix the scrubber stopped at what had been appended).
- `?fullscreen=video`: the video's own fullscreen opened from a tap, the player paused and played through the element,
  and a Top Menu call in fullscreen closed it with the menu playing on the page.
- An added SRT file's cue showed in the Picture in Picture window in some screenshots (all with the window's controls up) and not in others, while the track always held the right cue (re-check, below).
- Not checked (a script can't reach them): the Picture in Picture window's own buttons, the system fullscreen
  player's controls, leaving Safari with Picture in Picture open (audio may be suspended), and rotation.

### Device re-check after the review fixes (2026-11-24, 02:15–03:00)

- A playlist change while in Picture in Picture used to close it: the element's source was emptied at the session's
  stop. The element now keeps its media source while presented and the next session refills it, with a new source
  buffer (Safari on iPhone stretched a shorter playlist's duration back to the last one's on every append). Seen on
  the phone: menu to feature and back, and an 8 s playlist then a 4 s one, stayed in Picture in Picture with the new
  length (14 s media, 4 s playlist).
- An episode played to its end in Picture in Picture: the element paused at its end by itself, the player went to
  `ended` (this disc's program stops there), and nothing sought or restarted.
- Closing Picture in Picture on disc-interlaced: one reopen at the same place onto the canvas, deinterlaced (`video`).
- Backgrounding Safari could not be scripted: the phone is in Guided Access, which refused another app's launch.
- Captions in Picture in Picture are intermittent (known issues).
