# Encoder test fixtures

- `disc1/`: a copy of `fixtures/synthetic/disc1` (two 4 s H.264 clips, LPCM stereo, chapters every 2 s).
- `disc1-late/`: `disc1` with every audio timestamp 20 ms later, so the audio starts after the video (`encoder/scripts/make-late-audio-disc.ts`).
- `disc-speech/`: the speech disc of `scripts/make-speech-disc.ts` (150 s over two clips split at 90 s, AC-3 stereo 48 kHz with noise bursts at the times in `tests/helpers/speech-bursts.ts`, chapters every 30 s), for the alignment audio and the helper page's preview. Unlike `fixtures/synthetic/disc-speech` (64x36 video, which Chrome refuses to decode) its picture is 640x360, about 8 MB in all. The script only writes inside the repo's `fixtures/`, so make it with a scratch folder there (gitignored) and move it in:
  ```
  npx tsx scripts/make-speech-disc.ts fixtures/local/speech-640 --video-size 640x360
  rm -rf encoder/fixtures/disc-speech && mv fixtures/local/speech-640 encoder/fixtures/disc-speech && npx tsx encoder/scripts/patch-fixture-pmt.ts encoder/fixtures/disc-speech
  ```
  The patch step needs two null packets at the end of each clip, which the muxer's padding gives only by chance; a different x264 build can make it fail with a clear error, and changing `-crf` in the script moves the padding.
- `disc3/`: a copy of `fixtures/synthetic/disc3` (one 12 s H.264 clip with four audio streams: LPCM `jpn` 0x1100, AC-3 `eng` 0x1101, TrueHD `eng` 0x1102, DTS `fra` 0x1103), for choosing audio streams by PID. libavformat finds five audio streams in it: the TrueHD stream carries an AC-3 version that it lists as its own stream, so the DTS stream is BestSource's track 5.
- `disc-subs/`: a copy of `fixtures/synthetic/disc-subs` (one clip, LPCM `eng` audio and two PG streams, `eng` 0x1200 and `jpn` 0x1201).
- `small.ivf`, `tone.opus`: written by `encoder/scripts/make-av1-fixture.ts` and `make-opus-fixture.ts`.

The synthetic discs carry no PAT or PMT, so libavformat (inside BestSource) would guess their stream types and number their audio streams in the order it meets them, and the encoder, which reads the PMT from a clip's first 1,000 packets, would refuse them. Every disc here is patched with `npx tsx encoder/scripts/patch-fixture-pmt.ts <disc folder>` (default `encoder/fixtures/disc1`), which puts a PAT and a Blu-ray PMT built from each clip's CLPI in the clip's first packets and removes as many null packets from further on: the file size stays the same, the packets before the removed ones move two places later, and the CLPI's EP map is rewritten to match (the script checks that every entry still points at its packet). It needs two null packets in each clip and fails with a clear error otherwise. To refresh a copy, copy the synthetic disc again and rerun the script on it; a clip that already starts with a PAT is left alone, and one patched by the script's earlier version (which wrote the tables over two null packets near the end) has those packets moved to the front.
