/*
 * Draws text subtitle cues onto the player canvas.
 *
 * Original implementation for Seikou, 2026; contains no libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { Rect, TextRenderOptions } from '@seikou/ass/host-types';
import { activeCues, type StyledRun, type TextCue } from './srt';

export type { TextRenderOptions };

const FONT_SIZE = 0.055; // of the video height
const LINE_HEIGHT = 1.2;
const MARGIN = 0.05; // of the video height (vertical) and width (horizontal)
const MAX_LINE_WIDTH = 0.9; // of the video width
const OUTLINE = 0.12;
const SHADOW = 0.06;

interface Segment { readonly run: StyledRun; readonly text: string; readonly width: number }
interface VisualLine { readonly segments: readonly Segment[]; readonly width: number }

function fontFor(run: StyledRun, size: number): string {
  return `${run.italic ? 'italic ' : ''}${run.bold ? 'bold ' : ''}${size}px sans-serif`;
}

/** Greedy wrapping at spaces; a word wider than the line stays whole. */
function wrap(ctx: OffscreenCanvasRenderingContext2D, runs: readonly StyledRun[], size: number, maxWidth: number): VisualLine[] {
  const atoms: Array<{ run: StyledRun; text: string; space: boolean }> = [];
  for (const run of runs) for (const text of run.text.split(/( +)/)) if (text) atoms.push({ run, text, space: text.startsWith(' ') });
  const lines: VisualLine[] = [];
  let segments: Segment[] = [];
  let width = 0;
  const measure = (run: StyledRun, text: string): number => {
    ctx.font = fontFor(run, size);
    return ctx.measureText(text).width;
  };
  const finish = (): void => {
    while (segments.length > 0 && /^ +$/.test(segments.at(-1)!.text)) width -= segments.pop()!.width; // no trailing spaces
    lines.push({ segments: merge(segments), width });
    segments = [];
    width = 0;
  };
  for (let i = 0; i < atoms.length; ) {
    const atom = atoms[i]!;
    if (atom.space) {
      i++;
      if (segments.length > 0) { // no leading spaces
        const w = measure(atom.run, atom.text);
        segments.push({ run: atom.run, text: atom.text, width: w });
        width += w;
      }
      continue;
    }
    // a word is every non-space piece up to the next space, whatever its styles: it moves to the next line whole
    const word: Segment[] = [];
    for (; i < atoms.length && !atoms[i]!.space; i++) word.push({ run: atoms[i]!.run, text: atoms[i]!.text, width: measure(atoms[i]!.run, atoms[i]!.text) });
    const w = word.reduce((sum, seg) => sum + seg.width, 0);
    if (segments.length > 0 && width + w > maxWidth) finish();
    segments.push(...word);
    width += w;
  }
  if (segments.length > 0 || lines.length === 0) finish();
  return lines;
}

/** Joins neighbouring pieces of the same run, so each run of a line is drawn with one call. */
function merge(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const last = out.at(-1);
    if (last && last.run === s.run) out[out.length - 1] = { run: s.run, text: last.text + s.text, width: last.width + s.width };
    else out.push(s);
  }
  return out;
}

/** Where each piece of text goes: the layout of one set of cues at one size in one rectangle. */
interface Layout {
  readonly cues: readonly TextCue[];
  readonly scale: number;
  readonly rect: Rect;
  readonly size: number;
  readonly pieces: ReadonlyArray<{ readonly seg: Segment; readonly x: number; readonly y: number }>;
}

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const sameCues = (a: readonly TextCue[], b: readonly TextCue[]): boolean => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * Draws SRT cues as outlined white text with a shadow, wrapped at spaces to 90% of the video width, at 5.5% of the video
 * height times the user's scale. It is a TextRendererLike for one parsed cue list; the layout of the cues on screen is
 * kept from frame to frame.
 */
export class TextSubtitleRenderer {
  private lastCues: readonly TextCue[] = [];
  private lastScale = 1;
  /** The cues on screen keep their layout from frame to frame: wrapping measures every word. */
  private layoutCache: Layout | null = null;

  constructor(private readonly cues: readonly TextCue[]) {}

  /** True if the set of cues visible at `timeUs` (cue time = timeUs − offset), or the size, differs from the last render. */
  changed(timeUs: number, opts: TextRenderOptions): boolean {
    const now = activeCues(this.cues, timeUs - opts.offsetUs);
    if (now.length !== this.lastCues.length) return true;
    if (now.length > 0 && opts.scale !== this.lastScale) return true;
    return now.some((c, i) => c !== this.lastCues[i]);
  }

  /** Whether any cue shows at `timeUs`. */
  visible(timeUs: number, opts: TextRenderOptions): boolean {
    return activeCues(this.cues, timeUs - opts.offsetUs).length > 0;
  }

  /** Draws the visible cues inside `videoRect`; returns how many were drawn. */
  render(ctx: OffscreenCanvasRenderingContext2D, timeUs: number, videoRect: Rect, opts: TextRenderOptions): number {
    const cues = activeCues(this.cues, timeUs - opts.offsetUs);
    this.lastCues = cues;
    this.lastScale = opts.scale;
    if (cues.length === 0 || videoRect.width <= 0 || videoRect.height <= 0) return 0;

    const cached = this.layoutCache;
    const layout = cached && cached.scale === opts.scale && sameRect(cached.rect, videoRect) && sameCues(cached.cues, cues)
      ? cached
      : (this.layoutCache = this.layout(ctx, cues, videoRect, opts.scale));
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = layout.size * OUTLINE;
    ctx.strokeStyle = '#000000';
    for (const { seg, x, y } of layout.pieces) this.drawSegment(ctx, seg, x, y, layout.size);
    ctx.restore();
    return cues.length;
  }

  private layout(ctx: OffscreenCanvasRenderingContext2D, cues: readonly TextCue[], videoRect: Rect, scale: number): Layout {
    const size = videoRect.height * FONT_SIZE * scale;
    const lineHeight = size * LINE_HEIGHT;
    const marginV = videoRect.height * MARGIN;
    const marginH = videoRect.width * MARGIN;
    const maxWidth = videoRect.width * MAX_LINE_WIDTH;
    const pieces: Array<{ seg: Segment; x: number; y: number }> = [];
    ctx.save(); // wrap() sets the font to measure
    for (let align = 1; align <= 9; align++) {
      const group = cues.filter((c) => c.align === align);
      if (group.length === 0) continue;
      const row = Math.floor((align - 1) / 3); // 0 bottom, 1 middle, 2 top
      const col = (align - 1) % 3; // 0 left, 1 centre, 2 right
      // bottom-aligned cues stack upwards (later ones above), the others downwards
      const ordered = row === 0 ? [...group].reverse() : group;
      const lines = ordered.flatMap((c) => c.lines.flatMap((runs) => wrap(ctx, runs, size, maxWidth)));
      const blockHeight = (lines.length - 1) * lineHeight;
      let baseline =
        row === 0 ? videoRect.y + videoRect.height - marginV - blockHeight
          : row === 2 ? videoRect.y + marginV + size
            : videoRect.y + (videoRect.height - blockHeight) / 2 + size / 2;
      for (const line of lines) {
        let x =
          col === 0 ? videoRect.x + marginH
            : col === 2 ? videoRect.x + videoRect.width - marginH - line.width
              : videoRect.x + (videoRect.width - line.width) / 2;
        for (const seg of line.segments) {
          pieces.push({ seg, x, y: baseline });
          x += seg.width;
        }
        baseline += lineHeight;
      }
    }
    ctx.restore();
    return { cues, scale, rect: videoRect, size, pieces };
  }

  private drawSegment(ctx: OffscreenCanvasRenderingContext2D, seg: Segment, x: number, y: number, size: number): void {
    ctx.font = fontFor(seg.run, size);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowOffsetX = size * SHADOW;
    ctx.shadowOffsetY = size * SHADOW;
    ctx.strokeText(seg.text, x, y);
    ctx.shadowColor = 'transparent';
    // a colour the canvas cannot parse is ignored by it, which would leave the previous fill (often black): white first
    ctx.fillStyle = '#ffffff';
    if (seg.run.color) ctx.fillStyle = seg.run.color;
    ctx.fillText(seg.text, x, y);
    if (seg.run.underline) ctx.fillRect(x, y + size * 0.1, seg.width, Math.max(1, size * 0.06));
  }
}
