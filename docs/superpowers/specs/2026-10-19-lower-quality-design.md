# Lower Quality on the NAS (Step 4) — Design Spec

Date: 2026-10-19
Status: Approved by the user 2026-10-19. Phase 1 (the NAS side) is deployed and checked on the NAS on 2026-10-20 with `verify-level`. Every rewritten EP entry was an IDR at its PTS, decoding was clean, and the bytes matched the manifest on: a 1080p H.264 film at h264-1080 (4.6× real time) and a music disc at phone-720 (7.3×), an MPEG-2 film at h264-1080 (4.5×), and a UHD HDR10 film at h264-1080-sdr (1.5×); three fresh viewings at once ran at 2.0–2.3× real time each. Two production fixes followed the first run: QSV rounds frame PTS to the grid, so PTS is restored from the source; and per-interval budgets now merge intervals under 2 s and scale with the stream mix (§5.2, no scan, the user's choice: no first-open wait). Phase 2 (§7, the UI) is built: the pre-flight's level list, the Quality menu, audio at a level, the level badge and the switch, with E2E on the x264 backend; merged 2026-10-22 (ff8ffd5) and deployed (site and NAS, f3d4134). The iPhone device run found VC-1 failing at levels; fixed by decoding VC-1 in software (42bd454, deployed). The rerun on an iPhone on mobile data passed 2026-10-22: a VC-1 film at the auto Phone level had its first frame in 12.9 s, seeked in 0.5 s and switched to 1080p in about 5 s; an MPEG-2 film's first frame took 7.2 s and H.264's 4.0 s. On 2026-10-27, with the image on Debian's ffmpeg, `verify-level` passed again for VC-1, MPEG-2 and H.264 at h264-1080 and phone-720 (HEVC levels not rerun).
Parent spec: `2026-10-16-cross-browser-and-remote-design.md` §6 (step 4 sketch). Builds on `2026-10-18-webrtc-people-design.md` (people, the WebRTC route, buffer-first). Where this document and the parent disagree, this one wins for step 4.

## 1. Intent

A friend abroad measured 17 Mbps; mobile data gave 18 Mbps. Blu-ray films need 25–48 Mbps, so today they wait half an hour or watch with pauses. The user wants:
- on a phone, a smaller but sharp picture;
- on a computer, whatever quality starts playing straight away with no wait;
- the app to pick automatically, and the viewer able to override it.

The same re-encoder also makes MPEG-2 and VC-1 films playable: no browser decodes them, and 44 of 166 BD-J discs (and surely more among the rest) use them. BD-J milestone 5e (another session) makes those discs' menus work and shows "this disc's video can't play here yet"; making the films play is this step's job.

Stakes (user's words): low; nothing in particular would make them wince if auto picked wrongly.

## 2. Facts measured on the NAS (2026-10-19)

- The NAS now runs kernel 7.0 (`linux-generic-hwe-24.04`, installed by the user). Its Intel N150 graphics (PCI 46d4) is driven by i915; `/dev/dri/renderD128` exists, group `render` (GID 993). The old 6.8 kernel didn't know the device. Jellyfin doesn't use the GPU.
- With jellyfin-ffmpeg (Lavc 61.19, iHD 25.4.4): decode MPEG-2, VC-1, H.264, HEVC Main/Main10; encode H.264 and HEVC Main/Main10.
- Throughput, 120 s of film, video only, hardware decode → encode:

| Job | × real time, alone | 3 at once, each |
|---|---|---|
| 1080p H.264 → H.264 8 Mbps | 6.2× | 2.7× |
| 1080p MPEG-2 → H.264 8 Mbps | 6.9× | 2.8× |
| 1080p → HEVC 5 Mbps (preset veryfast) | 4.8× | 1.4× |
| 1080p → 720p H.264 3 Mbps | 9.2× | — |
| UHD HDR10 → 1080p HEVC Main10 HDR (veryfast) | 2.1× | — |
| UHD HDR10 → 1080p H.264 SDR, tone-mapped (`vpp_qsv`) | 2.8× | 1.2× |

  Total H.264 encode capacity ≈ 195 fps (≈ 8× real time); HEVC ≈ 105 fps. Host CPU stays 13–32%; the GPU is the limit.
- `-force_key_frames` with `-forced_idr 1` puts real IDR frames exactly at requested source PTS (with `-copyts`), for both encoders.
- Quality, 30 s against the source: 1080p H.264 8M SSIM 0.989 / PSNR 48.6 dB; 1080p HEVC 5M 0.990 / 49.2 dB; 720p H.264 3M 0.985 / 43.6 dB.
- Commands that worked are recorded in the session's spike notes; the builder re-derives them.

## 3. Goals, non-goals, anti-goals

Goals:
- **Quality levels** (my call, from §2): Original; 1080p H.264 ≈ 8 Mbps; Phone 720p H.264 ≈ 3 Mbps; for UHD HDR sources, 1080p HEVC Main10 HDR (only for devices that decode HEVC Main10) and 1080p H.264 SDR tone-mapped. A 1080p HEVC ≈ 5 Mbps level is offered only for devices that decode HEVC and only while the NAS has HEVC capacity.
- **Auto choice** (user: auto with override; my reading of "phone → sharp but smaller, computer → plays with no wait"):
  - computer: the highest level whose rate (×1.1, as in step 3's buffer plan) fits the measured connection; Original when it fits;
  - phone: at most the Phone level unless the viewer picks higher;
  - MPEG-2 / VC-1 discs: never Original (unplayable); the best re-encoded level that fits, for everyone, the owner included.
- **Override:** the pre-flight lists the levels with their rates and waits; during playback a Quality menu switches level. A switch takes effect within a few seconds, at the next seek point.
- **Everything else unchanged:** menus (HDMV and BD-J), chapters, seeking and subtitles work as with Original. Only the primary video stream is re-encoded; the streams a level keeps (§5.2) stay bit-exact, and all timestamps too.
- **Audio on re-encoded levels** (user, 2026-10-19): only the audio track picked at open travels, reduced to the core the player already plays. Switching audio language mid-film becomes like switching level: a few seconds, at the next seek point.
- **Up to 3 viewers at once** (user). Capacity is counted in encoder frames per second, not people (§6.4).
- Works on every route (home, Tailscale, WebRTC, relay).

Non-goals:
- Automatic switching during playback as the connection changes (parent §8: no silent drops). Auto picks once, at open; switches are the viewer's.
- Pre-encoding the library while idle (a later idea).
- Re-encoding audio (lossless tracks are large, but video dominates; later if needed).
- Anything for local folder discs (they don't come from the NAS).

Anti-goals:
- **Disturbing the NAS's other services.** Re-encoding runs on the GPU; CPU use stays low. Jellyfin and the rest must not notice.
- **Writing to the drives.** Encoded segments live only under `/data`.
- **A stall without explanation.** A busy NAS answers before playback with a clear message, never by starving a stream.

## 4. Order of work and the 5e dependency

The engine's playback path is off limits until BD-J 5e's MPEG-2/VC-1 change (accepting playlists without playable video) has merged; that session says when (agreed 2026-10-18). So:
1. **NAS side first** (§5–§6): the encoder pipeline, the re-muxer, rewritten CLPI/MPLS, the segment cache, capacity, the API. Testable end to end with a script that reads a level's files and decodes them, without the engine.
2. **Client side after 5e merges** (§7): pre-flight choice, the Quality menu, the switch, capability checks.

What "the playback path" means (my call): the engine's demux, decode, presentation and `Player` session code. The transport in `src/engine/disc/` (`HttpTransport`, `RemoteSource`, the WebRTC fetch) may change in phase 1: the `level` and audio parameters on manifest and range URLs, and retry on 503.

## 5. How a level is served

The client sees each level as **another version of the same disc**: the same paths and the same metadata, except that the stream files are re-encoded and the files that describe them say so. The engine reads it like any NAS disc.

- **Manifest per level:** `GET discs/<id>/manifest?level=<level>` returns the manifest of that version: the same file list, with `.m2ts` sizes and the inlined `.clpi` (and `.mpls` where the video's coding type changes) of the level. Range reads: `GET discs/<id>/files/<path>?level=<level>&t=…`. `level=original` (or none) is today's behaviour.
- **Rewritten metadata:** in each CLPI, the video stream's coding type (MPEG-2 0x02, VC-1 0xEA, HEVC 0x24 → H.264 0x1B or HEVC 0x24 as the level says), its format/rate fields, and the EP map's SPNs (§5.1); in each MPLS, the STN table's video coding type. Everything else is copied.
- **Byte layout (parent §6, the main risk):** to give the engine exact file sizes before anything is encoded, every EP interval (the bytes from one video EP entry to the next) gets a fixed byte budget for the level:
  - budget = interval duration × the level's peak rate ÷ 8, rounded up to a whole aligned unit (6144 bytes, 32 source packets);
  - the interval's new bytes are: the original interval's non-video packets in their original order and relative position, the encoded video's packets interleaved by DTS, then null packets (PID 0x1FFF) to the budget;
  - each EP entry's SPN is the running total of budgets ÷ 192, so the rewritten EP map and the file size are computable from the original CLPI alone.
  - The encoder uses capped VBR (maxrate under the budget's rate). An interval whose encode comes out over budget is re-encoded at a lower rate before it's served; the builder measures how often that happens and picks the margin.
  - Arrival timestamps (the 4-byte TP_extra_header) are rewritten to stay monotonic within the interval; the builder checks what the engine's demux expects of them.
- **Keyframes:** every EP entry's PTS gets a forced IDR (`-forced_idr 1`, `-copyts`), so seeking lands where the EP map says.
- **HDR:** the HDR level keeps HDR10 metadata (verified in the spike). Dolby Vision layers are dropped (HDR10 base only). The SDR level tone-maps with `vpp_qsv`.

### 5.2 What a re-encoded level carries

- **Video:** the primary video stream, re-encoded. Secondary video (picture-in-picture), the 3D MVC dependent view and a Dolby Vision enhancement layer are dropped (my call); the CLPI program info and MPLS STN tables lose those entries.
- **Audio** (user): only the track chosen at open (the level request carries the audio stream number, chosen by the player's usual PSR rules: the disc's default or the user's language). Lossless tracks are reduced to their lossy core, bit-exact: TrueHD to its AC-3 substream, DTS-HD to its DTS core (the cores the engine already plays). LPCM stays LPCM (the builder decides whether a level refuses LPCM sources or carries them). Other audio streams and secondary audio are dropped from the stream files and the STN/program info.
- **Graphics:** every PG (subtitle) and IG (menu) stream stays, bit-exact; they're small.
- **Byte budget per EP interval** (refines §5): total = interval duration × (the level's video peak + the kept audio's nominal rate, read from its first frame header + a graphics allowance of 1.5 Mbps) ÷ 8, rounded up to an aligned unit. Computable from the CLPI and one read of each clip's first audio frame, so a level's manifest is ready in seconds, with no full-clip scan. At encode time the interval's actual non-video bytes are known (the server reads the interval), and the video encode targets the remainder; an interval whose non-video bytes alone overflow is served with its video re-encoded at the floor rate, and the builder reports how often that happens.
  - **Amended 2026-10-20 (production overflow):** a one-frame interval (0.04 s) of an LPCM music disc got 43 008 bytes at Phone and held 25 728 bytes of LPCM plus a 15 KB IDR even at the 1 Mbps floor, so its read failed with HTTP 500; discs with 11 PG streams burst 300–420 KB of subtitles in 0.5–0.75 s, and a clip's last interval holds the audio muxed after its last picture. Still from the CLPI alone (no scan, no wait): intervals under 2 s are merged with the next (a clip's last with the one before), dropping the merged-away EP entries; the audio counts at its rate in source packets (7–20% over nominal); the graphics allowance is 1.5 Mbps plus 50 kbps per PG stream beyond the first and 1 Mbps per IG stream, at least 32 KB per stream per interval; the video's part is at least an IDR. An interval that still doesn't fit with its video at the floor drops whole PG/IG PES, highest stream numbers first, and logs it once per clip; video and the kept audio are never dropped. Simulated on 12 real discs (all intervals of their main clips): no interval needs the last resort at Phone, 1080p or 1080p HEVC; sizes grow 6.8% (worst 11.1%) at Phone, 3.4% at 1080p, 4.9% at 1080p HEVC over the old formula; 60% of EP entries are merged away.
- **Padding travels** (my call): null packets are sent like any other bytes, so a level's wire rate is its budget rate, and the auto rule (§3) and the pre-flight use the budget rate, not an average. The builder sets the encode's peak-to-average (my call: maxrate 1.25 × target) and the levels so that the budget rates come out at about: Phone ≈ 4 Mbps, 1080p ≈ 10 Mbps, 1080p HEVC ≈ 7 Mbps, before audio.
- **Interlaced sources** (1080i, 576i, telecined VC-1; my call): deinterlaced to progressive at the frame rate (25/30p; pulldown removed to 23.976p where flagged), with `vpp_qsv` deinterlacing. Encoder load and capacity stay as for progressive; motion in sports and concerts is a little less smooth. The CLPI's video format and rate fields say the new values.

## 6. The encoder pipeline on the NAS

### 6.1 Live, ahead of playback

- A read of a level's stream file at an offset maps to an EP interval. If that interval is encoded (cache, §6.3), it's served at once. If the encoder for that clip is already running and will reach it soon, the read waits; otherwise (a seek) the clip's encoder restarts at the EP entry at or before that interval.
- The encoder runs ahead of the furthest read by a window (my call: 120 s of film), then idles until reads advance; it stops when no read has touched the clip for 60 s.
- A read that waits longer than 15 s answers 503 with `Retry-After: 1`. Today `HttpTransport` treats 503 as a failure; the NAS-side phase adds a retry on 503 there and on the WebRTC route (§4: `src/engine/disc/` transport code is not the playback path).
- One ffmpeg process per active clip per level, hardware decode → (scale / tone-map) → encode, video only, reading the clip from the read-only drive mount; the server re-muxes its output with the original clip's other packets.

### 6.2 The container

- The server image gains ffmpeg with Intel's media driver (jellyfin-ffmpeg's build, or Debian's ffmpeg plus `intel-media-va-driver-non-free`; the builder picks, by what the spike's commands need). ffmpeg runs as a separate process, so the server stays plain Node with no native addons; CLAUDE.md's "no native dependencies" note gets a line saying ffmpeg is a bundled binary in the image.
- `compose.yaml` passes `/dev/dri/renderD128` and adds the `render` group (by GID, 993 on this NAS).
- Without a GPU (no `/dev/dri`, or a failing encoder self-test at start), the server offers only Original and says so in `GET me` (`levels: false`); MPEG-2/VC-1 discs then show 5e's "can't play here yet".

### 6.3 Segment cache

- Encoded EP intervals (already re-muxed and padded) are kept under `/data/transcode/<discId>/<level>/<clip>/`, one file per interval or per group of intervals, with an LRU byte budget (my call: 50 GB; the NAS's system disk has ~350 GB free). A second viewer, a re-watch or a seek back is then free.
- The cache is keyed by the clip's size and mtime, so a replaced disc never serves stale bytes.

### 6.4 Capacity

- The server keeps two budgets from the spike, H.264 ≈ 190 fps and HEVC ≈ 100 fps of encoder output, and admits a new viewing only if its need (the film's output fps × 1.3 for a margin) fits what's left.
- **Admission is a lease per viewing** (my call): granted when a disc opens at a level, held across seeks, encoder restarts and audio switches, released when the disc closes or no read arrives for 2 minutes. A level switch moves the lease (admitted if the new level fits, else the viewer keeps the old one with a message). First come, first served: the owner doesn't preempt guests.
- Three 1080p H.264 viewers fit with room to spare; HEVC and UHD jobs fit fewer.
- Refused: the pre-flight shows "The NAS is busy re-encoding for others. This will play at original quality." (for an MPEG-2/VC-1 disc: "The NAS is busy. Try again in a few minutes."). The owner's admin screen shows what's encoding for whom.

## 7. The client (after 5e merges)

- **Capabilities:** the existing capability report gains: HEVC Main10 decode, and whether the display is HDR (`matchMedia('(dynamic-range: high)')`). "Phone" means the constrained memory profile or a small screen (`matchMedia('(max-width: 900px)')` on the shorter side), never the user agent.
- **Pre-flight:** asks `GET discs/<id>/levels` → `[{level, label, peakMbps, avgMbps, available, reason?}]`, computes each level's wait with step 3's buffer plan, preselects by §3's auto rule, and lists the others ("1080p · plays now", "Original · about 38 minutes"). Buffer-first applies to whichever level is chosen.
- **Quality menu during playback:** switching reopens the disc's byte source at the new level and continues from the current position. The engine side: a `setLevel` command that swaps the disc's manifest (sizes, CLPI, MPLS) and byte source and seeks back to the current time; HDMV navigation state and BD-J keep running (they don't depend on stream bytes). The builder confirms that with the BD-J session, since BD-J reads its own copy of the disc.
- **Labels:** the player's info line shows the level ("1080p · re-encoded on the NAS"); MPEG-2/VC-1 discs say so.

## 8. Testing

- **Server unit tests:** the budget arithmetic and EP-map/CLPI/MPLS rewrite on synthetic clips; the re-muxer (non-video packets keep order and relative position, nulls fill the budget, an over-budget interval is retried); cache keys and eviction; capacity admission.
- **CI has no GPU:** the encoder command is injectable, and CI uses software encoding (libx264 at small sizes) on `fixtures/synthetic/` discs, including a new synthetic MPEG-2 disc (`npm run fixture:synthetic`, ffmpeg's mpeg2video). An E2E plays a synthetic disc at a re-encoded level in all three browsers and seeks.
- **NAS test:** a script reads a real disc's level files over the API, decodes them with ffmpeg and checks every EP entry lands on an IDR and the stream plays through; plus a 3-viewer load run.
- **Device run:** the iPhone on mobile data opens a film; auto picks Phone; it plays with no wait; seek; switch to 1080p; an MPEG-2 film plays.

## 9. Constraints

- Everything in CLAUDE.md: the public repo (made-up names only, also in fixture names and test output), no writes under `/mnt`, Caddy reload only, `src/engine/` free of UI imports, TypeScript strict.
- The engine's playback path waits for 5e's MPEG-2/VC-1 merge (§4).
- ffmpeg's licence (LGPL/GPL, depending on the build) is recorded in the server's `NOTICE`; the image ships ffmpeg as a separate binary.

## 10. Decisions

| Question | Decision | By |
|---|---|---|
| What "lower quality" means | Phone: smaller but sharp; computer: plays with no wait | User |
| Who picks | Auto, with the viewer able to override | User |
| How many at once | Up to 3 | User |
| Stakes | Low | User |
| GPU | i915 on kernel 7.0 (HWE), installed and rebooted by the user 2026-10-19 | User |
| MPEG-2 / VC-1 | Always re-encoded, for everyone | Agreed 2026-10-18 (via the BD-J session) |
| Levels and rates | §3, from the spike | My call |
| Byte layout | Fixed budget per EP interval, padded with nulls | Parent §6, my call |
| Read-ahead window, idle stop, wait timeout | 120 s, 60 s, 15 s | My call |
| Cache | `/data/transcode`, 50 GB LRU | My call |
| Capacity | Counted in encoder fps, two budgets | My call, from the spike |
| Order | NAS side first, client after 5e merges | My call |

## 11. Left to the builder

The ffmpeg build in the image; exact encoder options and the over-budget margin (measured); ATS rewriting details; the cache's file granularity; the levels endpoint's exact shape; the Quality menu's layout and copy beyond the strings above; how the server learns a film's frame rate for capacity (CLPI or the first ffprobe).
