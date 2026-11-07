import { describe, expect, it } from 'vitest';
import type { Rect } from '../render/compositor';
import { parseSrt } from './srt';
import { TextSubtitleRenderer } from './text-renderer';

interface TextCall { readonly kind: 'fill' | 'stroke'; readonly text: string; readonly x: number; readonly y: number; readonly font: string; readonly style: string }

/** Records text drawing; measureText is text.length × font size × 0.5. */
function fakeCtx() {
  const texts: TextCall[] = [];
  const rects: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
  const state = { font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineJoin: 'miter', textAlign: 'start', textBaseline: 'alphabetic', shadowColor: 'transparent', shadowOffsetX: 0, shadowOffsetY: 0, shadowBlur: 0 };
  const stack: Array<typeof state> = [];
  const size = (): number => Number(/(\d+(?:\.\d+)?)px/.exec(state.font)![1]);
  const ctx = {
    ...state,
    save(): void { stack.push({ ...state }); },
    restore(): void { Object.assign(state, stack.pop()); },
    measureText: (text: string) => ({ width: text.length * size() * 0.5 }),
    fillText(text: string, x: number, y: number): void { texts.push({ kind: 'fill', text, x, y, font: state.font, style: String(state.fillStyle) }); },
    strokeText(text: string, x: number, y: number): void { texts.push({ kind: 'stroke', text, x, y, font: state.font, style: String(state.strokeStyle) }); },
    fillRect(x: number, y: number, w: number, h: number): void { rects.push({ x, y, w, h, style: String(state.fillStyle) }); },
  };
  // writes go to `state` so save/restore and measureText see them
  const proxy = new Proxy(ctx, {
    get: (t, p: string) => (p in state ? state[p as keyof typeof state] : t[p as keyof typeof t]),
    set: (_t, p: string, v) => { (state as Record<string, unknown>)[p] = v; return true; },
  });
  return { ctx: proxy as unknown as OffscreenCanvasRenderingContext2D, texts, rects, fills: () => texts.filter((t) => t.kind === 'fill') };
}

const cue = (from: string, to: string, text: string) => `${from} --> ${to}\n${text}`;
const srt = (...blocks: string[]) => parseSrt(blocks.map((b, i) => `${i + 1}\n${b}`).join('\n\n')).cues;
const OPTS = { offsetUs: 0, scale: 1 };
/** A 1000×500 video letterboxed at y 100 inside a taller canvas. */
const VIDEO: Rect = { x: 0, y: 100, width: 1000, height: 500 };
const SIZE = 500 * 0.055;

describe('TextSubtitleRenderer', () => {
  it('draws a bottom-centre cue centred, with its baseline at the bottom margin of the video rectangle', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', 'Hello')));
    const { ctx, texts, fills } = fakeCtx();
    expect(r.render(ctx, 1_500_000, VIDEO, OPTS)).toBe(1);
    const [f] = fills();
    const width = 5 * SIZE * 0.5;
    expect(f).toMatchObject({ text: 'Hello', style: '#ffffff' });
    expect(f!.x).toBeCloseTo((1000 - width) / 2);
    expect(f!.y).toBeCloseTo(100 + 500 - 25);
    expect(f!.font).toBe(`${SIZE}px sans-serif`);
    // outline first, then fill, at the same place
    expect(texts.map((t) => t.kind)).toEqual(['stroke', 'fill']);
    expect(texts[0]).toMatchObject({ x: f!.x, y: f!.y, style: '#000000' });
    expect(r.render(ctx, 2_000_000, VIDEO, OPTS)).toBe(0);
  });

  it('places \\an8 at the top centre and \\an7 at the top left', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', '{\\an8}top'), cue('00:00:01,000', '00:00:02,000', '{\\an7}left')));
    const { ctx, fills } = fakeCtx();
    r.render(ctx, 1_000_000, VIDEO, OPTS);
    const top = fills().find((t) => t.text === 'top')!;
    const left = fills().find((t) => t.text === 'left')!;
    expect(top.y).toBeCloseTo(100 + 25 + SIZE);
    expect(top.x).toBeCloseTo((1000 - 3 * SIZE * 0.5) / 2);
    expect(left).toMatchObject({ x: 50 });
    expect(left.y).toBeCloseTo(100 + 25 + SIZE);
  });

  it('wraps a long line at spaces and keeps a single long word on one line', () => {
    const words = Array.from({ length: 16 }, () => 'word').join(' '); // 79 characters: 1086 px at this size, the limit is 900
    const long = 'x'.repeat(79);
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', words), cue('00:00:03,000', '00:00:04,000', long)));
    const a = fakeCtx();
    r.render(a.ctx, 1_000_000, VIDEO, OPTS);
    const lines = [...new Set(a.fills().map((t) => t.y))];
    expect(lines).toHaveLength(2);
    expect(lines[1]! - lines[0]!).toBeCloseTo(SIZE * 1.2);
    expect(a.fills().map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim()).toBe(words);
    const b = fakeCtx();
    r.render(b.ctx, 3_000_000, VIDEO, OPTS);
    expect(b.fills()).toHaveLength(1);
  });

  it('does not break inside a word whose letters change style', () => {
    const filler = 'a'.repeat(62); // with " wo" 65 characters (894 px) fit the 900 px line; "rd" would cross it
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', `${filler} <i>wo</i>rd`)));
    const { ctx, fills } = fakeCtx();
    r.render(ctx, 1_000_000, VIDEO, OPTS);
    const wo = fills().find((t) => t.text === 'wo')!;
    const rd = fills().find((t) => t.text === 'rd')!;
    expect(rd.y).toBe(wo.y);
    expect(rd.x).toBeCloseTo(wo.x + SIZE);
  });

  it('stacks a later overlapping bottom cue above the earlier one', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:05,000', 'first'), cue('00:00:02,000', '00:00:03,000', 'second')));
    const { ctx, fills } = fakeCtx();
    expect(r.render(ctx, 2_500_000, VIDEO, OPTS)).toBe(2);
    const first = fills().find((t) => t.text === 'first')!;
    const second = fills().find((t) => t.text === 'second')!;
    expect(first.y).toBeCloseTo(575);
    expect(second.y).toBeCloseTo(575 - SIZE * 1.2);
  });

  it('puts italic and bold in the font, fills a coloured run with its colour and underlines', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', '<i>it</i><b>bo</b><font color="#ff0000">red</font><u>un</u>')));
    const { ctx, fills, rects } = fakeCtx();
    r.render(ctx, 1_000_000, VIDEO, OPTS);
    const by = (text: string) => fills().find((t) => t.text === text)!;
    expect(by('it').font).toBe(`italic ${SIZE}px sans-serif`);
    expect(by('bo').font).toBe(`bold ${SIZE}px sans-serif`);
    expect(by('red').style).toBe('#ff0000');
    expect(by('bo').x).toBeCloseTo(by('it').x + 2 * SIZE * 0.5);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x).toBeCloseTo(by('un').x);
    expect(rects[0]!.w).toBeCloseTo(2 * SIZE * 0.5);
  });

  it('fills a run whose colour the canvas rejects in white, not in the colour left over from before', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', '<font color="nosuchcolour">x</font>')));
    const { ctx, fills } = fakeCtx();
    // a canvas ignores a fillStyle it cannot parse and keeps the old one (here the compositor's black)
    (ctx as unknown as { fillStyle: string }).fillStyle = '#000000';
    const guarded = new Proxy(ctx, {
      set: (t, p, v) => {
        if (p === 'fillStyle' && v === 'nosuchcolour') return true;
        (t as unknown as Record<string | symbol, unknown>)[p] = v;
        return true;
      },
      get: (t, p) => {
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    r.render(guarded, 1_000_000, VIDEO, OPTS);
    expect(fills()[0]).toMatchObject({ text: 'x', style: '#ffffff' });
  });

  it('reports changes at cue boundaries only and applies the offset', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', 'a')));
    const { ctx } = fakeCtx();
    const step = (t: number, opts = OPTS): boolean => {
      const changed = r.changed(t, opts);
      r.render(ctx, t, VIDEO, opts);
      return changed;
    };
    expect(step(500_000)).toBe(false); // nothing before, nothing now
    expect(step(1_000_000)).toBe(true);
    expect(step(1_500_000)).toBe(false);
    expect(step(2_000_000)).toBe(true);
    const late = { offsetUs: 500_000, scale: 1 };
    expect(step(1_200_000, late)).toBe(false);
    expect(step(1_500_000, late)).toBe(true);
    expect(step(2_499_999, late)).toBe(false);
    expect(step(2_500_000, late)).toBe(true);
  });

  it('shows a cue a negative offset moves before zero from zero, never shows a cue past the end, and does not throw', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:00,200', '00:00:01,000', 'early'), cue('99:00:00,000', '99:00:01,000', 'never')));
    const { ctx, fills } = fakeCtx();
    expect(r.render(ctx, 0, VIDEO, { offsetUs: -500_000, scale: 1 })).toBe(1);
    expect(fills()[0]!.text).toBe('early');
    expect(r.render(ctx, 600_000, VIDEO, { offsetUs: -500_000, scale: 1 })).toBe(0);
    expect(() => r.render(ctx, 8_000_000, VIDEO, OPTS)).not.toThrow();
    expect(new TextSubtitleRenderer([]).render(ctx, 0, VIDEO, OPTS)).toBe(0);
  });

  it('lays out a cue set once: later frames with the same cues, size and rectangle measure nothing', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:03,000', 'a long line of several words that wraps ' + 'word '.repeat(20))));
    const { ctx, fills } = fakeCtx();
    let measured = 0;
    const counting = new Proxy(ctx, {
      get: (t, p) => {
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        if (p === 'measureText') return (text: string) => { measured++; return (v as (s: string) => TextMetrics)(text); };
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
      set: (t, p, v) => { (t as unknown as Record<string | symbol, unknown>)[p] = v; return true; },
    });
    r.render(counting, 1_000_000, VIDEO, OPTS);
    const first = fills().map((f) => [f.text, f.x, f.y]);
    expect(measured).toBeGreaterThan(0);
    measured = 0;
    r.render(counting, 1_500_000, VIDEO, OPTS);
    expect(measured).toBe(0);
    expect(fills().slice(first.length).map((f) => [f.text, f.x, f.y])).toEqual(first); // the same picture
    r.render(counting, 1_600_000, { ...VIDEO, width: 800 }, OPTS);
    expect(measured).toBeGreaterThan(0); // another rectangle is another layout
    measured = 0;
    r.render(counting, 1_700_000, { ...VIDEO, width: 800 }, { offsetUs: 0, scale: 1.5 });
    expect(measured).toBeGreaterThan(0); // and so is another size
  });

  it('scales the font', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', 'a')));
    const { ctx, fills } = fakeCtx();
    r.render(ctx, 1_000_000, VIDEO, { offsetUs: 0, scale: 2 });
    expect(fills()[0]!.font).toBe(`${SIZE * 2}px sans-serif`);
    expect(r.changed(1_000_000, { offsetUs: 0, scale: 1 })).toBe(true); // another size is another picture
  });

  it('reports whether a cue shows at a time, with the offset', () => {
    const r = new TextSubtitleRenderer(srt(cue('00:00:01,000', '00:00:02,000', 'a')));
    expect(r.visible(1_500_000, OPTS)).toBe(true);
    expect(r.visible(2_500_000, OPTS)).toBe(false);
    expect(r.visible(2_500_000, { ...OPTS, offsetUs: 1_000_000 })).toBe(true);
  });
});
