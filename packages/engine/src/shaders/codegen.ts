/*
 * Original code for bluray-web, 2026. Builds the GLSL ES 3.00 source of an
 * mpv user shader pass. The texture macros follow the definitions libplacebo
 * emits in bind_pass_tex and hook_hook (src/shaders/custom_mpv.c), spec
 * section 3.4.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ShaderPass } from './parse';

/** A full-screen triangle drawn with `drawArrays(TRIANGLES, 0, 3)` and no attributes. */
export const VERTEX_SHADER = `#version 300 es
out vec2 v_pos;
void main() {
    vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1));
    v_pos = p * 0.5;
    gl_Position = vec4(p - 1.0, 0.0, 1.0);
}
`;

/** Name of the fragment output; `main()` assigns `hook()` to it. */
const OUT = 'out_color';

/** libplacebo treats MAIN and MAINPRESUB as one name. */
function canonical(name: string): string {
  return name === 'MAINPRESUB' ? 'MAIN' : name;
}

function bindMacros(name: string): string[] {
  return [
    `uniform sampler2D ${name}_raw;`,
    `uniform vec2 ${name}_size;`,
    `uniform vec2 ${name}_pt;`,
    `#define ${name}_pos v_pos`,
    `#define ${name}_mul 1.0`,
    `#define ${name}_rot mat2(1.0)`,
    `#define ${name}_off vec2(0.0)`,
    `#define ${name}_tex(pos) (${name}_mul * textureLod(${name}_raw, pos, 0.0))`,
    `#define ${name}_texOff(off) ${name}_tex(${name}_pos + ${name}_pt * vec2(off))`,
  ];
}

const ALIASED = ['raw', 'size', 'pt', 'pos', 'mul', 'rot', 'off', 'tex', 'texOff'];

/**
 * `hooked` is the stage name the pass runs at; samplers are `${BIND}_raw`, uniforms `${BIND}_size`, `${BIND}_pt`,
 * plus `frame`, `random`, `input_size`, `target_size`, `tex_offset`.
 */
export function fragmentSource(pass: ShaderPass, hooked: string): string {
  const lines = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler2D;',
    'in vec2 v_pos;',
    `out vec4 ${OUT};`,
    'uniform int frame;',
    'uniform float random;',
    'uniform vec2 input_size;',
    'uniform vec2 target_size;',
    'uniform vec2 tex_offset;',
  ];
  for (const name of pass.binds) lines.push(...bindMacros(name));

  // The hooked texture answers to HOOKED and to the stage's names (MAIN also as MAINPRESUB when the pass hooks it
  // so), as in libplacebo: whichever is bound, the others become macro aliases sharing its sampler.
  const stageNames = [...new Set([hooked, ...pass.hooks.filter((h) => canonical(h) === canonical(hooked))])];
  const bound = pass.binds.find((b) => b === 'HOOKED' || stageNames.includes(b));
  if (bound !== undefined) {
    for (const alias of ['HOOKED', ...stageNames]) {
      if (pass.binds.includes(alias)) continue;
      for (const s of ALIASED) lines.push(`#define ${alias}_${s} ${bound}_${s}`);
    }
  }

  lines.push('', pass.body, `void main() {`, `    ${OUT} = hook();`, `}`, '');
  return lines.join('\n');
}
