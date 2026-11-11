# @seikou/ass

An ASS/SSA subtitle renderer ported from libass 0.17.5. It parses a script, matches fonts, lays out each frame's events and draws them with Canvas2D, in a page or a worker.

## Modules

The port follows libass function by function; each file's header lists the functions it covers. The package root exports the names listed in `public-api.txt`; every module can also be imported by path (`@seikou/ass/<module>`), and what the root leaves out is internal and can change without notice.

| Module | What it does |
| --- | --- |
| `parse.ts` (`parseAss`, `parseAssCodecPrivate`, `parseChunkEvent`) | Reads a script, its `[Fonts]` section included, or an ASS track from Matroska: the track's CodecPrivate as a script header and each block as one event. |
| `types.ts`, `cstr.ts`, `host-types.ts` | Script types, C string helpers, and the types shared with the host (rectangles, memory limits, the text renderer contract). |
| `fonts.ts` (`AssFonts`), `font-tables.ts` (`readFontFile`) | Font matching and fallback from the sfnt tables, with faces registered as `FontFace`s. |
| `device-fonts.ts` (`createDeviceFontSource`) | An addition to the port: looks up a family nothing supplied among the device's installed fonts through CSS `local()`. |
| `tags.ts`, `state.ts`, `events.ts` | Override tags and `\t` animation, the render state, and an event's text split into glyph records and style runs, with karaoke timing. |
| `layout.ts`, `measure.ts` (`createCanvasMeasurer`), `gsub.ts` | Wrapping and alignment, with advances from the browser's `measureText` and the ligature lookups HarfBuzz applies by default. |
| `drawing.ts`, `transform.ts`, `warp.ts` | Vector drawings, transform matrices, and drawing a canvas through a projective matrix. |
| `collisions.ts`, `frame.ts` | Event collision handling and one frame's events and matrices. |
| `raster.ts`, `renderer.ts` (`AssRenderer`) | Drawing runs (supersampled glyph masks, libass's blur and compositing, mask and layer caches) and the renderer that caches static events. |
| `trace.ts`, `trace-format.ts` | A frame's layout in the libass trace format, used by the comparison tests. |
| `default-font.ttf` | DejaVu Sans, the fallback face when a script's fonts are missing, exported as `@seikou/ass/default-font.ttf` (licence in `LICENSE-DejaVu.txt`). |

## What a consumer must provide

Through `AssRendererDeps`:

- a canvas factory,
- a glyph measurer (`createCanvasMeasurer` makes one),
- a clock, and
- the memory limits the caches keep to.

The consumer also registers the fonts it has with `AssFonts`.

A host can pass `AssFonts` a `deviceFonts` source. A family no supplied face matches is then looked up among the fonts installed on the device, with its metrics measured by the browser, before the default font is used. This is an addition to the port (libass would ask its system font provider), so lines in a device font can lay out slightly differently from libass. Without the option the renderer uses only supplied faces, as the libass comparison needs.

## Usage

```ts
import { parseAss } from '@seikou/ass';

const script = parseAss(await file.text()); // a .ass or .ssa file's text
console.log(script.playResX, script.playResY, script.styles.map((s) => s.name), script.fonts.map((f) => f.name));
for (const event of script.events) console.log(event.start, event.duration, event.text); // times in milliseconds
```

Drawing the events takes an `AssRenderer` with the `AssRendererDeps` above. Seikou's engine builds them in its worker (`startEngineWorker` in `packages/engine/src/worker-main.ts`), which is the place to start from.

## Documentation

- Using the packages in your own page or tool: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- The design is in `docs/superpowers/specs/2026-10-15-m4b-ass-renderer-design.md` (in the Seikou repository).
- `NOTICE` lists each derived file. The port is compared with a patched libass in `tests/ass-trace/` and `tools/ass-trace/` in the repository; a difference there is a porting bug.
- Upstream: [libass](https://github.com/libass/libass) (ISC licence).
