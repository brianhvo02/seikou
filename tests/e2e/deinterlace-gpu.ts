// SPDX-License-Identifier: LGPL-3.0-or-later
// Bundled into a blank page by deinterlace.spec.ts (esbuild, at test time): runs the deinterlacer's WebGL2 backend on
// fixture frames and compares it with the CPU references it was written against, so the GPU passes are checked in each
// browser's real WebGL2. Luma goes in with neutral chroma, so the picture comes back grey: R = G = B, the luma mapped
// from limited to full range as the colour pass does.

import { bwdifField, bwdifIntraField } from '../../packages/engine/src/deinterlace/bwdif-cpu';
import type { FrameMetrics } from '../../packages/engine/src/deinterlace/cadence';
import type { DeinterlaceBackend } from '../../packages/engine/src/deinterlace/deinterlacer';
import { createGlDeinterlaceBackend } from '../../packages/engine/src/deinterlace/gl-backend';
import { frameMetrics, type Plane } from '../../packages/engine/src/deinterlace/metrics-cpu';

/** A run of luma frames from fixtures/synthetic/deinterlace-ref, `width` x `height` each, one after another (base64). */
export interface LumaFrames {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly base64: string;
}

/** One comparison: what was checked and how it went (`maxDiff` in 8-bit RGB levels for pictures). */
export interface GpuCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** What the page answers: null when the backend can't be made here (no WebGL2), else every check. */
export type GpuReport = { readonly unavailable: string } | { readonly checks: readonly GpuCheck[] };

declare global {
  interface Window {
    /** Runs every check over the video (top field first, true interlaced) and telecine frames. */
    deinterlaceGpuChecks(video: LumaFrames, telecine: LumaFrames): Promise<GpuReport>;
  }
}

function planesOf(input: LumaFrames): Plane[] {
  const bytes = Uint8Array.from(atob(input.base64), (c) => c.charCodeAt(0));
  const size = input.width * input.height;
  return Array.from({ length: input.frames }, (_, i) => ({ width: input.width, height: input.height, stride: input.width, data: bytes.subarray(i * size, (i + 1) * size) }));
}

/** The plane as I420 with neutral chroma, as the backend uploads a decoded frame. */
function upload(backend: DeinterlaceBackend, slot: number, plane: Plane): void {
  const { width, height } = plane;
  const cw = width / 2;
  const ch = height / 2;
  const data = new Uint8Array(width * height + 2 * cw * ch).fill(128);
  data.set(plane.data.subarray(0, width * height));
  backend.upload(slot, {
    format: 'I420',
    width,
    height,
    data,
    layout: [
      { offset: 0, stride: width },
      { offset: width * height, stride: cw },
      { offset: width * height + cw * ch, stride: cw },
    ],
    matrix: 'bt709',
  });
}

/** A frame's chroma: U and V planes at half size, as the deinterlacer gets them from a 4:2:0 frame. */
interface Chroma {
  readonly u: Plane;
  readonly v: Plane;
}

/**
 * Chroma made from a luma plane with each chroma row taken from its own field: row j (the top field's when j is even,
 * the bottom field's when odd, as in an interlaced 4:2:0 frame) from luma row 2j + (j & 1), so the two fields' chroma
 * differs wherever the picture moves and a field parity mixed up in a pass shows. Kept within 96-159 (U) and 96-160
 * (V) so little of the picture clips in RGB.
 */
function fieldChroma(luma: Plane): Chroma {
  const cw = luma.width / 2;
  const ch = luma.height / 2;
  const u = new Uint8Array(cw * ch);
  const v = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    const row = 2 * j + (j & 1);
    for (let i = 0; i < cw; i++) {
      u[j * cw + i] = 96 + (luma.data[row * luma.stride + 2 * i]! >> 2);
      v[j * cw + i] = 160 - (luma.data[row * luma.stride + 2 * i + 1]! >> 2);
    }
  }
  return { u: { width: cw, height: ch, stride: cw, data: u }, v: { width: cw, height: ch, stride: cw, data: v } };
}

/** Uploads luma and chroma as I420 or as NV12 (Safari's frames are NV12, Chrome's I420). */
function uploadYuv(backend: DeinterlaceBackend, slot: number, luma: Plane, chroma: Chroma, format: 'I420' | 'NV12'): void {
  const { width, height } = luma;
  const cw = width / 2;
  const ch = height / 2;
  const data = new Uint8Array(width * height + 2 * cw * ch);
  data.set(luma.data.subarray(0, width * height));
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const u = chroma.u.data[j * cw + i]!;
      const v = chroma.v.data[j * cw + i]!;
      if (format === 'I420') {
        data[width * height + j * cw + i] = u;
        data[width * height + cw * ch + j * cw + i] = v;
      } else {
        data[width * height + j * width + 2 * i] = u;
        data[width * height + j * width + 2 * i + 1] = v;
      }
    }
  }
  const layout =
    format === 'I420'
      ? [{ offset: 0, stride: width }, { offset: width * height, stride: cw }, { offset: width * height + cw * ch, stride: cw }]
      : [{ offset: 0, stride: width }, { offset: width * height, stride: width }];
  backend.upload(slot, { format, width, height, data, layout, matrix: 'bt709' });
}

/**
 * The CPU reference of the colour pass (written from its definition, not from the shader): luma row y from frame A when
 * y is even and B when odd, chroma row j from A when j is even and B when odd (an interlaced frame's chroma rows
 * alternate fields as its luma rows do), chroma upsampled bilinearly with sample (i, j) at luma column 2i and row
 * 2j + 0.5, limited-range BT.709 to RGB, clipped and rounded. RGBA, top row first.
 */
function cpuColour(yA: Plane, yB: Plane, cA: Chroma, cB: Chroma): Uint8Array {
  const { width, height } = yA;
  const cw = cA.u.width;
  const ch = cA.u.height;
  const kr = 0.2126;
  const kb = 0.0722;
  const out = new Uint8Array(width * height * 4);
  const chromaAt = (i: number, j: number): [number, number] => {
    const ci = Math.min(Math.max(i, 0), cw - 1);
    const cj = Math.min(Math.max(j, 0), ch - 1);
    const c = (cj & 1) === 0 ? cA : cB;
    return [c.u.data[cj * c.u.stride + ci]!, c.v.data[cj * c.v.stride + ci]!];
  };
  const mix = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let y = 0; y < height; y++) {
    const l = (y & 1) === 0 ? yA : yB;
    const cy = (y - 0.5) * 0.5;
    const j = Math.floor(cy);
    const fy = cy - j;
    for (let x = 0; x < width; x++) {
      const i = x >> 1;
      const fx = (x & 1) === 0 ? 0 : 0.5;
      const [cb, cr] = mix(mix(chromaAt(i, j), chromaAt(i + 1, j), fx), mix(chromaAt(i, j + 1), chromaAt(i + 1, j + 1), fx), fy).map((c) => (c - 128) / 224) as [number, number];
      const yy = (l.data[y * l.stride + x]! - 16) / 219;
      const r = yy + 2 * (1 - kr) * cr;
      const b = yy + 2 * (1 - kb) * cb;
      const g = (yy - kr * r - kb * b) / (1 - kr - kb);
      const o = (y * width + x) * 4;
      [r, g, b].forEach((c, k) => (out[o + k] = Math.round(Math.min(1, Math.max(0, c)) * 255)));
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Every channel of the backend's canvas, top row first. */
function readRgba(canvas: OffscreenCanvas): Uint8Array {
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const rgba = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  const rowBytes = canvas.width * 4;
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < canvas.height; y++) out.set(rgba.subarray((canvas.height - 1 - y) * rowBytes, (canvas.height - y) * rowBytes), y * rowBytes);
  return out;
}

/** The red channel of the backend's canvas, top row first (the default framebuffer, read straight from WebGL). */
function readGrey(canvas: OffscreenCanvas): Uint8Array {
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  const { width, height } = canvas;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const rgba = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = rgba[((height - 1 - y) * width + x) * 4]!;
  return out;
}

/** What the colour pass makes of a luma plane with neutral chroma: limited range to full, rounded to 8 bits. */
function expectedGrey(luma: Plane): Uint8Array {
  const out = new Uint8Array(luma.width * luma.height);
  for (let y = 0; y < luma.height; y++) {
    for (let x = 0; x < luma.width; x++) {
      const v = (luma.data[y * luma.stride + x]! - 16) / 219;
      out[y * luma.width + x] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return out;
}

/** Plain field interpolation, as the fall-back path draws it: rows of the kept field copied, the others the average of the rows above and below. */
function lineAveraged(cur: Plane, parity: 0 | 1): Plane {
  const { width, height } = cur;
  const data = new Uint8Array(width * height);
  const at = (x: number, y: number): number => cur.data[y * cur.stride + x]!;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = ((y ^ parity) & 1) === 0 ? at(x, y) : (at(x, y > 0 ? y - 1 : y + 1) + at(x, y + 1 < height ? y + 1 : y - 1)) >> 1;
    }
  }
  return { width, height, stride: width, data };
}

function compare(name: string, actual: Uint8Array, expected: Uint8Array): GpuCheck {
  let maxDiff = 0;
  let differing = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(actual[i]! - expected[i]!);
    if (d) differing++;
    maxDiff = Math.max(maxDiff, d);
  }
  return { name, ok: maxDiff === 0, detail: `maxDiff ${maxDiff}, ${differing} of ${expected.length} pixels differ` };
}

/**
 * A drawn picture against the CPU colour pass: the GPU's float arithmetic may round a value lying on .5 the other
 * way, so a pixel may be one level off, on at most 0.1% of the channels; anything more is a fault.
 */
function compareColour(name: string, actual: Uint8Array, expected: Uint8Array): GpuCheck {
  let maxDiff = 0;
  let offByOne = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(actual[i]! - expected[i]!);
    if (d === 1) offByOne++;
    maxDiff = Math.max(maxDiff, d);
  }
  const ok = maxDiff <= 1 && offByOne <= expected.length * 0.001;
  return { name, ok, detail: `maxDiff ${maxDiff}, ${offByOne} of ${expected.length} channel values one level off` };
}

function compareMetrics(name: string, gpu: FrameMetrics, cpu: FrameMetrics): GpuCheck {
  const ok = (Object.keys(cpu) as (keyof FrameMetrics)[]).every((k) => gpu[k] === cpu[k]);
  return { name, ok, detail: ok ? JSON.stringify(gpu) : `gpu ${JSON.stringify(gpu)} cpu ${JSON.stringify(cpu)}` };
}

async function metricsChecks(label: string, planes: Plane[]): Promise<GpuCheck[]> {
  const { width, height } = planes[0]!;
  const backend = createGlDeinterlaceBackend(width, height, planes.length);
  if (!backend) throw new Error('no backend');
  try {
    planes.forEach((p, i) => upload(backend, i, p));
    const checks: GpuCheck[] = [];
    for (const order of ['tff', 'bff'] as const) {
      for (let i = 0; i < planes.length; i++) {
        const prev = i > 0 ? i - 1 : null;
        const next = i + 1 < planes.length ? i + 1 : null;
        const gpu = await backend.measure(prev, i, next, order);
        const cpu = frameMetrics(prev === null ? null : planes[prev]!, planes[i]!, next === null ? null : planes[next]!, order);
        checks.push(compareMetrics(`${label} metrics, frame ${i}, ${order}`, gpu, cpu));
      }
    }
    return checks;
  } finally {
    backend.dispose();
  }
}

function pictureChecks(planes: Plane[]): GpuCheck[] {
  const { width, height } = planes[0]!;
  const backend = createGlDeinterlaceBackend(width, height, 3);
  if (!backend) throw new Error('no backend');
  try {
    const checks: GpuCheck[] = [];
    const draw = (name: string, op: Parameters<DeinterlaceBackend['render']>[0], slots: { prev: number | null; cur: number; next: number | null }, order: 'tff' | 'bff', cheap: boolean, expected: Plane) =>
      checks.push(compare(name, readGrey(backend.render(op, slots, order, 'bt709', cheap)), expectedGrey(expected)));
    // frames 1, 2, 3 of the clip in slots 0, 1, 2: frame 2 is the current one
    const [prev, cur, next] = [planes[1]!, planes[2]!, planes[3]!];
    [prev, cur, next].forEach((p, i) => upload(backend, i, p));
    const all = { prev: 0, cur: 1, next: 2 };
    draw('weave', { kind: 'weave' }, all, 'tff', false, cur);
    for (const order of ['tff', 'bff'] as const) {
      for (const field of ['top', 'bottom'] as const) {
        const parity = field === 'top' ? 0 : 1;
        draw(`bwdif ${field} field, ${order}`, { kind: 'interpolate', field }, all, order, false, bwdifField(prev, cur, next, parity, order === 'tff'));
        draw(`fall-back (line averaging) ${field} field, ${order}`, { kind: 'interpolate', field }, all, order, true, lineAveraged(cur, parity));
      }
    }
    draw("bwdif's first field of a stream (no previous frame)", { kind: 'interpolate', field: 'top' }, { prev: null, cur: 1, next: 2 }, 'tff', false, bwdifIntraField(cur, 0));

    // chroma: every op in I420 and NV12 against the CPU colour pass, with chroma that differs between the fields
    const chroma = [prev, cur, next].map(fieldChroma) as [Chroma, Chroma, Chroma];
    const [cp, cc, cn] = chroma;
    const each = (f: (p: Plane) => Plane): Chroma => ({ u: f(cc.u), v: f(cc.v) });
    const bwdifChroma = (parity: 0 | 1, tff: boolean): Chroma => ({ u: bwdifField(cp.u, cc.u, cn.u, parity, tff), v: bwdifField(cp.v, cc.v, cn.v, parity, tff) });
    type Op = Parameters<DeinterlaceBackend['render']>[0];
    const cases: Array<{ name: string; op: Op; order: 'tff' | 'bff'; cheap?: boolean; slots?: { prev: number | null; cur: number; next: number | null }; expected: () => Uint8Array }> = [
      { name: 'weave', op: { kind: 'weave' }, order: 'tff', expected: () => cpuColour(cur, cur, cc, cc) },
    ];
    for (const order of ['tff', 'bff'] as const) {
      const tff = order === 'tff';
      // a match is cur's first field with the previous frame's second, or the next frame's first field with cur's second
      const firstSecond = (first: [Plane, Chroma], second: [Plane, Chroma]): Uint8Array =>
        tff ? cpuColour(first[0], second[0], first[1], second[1]) : cpuColour(second[0], first[0], second[1], first[1]);
      cases.push(
        { name: `match with the previous frame, ${order}`, op: { kind: 'match', with: 'prev' }, order, expected: () => firstSecond([cur, cc], [prev, cp]) },
        { name: `match with the next frame, ${order}`, op: { kind: 'match', with: 'next' }, order, expected: () => firstSecond([next, cn], [cur, cc]) },
      );
      for (const field of ['top', 'bottom'] as const) {
        const parity = field === 'top' ? 0 : 1;
        cases.push(
          { name: `bwdif ${field} field, ${order}`, op: { kind: 'interpolate', field }, order, expected: () => { const l = bwdifField(prev, cur, next, parity, tff); const c = bwdifChroma(parity, tff); return cpuColour(l, l, c, c); } },
          { name: `fall-back ${field} field, ${order}`, op: { kind: 'interpolate', field }, order, cheap: true, expected: () => { const l = lineAveraged(cur, parity); const c = each((p) => lineAveraged(p, parity)); return cpuColour(l, l, c, c); } },
        );
      }
    }
    cases.push({
      name: "bwdif's first field of a stream",
      op: { kind: 'interpolate', field: 'top' },
      order: 'tff',
      slots: { prev: null, cur: 1, next: 2 },
      expected: () => { const l = bwdifIntraField(cur, 0); const c = each((p) => bwdifIntraField(p, 0)); return cpuColour(l, l, c, c); },
    });
    for (const format of ['I420', 'NV12'] as const) {
      [prev, cur, next].forEach((p, i) => uploadYuv(backend, i, p, chroma[i]!, format));
      for (const c of cases) checks.push(compareColour(`colour ${format}: ${c.name}`, readRgba(backend.render(c.op, c.slots ?? all, c.order, 'bt709', c.cheap ?? false)), c.expected()));
    }
    return checks;
  } finally {
    backend.dispose();
  }
}

window.deinterlaceGpuChecks = async (video, telecine) => {
  const probe = createGlDeinterlaceBackend(2, 2, 1);
  if (!probe) return { unavailable: 'no WebGL2 deinterlace backend in this browser (OffscreenCanvas, WebGL2 or a program failed)' };
  probe.dispose();
  const videoPlanes = planesOf(video);
  const telecinePlanes = planesOf(telecine);
  return {
    checks: [...(await metricsChecks('video', videoPlanes)), ...(await metricsChecks('telecine', telecinePlanes)), ...pictureChecks(videoPlanes)],
  };
};
