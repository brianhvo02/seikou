# Encoder (`seikou-encode`)

Cuts a decrypted Blu-ray playlist into episodes and encodes them to AV1 + Opus MKVs, streaming video and audio through pipes (VapourSynth, SVT-AV1, opusenc) instead of writing intermediate files.

## Requirements

- Node 22 or newer
- `brew install vapoursynth vapoursynth-bestsource svt-av1 opus-tools`

## Usage

Run from the repository root.

```sh
# List the playlists on a disc, or the chapters of one playlist
npm run seikou-encode -- plan encoder/fixtures/disc1
npm run seikou-encode -- plan encoder/fixtures/disc1 --playlist 00000

# Encode episodes (chapter ranges) from a playlist
npm run seikou-encode -- encode encoder/fixtures/disc1 --playlist 00000 --episodes "1-2,3-4" --out out

# Start the subtitle helper for a playlist and an episode list
npm run seikou-encode -- serve encoder/fixtures/disc1 --playlist 00000 --episodes "1-2,3-4"
```

`--episodes` is a comma-separated list of ascending, non-overlapping chapter ranges, one episode each. Options: `--name PATTERN` (default `episode-{n}`, `{n}` is the episode number padded to 2 digits), `--crf N` (25), `--preset N` (4), `--svt-args "..."` (extra SVT-AV1 arguments), `--opus-bitrate N` (160 for stereo, 320 otherwise), `--title T`, `--cache DIR` (where BestSource keeps its index files; default `bestsource/` in the data directory below).

Output layout:

```
out/
  episode-01.mkv
  episode-02.mkv
```

`serve` checks the episode list against the playlist, starts the helper on 127.0.0.1 and prints `Helper: http://127.0.0.1:<port>/?t=<token>`, the address of the page with this run's secret token. It opens that address in your browser (`open` on macOS, `xdg-open` elsewhere) unless `--no-open` is given, and runs until Ctrl-C. `--port N` picks the port (default: any free one). The helper needs the built page in `encoder/web/dist` (`npm run encoder:web:build`; `SEIKOU_ENCODE_WEB_DIR` points at another folder). Without `vspipe` the helper still starts, and says line-up is unavailable.

### Data directory

The encoder keeps what it learns and downloads in one directory: saved subtitle records (`subtitles/<disc key>/<playlist>.json`), fetched fansub tracks and fonts, and the BestSource index files (`bestsource/`, shared by `serve` and `encode` so an encode reuses the index the line-up built). It is `~/Library/Application Support/seikou-encode` on macOS and `$XDG_DATA_HOME/seikou-encode` (default `~/.local/share/seikou-encode`) elsewhere; `SEIKOU_ENCODE_DATA` names another.

### Offline mode

`SEIKOU_ENCODE_FIXTURE=<folder>` makes `serve` read SeaDex, Anime Tosho and AniList answers from recorded files in that folder (`seadex.json`, `tosho.json`, `anilist.json`, `files/`) instead of the network. It is for tests; `encoder/tests/fixtures/fansubs/` is an example with made-up titles.

Exit codes: 0 success, 1 encode failure, 2 usage error or bad episode spec, 3 required tools missing (for `serve`, the helper page not built).

## Where it sits in Seikou

The encoder is an application inside the Seikou repository, beside `server/` and `rendezvous/`. It reads discs through the `@seikou/bdmv` workspace package (MPLS, CLPI and the transport-stream demuxer), is type-checked by `tsconfig.encoder.json`, and its tests run as the `encoder` project of the root Vitest config. It has no `package.json` of its own; its tools (`tsx`, `vitest`, `typescript`) come from the root. Its history before the move is kept in the repository through `git subtree`.

## Reading the code

Each area of `encoder/src/` has a README with its concepts, its API and where to look:

- [`src/disc/`](src/disc/README.md): playlists, chapters and clip probes from a disc folder.
- [`src/plan/`](src/plan/README.md): chapter ranges to frame and sample cuts.
- [`src/pipeline/`](src/pipeline/README.md): VapourSynth scripts and the vspipe-to-encoder chains.
- [`src/mux/`](src/mux/README.md): IVF and Ogg Opus readers and the Matroska writer.
- [`src/audio/`](src/audio/README.md): an episode's audio as 16 kHz mono for subtitle alignment.

The test discs are described in [`fixtures/README.md`](fixtures/README.md).

Every export has a doc comment, and code that implements a format cites the specification section it follows; `npx vitest run --project encoder encoder/tests/docs.test.ts` checks the first rule and that no comment points at planning notes.

## Tests

```sh
npx vitest run --project encoder   # or npm test for the whole repository
```

Tests that need the encoders skip themselves when `vspipe`, `SvtAv1EncApp`, `opusenc` or the BestSource plugin are missing. Set `ENCODING_TOOLS_VSPIPE`, `ENCODING_TOOLS_SVT` or `ENCODING_TOOLS_OPUSENC` to point at binaries outside `PATH`.

## License

LGPL-3.0-or-later, like the rest of Seikou. See `LICENSE` and `COPYING` (GPL-3.0).
