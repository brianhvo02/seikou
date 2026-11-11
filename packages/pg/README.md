# @seikou/pg

Presentation Graphics (PG), the Blu-ray bitmap subtitles, ported from libbluray. The package decodes PG streams into display sets, renders them at their presentation time as overlay operations, and applies those operations to an RGBA surface a canvas can draw.

The reference, with an example for every function, is at [/developers/pg](https://bluray.pages.dev/developers/pg).

## Modules

All of it lives in `src/`. The package root exports the names listed in `public-api.txt`; every module can also be imported by path (`@seikou/pg/<module>`), and what the root leaves out is internal and can change without notice.

| Module | What it does |
| --- | --- |
| `pg-decoder.ts` (`PgSegmentDecoder`) | Turns PG PES payloads into display sets. |
| `segments.ts` | Segment types and parsing, and the internal `SegmentJoiner`, which joins segments split across packets. |
| `rle.ts` | Internal: run-length decoding and cropping of object bitmaps. |
| `palette.ts` | Internal: converts YCrCb palette entries to RGBA. |
| `pg-renderer.ts` (`PgRenderer`) | Turns display sets into overlay operations at their presentation time. |
| `composition.ts` | Internal: renders one composition object. |
| `overlay-plane.ts` (`OverlayPlane`) | Applies overlay operations to an RGBA surface. |

## What a consumer must provide

The renderer holds no player state, so the consumer supplies it through `PgRendererDeps`:

- `displayFlag()` says whether subtitles are switched on. When it returns false, only forced objects are drawn.
- `onOverlay(op)` receives each overlay operation, usually to pass to an `OverlayPlane`.

The consumer also feeds the decoder the PES packets of one PG stream, which it gets from the `@seikou/bdmv` demuxer (the package's only dependency).

## Usage

```ts
import { OverlayPlane, PgRenderer, PgSegmentDecoder } from '@seikou/pg';

const decoder = new PgSegmentDecoder();
const plane = new OverlayPlane(1920, 1080);
const renderer = new PgRenderer({
  displayFlag: () => true, // false draws only forced objects
  onOverlay: (op) => plane.apply(op),
});

// For each PG PES packet of the stream:
const set = decoder.push(pes.payload, pes.pts, pes.dts ?? null);
if (set) renderer.render(set);

// Draw a region of the plane on a canvas:
const rect = { x: 0, y: 800, w: 1920, h: 280 };
ctx.putImageData(new ImageData(plane.rgba(rect), rect.w, rect.h), rect.x, rect.y);
```

## Documentation

- Using the packages in your own page or tool: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- The design is in `docs/superpowers/specs/2026-10-15-m4a-pgs-srt-design.md` (in the Seikou repository).
- `NOTICE` lists each file derived from [libbluray](https://www.videolan.org/developers/libbluray.html). `overlay-plane.ts` and `palette.ts` are original and follow the overlay command semantics of libbluray's `overlay.h`.
