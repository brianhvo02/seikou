# @seikou/pg

Presentation Graphics (PG), the Blu-ray bitmap subtitles, ported from libbluray: `PgSegmentDecoder` turns PG PES payloads into display sets, `PgRenderer` turns display sets into overlay operations at their presentation time, and `OverlayPlane` applies those operations to an RGBA surface that a canvas can draw. The renderer holds no player state, so its consumer provides it through `PgRendererDeps`: `displayFlag()` says whether subtitles are switched on (when false only forced objects are drawn), and `onOverlay(op)` receives each overlay operation.

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
