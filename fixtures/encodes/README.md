# Encoded-episode fixtures

Two short episodes in the shape the Seikou encoder writes, for the NAS server's encodes index, the engine's Matroska playback and the end-to-end check. `npm run fixture:encodes` (`scripts/make-encode-fixture.ts`) rebuilds them and the output is committed. It needs VapourSynth with BestSource, SvtAv1EncApp and opusenc.

The video and audio are cut from `encoder/fixtures/disc-speech` (episodes `1-2,3-4` of playlist `00000`, so each starts at a chapter and lasts 60 s) with a fast, small encode (preset 10, CRF 40, film grain 0, capped at 10 kb/s, Opus at 24 kb/s, so the files stay small). The files are then rewritten through `@seikou/matroska` with no re-encode, to set what the encoder does not write yet: chapter names, tags, the ASS track with its font and the PGS track. Everything named here is made up. `packages/matroska/src/fixtures-encodes.test.ts` checks the facts below.

Files: `990001/1.mkv` and `990001/2.mkv`, about 1.15 MB each (the font attachment is 340,712 bytes of that).

## Both files

- Tracks, in order (track numbers 1 to 4):
  1. `V_AV1`, 640x360 (the size of the `disc-speech` video it is cut from), no name, `und`, default
  2. `A_OPUS`, stereo 48 kHz, name `Japanese`, language `jpn`, default
  3. `S_TEXT/ASS`, name `English`, language `eng`, default
  4. `S_HDMV/PGS`, name `English (disc)`, language `eng`, not default
- Chapters (start in ms, name): 0 `Avant`, 10000 `Opening`, 20000 `Part A`, 40000 `Ending`, 50000 `Preview`; each ends where the next starts and the last at the file's duration.
- Attachment: `DejaVuSansMono.ttf` (`font/ttf`), which the ASS style `Default` uses (family `DejaVu Sans Mono`).
- ASS events (episode time, text): 1.00 to 3.00 `Episode N begins`; 12.00 to 14.00 `The opening line`; 19.00 to 23.00 `A line across the twenty second mark` (on screen from 19 s to 23 s, so across 20 s and 22 s); 41.00 to 44.00 `The ending line`; 55.00 to 58.00 `Next time`.
- PGS display sets, at 5000, 7000, 8000, 10000, 12000 and 14000 ms: the English PG stream (PID 0x1200) of `fixtures/synthetic/disc-subs`, three captions each shown and cleared, the first at 5 s.
- Tags (segment level): `ANILIST_ID` `990001`, `SEIKOU_DISC_KEY` `f.148C2FD8E35B72A696EB6FB331CB0AE7` (the key of `encoder/fixtures/disc-speech`), `SEIKOU_PLAYLIST` `00000`, `ENCODER` `seikou-encode`.

## Per file

| File | `EPISODE` | `EPISODE_TITLE` | `SEIKOU_EPISODE_START_MS` | Title | Duration |
| --- | --- | --- | --- | --- | --- |
| `990001/1.mkv` | `1` | `The Lantern Road` | `0` | `The Lantern Road` | 60018.7 ms |
| `990001/2.mkv` | `2` | `A Quiet Harbor` | `60000` | `A Quiet Harbor` | 60000 ms |

The AniList entries `990001` (Lantern Road) and its sequel `990002` are in `tests/e2e/fixtures/nas-metadata.json`.

## Font licence

`DejaVuSansMono.ttf` is copied from `fixtures/ass/fonts/` and is DejaVu Fonts, (c) Bitstream, Inc. (Bitstream Vera) with DejaVu's changes in the public domain, under the permissive Bitstream Vera licence: the fonts may be used, copied and distributed, including with software, provided the copyright and permission notice travels with them and the fonts are not sold alone. The full text is `fixtures/ass/fonts/LICENSE-DejaVu.txt`.
