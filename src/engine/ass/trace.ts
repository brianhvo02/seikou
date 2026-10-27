/*
 * A frame's layout in the libass trace format (tools/ass-trace/trace.patch), for comparing the port with libass.
 * Runs are split as render_and_combine_glyphs splits them.
 *
 * Original implementation for bluray-web, 2026; contains no libass, libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { TraceEvent, TraceRun } from './trace-format';
import type { GlyphInfo } from './events';
import type { AssFonts } from './fonts';
import type { FrameEvent, FrameLayout } from './frame';
import { EF_KARAOKE_KF } from './state';
import { applyFade } from './tags';
import { applyMat3, normalize, type Mat3 } from './transform';

const hex = (c: number): string => (c >>> 0).toString(16).toUpperCase().padStart(8, '0');
const lround = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/** The run's karaoke split for \kf: from its leftmost transformed outline x, as render_and_combine_glyphs does. */
function kfTiming(glyphs: readonly GlyphInfo[], matrices: readonly (Mat3 | null)[], first: GlyphInfo, parScaleX: number): number {
  let leftmost = Infinity;
  glyphs.forEach((g, k) => {
    const m = matrices[k];
    if (!m) return;
    for (const [x, y] of [[g.bboxXMin, g.bboxYMin], [g.bboxXMin, g.bboxYMax], [g.bboxXMax, g.bboxYMin], [g.bboxXMax, g.bboxYMax]] as const) {
      leftmost = Math.min(leftmost, applyMat3(m, x, y)[0]);
    }
  });
  if (!Number.isFinite(leftmost)) leftmost = 0;
  return lround(leftmost / 64 + (first.effectTiming / 64) * parScaleX);
}

function runOf(e: FrameEvent, idx: readonly number[], fonts: AssFonts): TraceRun {
  const g = e.layout.text.glyphs;
  const s = e.layout.text.state;
  const glyphs = idx.map((i) => g[i]!);
  const first = glyphs[0]!;
  const shown = glyphs.filter((x) => x.symbol !== 0x0a && x.symbol !== 0);
  const face = first.face ?? fonts.resolve(first.font);
  const c = first.c.map((v) => applyFade(v, first.fade));
  const m = e.matrices[idx[0]!];
  const karaoke = first.effectType === EF_KARAOKE_KF ? kfTiming(glyphs, idx.map((i) => e.matrices[i]!), first, s.parScaleX) : first.effectTiming;
  return {
    text: String.fromCodePoint(...shown.map((x) => x.symbol)),
    font: `${first.font.family}|${face.face.postscriptName ?? ''}`,
    size: first.fontSize,
    scale: [first.scaleX, first.scaleY],
    hspacing: first.hspacing,
    colors: [hex(c[0]!), hex(c[1]!), hex(c[2]!), hex(c[3]!)],
    border: [first.borderX, first.borderY],
    shadow: [first.shadowX, first.shadowY],
    blur: first.blur,
    be: first.be,
    rot: [first.frx, first.fry, first.frz],
    shear: [first.fax, first.fay],
    borderStyle: first.borderStyle,
    flags: first.flags,
    bold: first.bold,
    italic: first.italic,
    karaoke: [first.effectType, karaoke],
    drawing: first.drawingText !== null,
    matrix: m ? [...normalize(m)] : [0, 0, 0, 0, 0, 0, 0, 0, 0],
    glyphs: shown.map((x) => ({ x: x.posX / 64, y: x.posY / 64, adv: x.clusterAdvanceX / 64, ch: x.symbol })),
  };
}

export function frameToTrace(frame: FrameLayout, fonts: AssFonts): TraceEvent[] {
  return frame.events.map((e) => {
    const l = e.layout;
    const runs: number[][] = [];
    let newRun = true;
    l.text.glyphs.forEach((g, i) => {
      if (g.startsNewRun) newRun = true;
      if (g.skip) return;
      if (newRun) runs.push([]);
      newRun = false;
      runs.at(-1)!.push(i);
    });
    const clip = l.clip.drawing !== null
      ? { vector: l.clip.drawing, scale: l.clip.drawingScale, inverse: l.clip.drawingMode === 1 }
      : { rect: [l.clip.x0, l.clip.y0, l.clip.x1, l.clip.y1] as const, inverse: l.clip.mode === 1 };
    return {
      t: frame.t,
      event: e.index,
      layer: l.text.state.event.layer,
      box: [e.box.left, e.box.top, e.box.width, e.box.height] as const,
      lines: l.lines.length,
      clip,
      runs: runs.map((idx) => runOf(e, idx, fonts)),
    };
  });
}
