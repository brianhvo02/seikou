# Lossless and multichannel audio: plan

Spec: `docs/superpowers/specs/2026-11-24-lossless-audio-design.md`. TDD, a commit per task.

1. **Channel map** — `packages/engine/src/audio/channel-map.ts` (`Speaker`, `outputLayout(n)`, `mixMatrix`, `remix`),
   `channel-map.test.ts`. `PcmChunk` gets `channels` and `samples` (`decode/lpcm.ts`); `decodeLpcm` returns its native
   layout; callers and tests renamed (`decimator.ts` N channels, `opus-decoder.ts` stereo layout,
   `audio-decoder.ts`).
2. **Ring and worklet with N channels** — `audio/ring.ts` (`Control.Channels`, `createRing(..., channels)`,
   `renderQuantum(views, ...outputs)`, `renderChannels`), `controller/pcm-worklet.ts`, `audio/audio-writer.ts` (remix
   to the ring's layout), tests.
3. **Shim and module** — `wasm/audio/shim.c`, `build.sh` (`truehd`), `npm run wasm:build:audio`;
   `decode/wasm-audio.ts` (`audio_open(codec, outChannels)`, `audio_channels`, `audio_channel`, `WasmCodec.DTS_FULL`,
   `TRUEHD`), `wasm-audio.test.ts`.
4. **Framers** — `decode/audio-frames.ts` kinds `truehd` and `dtshd`, `resync()`; tests.
5. **Factory and fallback** — `decode/audio-decoder.ts` (`AudioDecoderOptions`, `LosslessDecoder`, `describe()`),
   `memory-profile.ts` (`losslessAudio`), `player.ts` (passes options, telemetry `audioCodec` from the decoder's
   description, `audioOutput`), `protocol.ts`; tests.
6. **Fixtures and bit-exact tests** — `scripts/make-audio-fixtures.ts` (TrueHD stereo/5.1/7.1/96k streams),
   `decode/lossless.test.ts` against ffmpeg's decode (ffmpeg-produced reference PCM committed beside them as
   `.s32` files so the test needs no ffmpeg), DTS-HD from `fixtures/local/fate/` when present; cost measurement.
7. **Output channels and setting** — `controller/audio-output.ts` (choose N, discrete routing, stereo effect
   buffers, `channels` option), `src/ui` setting (`audio-channels.ts`, Settings menu entry), `?audiochannels=`; tests.
8. **What the user sees** — snapshot `audioDecoding`, Audio menu mark; tests.
9. **Docs and checks** — CLAUDE.md, known-issues, roadmap, `docs/playing-discs.md`/`troubleshooting.md`, NOTICE if
   needed; `tsc -b`, `devsite:model`, `npm test`, build, audio and playback E2E.
