import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseShaderFile, type ShaderPass } from './parse';
import { planFrame, type Size } from './plan';

const basic = (n: string): ShaderPass[] =>
  parseShaderFile(`${n}.glsl`, readFileSync(`fixtures/shaders/basic/${n}.glsl`, 'utf8'));
const anime4k = (n: string): ShaderPass[] =>
  parseShaderFile(`Anime4K_${n}.glsl`, readFileSync(`fixtures/shaders/anime4k/Anime4K_${n}.glsl`, 'utf8'));
const inline = (text: string): ShaderPass[] => parseShaderFile('inline.glsl', text);
const size = (width: number, height: number): Size => ({ width, height });

describe('planFrame', () => {
  it('empty set', () => {
    const plan = planFrame([], size(1920, 1080), size(1920, 1080));
    expect(plan.passes).toEqual([]);
    expect(plan.final).toEqual({ id: 0, width: 1920, height: 1080, components: 4 });
    expect(plan.output).toEqual(size(1920, 1080));
  });

  it('nearest-x2 doubles MAIN', () => {
    const plan = planFrame(basic('nearest-x2'), size(640, 360), size(1280, 720));
    expect(plan.passes).toHaveLength(1);
    const p = plan.passes[0]!;
    expect(p.stage).toBe('MAIN');
    expect(p.hooked.id).toBe(0);
    expect(p.inputs).toEqual([{ name: 'HOOKED', tex: p.hooked }]);
    expect(p.out).toMatchObject({ width: 1280, height: 720, components: 4 });
    expect(p.out.id).not.toBe(0);
    expect(p.saveAs).toBe('MAIN');
    expect(plan.final).toBe(p.out);
  });

  it('SAVE replaces by name and BIND sees the latest', () => {
    const plan = planFrame([...basic('chain'), ...basic('chain')], size(640, 360), size(640, 360));
    expect(plan.passes).toHaveLength(4);
    const [tint1, combine1, tint2, combine2] = plan.passes;
    expect(tint1!.saveAs).toBe('TINT');
    expect(tint1!.out.components).toBe(1);
    // SAVE to another name leaves the stage texture alone.
    expect(combine1!.hooked.id).toBe(0);
    expect(combine1!.inputs.find((i) => i.name === 'TINT')!.tex).toBe(tint1!.out);
    expect(tint2!.hooked).toBe(combine1!.out);
    expect(combine2!.inputs.map((i) => i.name)).toEqual(['HOOKED', 'TINT']);
    expect(combine2!.inputs[1]!.tex).toBe(tint2!.out);
    expect(plan.final).toBe(combine2!.out);
  });

  it('skips a pass whose size is not finite', () => {
    const plan = planFrame(basic('invert'), size(Infinity, 360), size(640, 360));
    expect(plan.passes).toEqual([]);
  });

  it('skips a pass larger than the max texture size', () => {
    const set = [...basic('nearest-x2'), ...basic('invert')];
    const capped = planFrame(set, size(640, 360), size(1280, 720), 1000);
    expect(capped.passes.map((p) => p.pass.desc)).toEqual(['invert']);
    expect(capped.passes[0]!.out).toMatchObject({ width: 640, height: 360 });
    const exact = planFrame(set, size(640, 360), size(1280, 720), 1280);
    expect(exact.passes.map((p) => p.pass.desc)).toEqual(['nearest x2', 'invert']);
  });

  it('missing BIND skips', () => {
    const passes = inline('//!HOOK MAIN\n//!BIND HOOKED\n//!BIND NOPE\n//!DESC nope\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n');
    const plan = planFrame([...passes, ...basic('invert')], size(640, 360), size(640, 360));
    expect(plan.passes.map((p) => p.pass.desc)).toEqual(['invert']);
  });

  it('WHEN sees sizes changing mid-chain', () => {
    const set = [...basic('nearest-x2'), ...basic('when-skip')];
    const small = planFrame(set, size(640, 360), size(1280, 720));
    expect(small.passes.map((p) => p.pass.desc)).toEqual(['nearest x2']);
    const big = planFrame(set, size(640, 360), size(2560, 1440));
    expect(big.passes.map((p) => p.pass.desc)).toEqual(['nearest x2', 'when skip']);
    expect(big.passes[1]!.hooked).toBe(big.passes[0]!.out);
  });

  it('PREKERNEL runs after MAIN', () => {
    const plan = planFrame([...basic('prekernel'), ...basic('invert')], size(640, 360), size(640, 360));
    expect(plan.passes.map((p) => [p.pass.desc, p.stage])).toEqual([
      ['invert', 'MAIN'],
      ['prekernel', 'PREKERNEL'],
    ]);
    expect(plan.passes[1]!.hooked).toBe(plan.passes[0]!.out);
    expect(plan.final).toBe(plan.passes[1]!.out);
  });

  it('hooks that never fire are ignored', () => {
    const plan = planFrame(basic('luma-only'), size(640, 360), size(640, 360));
    expect(plan.passes).toEqual([]);
    expect(plan.final.id).toBe(0);
  });

  it('NATIVE runs first and its result starts MAIN', () => {
    const native = inline('//!HOOK NATIVE\n//!BIND HOOKED\n//!WIDTH HOOKED.w 2 *\n//!DESC native\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n');
    const plan = planFrame([...basic('invert'), ...native], size(640, 360), size(640, 360));
    expect(plan.passes.map((p) => [p.pass.desc, p.stage])).toEqual([
      ['native', 'NATIVE'],
      ['invert', 'MAIN'],
    ]);
    expect(plan.passes[1]!.hooked).toBe(plan.passes[0]!.out);
    expect(plan.final.width).toBe(1280);
  });

  it('a pass hooking several stages runs in each, MAIN and MAINPRESUB once', () => {
    const multi = inline('//!HOOK MAIN\n//!HOOK MAINPRESUB\n//!HOOK PREKERNEL\n//!BIND HOOKED\n//!DESC multi\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n');
    const plan = planFrame(multi, size(640, 360), size(640, 360));
    expect(plan.passes.map((p) => p.stage)).toEqual(['MAIN', 'PREKERNEL']);
  });

  it('expressions see OUTPUT, NATIVE_CROPPED and the table; SAVE HOOKED and MAINPRESUB alias the stage', () => {
    const set = inline(
      [
        '//!HOOK MAIN\n//!BIND HOOKED\n//!WIDTH OUTPUT.w\n//!HEIGHT NATIVE_CROPPED.h 3 *\n//!SAVE HOOKED\n//!COMPONENTS 3\n//!DESC a\nvec4 hook() { return vec4(0.0); }',
        '//!HOOK MAIN\n//!BIND MAINPRESUB\n//!WIDTH MAIN.w 1 +\n//!SAVE MAINPRESUB\n//!DESC b\nvec4 hook() { return vec4(0.0); }',
      ].join('\n'),
    );
    const plan = planFrame(set, size(640, 360), size(1000, 500));
    const [a, b] = plan.passes;
    expect(a!.out).toMatchObject({ width: 1000, height: 1080, components: 4 });
    expect(a!.saveAs).toBe('MAIN');
    expect(b!.inputs).toEqual([{ name: 'MAINPRESUB', tex: a!.out }]);
    expect(b!.out).toMatchObject({ width: 1001, height: 1080 });
    expect(plan.final).toBe(b!.out);
  });

  it('skips malformed expressions, unknown size names and empty sizes without throwing', () => {
    const set = inline(
      [
        '//!HOOK MAIN\n//!BIND HOOKED\n//!WHEN 1 +\n//!DESC malformed\nvec4 hook() { return vec4(0.0); }',
        '//!HOOK MAIN\n//!BIND HOOKED\n//!WIDTH NOPE.w\n//!DESC unknown\nvec4 hook() { return vec4(0.0); }',
        '//!HOOK MAIN\n//!BIND HOOKED\n//!WIDTH HOOKED.w 0.4 *\n//!HEIGHT 0.4\n//!DESC zero\nvec4 hook() { return vec4(0.0); }',
        '//!HOOK MAIN\n//!BIND HOOKED\n//!WHEN 0\n//!DESC off\nvec4 hook() { return vec4(0.0); }',
        '//!HOOK MAIN\n//!BIND HOOKED\n//!WIDTH HOOKED.w 2 /\n//!DESC kept\nvec4 hook() { return vec4(0.0); }',
      ].join('\n'),
    );
    const plan = planFrame(set, size(641, 361), size(641, 361));
    expect(plan.passes.map((p) => p.pass.desc)).toEqual(['kept']);
    expect(plan.final).toMatchObject({ width: 321, height: 361 });
  });

  describe('Anime4K Mode A (Fast) plans', () => {
    const modeA = [
      ...anime4k('Clamp_Highlights'),
      ...anime4k('Restore_CNN_M'),
      ...anime4k('Upscale_CNN_x2_M'),
      ...anime4k('AutoDownscalePre_x2'),
      ...anime4k('AutoDownscalePre_x4'),
      ...anime4k('Upscale_CNN_x2_S'),
    ];
    const files = (plan: ReturnType<typeof planFrame>): Set<string> => new Set(plan.passes.map((p) => p.pass.file));
    const count = (plan: ReturnType<typeof planFrame>, file: string): number =>
      plan.passes.filter((p) => p.pass.file === `Anime4K_${file}.glsl`).length;

    it('at 1920x1080 output only restores and clamps', () => {
      const plan = planFrame(modeA, size(1920, 1080), size(1920, 1080));
      expect([...files(plan)].sort()).toEqual(['Anime4K_Clamp_Highlights.glsl', 'Anime4K_Restore_CNN_M.glsl']);
      expect(count(plan, 'Restore_CNN_M')).toBe(anime4k('Restore_CNN_M').length);
      expect(count(plan, 'Clamp_Highlights')).toBe(3);
      expect(plan.final).toMatchObject({ width: 1920, height: 1080 });
      expect(plan.passes.at(-1)!.stage).toBe('PREKERNEL');
    });

    it('at 3840x2160 output runs Upscale_CNN_x2_M only', () => {
      const plan = planFrame(modeA, size(1920, 1080), size(3840, 2160));
      expect(count(plan, 'Upscale_CNN_x2_M')).toBe(anime4k('Upscale_CNN_x2_M').length);
      expect(count(plan, 'Upscale_CNN_x2_S')).toBe(0);
      expect(count(plan, 'AutoDownscalePre_x2')).toBe(0);
      expect(count(plan, 'AutoDownscalePre_x4')).toBe(0);
      expect(plan.final).toMatchObject({ width: 3840, height: 2160 });
    });

    it('at 2560x1440 output upscales then downscales to the output', () => {
      const plan = planFrame(modeA, size(1920, 1080), size(2560, 1440));
      expect(count(plan, 'Upscale_CNN_x2_M')).toBe(anime4k('Upscale_CNN_x2_M').length);
      expect(count(plan, 'AutoDownscalePre_x2')).toBe(1);
      expect(count(plan, 'AutoDownscalePre_x4')).toBe(0);
      expect(count(plan, 'Upscale_CNN_x2_S')).toBe(0);
      const down = plan.passes.find((p) => p.pass.file === 'Anime4K_AutoDownscalePre_x2.glsl')!;
      expect(down.hooked).toMatchObject({ width: 3840, height: 2160 });
      expect(down.inputs.find((i) => i.name === 'NATIVE')!.tex.id).toBe(0);
      expect(down.out).toMatchObject({ width: 2560, height: 1440 });
      expect(plan.final).toMatchObject({ width: 2560, height: 1440 });
    });

    it('resize changes the plan; planning is pure', () => {
      const a = planFrame(modeA, size(1920, 1080), size(1920, 1080));
      const b = planFrame(modeA, size(1920, 1080), size(3840, 2160));
      expect(a.passes.length).not.toBe(b.passes.length);
      expect(a.final).not.toEqual(b.final);
      expect(planFrame(modeA, size(1920, 1080), size(3840, 2160))).toEqual(b);
      expect(planFrame(modeA, size(1920, 1080), size(1920, 1080))).toEqual(a);
    });
  });
});
