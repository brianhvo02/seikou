# pipeline/: VapourSynth scripts and tool chains

The encoder never decodes or encodes in-process. It writes a small VapourSynth script for each stream, runs `vspipe` on it and pipes the output into the encoder program, so no intermediate file is written. This area builds the scripts and runs the two-process chains.

## Concepts

- **Script.** A `.vpy` file (Python). For each segment of an episode it opens the clip with the BestSource plugin, cuts the planned frame or sample range and joins the cuts. Paths are embedded as Python raw strings, so a path with a single quote is refused rather than escaped.
- **BestSource.** It decodes frame-accurately by first indexing the file (see its README, https://github.com/vapoursynth/bestsource). The arguments used here: `cachemode=4` keeps the index under `cachepath` and reuses it on later runs; `cachepath` is a file prefix, not a directory, so each clip gets its own prefix; `adjustdelay=-1` pads or trims audio so sample 0 is the first video frame; `track=-1` picks the first audio stream, because choosing a stream by PID would need a PID-to-track mapping BestSource does not provide.
- **Checks in the script.** VapourSynth clamps slices silently, so a clip shorter than planned would shorten the episode and shift every later chapter. The video script raises when a clip has too few frames. The audio script instead pads with silence when the audio ends a little before the video (audio that started before the video was trimmed at the front).
- **Chain.** `vspipe script.vpy - -c y4m | SvtAv1EncApp ...` for video and `vspipe script.vpy - -c wav | opusenc ...` for audio. The last process's stdout is the result: an IVF stream of AV1 packets, or an Ogg Opus stream. A failure in either process kills the other and rejects `done` with a `ChainError` that carries the tool's last stderr output.

## API

- `buildVideoScript(plan, { cacheDir })` and `buildAudioScript(plan, { cacheDir })` return script text. `buildSpeechAudioScript` returns the audio script that subtitle alignment decodes (see `audio/`): today the same as `buildAudioScript`, kept separate so a conversion added to the encode's audio does not change what alignment hears.
- `videoChain(tools, scriptPath, svtArgs)` and `audioChain(tools, scriptPath, opusArgs)` return a `Chain`: `stream` (read it), `done` (await it for the outcome), `abort(reason)`.
- `ToolPaths` names the three programs; `ChainError` is the failure type.

## Where to look

- `vpy.ts`: script text and the BestSource arguments.
- `chain.ts`: process wiring, stderr capture, failure ordering. A consumer must drain `stream` or `done` cannot settle.
- Tests: `encoder/tests/pipeline/`; those that run the real tools skip when `vspipe`, BestSource, SvtAv1EncApp or opusenc are missing.
