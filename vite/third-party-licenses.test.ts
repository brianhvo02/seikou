// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatLicenses, MissingLicenseError, packageRootOf, readPackageLicenses, readVendored, rootsFromMetafile } from './third-party-licenses.ts';

function pkg(root: string, name: string, files: Record<string, string>, meta: object = {}): string {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', license: 'MIT', ...meta }));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

describe('packageRootOf', () => {
  it('finds the package, scope included, and the innermost node_modules', () => {
    expect(packageRootOf('/r/node_modules/react/index.js')).toBe('/r/node_modules/react');
    expect(packageRootOf('/r/node_modules/@scope/pkg/dist/a.js?v=1')).toBe('/r/node_modules/@scope/pkg');
    expect(packageRootOf('/r/node_modules/a/node_modules/b/x.js')).toBe('/r/node_modules/a/node_modules/b');
    expect(packageRootOf('/r/node_modules/@fontsource-variable/instrument-sans/index.css')).toBe('/r/node_modules/@fontsource-variable/instrument-sans');
  });
  it('is null for the project itself and virtual modules', () => {
    expect(packageRootOf('/r/src/a.ts')).toBeNull();
    expect(packageRootOf('\0virtual:help-pages')).toBeNull();
    expect(packageRootOf('/r/node_modules/@scope')).toBeNull();
  });
});

describe('readPackageLicenses', () => {
  const root = mkdtempSync(join(tmpdir(), 'licenses-'));
  it('reads name, version, licence and every licence file, sorted', () => {
    const b = pkg(root, 'b-lib', { LICENSE: 'B text\n', NOTICE: 'B notice' });
    const a = pkg(root, 'a-lib', { 'LICENSE.md': 'A text' }, { license: 'ISC' });
    const entries = readPackageLicenses([b, a, b]);
    expect(entries.map((e) => e.name)).toEqual(['a-lib', 'b-lib']);
    expect(entries[0]).toMatchObject({ version: '1.2.3', license: 'ISC', text: 'A text' });
    expect(entries[1]!.text).toBe('B text\n\nB notice');
  });
  it('fails, naming every package, when one ships no licence file', () => {
    const c = pkg(root, 'c-lib', { 'README.md': 'x' });
    const d = pkg(root, 'd-lib', {});
    expect(() => readPackageLicenses([c, d])).toThrow(MissingLicenseError);
    expect(() => readPackageLicenses([c, d])).toThrow(/c-lib, d-lib/);
  });
  it('accepts a header-licensed package only when its header says so', () => {
    const q = pkg(root, 'qrcode-generator', { 'README.md': '' });
    mkdirSync(join(q, 'dist'));
    writeFileSync(join(q, 'dist/qrcode.js'), '// Licensed under the MIT license\n');
    const [entry] = readPackageLicenses([q]);
    expect(entry!.text).toContain('Kazuhiko Arase');
    expect(entry!.text).toContain('Permission is hereby granted');
    writeFileSync(join(q, 'dist/qrcode.js'), '// nothing\n');
    expect(() => readPackageLicenses([q])).toThrow(MissingLicenseError);
  });
});

describe('vendored works, metafile roots and formatting', () => {
  it('reads vendored files and fails on a missing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'vendored-'));
    writeFileSync(join(root, 'N'), 'notice');
    expect(readVendored(root, [{ name: 'X', version: '1', license: 'MIT', files: ['N'] }])[0]!.text).toBe('notice');
    expect(() => readVendored(root, [{ name: 'Y', version: '', license: 'MIT', files: ['nope'] }])).toThrow(/nope/);
  });
  it('maps esbuild inputs to package roots', () => {
    const roots = rootsFromMetafile({ 'node_modules/werift/lib/a.js': {}, 'src/main.ts': {}, '../packages/nas/src/a.ts': {} }, '/repo/server', ['/repo/server/src', 'src', '/repo/packages']);
    expect([...roots]).toEqual(['/repo/server/node_modules/werift']);
  });
  it('lists name, version, licence and text', () => {
    const text = formatLicenses('T', [{ heading: 'H', entries: [{ name: 'react', version: '19', license: 'MIT', text: 'MIT body' }] }]);
    expect(text).toContain('react 19\nLicence: MIT\n\nMIT body');
  });

  it('resolves metafile paths against the directory esbuild ran in, and refuses an input that names no package', () => {
    const roots = rootsFromMetafile({ '../node_modules/werift/lib/a.js': {}, '../node_modules/@scope/pkg/x.js': {}, 'src/main.ts': {} }, '/repo/server', ['/repo/server/src', 'src', '/repo/packages']);
    expect([...roots].sort()).toEqual(['/repo/node_modules/@scope/pkg', '/repo/node_modules/werift']);
    expect(() => rootsFromMetafile({ 'node_modules/@scope': {} }, '/repo')).toThrow(/neither our own/);
  });

  it('fails for a package root with no package.json', () => {
    expect(() => readPackageLicenses(['/nonexistent/node_modules/ghost'])).toThrow(MissingLicenseError);
  });

  it('refuses an input that is neither our own source nor in a package', () => {
    const own = ['/repo/server/src', '/repo/packages'];
    expect([...rootsFromMetafile({ 'server/src/a.ts': {}, 'packages/nas/src/b.ts': {}, 'node_modules/werift/x.js': {} }, '/repo', own)]).toEqual(['/repo/node_modules/werift']);
    expect(() => rootsFromMetafile({ 'vendor/lib/a.js': {} }, '/repo', own)).toThrow(/vendor\/lib\/a\.js/);
  });

  it('builds the same licence list whatever directory the build runs from', () => {
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const out = join(repo, 'server/dist/third-party-licenses.txt');
    const run = (cwd: string): string => {
      execFileSync(process.execPath, [join(repo, 'server/build.mjs')], { cwd, stdio: 'pipe' });
      return readFileSync(out, 'utf8');
    };
    const here = run(repo);
    expect(here).toContain('werift');
    expect(run(tmpdir())).toBe(here);
  }, 60_000);
});
