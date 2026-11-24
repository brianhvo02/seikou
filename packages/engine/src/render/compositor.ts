import { PLANE_HEIGHT, PLANE_WIDTH } from '../bdj-provider';
import type { GraphicsPlaneReaderLike, ShownStill } from '../bdj-types';
import type { OverlayPlane } from '@seikou/pg';
import type { ShaderStage } from '../shaders/stage';
import type { HdrOverlayPresenter } from './hdr-presenter';
import type { Rect, TextRenderOptions, TextRendererLike } from '@seikou/ass/host-types';

/**
 * The picture's sizes on the element path, from its init segment: the size it shows at (`width`, `height`, where
 * overlays are placed) and its coded size (`codedWidth`, `codedHeight`, ASS's storage size, as a frame's visible
 * size is on the canvas path).
 * @internal
 */
export interface ElementPictureSize {
  readonly width: number;
  readonly height: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
}

export type { Rect, TextRendererLike };

/**
 * A picture the deinterlacer drew: its image (an ImageBitmap of its own at the stream's visible size, open until the
 * next picture is drawn, and the same bitmap every time the same picture is drawn again), the size it shows at, and
 * what it holds, so a shader set's result is reused while the same picture shows.
 * @internal
 */
export interface DrawnPicture {
  readonly image: ImageBitmap;
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Changes whenever another picture is drawn. */
  readonly key: object;
}

/**
 * The largest rectangle of the source's aspect ratio that fits inside the destination, centred and rounded to whole
 * pixels. Any non-positive size gives an empty rectangle at the origin.
 */
export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);
  return { x: Math.floor((dstW - width) / 2), y: Math.floor((dstH - height) / 2), width, height };
}

/**
 * What the player draws with: it owns the transferred canvas and paints the layers in order (background still, video,
 * PG, text, IG, BD-J plane). Methods marked optional are absent from the minimal fakes tests use. Runs in the engine
 * worker.
 */
export interface CompositorLike {
  /** Sets the canvas size in device pixels (at least 1×1). */
  resize(width: number, height: number): void;
  /**
   * Clears to black, draws the background still (if any), then the frame. In element mode (startPlaylist's `element`)
   * it clears to transparent and draws no video: the page's video element shows the picture under the canvas; the
   * background still is drawn only until the element shows a frame (elementFrameShown). The frame is a decoded one, or
   * a picture the deinterlacer drew.
   */
  drawVideo(frame: VideoFrame | DrawnPicture | null): void;
  /**
   * A playlist starts: the last frame's size is forgotten. With `picture` false (video the browser can't decode) text is
   * laid out over the 1920×1080 screen; otherwise none is drawn until the playlist's first frame. With `element` (the
   * picture's sizes), the page's video element shows the picture: the canvas is cleared to transparent, no video is
   * drawn, and text is laid out on the display size, with the coded size as ASS's storage size.
   */
  startPlaylist?(picture: boolean, opts?: StartPlaylistOptions): void;
  /**
   * In element mode, the page's video element shows the playlist's first frame: the BD-J background still, drawn until
   * then (it would cover the picture under the canvas), is not drawn again until the next startPlaylist.
   */
  elementFrameShown?(): void;
  /** In element mode, the picture's sizes changed (a new init segment): text is laid out on them from now on. */
  setElementSize?(size: ElementPictureSize): void;
  /**
   * The BD-J background still drawn under the video from the next drawVideo on (null: none), placed in its screen
   * rectangle of the 1920×1080 menu rectangle. The caller owns the image and closes it after replacing it here.
   */
  setBackground?(still: ShownStill | null): void;
  /** Draws the PG plane over the video just drawn: call it after every drawVideo, before drawIg. */
  drawPg?(plane: OverlayPlane): void;
  /** Draws text subtitles inside the video rectangle, after drawPg and before drawIg. */
  drawText?(renderer: TextRendererLike, timeUs: number, opts: TextRenderOptions): void;
  /** Draws the IG plane over the video (and PG) just drawn: call it after every drawVideo. */
  drawIg?(plane: OverlayPlane): void;
  /**
   * Draws the BD-J graphics plane over everything else (it takes the IG plane's place), scaled to the 1920×1080 menu
   * rectangle as IG is. Copies only what was published since the last draw (what the BD-J worker publishes while the
   * copy waits stays pending for the next draw).
   */
  drawBdj?(plane: GraphicsPlaneReaderLike): void;
  /** Forgets the BD-J plane (BD-J stopped): nothing of it is drawn again. */
  clearBdj?(): void;
  /** Bytes the compositor's copy of the BD-J plane takes (canvas and ImageData); 0 while it has none. */
  bdjBytes?(): number;
  /** Shades every video frame drawn from now on with the stage's set (null: draw frames as they are). */
  setShaderStage?(stage: ShaderStage | null): void;
  /**
   * The presenter of overlays over HDR video (null: none), with how it is used (`opts`). While the compositor is in
   * element mode for an HDR stream (startPlaylist's `hdr`) and has one, it draws its overlays on a layer of its own
   * covering only the overlay rectangle (the 1920×1080 menu rectangle and the picture's), the visible canvas keeps only
   * the BD-J background still (SDR, as it shows until the element's first frame), and present() shows the layer through
   * the presenter.
   */
  setHdrPresenter?(presenter: HdrOverlayPresenter | null, opts: HdrPresenterOptions): void;
  /** Ends a paint: in HDR overlay mode the layer just drawn goes to the presenter; otherwise nothing. */
  present?(): void;
  /** The overlays go through the HDR presenter now. */
  hdrActive?(): boolean;
  /** In HDR overlay mode, the layer's size in pixels; null outside it. */
  hdrLayerSize?(): { readonly width: number; readonly height: number } | null;
}

/**
 * How the compositor uses an HDR overlay presenter: the gain on the overlays' white (linear light), the largest layer in
 * pixels (a larger overlay rectangle is drawn smaller and stretched), and `place`, told where the layer goes over the
 * visible canvas (fractions of its width and height) whenever that changes, so the page can put the HDR canvas there.
 * @internal
 */
export interface HdrPresenterOptions {
  readonly gain: number;
  readonly maxPixels: number;
  readonly place?: (rect: Rect) => void;
}

/**
 * How a playlist starts on the compositor: `element`, the picture's sizes when the page's video element shows it, and
 * `hdr`, that element's stream is HDR.
 * @internal
 */
export interface StartPlaylistOptions {
  readonly element?: ElementPictureSize;
  readonly hdr?: boolean;
}

/** A plane's pixels at plane size, updated from its dirty rects. */
interface PlaneCanvas { readonly canvas: OffscreenCanvas; readonly ctx: OffscreenCanvasRenderingContext2D; readonly plane: OverlayPlane }

/** The BD-J plane's pixels at plane size: one canvas and one ImageData, reused while BD-J runs. */
interface BdjCanvas {
  readonly canvas: OffscreenCanvas;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  readonly image: ImageData;
  plane: GraphicsPlaneReaderLike | null;
}

/**
 * Draws planes onto the transferred canvas: the BD-J background still, video, then the PG overlay, then the IG
 * overlay, then the BD-J plane.
 */
export class Compositor implements CompositorLike {
  /** Where everything is drawn: the visible canvas, or in HDR overlay mode the layer. */
  private ctx: OffscreenCanvasRenderingContext2D;
  private readonly mainCtx: OffscreenCanvasRenderingContext2D;
  private hdrPresenter: HdrOverlayPresenter | null = null;
  private hdrOpts: HdrPresenterOptions = { gain: 1, maxPixels: Infinity };
  /** The BD-J background still was drawn on the visible canvas in HDR overlay mode, so it is cleared before the next. */
  private stillOnMain = false;
  /** The element's stream is HDR (startPlaylist's `hdr`). */
  private elementHdr = false;
  /**
   * The layer drawn in HDR overlay mode: the overlay rectangle of the visible canvas (`rect`, in its pixels) at `scale`,
   * its context transformed so everything draws at the visible canvas's coordinates; null outside it.
   */
  private layer: { readonly canvas: OffscreenCanvas; readonly ctx: OffscreenCanvasRenderingContext2D; rect: Rect | null; scale: number } | null = null;
  private pg: PlaneCanvas | null = null;
  private ig: PlaneCanvas | null = null;
  private bdj: BdjCanvas | null = null;
  /** Display size of the last frame drawn: text is laid out in its fitted rectangle. */
  private frameSize: { readonly width: number; readonly height: number } | null = null;
  /** The playlist has no picture (startPlaylist(false)): text goes over the 1920×1080 screen. */
  private noPicture = false;
  /** Storage (coded, visible) size of the last frame: ASS layout follows it for anamorphic video. */
  private storageSize: { readonly width: number; readonly height: number } | null = null;
  private stage: ShaderStage | null = null;
  private background: ShownStill | null = null;
  /** The page's video element shows the picture (startPlaylist with `element`): clear to transparent, draw no video. */
  private element = false;
  /** In element mode, the page's video element shows a frame of this playlist: the background still is not drawn. */
  private elementShown = false;

  constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly createCanvas: (width: number, height: number) => OffscreenCanvas = (w, h) => new OffscreenCanvas(w, h),
  ) {
    // with alpha, so the element path can clear to transparent; the canvas path fills opaque black under every frame
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas context is unavailable');
    this.ctx = this.mainCtx = ctx;
  }

  resize(width: number, height: number): void {
    this.canvas.width = Math.max(1, Math.round(width));
    this.canvas.height = Math.max(1, Math.round(height));
    this.layoutLayer();
  }

  setHdrPresenter(presenter: HdrOverlayPresenter | null, opts: HdrPresenterOptions): void {
    const maxChanged = opts.maxPixels !== this.hdrOpts.maxPixels;
    this.hdrOpts = opts;
    if (presenter === this.hdrPresenter) {
      if (maxChanged) this.layoutLayer();
      return;
    }
    // the one taken away shows nothing from now on
    if (this.layer) this.hdrPresenter?.clear();
    this.hdrPresenter = presenter;
    this.updateTarget();
  }

  hdrActive(): boolean {
    return this.layer !== null;
  }

  hdrLayerSize(): { readonly width: number; readonly height: number } | null {
    return this.layer ? { width: this.layer.canvas.width, height: this.layer.canvas.height } : null;
  }

  present(): void {
    if (this.layer) this.hdrPresenter?.present(this.layer.canvas, this.hdrOpts.gain);
  }

  /**
   * Sizes the layer to the overlay rectangle (the menu rectangle, and the picture's when there is one), scaled down to
   * the largest layer allowed, and tells `place` where it goes when that changed.
   */
  private layoutLayer(): void {
    const l = this.layer;
    if (!l) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    let r = fitRect(PLANE_WIDTH, PLANE_HEIGHT, cw, ch);
    if (this.frameSize) {
      const f = fitRect(this.frameSize.width, this.frameSize.height, cw, ch);
      const x = Math.min(r.x, f.x);
      const y = Math.min(r.y, f.y);
      r = { x, y, width: Math.max(r.x + r.width, f.x + f.width) - x, height: Math.max(r.y + r.height, f.y + f.height) - y };
    }
    if (r.width <= 0 || r.height <= 0) r = { x: 0, y: 0, width: Math.max(1, cw), height: Math.max(1, ch) };
    const scale = Math.min(1, Math.sqrt(this.hdrOpts.maxPixels / (r.width * r.height)));
    const width = Math.max(1, Math.round(r.width * scale));
    const height = Math.max(1, Math.round(r.height * scale));
    if (l.canvas.width !== width) l.canvas.width = width;
    if (l.canvas.height !== height) l.canvas.height = height;
    // a canvas's size change resets its transform: set every time
    l.ctx.setTransform(width / r.width, 0, 0, height / r.height, (-r.x * width) / r.width, (-r.y * height) / r.height);
    l.scale = scale;
    const old = l.rect;
    l.rect = r;
    if (!old || old.x !== r.x || old.y !== r.y || old.width !== r.width || old.height !== r.height) {
      this.hdrOpts.place?.({ x: r.x / Math.max(1, cw), y: r.y / Math.max(1, ch), width: r.width / Math.max(1, cw), height: r.height / Math.max(1, ch) });
    }
  }

  /** Enters or leaves HDR overlay mode as the element, its stream and the presenter now say. */
  private updateTarget(): void {
    const want = this.element && this.elementHdr && this.hdrPresenter !== null;
    if (want && !this.layer) {
      const canvas = this.createCanvas(1, 1);
      const ctx = canvas.getContext('2d');
      if (!ctx) return; // no layer: the overlays stay on the visible canvas
      this.layer = { canvas, ctx, rect: null, scale: 1 };
      this.ctx = ctx;
      this.layoutLayer();
      // nothing SDR stays over the video
      this.mainCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.stillOnMain = false;
    } else if (!want && this.layer) {
      this.hdrPresenter?.clear();
      this.layer.canvas.width = this.layer.canvas.height = 0;
      this.layer = null;
      this.ctx = this.mainCtx;
    }
  }

  setShaderStage(stage: ShaderStage | null): void {
    this.stage = stage;
  }

  setBackground(still: ShownStill | null): void {
    this.background = still;
  }

  drawVideo(frame: VideoFrame | DrawnPicture | null): void {
    const { width, height } = this.canvas;
    if (this.element) {
      this.ctx.clearRect(0, 0, width, height);
      if (this.stillOnMain) {
        this.mainCtx.clearRect(0, 0, width, height);
        this.stillOnMain = false;
      }
      // over the element the still would cover the picture: only until the element shows one
      if (!this.elementShown) this.drawBackground(null);
      return;
    }
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    const r = frame ? fitRect(frame.displayWidth, frame.displayHeight, width, height) : null;
    this.drawBackground(r);
    if (!frame || !r) return;
    this.frameSize = { width: frame.displayWidth, height: frame.displayHeight };
    // the shaded image is already at the fitted size (shaders see it as OUTPUT)
    const output = r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
    if ('image' in frame) {
      // a deinterlaced picture: its image is at the stream's visible size, which is the storage size
      this.storageSize = { width: frame.image.width, height: frame.image.height };
      const image = output ? this.stage?.process(frame.image, output, frame.key) : null;
      this.ctx.drawImage(image ?? frame.image, r.x, r.y, r.width, r.height);
      return;
    }
    this.storageSize = { width: frame.visibleRect?.width ?? frame.codedWidth, height: frame.visibleRect?.height ?? frame.codedHeight };
    const image = output ? this.stage?.process(frame, output) : null;
    this.ctx.drawImage(image ?? frame, r.x, r.y, r.width, r.height);
  }

  elementFrameShown(): void {
    if (this.element) this.elementShown = true;
  }

  /** The background still in its part of the screen rectangle, unless the frame drawn at `frame` covers it. */
  private drawBackground(frame: Rect | null): void {
    const bg = this.background;
    if (!bg || bg.rect.width <= 0 || bg.rect.height <= 0) return;
    const screen = fitRect(PLANE_WIDTH, PLANE_HEIGHT, this.canvas.width, this.canvas.height);
    const x = screen.x + bg.rect.x * screen.width;
    const y = screen.y + bg.rect.y * screen.height;
    const w = bg.rect.width * screen.width;
    const h = bg.rect.height * screen.height;
    // an opaque frame that covers the still hides it: no full-screen draw under every frame of a feature
    const hidden = frame !== null && frame.x <= x && frame.y <= y && frame.x + frame.width >= x + w && frame.y + frame.height >= y + h;
    if (hidden) return;
    // on the visible canvas: in HDR overlay mode the still stays SDR, as a picture (it shows under the overlays)
    this.mainCtx.drawImage(bg.image, x, y, w, h);
    if (this.layer) this.stillOnMain = true;
  }

  drawPg(plane: OverlayPlane): void {
    this.pg = this.drawPlane(this.pg, plane);
  }

  drawIg(plane: OverlayPlane): void {
    this.ig = this.drawPlane(this.ig, plane);
  }

  drawBdj(plane: GraphicsPlaneReaderLike): void {
    let b = this.bdj;
    if (!b) {
      const canvas = this.createCanvas(PLANE_WIDTH, PLANE_HEIGHT);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context is unavailable');
      b = this.bdj = { canvas, ctx, image: new ImageData(new Uint8ClampedArray(PLANE_WIDTH * PLANE_HEIGHT * 4), PLANE_WIDTH, PLANE_HEIGHT), plane: null };
    }
    const rect = plane.copyDirtyInto(b.image, b.plane !== plane);
    if (rect) {
      b.ctx.putImageData(b.image, 0, 0, rect.x, rect.y, rect.width, rect.height);
      b.plane = plane;
    }
    if (b.plane !== plane) return; // a new plane whose first copy waits for the writer: nothing stale is drawn
    const { width, height } = plane.size();
    if (width > 0 && height > 0 && plane.visible()) {
      const r = fitRect(PLANE_WIDTH, PLANE_HEIGHT, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(b.canvas, 0, 0, width, height, r.x, r.y, r.width, r.height);
    }
  }

  bdjBytes(): number {
    return this.bdj ? this.bdj.canvas.width * this.bdj.canvas.height * 4 + this.bdj.image.data.byteLength : 0;
  }

  /** Drops the plane's canvas and ImageData (about 16 MB); the next plane allocates them again. */
  clearBdj(): void {
    if (!this.bdj) return;
    this.bdj.canvas.width = this.bdj.canvas.height = 0; // let the browser free the backing store now
    this.bdj = null;
  }

  startPlaylist(picture: boolean, opts?: StartPlaylistOptions): void {
    this.frameSize = null;
    this.storageSize = null;
    this.noPicture = !picture;
    this.element = opts?.element !== undefined;
    this.elementHdr = this.element && opts?.hdr === true;
    this.elementShown = false;
    this.updateTarget();
    if (opts?.element) this.setElementSize(opts.element);
    else this.layoutLayer();
  }

  setElementSize(size: ElementPictureSize): void {
    if (!this.element) return;
    // as drawVideo does for a frame: placement on the display size, ASS's storage size the coded one
    this.frameSize = { width: size.width, height: size.height };
    this.storageSize = { width: size.codedWidth, height: size.codedHeight };
    this.layoutLayer();
  }

  drawText(renderer: TextRendererLike, timeUs: number, opts: TextRenderOptions): void {
    // no frame yet: none drawn, unless the playlist has no picture at all (then the 1920×1080 screen)
    const f = this.frameSize ?? (this.noPicture ? { width: PLANE_WIDTH, height: PLANE_HEIGHT } : null);
    if (!f) return;
    renderer.render(this.ctx, timeUs, fitRect(f.width, f.height, this.canvas.width, this.canvas.height), { ...opts, storage: opts.storage ?? this.storageSize });
  }

  private drawPlane(held: PlaneCanvas | null, plane: OverlayPlane): PlaneCanvas {
    let pc = held;
    if (!pc || pc.plane !== plane) {
      const canvas = this.createCanvas(plane.width, plane.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context is unavailable');
      pc = { canvas, ctx, plane };
      if (!plane.dirty()) pc.ctx.putImageData(new ImageData(plane.rgba({ x: 0, y: 0, w: plane.width, h: plane.height }), plane.width, plane.height), 0, 0);
    }
    const rect = plane.takeDirty();
    if (rect) {
      const x = Math.max(0, rect.x);
      const y = Math.max(0, rect.y);
      const w = Math.min(plane.width, rect.x + rect.w) - x;
      const h = Math.min(plane.height, rect.y + rect.h) - y;
      if (w > 0 && h > 0) pc.ctx.putImageData(new ImageData(plane.rgba({ x, y, w, h }), w, h), x, y);
    }
    const { width, height } = this.canvas;
    const r = fitRect(plane.width, plane.height, width, height);
    this.ctx.drawImage(pc.canvas, r.x, r.y, r.width, r.height);
    return pc;
  }
}
