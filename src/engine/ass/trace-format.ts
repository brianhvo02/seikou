/**
 * The libass layout trace (tools/ass-trace/trace.patch): one JSON line per event shown at a time, in libass's output
 * order (layer, then input order). Values are libass's own: GlyphInfo fields in its units (sizes in script units,
 * rotations in degrees), positions in frame pixels.
 */

export interface TraceGlyph { readonly x: number; readonly y: number; readonly adv: number; readonly ch: number }

export interface TraceRun {
  readonly text: string;
  /** "<requested family>|<PostScript name of the face drawn>". */
  readonly font: string;
  readonly size: number;
  readonly scale: readonly [number, number];
  readonly hspacing: number;
  /** c[0..3] as RRGGBBAA hex, fade applied. */
  readonly colors: readonly [string, string, string, string];
  readonly border: readonly [number, number];
  readonly shadow: readonly [number, number];
  readonly blur: number;
  readonly be: number;
  readonly rot: readonly [number, number, number];
  readonly shear: readonly [number, number];
  readonly borderStyle: number;
  readonly flags: number;
  readonly bold: number;
  readonly italic: number;
  /** effect_type and effect_timing of the run's combined bitmap (after ass_process_karaoke_effects). */
  readonly karaoke: readonly [number, number];
  readonly drawing: boolean;
  /** calc_transform_matrix's m for the run's first glyph, row-major, divided by m[2][2]. */
  readonly matrix: readonly number[];
  readonly glyphs: readonly TraceGlyph[];
}

export type TraceClip =
  | { readonly rect: readonly [number, number, number, number]; readonly inverse: boolean }
  | { readonly vector: string; readonly scale: number; readonly inverse: boolean };

export interface TraceEvent {
  readonly t: number;
  /** Index in the track's events (file order). */
  readonly event: number;
  readonly layer: number;
  /** EventImages left, top, width, height after fix_collisions. */
  readonly box: readonly [number, number, number, number];
  readonly lines: number;
  readonly clip: TraceClip;
  readonly runs: readonly TraceRun[];
}
