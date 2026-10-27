# Cross-Browser, Mobile, Offline App and Remote Watching from a NAS — Design Spec

Date: 2026-10-16
Status: Step 1 implemented and deployed (2026-10-17). Device gate, iPad (iPad Pro 12.9" 5th gen, iPadOS 27.0.1 Safari, driven remotely with safaridriver; fixture discs handed to the page in place of the Files picker, which can't be automated): all checks pass. disc1 across the play-item boundary at 7.4 ms mean / 9.9 ms worst A/V offset with no drops or underruns; disc2 (B-frames, open GOP) seek; disc3 audio switch LPCM to AC-3; HDMV menu by tap and by the on-screen remote; PGS and forced captions; an ASS file; BD-J (first frame 514 ms); tap to show controls and double tap to seek both ways; phone layout with 44 px targets; the service worker controlling the page while cross-origin isolated. The run found one bug, fixed: touch pointerup reported at (0, 0). Then (same day): iPhone 17 Pro (iOS 27.2 Safari), Safari 26.6.2 and Firefox 158 on the Mac all pass the same checks (desktop: keyboard seeks for double taps, mouse for taps); Mac Safari needed its automation window kept in front, since safaridriver stops delivering input to a hidden window after a navigation. Offline without Airplane Mode: the app was served to the tailnet from the Mac with `tailscale serve`, installed by each browser, then the origin was taken away (serving switched off; Firefox's own offline mode): iPad, iPhone, Firefox and Safari reloaded from the service worker, stayed cross-origin isolated and played disc1. That run found a second bug, fixed: an error-page answer (404) to a navigation was passed through instead of the cached app. Step 2 (§4) is done and deployed 2026-10-17 (`2026-10-17-nas-server-design.md`), with the title library on top (`2026-10-17-nas-library-titles-design.md`); the iPhone has played a disc with menus over the NAS, and Mac Safari played an episode of a full disc over the NAS's HTTPS route on 2026-10-21 (first frame 5.1 s, no dropped frames, seeks landing in 0.2–0.4 s). The iPad run through the NAS is still not done. Step 3 (`2026-10-18-webrtc-people-design.md`) is deployed (2026-10-19), and step 4 (`2026-10-19-lower-quality-design.md`) too (phase 2, 2026-10-22).
Base: step 1 is built on `main` before milestone 5 (BD-J) lands, and runs in parallel with it. BD-J on phones is handed to milestone 5 (§3.9).
Parent spec: `2026-10-12-bluray-web-player-design.md`. Touches every milestone's UI, and the engine's disc source (§2 of the parent spec).

This spec covers four steps that build on each other. Step 1 is specified in full and gets the first implementation plan. Steps 2–4 are specified far enough that step 1 doesn't paint them into a corner; each gets its own detailed design pass and plan when it starts.

1. **Cross-browser and mobile player, installable offline app** (§3).
2. **NAS server with an HTTPS route**: library, disc manifests, byte-range serving, "Open from NAS" (§4).
3. **WebRTC route, invites and pairing**: browser-only peer-to-peer access for the user abroad and for family and friends (§5).
4. **Lower-quality tier**: the NAS re-encodes only the video stream with Quick Sync, so menus, subtitles and audio stay intact (§6).

## 1. Intent

The player works today only in desktop Chromium, on discs stored on the same machine. The user wants to watch their discs on whatever they're holding (phone, tablet or laptop), with whatever browser it has, and from anywhere, including abroad.

- **Where the discs are.** The user's Blu-ray rips live on a NAS at home: Ubuntu, x86_64, Intel N150 (Alder Lake-N iGPU, Quick Sync), ext4 on HDD, gigabit internet. Most rips are folders (`BDMV/` inside); some are `.iso` images. Sometimes discs are also on the device itself, for example a USB drive plugged into a phone or tablet.
- **The connection abroad.** It varies (hotel Wi-Fi, mobile data). The user wants streaming to be "almost seamless": quick start, quick seeks, no stalls.
- **Who watches.** Mostly the user. Family and friends may watch from the NAS too.
- **What "peer-to-peer" means here.** The device talks to the NAS directly. Disc bytes never pass through or rest on a cloud service the user doesn't control, except an optional TURN relay that only forwards encrypted packets (§5).

Success looks like this: the user, abroad, opens the app on an iPhone, picks a disc from their NAS, and gets the disc's menus, chapters, audio and subtitle switching exactly as at home, at original quality when the connection allows and at a clearly labelled lower quality when it doesn't.

## 2. Goals, non-goals, anti-goals

Goals:

- Supported browsers (step 1): Chrome/Edge desktop (as today), Chrome Android, Safari macOS, Safari iOS/iPadOS (and so every iOS browser, all WebKit), Firefox desktop. Minimum versions: Safari 26 (macOS and iOS); Chrome and Firefox current stable minus two.
- Local discs open in all of them. On iOS/iPadOS this works but is impractical for full discs: Safari copies every picked file before the page can read it (§3.2), so iPhone and iPad watch discs through the NAS (steps 2–3). Android picks through the Storage Access Framework.
- Touch works everywhere a mouse or keyboard is needed today: playback controls, seeking, HDMV menu buttons, the on-screen remote.
- The site installs as an app (home screen, dock) and opens and plays local discs with no network.
- Discs on the NAS play on any supported device, at home and abroad, with menus and everything else intact.
- Family and friends can be invited, per person, and revoked.

Non-goals:

- **Downloading discs** to the device for offline viewing (the user ruled this out), and any persistent on-device cache of disc data beyond the playback buffers.
- **Firefox Android.** It has no WebCodecs. It gets a clear "not supported, use Chrome" message.
- **Background audio on iOS** with the screen locked or the app hidden. WebKit suspends Web Audio there; we document it and don't fight it.
- **Element fullscreen on iPhone**, which WebKit doesn't offer. The installed app (standalone display) is the fullscreen experience on iPhone. Piping the canvas into a `<video>` for native fullscreen/PiP is a later experiment, recorded in `docs/known-issues.md`.
- A public or multi-tenant service. One NAS serves its owner's invited people.
- Transcoding audio, subtitles or menus. Ever. Step 4 touches the video stream only.
- Native apps (iOS/Android/desktop). Everything client-side stays a web app. The NAS server is the one native-ish process.
- An NAS admin web UI beyond what invites, devices and library roots need.

Anti-goals (failure even if it works):

- **Regressing desktop Chromium**: A/V sync bounds, vm-trace and ass-trace parity, shader performance. Every existing test keeps passing unchanged.
- **Silent failure** on a browser or device that can't do something (a codec, shaders, a USB folder). Every missing capability is detected and named in the UI.
- **The NAS reachable without pairing.** No endpoint other than "redeem an invite" answers an unpaired device, on any route, including on the home LAN.
- **Disc content or titles visible to third parties** (the signaling service, the TURN relay, Cloudflare). They see connection metadata only.
- Picture quality silently dropped. The lower-quality tier is always labelled, and the user can always choose original quality and accept buffering.

## 3. Step 1: cross-browser, mobile and offline

### 3.1 Capability detection replaces the Chromium gate

Today `src/ui/capabilities.ts` checks four features and the landing screen disables "Open disc folder" if any is missing (`LandingScreen.tsx:103-118`), with the text "Use a recent desktop Chrome or Edge".

Replace it with a per-feature capability report, computed once at start (and partly in the worker, where WebCodecs and OffscreenCanvas actually run):

| Capability | How it's detected | If missing |
|---|---|---|
| Core playback | `VideoDecoder`, `AudioWorkletNode`, `OffscreenCanvas` with 2D in a worker, `crossOriginIsolated` | Landing screen explains which one is missing and names a supported browser. This is the Firefox Android case. |
| H.264 | `VideoDecoder.isConfigSupported` with the stream's codec string | Today's `UnsupportedCodecError`, unchanged. |
| HEVC (Main, Main10) | `isConfigSupported` per stream, trying `hvc1.` then `hev1.` forms of the codec string (Safari may accept only one) | Per-disc message: "This device can't decode HEVC (4K) video". |
| Folder picking | `showDirectoryPicker`, `webkitdirectory`, drag-and-drop with `getAsFileSystemHandle` or `webkitGetAsEntry` | Use what's there (§3.2). |
| Shaders | WebGL2 in a worker plus a renderable float format (RGBA16F is enough; iOS has no RGBA32F) | Shaders menu shows "Not available on this device", as `webgl-backend.ts:65` does today. |
| Element fullscreen | `document.fullscreenEnabled` (or the `webkit`-prefixed form) | Fullscreen button hidden; on iPhone the UI suggests installing the app. |
| Wake Lock, Media Session, `navigator.audioSession` | Feature presence | Silently skipped. They are conveniences. |

No user-agent sniffing, except one documented exception if a platform lies (for example a codec reported supported that fails to decode, WebKit bug 262950). Any such exception goes in `docs/known-issues.md` with the bug link.

### 3.2 Opening local discs

- **Pick.** `showDirectoryPicker` where it exists (Chromium desktop, and possibly Chrome Android). Otherwise `<input type=file webkitdirectory>`, which every target supports (iOS from 18.4). On iOS this opens the Files app, where USB drives appear.
- **Drop.** The landing-screen drop handler gains the `webkitGetAsEntry` + `readEntries` fallback that `src/player/drop-files.ts:30-50` already uses for subtitles. Factor the directory walk out and share it.
- **Recent discs.** These store `FileSystemDirectoryHandle`s and only work in Chromium. Keep them there, hide the section elsewhere, and show NAS discs (step 2) in the recents list on every browser.
- **iOS copies picked files (measured 2026-10-17).** On iPadOS 27 a folder pick hands its files to the page only after Safari has copied them out of the Files provider: a 2-file folder took 3 s, a 0.40 GiB clip from a USB drive 61 s (about 7 MB/s), and a full disc folder did not finish in the time the user waited. A full disc (25–40 GB) would take an hour or more on every open. No web API avoids this on iOS. So: the landing screen says so when a pick takes longer than 1.5 s, local folders stay allowed (subtitles, fonts, small discs, the patient), and iOS watching goes through the NAS, whose range reads copy nothing. A one-time import into OPFS was considered and rejected: the same copy time once, plus double storage on the device.
- **Large files.** Clips above 4 GiB are common. `Blob.slice` beyond 4 GiB on iOS Safari and Android Chrome (through SAF) is unverified; the plan must include an early device test, and if it fails, a documented limitation per platform.
- **Lazy `getFile()`.** `collectFromDirectoryHandle` (`disc-input.ts:9-18`) calls `getFile()` on every file up front. Fine for local folders; keep as is unless the device test shows it is slow on USB.

### 3.3 Touch and small screens

- **Controls.** Tap the video to show or hide the controls (today a click toggles play; on touch, the first tap only reveals the controls, a tap on the play button plays). Double-tap the left or right third to seek −10/+10 s. Controls stay visible while paused. Hit targets at least 44 px. The control bar and the Audio, Subtitles and Shaders menus reflow for narrow and portrait screens.
- **HDMV menus.** A tap on a menu button selects and activates it, like a mouse click today (`pointer.ts` already maps to 1920×1080 menu space). With no hover on touch, the selected button stays highlighted as the disc draws it. The on-screen remote (`RemotePad.tsx`) is reachable from the control bar on touch devices, for discs that need arrow-key navigation.
- **Layout.** `viewport-fit=cover`, safe-area insets, no `cursor:none` dependence, landscape lock not forced (the user rotates).
- **Pointer type.** Use `PointerEvent.pointerType` to tell touch from mouse; don't use hover media queries alone (iPad with a trackpad has both).

### 3.4 Platform behaviour

- **iOS audio.** Set `navigator.audioSession.type = 'playback'` before starting the `AudioContext`, so the silent switch doesn't mute the movie. `AudioContext.resume()` stays inside the user gesture that opens a disc, as today.
- **Sample rate.** `audio-output.ts:20` requests 48 kHz. If a platform refuses or gives another rate, the engine must not break. The plan verifies this on iOS and Android; if the context runs at another rate, resample in the worklet path. `ring.ts` treats 48 kHz as fixed today, so this may need a change.
- **Visibility.** Desktop behaviour is unchanged (a background tab keeps playing). When the platform suspends audio while the page is hidden, which the `AudioContext` reports through its `statechange` (`suspended` or `interrupted`) after `visibilitychange`, the player pauses and says so on return, instead of drifting onto the wall clock. No platform detection is needed: the trigger is the suspension itself. (My call.)
- **Wake Lock** while playing; **Media Session** metadata (disc title, chapter) and play/pause/seek handlers, so lock-screen and headset controls work while the page is visible.
- **Worker `requestAnimationFrame`.** Missing in some workers; `worker.ts:28-31` already falls back to `setTimeout(16)`. Verify presentation smoothness with the fallback on Safari and Firefox; if it is poor, drive frames from the main thread's rAF via a message tick.
- **Canvas features.** `ctx.letterSpacing` and `fontKerning` may be missing or behave differently in Safari and Firefox; detect them. The ASS mask path already blurs in JS (`gaussianBlur`, `raster.ts:399`), but the direct path for reshaped runs blurs with `ctx.filter` (`raster.ts:572-588`). Where `ctx.filter` is unsupported, send blurred runs through the mask path instead. ASS goldens stay Chromium-only; other browsers get a visual-similarity check, not pixel parity.
- **Shaders on iOS.** Use RGBA16F/RG16F/R16F targets only (already the case per the shaders spec); check `webgl-backend.ts` asks for nothing 32-bit-float-renderable.

### 3.5 Memory profile

iPhones kill pages that use too much memory, with no exception to catch. Add a "constrained" memory profile, chosen at start by a heuristic (no `navigator.deviceMemory` on Safari; for example coarse pointer plus small screen, or any iOS/iPadOS WebKit) and overridable with a URL parameter for testing. Under it:

| Item (today) | Constrained |
|---|---|
| IG sub-path preload, up to 512 MB (`player.ts:114`) | 64 MB; above that, the disc fails to open its menus with a named message ("This disc's menus need more memory than this device allows"), recorded in `docs/known-issues.md`. Streaming the IG sub-path waits until a real disc needs it. (My call.) |
| ASS event cache 128 MB, layer LRU 128 MB, mask LRU 64 MB (`ass/renderer.ts:34-40`) | 32 / 32 / 16 MB |
| ASS supersampling up to 8× per side (`raster.ts:340`) | Up to 4× |
| Compressed read-ahead 2 s / 64 MB (`player.ts:99-100`) | Unchanged for local discs (the remote source has its own buffer, §4.4) |
| Decoded frame queue 8 (`player.ts:92`) | 4 for 4K streams |

BD-J is not part of step 1 (§3.9); until milestone 5 lands, BD-J discs fall back to the playlist picker on every browser, as on desktop today.

### 3.6 Installable offline app

- **Manifest**: name, icons, `display: standalone`, `orientation: any`, theme colour.
- **Service worker**: precaches the built app (HTML, JS, CSS, `audio.wasm`, the worklet module, `default-font.ttf`, the vendored test shaders are not shipped). Cache-first for versioned assets, network-first for `index.html` with cache fallback. Every response it serves carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, so the app stays cross-origin isolated offline (`SharedArrayBuffer` depends on it). The real headers in `public/_headers` stay; the worker repeats them, it doesn't replace them.
- **Updates**: a new version installs in the background; the UI offers "Reload to update" and never reloads during playback.
- **Storage**: call `navigator.storage.persist()` once the app is installed, so the shader library and NAS pairings (step 2+) survive. Note in the UI help that Safari deletes data for sites not opened in 7 days unless installed to the home screen.
- Building it: a hand-written service worker or `vite-plugin-pwa` is the builder's choice; it must work with module workers (`vite.config.ts:14`) and `?url` assets.

### 3.7 Testing

- **Playwright projects** for `chromium` (as today, `channel: 'chrome'`), `webkit` and `firefox`, on the existing Linux runners. Playwright's WebKit on Linux is not Safari and generally lacks H.264 in WebCodecs, so in that project the playback tests skip with a stated reason; what it must run is the landing screen, capability messages, folder picking, touch layout and the service worker. Firefox desktop runs the playback tests. The A/V sync tests stay Chrome-only in CI. Real Safari is covered by the real-device gate, not CI; no macOS runner. (My call.)
- **Mobile emulation** projects (Chromium with a phone viewport and touch) cover layout, touch controls and menu taps.
- **Real-device gate**, run by hand at the end of step 1 and recorded in this spec's status line, as earlier milestones did: iPhone (iOS 26), iPad (iPadOS 26), Safari macOS, Firefox desktop. On iPhone and iPad, local discs are the small synthetic fixture discs (`fixtures/synthetic/`, copied to the device), since full discs can't be picked in practice (§3.2); full discs on iOS are gated with step 2's NAS streaming. Per device: open a 1080p H.264 disc, a 1080i disc, an HEVC disc where available, navigate an HDMV menu by touch, PGS and ASS subtitles, audio switching, seek, ten minutes of playback with no drift visible (telemetry from `?telemetry=1`), install and open offline.
- **Android**: the user has no Android device. Chrome Android stays a supported target, verified on the Android emulator (Android Studio, Chrome) for layout, touch, folder picking from emulated storage, H.264 playback and offline install. Hardware HEVC and USB OTG can't be verified there; they are listed as unverified in `docs/known-issues.md` until someone tests on a device. No paid device farm. (My call.)
- **Early device checks**, as the first tasks of the plan, because they decide go/no-go for pieces of the design: `Blob.slice` beyond 4 GiB from a USB drive on iPad and iPhone, the `AudioContext` sample rate on iOS, worker rAF smoothness on Safari, HEVC decode on iPhone and iPad.
- `capabilities` and the memory profile get unit tests; touch handling gets component tests.

### 3.8 Done when

All goals in §2 for step 1 pass the real-device gate (Android on the emulator, §3.7); every existing test passes unchanged in Chromium; CI runs the new WebKit and Firefox projects.

### 3.9 BD-J on phones (handed to milestone 5)

**Covered by milestone 5d's device gate (2026-10-18; `2026-10-17-m5d-bdj-menus-design.md`, status line and §9).** Both local BD-J discs open, reach their menus and play the feature by touch on iPhone 17 Pro (iOS 27.2) and iPad Pro 12.9" 5th gen (iPadOS 27.0.1), and by keys in Safari macOS and Firefox (Firefox on the H.264 disc only, no HEVC). The BD-J worker runs in Safari and Firefox (nested workers work; a browser without them gets a named message and the picker). The constrained profile has BD-J budgets, measured on the devices well within them, with no memory kill in ten minutes of menu use. iPhone time to first frame for the slower disc: 8.3–9.0 s warm, 10.8 s cold, against 5d's 10 s target and 15 s blocker; not a blocker, open items in `docs/known-issues.md`.

The user wants BD-J discs to work on iPhone and iPad like HDMV discs. Step 1 is built before milestone 5 finishes, so these requirements belong to milestone 5's remaining work and its device gate, and are recorded in `docs/known-issues.md` until then:

- BD-J discs open and reach their menus on iPhone and iPad (iOS/iPadOS 26) and Safari macOS, within milestone 5's own time-to-first-frame target, navigated by touch (taps map to the same pointer and key events as HDMV menus, §3.3).
- The BD-J worker (added in M5c) and everything it uses run in Safari and Firefox: check its use of `SharedArrayBuffer`, `Atomics.wait`, OffscreenCanvas and fonts against §3.1's capability report.
- The JVM's heap, class data and interpreter caches get limits in the constrained memory profile (§3.5), measured on an iPhone.
- If an iPhone misses milestone 5's targets, that is a milestone-5 blocker to fix in the JVM, not a known issue to accept.

## 4. Step 2: NAS server and the HTTPS route

### 4.1 The NAS server

- **Language and shape (my call):** Node 24 and TypeScript in this repo (a new top-level `server/`), so it shares the BDMV parsers in `src/engine/bdmv/` and, in step 4, the CLPI and EP-map code. LGPL applies to what it imports from `src/engine/`; the server's own code can take the same licence. Ships as a Docker image (with `/dev/dri` passed through for step 4) and as a plain systemd unit for people who prefer it.
- **Library**: configured root folders; every folder that contains `BDMV/index.bdmv` is a disc, and so is every `.iso` file whose UDF file system contains one (§4.7). Title from `BDMV/META/DL/bdmt_*.xml` where present, else the folder name; thumbnail from the disc's meta images where present. Rescans on a timer and on demand. Read-only access to the files, always.
- **Disc ID**: stable across rescans (for example a hash of the root-relative path plus `index.bdmv` contents), used in URLs and recents.

### 4.2 Protocol

One request/response protocol, carried over HTTPS (step 2) or a WebRTC data channel (step 3):

- `library` → list of discs: id, title, thumbnail, total size, video codec and resolution of the main title (so the client can warn about HEVC before opening).
- `manifest(discId)` → every file's root-relative path, size and modification time, plus the **contents** of the small metadata files the engine reads at open (`index.bdmv`, `MovieObject.bdmv`, every `.mpls`, every `.clpi`, `sound.bdmv`, `bdmt` XML). `open-disc.ts` reads these one at a time today; over a 250 ms round trip that would take many seconds. The manifest makes opening one round trip.
- `range(discId, path, offset, length)` → bytes. Over HTTPS this is a plain `GET` with a `Range` header.
- `probe(discId)` → a short download used to measure throughput before playback (§4.4).
- Auth on every request: a device token (§5.3). Step 2 ships with pairing already in place for HTTPS; it is not deferred to step 3 (anti-goal: nothing answers an unpaired device).

### 4.3 In the engine: a remote `ByteSource`

- `ByteSource` (`src/engine/disc/byte-source.ts`) has synchronous `exists`, `size` and `list`; the manifest supplies all three, so the interface doesn't change.
- New `RemoteSource implements ByteSource`: serves manifest-inlined files from memory, and other reads through a `RangeTransport` interface (`read(path, offset, length, signal) → Promise<Uint8Array>`). The HTTPS transport is `fetch` in the worker; the WebRTC transport (step 3) lives on the main thread, because `RTCPeerConnection` isn't available in workers, and is reached over a `MessagePort` with transferred buffers.
- `protocol.ts`: the `open` command becomes a union, `{ kind: 'files', entries }` or `{ kind: 'remote', manifest, transport }` (the transport described by an HTTPS base URL plus token, or a `MessagePort`). `player.ts:427-431` builds the matching source. This is the one seam step 1 should already prepare.
- Abort on seek works as today (`m2ts-reader.ts:51-55` passes the signal; `fetch` honours it).
- Errors: network loss maps to `read-failed` with a retry policy (a few retries with backoff, then a visible "Connection to NAS lost" with a retry button that resumes at the current time).

### 4.4 Buffering for "almost seamless"

- **Remote read-ahead** is time-based and larger than local: target about 30 s of stream ahead (bounded by the memory profile, e.g. 128 MB desktop, 48 MB constrained), using several range requests in flight (e.g. 4 × 2 MB) to fill a long-RTT link. The demuxer's existing 2 MB chunk and one-chunk prefetch stay for local files.
- **Start**: begin playing once about 3 s are buffered and the measured rate exceeds the stream rate; otherwise buffer more first.
- **Pre-flight**: before playing, the client measures throughput with `probe` and shows it against the title's bitrate (from the clip's `TS_recording_rate` in CLPI): "This connection: 18 Mbps. This disc needs about 32 Mbps." with choices: original quality (expect pauses), or lower quality (step 4, once it exists).
- **During play**: telemetry gains buffer level, measured throughput and stall count. A stall shows "Buffering…", never a frozen frame without explanation.
- **Seek**: one range request at the EP-map offset; expect RTT plus a few hundred ms abroad. Chapter skips can prefetch the first second of the next and previous chapter.

### 4.5 Reaching the NAS over HTTPS

- **At home** on the LAN, and **abroad over Tailscale** (the user installs Tailscale on their own devices). `tailscale serve` gives the NAS an HTTPS name with a valid certificate (`*.ts.net`); on the LAN the same name works if the device runs Tailscale, otherwise the LAN uses the WebRTC route too (step 3).
- **Origin**: the app stays at `bluray-web.pages.dev`. The NAS answers cross-origin with CORS (allowing the app origin) and `Cross-Origin-Resource-Policy: cross-origin`, as COEP `require-corp` demands. Chrome's Local Network Access permission prompt (Chrome 142+) may appear for private addresses; whether it applies to Tailscale's 100.64.0.0/10 addresses is unverified. If it blocks, the fallback is for the NAS server to also serve the app build at its own origin (same build, same-origin requests); that fallback is a step-2 plan task to verify, not a default.
- Tailscale Funnel and Cloudflare Tunnel are not used: Funnel caps bandwidth and Cloudflare's terms restrict video through its proxy.

### 4.6 Client UI

"Open from NAS" next to "Open disc folder". First use: pair (§5.3). Then a library grid (title, thumbnail, 4K/HDR badge), the pre-flight screen, and playback as for a local disc. The NAS and its library show in recents on every browser.

### 4.7 ISO images

Some of the user's rips are `.iso` files. Step 2 adds a UDF reader to the engine, `src/engine/disc/udf.ts`, ported from libudfread (the library libbluray uses; LGPL, recorded in `src/engine/NOTICE`), so the same code serves two uses:

- **Locally**: the landing screen also accepts a single `.iso` file (picked or dropped). An `IsoSource implements ByteSource` reads the UDF directory at open, then maps each disc path to extents in the image.
- **On the NAS**: the server runs the same reader to build the manifest. Manifest entries for an ISO disc carry the path's extents within the image, and `range` requests address the image. `RemoteSource` maps reads through the extents the same way.

Only the UDF versions found on Blu-ray (2.50/2.60, metadata partition) are needed. (My call: ISO lands in step 2 with the NAS, not step 1.)

## 5. Step 3: WebRTC route, invites and pairing

> Revised 2026-10-17: pairing is by QR or short code (`2026-10-17-nas-server-design.md` §7), built in step 2 together with the rendezvous service; step 3 adds WebRTC signalling to that service and starts with a throughput spike.

### 5.1 Why

Browser-only access: no Tailscale needed for family and friends, or for the user on a device without it. The device and the NAS connect directly (DTLS-encrypted data channel); the NAS only makes outbound connections, so no port forwarding.

### 5.2 Pieces

- **Signaling service**: a Cloudflare Worker with a Durable Object per NAS, deployed from this repo alongside the Pages site. The NAS keeps an outbound WebSocket open to it. A device connects with the NAS's ID and its device token's public identifier, the service forwards SDP offers/answers and ICE candidates, and nothing else. It never sees disc content, titles or the library. It rate-limits per IP and per NAS.
- **STUN**: a public STUN server (Cloudflare's or Google's).
- **TURN (optional, user-configured)**: for networks where a direct connection fails (symmetric NAT, strict hotel Wi-Fi). Cloudflare Realtime TURN or a self-hosted coturn on a VPS. It forwards encrypted packets only. Costs and limits are the user's to accept; the app shows when a session is relayed.
- **NAS side**: `node-datachannel` (libdatachannel bindings) in the same server process (my call, consistent with §4.1).
- **Framing**: the §4.2 protocol over one reliable ordered data channel for control and one or more for bulk ranges. Responses are chunked into messages of at most 64 KB (Safari's limits are smaller than Chromium's 256 KB), with flow control on `bufferedAmount` / `bufferedAmountLowThreshold`. Range reads are cancellable by request ID so seeks abort cleanly.
- **Route selection**: the client tries HTTPS first if it has an HTTPS address for the NAS and it answers within a short timeout, else WebRTC. The engine doesn't know which route carries the bytes.
- **Throughput risk**: 30–50 Mbps over an intercontinental data channel is plausible but unproven, especially in Safari (SCTP windowing over high RTT). The step-3 plan starts with a spike that measures it from a remote network; if it falls short, multiple parallel data channels are the first remedy, and the lower-quality tier the second.

### 5.3 Invites, devices and revocation

- The NAS has a small admin page (on the LAN or tailnet only, protected by an admin password set at install). There the owner creates an invite for a named person.
- An invite is a one-time link and QR code containing the NAS ID and a single-use secret, expiring after a few days. Opening it in the app on a device redeems it: the device generates a non-extractable WebCrypto key pair, stores it in IndexedDB, and registers the public key with the NAS under that person's name. Each later session proves possession of the key (challenge–response over the data channel or HTTPS). The NAS stores public keys only.
- The owner can revoke a person (all their devices) or one device. Revocation ends open sessions.
- Everyone sees the same library in v1. Per-person shelves are a later extension; the data model gives each person an ID so it can be added.
- Concurrency: original-quality streams aren't capped (gigabit upload carries many); lower-quality streams are capped by step 4's transcode capacity.

## 6. Step 4: lower-quality tier (sketch)

- **Idea**: re-encode only the video elementary stream of the clips being played, on the N150's Quick Sync (VAAPI/QSV via ffmpeg, `intel-media-va-driver-non-free`), and leave audio, PG, IG and every other PID and all timestamps bit-exact. The client sees a disc whose clips are smaller; menus, subtitles and audio switching work unchanged.
- **Seeking**: the CLPI EP maps point at byte positions in the original clip. The NAS forces a keyframe at every EP-map entry's PTS and serves a rewritten CLPI whose EP map points into the re-encoded clip. To give the engine synchronous file sizes before encoding finishes, each EP interval gets a fixed byte budget for its tier, the encoder targets under it, and the remainder is padded with null TS packets; sizes and SPNs are then computable up front. This is the main technical risk of step 4 and gets its own design pass.
- **Tiers**: e.g. 1080p H.264 ~8 Mbps and 1080p HEVC ~5 Mbps; for UHD, 1080p HEVC Main10 with HDR kept, or tone-mapped to SDR H.264 for devices without HEVC. Exact ladder is left to step 4's design.
- **Live, not ahead of time**: encoding starts at the requested position and runs ahead of playback; a seek restarts it at the nearest EP entry. Optional pre-encoding of a title while idle is a later idea, not v1.
- **Choosing**: the user picks the tier at the pre-flight screen and can switch at any time (takes effect at the next seek point). No automatic quality switching in v1 (anti-goal: silent drops); an "auto" option can come later and must label itself.
- **Capacity**: the N150 handles about two simultaneous re-encodes (to be measured); the NAS refuses a third with a clear message.

## 7. Constraints

- `src/engine/` stays LGPL-2.1, free of React and UI imports. New engine pieces (`RemoteSource`, transports, memory profile) follow the `PlayerDeps` injectable pattern.
- Cross-origin isolation must hold online, offline, and with NAS responses (CORS + CORP on everything the NAS serves).
- `src/wasm/audio/audio.wasm` is unchanged by this work.
- vm-trace and ass-trace goldens are untouched; behaviour changes under the constrained memory profile must keep vm-trace equivalence (a cache size is not behaviour, a different IG loading order could be).
- Licences of new dependencies (`node-datachannel`, ffmpeg in the Docker image) recorded in `NOTICE` files as usual.

## 8. Decisions

| Question | Decision | By |
|---|---|---|
| Devices | Phone, tablet and laptop | User |
| Where discs are | Rips on the Ubuntu NAS; sometimes on the device or a USB drive attached to it | User |
| Offline | Installable app that works offline for local discs | User |
| Downloading discs for offline viewing | No | User |
| Routes to the NAS | Both: HTTPS (LAN, Tailscale) and browser-only WebRTC | User |
| Who watches | The user, maybe family and friends | User |
| BD-J | BD-J discs must work on iPhone; step 1 starts now without BD-J, and milestone 5 carries the phone requirements (§3.9) | User |
| Test devices | iPhone, iPad, USB drive, Mac; no Android device | User |
| iOS local discs | Impractical (Safari copies picked files, ~7 MB/s measured); iOS watches through the NAS; the landing screen explains a slow pick | User agreed (2026-10-17) |
| Rip format | Mostly folders, some `.iso` | User |
| Android verification | Emulator only; HEVC and USB OTG listed as unverified | My call |
| ISO support | Step 2, UDF reader ported from libudfread, shared by client and NAS | My call |
| Order | Step 1 cross-browser/mobile/offline, then NAS + HTTPS, then WebRTC + invites, then the lower-quality tier | User agreed |
| Weak connections | Original quality buffered first; lower-quality tier added in step 4 | User agreed |
| Firefox Android | Unsupported (no WebCodecs) | My call |
| NAS server stack | Node/TypeScript in this repo, Docker + systemd | My call |
| Signaling | Cloudflare Worker + Durable Object | My call |
| Pairing | Invite link/QR, per-device WebCrypto key pair | My call |
| HTTPS is tried before WebRTC | Yes | My call |
| App origin for NAS access | Stays on pages.dev; NAS-served copy only as LNA fallback | My call |
| No automatic quality switching in v1 | Yes | My call |
| Pausing when hidden | Only when the platform suspends audio; desktop unchanged | My call |
| IG sub-path above the constrained limit | Named failure, no streaming yet | My call |
| WebKit/Firefox in CI | Linux Playwright projects; real Safari only in the device gate | My call |

## 9. Left to the builder

- Service worker tooling, icon set, manifest details.
- The exact constrained-profile heuristic and numbers (within §3.5's intent).
- Touch gesture details beyond §3.3, and the narrow-screen layout of menus.
- Remote buffer sizes, number of parallel range requests, retry policy constants.
- Library thumbnail and title extraction details; disc ID scheme.
- Data-channel framing details and message sizes within §5.2.
