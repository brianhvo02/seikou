# Roadmap

What comes next for Seikou, in rough order. It is drawn from [known-issues.md](known-issues.md) (the source of truth for each limitation, with the reasoning behind it), the specs and plans in `docs/superpowers/`, and the status notes from each milestone. Sizes are rough: **S** is a day or less, **M** a few days, **L** a milestone of its own. Items marked *needs a disc*, *needs a device* or *owner's call* can't start until that is to hand.

Everything listed in [CLAUDE.md](../CLAUDE.md) under "What this is" is done: milestones 1 to 5e, cross-browser and mobile, the NAS server and title library, people and WebRTC, quality levels, the music shelf, fansubs, resume and the subtitle store, self-hosting and the docs, the packages and the developer site, the encoder and the Encodes library, HDR video through the video element with HDR labels and subtitles and menus over it at graphics white, disc preferences, deinterlacing, MPEG-2 and VC-1 decoding, and lossless and multichannel audio (TrueHD and DTS-HD decoded whole, 5.1 and 7.1 output; waiting for the owner's check by ear on a surround system).

## Now: housekeeping

Short tasks that unblock or protect what is already deployed.

| Item | Size | Notes |
| --- | --- | --- |
| **Owner set-up still pending:** the first real "Find fansubs" run on a title. | S | owner |
| **HDR overlay brightness by eye:** subtitles and menus over HDR video now go through WebGPU in extended range at a gain of 2.03 (graphics white over a 100 cd/m² SDR white, an assumption). Look at disc-hdr's subtitle on the iPhone and in Chrome on Windows with HDR on, try `?hdrgain=`, then keep the default, change it, or ask for a setting. | S | needs a device, owner's call |
| **Device check of the tools' touch timing:** `tools/devices/tap.ts` (settle, hold, check where each touch landed) has not run on an iPhone yet. Run it at the next device gate. | S | needs a device |

## Next: finish what was planned

| Item | Size | Notes |
| --- | --- | --- |
| **HDMV TextST and sub-path PG** decoding. | M | needs a disc |
| **Playlist ends:** a playlist ends 100 ms after its last picture, so a still at the end can end early; picking a PG stream re-reads the playlist, which shows the next picture of a slideshow early. | S–M | needs a disc |
| **Device coverage:** iPad over the NAS, real Android Chrome (HEVC, USB OTG), the iPhone row of the probe table, Blob slicing over 4 GiB on iOS, long press on real hardware, and the alphabet bar on a later iOS build. | M | needs a device |
| **A friend abroad over WebRTC.** The route has only been measured through a VPN. Record a real friend's throughput and start-up time. | S | needs a person |
| **The BD-J library's open cases:** 8 discs that fail in native libbluray too (a check by hand on the device) and 5 unconfirmed discs (3 that likely need their 3.5 GB menu clip copied, 1 too large to copy, 1 with a long opening video before the menu). | M | |

## Later: bigger pieces

| Item | Size | Notes |
| --- | --- | --- |
| **BD-J start-up on iPhone and iPad** (they miss the 10 s cold-start target by 0.8 to 1.6 s; desktop has little margin on its 5 s bar). The JIT (stage 2 of 5c §4.7, spec `2026-11-24-bdj-jit-design.md`) is built but measured no faster on the Mac or the iPhone 17 Pro and is off (`?jit=1`); that iPhone opened BDJ_DISC_A in 6.3 s cold and 5.8 s warm on 2026-11-24, so recheck the device table (the iPad especially) with `tools/devices/gate.ts` first. Levers that fit a thin, cold start-up better: intrinsics for the JDK's jar-manifest path, or keeping the booted JVM between BD-J entries. A compact constant-pool form is the matching memory lever. | M | owner's call; re-measure the devices first |
| **Field rate on an iPhone:** 1080i (VC-1 first) steps down to frame rate in some stretches of video. Decoding, the shaders, the canvas hand-offs and the page's main thread are all ruled out (known issues); the rest is inside WebKit's GPU side. Parked until a Safari release or a newer phone changes it. | M | parked |
| **Element path start in WebKit,** which begins about 33 ms behind the sound. | S | owner's call |
| **Encoders beyond Intel QSV** (NVENC, AMD VAAPI) for self-hosters. The self-hosting spec puts this last, after everything else. | L | |
| **Quality-level ideas:** pre-encode while the GPU is idle, re-encode audio, and an "auto" level that labels itself. Its known gaps (the disc's PSR1 audio choice at a level, the `primaryAudioChange` UO mask, the BD-J still timer restarting on a switch) are closed. | L | |
| **Per-person shelves,** and hiding titles from a person. | M | |
| **ASS fidelity, what is left:** HarfBuzz's vertical forms (`vert`, `vkna`) for `@` fonts, `\be` on a run whose shape changes every frame (drawn on the GPU as a Gaussian), and the libass extension `Encoding: -1` (bidi and shaping across style runs). `\be`, BorderStyle 4, legacy `Effect` and the turn of vertical `@font` glyphs were ported on 2026-11-24 (spec `docs/superpowers/specs/2026-11-24-ass-fidelity-design.md`); line breaking already matches libass for ASS scripts; FreeType's auto-hinter is not planned (below). | M | |
| **Shader gaps:** a Lanczos final scaler, linear-light PREKERNEL, the `COMPUTE` and `TEXTURE` directives, an early probe for `unavailable`, and hand-made sets. | M | |
| **Picture in Picture, next steps** (first slice built 2026-11-24, spec `2026-11-24-iphone-fullscreen-pip-design.md`): PG subtitles and ASS signs in Picture in Picture (text files already show as plain text); a canvas capture for MPEG-2, VC-1 and encodes; whether Auto should take the element path on phones so the first tap always enters; the 10 s media offset shown on the system player's clock. | M | owner's call |
| **A slimmer server image.** It is about 730 MB unpacked, most of it libraries Debian's `ffmpeg` pulls in that the levels never use. A build of our own with only the QSV and x264 parts would cut it. | M | |
| **JVM gaps,** each taken up when a disc needs it: JPEG decoding in Java, JSSE, annotation reflection, weak and soft references, finalizers, `SecureRandom` entropy, the verifier and access checks. Also libbluray deviations: one JVM per BD-J entry, and the HDMV navigator dropped rather than suspended. | S–M each | needs a disc |
| **Faithful HDMV resume:** the VM's program counter and the IG page. Resume is an approximation today. | L | |

## Not planned

- **AACS and BD+ decryption.** Seikou plays decrypted folders only; this would need legal review first.
- **3D (MVC), multi-angle and picture-in-picture secondary video.** These were non-goals for every milestone so far. HDR tone mapping on SDR screens is in the same group, beyond the `h264-1080-sdr` level.
- **Background audio on iOS.**
- **FreeType's auto-hinter for ASS.** About 1 px across a short title, in fonts without TrueType hinting only, for a port of FreeType's `autofit` run on outlines the browser never hands over (known issues).
