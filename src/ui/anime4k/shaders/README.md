# Anime4K shaders

The shader files the built-in Anime4K modes use (every file `../input-hq.conf` and `../input-fast.conf` name), copied
byte for byte from https://github.com/bloc97/Anime4K at release tag `v4.0.1`, commit
4029bf701ecaa15f163cdc49cffe5501c1acf410. They are identical to the files at commit
7684e9586f8dcc738af08a1cdceb024cc184f426, which the two `.conf` files come from. MIT License, © 2019 bloc97; see
`../LICENSE`.

The app loads a file only when a mode that uses it is picked, and the service worker keeps it for offline use
(`src/ui/bundled-shaders.ts`, `src/sw.ts`). A shader file the player imports with the same name is used instead.

| File | Source path |
| --- | --- |
| `Anime4K_AutoDownscalePre_x2.glsl` | `glsl/Upscale/Anime4K_AutoDownscalePre_x2.glsl` |
| `Anime4K_AutoDownscalePre_x4.glsl` | `glsl/Upscale/Anime4K_AutoDownscalePre_x4.glsl` |
| `Anime4K_Clamp_Highlights.glsl` | `glsl/Restore/Anime4K_Clamp_Highlights.glsl` |
| `Anime4K_Restore_CNN_M.glsl` | `glsl/Restore/Anime4K_Restore_CNN_M.glsl` |
| `Anime4K_Restore_CNN_S.glsl` | `glsl/Restore/Anime4K_Restore_CNN_S.glsl` |
| `Anime4K_Restore_CNN_Soft_M.glsl` | `glsl/Restore/Anime4K_Restore_CNN_Soft_M.glsl` |
| `Anime4K_Restore_CNN_Soft_S.glsl` | `glsl/Restore/Anime4K_Restore_CNN_Soft_S.glsl` |
| `Anime4K_Restore_CNN_Soft_VL.glsl` | `glsl/Restore/Anime4K_Restore_CNN_Soft_VL.glsl` |
| `Anime4K_Restore_CNN_VL.glsl` | `glsl/Restore/Anime4K_Restore_CNN_VL.glsl` |
| `Anime4K_Upscale_CNN_x2_M.glsl` | `glsl/Upscale/Anime4K_Upscale_CNN_x2_M.glsl` |
| `Anime4K_Upscale_CNN_x2_S.glsl` | `glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl` |
| `Anime4K_Upscale_CNN_x2_VL.glsl` | `glsl/Upscale/Anime4K_Upscale_CNN_x2_VL.glsl` |
| `Anime4K_Upscale_Denoise_CNN_x2_M.glsl` | `glsl/Upscale+Denoise/Anime4K_Upscale_Denoise_CNN_x2_M.glsl` |
| `Anime4K_Upscale_Denoise_CNN_x2_VL.glsl` | `glsl/Upscale+Denoise/Anime4K_Upscale_Denoise_CNN_x2_VL.glsl` |

## Documentation

- The shader feature as a whole (parsing mpv user shaders, planning passes, running them on WebGL2): `docs/superpowers/specs/2026-10-15-video-shaders-design.md` and `packages/engine/src/shaders/`.
- The templates that name these files, and the licence: `../README.md`, `../input-hq.conf`, `../input-fast.conf`, `../LICENSE`.
- Anime4K upstream: https://github.com/bloc97/Anime4K
