# @seikou/pg

Presentation Graphics (PG) subtitle decoding and rendering for Blu-ray: a segment
decoder that turns PG PES payloads into display sets, a renderer that turns display sets
into overlay operations, and an `OverlayPlane` that applies them to an RGBA surface. The
renderer is told whether subtitles are switched on by a `displayFlag()` callback, so it
needs no register file.

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
