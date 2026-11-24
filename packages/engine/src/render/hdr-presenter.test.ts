// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { createWebGpuHdrPresenter, type HdrCanvasLike } from './hdr-presenter';

interface FakeOptions {
  readonly adapter?: boolean;
  readonly context?: boolean;
  readonly configureThrows?: boolean;
  /** What getConfiguration reports as the tone mapping mode; 'none' leaves getConfiguration out. */
  readonly mode?: 'extended' | 'standard' | 'dropped' | 'none';
}

function fakeGpu(o: FakeOptions = {}) {
  const calls: string[] = [];
  let resolveLost: (info: { message: string; reason: string }) => void = () => undefined;
  const lost = new Promise<{ message: string; reason: string }>((res) => (resolveLost = res));
  const written: number[] = [];
  let configured: GPUCanvasConfiguration | null = null;
  const device = {
    lost,
    destroy: vi.fn(() => calls.push('destroy')),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({}),
    createTexture: (d: { size: number[] }) => {
      calls.push(`texture ${d.size.join('x')}`);
      return { createView: () => ({}), destroy: () => calls.push('texture destroyed') };
    },
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => undefined,
        setBindGroup: () => undefined,
        draw: (n: number) => calls.push(`draw ${n}`),
        end: () => undefined,
      }),
      finish: () => ({}),
    }),
    queue: {
      copyExternalImageToTexture: (_s: unknown, d: { premultipliedAlpha?: boolean }, size: number[]) => calls.push(`copy ${size.join('x')} premultiplied=${d.premultipliedAlpha}`),
      writeBuffer: (_b: unknown, _o: number, data: Float32Array) => written.push(data[0]!),
      submit: () => calls.push('submit'),
    },
  };
  const context = {
    configure: (c: GPUCanvasConfiguration) => {
      if (o.configureThrows) throw new TypeError('bad');
      configured = c;
    },
    getCurrentTexture: () => ({ createView: () => ({}) }),
    ...(o.mode === 'none'
      ? {}
      : {
          getConfiguration: () =>
            configured && { ...configured, toneMapping: o.mode === 'dropped' ? undefined : { mode: o.mode ?? 'extended' } },
        }),
  };
  const canvas: HdrCanvasLike = { width: 0, height: 0, getContext: () => (o.context === false ? null : (context as unknown as GPUCanvasContext)) };
  const gpu = {
    requestAdapter: async () => (o.adapter === false ? null : { requestDevice: async () => device }),
  } as unknown as GPU;
  return { gpu, canvas, device, calls, written, configuredWith: () => configured, lose: (message: string) => resolveLost({ message, reason: 'unknown' }) };
}

const layer = (width: number, height: number): OffscreenCanvas => ({ width, height }) as OffscreenCanvas;

describe('createWebGpuHdrPresenter', () => {
  it('says why when anything is missing', async () => {
    const onLost = vi.fn();
    expect(await createWebGpuHdrPresenter(fakeGpu().canvas, undefined, onLost)).toEqual({ reason: 'no WebGPU' });
    const noAdapter = fakeGpu({ adapter: false });
    expect(await createWebGpuHdrPresenter(noAdapter.canvas, noAdapter.gpu, onLost)).toEqual({ reason: 'no WebGPU adapter' });
    const noContext = fakeGpu({ context: false });
    expect(await createWebGpuHdrPresenter(noContext.canvas, noContext.gpu, onLost)).toEqual({ reason: 'no WebGPU canvas context' });
    expect(noContext.device.destroy).toHaveBeenCalled();
    const refused = fakeGpu({ configureThrows: true });
    expect(await createWebGpuHdrPresenter(refused.canvas, refused.gpu, onLost)).toMatchObject({ reason: expect.stringContaining('refused') });
    for (const mode of ['standard', 'dropped', 'none'] as const) {
      const f = fakeGpu({ mode });
      expect(await createWebGpuHdrPresenter(f.canvas, f.gpu, onLost)).toEqual({ reason: 'the canvas has no extended range' });
      expect(f.device.destroy).toHaveBeenCalled();
    }
    expect(onLost).not.toHaveBeenCalled();
  });

  it('configures a float16 premultiplied canvas in extended range', async () => {
    const f = fakeGpu();
    const r = await createWebGpuHdrPresenter(f.canvas, f.gpu, () => undefined);
    expect('presenter' in r).toBe(true);
    expect(f.configuredWith()).toMatchObject({ format: 'rgba16float', alphaMode: 'premultiplied', colorSpace: 'srgb', toneMapping: { mode: 'extended' } });
  });

  it('copies the layer premultiplied, sets the gain and draws, at the layer size', async () => {
    const f = fakeGpu();
    const r = await createWebGpuHdrPresenter(f.canvas, f.gpu, () => undefined);
    if (!('presenter' in r)) throw new Error(r.reason);
    r.presenter.present(layer(640, 360), 2.03);
    expect(f.canvas.width).toBe(640);
    expect(f.canvas.height).toBe(360);
    expect(f.calls).toEqual(['texture 640x360', 'copy 640x360 premultiplied=true', 'draw 3', 'submit']);
    expect(f.written[0]).toBeCloseTo(2.03, 5);
    f.calls.length = 0;
    r.presenter.present(layer(640, 360), 2.03);
    expect(f.calls).toEqual(['copy 640x360 premultiplied=true', 'draw 3', 'submit']); // the texture is kept
    f.calls.length = 0;
    r.presenter.present(layer(800, 450), 2.03);
    expect(f.calls.slice(0, 2)).toEqual(['texture destroyed', 'texture 800x450']);
    f.calls.length = 0;
    r.presenter.clear();
    expect(f.calls).toEqual(['submit']); // a cleared pass, no draw
  });

  it('calls back once when the device is lost, and presents nothing after', async () => {
    const f = fakeGpu();
    const onLost = vi.fn();
    const r = await createWebGpuHdrPresenter(f.canvas, f.gpu, onLost);
    if (!('presenter' in r)) throw new Error(r.reason);
    f.lose('gone');
    await Promise.resolve();
    await Promise.resolve();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0]![0]).toContain('gone');
    f.calls.length = 0;
    r.presenter.present(layer(10, 10), 2);
    expect(f.calls).toEqual([]);
  });

  it('treats a present that throws as a loss', async () => {
    const f = fakeGpu();
    const onLost = vi.fn();
    const r = await createWebGpuHdrPresenter(f.canvas, f.gpu, onLost);
    if (!('presenter' in r)) throw new Error(r.reason);
    f.device.queue.copyExternalImageToTexture = () => {
      throw new Error('copy refused');
    };
    r.presenter.present(layer(10, 10), 2);
    expect(onLost).toHaveBeenCalledWith(expect.stringContaining('copy refused'));
    expect(f.device.destroy).toHaveBeenCalled();
  });
});
