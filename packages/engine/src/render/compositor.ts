import { PLANE_HEIGHT, PLANE_WIDTH } from '../bdj-provider';
import type { GraphicsPlaneReaderLike, ShownStill } from '../bdj-types';
import type { OverlayPlane } from '@seikou/pg';
import type { ShaderStage } from '../shaders/stage';
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
  startPlaylist?(picture: boolean, opts?: { readonly element?: ElementPictureSize }): void;
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
  private readonly ctx: OffscreenCanvasRenderingContext2D;
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
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.canvas.width = Math.max(1, Math.round(width));
    this.canvas.height = Math.max(1, Math.round(height));
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
    if (!hidden) this.ctx.drawImage(bg.image, x, y, w, h);
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

  startPlaylist(picture: boolean, opts?: { readonly element?: ElementPictureSize }): void {
    this.frameSize = null;
    this.storageSize = null;
    this.noPicture = !picture;
    this.element = opts?.element !== undefined;
    this.elementShown = false;
    if (opts?.element) this.setElementSize(opts.element);
  }

  setElementSize(size: ElementPictureSize): void {
    if (!this.element) return;
    // as drawVideo does for a frame: placement on the display size, ASS's storage size the coded one
    this.frameSize = { width: size.width, height: size.height };
    this.storageSize = { width: size.codedWidth, height: size.codedHeight };
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
