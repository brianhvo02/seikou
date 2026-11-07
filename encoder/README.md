# encoding-tools

Cuts a decrypted Blu-ray playlist into episodes and encodes them to AV1 + Opus MKVs, streaming video and audio through pipes (VapourSynth, SVT-AV1, opusenc) instead of writing intermediate files.

## Requirements

- Node 22 or newer
- `brew install vapoursynth vapoursynth-bestsource svt-av1 opus-tools`

## Usage

```sh
# List the playlists on a disc, or the chapters of one playlist
npm run cli -- plan fixtures/disc1
npm run cli -- plan fixtures/disc1 --playlist 00000

# Encode episodes (chapter ranges) from a playlist
npm run cli -- encode fixtures/disc1 --playlist 00000 --episodes "1-2,3-4" --out out
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

## Temporary Seikou alias

The Blu-ray parsers (MPLS, CLPI and friends) live in the sibling project Seikou and are imported as `seikou/engine/*`. Until they are published as a package, the alias resolves through a symlink at `vendor/seikou`, which is git-ignored. On a new machine, create it yourself:

```sh
ln -s /path/to/seikou vendor/seikou
```

The alias is declared in `tsconfig.json` (`paths`) and `vitest.config.ts` (`resolve.alias`).

## Tests

```sh
npm test
```

Tests that need the encoders skip themselves when `vspipe`, `SvtAv1EncApp`, `opusenc` or the BestSource plugin are missing. Set `ENCODING_TOOLS_VSPIPE`, `ENCODING_TOOLS_SVT` or `ENCODING_TOOLS_OPUSENC` to point at binaries outside `PATH`.

## License

LGPL-3.0-or-later. See `LICENSE` and `COPYING` (GPL-3.0).
