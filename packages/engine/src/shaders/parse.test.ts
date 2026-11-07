import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseShaderFile, ShaderFileError, validateShaderFile } from './parse';

const basic = (n: string): string => readFileSync(`fixtures/shaders/basic/${n}.glsl`, 'utf8');

describe('parseShaderFile', () => {
  it('parses directives and defaults', () => {
    const p = parseShaderFile('chain.glsl', basic('chain'));
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ hooks: ['MAIN'], binds: ['HOOKED'], save: 'TINT', components: 1, width: null });
    expect(p[1]).toMatchObject({ binds: ['HOOKED', 'TINT'], save: null });
    for (const pass of p) {
      expect(pass.body).toContain('vec4 hook()');
      expect(pass.body).not.toMatch(/^\s*\/\/!/m);
    }
  });

  it('keeps RPN text', () => {
    expect(parseShaderFile('nearest-x2.glsl', basic('nearest-x2'))[0]!.width).toBe('MAIN.w 2 *');
  });

  it('tolerates CRLF, BOM and extra spaces', () => {
    const clean = basic('passthrough');
    const messy = '\uFEFF' + clean.replace(/\n/g, '\r\n').replace('//!HOOK MAIN', '//!HOOK  MAIN  ');
    expect(parseShaderFile('p.glsl', messy)).toEqual(parseShaderFile('p.glsl', clean));
  });

  it('parses every Anime4K fixture', () => {
    const dir = 'fixtures/shaders/anime4k';
    const files = readdirSync(dir).filter((f) => f.endsWith('.glsl'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const passes = parseShaderFile(f, readFileSync(`${dir}/${f}`, 'utf8'));
      expect(passes.length).toBeGreaterThan(0);
      if (f === 'Anime4K_Clamp_Highlights.glsl') expect(passes.at(-1)!.hooks).toEqual(['PREKERNEL']);
      if (f === 'Anime4K_Upscale_CNN_x2_VL.glsl') {
        for (const p of passes) expect(p.binds.length).toBeLessThanOrEqual(16);
      }
    }
  });

  it('rejects unsupported directives with line numbers', () => {
    const err = (src: string): ShaderFileError => {
      try {
        parseShaderFile('x.glsl', src);
      } catch (e) {
        return e as ShaderFileError;
      }
      throw new Error('did not throw');
    };
    const c = err(basic('compute'));
    expect(c).toBeInstanceOf(ShaderFileError);
    expect(c.reason).toContain('COMPUTE');
    expect(c.line).toBe(3);
    for (const d of ['TEXTURE tex', 'PARAM p', 'BUFFER b', 'OFFSET 1 1']) {
      const e = err(`//!HOOK MAIN\n//!${d}\nvec4 hook() { return vec4(0); }\n`);
      expect(e.reason).toContain(d.split(' ')[0]);
      expect(e.line).toBe(2);
    }
  });
});

describe('validateShaderFile', () => {
  it('reports hook-only-LUMA, size, missing hooks and accepts valid files', () => {
    const luma = basic('luma-only');
    expect(validateShaderFile('l.glsl', luma, luma.length)).toBe(
      "this shader hooks only LUMA, which this player doesn't provide",
    );
    expect(validateShaderFile('big.glsl', basic('passthrough'), 4 * 1024 * 1024 + 1)).toContain('4 MiB');
    const ok = basic('passthrough');
    expect(validateShaderFile('p.glsl', ok, ok.length)).toBeNull();
    expect(validateShaderFile('n.glsl', 'vec4 hook() { return vec4(0); }\n', 30)).toEqual(expect.any(String));
  });
});
