/** The trace's types live with the renderer that writes it (src/engine/ass/trace.ts). */
import type { TraceClip, TraceEvent, TraceRun } from '../../src/engine/ass/trace-format';

export type { TraceClip, TraceEvent, TraceGlyph, TraceRun } from '../../src/engine/ass/trace-format';

export function parseTrace(jsonl: string): TraceEvent[] {
  return jsonl.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as TraceEvent);
}

/** As the harness prints doubles (%.6f). */
const round = (v: number): number => {
  const r = Number(v.toFixed(6));
  return Object.is(r, -0) ? 0 : r;
};

const num = (v: number): number => round(v);
const nums = <T extends readonly number[]>(v: T): T => v.map(num) as unknown as T;

function clip(c: TraceClip): TraceClip {
  return 'rect' in c ? { rect: nums(c.rect), inverse: c.inverse } : { vector: c.vector, scale: c.scale, inverse: c.inverse };
}

function run(r: TraceRun): TraceRun {
  return {
    text: r.text, font: r.font, size: num(r.size), scale: nums(r.scale), hspacing: num(r.hspacing), colors: r.colors,
    border: nums(r.border), shadow: nums(r.shadow), blur: num(r.blur), be: r.be, rot: nums(r.rot), shear: nums(r.shear),
    borderStyle: r.borderStyle, flags: r.flags, bold: r.bold, italic: r.italic, karaoke: r.karaoke, drawing: r.drawing,
    // a projective matrix needs more than 1/64: keep 6 significant digits
    matrix: r.matrix.map((v) => { const p = Number(v.toPrecision(6)); return Object.is(p, -0) ? 0 : p; }),
    glyphs: r.glyphs.map((g) => ({ x: num(g.x), y: num(g.y), adv: num(g.adv), ch: g.ch })),
  };
}

/** One line per event, keys in the order of TraceEvent, numbers rounded to 6 decimals; ends with a newline. */
export function formatTrace(events: readonly TraceEvent[]): string {
  return events.map((e) => JSON.stringify({ t: e.t, event: e.event, layer: e.layer, box: nums(e.box), lines: e.lines, clip: clip(e.clip), runs: e.runs.map(run) }) + '\n').join('');
}
