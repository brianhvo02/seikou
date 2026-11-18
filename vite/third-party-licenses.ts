// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One third-party package (or vendored work) with the licence text it ships. */
export interface LicenseEntry {
  readonly name: string;
  readonly version: string;
  /** The SPDX expression or name from the package's own metadata. */
  readonly license: string;
  /** The licence file's text, as the package ships it (one or more files joined). */
  readonly text: string;
}

/** A vendored work (not from node_modules): its name, licence and the repo files holding its notice. */
export interface VendoredWork {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Repo-relative files whose text is the notice, in order. */
  readonly files: readonly string[];
}

/** The standard MIT permission notice, for a package that ships only a source header naming the licence. */
export function mitText(copyright: string): string {
  return `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
}

/**
 * Packages that ship no licence file but name their licence in a source file's header: the file whose header is checked
 * (it must contain `mustContain`) and the copyright line for the standard text.
 */
export const HEADER_LICENSED: Readonly<Record<string, { file: string; mustContain: string; copyright: string }>> = {
  // werift ships no licence file; its package.json declares MIT and server/NOTICE records the copyright line.
  werift: { file: 'package.json', mustContain: '"license": "MIT"', copyright: 'Copyright (c) 2020 shinyoshiaki' },
  'qrcode-generator': { file: 'dist/qrcode.js', mustContain: 'Licensed under the MIT license', copyright: 'Copyright (c) 2009 Kazuhiko Arase' },
};

/** Thrown when a bundled package ships no licence file: the build must not publish a bundle without one. */
export class MissingLicenseError extends Error {
  readonly packages: readonly string[];

  constructor(packages: readonly string[]) {
    super(`No licence file found for bundled package(s): ${packages.join(', ')}`);
    this.name = 'MissingLicenseError';
    this.packages = packages;
  }
}

const LICENSE_FILE = /^(licen[sc]e|copying|notice|unlicense)([-._].*)?$/i;

/**
 * The root directory of the package a module id lies in (the last `node_modules/<name>` segment, scope included), or
 * null for a file outside any `node_modules`, a virtual module or a build-time helper.
 */
export function packageRootOf(id: string): string | null {
  const clean = id.replace(/^\0/, '').replace(/[?#].*$/, '');
  const marker = '/node_modules/';
  const at = clean.lastIndexOf(marker);
  if (at < 0 || !clean.startsWith('/')) return null;
  const rest = clean.slice(at + marker.length).split('/');
  const parts = rest[0]!.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  if (parts.length === 0 || parts.some((p) => p === '') || (rest[0]!.startsWith('@') && parts.length < 2)) return null;
  return clean.slice(0, at + marker.length) + parts.join('/');
}

/** The licence-like files directly in a package directory, sorted by name. */
function licenseFilesIn(root: string): string[] {
  return readdirSync(root)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(root, f)).isFile())
    .sort();
}

function licenseName(pkg: { license?: unknown; licenses?: unknown }): string {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && 'type' in pkg.license) return String((pkg.license as { type: unknown }).type);
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l: { type?: string }) => l.type ?? '').filter(Boolean).join(' OR ');
  return 'see licence text';
}

/**
 * Reads the name, version, licence and licence text of each package root, deduplicated and sorted by name. A package
 * with no licence file throws {@link MissingLicenseError} (after listing them all), unless `allowMissing` names it.
 */
export function readPackageLicenses(roots: Iterable<string>, allowMissing: ReadonlySet<string> = new Set()): LicenseEntry[] {
  const entries: LicenseEntry[] = [];
  const missing: string[] = [];
  for (const root of new Set(roots)) {
    const pkgFile = join(root, 'package.json');
    if (!existsSync(pkgFile)) {
      missing.push(`${root} (no package.json)`);
      continue;
    }
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: string; version?: string; license?: unknown; licenses?: unknown };
    const name = pkg.name ?? root.slice(root.lastIndexOf('/node_modules/') + '/node_modules/'.length);
    const files = licenseFilesIn(root);
    const header = HEADER_LICENSED[name];
    if (files.length === 0 && header) {
      const source = readFileSync(join(root, header.file), 'utf8');
      if (!source.includes(header.mustContain)) {
        missing.push(name);
        continue;
      }
      const top = header.file === 'package.json' ? '' : `${source.split('\n').slice(0, 14).join('\n')}\n\n`;
      entries.push({ name, version: pkg.version ?? '', license: licenseName(pkg), text: `${top}${mitText(header.copyright)}` });
      continue;
    }
    if (files.length === 0) {
      if (!allowMissing.has(name)) missing.push(name);
      continue;
    }
    const text = files.map((f) => readFileSync(join(root, f), 'utf8').trim()).join('\n\n');
    entries.push({ name, version: pkg.version ?? '', license: licenseName(pkg), text });
  }
  if (missing.length > 0) throw new MissingLicenseError(missing.sort());
  return entries.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

/** Reads a vendored work's notice files; a missing file is an error. */
export function readVendored(repoRoot: string, works: readonly VendoredWork[]): LicenseEntry[] {
  return works.map((w) => ({
    name: w.name,
    version: w.version,
    license: w.license,
    text: w.files
      .map((f) => {
        const path = resolve(repoRoot, f);
        if (!existsSync(path)) throw new Error(`Vendored licence file missing for ${w.name}: ${f}`);
        return readFileSync(path, 'utf8').trim();
      })
      .join('\n\n'),
  }));
}

/** The text of the licence file: a heading, then each section's entries with name, version, licence and full text. */
export function formatLicenses(title: string, sections: readonly { heading: string; entries: readonly LicenseEntry[] }[]): string {
  const rule = '='.repeat(78);
  const out = [title, '', 'Seikou is free software under the LGPL-3.0-or-later; its own source is at https://github.com/brianhvo02/seikou.', 'The works below are bundled in it, each under its own licence.', ''];
  for (const section of sections) {
    out.push(rule, section.heading, rule, '');
    for (const e of section.entries) {
      out.push(`${e.name}${e.version ? ` ${e.version}` : ''}`, `Licence: ${e.license}`, '', e.text, '', '-'.repeat(78), '');
    }
  }
  return out.join('\n');
}

/** The repo-relative directories whose sources the NAS server's bundle holds besides packages: ours, so they need no licence entry. */
export const SERVER_OWN_SOURCES: readonly string[] = ['server/src', 'packages', 'rendezvous/src'];

/**
 * The package roots of the modules an esbuild metafile lists as inputs. esbuild reports them relative to its working
 * directory, so `baseDir` must be that directory (the build passes the same one as `absWorkingDir`). An input that
 * is in a `node_modules` package is collected; one under `ownDirs` (absolute, or relative to `baseDir`) is our own
 * source; anything else is an error, never skipped.
 */
export function rootsFromMetafile(inputs: Record<string, unknown>, baseDir: string, ownDirs: readonly string[] = []): Set<string> {
  const roots = new Set<string>();
  const own = ownDirs.map((d) => resolve(baseDir, d) + '/');
  for (const key of Object.keys(inputs)) {
    const path = resolve(baseDir, key);
    const root = packageRootOf(path);
    if (root) roots.add(root);
    else if (!path.includes('/node_modules/') && own.some((d) => path.startsWith(d))) continue;
    else throw new Error(`Bundled input is neither our own source nor in a package: ${key}`);
  }
  return roots;
}
