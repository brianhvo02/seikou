// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { entriesFromIso, isIsoFile, IsoError } from './iso-input';

const ISO = 'fixtures/synthetic/disc1.iso';
const FOLDER = 'fixtures/synthetic/disc1';

/** Every file under `dir` as an upper-case path relative to it, with its bytes. */
function walk(dir: string, prefix = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) for (const [k, v] of walk(abs, rel)) out.set(k, v);
    else out.set(rel.toUpperCase(), readFileSync(abs));
  }
  return out;
}

describe('entriesFromIso', () => {
  it("gives disc1.iso's files under the image's name, byte for byte the folder's", async () => {
    const image = new File([readFileSync(ISO)], 'disc1.iso');
    const entries = await entriesFromIso(image);
    const folder = walk(FOLDER);
    expect(entries.every(([path]) => path.startsWith('disc1/BDMV/'))).toBe(true);
    const bdmv = [...folder.keys()].filter((k) => k.startsWith('BDMV/')).sort();
    expect(entries.map(([path]) => path.slice('disc1/'.length)).sort()).toEqual(bdmv);
    for (const [path, file] of entries) {
      expect(Buffer.from(await file.arrayBuffer()).equals(folder.get(path.slice('disc1/'.length))!)).toBe(true);
    }
  });

  it('refuses an image that is not UDF', async () => {
    await expect(entriesFromIso(new File([new Uint8Array(1 << 20)], 'blank.iso'))).rejects.toBeInstanceOf(IsoError);
  });

  it('refuses an image cut short', async () => {
    const bytes = readFileSync(ISO);
    await expect(entriesFromIso(new File([bytes.subarray(0, Math.floor(bytes.length * 0.6))], 'cut.iso'))).rejects.toBeInstanceOf(IsoError);
  });
});

it('tells an image by its name', () => {
  expect(isIsoFile({ name: 'Disc.ISO' })).toBe(true);
  expect(isIsoFile({ name: 'disc.iso.part' })).toBe(false);
});
