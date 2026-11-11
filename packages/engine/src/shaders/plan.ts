/*
 * Original code for Seikou, 2026. Plans one frame of mpv user shader
 * passes. Hook semantics follow libplacebo's hook_hook and lookup_tex in
 * src/shaders/custom_mpv.c: a table of named textures that each pass reads and `SAVE` replaces, sizes and `WHEN`
 * evaluated per pass against that table, and the stages NATIVE, MAIN and PREKERNEL run in that order. The rules this
 * player applies are in docs/superpowers/specs/2026-10-15-video-shaders-design.md.
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { ShaderPass } from './parse';
import { evalRpn, RpnError, type SizeLookup } from './rpn';

/** A size in pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A texture in a frame's plan: id 0 is the uploaded frame (RGBA8); every pass output gets a new id. */
export interface TexRef {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly components: 1 | 2 | 4;
}

/** The points a frame passes through: the frame as it arrives, the main picture (after any upscaling pass), and the step before the final scale. */
export type PlanStage = 'NATIVE' | 'MAIN' | 'PREKERNEL';

/** A pass that will run this frame, with the textures it reads and the one it writes. */
export interface PlannedPass {
  readonly pass: ShaderPass;
  /** The stage it runs in. */
  readonly stage: PlanStage;
  /** The texture `HOOKED` names for it: the stage's current image. */
  readonly hooked: TexRef;
  /** In BIND order; `name` is the BIND text (HOOKED stays HOOKED). */
  readonly inputs: readonly { readonly name: string; readonly tex: TexRef }[];
  readonly out: TexRef;
  /** The table name the output is stored under: its `//!SAVE`, or the stage name when it saves to the hooked texture. */
  readonly saveAs: string;
}

/** What one frame's shading comes to: the passes in run order and the texture the final scale reads. */
export interface FramePlan {
  readonly passes: readonly PlannedPass[];
  /** The image after the last pass (the uploaded frame when no pass runs). */
  readonly final: TexRef;
  /** The displayed video rectangle the final scale fills (`OUTPUT` in expressions). */
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

/**
 * Works out which passes run for a frame of `source` size drawn at `output` size, and the size of each pass's output.
 * Pure. A pass is skipped when its `WHEN` is zero or cannot be evaluated, when it binds a texture nothing has saved,
 * or when its output would be non-finite, empty or larger than `maxTextureSize` on either side; the rest still run.
 */
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
