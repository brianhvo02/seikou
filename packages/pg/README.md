# @seikou/pg

Presentation Graphics (PG), the Blu-ray bitmap subtitles, ported from libbluray: `PgSegmentDecoder` turns PG PES payloads into display sets, `PgRenderer` turns display sets into overlay operations at their presentation time, and `OverlayPlane` applies those operations to an RGBA surface that a canvas can draw. The renderer holds no player state, so its consumer provides it through `PgRendererDeps`: `displayFlag()` says whether subtitles are switched on (when false only forced objects are drawn), and `onOverlay(op)` receives each overlay operation.
