// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/ass: the ASS renderer, ported from libass. Everything else is internal, reached through ./*.

// Reading a script, or an ASS track and its events from Matroska.
export { parseAss, parseAssCodecPrivate, parseChunkEvent } from './parse';
// A parsed script: styles, events and its colour matrix.
export { type AssTrack, type AssStyle, type AssEvent, YCbCr, type YCbCrMatrix } from './types';
// The renderer and what it needs from the host.
export { AssRenderer, type AssRendererDeps, type AssRenderStats } from './renderer';
// Types shared with the host: rectangles, memory limits and the text renderer contract.
export type { AssRendererLimits, Rect, TextRenderOptions, TextRendererLike } from './host-types';
// Font matching and loading.
export {
  AssFonts,
  type AssFontsOptions,
  type FontLoader,
  type FontRequest,
  type ResolvedFace,
  createFontFaceLoader,
} from './fonts';
// Reading a font file's faces.
export { readFontFile, type FontFile, type FaceInfo } from './font-tables';
// Falling back to fonts installed on the device.
export { createDeviceFontSource, type DeviceFontSource, type DeviceFaceMetrics } from './device-fonts';
// Measuring glyphs with the browser.
export { createCanvasMeasurer, type GlyphMeasurer, type GlyphMetrics } from './measure';
// Drawing a canvas through a projective matrix.
export { drawWarped } from './warp';
// The matrix type the warp takes.
export type { Mat3 } from './transform';
