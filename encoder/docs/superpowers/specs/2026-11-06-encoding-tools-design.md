# Encoding Tools: Design Spec

Date: 2026-11-06
Status: Draft, decided in conversation; milestone 1 plan at `docs/superpowers/plans/2026-11-06-m1-pipeline-prototype.md`.
Related: Seikou (`~/seikou`, GitHub `brianhvo02/seikou`), the browser Blu-ray player whose parsers and PGS renderer this project reuses.

## 1. Goal

An app with a web interface that takes a decrypted Blu-ray folder, reads one of its playlists, lets the user group the playlist's chapters into episodes, and produces one watching encode per episode in a single streaming pipeline with no intermediate files. Each episode is an MKV with chapters, the disc's subtitles and any fansub tracks with their fonts. The app then serves those encodes to a browser. The Blu-ray stays the archive; the encodes exist for watching.

Non-goals: AACS or any decryption (users supply decrypted backups), archival-grade transparent encodes, Apple devices that cannot decode AV1 in hardware, DVD sources (later), menus.

## 2. Decisions

| Area | Decision | Why |
|---|---|---|
| App shape | Local web app: a Node/TypeScript backend that is also the playback server, a browser UI. No native shell. | Every tool is a subprocess with pipes and logs; streaming already needs an HTTP server. |
| Language | TypeScript on Node 22+. VapourSynth only as a `vspipe` subprocess. | Reuses Seikou's parsers, demuxer and PGS renderer (TypeScript, LGPL-2.1-or-later). |
| License | LGPL-3.0-or-later. Every encoder, decoder and muxer runs as a separate process; nothing GPL is linked. | FSF: invoking a program over pipes and arguments is aggregation, not a derivative work. |
| ffmpeg | Not used. Decoding goes through VapourSynth + BestSource (libavcodec inside, as LGPL libraries). Muxing is this project's own Matroska writer. | Removes the GPL-build question, gives frame-exact cuts and filtering. libavcodec is unavoidable for interlaced H.264, VC-1, MPEG-2, TrueHD and DTS-HD MA. |
| Delivery | A pinned manifest of tool versions per OS and CPU with checksums. Desktop: download on first run (`uv` installs Python + VapourSynth + BestSource). NAS: a Docker image built from the same manifest. | yt-dlp pattern; Seikou's server image is the Docker precedent. |
| Video | AV1 10-bit 4:2:0, SVT-AV1 mainline. | Plays natively in Chrome, Firefox, Edge, Android; Safari on M3/A17 Pro and newer. |
| Audio | Opus via `opusenc`: 160 kb/s stereo, 320 kb/s for 5.1 (mapping family 1). Never ffmpeg's native Opus or AAC encoders. | Transparent at these rates; community consensus (JET, encode.moe, thewiki, Codec Wiki). |
| Subtitles | ASS and fonts carried in the MKV; PGS copied untouched (`S_HDMV/PGS`). Web: JASSUB for ASS, Seikou's PG renderer for PGS. Never OCR PGS. | Only way to keep typesetting; browsers cannot draw PGS natively. |
| Container | MKV master per episode. Static per-episode web directory: WebM remux, `.sup` sidecar, ASS + fonts, WebVTT chapters. | WebM forbids ASS, fonts, FLAC and PGS. Static files need no CPU at serve time. |
| Apple | Only devices Safari already supports for AV1. No HEVC, AAC or HLS rendition. | Decided 2026-11-06. Verify AV1-in-WebM on a real device; fallback is a static fMP4 remux, never a transcode. |
| Seikou reuse | npm workspaces in Seikou; extract `@seikou/bdmv` first (the server already consumes it), `@seikou/pg` when this app's player needs it, ASS later; never BD-J. This app lives in its own repo and consumes the packages by git dependency until published. Until `@seikou/bdmv` exists, this repo aliases `seikou/*` to `../seikou/src/*`. | Different runtime dependencies and release rhythm. |

## 3. Architecture

```
disc folder ──► MPLS/CLPI parsers (Seikou) ──► Playlist model ──► Episode plan
                                                                   (chapter ranges → frame and sample ranges per clip)
per episode:
  video.vpy ──► vspipe -c y4m ──► SvtAv1EncApp -i - -b - ──► IVF stream ─┐
  audio.vpy ──► vspipe -c wav ──► opusenc - -            ──► Ogg stream ─┼──► Matroska writer ──► episode.mkv
  chapters (rebased to 0), PGS from the m2ts (Seikou demuxer) ───────────┘
packaging (M2): episode.mkv ──► episode.webm, episode.sup, subs/*.ass, fonts/*, chapters.vtt
```

One encoder instance per episode, because `SvtAv1EncApp` cannot force keyframes at chosen frames. Cuts are computed from the playlist's 45 kHz times against each stream's first PTS, so audio and video positions derive from the same absolute timestamp and need no mux-time offset. Multi-clip playlists are spliced inside the VapourSynth script.

## 4. Encoder settings (best practice references)

SVT-AV1 (mainline, v4.x). Base: `--preset 4 --crf 25 --enable-variance-boost 1 --tf-strength 1 --film-grain 4 --sharpness 1 --luminance-qp-bias 25 --enable-qm 1 --qm-min 0 --tile-columns 1 --keyint -2` (5 s closed GOPs, SVT default) plus BT.709 limited-range colorimetry flags, since y4m carries none. Input is converted to 10-bit in the VapourSynth script because SVT only writes 10-bit when the input is 10-bit.

- Amended 2026-11-07: `--sharpness 1 --luminance-qp-bias 25` (JET's sane base list) and `--enable-qm 1 --qm-min 0` (JET and Codec Wiki) were missing from the first version of this list by oversight. Measured on TSURUNE episode 1 at CRF 25: file 374 → 366 MB, VMAF 93.2 and SSIMULACRA2 mean 86.6 → 86.5 (unchanged), SSIMULACRA2 minimum 58.4 → 61.8 and frames below 70 from 13 to 10, the gain concentrated in dark scenes. Luma bias is for SDR and HLG only, not PQ.
- JET guide, SVT-AV1 page: preset 2 or 4 (not 3), variance boost on, keep CDEF and restoration, `--tf-strength 1`, grain synthesis even on clean sources (≥4 for dithering), tiles 1 column at 1080p, CRF 20–30. https://jaded-encoding-thaumaturgy.github.io/JET-guide/master/encoding/svtav1/
- Codec Wiki SVT-AV1 deep dives (anime corpus, SSIMULACRA2/XPSNR/Butteraugli): presets 2 and 4 best value; varboost default s2/o6 always helps; tf-strength 4 never; tune 1 fine; tiles cost almost nothing and give +67–250 % decode speed; luma-qp-bias < 50 helps anime but not PQ. https://wiki.x266.mov/blog/svt-av1-fourth-deep-dive-p1 and https://wiki.x266.mov/blog/svt-av1-fourth-deep-dive-p2
- SilentAperture, test encodes: cut a representative sample, test settings with 2-pass so bitrate stays fixed, then return to CRF. https://silentaperture.gitlab.io/mdbook-guide/encoding/testing.html
- Colorimetry must be tagged on output: https://wiki.x266.mov/docs/colorimetry/intro

Opus. `opusenc --bitrate 160 --ignorelength - -` for stereo; 320 for 5.1. Defaults otherwise (VBR, complexity 10, 20 ms frames).

- guide.encode.moe audio: `opusenc --vbr --bitrate 160 --ignorelength`, 320 for 5.1, never re-encode lossy audio. https://guide.encode.moe/encoding/audio/
- Codec Wiki Opus: stereo transparent ~128 kb/s; opusenc defaults are best practice. https://wiki.x266.mov/docs/audio/Opus
- thewiki release standards: Opus 128–192 stereo, 256–320 multichannel. https://guyman624.github.io/thewiki/advanced/release-standards

Filtering (later milestones). JET filter order: inverse operations first (IVTC, descale), then denoise, AA, dering, deband, regrain; never descale without a same-kernel rescale check. https://jaded-encoding-thaumaturgy.github.io/JET-guide/master/filtering/general/order/ and https://jaded-encoding-thaumaturgy.github.io/JET-guide/master/filtering/common/descaling/theory/

Matroska. Opus in Matroska needs `CodecDelay` = pre-skip and `SeekPreRoll` = 80 ms; AV1 needs `av1C` in CodecPrivate; chapters as one EditionEntry; Cues on video keyframes. RFC 9559 (Matroska), the AV1-in-Matroska mapping https://github.com/ietf-wg-cellar/matroska-specification/blob/master/codec/av1.md and the WebM guidelines https://www.webmproject.org/docs/container/.

PGS in the browser: Seikou's PG stack (`src/engine/graphics/pg-*.ts`, `segments.ts`, `composition.ts`), verified against libbluray; alternatives libbitsub (Rust/WASM, MIT) and libpgs-js (MIT). https://jsr.io/@altq/libbitsub

## 5. Licensing of what ships

| Tool | License | Use |
|---|---|---|
| SVT-AV1 | BSD-3-Clause-Clear + AOM patent grant | subprocess |
| opus-tools, libopus | BSD | subprocess |
| VapourSynth, vspipe | LGPL-2.1+ | subprocess |
| BestSource | MIT, links FFmpeg libraries (LGPL-2.1+) | VapourSynth plugin |
| Seikou packages | LGPL-2.1-or-later | imported |
| JASSUB | MIT | web |

Bundled GPL tools, if any are ever added, ship with their license text and a mirror of the exact source tarball.

## 6. Milestones

1. **Pipeline prototype (CLI).** Playlist model, episode plan, VapourSynth script generation, the piped encode, IVF/Ogg readers, the Matroska writer with chapters, an end-to-end test on a synthetic disc. Plan: `docs/superpowers/plans/2026-11-06-m1-pipeline-prototype.md`.
2. **Subtitles and packaging.** PGS passthrough into the MKV and `.sup` extraction with Seikou's demuxer, ASS + fonts as attachments, the static web directory (WebM remux, WebVTT chapters). Multi-channel audio and audio track selection by PID.
3. **Seikou packages.** `@seikou/bdmv` extraction in the Seikou repo; this repo switches from the path alias to the package.
4. **Web UI and job runner.** Disc browser, chapter grouping with a preview (the playlist plays in `@seikou/engine`, each chapter mark can be jumped to, and chapters are grouped into episodes while watching; added 2026-11-07), encode queue, logs and progress, settings profiles (SilentAperture-style test-encode helper).
5. **Player.** WebM playback, JASSUB, `@seikou/pg` for PGS, WebVTT chapters; Safari AV1-in-WebM check.
6. **Delivery.** Manifest, first-run bootstrapper with `uv`, Docker image.

## 7. Open questions

- Audio track choice when a disc has several (M2: by PID from the STN table; BestSource picks by stream index, so a PID-to-index mapping is needed).
- Interlaced (1080i) discs: QTGMC through VapourSynth, a per-source flag; not in M1.
- Whether the HDMV VM's chapter names (none on disc) get titles from AniList as Seikou's library does.
