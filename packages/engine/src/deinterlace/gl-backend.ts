// SPDX-License-Identifier: LGPL-3.0-or-later
// The deinterlacer's WebGL2 backend: a ring of plane textures (luma and 4:2:0 chroma, unsigned-integer textures so
// every pass works on the codec's 8-bit values exactly), the field measurements as GPU passes reduced to a few
// integers read back through a pixel-pack buffer and a fence, and the picture passes (bwdif from `gl-shaders.ts`,
// weave and field match) ending in one YUV to RGB pass into the output canvas. The measurement and colour shaders
// here are original code; they count exactly what `metrics-cpu.ts` counts, so the two can be compared.

import type { FrameMetrics, PictureOp } from './cadence';
import type { DeinterlaceBackend } from './deinterlacer';
import type { YuvPlanes } from './field-input';
import { bwdifFragment, type BwdifPlane } from './gl-shaders';
import { COMB_CELL, COMB_LEVEL } from './metrics-cpu';

const VERTEX = `#version 300 es
void main() {
  // One triangle over the whole viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
`;

/** The side of the square blocks the first measurement pass counts in (a divisor of `COMB_CELL`). */
const BLOCK = 8;

/**
 * Measurement pass 1: one fragment per 8x8 block of the luma counts the combing pixels of each pairing (the woven
 * frame; the top field of `cur` with the previous and next frames' bottom fields; its bottom field with their top
 * fields) and sums |cur - prev|. A pixel combs as `FrameMetrics` defines it (`metrics-cpu.ts`'s combSign over three
 * neighbouring columns). Out: r = woven | topPrev << 8, g = bottomPrev | topNext << 8, b = bottomNext, a = the sum.
 */
const BLOCK_FRAGMENT = `${HEADER}
uniform usampler2D cur, prv, nxt;
uniform ivec2 u_size;
out uvec4 o;

int Cv(int x, int y) { return int(texelFetch(cur, ivec2(x, y), 0).r); }
int Pv(int x, int y) { return int(texelFetch(prv, ivec2(x, y), 0).r); }
int Nv(int x, int y) { return int(texelFetch(nxt, ivec2(x, y), 0).r); }

int combSign(int c, int up, int down, int up2, int down2) {
  int du = c - up;
  int dd = c - down;
  if ((du > 0) != (dd > 0) || du == 0 || dd == 0) return 0;
  int apart = min(abs(du), abs(dd));
  if (apart <= ${COMB_LEVEL}) return 0;
  if (abs(2 * c - up2 - down2) >= 2 * apart) return 0;
  return du > 0 ? 1 : -1;
}

// The comb signs at (x, y) of the woven frame (w) and of the pairings (s: topPrev, bottomPrev, topNext, bottomNext).
void signsAt(int x, int y, out int w, out ivec4 s) {
  int c0 = Cv(x, y - 2), c1 = Cv(x, y - 1), c2 = Cv(x, y), c3 = Cv(x, y + 1), c4 = Cv(x, y + 2);
  int p0 = Pv(x, y - 2), p1 = Pv(x, y - 1), p2 = Pv(x, y), p3 = Pv(x, y + 1), p4 = Pv(x, y + 2);
  int n0 = Nv(x, y - 2), n1 = Nv(x, y - 1), n2 = Nv(x, y), n3 = Nv(x, y + 1), n4 = Nv(x, y + 2);
  w = combSign(c2, c1, c3, c0, c4);
  // A row of cur's own field keeps cur's rows two away and takes the other frame's rows above and below; a row of
  // the other field is the other frame's, between cur's rows.
  int prevOwn = combSign(c2, p1, p3, c0, c4);
  int prevOther = combSign(p2, c1, c3, p0, p4);
  int nextOwn = combSign(c2, n1, n3, c0, c4);
  int nextOther = combSign(n2, c1, c3, n0, n4);
  bool even = (y & 1) == 0;
  s = even ? ivec4(prevOwn, prevOther, nextOwn, nextOther) : ivec4(prevOther, prevOwn, nextOther, nextOwn);
}

void main() {
  int W = u_size.x;
  int H = u_size.y;
  int x0 = int(gl_FragCoord.x) * ${BLOCK};
  int x1 = min(x0 + ${BLOCK}, W);
  int y0 = int(gl_FragCoord.y) * ${BLOCK};
  uint woven = 0u;
  uvec4 pairs = uvec4(0u);
  uint diff = 0u;
  for (int py = 0; py < ${BLOCK}; py++) {
    int y = y0 + py;
    if (y >= H) break;
    for (int x = x0; x < x1; x++) diff += uint(abs(Cv(x, y) - Pv(x, y)));
    if (y < 2 || y > H - 3) continue;
    int xs = max(x0, 1);
    int xe = min(x1, W - 1);
    if (xs >= xe) continue;
    int wl, wm, wr;
    ivec4 l, m, r;
    signsAt(xs - 1, y, wl, l);
    signsAt(xs, y, wm, m);
    for (int x = xs; x < xe; x++) {
      signsAt(x + 1, y, wr, r);
      if (wm != 0 && wl == wm && wr == wm) woven++;
      pairs += uvec4(notEqual(m, ivec4(0))) * uvec4(equal(l, m)) * uvec4(equal(r, m));
      wl = wm; wm = wr;
      l = m; m = r;
    }
  }
  o = uvec4(woven | (pairs.x << 8), pairs.y | (pairs.z << 8), pairs.w, diff);
}
`;

const BLOCKS_PER_CELL = COMB_CELL / BLOCK;

/**
 * Measurement pass 2: one fragment per comb cell sums its blocks. Out: r = woven | topPrev << 16,
 * g = bottomPrev | topNext << 16, b = bottomNext, a = the difference sum.
 */
const CELL_FRAGMENT = `${HEADER}
uniform usampler2D blocks;
uniform ivec2 u_blocks;
out uvec4 o;
void main() {
  int bx0 = int(gl_FragCoord.x) * ${BLOCKS_PER_CELL};
  int by0 = int(gl_FragCoord.y) * ${BLOCKS_PER_CELL};
  uint w = 0u, tp = 0u, bp = 0u, tn = 0u, bn = 0u, d = 0u;
  for (int j = 0; j < ${BLOCKS_PER_CELL}; j++) {
    int by = by0 + j;
    if (by >= u_blocks.y) break;
    for (int i = 0; i < ${BLOCKS_PER_CELL}; i++) {
      int bx = bx0 + i;
      if (bx >= u_blocks.x) break;
      uvec4 v = texelFetch(blocks, ivec2(bx, by), 0);
      w += v.r & 255u;
      tp += v.r >> 8;
      bp += v.g & 255u;
      tn += v.g >> 8;
      bn += v.b;
      d += v.a;
    }
  }
  o = uvec4(w | (tp << 16), bp | (tn << 16), bn, d);
}
`;

/**
 * Measurement pass 3, drawn 3x1: every fragment reduces the cells to the largest 2x2-cell window count of each of
 * the five pairings (windows start at every cell but the last column and row, one column or row when the picture is
 * a cell across or down, cells past the edge counting 0) and the whole-frame totals; fragment x writes its share.
 * Out: x 0 = window maxima of woven, topPrev, bottomPrev, topNext; x 1 = bottomNext's window maximum and the totals
 * of topPrev, bottomPrev, topNext; x 2 = bottomNext's total and the difference sum.
 */
const FINAL_FRAGMENT = `${HEADER}
uniform usampler2D cells;
uniform ivec2 u_cells;
out uvec4 o;
uint part(uvec4 v, int k) {
  if (k == 0) return v.r & 65535u;
  if (k == 1) return v.r >> 16;
  if (k == 2) return v.g & 65535u;
  if (k == 3) return v.g >> 16;
  return v.b;
}
uvec4 cellAt(int i, int j) {
  if (i >= u_cells.x || j >= u_cells.y) return uvec4(0u);
  return texelFetch(cells, ivec2(i, j), 0);
}
void main() {
  uint wmax[5] = uint[5](0u, 0u, 0u, 0u, 0u);
  uint total[5] = uint[5](0u, 0u, 0u, 0u, 0u);
  uint diff = 0u;
  int wi = max(1, u_cells.x - 1);
  int wj = max(1, u_cells.y - 1);
  for (int j = 0; j < u_cells.y; j++) {
    for (int i = 0; i < u_cells.x; i++) {
      uvec4 a = cellAt(i, j);
      diff += a.a;
      for (int k = 0; k < 5; k++) total[k] += part(a, k);
      if (i >= wi || j >= wj) continue;
      uvec4 b = cellAt(i + 1, j);
      uvec4 c = cellAt(i, j + 1);
      uvec4 d = cellAt(i + 1, j + 1);
      for (int k = 0; k < 5; k++) wmax[k] = max(wmax[k], part(a, k) + part(b, k) + part(c, k) + part(d, k));
    }
  }
  int x = int(gl_FragCoord.x);
  if (x == 0) o = uvec4(wmax[0], wmax[1], wmax[2], wmax[3]);
  else if (x == 1) o = uvec4(wmax[4], total[1], total[2], total[3]);
  else o = uvec4(total[4], diff, 0u, 0u);
}
`;

/** How the colour pass reads chroma: I420's U and V textures, or one two-component texture (NV12, or bwdif's output). */
type ChromaKind = 'i420' | 'rg';

/**
 * The colour pass, into the output canvas: luma row y from `yA` when y is even and `yB` when odd, chroma row j
 * likewise by j's parity (4:2:0 chroma of an interlaced frame is field-based: its even rows belong to the top field),
 * so one pass draws a woven frame (A = B), a field match (A and B the two frames) or a bwdif picture (A = B, the
 * picture's planes). Chroma is upsampled bilinearly with each sample at luma column 2i and row 2j + 0.5 (the woven
 * position of both fields' samples), then limited-range YUV becomes RGB with the matrix's Kr and Kb.
 */
function convertFragment(chroma: ChromaKind): string {
  const samplers = chroma === 'i420' ? 'uniform usampler2D uA, vA, uB, vB;' : 'uniform usampler2D cA, cB;';
  const fetch =
    chroma === 'i420'
      ? `(j & 1) == 0 ? vec2(float(texelFetch(uA, p, 0).r), float(texelFetch(vA, p, 0).r)) : vec2(float(texelFetch(uB, p, 0).r), float(texelFetch(vB, p, 0).r))`
      : `(j & 1) == 0 ? vec2(texelFetch(cA, p, 0).rg) : vec2(texelFetch(cB, p, 0).rg)`;
  return `${HEADER}
uniform usampler2D yA, yB;
${samplers}
uniform ivec2 u_size;
uniform ivec2 u_csize;
uniform vec2 u_k;
out vec4 o;
vec2 chromaAt(int i, int j) {
  ivec2 p = ivec2(clamp(i, 0, u_csize.x - 1), clamp(j, 0, u_csize.y - 1));
  j = p.y;
  return ${fetch};
}
void main() {
  int x = int(gl_FragCoord.x);
  int y = u_size.y - 1 - int(gl_FragCoord.y);
  float luma = float((y & 1) == 0 ? texelFetch(yA, ivec2(x, y), 0).r : texelFetch(yB, ivec2(x, y), 0).r);
  int i = x >> 1;
  float fx = (x & 1) == 0 ? 0.0 : 0.5;
  // Chroma row j sits at luma row 2j + 0.5.
  float cy = (float(y) - 0.5) * 0.5;
  int j = int(floor(cy));
  float fy = cy - float(j);
  vec2 top = mix(chromaAt(i, j), chromaAt(i + 1, j), fx);
  vec2 bottom = mix(chromaAt(i, j + 1), chromaAt(i + 1, j + 1), fx);
  vec2 cbcr = (mix(top, bottom, fy) - 128.0) / 224.0;
  float yy = (luma - 16.0) / 219.0;
  float kr = u_k.x;
  float kb = u_k.y;
  float r = yy + 2.0 * (1.0 - kr) * cbcr.y;
  float b = yy + 2.0 * (1.0 - kb) * cbcr.x;
  float g = (yy - kr * r - kb * b) / (1.0 - kr - kb);
  o = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}
`;
}

/** Kr and Kb of each matrix. */
const MATRIX_K: Record<YuvPlanes['matrix'], readonly [number, number]> = {
  bt709: [0.2126, 0.0722],
  smpte170m: [0.299, 0.114],
  bt470bg: [0.299, 0.114],
};

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
/** How often fences are polled while a measurement is out, in ms. */
const POLL_MS = 2;

interface Program {
  readonly program: WebGLProgram;
  readonly uniforms: Map<string, WebGLUniformLocation | null>;
}

interface Target {
  readonly texture: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
}

/** One ring slot's textures; `format` is null until a frame is uploaded. */
interface Slot {
  format: YuvPlanes['format'] | null;
  readonly y: WebGLTexture;
  /** I420: U and V (R8UI); NV12: UV (RG8UI). */
  chroma: WebGLTexture[];
}

interface PendingMeasure {
  readonly sync: WebGLSync;
  readonly buffer: WebGLBuffer;
  readonly prev: boolean;
  readonly next: boolean;
  readonly fieldOrder: 'tff' | 'bff';
  resolve(m: FrameMetrics): void;
  reject(err: Error): void;
}

/**
 * The deinterlacer's WebGL2 backend for frames of `width` x `height` (the visible size), with `ringSize` slots, drawing
 * into its own OffscreenCanvas. Null without OffscreenCanvas or WebGL2, or when a program fails to build. A lost
 * context isn't restored: measurements reject and `render` throws from then on, and the caller draws woven frames.
 */
export function createGlDeinterlaceBackend(width: number, height: number, ringSize: number): DeinterlaceBackend | null {
  if (typeof OffscreenCanvas === 'undefined' || width < 1 || height < 1) return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false });
  if (!ctx) return null;
  try {
    return new GlDeinterlaceBackend(canvas, ctx as WebGL2RenderingContext, width, height, ringSize);
  } catch {
    return null;
  }
}

class GlDeinterlaceBackend implements DeinterlaceBackend {
  private readonly cw: number;
  private readonly ch: number;
  private readonly slots: Slot[] = [];
  private readonly programs = new Map<string, Program>();
  private readonly vertex: WebGLShader;
  private readonly vao: WebGLVertexArrayObject | null;
  private readonly lumaTarget: Target;
  private readonly chromaTarget: Target;
  private readonly blocks: Target;
  private readonly cells: Target;
  private readonly final: Target;
  private readonly blockSize: readonly [number, number];
  private readonly cellSize: readonly [number, number];
  private readonly freeBuffers: WebGLBuffer[] = [];
  private pending: PendingMeasure[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timer: object | null;
  private readonly queries: WebGLQuery[] = [];
  private lastGpuMs: number | null = null;
  private lost = false;
  private disposed = false;

  constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly gl: WebGL2RenderingContext,
    private readonly width: number,
    private readonly height: number,
    ringSize: number,
  ) {
    this.cw = (width + 1) >> 1;
    this.ch = (height + 1) >> 1;
    canvas.addEventListener('webglcontextlost', () => this.loseContext());
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.vertex = this.shader(gl.VERTEX_SHADER, VERTEX);
    this.vao = gl.createVertexArray();
    const fragments: Record<string, string> = {
      block: BLOCK_FRAGMENT,
      cell: CELL_FRAGMENT,
      final: FINAL_FRAGMENT,
      'convert-i420': convertFragment('i420'),
      'convert-rg': convertFragment('rg'),
    };
    for (const plane of ['luma', 'i420', 'nv12'] as const) fragments[`bwdif-${plane}`] = bwdifFragment(plane);
    for (const [name, source] of Object.entries(fragments)) this.programs.set(name, this.program(name, source));
    for (let i = 0; i < ringSize; i++) this.slots.push({ format: null, y: this.storage(gl.R8UI, width, height), chroma: [] });
    this.lumaTarget = this.target(gl.R8UI, width, height);
    this.chromaTarget = this.target(gl.RG8UI, this.cw, this.ch);
    this.blockSize = [Math.ceil(width / BLOCK), Math.ceil(height / BLOCK)];
    this.cellSize = [Math.ceil(width / COMB_CELL), Math.ceil(height / COMB_CELL)];
    this.blocks = this.target(gl.RGBA16UI, ...this.blockSize);
    this.cells = this.target(gl.RGBA32UI, ...this.cellSize);
    this.final = this.target(gl.RGBA32UI, 3, 1);
  }

  get gpuMs(): number | null {
    this.collectTimer();
    return this.lastGpuMs;
  }

  upload(slot: number, planes: YuvPlanes): void {
    const gl = this.gl;
    this.check();
    const s = this.slots[slot];
    if (!s) throw new Error(`deinterlace backend: no slot ${slot}`);
    if (planes.width !== this.width || planes.height !== this.height) {
      throw new Error(`deinterlace backend: a ${planes.width}x${planes.height} frame in a ${this.width}x${this.height} ring`);
    }
    if (s.format !== planes.format) {
      for (const t of s.chroma) gl.deleteTexture(t);
      s.chroma =
        planes.format === 'I420'
          ? [this.storage(gl.R8UI, this.cw, this.ch), this.storage(gl.R8UI, this.cw, this.ch)]
          : [this.storage(gl.RG8UI, this.cw, this.ch)];
      s.format = planes.format;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const put = (texture: WebGLTexture, plane: number, w: number, h: number, components: 1 | 2): void => {
      const layout = planes.layout[plane];
      if (!layout) throw new Error(`deinterlace backend: the frame has no plane ${plane}`);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout.stride / components);
      const format = components === 1 ? gl.RED_INTEGER : gl.RG_INTEGER;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, gl.UNSIGNED_BYTE, planes.data, layout.offset);
    };
    put(s.y, 0, this.width, this.height, 1);
    if (planes.format === 'I420') {
      put(s.chroma[0]!, 1, this.cw, this.ch, 1);
      put(s.chroma[1]!, 2, this.cw, this.ch, 1);
    } else {
      put(s.chroma[0]!, 1, this.cw, this.ch, 2);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  measure(prev: number | null, cur: number, next: number | null, fieldOrder: 'tff' | 'bff'): Promise<FrameMetrics> {
    if (this.lost || this.disposed) return Promise.reject(new Error(this.lost ? 'WebGL context lost' : 'deinterlace backend disposed'));
    const gl = this.gl;
    const curY = this.slotOf(cur).y;
    const prevY = prev !== null ? this.slotOf(prev).y : curY;
    const nextY = next !== null ? this.slotOf(next).y : curY;

    const block = this.use('block');
    this.bindTarget(this.blocks, ...this.blockSize);
    this.bind(block, 'cur', 0, curY);
    this.bind(block, 'prv', 1, prevY);
    this.bind(block, 'nxt', 2, nextY);
    gl.uniform2i(this.loc(block, 'u_size'), this.width, this.height);
    this.draw();

    const cell = this.use('cell');
    this.bindTarget(this.cells, ...this.cellSize);
    this.bind(cell, 'blocks', 0, this.blocks.texture);
    gl.uniform2i(this.loc(cell, 'u_blocks'), ...this.blockSize);
    this.draw();

    const final = this.use('final');
    this.bindTarget(this.final, 3, 1);
    this.bind(final, 'cells', 0, this.cells.texture);
    gl.uniform2i(this.loc(final, 'u_cells'), ...this.cellSize);
    this.draw();

    const buffer = this.freeBuffers.pop() ?? gl.createBuffer();
    if (!buffer) return Promise.reject(new Error('WebGL: createBuffer failed'));
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 3 * 16, gl.STREAM_READ);
    gl.readPixels(0, 0, 3, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return Promise.reject(new Error('WebGL: fenceSync failed'));
    gl.flush();
    return new Promise<FrameMetrics>((resolve, reject) => {
      this.pending.push({ sync, buffer, prev: prev !== null, next: next !== null, fieldOrder, resolve, reject });
      this.schedulePoll();
    });
  }

  render(
    op: PictureOp,
    slots: { readonly prev: number | null; readonly cur: number; readonly next: number | null },
    fieldOrder: 'tff' | 'bff',
    matrix: YuvPlanes['matrix'],
    cheap = false,
  ): OffscreenCanvas {
    this.check();
    const gl = this.gl;
    const cur = this.slotOf(slots.cur);
    if (!cur.format) throw new Error('deinterlace backend: render of an empty slot');
    // A neighbour of another pixel format (a decoder change) can't be read with this frame's programs.
    const same = (n: number | null): Slot | null => {
      const s = n !== null ? this.slotOf(n) : null;
      return s && s.format === cur.format ? s : null;
    };
    const prev = same(slots.prev);
    const next = same(slots.next);
    this.collectTimer();
    const query = this.beginTimer();
    try {
      // The frames that give the even (top) rows and the odd (bottom) rows.
      let a = cur;
      let b = cur;
      if (op.kind === 'match') {
        // The first parity (top for top field first) comes from cur for `prev` and from the next frame for `next`.
        const other = op.with === 'prev' ? prev : next;
        if (other) {
          const curGivesTop = (op.with === 'prev') === (fieldOrder === 'tff');
          a = curGivesTop ? cur : other;
          b = curGivesTop ? other : cur;
        }
      } else if (op.kind === 'interpolate') {
        this.bwdif(op.field === 'top' ? 0 : 1, fieldOrder, prev, cur, next, cheap);
        this.convert(this.lumaTarget.texture, this.lumaTarget.texture, null, matrix);
        return this.canvas;
      }
      this.convert(a.y, b.y, [a, b], matrix);
      return this.canvas;
    } finally {
      if (query) gl.endQuery(TIME_ELAPSED_EXT);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const p of this.pending.splice(0)) p.reject(new Error('deinterlace backend disposed'));
    if (this.lost) return;
    const gl = this.gl;
    for (const s of this.slots) {
      gl.deleteTexture(s.y);
      for (const t of s.chroma) gl.deleteTexture(t);
    }
    for (const t of [this.lumaTarget, this.chromaTarget, this.blocks, this.cells, this.final]) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.texture);
    }
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    gl.deleteShader(this.vertex);
    gl.deleteVertexArray(this.vao);
    for (const b of this.freeBuffers) gl.deleteBuffer(b);
    for (const q of this.queries) gl.deleteQuery(q);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** bwdif of each plane into the picture targets: field `parity` kept, the other interpolated. */
  private bwdif(parity: 0 | 1, fieldOrder: 'tff' | 'bff', prev: Slot | null, cur: Slot, next: Slot | null, cheap: boolean): void {
    const gl = this.gl;
    const tff = fieldOrder === 'tff';
    // A stream's first field has nothing before it (filter_intra); its second field takes its own frame as the
    // previous one, and the last frame takes itself as the next, as ffmpeg's bwdif does.
    const intra = prev === null && parity === (tff ? 0 : 1);
    const p = prev ?? cur;
    const n = next ?? cur;
    const passes: Array<{ plane: BwdifPlane; target: Target; size: readonly [number, number]; tex: (s: Slot) => WebGLTexture[] }> = [
      { plane: 'luma', target: this.lumaTarget, size: [this.width, this.height], tex: (s) => [s.y] },
      { plane: cur.format === 'I420' ? 'i420' : 'nv12', target: this.chromaTarget, size: [this.cw, this.ch], tex: (s) => s.chroma },
    ];
    for (const pass of passes) {
      const prog = this.use(`bwdif-${pass.plane}`);
      this.bindTarget(pass.target, ...pass.size);
      let unit = 0;
      for (const [name, slot] of [
        ['p', p],
        ['c', cur],
        ['n', n],
      ] as const) {
        pass.tex(slot).forEach((t, i) => this.bind(prog, `${name}${i}`, unit++, t));
      }
      gl.uniform2i(this.loc(prog, 'u_size'), ...pass.size);
      gl.uniform1i(this.loc(prog, 'u_parity'), parity);
      gl.uniform1i(this.loc(prog, 'u_dspParity'), parity ^ (tff ? 1 : 0));
      gl.uniform1i(this.loc(prog, 'u_intra'), intra ? 1 : 0);
      gl.uniform1i(this.loc(prog, 'u_cheap'), cheap ? 1 : 0);
      this.draw();
    }
  }

  /**
   * The colour pass into the canvas: even rows from `yA` and the chroma of `slots[0]`, odd rows from `yB` and the
   * chroma of `slots[1]`; with `slots` null, the bwdif picture's planes.
   */
  private convert(yA: WebGLTexture, yB: WebGLTexture, slots: readonly [Slot, Slot] | null, matrix: YuvPlanes['matrix']): void {
    const gl = this.gl;
    const i420 = slots !== null && slots[0].format === 'I420';
    const prog = this.use(i420 ? 'convert-i420' : 'convert-rg');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    this.bind(prog, 'yA', 0, yA);
    this.bind(prog, 'yB', 1, yB);
    if (slots === null) {
      this.bind(prog, 'cA', 2, this.chromaTarget.texture);
      this.bind(prog, 'cB', 3, this.chromaTarget.texture);
    } else if (i420) {
      this.bind(prog, 'uA', 2, slots[0].chroma[0]!);
      this.bind(prog, 'vA', 3, slots[0].chroma[1]!);
      this.bind(prog, 'uB', 4, slots[1].chroma[0]!);
      this.bind(prog, 'vB', 5, slots[1].chroma[1]!);
    } else {
      this.bind(prog, 'cA', 2, slots[0].chroma[0]!);
      this.bind(prog, 'cB', 3, slots[1].chroma[0]!);
    }
    gl.uniform2i(this.loc(prog, 'u_size'), this.width, this.height);
    gl.uniform2i(this.loc(prog, 'u_csize'), this.cw, this.ch);
    const [kr, kb] = MATRIX_K[matrix];
    gl.uniform2f(this.loc(prog, 'u_k'), kr, kb);
    this.draw();
  }

  private schedulePoll(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.poll();
    }, POLL_MS);
  }

  /** Reads back every measurement whose fence has passed, in order, without waiting on the GPU. */
  private poll(): void {
    if (this.lost || this.disposed) return;
    const gl = this.gl;
    while (this.pending.length > 0) {
      const p = this.pending[0]!;
      const status = gl.clientWaitSync(p.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) break;
      this.pending.shift();
      gl.deleteSync(p.sync);
      if (status === gl.WAIT_FAILED) {
        p.reject(new Error('WebGL: clientWaitSync failed'));
        continue;
      }
      const out = new Uint32Array(12);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.freeBuffers.push(p.buffer);
      p.resolve(metricsFromCounts(out, p, this.width * this.height));
    }
    if (this.pending.length > 0) this.schedulePoll();
  }

  private loseContext(): void {
    if (this.lost) return;
    this.lost = true;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const p of this.pending.splice(0)) p.reject(new Error('WebGL context lost'));
  }

  private check(): void {
    if (this.lost || this.gl.isContextLost()) {
      this.loseContext();
      throw new Error('WebGL context lost');
    }
    if (this.disposed) throw new Error('deinterlace backend disposed');
  }

  private slotOf(n: number): Slot {
    const s = this.slots[n];
    if (!s) throw new Error(`deinterlace backend: no slot ${n}`);
    return s;
  }

  private shader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type);
    if (!s) throw new Error('WebGL: createShader failed');
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  }

  private program(name: string, source: string): Program {
    const gl = this.gl;
    const fs = this.shader(gl.FRAGMENT_SHADER, source);
    const p = gl.createProgram();
    if (!p) throw new Error('WebGL: createProgram failed');
    gl.attachShader(p, this.vertex);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getShaderParameter(fs, gl.COMPILE_STATUS) ? gl.getProgramInfoLog(p) : gl.getShaderInfoLog(fs);
      gl.deleteShader(fs);
      gl.deleteProgram(p);
      throw new Error(`deinterlace ${name}: ${log ?? 'unknown error'}`);
    }
    gl.deleteShader(fs);
    return { program: p, uniforms: new Map() };
  }

  private use(name: string): Program {
    const p = this.programs.get(name)!;
    this.gl.useProgram(p.program);
    return p;
  }

  private loc(p: Program, name: string): WebGLUniformLocation | null {
    let l = p.uniforms.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p.program, name);
      p.uniforms.set(name, l);
    }
    return l;
  }

  private bind(p: Program, name: string, unit: number, texture: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.loc(p, name), unit);
  }

  private bindTarget(t: Target, w: number, h: number): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.fbo);
    this.gl.viewport(0, 0, w, h);
  }

  private draw(): void {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  /** An immutable unsigned-integer texture (sampled with texelFetch, so nearest filtering). */
  private storage(internal: number, w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error('WebGL: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    return t;
  }

  private target(internal: number, w: number, h: number): Target {
    const gl = this.gl;
    const texture = this.storage(internal, w, h);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('WebGL: createFramebuffer failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('WebGL: incomplete framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, fbo };
  }

  private beginTimer(): WebGLQuery | null {
    if (!this.timer) return null;
    const gl = this.gl;
    const q = gl.createQuery();
    if (!q) return null;
    gl.beginQuery(TIME_ELAPSED_EXT, q);
    if (gl.getQuery(TIME_ELAPSED_EXT, gl.CURRENT_QUERY) !== q) {
      gl.deleteQuery(q);
      return null;
    }
    this.queries.push(q);
    return q;
  }

  /** Reads finished timer queries; their results arrive a picture or more late. */
  private collectTimer(): void {
    if (!this.timer || this.lost || this.disposed) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(GPU_DISJOINT_EXT) as boolean;
    while (this.queries.length > 0) {
      const q = this.queries[0]!;
      if (!disjoint && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.queries.shift();
      if (!disjoint) this.lastGpuMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      gl.deleteQuery(q);
    }
  }
}

/** A whole 2x2-cell window's pixels, the divisor of comb values. */
const WINDOW_PIXELS = 4 * COMB_CELL * COMB_CELL;

/**
 * The `FrameMetrics` of the final pass's integers (3 RGBA32UI pixels, in its layout), as `frameMetrics` in
 * `metrics-cpu.ts` makes them from its counts: a pairing with a missing neighbour measures as the woven frame, and
 * `diffPrev` with no previous frame is 1.
 */
export function metricsFromCounts(
  counts: Uint32Array,
  have: { readonly prev: boolean; readonly next: boolean; readonly fieldOrder: 'tff' | 'bff' },
  pixels: number,
): FrameMetrics {
  const [woven, topPrev, bottomPrev, topNext, bottomNext, totalTopPrev, totalBottomPrev, totalTopNext, totalBottomNext, diff] = [
    counts[0]!,
    counts[1]!,
    counts[2]!,
    counts[3]!,
    counts[4]!,
    counts[5]!,
    counts[6]!,
    counts[7]!,
    counts[8]!,
    counts[9]!,
  ];
  const tff = have.fieldOrder === 'tff';
  const combWoven = woven / WINDOW_PIXELS;
  const firstPrev = tff ? topPrev : bottomPrev;
  const secondNext = tff ? bottomNext : topNext;
  const whole = (n: number, present: boolean): number => (present ? n / pixels : 0);
  return {
    combWoven,
    combMatchPrev: have.prev ? firstPrev / WINDOW_PIXELS : combWoven,
    combMatchNext: have.next ? secondNext / WINDOW_PIXELS : combWoven,
    diffPrev: have.prev ? diff / (pixels * 255) : 1,
    motionTff: whole(totalTopPrev, have.prev) + whole(totalBottomNext, have.next),
    motionBff: whole(totalBottomPrev, have.prev) + whole(totalTopNext, have.next),
  };
}
