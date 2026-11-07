import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BD-J is an optional provider of the engine (PlayerDeps.bdj): no engine file outside src/engine/bdj imports it, at
 * run time or for types, so the engine can be packaged without it. The one exception is the app's worker entry,
 * worker.ts, which assembles the provider from bdj/provider.ts.
 */
const ENGINE = dirname(fileURLToPath(import.meta.url));
const BDJ = join(ENGINE, 'bdj');
const ALLOWED: Readonly<Record<string, readonly string[]>> = { 'worker.ts': [join(BDJ, 'provider')] };

function engineFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return path === BDJ ? [] : engineFiles(path);
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [path] : [];
  });
}

/** Every relative module specifier a file names: static and type imports, re-exports, import(), new URL(). */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g, /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]/g];
  for (const re of patterns) for (const m of source.matchAll(re)) if (m[1]!.startsWith('.')) found.push(m[1]!);
  return found;
}

describe('the engine without BD-J', () => {
  it('has no static import of src/engine/bdj outside it (but the app worker entry, from bdj/provider)', () => {
    const offenders: string[] = [];
    for (const file of engineFiles(ENGINE)) {
      const rel = relative(ENGINE, file).split(sep).join('/');
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const target = resolve(dirname(file), spec).replace(/\.tsx?$/, '');
        if (target !== BDJ && !target.startsWith(BDJ + sep)) continue;
        if (ALLOWED[rel]?.includes(target)) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
