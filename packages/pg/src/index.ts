// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/pg: PG subtitles, decoded and rendered. Everything else is internal, reached through ./*.

// Turning PG PES payloads into display sets.
export { PgSegmentDecoder, type PgDisplaySet, type PgComposition } from './pg-decoder';
// The segment contents a display set holds.
export type {
  PgWindow,
  PgPalette,
  PgPaletteEntry,
  PgObject,
  RleElem,
  PgVideoDescriptor,
  PgCompositionDescriptor,
  PgCompositionObject,
} from './segments';
// Turning display sets into overlay operations at their presentation time.
export { PgRenderer, type PgRendererDeps } from './pg-renderer';
// The RGBA surface overlay operations draw on.
export { OverlayPlane, type OverlayOp, type OverlayCmd, type Rect } from './overlay-plane';
