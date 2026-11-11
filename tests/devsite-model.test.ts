// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceHash } from '../tools/devsite/source-hash.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelPath = resolve(root, '.cache/devsite/model.json');

interface Reflection {
  name: string;
  kind: number;
  children?: Reflection[];
  signatures?: { comment?: { summary?: unknown[] }; parameters?: unknown[] }[];
}
interface Model extends Reflection {
  seikouSourceHash: string;
}

const present = existsSync(modelPath);
// Locally the model is optional (npm run devsite:model builds it); CI builds it first, so there its
// absence is a failure, not a skip.
const maybe = present || process.env.CI ? describe : describe.skip;

maybe('devsite model (run npm run devsite:model to build it)', () => {
  it('exists', () => expect(present, `${modelPath} is missing; run npm run devsite:install && npm run devsite:model`).toBe(true));
  if (!present) return;
  const model = JSON.parse(readFileSync(modelPath, 'utf8')) as Model;
  const mod = (name: string): Reflection => {
    const found = model.children?.find((c) => c.name === name);
    if (!found) throw new Error(`no module ${name}`);
    return found;
  };

  it('has a module per package', () =>
    expect(model.children?.map((c) => c.name).sort()).toEqual(['ass', 'bdmv', 'engine', 'fansubs', 'matroska', 'nas', 'pg', 'titles']));

  it('documents bdmv parseMpls with a summary and a parameter', () => {
    const fn = mod('bdmv').children?.find((c) => c.name === 'parseMpls');
    expect(fn?.signatures?.[0]?.comment?.summary?.length).toBeGreaterThan(0);
    expect(fn?.signatures?.[0]?.parameters?.length).toBeGreaterThan(0);
  });

  it('has the engine PlayerController class with an open method', () => {
    const cls = mod('engine').children?.find((c) => c.name === 'PlayerController');
    expect(cls?.kind).toBe(128);
    expect(cls?.children?.some((c) => c.name === 'open')).toBe(true);
  });

  it('carries the hash of the current sources', () => expect(model.seikouSourceHash).toBe(sourceHash(root)));
});

describe('sourceHash', () => {
  it('changes when an untracked source or example file appears', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'devsite-hash-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      mkdirSync(resolve(dir, 'packages/x/src'), { recursive: true });
      writeFileSync(resolve(dir, 'packages/x/src/a.ts'), 'export {};\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      const before = sourceHash(dir);
      mkdirSync(resolve(dir, 'packages/x/examples'), { recursive: true });
      writeFileSync(resolve(dir, 'packages/x/examples/one.ts'), 'export {};\n');
      expect(sourceHash(dir)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
