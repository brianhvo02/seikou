# Encoder test fixtures

- `disc1/`: a copy of `fixtures/synthetic/disc1` (two 4 s H.264 clips, LPCM stereo, chapters every 2 s).
- `disc1-late/`: `disc1` with every audio timestamp 20 ms later, so the audio starts after the video (`encoder/scripts/make-late-audio-disc.ts`).
- `disc-speech/`: a copy of `fixtures/synthetic/disc-speech` (`scripts/make-speech-disc.ts`: 150 s over two clips split at 90 s, AC-3 stereo 48 kHz with noise bursts at the times in `tests/helpers/speech-bursts.ts`, chapters every 30 s), for the alignment audio.
- `small.ivf`, `tone.opus`: written by `encoder/scripts/make-av1-fixture.ts` and `make-opus-fixture.ts`.

The synthetic discs carry no PAT or PMT, so libavformat (inside BestSource) would guess their stream types. The copies here are patched with `npx tsx encoder/scripts/patch-fixture-pmt.ts <disc folder>` (default `encoder/fixtures/disc1`), which writes a PAT and a Blu-ray PMT built from each clip's CLPI over two null packets, keeping every size and packet number. To refresh a copy, copy the synthetic disc again and rerun the script on it.
