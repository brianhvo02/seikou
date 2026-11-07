// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolPaths } from '../../src/pipeline/chain';

export type { ToolPaths };

function findOnPath(name: string, override: string | undefined): string | null {
  const candidates =
    override !== undefined && override !== ''
      ? [override]
      : (process.env.PATH ?? '')
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

export function toolPaths(): ToolPaths | null {
  const vspipe = findOnPath('vspipe', process.env.ENCODING_TOOLS_VSPIPE);
  const svt = findOnPath('SvtAv1EncApp', process.env.ENCODING_TOOLS_SVT);
  const opusenc = findOnPath('opusenc', process.env.ENCODING_TOOLS_OPUSENC);
  if (vspipe === null || svt === null || opusenc === null) return null;
  return { vspipe, svt, opusenc };
}

function bestSourceLoads(vspipe: string): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'encoding-tools-bs-'));
  try {
    const script = path.join(dir, 'probe.vpy');
    writeFileSync(
      script,
      'import vapoursynth as vs\nvs.core.bs\nvs.core.std.BlankClip().set_output()\n',
    );
    execFileSync(vspipe, ['--info', script, '-'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tools = toolPaths();

export const haveTools: boolean = tools !== null && bestSourceLoads(tools.vspipe);

export const haveFfprobe: boolean = findOnPath('ffprobe', process.env.ENCODING_TOOLS_FFPROBE) !== null;
