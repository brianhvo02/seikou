// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Presents the overlay layer (subtitles and menus drawn in sRGB) on the page's HDR overlay canvas through WebGPU in
 * extended range, its white lifted to graphics white: the shader follows `scalePremultiplied` in `hdr-overlay.ts`.
 * @internal
 */

/** What the compositor presents HDR overlays through. */
export interface HdrOverlayPresenter {
  /** Shows `source` (premultiplied sRGB, any size) on the HDR canvas at the same size, its linear light times `gain`. */
  present(source: OffscreenCanvas, gain: number): void;
  /** Shows nothing (a transparent canvas). */
  clear(): void;
  /** Releases the GPU device; nothing is shown again. */
  dispose(): void;
}

/** A presenter, or why none could be made (for telemetry). */
export type HdrPresenterResult = { readonly presenter: HdrOverlayPresenter } | { readonly reason: string };

/** The canvas the presenter draws on: the page's HDR overlay canvas, transferred to the worker. */
export interface HdrCanvasLike {
  width: number;
  height: number;
  getContext(id: 'webgpu'): GPUCanvasContext | null;
}

// WebGPU's usage flags, as numbers, so the module loads where the GPU globals are missing (tests, Node)
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_BINDING = 0x04;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_COPY_DST = 0x08;
const BUFFER_UNIFORM = 0x40;

/** The shader: one full-screen triangle; each pixel unpremultiplied, decoded from sRGB, scaled, encoded, premultiplied. */
export const HDR_OVERLAY_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: vec4f;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn decode(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn encode(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = textureLoad(src, vec2i(pos.xy), 0);
  if (p.a <= 0.0) {
    return vec4f(0.0);
  }
  let linear = decode(clamp(p.rgb / p.a, vec3f(0.0), vec3f(1.0))) * u.x;
  return vec4f(encode(linear) * p.a, p.a);
}
`;

/**
 * Makes the WebGPU presenter on `canvas`, or says why it can't: no WebGPU, no adapter or device, no context, a
 * configuration refused, or one whose extended tone mapping didn't stick (a browser that doesn't know the member drops
 * it, and would clamp at SDR white). `onLost` is called once if the device is lost or a present fails afterwards.
 */
export async function createWebGpuHdrPresenter(
  canvas: HdrCanvasLike,
  gpu: Pick<GPU, 'requestAdapter'> | undefined,
  onLost: (reason: string) => void,
): Promise<HdrPresenterResult> {
  if (!gpu) return { reason: 'no WebGPU' };
  let device: GPUDevice;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { reason: 'no WebGPU adapter' };
    device = await adapter.requestDevice();
  } catch (err) {
    return { reason: `no WebGPU device (${String(err)})` };
  }
  const fail = (reason: string): HdrPresenterResult => {
    device.destroy();
    return { reason };
  };
  let context: GPUCanvasContext | null;
  try {
    context = canvas.getContext('webgpu');
  } catch (err) {
    return fail(`no WebGPU canvas context (${String(err)})`);
  }
  if (!context) return fail('no WebGPU canvas context');
  try {
    context.configure({ device, format: 'rgba16float', alphaMode: 'premultiplied', colorSpace: 'srgb', toneMapping: { mode: 'extended' } });
  } catch (err) {
    return fail(`the extended-range canvas was refused (${String(err)})`);
  }
  const mode = typeof context.getConfiguration === 'function' ? context.getConfiguration()?.toneMapping?.mode : undefined;
  if (mode !== 'extended') return fail('the canvas has no extended range');
  try {
    return { presenter: new WebGpuHdrPresenter(canvas, context, device, onLost) };
  } catch (err) {
    return fail(`the HDR overlay pipeline failed (${String(err)})`);
  }
}

class WebGpuHdrPresenter implements HdrOverlayPresenter {
  private readonly pipeline: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private source: { readonly texture: GPUTexture; readonly bindGroup: GPUBindGroup; readonly width: number; readonly height: number } | null = null;
  private dead = false;

  constructor(
    private readonly canvas: HdrCanvasLike,
    private readonly context: GPUCanvasContext,
    private readonly device: GPUDevice,
    private readonly onLost: (reason: string) => void,
  ) {
    const module = device.createShaderModule({ code: HDR_OVERLAY_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.uniform = device.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DST });
    void device.lost.then((info) => this.lose(`the GPU device was lost (${info.message || info.reason})`));
  }

  present(source: OffscreenCanvas, gain: number): void {
    if (this.dead) return;
    const width = Math.max(1, source.width);
    const height = Math.max(1, source.height);
    try {
      this.size(width, height);
      const src = this.sourceTexture(width, height);
      this.device.queue.copyExternalImageToTexture({ source }, { texture: src.texture, premultipliedAlpha: true }, [width, height]);
      this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([gain, 0, 0, 0]));
      this.draw(src.bindGroup);
    } catch (err) {
      this.lose(`presenting failed (${String(err)})`);
    }
  }

  clear(): void {
    if (this.dead) return;
    try {
      this.draw(null);
    } catch (err) {
      this.lose(`presenting failed (${String(err)})`);
    }
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.source?.texture.destroy();
    this.source = null;
    this.device.destroy();
  }

  private size(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  private sourceTexture(width: number, height: number): NonNullable<WebGpuHdrPresenter['source']> {
    const held = this.source;
    if (held && held.width === width && held.height === height) return held;
    held?.texture.destroy();
    const texture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: TEXTURE_COPY_DST | TEXTURE_BINDING | TEXTURE_RENDER_ATTACHMENT,
    });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: this.uniform } },
      ],
    });
    return (this.source = { texture, bindGroup, width, height });
  }

  /** One pass onto the canvas: cleared to transparent, then the overlay drawn when `bindGroup` is given. */
  private draw(bindGroup: GPUBindGroup | null): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    if (bindGroup) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private lose(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.device.destroy();
    } catch {
      // already gone
    }
    this.onLost(reason);
  }
}
