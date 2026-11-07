import { describe, expect, it } from 'vitest';
import { OverlayPlane, type OverlayOp } from './overlay-plane';
import { paletteToRgba, ycrcbToRgba } from './palette';
import { cropRle } from './rle';
import type { PgPaletteEntry, RleElem } from './segments';

const Z: PgPaletteEntry = { y: 0, cr: 0, cb: 0, t: 0 };
function palette(): PgPaletteEntry[] {
  const p = new Array<PgPaletteEntry>(256).fill(Z);
  p[1] = { y: 235, cr: 128, cb: 128, t: 255 };
  p[2] = { y: 16, cr: 128, cb: 128, t: 255 };
  return p;
}
const E: RleElem = { len: 0, color: 0 };

describe('paletteToRgba', () => {
  it('maps white, black and transparent', () => {
    const rgba = paletteToRgba([{ y: 235, cr: 128, cb: 128, t: 255 }, { y: 16, cr: 128, cb: 128, t: 255 }, { y: 235, cr: 128, cb: 128, t: 0 }]);
    expect(rgba.length).toBe(256);
    expect(rgba[0]).toBe(0xffffffff);
    expect(rgba[1]).toBe(0xff000000);
    expect(rgba[2]! >>> 24).toBe(0);
    expect(rgba[200]).toBe(0);
  });
  it('converts a saturated red with BT.709 coefficients', () => {
    // BT.709 limited red: Y=63, Cb=102, Cr=240
    const [px] = paletteToRgba([{ y: 63, cr: 240, cb: 102, t: 255 }]);
    expect(px! & 0xff).toBeGreaterThan(250);
    expect((px! >> 8) & 0xff).toBeLessThan(5);
    expect((px! >> 16) & 0xff).toBeLessThan(5);
  });
});

describe('cropRle', () => {
  it('crops the right 2x1 of a 4x2 image', () => {
    // row0: AABB (1,1,2)  row1: CCCC
    const img: RleElem[] = [{ len: 1, color: 1 }, { len: 1, color: 2 }, { len: 2, color: 3 }, E, { len: 4, color: 4 }, E];
    // rle.c quirk kept: a run ending exactly at crop_x (x + len == x0) is not skipped and
    // is emitted with len 0
    expect(cropRle(img, 4, 2, 0, 2, 1)).toEqual([{ len: 0, color: 2 }, { len: 2, color: 3 }, E]);
    expect(cropRle(img, 4, 1, 1, 2, 1)).toEqual([{ len: 2, color: 4 }, E]);
    expect(cropRle(img, 4, 1, 0, 2, 1)).toEqual([{ len: 0, color: 1 }, { len: 1, color: 2 }, { len: 1, color: 3 }, E]);
    // no run touching the crop edge: clean result
    expect(cropRle([{ len: 1, color: 1 }, { len: 3, color: 3 }, E, { len: 4, color: 4 }, E], 4, 2, 0, 2, 1)).toEqual([{ len: 2, color: 3 }, E]);
  });
});

describe('OverlayPlane', () => {
  const img: RleElem[] = [{ len: 2, color: 1 }, { len: 1, color: 2 }, E, { len: 3, color: 1 }, E];
  const draw: OverlayOp = { cmd: 'draw', pts: 0, x: 10, y: 20, w: 3, h: 2, palette: palette(), img };

  it('draw + flush gives the exact dirty rect and changes the hash; wipe restores it', () => {
    const plane = new OverlayPlane();
    const empty = plane.hash();
    expect(empty).toMatch(/^[0-9a-f]{16}$/);
    plane.apply(draw);
    plane.apply({ cmd: 'flush', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.takeDirty()).toEqual({ x: 10, y: 20, w: 3, h: 2 });
    expect(plane.dirty()).toBeNull();
    expect(plane.hash()).not.toBe(empty);
    const px = plane.rgba({ x: 10, y: 20, w: 3, h: 2 });
    expect(Array.from(px.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(px.slice(8, 12))).toEqual([0, 0, 0, 255]);
    plane.apply({ cmd: 'wipe', pts: 0, x: 10, y: 20, w: 3, h: 2 });
    expect(plane.hash()).toBe(empty);
  });

  it('unions dirty rects, clips to the plane, and clear/init reset', () => {
    const plane = new OverlayPlane(64, 32);
    const empty = plane.hash();
    plane.apply({ ...draw, x: 62, y: 1 });
    expect(plane.takeDirty()).toEqual({ x: 62, y: 1, w: 2, h: 2 });
    plane.apply({ ...draw, x: 0, y: 0 });
    plane.apply({ ...draw, x: 5, y: 10 });
    expect(plane.dirty()).toEqual({ x: 0, y: 0, w: 8, h: 12 });
    plane.apply({ cmd: 'clear', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.hash()).toBe(empty);
    expect(plane.dirty()).toEqual({ x: 0, y: 0, w: 64, h: 32 });
  });

  it('ignores the len-0 element rle_crop_object can leave mid-line', () => {
    const cropped = cropRle([{ len: 1, color: 1 }, { len: 1, color: 2 }, { len: 2, color: 1 }, E], 4, 2, 0, 2, 1);
    const a = new OverlayPlane(8, 4);
    a.apply({ cmd: 'draw', pts: 0, x: 0, y: 0, w: 2, h: 1, palette: palette(), img: cropped });
    const b = new OverlayPlane(8, 4);
    b.apply({ cmd: 'draw', pts: 0, x: 0, y: 0, w: 2, h: 1, palette: palette(), img: [{ len: 2, color: 1 }, E] });
    expect(a.hash()).toBe(b.hash());
  });

  it('palette-only updates redraw with the new palette', () => {
    const plane = new OverlayPlane(16, 16);
    plane.apply({ ...draw, x: 0, y: 0 });
    const before = plane.hash();
    const pal = palette();
    pal[1] = { y: 100, cr: 128, cb: 128, t: 255 };
    plane.apply({ ...draw, x: 0, y: 0, palette: pal, paletteUpdate: true });
    expect(plane.hash()).not.toBe(before);
  });

  it('hash is FNV-1a 64 over Y,Cr,Cb,T', () => {
    const plane = new OverlayPlane(3, 2);
    plane.apply({ cmd: 'draw', pts: 0, x: 1, y: 1, w: 1, h: 1, palette: [{ y: 0x12, cr: 0x34, cb: 0x56, t: 0x78 }], img: [{ len: 1, color: 0 }, E] });
    const bytes = new Uint8Array(24);
    bytes.set([0x12, 0x34, 0x56, 0x78], (1 * 3 + 1) * 4);
    let h = 0xcbf29ce484222325n;
    for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    expect(plane.hash()).toBe(h.toString(16).padStart(16, '0'));
  });

  it('hashes and extracts a full 1920x1080 plane quickly', () => {
    const plane = new OverlayPlane();
    const t0 = performance.now();
    plane.hash();
    plane.rgba({ x: 0, y: 0, w: 64, h: 64 });
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('rgba() matches the per-pixel conversion for many colours, including after a plane change', () => {
    const plane = new OverlayPlane(64, 32);
    const pal: PgPaletteEntry[] = Array.from({ length: 256 }, (_, i) => ({ y: (i * 7) & 0xff, cr: (i * 13) & 0xff, cb: (i * 29) & 0xff, t: (i * 3) & 0xff }));
    const img: RleElem[] = [];
    for (let row = 0; row < 32; row++) {
      for (let c = 0; c < 64; c++) img.push({ len: 1, color: (row * 5 + c * 3) & 0xff });
      img.push(E);
    }
    plane.apply({ cmd: 'draw', pts: -1, x: 0, y: 0, w: 64, h: 32, palette: pal, img });
    const expectAll = (): void => {
      const out = plane.rgba({ x: 0, y: 0, w: 64, h: 32 });
      const words = new Uint32Array(out.buffer);
      for (let row = 0; row < 32; row++) {
        for (let c = 0; c < 64; c++) expect(words[row * 64 + c]).toBe(ycrcbToRgba(pal[(row * 5 + c * 3) & 0xff]));
      }
    };
    expectAll();
    expectAll(); // served from the colour cache
    plane.apply({ cmd: 'wipe', pts: -1, x: 0, y: 0, w: 64, h: 16 });
    const out = new Uint32Array(plane.rgba({ x: 0, y: 0, w: 64, h: 32 }).buffer);
    expect(out[0]).toBe(ycrcbToRgba(Z));
  });

  it('hasContent follows draws and clears', () => {
    const plane = new OverlayPlane(16, 8);
    expect(plane.hasContent).toBe(false);
    plane.apply({ cmd: 'draw', pts: -1, x: 0, y: 0, w: 2, h: 1, palette: palette(), img: [{ len: 2, color: 1 }, E] });
    expect(plane.hasContent).toBe(true);
    plane.apply({ cmd: 'clear', pts: -1, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.hasContent).toBe(false);
  });

  it('hasContent goes false once wipes cover everything drawn, and stays true while something is left', () => {
    const plane = new OverlayPlane(16, 8);
    const draw = (x: number, w: number): OverlayOp => ({ cmd: 'draw', pts: -1, x, y: 0, w, h: 1, palette: palette(), img: [{ len: w, color: 1 }, E] });
    plane.apply(draw(0, 2));
    plane.apply(draw(0, 2)); // drawn again in place
    plane.apply(draw(8, 4));
    plane.apply({ cmd: 'wipe', pts: -1, x: 0, y: 0, w: 4, h: 2 });
    expect(plane.hasContent).toBe(true); // the second object is still there
    plane.apply({ cmd: 'wipe', pts: -1, x: 9, y: 0, w: 2, h: 1 }); // part of it only
    expect(plane.hasContent).toBe(true);
    plane.apply({ cmd: 'wipe', pts: -1, x: 8, y: 0, w: 8, h: 1 });
    expect(plane.hasContent).toBe(false);
  });
});

describe('OverlayPlane buffered', () => {
  const box = (x: number, y: number, w: number, h: number): OverlayOp => ({
    cmd: 'draw', pts: 0, x, y, w, h, palette: palette(),
    img: Array.from({ length: h }, () => [{ len: w, color: 1 }, E]).flat(),
  });

  it('keeps draws in the back buffer until a flush', () => {
    const plane = new OverlayPlane(64, 32, { buffered: true });
    const empty = plane.hash();
    plane.apply(box(4, 4, 8, 2));
    expect(plane.hash()).toBe(empty);
    expect(plane.dirty()).toBeNull();
    expect(plane.hasContent).toBe(false);
    plane.apply({ cmd: 'flush', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.hash()).not.toBe(empty);
    expect(plane.dirty()).toEqual({ x: 4, y: 4, w: 8, h: 2 });
    expect(plane.hasContent).toBe(true);
    expect(plane.rgba({ x: 4, y: 4, w: 1, h: 1 })[3]).toBe(255);
  });

  it('shows a wipe after the flush only at the next flush', () => {
    const plane = new OverlayPlane(64, 32, { buffered: true });
    const empty = plane.hash();
    plane.apply(box(4, 4, 8, 2));
    plane.apply({ cmd: 'flush', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    const shown = plane.hash();
    plane.takeDirty();
    plane.apply({ cmd: 'wipe', pts: -1, x: 4, y: 4, w: 8, h: 2 });
    plane.apply({ cmd: 'hide', pts: -1, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.hash()).toBe(shown);
    expect(plane.dirty()).toBeNull();
    plane.apply({ cmd: 'flush', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.hash()).toBe(empty);
    expect(plane.dirty()).toEqual({ x: 4, y: 4, w: 8, h: 2 });
  });

  it('hasContent follows the visible buffer: false after a flush commits wipes of everything drawn', () => {
    const plane = new OverlayPlane(64, 32, { buffered: true });
    plane.apply(box(4, 4, 8, 2));
    plane.apply({ cmd: 'flush', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    plane.apply({ cmd: 'wipe', pts: -1, x: 4, y: 4, w: 8, h: 2 });
    expect(plane.hasContent).toBe(true); // not committed yet
    plane.apply({ cmd: 'flush', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.hasContent).toBe(false);
  });

  it('clear empties both buffers', () => {
    const plane = new OverlayPlane(64, 32, { buffered: true });
    const empty = plane.hash();
    plane.apply(box(0, 0, 4, 4));
    plane.apply({ cmd: 'flush', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    plane.apply(box(10, 10, 4, 4));
    plane.apply({ cmd: 'clear', pts: -1, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.hash()).toBe(empty);
    plane.apply({ cmd: 'flush', pts: 0, x: 0, y: 0, w: 0, h: 0 });
    expect(plane.hash()).toBe(empty);
    expect(plane.hasContent).toBe(false);
  });
});
