// SPDX-License-Identifier: LGPL-3.0-or-later
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { ToolPaths } from './pipeline/chain';

/** Thrown by `findTools` when one or more of the required programs cannot be found. */
export class ToolsError extends Error {
  /** Names of the missing programs (`vspipe`, `SvtAv1EncApp`, `opusenc`). */
  constructor(public missing: string[]) {
    super(
      `Missing required tools: ${missing.join(', ')}\n` +
        'brew install vapoursynth vapoursynth-bestsource svt-av1 opus-tools',
    );
    this.name = 'ToolsError';
  }
}

function findOnPath(name: string, override: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const candidates =
    override !== undefined && override !== ''
      ? [override]
      : (env.PATH ?? '')
          .split(path.delimiter)
          .filter((d) => d !== '')
          .map((d) => path.join(d, name));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // not here, keep looking
    }
  }
  return null;
}

/**
 * Locates `vspipe`, `SvtAv1EncApp` and `opusenc`. Each is looked up on PATH, unless its override
 * variable (`ENCODING_TOOLS_VSPIPE`, `ENCODING_TOOLS_SVT`, `ENCODING_TOOLS_OPUSENC`) names a path,
 * which is then the only candidate. Throws `ToolsError` listing every missing tool.
 */
export function findTools(env: NodeJS.ProcessEnv = process.env): ToolPaths {
  const vspipe = findOnPath('vspipe', env.ENCODING_TOOLS_VSPIPE, env);
  const svt = findOnPath('SvtAv1EncApp', env.ENCODING_TOOLS_SVT, env);
  const opusenc = findOnPath('opusenc', env.ENCODING_TOOLS_OPUSENC, env);
  const missing: string[] = [];
  if (vspipe === null) missing.push('vspipe');
  if (svt === null) missing.push('SvtAv1EncApp');
  if (opusenc === null) missing.push('opusenc');
  if (vspipe === null || svt === null || opusenc === null) throw new ToolsError(missing);
  return { vspipe, svt, opusenc };
}
