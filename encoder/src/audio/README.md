# audio/: an episode's audio for subtitle alignment

Fansub tracks are lined up with a disc by comparing where their dialogue falls with where the episode's audio holds speech (`alignAudio` in `@seikou/fansubs`). This area produces that audio: the episode's sound as 16 kHz mono 16-bit PCM, decoded by VapourSynth and BestSource as the encode decodes it, with no ffmpeg.

## Concepts

- **Decoded once per episode.** Alignment listens to an episode several times: a coarse pass over all of it, then finer passes over a few windows. Decoding it once and keeping it in memory (about 1.9 MB a minute at 16 kHz mono) is cheaper than running vspipe per window, and BestSource's index, built on the first run, is reused by the encode.
- **The encode's audio.** `buildSpeechAudioScript` gives the same cuts, joins and silence padding as the encode's audio script (see `pipeline/`), so sample 0 is the episode's first video frame and a subtitle timed against this audio is timed against the encoded file.
- **Why 16 kHz mono.** The speech detector in `@seikou/fansubs` works on 16 kHz mono; speech is a band below about 4 kHz, so nothing it needs is lost, and the channels are averaged because dialogue sits in the centre or in both front channels.
- **Downsampling.** VapourSynth has no audio resampler, so vspipe writes the source rate and format (float32 for AC-3, integers for LPCM) and `Downsampler16k` converts: average the channels, low-pass at 7 kHz with a windowed-sinc FIR (Hamming window, 32 taps per unit of decimation factor, at least 65), keep every `rate / 16000`-th sample. The filter is centred, so output sample n is input frame `n × factor` with no delay. Disc audio is 48, 96 or 192 kHz, all whole multiples of 16 kHz, so no fractional resampling is needed; any other rate is refused with a `RangeError`. The filter design follows Smith, "The Scientist and Engineer's Guide to Digital Signal Processing", chapter 16.
- **WAV.** vspipe writes `WAVE_FORMAT_EXTENSIBLE` with an IEEE-float or PCM subformat; a streamed WAV may carry a `data` size of 0 or `0xFFFFFFFF`, read to the end of the stream. `readWav` follows Microsoft's RIFF and WAVEFORMATEX/WAVEFORMATEXTENSIBLE documentation; the field layout is in the comment at the top of `wav.ts`.

## API

- `decodeEpisodeAudio16k(plan, { vspipe }, cacheDir, signal?)` returns the episode as an `Int16Array` at 16 kHz. The script lives in a temporary folder removed afterwards; a vspipe failure rejects with a `ChainError` carrying its stderr tail; a decode shorter than the planned audio by more than one video frame (a WAV size cut short) rejects naming both lengths; an abort stops vspipe and rejects with the signal's reason. Output vspipe writes past the WAV's declared size is drained, so vspipe never blocks on a full pipe.
- `episodeReader(pcm16k)` returns a `PlaylistAudioReader` for `alignAudio`: `'whole'` gives the PCM from 0 ms, spans give one window from the first span's start to the last span's end, zero outside the spans.
- `new EpisodeAudioCache<K = number>(load, keep = 2)`, then `get(key, signal?)`: keeps the last `keep` decoded episodes (named by a key: the episode number, or the helper backend's session and episode), runs one `load` at a time, shares a running decode between requests for the same episode, and aborts a decode only when every request waiting on it has aborted.
- `readWav(stream)` returns `{ format, frames }`, `frames` being planar `Float32Array` chunks in [-1, 1). `parseWavHeader(bytes)` is its header reader on a byte prefix: the format, block size, where the samples start and the data size (null when streamed), or null while the prefix is too short; the encode's WAV guard (`pipeline/wav-guard.ts`) uses it.
- `new Downsampler16k(sourceRate)`, then `push(planar)` and one `flush()`, each returning the 16 kHz samples completed.

## Where to look

- `episode-audio-cache.ts`: the decodes kept between line-ups.
- `episode-audio.ts`: the vspipe run, its failure ordering (vspipe's own error wins over a reader error it caused), and the span slicing.
- `downsample.ts`: the filter and the streaming decimator.
- `wav.ts`: the RIFF reader.
- Tests: `encoder/tests/audio/`. The decode test runs on `encoder/fixtures/disc-speech` (noise bursts at known times, see `tests/helpers/speech-bursts.ts` at the repository root) and skips when vspipe or BestSource is missing.
