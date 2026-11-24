# Lossless and multichannel audio

Status: design, written unattended on 2026-11-24 by the night lead (the owner asked for the item that evening; it had
been deferred on 2026-11-16). Every decision the owner has not seen is marked *(My call: … — why.)*. Roadmap item
"Lossless and multichannel audio" (`docs/roadmap.md`, Later).

## Why

Seikou plays every Blu-ray audio track as a 48 kHz stereo downmix. Dolby TrueHD plays through the Dolby Digital (AC-3)
core Blu-ray carries beside it, and DTS-HD Master Audio and High Resolution through the DTS core. On stereo
headphones that loses little (`docs/known-issues.md` said so), but anyone with a 5.1 or 7.1 system, a receiver over
HDMI or a multichannel interface, hears a fold-down of a lossy core. A page can't pass a bitstream through to a
receiver, so the only route is to decode in the browser and play multichannel PCM, which Web Audio can do where the
output device has the channels.

## Goals

- **Lossless decode** of TrueHD (MLP) and of DTS-HD (core plus extensions: XLL for Master Audio, XBR/X96/XXCH for High
  Resolution) through FFmpeg's `truehd` and `dca` decoders in `audio.wasm`, bit-exact with FFmpeg's own decode.
- **Multichannel output**: up to 7.1 discrete PCM where the device offers six or eight channels, with LPCM, AC-3,
  E-AC-3, DTS, TrueHD and DTS-HD all routed by channel name, not position.
- **No regression in stereo**: on a two-channel device every codec is folded to stereo exactly as today (the same
  FFmpeg downmix for the coded formats, the same coefficients for LPCM), so stereo users hear the same balance and
  level.
- **The cores stay where lossless isn't worth it or can't run**: on the constrained memory profile (phones and
  tablets), when the lossless part of a stream fails, and when decoding it takes too much of the engine worker.
- **The user can see what plays**: the telemetry's `audioCodec` names the decoding ("Dolby TrueHD, lossless, 7.1" or
  "Dolby TrueHD, Dolby Digital core"), and the Audio menu marks the playing track "lossless" or "core".
- A way to force stereo on a device that claims more channels than it has speakers.

## Non-goals

- Atmos and DTS:X objects and height channels. FFmpeg decodes TrueHD up to its third substream (the 7.1 bed) and DTS:X
  as its 7.1 XLL bed; nothing renders objects, and a page can't pass a stream through.
- Output above 48 kHz. The output context stays at 48 kHz; 96 and 192 kHz lossless audio is decimated as LPCM already
  is. *(My call: keep the 48 kHz context — the clock, the ring, the element path's sync and the menu sounds all assume
  it, a 96 kHz context doubles the worklet's work on every disc, and no listener tells 96 from 48 at the end of a
  browser's mixer.)*
- The NAS's quality levels. `server/src/levels/audio-core.ts` keeps one audio stream's core for a re-encoded level
  (its byte budget prices the core's rate). Lossless at a level would need its own budget; left alone. *(My call: not
  trivial — the level's per-interval budgets are computed from the core's rate before anything is encoded, and a
  lossless track is several times larger; a re-encoded level is for a slow link, where a core is right anyway.)*
- E-AC-3 7.1 beyond what FFmpeg's `eac3` gives (it decodes the dependent substream's extra channels; nothing new).
- Changing the output channel count while a page lives (see Output).

## Approaches considered

1. **Decode lossless only when the output has more than two channels.** Cores stay for every stereo listener, so no
   one can hear a change, but CI (a stereo null sink) and every developer machine would never run the lossless path,
   and it would ship untested.
2. **Decode lossless whenever the device class allows it (chosen)**, and fold to the output's channels. Stereo
   desktops run the lossless decoders (cheap there, measured below) with FFmpeg's own stereo downmix: TrueHD's
   two-channel presentation (the disc's own lossless stereo mix) and DTS's embedded downmix. The E2E runs it.
3. **A JS/TS port of MLP and XLL decoding.** No: FFmpeg's decoders are already in the module, LGPL as the rest, and
   bit-exact by construction.

*(My call: approach 2 — the lossless path is exercised everywhere desktops play, so CI catches regressions; the cost
on a desktop is a fraction of a percent of a core; phones keep cores, where a stereo fold of lossless audio is not
audible and battery matters.)*

## Design

### Decoders (`audio.wasm`, `packages/engine/wasm/audio/`)

`build.sh` enables `truehd` beside `ac3`, `eac3` and `dca`. The shim (`shim.c`) changes:

- `audio_open(codec, out_channels)`: codec 0 AC-3/E-AC-3, 1 DTS core only (`core_only`), 2 DTS with its extensions,
  3 TrueHD. `out_channels` 2 asks every decoder for a stereo downmix (as today); 6 asks TrueHD and DTS for 5.1 (TrueHD
  then decodes its own six-channel presentation, DTS its embedded 5.1 downmix); 8 asks nothing.
- `audio_decode` writes the frame **interleaved in the decoder's own channel order**, any channel count (up to 8;
  more is an error), and `audio_channels(d)` / `audio_channel(d, i)` give the count and the `AVChannel` of each. The
  shim no longer folds anything; the stereo fold it did for a decoder that ignored `downmix` moves to TypeScript with
  the same coefficients.
- Packed `S16` and `S32` (TrueHD's formats) join the planar and float ones. Integer samples are scaled by 2⁻¹⁵ and
  2⁻³¹ into float, exact for 24-bit audio, so a test can compare with ffmpeg's `s32le` decode bit for bit.

`WasmFrameDecoder.decode` returns `{ sampleRate, channels: Speaker[], samples }`.

### Framing

- **TrueHD** (`AudioFramer` kind `truehd`): an MLP access unit is `access_unit_length` 16-bit words (12 bits after a
  check nibble) and lasts 1/1200 s (40 samples at 48 kHz, 80 at 96, 160 at 192). The framer cuts units from the MLP
  PES (stream_id_extension 0x72), drops everything before the first major sync (`F8 72 6F BA` at offset 4), and
  resyncs to the next major sync after the decoder rejects a unit (`resync()`). Units are fed one by one (FFmpeg's
  `truehd` takes single access units).
- **DTS-HD** (kind `dtshd`): a core frame and the extension substream (EXSS, sync `64 58 20 25`) after it make one
  packet, as FFmpeg's parser builds it, with the core padded to 4 bytes (the EXSS is 4-byte aligned, and padding bytes
  between them are skipped by the resync). A packet is emitted when the next core starts, like an E-AC-3 access unit,
  so the last frame before the end of input is not played (an existing known issue, now also DTS-HD's).
- DTS core (kind `dts`) and AC-3 are unchanged.

### Which decoder (`decode/audio-decoder.ts`)

`AudioDecoderFactory` gains options: `(codingType, { outputChannels, lossless })`. The player passes its ring's
channel count and the memory profile's new `losslessAudio` (desktop `true`, constrained `false`).

- `TRUEHD` with `lossless`: a `LosslessDecoder` over the MLP units, with the AC-3 core decoder as its fallback; without:
  today's `TrueHdCoreFilter` path.
- `DTSHD` and `DTSHD_MASTER` with `lossless`: the `dtshd` framer and codec 2, falling back to codec 1 on the same
  packets; without: today's core path.
- Everything else as today.

**Fallback to the core** (`LosslessDecoder`), once per stream, from the next unit, logged and visible in the label:
the lossless decoder throws `UnsupportedCodecError` (say, a rate other than 48, 96 or 192 kHz), no lossless output
has come 2 s of stream time after the first unit while the core is there (TrueHD with a broken or missing MLP part),
more than 50 frames fail in a row, or decoding costs more than 25 % of real time measured over 5 s of audio (the
engine worker also feeds video; at 25 % something is badly wrong, since a desktop measures under 1 %). *(My call:
25 % over 5 s — high enough that a desktop never trips it, low enough that a slow machine falls back before the
video decoder starves; the measured cost is in the report.)*

### Channels (`audio/channel-map.ts`, new)

Speakers are named (`FL FR FC LFE BL BR SL SR FLC FRC BC` and FFmpeg's height and wide channels). The output layouts
are Web Audio's: 2 = `FL FR`; 6 = `FL FR FC LFE SL SR` (Web Audio's 5.1: its "SL SR" are the surrounds); 8 = WAVE
order `FL FR FC LFE BL BR SL SR` (Web Audio defines no 8-channel speaker layout, so it is discrete, and this is what
operating systems use for 7.1). `mixMatrix(source, output)` builds a gain matrix:

- A speaker the output has goes there at 1.
- Surrounds: 5.1 with back channels (`BL BR`, as FFmpeg names AC-3 and LPCM surrounds in some layouts) goes to the
  output's surround pair (`SL SR`) on 6 and 8; 7.1's backs fold into the surrounds at −3 dB on 6. `BC` splits −3 dB
  to the surround (or back) pair.
- Wide and front-centre pairs (`FLC FRC`, `WL WR`) fold −3 dB into front left/right and centre; heights fold −3 dB
  into the ear-level speaker below them; `LFE2` joins `LFE`.
- **Stereo** uses today's coefficients exactly: `FC` −3 dB to both, each surround and back −3 dB to its side, `BC`
  −6 dB to both, `LFE` dropped, mono to both at 1.
- One normaliser for all outputs: 1 / max(1, largest row sum), which is today's LPCM and shim rule for stereo and is 1
  (passthrough) whenever nothing folds.

`AudioWriter.enqueue` remixes a chunk whose channels differ from the ring's (cached matrix per source layout), so
decoders give their native layout and nothing else changes. `decodeLpcm` now returns the native layout (no fold); the
stereo result is the same numbers as before through the matrix. The `Decimator` filters any channel count. Opus (an
encode's) still gives stereo.

`PcmChunk` becomes `{ ptsUs, sampleRate, frames, channels: readonly Speaker[], samples }` (interleaved).

### Output (`controller/audio-output.ts`, ring, worklet)

- The ring carries N interleaved channels; `createRing(rate, seconds, channels = 2)` writes N into a new control slot
  (`Control.Channels`), and every view reads it. `renderQuantum(views, ...outputs)` fills each of the worklet's output
  channels; the worklet passes its output array without allocating.
- `AudioOutput` picks N when it makes the context (on the gesture that starts playback): 8 when
  `destination.maxChannelCount ≥ 8`, 6 when ≥ 6, else 2; the worklet node gets `outputChannelCount: [N]`, and the gain
  node and destination are set to N channels, `explicit`, `discrete`, so the browser passes them through without its
  own up- or downmix. Menu sounds (mono or stereo clips) are made stereo buffers, so they reach front left and right
  as before. N is fixed for the context's life: a device plugged in later is mixed by the browser and system.
  *(My call: fix N per page — replacing the ring under a playing engine is a rebuild of its audio path for a rare
  event; a reload picks the new device up, and it is listed in known issues.)*
- **Setting** "Audio output" (`AudioChannelsSetting`, `auto` | `stereo`, `localStorage` key
  `bluray-web:audio-channels`, default `auto`) in the player's Settings menu: `stereo` makes N 2 (and takes effect
  when the context is next made, that is after a reload; the menu says so). *(My call: Auto by default, as Video
  output and Deinterlacing are, with Stereo as the way out — a USB interface with eight outputs and two monitors
  plugged in, or a TV that reports eight channels and plays two, would otherwise lose the centre's dialogue; the help
  page says so.)* `?audiochannels=2|6|8` is test-only: the count is used as if the device offered it, capped by the
  device (so a test on a stereo machine can't ask for 8).

### What the user sees

- `Telemetry.audioCodec` becomes the decoding's description: the coding name, plus ", lossless" or ", Dolby Digital
  core" / ", DTS core" for TrueHD and DTS-HD, plus the decoded channel layout ("5.1", "7.1"). `Telemetry.audioOutput`
  (new) is `{ channels }` of the ring.
- The snapshot's `audioDecoding` (`'lossless' | 'core' | null`) marks the selected track in the Audio menu with a
  small "lossless" or "core" after its label.

## Constraints

- `audio.wasm` is rebuilt only with `npm run wasm:build:audio` (CI diffs it). The module grows by the `truehd` decoder
  (about 60 KB).
- Licensing: the shim stays LGPL-2.1-or-later with its stated reason; no new derived files (the channel map is
  original; the coefficients are the ones the shim and the LPCM port already use).
- The ring's header grows by one Int32 slot; its frames start 4 bytes later. Every thread builds views from the
  buffer, so nothing else assumes the offset.

## Testing

- Unit: the channel map (each source layout to 2, 6 and 8; the stereo fold equal to the old shim and LPCM values),
  the ring and worklet with 6 and 8 channels, the writer's remix, the decimator on 6 channels, the TrueHD and DTS-HD
  framers (cuts, carries, resync, padding), the factory's choice by profile, the fallbacks (failure, no output, slow
  with a fake clock), the output's channel choice with a fake `AudioContext`.
- Decoder against ffmpeg: committed TrueHD streams (stereo, 5.1 and 7.1, 48 kHz, and 5.1 at 96 kHz, made by ffmpeg's
  `truehd` encoder from a test tone) decode bit-exact against ffmpeg's `s32le` decode in the native order. ffmpeg
  can't encode DTS-HD, so the DTS-HD test reads FFmpeg's FATE samples (`master_audio_7.1_24bit.dts`,
  `xll_71_24_96_768.dts`, …) from `fixtures/local/fate/` when present (gitignored; the test names the rsync command)
  and compares with ffmpeg the same way; it skips otherwise.
- The cost per second of audio on this Mac (Node, the real module) is recorded in the report.
- E2E: disc3's TrueHD track plays in sync through the lossless path and its telemetry says lossless.
- What can't be tested tonight: hearing 5.1 and 7.1 on real speakers (order, levels, LFE), Safari's and Firefox's
  `maxChannelCount` on HDMI and USB devices, and a real disc's DTS-HD MA and TrueHD (BDJ_DISC_A and BDJ_DISC_B carry
  them). The owner's morning checks are in the night report.
