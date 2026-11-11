/**
 * The libass layout trace (tools/ass-trace/trace.patch): one JSON line per event shown at a time, in libass's output
 * order (layer, then input order). Values are libass's own: GlyphInfo fields in its units (sizes in script units,
 * rotations in degrees), positions in frame pixels.
 */

/** One glyph of a run: `x` and `y` its position in frame pixels, `adv` its cluster advance in pixels and `ch` its code point. */
export interface TraceGlyph { readonly x: number; readonly y: number; readonly adv: number; readonly ch: number }

/** One run of glyphs with the same drawing state, as the libass trace patch prints it. */
export interface TraceRun {
  /** The run's characters. */
  readonly text: string;
  /** "<requested family>|<PostScript name of the face drawn>". */
  readonly font: string;
  /** The glyph font size in pixels. */
  readonly size: number;
  /** Glyph scale as fractions: x, y. */
  readonly scale: readonly [number, number];
  /** Extra space after each character. */
  readonly hspacing: number;
  /** c[0..3] as RRGGBBAA hex, fade applied. */
  readonly colors: readonly [string, string, string, string];
  /** Outline width along x, y. */
  readonly border: readonly [number, number];
  /** Shadow distance along x, y. */
  readonly shadow: readonly [number, number];
  /** Gaussian blur radius. */
  readonly blur: number;
  /** Edge blur passes. */
  readonly be: number;
  /** Rotation in degrees about x, y, z. */
  readonly rot: readonly [number, number, number];
  /** Shear along x, y. */
  readonly shear: readonly [number, number];
  /** BorderStyle: 1 outline and shadow, 3 box. */
  readonly borderStyle: number;
  /** `DECO_*` bits. */
  readonly flags: number;
  /** The weight requested. */
  readonly bold: number;
  /** The slant requested. */
  readonly italic: number;
  /** effect_type and effect_timing of the run's combined bitmap (after ass_process_karaoke_effects). */
  readonly karaoke: readonly [number, number];
  /** The run is a `\p` drawing. */
  readonly drawing: boolean;
  /** calc_transform_matrix's m for the run's first glyph, row-major, divided by m[2][2]. */
  readonly matrix: readonly number[];
  /** The run's visible glyphs. */
  readonly glyphs: readonly TraceGlyph[];
}

/** An event's clip: a rectangle (`\clip` or `\iclip` with four numbers) or a vector drawing, and whether it is inverse (`\iclip`). */
export type TraceClip =
  | { readonly rect: readonly [number, number, number, number]; readonly inverse: boolean }
  | { readonly vector: string; readonly scale: number; readonly inverse: boolean };

/** One event shown at time `t` (ms): its box after collisions, its line count, its clip and its runs. */
export interface TraceEvent {
  /** The time in ms the frame was built for. */
  readonly t: number;
  /** Index in the track's events (file order). */
  readonly event: number;
  readonly layer: number;
  /** EventImages left, top, width, height after fix_collisions. */
  readonly box: readonly [number, number, number, number];
  /** The number of text lines. */
  readonly lines: number;
  /** The clip in force for the event. */
  readonly clip: TraceClip;
  /** The event's runs in drawing order. */
  readonly runs: readonly TraceRun[];
}
