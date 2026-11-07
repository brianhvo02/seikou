/*
 * Glyph metrics from the browser's text shaping, standing in for FreeType and HarfBuzz in libass's layout.
 *
 * Original implementation for bluray-web, 2026; contains no libass, libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/** One code point's metrics in px at the em size measured, y up. */
export interface GlyphMetrics {
  /** Advance including kerning with the next glyph of the run. */
  readonly advance: number;
  /** Ink extents of the glyph alone, from its origin. */
  readonly inkLeft: number;
  readonly inkRight: number;
  readonly inkTop: number;
  readonly inkBottom: number;
}

export interface GlyphMeasurer {
  /** Metrics of each code point of `codepoints` shaped as one run in `cssFamily` at `emPx`. */
  measureRun(cssFamily: string, emPx: number, codepoints: readonly number[], kerning: boolean): readonly GlyphMetrics[];
  /** Forget cached measurements (fonts finished loading). */
  reset?(): void;
}

/** For Node tests: every code point advances `ratio × emPx`, ink fills the advance, 0.7 em up and 0.2 em down. */
export function createFixedMeasurer(ratio: number): GlyphMeasurer {
  return {
    measureRun: (_family, emPx, cps) => cps.map(() => ({ advance: ratio * emPx, inkLeft: 0, inkRight: ratio * emPx, inkTop: 0.7 * emPx, inkBottom: -0.2 * emPx })),
  };
}

/** ctx.measureText on prefixes, so kerning and ligatures are the browser's shaping; cached per run. */
export function createCanvasMeasurer(ctx: OffscreenCanvasRenderingContext2D): GlyphMeasurer {
  const cache = new Map<string, readonly GlyphMetrics[]>();
  return {
    measureRun(cssFamily, emPx, cps, kerning) {
      const text = String.fromCodePoint(...cps);
      const key = `${cssFamily}\u0000${emPx}\u0000${kerning ? 1 : 0}\u0000${text}`;
      const hit = cache.get(key);
      if (hit) return hit;
      ctx.save();
      ctx.font = `${emPx}px "${cssFamily}"`;
      ctx.fontKerning = kerning ? 'normal' : 'none';
      ctx.letterSpacing = '0px';
      const out: GlyphMetrics[] = [];
      let prefix = '';
      let before = 0;
      for (const cp of cps) {
        const ch = String.fromCodePoint(cp);
        prefix += ch;
        const after = ctx.measureText(prefix).width;
        const ink = ctx.measureText(ch);
        out.push({
          advance: after - before,
          inkLeft: -ink.actualBoundingBoxLeft,
          inkRight: ink.actualBoundingBoxRight,
          inkTop: ink.actualBoundingBoxAscent,
          inkBottom: -ink.actualBoundingBoxDescent,
        });
        before = after;
      }
      ctx.restore();
      if (cache.size > 4096) cache.clear();
      cache.set(key, out);
      return out;
    },
    reset: () => cache.clear(),
  };
}
