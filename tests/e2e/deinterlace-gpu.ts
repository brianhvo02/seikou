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

/**
 * The plane with chroma made from it (the luma's even rows and columns, and its inverse), as I420 or as NV12: the
 * same picture either way, for checking that both chroma layouts draw alike.
 */
function uploadWithChroma(backend: DeinterlaceBackend, slot: number, plane: Plane, format: 'I420' | 'NV12'): void {
  const { width, height } = plane;
  const cw = width / 2;
  const ch = height / 2;
  const data = new Uint8Array(width * height + 2 * cw * ch);
  data.set(plane.data.subarray(0, width * height));
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const u = plane.data[2 * j * plane.stride + 2 * i]!;
      const v = 255 - u;
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

/** Every channel of the backend's canvas, top row first. */
function readRgba(canvas: OffscreenCanvas): Uint8Array {
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const rgba = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  return rgba;
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

    // chroma: NV12 (Safari's frames) draws exactly as I420 (Chrome's) does, in every op
    const ops: Array<[string, Parameters<DeinterlaceBackend['render']>[0]]> = [
      ['weave', { kind: 'weave' }],
      ['match with the previous frame', { kind: 'match', with: 'prev' }],
      ['bwdif top field', { kind: 'interpolate', field: 'top' }],
      ['bwdif bottom field', { kind: 'interpolate', field: 'bottom' }],
    ];
    const drawn = (format: 'I420' | 'NV12'): Uint8Array[] => {
      [prev, cur, next].forEach((p, i) => uploadWithChroma(backend, i, p, format));
      return ops.map(([, op]) => readRgba(backend.render(op, all, 'tff', 'bt709', false)));
    };
    const i420 = drawn('I420');
    const nv12 = drawn('NV12');
    ops.forEach(([name], k) => checks.push(compare(`NV12 chroma draws as I420's: ${name}`, nv12[k]!, i420[k]!)));
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
