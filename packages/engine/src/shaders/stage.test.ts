import { describe, expect, it } from 'vitest';
import type { ShaderSetData, ShaderState } from '../protocol';
import type { ShaderPass } from './parse';
import { ShaderStage } from './stage';
import { ShaderCompileError, ShaderContextLostError, ShaderSetStaleError, type CompiledSet, type RenderResult, type ShaderBackend } from './webgl-backend';

const PASS = '//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n';

interface FakeSet extends CompiledSet {
  readonly id: number;
  disposed: boolean;
}

interface PendingCompile {
  readonly passes: readonly ShaderPass[];
  readonly set: FakeSet;
  resolve(): void;
  reject(err: Error): void;
}

function fakeBackend() {
  const compiles: PendingCompile[] = [];
  const renders: Array<{ set: FakeSet; frame: VideoFrame; output: { width: number; height: number } }> = [];
  const images = new Map<number, OffscreenCanvas>();
  const state = { renderError: null as Error | null };
  const imageOf = (set: FakeSet): OffscreenCanvas => {
    let image = images.get(set.id);
    if (!image) images.set(set.id, (image = { sentinel: set.id } as unknown as OffscreenCanvas));
    return image;
  };
  const backend: ShaderBackend = {
    compile(passes) {
      return new Promise<CompiledSet>((resolve, reject) => {
        const set: FakeSet = { id: compiles.length, passes, disposed: false, dispose() { set.disposed = true; } };
        compiles.push({ passes, set, resolve: () => resolve(set), reject });
      });
    },
    render(set, frame, output): RenderResult {
      const s = set as FakeSet;
      renders.push({ set: s, frame, output });
      if (state.renderError) throw state.renderError;
      return { image: imageOf(s), passesRun: s.passes.length, gpuMs: 1.5 };
    },
  };
  return { backend, compiles, renders, imageOf, state };
}

function setup(backend?: ShaderBackend | string) {
  const fake = fakeBackend();
  const statuses: Array<{ state: ShaderState; set: string | null; error: string | null }> = [];
  let ready = 0;
  const stage = new ShaderStage(backend ?? fake.backend, (s) => statuses.push(s), () => ready++);
  return { ...fake, stage, statuses, ready: () => ready };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const set = (name: string, source = PASS, file = 'a.glsl'): ShaderSetData => ({ name, files: [{ name: file, source }] });
const frame = (): VideoFrame => ({}) as VideoFrame;
const OUT = { width: 1920, height: 1080 };

describe('ShaderStage', () => {
  it('compiles a set, then shades frames with it', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    expect(t.statuses).toEqual([{ state: 'compiling', set: 'A', error: null }]);
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.ready()).toBe(0);
    t.compiles[0]!.resolve();
    await settle();
    expect(t.statuses.at(-1)).toEqual({ state: 'active', set: 'A', error: null });
    expect(t.ready()).toBe(1);
    expect(t.stage.process(frame(), OUT)).toBe(t.imageOf(t.compiles[0]!.set));
    expect(t.stage.stats).toEqual({ set: 'A', passesRun: 1, gpuMs: 1.5 });
  });

  it('reuses the output for the same frame and size, and renders again for a new size or frame', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    const f = frame();
    t.stage.process(f, OUT);
    t.stage.process(f, { width: 1920, height: 1080 });
    expect(t.renders).toHaveLength(1);
    t.stage.process(f, { width: 1280, height: 720 });
    expect(t.renders).toHaveLength(2);
    expect(t.renders[1]!.output).toEqual({ width: 1280, height: 720 });
    t.stage.process(frame(), { width: 1280, height: 720 });
    expect(t.renders).toHaveLength(3);
  });

  it('keeps shading with A while B compiles, and switches back to a cached A at once', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    const a = t.imageOf(t.compiles[0]!.set);
    t.stage.setSet(set('B', PASS + '\n// b\n'));
    expect(t.statuses.at(-1)).toEqual({ state: 'compiling', set: 'B', error: null });
    expect(t.stage.process(frame(), OUT)).toBe(a);
    t.compiles[1]!.resolve();
    await settle();
    expect(t.statuses.at(-1)).toEqual({ state: 'active', set: 'B', error: null });
    expect(t.stage.process(frame(), OUT)).toBe(t.imageOf(t.compiles[1]!.set));
    const before = t.statuses.length;
    t.stage.setSet(set('A'));
    expect(t.statuses.slice(before)).toEqual([{ state: 'active', set: 'A', error: null }]);
    expect(t.compiles).toHaveLength(2);
    expect(t.stage.process(frame(), OUT)).toBe(a);
    expect(t.ready()).toBe(3);
  });

  it('caches a compile that finishes after another set was chosen, without activating it', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.stage.setSet(set('B', PASS + '\n// b\n'));
    t.compiles[0]!.resolve();
    await settle();
    expect(t.statuses.at(-1)).toEqual({ state: 'compiling', set: 'B', error: null });
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.ready()).toBe(0);
    t.stage.setSet(set('A'));
    expect(t.statuses.at(-1)).toEqual({ state: 'active', set: 'A', error: null });
    expect(t.compiles).toHaveLength(2);
  });

  it('recompiles a set whose name is the same but whose source changed', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    t.stage.setSet(set('A', PASS + '\n// edited\n'));
    expect(t.compiles).toHaveLength(2);
    expect(t.statuses.at(-1)).toEqual({ state: 'compiling', set: 'A', error: null });
    t.compiles[1]!.resolve();
    await settle();
    expect(t.stage.process(frame(), OUT)).toBe(t.imageOf(t.compiles[1]!.set));
  });

  it('reports a file error with its file and line, and draws the raw frame', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    t.stage.setSet(set('Bad', PASS + '//!HOOK MAIN\n//!COMPUTE 8 8\n', 'bad.glsl'));
    expect(t.statuses.at(-1)).toEqual({ state: 'error', set: 'Bad', error: 'bad.glsl line 5: //!COMPUTE is not supported' });
    expect(t.compiles).toHaveLength(1);
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.stage.stats).toBeNull();
  });

  it('reports a compile error with its file and pass, and draws the raw frame', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.reject(new ShaderCompileError('a.glsl', 'Upscale', "ERROR: 0:12: 'foo' : undeclared identifier"));
    await settle();
    expect(t.statuses.at(-1)).toEqual({ state: 'error', set: 'A', error: "a.glsl, Upscale: ERROR: 0:12: 'foo' : undeclared identifier" });
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.ready()).toBe(0);
  });

  it('reports unavailable with the reason for every set', () => {
    const t = setup('Shaders need WebGL2.');
    t.stage.setSet(set('A'));
    t.stage.setSet(null);
    expect(t.statuses).toEqual([
      { state: 'unavailable', set: 'A', error: 'Shaders need WebGL2.' },
      { state: 'unavailable', set: null, error: 'Shaders need WebGL2.' },
    ]);
    expect(t.stage.process(frame(), OUT)).toBeNull();
  });

  it('turns off: raw frames, status off, a repaint', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    t.stage.setSet(null);
    expect(t.statuses.at(-1)).toEqual({ state: 'off', set: null, error: null });
    expect(t.ready()).toBe(2);
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.stage.stats).toBeNull();
  });

  it('drops to raw frames on context loss and recompiles the selected set on restore', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    t.stage.contextLost();
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', set: 'A' });
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.compiles[0]!.set.disposed).toBe(true);
    t.stage.contextRestored();
    expect(t.compiles).toHaveLength(2);
    expect(t.statuses.at(-1)).toEqual({ state: 'compiling', set: 'A', error: null });
    t.compiles[1]!.resolve();
    await settle();
    expect(t.statuses.at(-1)).toEqual({ state: 'active', set: 'A', error: null });
    expect(t.stage.process(frame(), OUT)).toBe(t.imageOf(t.compiles[1]!.set));
  });

  it('treats a lost context during render as a context loss, never throwing', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    t.state.renderError = new ShaderContextLostError();
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', set: 'A' });
    t.state.renderError = null;
    expect(t.stage.process(frame(), OUT)).toBeNull();
    t.stage.contextLost(); // the event arrives after render noticed
    t.stage.contextRestored();
    expect(t.compiles).toHaveLength(2);
    t.compiles[1]!.resolve();
    await settle();
    expect(t.stage.process(frame(), OUT)).toBe(t.imageOf(t.compiles[1]!.set));
  });

  it('treats a lost context during compile as a context loss, not a shader error', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.reject(new ShaderContextLostError());
    await settle();
    expect(t.statuses.at(-1)).toEqual({ state: 'error', set: 'A', error: 'WebGL context lost' });
    t.stage.contextLost();
    t.stage.contextRestored();
    expect(t.compiles).toHaveLength(2);
    t.compiles[1]!.resolve();
    await settle();
    expect(t.statuses.at(-1)).toEqual({ state: 'active', set: 'A', error: null });
  });

  it('ignores a compile that settles after the context was lost', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.stage.contextLost();
    t.compiles[0]!.resolve();
    await settle();
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', set: 'A' });
    expect(t.compiles[0]!.set.disposed).toBe(true);
    expect(t.stage.process(frame(), OUT)).toBeNull();
  });

  it('remembers a set chosen while the context is lost and compiles it on restore', async () => {
    const t = setup();
    t.stage.contextLost();
    t.stage.setSet(set('A'));
    expect(t.compiles).toHaveLength(0);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', set: 'A' });
    t.stage.contextRestored();
    t.compiles[0]!.resolve();
    await settle();
    expect(t.statuses.at(-1)).toEqual({ state: 'active', set: 'A', error: null });
  });

  it('drops a stale set that fails to render and recompiles it while it is selected', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    t.state.renderError = new ShaderSetStaleError();
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.stage.stats).toBeNull();
    t.state.renderError = null;
    expect(t.compiles).toHaveLength(2);
    expect(t.statuses.at(-1)).toEqual({ state: 'compiling', set: 'A', error: null });
    t.compiles[1]!.resolve();
    await settle();
    expect(t.stage.process(frame(), OUT)).toBe(t.imageOf(t.compiles[1]!.set));
  });

  it('stays unshaded with an error, without recompiling, when the set fails to render', async () => {
    const t = setup();
    t.stage.setSet(set('A'));
    t.compiles[0]!.resolve();
    await settle();
    expect(t.stage.process(frame(), OUT)).not.toBeNull();
    expect(t.stage.stats).not.toBeNull();
    t.state.renderError = new Error('WebGL: createFramebuffer failed');
    expect(t.stage.process(frame(), OUT)).toBeNull();
    expect(t.statuses.at(-1)).toEqual({ state: 'error', set: 'A', error: 'WebGL: createFramebuffer failed' });
    expect(t.stage.stats).toBeNull();
    for (let i = 0; i < 3; i++) expect(t.stage.process(frame(), OUT)).toBeNull();
    await settle();
    expect(t.compiles).toHaveLength(1);
    expect(t.renders).toHaveLength(2);
    expect(t.statuses.at(-1)!.state).toBe('error');
  });
});
