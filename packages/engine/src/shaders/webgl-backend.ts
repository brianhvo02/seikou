/*
 * Original code for bluray-web, 2026. Runs mpv user shader passes on WebGL2.
 * Pass execution follows libplacebo's semantics (src/renderer.c,
 * src/shaders/custom_mpv.c), spec sections 3 and 5.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { fragmentSource, VERTEX_SHADER } from './codegen';
import type { ShaderPass } from './parse';
import { planFrame, type PlanStage, type Size, type TexRef } from './plan';
import { floatTargetExtension, floatTargetSupport } from './webgl-support';

export interface CompiledSet {
  readonly passes: readonly ShaderPass[];
  dispose(): void;
}

export interface RenderResult {
  readonly image: OffscreenCanvas;
  readonly passesRun: number;
  readonly gpuMs: number | null;
}

export class ShaderCompileError extends Error {
  constructor(
    readonly file: string,
    readonly pass: string,
    readonly log: string,
  ) {
    super(`${file}, ${pass}: ${log}`);
    this.name = 'ShaderCompileError';
  }
}

/** The WebGL context was lost before or during the call; recompile after `restored()`. */
export class ShaderContextLostError extends Error {
  constructor() {
    super('WebGL context lost');
    this.name = 'ShaderContextLostError';
  }
}

/** The set was disposed or compiled on an earlier (lost) context; compile it again. */
export class ShaderSetStaleError extends Error {
  constructor() {
    super('shader set is disposed or was compiled on a lost WebGL context');
    this.name = 'ShaderSetStaleError';
  }
}

export interface ShaderBackend {
  /**
   * Compiles one program per (pass, firing stage). Rejects with ShaderCompileError when a pass fails to compile or
   * link, or with ShaderContextLostError when the context is lost before or while compiling.
   */
  compile(passes: readonly ShaderPass[]): Promise<CompiledSet>;
  /**
   * Runs the set on `frame` and draws the result at `output` size into the returned canvas (the same canvas every call).
   * Throws ShaderContextLostError while the context is lost; throws ShaderSetStaleError for a set that was disposed or
   * compiled on an earlier (lost) context, and passes through errors from the upload of `frame` (a closed VideoFrame).
   */
  render(set: CompiledSet, frame: VideoFrame, output: Size): RenderResult;
}

export const UNAVAILABLE = 'Not available on this device';

const STAGES: readonly PlanStage[] = ['NATIVE', 'MAIN', 'PREKERNEL'];
const COMPLETION_STATUS_KHR = 0x91b1;
const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const POLL_MS = 16;

const FINAL_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_pos;
out vec4 out_color;
uniform sampler2D image;
void main() {
    // Pass textures keep the frame's first row at y = 0; the default framebuffer shows y = 0 at the bottom.
    out_color = vec4(texture(image, vec2(v_pos.x, 1.0 - v_pos.y)).rgb, 1.0);
}
`;

interface Program {
  readonly program: WebGLProgram;
  readonly uniforms: Map<string, WebGLUniformLocation | null>;
}

interface PoolTexture {
  readonly key: string;
  readonly texture: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
}

class WebGlSet implements CompiledSet {
  constructor(
    readonly passes: readonly ShaderPass[],
    readonly programs: Map<ShaderPass, Map<PlanStage, Program>>,
    readonly generation: number,
    private readonly release: (set: WebGlSet) => void,
  ) {}

  dispose(): void {
    this.release(this);
  }
}

function firstLine(log: string | null): string {
  const line = (log ?? '').split('\n').find((l) => l.trim() !== '');
  return line?.trim() ?? 'unknown error';
}

function canonical(name: string): string {
  return name === 'MAINPRESUB' ? 'MAIN' : name;
}

function uniform(gl: WebGL2RenderingContext, p: Program, name: string): WebGLUniformLocation | null {
  let loc = p.uniforms.get(name);
  if (loc === undefined) {
    loc = gl.getUniformLocation(p.program, name);
    p.uniforms.set(name, loc);
  }
  return loc;
}

/** Returns the backend, or the reason shaders are unavailable. */
export function createWebGlBackend(
  createCanvas: (w: number, h: number) => OffscreenCanvas,
  events: { lost(): void; restored(): void },
): ShaderBackend | string {
  const canvas = createCanvas(1, 1);
  const ctx = canvas.getContext('webgl2', {
    alpha: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
  });
  if (!ctx) return UNAVAILABLE;
  const gl = ctx as WebGL2RenderingContext;
  const support = floatTargetSupport((name) => gl.getExtension(name) !== null);
  if (!support) return UNAVAILABLE;
  return new WebGlBackend(canvas, gl, events, floatTargetExtension(support));
}

class WebGlBackend implements ShaderBackend {
  private generation = 0;
  private parallel = false;
  private maxTextureSize = Infinity;
  private timer: object | null = null;
  private vertex: WebGLShader | null = null;
  private final: Program | null = null;
  private frameTexture: WebGLTexture | null = null;
  private readonly sets = new Set<WebGlSet>();
  private pool = new Map<string, PoolTexture[]>();
  private readonly pending: WebGLQuery[] = [];
  private gpuMs: number | null = null;
  private frameCount = 0;

  constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly gl: WebGL2RenderingContext,
    events: { lost(): void; restored(): void },
    private readonly targetExtension: string,
  ) {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.drop();
      events.lost();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.init();
      events.restored();
    });
    this.init();
  }

  /** (Re)creates the per-context state; extensions must be enabled again after a restore. */
  private init(): void {
    const gl = this.gl;
    gl.getExtension(this.targetExtension);
    this.parallel = gl.getExtension('KHR_parallel_shader_compile') !== null;
    this.maxTextureSize = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | null) ?? Infinity;
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.vertex = this.shader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.shader(gl.FRAGMENT_SHADER, FINAL_FRAGMENT);
    this.final = { program: this.link(this.vertex, fs), uniforms: new Map() };
    gl.deleteShader(fs);
    this.frameTexture = this.texture();
  }

  /** Forgets every GL object of the lost context; sets compiled on it can no longer render. */
  private drop(): void {
    this.generation++;
    for (const set of this.sets) set.programs.clear();
    this.sets.clear();
    this.pool = new Map();
    this.pending.length = 0;
    this.vertex = null;
    this.final = null;
    this.frameTexture = null;
    this.gpuMs = null;
  }

  private shader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type);
    if (!s) throw new Error('WebGL: createShader failed');
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  }

  private link(vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const gl = this.gl;
    const p = gl.createProgram();
    if (!p) throw new Error('WebGL: createProgram failed');
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    return p;
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error('WebGL: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  async compile(passes: readonly ShaderPass[]): Promise<CompiledSet> {
    const gl = this.gl;
    const generation = this.generation;
    if (gl.isContextLost() || !this.vertex) throw new ShaderContextLostError();
    const vertex = this.vertex;

    const jobs: { pass: ShaderPass; stage: PlanStage; fs: WebGLShader; program: WebGLProgram }[] = [];
    for (const pass of passes) {
      for (const stage of STAGES) {
        if (!pass.hooks.some((h) => canonical(h) === stage)) continue;
        const fs = this.shader(gl.FRAGMENT_SHADER, fragmentSource(pass, stage));
        const program = this.link(vertex, fs);
        jobs.push({ pass, stage, fs, program });
        if (!this.parallel) {
          // Without KHR_parallel_shader_compile, finish this link now and yield so the worker's render loop runs between programs.
          gl.getProgramParameter(program, gl.LINK_STATUS);
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (this.generation !== generation) break;
        }
      }
      if (this.generation !== generation) break;
    }
    const discard = (): void => {
      for (const j of jobs) {
        gl.deleteShader(j.fs);
        gl.deleteProgram(j.program);
      }
    };

    // Polling KHR_parallel_shader_compile keeps the worker free to draw frames while the driver compiles.
    if (this.parallel) {
      while (!jobs.every((j) => gl.getProgramParameter(j.program, COMPLETION_STATUS_KHR) !== false)) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (this.generation !== generation) break;
      }
    }
    if (this.generation !== generation || gl.isContextLost()) {
      throw new ShaderContextLostError();
    }

    const programs = new Map<ShaderPass, Map<PlanStage, Program>>();
    for (const j of jobs) {
      if (!gl.getProgramParameter(j.program, gl.LINK_STATUS)) {
        const log = gl.getShaderParameter(j.fs, gl.COMPILE_STATUS)
          ? gl.getProgramInfoLog(j.program)
          : gl.getShaderInfoLog(j.fs);
        discard();
        throw new ShaderCompileError(j.pass.file, j.pass.desc, firstLine(log));
      }
      let byStage = programs.get(j.pass);
      if (!byStage) programs.set(j.pass, (byStage = new Map()));
      byStage.set(j.stage, { program: j.program, uniforms: new Map() });
    }
    for (const j of jobs) gl.deleteShader(j.fs);

    const set = new WebGlSet(passes, programs, generation, (s) => {
      if (!this.sets.delete(s)) return;
      for (const byStage of s.programs.values()) for (const p of byStage.values()) gl.deleteProgram(p.program);
      s.programs.clear();
    });
    this.sets.add(set);
    return set;
  }

  render(set: CompiledSet, frame: VideoFrame, output: Size): RenderResult {
    const gl = this.gl;
    if (!(set instanceof WebGlSet) || set.generation !== this.generation || !this.sets.has(set)) {
      if (this.gl.isContextLost()) throw new ShaderContextLostError();
      throw new ShaderSetStaleError();
    }
    if (gl.isContextLost() || !this.final || !this.frameTexture) throw new ShaderContextLostError();
    const final = this.final;
    const frameTexture = this.frameTexture;

    this.collectTimer();
    const textures = new Map<number, PoolTexture>();
    const glTexture = (ref: TexRef): WebGLTexture => (ref.id === 0 ? frameTexture : textures.get(ref.id)!.texture);
    let passesRun = 0;
    // Everything after beginTimer sits in the try, so the query is always ended and the textures released.
    const query = this.beginTimer();
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);

      // texImage2D uploads the visible rectangle, so MAIN is the visible size (spec section 3.3).
      const source: Size = {
        width: frame.visibleRect?.width ?? frame.codedWidth,
        height: frame.visibleRect?.height ?? frame.codedHeight,
      };
      const plan = planFrame(set.passes, source, output, this.maxTextureSize);
      passesRun = plan.passes.length;

      for (const step of plan.passes) {
        const program = set.programs.get(step.pass)?.get(step.stage);
        if (!program) throw new Error(`no program for ${step.pass.desc} at ${step.stage}`);
        const target = this.acquire(step.out);
        textures.set(step.out.id, target);

        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, step.out.width, step.out.height);
        gl.useProgram(program.program);
        step.inputs.forEach((input, unit) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, glTexture(input.tex));
          gl.uniform1i(uniform(gl, program, `${input.name}_raw`), unit);
          gl.uniform2f(uniform(gl, program, `${input.name}_size`), input.tex.width, input.tex.height);
          gl.uniform2f(uniform(gl, program, `${input.name}_pt`), 1 / input.tex.width, 1 / input.tex.height);
        });
        gl.uniform1i(uniform(gl, program, 'frame'), this.frameCount++);
        gl.uniform1f(uniform(gl, program, 'random'), Math.random());
        gl.uniform2f(uniform(gl, program, 'input_size'), source.width, source.height);
        gl.uniform2f(uniform(gl, program, 'target_size'), output.width, output.height);
        gl.uniform2f(uniform(gl, program, 'tex_offset'), 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // Final scale: one bilinear pass from the current MAIN to the output (spec section 3.3).
      if (this.canvas.width !== output.width) this.canvas.width = output.width;
      if (this.canvas.height !== output.height) this.canvas.height = output.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, output.width, output.height);
      gl.useProgram(final.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, glTexture(plan.final));
      gl.uniform1i(uniform(gl, final, 'image'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      if (query) gl.endQuery(TIME_ELAPSED_EXT);
      this.releaseFrame(textures);
    }
    return { image: this.canvas, passesRun, gpuMs: this.gpuMs };
  }

  private acquire(ref: TexRef): PoolTexture {
    const key = `${ref.width}x${ref.height}x${ref.components}`;
    const free = this.pool.get(key);
    const reused = free?.pop();
    if (reused) return reused;

    const gl = this.gl;
    const texture = this.texture();
    const [internal, format] =
      ref.components === 1 ? [gl.R16F, gl.RED] : ref.components === 2 ? [gl.RG16F, gl.RG] : [gl.RGBA16F, gl.RGBA];
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, ref.width, ref.height, 0, format, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('WebGL: createFramebuffer failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { key, texture, fbo };
  }

  /** Returns this frame's textures to the pool and frees pooled ones the frame did not use (a resize, a new set). */
  private releaseFrame(used: Map<number, PoolTexture>): void {
    const gl = this.gl;
    for (const list of this.pool.values()) {
      for (const t of list) {
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.texture);
      }
    }
    const pool = new Map<string, PoolTexture[]>();
    for (const t of used.values()) {
      let list = pool.get(t.key);
      if (!list) pool.set(t.key, (list = []));
      list.push(t);
    }
    this.pool = pool;
  }

  private beginTimer(): WebGLQuery | null {
    if (!this.timer) return null;
    const q = this.gl.createQuery();
    if (!q) return null;
    this.gl.beginQuery(TIME_ELAPSED_EXT, q);
    // A query that did not start (another one still active) would never become available and stall collectTimer.
    if (this.gl.getQuery(TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== q) {
      this.gl.deleteQuery(q);
      return null;
    }
    this.pending.push(q);
    return q;
  }

  /** Reads finished timer queries; their results arrive a frame or more late. */
  private collectTimer(): void {
    const gl = this.gl;
    if (!this.timer) return;
    const disjoint = gl.getParameter(GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length > 0) {
      const q = this.pending[0]!;
      if (!disjoint && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) this.gpuMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      gl.deleteQuery(q);
    }
  }
}
