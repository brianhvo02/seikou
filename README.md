# encoding-tools

Cuts a decrypted Blu-ray playlist into episodes and encodes them to AV1 + Opus MKVs, streaming video and audio through pipes (VapourSynth, SVT-AV1, opusenc) instead of writing intermediate files.

## Requirements

- Node 22 or newer
- `brew install vapoursynth vapoursynth-bestsource svt-av1 opus-tools`

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
