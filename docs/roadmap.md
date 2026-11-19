# Roadmap

What comes next for Seikou, in rough order. It is drawn from [known-issues.md](known-issues.md) (the source of truth for each limitation, with the reasoning behind it), the specs and plans in `docs/superpowers/`, and the status notes from each milestone. Sizes are rough: **S** is a day or less, **M** a few days, **L** a milestone of its own. Items marked *needs a disc*, *needs a device* or *owner's call* can't start until that is to hand.

Everything listed in [CLAUDE.md](../CLAUDE.md) under "What this is" is done: milestones 1 to 5e, cross-browser and mobile, the NAS server and title library, people and WebRTC, quality levels, the music shelf, fansubs, resume and the subtitle store, self-hosting and the docs, the packages and the developer site, the encoder and the Encodes library, HDR video through the video element with HDR labels, disc preferences, deinterlacing, and MPEG-2 and VC-1 decoding.

## Now: housekeeping

Short tasks that unblock or protect what is already deployed.

| Item | Size | Notes |
| --- | --- | --- |
| **Owner set-up still pending:** the first real "Find fansubs" run on a title. | S | owner |
| **Device check of the tools' touch timing:** `tools/devices/tap.ts` (settle, hold, check where each touch landed) has not run on an iPhone yet. Run it at the next device gate. | S | needs a device |

## Next: finish what was planned

| Item | Size | Notes |
| --- | --- | --- |
| **Subtitles from picked `.mkv` files.** Extract ASS and SRT tracks and attached fonts from an `.mkv` the viewer picks or drops (the Encodes library's own MKVs already load theirs), deferred since M4b. This pairs with episode subtitle sets and the subtitle store. | M | |
| **HDMV TextST and sub-path PG** decoding. | M | needs a disc |
| **Playlist ends:** a playlist ends 100 ms after its last picture, so a still at the end can end early; picking a PG stream re-reads the playlist, which shows the next picture of a slideshow early. | S–M | needs a disc |
| **Device coverage:** iPad over the NAS, real Android Chrome (HEVC, USB OTG), the iPhone row of the probe table, Blob slicing over 4 GiB on iOS, long press on real hardware, and the alphabet bar on a later iOS build. | M | needs a device |
| **A friend abroad over WebRTC.** The route has only been measured through a VPN. Record a real friend's throughput and start-up time. | S | needs a person |
| **The BD-J library's open cases:** 18 discs that fail in libbluray too (a native amd64 libbluray run, or a check by hand) and 1 unconfirmed disc (a long opening video before the menu). | M | |

## Later: bigger pieces

| Item | Size | Notes |
| --- | --- | --- |
| **BD-J JIT** (stage 2 of 5c §4.7). This is the start-up lever: iPhone and iPad miss the 10 s cold-start target by 0.8 to 1.6 s, and desktop has little margin on its 5 s bar. A compact constant-pool form is the matching memory lever. | L | owner's call (deferred by choice) |
| **Faster WASM video decoding:** threads, or skipping the field the frame-rate step doesn't show, so 1080i VC-1 plays at field rate on an iPhone. | M | |
| **Deinterlacing gaps:** RGB frames from Firefox on macOS (interlaced H.264 shows woven there) and a cheaper deinterlacer for software WebGL. | M | |
| **HDR overlays at graphics white:** subtitles and menus over HDR video are drawn SDR; try a float16 or WebGPU canvas on an HDR display. | M | needs a device, owner's call |
| **Element path start in WebKit,** which begins about 33 ms behind the sound. | S | owner's call |
| **Lossless and multichannel audio:** full TrueHD and DTS-HD instead of their cores, and output beyond a stereo downmix (multichannel PCM where the browser offers it; no Atmos or DTS:X height channels, since a page can't pass a stream through). | L | deferred by the owner (2026-11-16) |
| **Encoders beyond Intel QSV** (NVENC, AMD VAAPI) for self-hosters. The self-hosting spec puts this last, after everything else. | L | |
| **Quality-level ideas:** pre-encode while the GPU is idle, re-encode audio, and an "auto" level that labels itself. Known gaps to close: the disc's PSR1 audio choice at a level, the `primaryAudioChange` UO mask, and the BD-J still timer restarting on a switch. | L | |
| **Per-person shelves,** and hiding titles from a person. | M | |
| **Signalling hardening:** a lockout for hostile clients, and not showing the NAS's addresses in the answer SDP to anyone who holds its id. | M | |
| **Read-ahead cache per tab:** a Web Lock per disc, since the cache is shared by the origin. | S | |
| **ASS fidelity:** legacy `Effect`, FriBidi across style runs, line breaking (libunibreak), the auto-hinter, and approximations of BorderStyle 4, vertical `@font` and `\be`. | M–L | |
| **Shader gaps:** a Lanczos final scaler, linear-light PREKERNEL, the `COMPUTE` and `TEXTURE` directives, an early probe for `unavailable`, and hand-made sets. | M | |
| **iPhone fullscreen and PiP** through a `<video>`: the element path already plays H.264 and HEVC in one, so the experiment can start there rather than from a canvas capture. | M | experiment |
| **A slimmer server image.** It is about 730 MB unpacked, most of it libraries Debian's `ffmpeg` pulls in that the levels never use. A build of our own with only the QSV and x264 parts would cut it. | M | |
| **JVM gaps,** each taken up when a disc needs it: JPEG decoding in Java, JSSE, annotation reflection, weak and soft references, finalizers, `SecureRandom` entropy, the verifier and access checks. Also libbluray deviations: one JVM per BD-J entry, and the HDMV navigator dropped rather than suspended. | S–M each | needs a disc |
| **Faithful HDMV resume:** the VM's program counter and the IG page. Resume is an approximation today. | L | |

## Not planned

- **AACS and BD+ decryption.** Seikou plays decrypted folders only; this would need legal review first.
- **3D (MVC), multi-angle and picture-in-picture secondary video.** These were non-goals for every milestone so far. HDR tone mapping on SDR screens is in the same group, beyond the `h264-1080-sdr` level.
- **Background audio on iOS.**
