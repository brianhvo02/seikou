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
```

`--episodes` is a comma-separated list of ascending, non-overlapping chapter ranges, one episode each. Options: `--name PATTERN` (default `episode-{n}`, `{n}` is the episode number padded to 2 digits), `--crf N` (25), `--preset N` (4), `--svt-args "..."` (extra SVT-AV1 arguments), `--opus-bitrate N` (160 for stereo, 320 otherwise), `--title T`.

Output layout:

```
out/
  episode-01.mkv
  episode-02.mkv
  .cache/bestsource/   # BestSource index files, reused on later runs
```

Exit codes: 0 success, 1 encode failure, 2 usage error or bad episode spec, 3 required tools missing.

## Where it sits in Seikou

The encoder is an application inside the Seikou repository, beside `server/` and `rendezvous/`. It reads discs through the `@seikou/bdmv` workspace package (MPLS, CLPI and the transport-stream demuxer), is type-checked by `tsconfig.encoder.json`, and its tests run as the `encoder` project of the root Vitest config. It has no `package.json` of its own; its tools (`tsx`, `vitest`, `typescript`) come from the root. Its history before the move is kept in the repository through `git subtree`.

## Reading the code

Each area of `encoder/src/` has a README with its concepts, its API and where to look:

- [`src/disc/`](src/disc/README.md): playlists, chapters and clip probes from a disc folder.
- [`src/plan/`](src/plan/README.md): chapter ranges to frame and sample cuts.
- [`src/pipeline/`](src/pipeline/README.md): VapourSynth scripts and the vspipe-to-encoder chains.
- [`src/mux/`](src/mux/README.md): IVF and Ogg Opus readers and the Matroska writer.

Every export has a doc comment, and code that implements a format cites the specification section it follows; `npx vitest run --project encoder encoder/tests/docs.test.ts` checks the first rule and that no comment points at planning notes.

## Tests

```sh
npx vitest run --project encoder   # or npm test for the whole repository
```

Tests that need the encoders skip themselves when `vspipe`, `SvtAv1EncApp`, `opusenc` or the BestSource plugin are missing. Set `ENCODING_TOOLS_VSPIPE`, `ENCODING_TOOLS_SVT` or `ENCODING_TOOLS_OPUSENC` to point at binaries outside `PATH`.

## License

LGPL-3.0-or-later, like the rest of Seikou. See `LICENSE` and `COPYING` (GPL-3.0).
