// SPDX-License-Identifier: LGPL-3.0-or-later
// Generates fixtures/small.ivf: 10 frames of flat 10-bit grey at 64x64, encoded by SVT-AV1.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findSvt(): string {
  const override = process.env.ENCODING_TOOLS_SVT;
  const candidates =
    override !== undefined && override !== ''
      ? [override]
      : (process.env.PATH ?? '')
          .split(path.delimiter)
          .filter((d) => d !== '')
          .map((d) => path.join(d, 'SvtAv1EncApp'));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // keep looking
    }
  }
  throw new Error('SvtAv1EncApp not found (set ENCODING_TOOLS_SVT or add it to PATH)');
}

const W = 64;
const H = 64;
const FRAMES = 10;
const MID = 512;

function makeY4m(): Buffer {
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F24:1 Ip A1:1 C420p10\n`, 'latin1');
  const samples = W * H + 2 * (W / 2) * (H / 2);
  const parts: Buffer[] = [header];
  for (let i = 0; i < FRAMES; i++) {
    const body = Buffer.alloc(samples * 2);
    for (let s = 0; s < samples; s++) body.writeUInt16LE(MID, s * 2);
    parts.push(Buffer.from('FRAME\n', 'latin1'), body);
  }
  return Buffer.concat(parts);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'fixtures', 'small.ivf');
const dir = mkdtempSync(path.join(tmpdir(), 'encoding-tools-fixture-'));
try {
  const y4m = path.join(dir, 'grey.y4m');
  writeFileSync(y4m, makeY4m());
  execFileSync(
    findSvt(),
    ['-i', y4m, '-b', out, '--preset', '8', '--crf', '30', '--keyint', '4', '--progress', '0'],
    { stdio: 'inherit' },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
