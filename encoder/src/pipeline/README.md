# pipeline/: VapourSynth scripts and tool chains

The encoder never decodes or encodes in-process. It writes a small VapourSynth script for each stream, runs `vspipe` on it and pipes the output into the encoder program, so no intermediate file is written. This area builds the scripts, runs the two-process chains (one for the video and one per audio stream) and checks each decoded audio stream on its way to opusenc.

## Uses

`plan/` (episode plans), `disc/` (stream codes) and `audio/` (the WAV header reader).

## Concepts

- Script. A `.vpy` file (Python). For each segment of an episode it opens the clip with the BestSource plugin, cuts the planned frame or sample range and joins the cuts. Paths are embedded as Python raw strings, so a path with a single quote is refused rather than escaped.
- BestSource. It decodes frame-accurately by first indexing the file (see its README, https://github.com/vapoursynth/bestsource). The arguments used here: `cachemode=4` keeps the index under `cachepath` and reuses it on later runs; `cachepath` is a file prefix, not a directory, so each clip gets its own prefix; `adjustdelay=-1` pads or trims audio so sample 0 is the first video frame; `track=-n` picks the n-th audio stream libavformat finds in the clip; the planner works out `n` for each stream and clip from the clip's PMT (`bsTrack`, see `plan/` and `disc/pmt.ts`), and each audio script uses its own stream's `n` clip by clip.
- Checks in the script. VapourSynth clamps slices silently, so a clip shorter than planned would shorten the episode and shift every later chapter. The video script raises when a clip has too few frames. The audio script instead pads with silence when the audio ends a little before the video (audio that started before the video was trimmed at the front).
- Chain. `vspipe script.vpy - -c y4m | SvtAv1EncApp ...` for video and `vspipe script.vpy - -c wav | guardWav | opusenc ...` for each audio stream. The last process's stdout is the result: an IVF stream of AV1 packets, or an Ogg Opus stream. A failure in either process kills the other and rejects `done` with a `ChainError` that carries the tool's last stderr output.
- One chain per audio stream. The Matroska writer pulls packets from every track in timestamp order. Were one vspipe to feed several opusencs, it would block on whichever pipe the writer is not draining and stall the rest, so each stream gets its own vspipe and opusenc, and `encode` starts every chain before reading any. When one chain fails, `encode` stops the others.
- The WAV guard. BestSource picks an audio stream by position, and nothing in its output says which stream it decoded. `guardWav` reads the WAV header vspipe writes (with `parseWavHeader` from `audio/wav.ts`) and compares its channel count and sample rate with what the playlist's stream table says about the stream the script was meant to decode; a mismatch errors the stream with, for example, `PID 0x1101: BestSource gave 2 channels at 48000 Hz; the disc says 6 channels at 48000 Hz`, and the chain stops before opusenc encodes anything. The table's multi-channel code covers 5.1 and 7.1 alike, so an expectation above two channels accepts any count above two. The bytes pass through unchanged.

## API

- `buildVideoScript(plan, { cacheDir })` and `buildAudioScript(plan, { cacheDir }, trackIndex)` return script text; `trackIndex` is the 0-based position of the stream among those the plan was made with. `buildSpeechAudioScript(plan, { cacheDir })` returns the audio script that subtitle alignment decodes (see `audio/`): today `buildAudioScript` of the first planned stream (the helper plans only the playlist's first STN audio stream), kept separate so a conversion added to the encode's audio does not change what alignment hears.
- `videoChain(tools, scriptPath, svtArgs)` and `audioChain(tools, scriptPath, opusArgs, expected)` return a `Chain`: `stream` (read it), `done` (await it for the outcome), `abort(reason)`, `exited` (resolves once both processes have exited; a process that ignores SIGTERM is killed after 5 s). `expected` (`WavExpectation`: PID, channels, sample rate; a `SelectedAudio` will do) is what the audio chain's guard checks.
- `guardWav(stream, expected)` returns the guarded pass-through; its failure is a `WavGuardError`.
- `ToolPaths` names the three programs; `ChainError` is the failure type.

## Files

- `vpy.ts`: script text and the BestSource arguments.
- `chain.ts`: process wiring, stderr capture, failure ordering. A consumer must drain `stream` or `done` cannot settle.
- `wav-guard.ts`: the header check between vspipe and opusenc.
- Tests: `encoder/tests/pipeline/`; those that run the real tools skip when `vspipe`, BestSource, SvtAv1EncApp or opusenc are missing.

## Documentation

- [Encoding tools design (spec)](../../docs/superpowers/specs/2026-11-06-encoding-tools-design.md)
- [M1 pipeline prototype (plan)](../../docs/superpowers/plans/2026-11-06-m1-pipeline-prototype.md)
- [VapourSynth documentation](https://www.vapoursynth.com/doc/)
- [BestSource](https://github.com/vapoursynth/bestsource)
- [SVT-AV1](https://gitlab.com/AOMediaCodec/SVT-AV1)
- [opusenc](https://opus-codec.org/docs/opus-tools/opusenc.html)
