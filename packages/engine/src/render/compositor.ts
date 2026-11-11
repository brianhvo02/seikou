import { PLANE_HEIGHT, PLANE_WIDTH } from '../bdj-provider';
import type { GraphicsPlaneReaderLike, ShownStill } from '../bdj-types';
import type { OverlayPlane } from '@seikou/pg';
import type { ShaderStage } from '../shaders/stage';
import type { Rect, TextRenderOptions, TextRendererLike } from '@seikou/ass/host-types';

export type { Rect, TextRendererLike };

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
  /** Clears to black, draws the background still (if any), then the frame. */
  drawVideo(frame: VideoFrame | null): void;
  /**
   * A playlist starts: the last frame's size is forgotten. With `picture` false (video the browser can't decode) text is
   * laid out over the 1920×1080 screen; otherwise none is drawn until the playlist's first frame.
   */
  startPlaylist?(picture: boolean): void;
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

  constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly createCanvas: (width: number, height: number) => OffscreenCanvas = (w, h) => new OffscreenCanvas(w, h),
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
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

  drawVideo(frame: VideoFrame | null): void {
    const { width, height } = this.canvas;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    const r = frame ? fitRect(frame.displayWidth, frame.displayHeight, width, height) : null;
    const bg = this.background;
    if (bg && bg.rect.width > 0 && bg.rect.height > 0) {
      const screen = fitRect(PLANE_WIDTH, PLANE_HEIGHT, width, height);
      const x = screen.x + bg.rect.x * screen.width;
      const y = screen.y + bg.rect.y * screen.height;
      const w = bg.rect.width * screen.width;
      const h = bg.rect.height * screen.height;
      // an opaque frame that covers the still hides it: no full-screen draw under every frame of a feature
      const hidden = r !== null && r.x <= x && r.y <= y && r.x + r.width >= x + w && r.y + r.height >= y + h;
      if (!hidden) this.ctx.drawImage(bg.image, x, y, w, h);
    }
    if (!frame || !r) return;
    this.frameSize = { width: frame.displayWidth, height: frame.displayHeight };
    this.storageSize = { width: frame.visibleRect?.width ?? frame.codedWidth, height: frame.visibleRect?.height ?? frame.codedHeight };
    // the shaded image is already at the fitted size (shaders see it as OUTPUT)
    const image = r.width > 0 && r.height > 0 ? this.stage?.process(frame, { width: r.width, height: r.height }) : null;
    this.ctx.drawImage(image ?? frame, r.x, r.y, r.width, r.height);
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

  startPlaylist(picture: boolean): void {
    this.frameSize = null;
    this.storageSize = null;
    this.noPicture = !picture;
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
