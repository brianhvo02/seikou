/*
 * Draws an ASS track on the player canvas: the events active at the playback time, laid out and rasterized as libass
 * does, static events cached as finished bitmaps, collision memory dropped on seeks.
 *
 * Original implementation for Seikou, 2026; contains no libass, libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { AssRendererLimits, Rect, TextRendererLike, TextRenderOptions } from './host-types';
import type { AssFonts } from './fonts';
import { FrameBuilder, type FrameEvent } from './frame';
import type { GlyphMeasurer } from './measure';
import { renderEvent, type CachedLayers, type RasterContext, type RenderedEvent, type RunMasks } from './raster';
import type { RenderSettings } from './state';
import type { Mat3 } from './transform';
import { YCbCr, type AssTrack, type YCbCrMatrix } from './types';

/**
 * What the last render did: `events` shown, how many of them are `animated`, `renderMs` the time it took in ms, and
 * the counts since the renderer was made: `renders` done and `overBudget`, those that took more than 8 ms.
 */
export interface AssRenderStats { readonly events: number; readonly animated: number; readonly renderMs: number; readonly overBudget: number; readonly renders: number }

export type { AssRendererLimits };

/** What `AssRenderer` needs from its host: a measurer, canvas and clock, and the browser's drawing classes. */
export interface AssRendererDeps {
  readonly measurer: GlyphMeasurer;
  readonly createCanvas: (w: number, h: number) => OffscreenCanvas;
  readonly nowMs: () => number;
  readonly Path2D: typeof Path2D;
  /** 'video': convert BT.601 scripts' colours to the BT.709 video, as players do (libass does not); 'none': as written. */
  readonly colorMatrix: 'video' | 'none';
  readonly warp?: (target: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, m: Mat3, originX: number, originY: number) => void;
  /** Cache byte budgets and the text supersampling cap (the memory profile's). */
  readonly limits: AssRendererLimits;
  /** Whether canvases honour `ctx.filter` (false on Safari): blurred runs then take the mask path. */
  readonly canvasFilter: boolean;
  /**
   * For tests: replaces the raster.
   * @internal
   */
  readonly renderEvent?: (rc: RasterContext, ev: FrameEvent, frame: { readonly width: number; readonly height: number }) => RenderedEvent | null;
}

const CACHE_SIZE = 64;
const BUDGET_MS = 8;
const SEEK_MS = 1000;
const ANIMATION_STEP_MS = 40;

/** Least recently used values within a byte budget (libass bounds its bitmap caches the same way). */
class SizedLru<V> {
  private readonly map = new Map<string, { value: V; bytes: number }>();
  private bytes = 0;
  constructor(private readonly budget: number, private readonly sizeOf: (v: V) => number, private readonly maxEntries = Infinity) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, value: V): void {
    const old = this.map.get(key);
    if (old) this.bytes -= old.bytes;
    const bytes = this.sizeOf(value);
    this.map.delete(key);
    this.map.set(key, { value, bytes });
    this.bytes += bytes;
    while ((this.bytes > this.budget || this.map.size > this.maxEntries) && this.map.size > 1) {
      const [k, e] = this.map.entries().next().value!;
      this.map.delete(k);
      this.bytes -= e.bytes;
    }
  }
  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
  get size(): number {
    return this.map.size;
  }
}

const maskBytes = (m: RunMasks): number => m.fill.length + (m.border?.length ?? 0) + (m.shadow?.length ?? 0);
const eventBytes = (r: RenderedEvent | null): number => (r ? 4 * r.canvas.width * r.canvas.height || 0 : 0);
const layerBytes = (l: CachedLayers): number => [l.shadow, l.border, l.fill].reduce((n, x) => n + (x ? 4 * x.w * x.h : 0), 0);

const BT601 = { kr: 0.299, kb: 0.114 };
const BT709 = { kr: 0.2126, kb: 0.0722 };

/** A script colour for display: BT.601 (TV.601, PC.601, or no header, as VSFilter assumed) re-encoded as BT.709. */
export function convertColor(c: number, matrix: YCbCrMatrix, mode: 'video' | 'none'): number {
  if (mode === 'none') return c;
  if (matrix !== YCbCr.Default && matrix !== YCbCr.Bt601Tv && matrix !== YCbCr.Bt601Pc) return c;
  const r = (c >>> 24) / 255;
  const g = ((c >>> 16) & 0xff) / 255;
  const b = ((c >>> 8) & 0xff) / 255;
  const y = BT601.kr * r + (1 - BT601.kr - BT601.kb) * g + BT601.kb * b;
  const cb = (b - y) / (2 * (1 - BT601.kb));
  const cr = (r - y) / (2 * (1 - BT601.kr));
  const r2 = y + 2 * (1 - BT709.kr) * cr;
  const b2 = y + 2 * (1 - BT709.kb) * cb;
  const g2 = (y - BT709.kr * r2 - BT709.kb * b2) / (1 - BT709.kr - BT709.kb);
  const q = (v: number): number => Math.min(255, Math.max(0, Math.round(v * 255)));
  return ((q(r2) << 24) | (q(g2) << 16) | (q(b2) << 8) | (c & 0xff)) >>> 0;
}

const sameSettings = (a: RenderSettings | null, b: RenderSettings): boolean =>
  !!a && a.frameWidth === b.frameWidth && a.frameHeight === b.frameHeight && a.storageWidth === b.storageWidth && a.storageHeight === b.storageHeight && a.fontScale === b.fontScale;

/**
 * Draws an ASS track onto the player canvas. It is the counterpart of libass's `ass_render_frame` plus the bitmap
 * caches, with Canvas2D doing the rasterising. It runs in the engine worker and keeps its caches within the
 * byte limits it is given.
 * @example ../examples/ass-renderer.browser.ts#construct
 */
export class AssRenderer implements TextRendererLike {
  private builder: FrameBuilder;
  private readonly rc: RasterContext;
  /** Static events, composited (null: nothing to draw). */
  private readonly cache: SizedLru<RenderedEvent | null>;
  private readonly masks: SizedLru<RunMasks>;
  private readonly layers: SizedLru<CachedLayers>;
  private cacheSettings: RenderSettings | null = null;
  private lastActive = '';
  private lastAnimated = false;
  private lastScale = 1;
  private lastSeenT: number | null = null;
  private lastRenderT = 0;
  private dirty = true;
  private lastStats: AssRenderStats = { events: 0, animated: 0, renderMs: 0, overBudget: 0, renders: 0 };
  private overBudget = 0;
  private renders = 0;

  constructor(private readonly track: AssTrack, private readonly fonts: AssFonts, private readonly deps: AssRendererDeps) {
    this.builder = new FrameBuilder(track, fonts, deps.measurer);
    this.cache = new SizedLru(deps.limits.assEventCacheBytes, eventBytes, CACHE_SIZE);
    this.masks = new SizedLru(deps.limits.assMaskCacheBytes, maskBytes);
    this.layers = new SizedLru(deps.limits.assLayerCacheBytes, layerBytes);
    this.rc = {
      createCanvas: deps.createCanvas,
      Path2D: deps.Path2D,
      masks: this.masks,
      layers: this.layers,
      lastShapes: new Map(),
      maxTextSupersampling: deps.limits.maxTextSupersampling,
      canvasFilter: deps.canvasFilter,
      ...(deps.warp ? { warp: deps.warp } : {}),
      ...(deps.colorMatrix === 'video' ? { mapColor: (c: number) => convertColor(c, track.ycbcrMatrix, 'video') } : {}),
    };
  }

  private static ms(timeUs: number, opts: TextRenderOptions): number {
    return Math.round((timeUs - opts.offsetUs) / 1000);
  }

  private activeKey(t: number): string {
    return this.builder.activeIndices(t).join(',');
  }

  /** Seen every compositor tick: a jump of over a second is a seek, which drops collision memory. */
  private see(t: number): void {
    if (this.lastSeenT !== null && Math.abs(t - this.lastSeenT) > SEEK_MS) this.reset();
    this.lastSeenT = t;
  }

  /**
   * Whether a render at `timeUs` would differ from the last one.
   * @example ../examples/ass-renderer.browser.ts#changed
   */
  changed(timeUs: number, opts: TextRenderOptions): boolean {
    const t = AssRenderer.ms(timeUs, opts);
    this.see(t);
    if (this.dirty) return true;
    // animation advances with the video's frames, or every ANIMATION_STEP_MS when none arrive (a still)
    if (this.lastAnimated && Math.abs(t - this.lastRenderT) >= ANIMATION_STEP_MS) return true;
    const key = this.activeKey(t);
    return key !== this.lastActive || (key !== '' && opts.scale !== this.lastScale);
  }

  /**
   * Whether any event shows at `timeUs`.
   * @example ../examples/ass-renderer.browser.ts#visible
   */
  visible(timeUs: number, opts: TextRenderOptions): boolean {
    return this.builder.activeIndices(AssRenderer.ms(timeUs, opts)).length > 0;
  }

  /**
   * Draws the events active at `timeUs` inside `videoRect`; returns how many were drawn.
   * @example ../examples/ass-renderer.browser.ts#render
   */
  render(ctx: OffscreenCanvasRenderingContext2D, timeUs: number, videoRect: Rect, opts: TextRenderOptions): number {
    const start = this.deps.nowMs();
    const t = AssRenderer.ms(timeUs, opts);
    const settings: RenderSettings = {
      frameWidth: Math.max(1, Math.round(videoRect.width)),
      frameHeight: Math.max(1, Math.round(videoRect.height)),
      storageWidth: opts.storage?.width ?? Math.round(videoRect.width),
      storageHeight: opts.storage?.height ?? Math.round(videoRect.height),
      fontScale: opts.scale,
    };
    if (!sameSettings(this.cacheSettings, settings)) {
      this.cache.clear();
      this.masks.clear();
      this.layers.clear();
      this.cacheSettings = settings;
    }
    const frame = this.builder.build(t, settings);
    if (this.fonts.hasPending()) {
      // faces chosen for this frame were not registered yet: measure again once they are
      void this.fonts.ready().then(() => {
        this.deps.measurer.reset?.();
        this.cache.clear();
        this.masks.clear();
        this.layers.clear();
        this.dirty = true;
      });
    }
    const size = { width: settings.frameWidth, height: settings.frameHeight };
    const draw = this.deps.renderEvent ?? renderEvent;
    let animated = 0;
    ctx.save();
    ctx.translate(videoRect.x, videoRect.y);
    for (const ev of frame.events) {
      let r: RenderedEvent | null | undefined;
      if (ev.animated) {
        animated++;
        r = draw(this.rc, ev, size);
      } else {
        r = this.cache.get(String(ev.index));
        if (r === undefined) {
          r = draw(this.rc, ev, size);
          this.cache.set(String(ev.index), r);
        }
      }
      if (r) ctx.drawImage(r.canvas, r.x, r.y + ev.shiftY);
    }
    ctx.restore();
    this.lastActive = frame.events.map((e) => e.index).sort((a, b) => a - b).join(',');
    this.lastAnimated = animated > 0;
    this.lastRenderT = t;
    this.lastScale = opts.scale;
    this.dirty = false;
    const renderMs = this.deps.nowMs() - start;
    this.renders++;
    if (renderMs > BUDGET_MS) this.overBudget++;
    this.lastStats = { events: frame.events.length, animated, renderMs, overBudget: this.overBudget, renders: this.renders };
    return frame.events.length;
  }

  /**
   * A seek or offset change: forget collision memory.
   * @example ../examples/ass-renderer.browser.ts#reset
   */
  reset(): void {
    this.builder.reset();
    this.dirty = true;
  }

  /**
   * Events were appended to the track's event list (a Matroska ASS track's blocks as they are read). Existing events
   * keep their indices, so their cached bitmaps stay; the next changed() reports a change.
   * @example ../examples/ass-renderer.browser.ts#eventsAdded
   */
  eventsAdded(): void {
    this.builder.eventsAdded();
    this.dirty = true;
  }

  /**
   * New fonts: drop layout and bitmap caches.
   * @example ../examples/ass-renderer.browser.ts#fontsChanged
   */
  fontsChanged(): void {
    this.deps.measurer.reset?.();
    this.builder = new FrameBuilder(this.track, this.fonts, this.deps.measurer);
    this.cache.clear();
    this.masks.clear();
    this.layers.clear();
    this.dirty = true;
  }

  /**
   * What the last render did and the counts since the renderer was made.
   * @example ../examples/ass-renderer.browser.ts#stats
   */
  stats(): AssRenderStats {
    return this.lastStats;
  }

  /**
   * How many static events are held in the event cache (one entry per event, including events that draw nothing).
   * @example ../examples/ass-renderer.browser.ts#cacheSize
   */
  cacheSize(): number {
    return this.cache.size;
  }
}
