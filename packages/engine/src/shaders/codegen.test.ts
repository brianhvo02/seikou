import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fragmentSource, VERTEX_SHADER } from './codegen';
import { FIRING_HOOKS, parseShaderFile, type ShaderPass } from './parse';

const basic = (n: string): ShaderPass[] =>
  parseShaderFile(`${n}.glsl`, readFileSync(`fixtures/shaders/basic/${n}.glsl`, 'utf8'));
const inline = (text: string): ShaderPass[] => parseShaderFile('inline.glsl', text);
const samplerLines = (src: string): string[] => src.split('\n').filter((l) => l.startsWith('uniform sampler2D '));

const SUFFIXES = ['tex', 'texOff', 'pos', 'size', 'pt', 'mul', 'raw', 'rot', 'off'];

describe('fragmentSource', () => {
  it('chain.glsl pass 1 at MAIN', () => {
    const pass = basic('chain')[1]!;
    const src = fragmentSource(pass, 'MAIN');
    expect(src.startsWith('#version 300 es\n')).toBe(true);
    expect(src).toContain('uniform sampler2D HOOKED_raw;');
    expect(src).toContain('uniform sampler2D TINT_raw;');
    expect(src).toContain('#define TINT_tex(pos) (TINT_mul * textureLod(TINT_raw, pos, 0.0))');
    expect(src).toContain('#define TINT_texOff(off) TINT_tex(TINT_pos + TINT_pt * vec2(off))');
    expect(src).toContain('#define TINT_pos v_pos');
    expect(src).toContain(pass.body);
    expect(src.trimEnd()).toMatch(/void main\(\) \{\s*\w+ = hook\(\);\s*\}$/);
    const out = /^out vec4 (\w+);$/m.exec(src);
    expect(out).not.toBeNull();
    expect(src.trimEnd()).toMatch(new RegExp(`${out![1]} = hook\\(\\);\\s*\\}$`));
  });

  it('VERTEX_SHADER is GLSL ES 3.00 and writes v_pos', () => {
    expect(VERTEX_SHADER.startsWith('#version 300 es\n')).toBe(true);
    expect(VERTEX_SHADER).toContain('out vec2 v_pos;');
  });

  it('BIND MAIN at MAIN aliases HOOKED to MAIN', () => {
    const [pass] = inline('//!HOOK MAIN\n//!BIND MAIN\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n');
    const src = fragmentSource(pass!, 'MAIN');
    expect(src).toContain('uniform sampler2D MAIN_raw;');
    expect(src).not.toContain('uniform sampler2D HOOKED_raw;');
    for (const s of ['tex', 'pos', 'size', 'pt']) expect(src).toMatch(new RegExp(`^#define HOOKED_${s}\\b.*\\bMAIN_${s}\\b`, 'm'));
  });

  it('BIND HOOKED at MAIN aliases MAIN to HOOKED', () => {
    const [pass] = inline('//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook() { return MAIN_tex(MAIN_pos); }\n');
    const src = fragmentSource(pass!, 'MAIN');
    expect(samplerLines(src)).toEqual(['uniform sampler2D HOOKED_raw;']);
    for (const s of ['tex', 'texOff', 'pos', 'size', 'pt']) expect(src).toMatch(new RegExp(`^#define MAIN_${s}\\b.*\\bHOOKED_${s}\\b`, 'm'));
  });

  it('binding both HOOKED and the stage defines no aliases', () => {
    const [pass] = inline('//!HOOK MAIN\n//!BIND HOOKED\n//!BIND MAIN\nvec4 hook() { return MAIN_tex(HOOKED_pos); }\n');
    const src = fragmentSource(pass!, 'MAIN');
    expect(samplerLines(src)).toHaveLength(2);
    expect(src).not.toMatch(/^#define (MAIN|HOOKED)_tex (MAIN|HOOKED)_tex$/m);
  });

  it('BIND MAINPRESUB at MAIN also aliases HOOKED', () => {
    const [pass] = inline('//!HOOK MAINPRESUB\n//!BIND MAINPRESUB\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n');
    expect(fragmentSource(pass!, 'MAIN')).toMatch(/^#define HOOKED_tex\b.*\bMAINPRESUB_tex\b/m);
  });

  it('no HOOKED macros without a binding of HOOKED or the stage', () => {
    const [pass] = inline('//!HOOK MAIN\n//!BIND NATIVE\nvec4 hook() { return NATIVE_tex(NATIVE_pos); }\n');
    const src = fragmentSource(pass!, 'MAIN');
    expect(src).not.toContain('HOOKED_');
    expect(src).toContain('#define NATIVE_pos v_pos');
  });

  it('one sampler per BIND, none reserved', () => {
    for (const name of ['chain', 'invert', 'nearest-x2', 'passthrough', 'prekernel']) {
      for (const pass of basic(name)) {
        const stage = pass.hooks.find((h) => FIRING_HOOKS.includes(h)) ?? 'MAIN';
        expect(samplerLines(fragmentSource(pass, stage))).toHaveLength(pass.binds.length);
      }
    }
    const binds = Array.from({ length: 16 }, (_, i) => `//!BIND T${i}`).join('\n');
    const [pass] = inline(`//!HOOK MAIN\n${binds}\nvec4 hook() { return T0_tex(T0_pos); }\n`);
    expect(samplerLines(fragmentSource(pass!, 'MAIN'))).toHaveLength(16);
  });

  it('declares the global uniforms', () => {
    const src = fragmentSource(basic('invert')[0]!, 'MAIN');
    for (const u of ['int frame', 'float random', 'vec2 input_size', 'vec2 target_size', 'vec2 tex_offset']) {
      expect(src).toContain(`uniform ${u};`);
    }
  });

  const files = readdirSync('fixtures/shaders/anime4k').filter((f) => f.endsWith('.glsl'));
  it.each(files)('%s only uses macros it defines', (file) => {
    const passes = parseShaderFile(file, readFileSync(`fixtures/shaders/anime4k/${file}`, 'utf8'));
    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      const stage = pass.hooks.find((h) => FIRING_HOOKS.includes(h))!;
      const src = fragmentSource(pass, stage);
      // Parameters of function-like macros in the body (`go_0(x_off, y_off)`) are not texture macros.
      const params = new Set<string>();
      for (const m of pass.body.matchAll(/#define\s+\w+\(([^)]*)\)/g)) {
        for (const p of m[1]!.split(',')) params.add(p.trim());
      }
      // Binding HOOKED also defines the stage's own name (MAIN_texOff in Clamp_Highlights), as in libplacebo.
      const allowed = new Set([...pass.binds, 'HOOKED', stage]);
      for (const m of pass.body.matchAll(new RegExp(`\\b([A-Za-z0-9_]+)_(${SUFFIXES.join('|')})\\b`, 'g'))) {
        if (params.has(m[0])) continue;
        expect(allowed, `${pass.desc}: ${m[0]}`).toContain(m[1]);
        const definedAsMacro = new RegExp(`^#define ${m[0]}\\b`, 'm').test(src);
        const declared = new RegExp(`^uniform \\w+ ${m[0]};`, 'm').test(src);
        expect(definedAsMacro || declared, `${pass.desc}: ${m[0]} undefined`).toBe(true);
      }
    }
  });
});
