/*
 * Original code for bluray-web, 2026. Plans one frame of mpv user shader
 * passes. Hook semantics follow libplacebo's hook_hook and lookup_tex in
 * src/shaders/custom_mpv.c (spec section 3.2-3.3).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ShaderPass } from './parse';
import { evalRpn, RpnError, type SizeLookup } from './rpn';

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** id 0 is the uploaded frame (RGBA8); every pass output gets a new id. */
export interface TexRef {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly components: 1 | 2 | 4;
}

export type PlanStage = 'NATIVE' | 'MAIN' | 'PREKERNEL';

export interface PlannedPass {
  readonly pass: ShaderPass;
  readonly stage: PlanStage;
  readonly hooked: TexRef;
  /** In BIND order; `name` is the BIND text (HOOKED stays HOOKED). */
  readonly inputs: readonly { readonly name: string; readonly tex: TexRef }[];
  readonly out: TexRef;
  readonly saveAs: string;
}

export interface FramePlan {
  readonly passes: readonly PlannedPass[];
  readonly final: TexRef;
  readonly output: Size;
}

const STAGES: readonly PlanStage[] = ['NATIVE', 'MAIN', 'PREKERNEL'];

/** libplacebo treats MAIN and MAINPRESUB as one name. */
function canonical(name: string): string {
  return name === 'MAINPRESUB' ? 'MAIN' : name;
}

function firesIn(pass: ShaderPass, stage: PlanStage): boolean {
  return pass.hooks.some((h) => canonical(h) === stage);
}

/** Null when the expression is malformed, names an unknown texture or is non-finite. */
function evaluate(expr: string, lookup: SizeLookup): number | null {
  try {
    return evalRpn(expr, lookup);
  } catch (e) {
    if (e instanceof RpnError) return null;
    throw e;
  }
}

/** A pass whose output would be non-finite, empty or larger than `maxTextureSize` on either side is skipped. */
export function planFrame(passes: readonly ShaderPass[], source: Size, output: Size, maxTextureSize = Infinity): FramePlan {
  const frame: TexRef = { id: 0, width: source.width, height: source.height, components: 4 };
  const table = new Map<string, TexRef>([
    ['NATIVE', frame],
    ['MAIN', frame],
  ]);
  const planned: PlannedPass[] = [];
  let nextId = 1;
  // The texture handed from one stage to the next.
  let current = frame;

  for (const stage of STAGES) {
    // libplacebo saves the stage's input texture under the stage name on entry.
    let hooked = current;
    table.set(stage, hooked);

    const lookup: SizeLookup = (name) => {
      if (name === 'HOOKED') return hooked;
      if (name === 'NATIVE_CROPPED') return source;
      if (name === 'OUTPUT') return output;
      return table.get(canonical(name));
    };

    for (const pass of passes) {
      if (!firesIn(pass, stage)) continue;
      if (pass.when !== null) {
        const run = evaluate(pass.when, lookup);
        if (run === null || run === 0) continue;
      }

      const inputs: { name: string; tex: TexRef }[] = [];
      let bound = true;
      for (const name of pass.binds) {
        const tex = name === 'HOOKED' ? hooked : table.get(canonical(name));
        if (!tex) {
          bound = false;
          break;
        }
        inputs.push({ name, tex });
      }
      if (!bound) continue;

      const w = pass.width === null ? hooked.width : evaluate(pass.width, lookup);
      const h = pass.height === null ? hooked.height : evaluate(pass.height, lookup);
      if (w === null || h === null) continue;
      const width = Math.round(w);
      const height = Math.round(h);
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      if (width <= 0 || height <= 0 || width > maxTextureSize || height > maxTextureSize) continue;

      const components = pass.components === null ? hooked.components : pass.components === 3 ? 4 : pass.components;
      const out: TexRef = { id: nextId++, width, height, components };
      const saveAs = pass.save === null || pass.save === 'HOOKED' ? stage : canonical(pass.save);
      planned.push({ pass, stage, hooked, inputs, out, saveAs });
      table.set(saveAs, out);
      // Saving to another name leaves the stage texture unchanged.
      if (saveAs === stage) hooked = out;
    }
    current = hooked;
  }

  return { passes: planned, final: current, output };
}
