// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource } from './doc-check';

/*
 * The public API rule: a package's `public-api.txt` lists its public names, it holds every name
 * `docs/integrating.md` uses and every name code outside the package imports from the root, and the
 * package's `index.ts` exports exactly that list. Everything else is reachable through `./*` only.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The eight documented packages. */
export const PACKAGES = ['bdmv', 'nas', 'pg', 'ass', 'engine', 'titles', 'fansubs', 'matroska'] as const;

/** Marks an import whose names are not known (`import * as ns`, a bare dynamic `import()`). */
export const UNKNOWN_NAMES = '*';

interface Node {
  type: string;
  [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/** The text of a module export name node (an identifier or a string literal). */
function nameOf(node: unknown): string {
  if (!isNode(node)) return '';
  return String(node.name ?? node.value ?? '');
}

/** Visits every node of a syntax tree. */
function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    const child = node[key];
    if (typeof child === 'object' && child !== null) walk(child, visit);
  }
}

/** The package a module specifier names when it is exactly `@seikou/<name>`, else undefined. */
function rootPackage(specifier: unknown): string | undefined {
  if (typeof specifier !== 'string') return undefined;
  const m = /^@seikou\/([^/]+)$/.exec(specifier);
  return m?.[1];
}

/** Adds the names one source text imports from package roots to `into`, keyed by package name. */
export function importedRootNames(file: string, source: string, into: Map<string, Set<string>> = new Map()): Map<string, Set<string>> {
  const add = (pkg: string, name: string): void => {
    let set = into.get(pkg);
    if (!set) into.set(pkg, (set = new Set()));
    set.add(name);
  };
  walk(parseSource(file, source).program, (n) => {
    if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') {
      const src = isNode(n.source) ? n.source.value : undefined;
      const pkg = rootPackage(src);
      if (!pkg) return;
      if (n.type === 'ExportAllDeclaration') {
        add(pkg, UNKNOWN_NAMES);
        return;
      }
      for (const spec of (n.specifiers as Node[] | undefined) ?? []) {
        if (spec.type === 'ImportSpecifier') add(pkg, nameOf(spec.imported));
        else if (spec.type === 'ExportSpecifier') add(pkg, nameOf(spec.local));
        else add(pkg, spec.type === 'ImportDefaultSpecifier' ? 'default' : UNKNOWN_NAMES);
      }
    } else if (n.type === 'ImportExpression') {
      const pkg = isNode(n.source) ? rootPackage(n.source.value) : undefined;
      if (pkg) add(pkg, UNKNOWN_NAMES);
    }
  });
  return into;
}

const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;
const TEST_FILE = /\.test\.tsx?$|\.d\.ts$|(^|\/)tests\//;
const CONSUMER_DIRS = ['src/', 'server/', 'rendezvous/', 'encoder/', 'tools/', 'scripts/', 'vite/'];

/** The tracked non-test source files outside `packages/` that may import a package. */
function consumerFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split('\n')
    .filter((f) => f && CONSUMER_DIRS.some((d) => f.startsWith(d)) && SOURCE_EXT.test(f) && !TEST_FILE.test(f) && existsSync(join(ROOT, f)));
}

let rootImportsCache: Map<string, Set<string>> | undefined;

/** Names imported from `@seikou/<name>` by tracked files outside `packages/` and outside tests, `import type` included. */
export function rootImports(): Map<string, Set<string>> {
  if (rootImportsCache) return rootImportsCache;
  const into = new Map<string, Set<string>>();
  for (const file of consumerFiles()) importedRootNames(file, readFileSync(join(ROOT, file), 'utf8'), into);
  rootImportsCache = into;
  return into;
}

/** The TypeScript code blocks (```ts) of a Markdown text. */
function tsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
}

/** Names the integration guide uses from package roots: its TypeScript blocks and the minimal player. */
export function guideNames(): Map<string, Set<string>> {
  const into = new Map<string, Set<string>>();
  const guide = readFileSync(join(ROOT, 'docs/integrating.md'), 'utf8');
  tsBlocks(guide).forEach((block, i) => {
    try {
      importedRootNames(`integrating-${i}.ts`, block, into);
    } catch {
      // a block that is not a complete program is not an import list
    }
  });
  const player = join(ROOT, 'docs/integrating/minimal-player.ts');
  importedRootNames(player, readFileSync(player, 'utf8'), into);
  return into;
}

function resolveModule(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${from}: cannot resolve ${specifier}`);
}

/** The names a module file exports, following `export *` and `export { … } from`. */
export function exportedNames(file: string, seen: Set<string> = new Set()): Set<string> {
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);
  for (const st of parseSource(file, readFileSync(file, 'utf8')).statements as unknown as Node[]) {
    if (st.type === 'ExportAllDeclaration') {
      const target = resolveModule(file, String((st.source as Node).value));
      if (st.exported) names.add(nameOf(st.exported));
      else for (const n of exportedNames(target, seen)) names.add(n);
    } else if (st.type === 'ExportNamedDeclaration') {
      const decl = st.declaration;
      if (isNode(decl)) {
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations as Node[]) walk(d.id, (n) => n.type === 'Identifier' && names.add(String(n.name)));
        } else if (isNode(decl.id)) names.add(nameOf(decl.id));
      }
      for (const spec of (st.specifiers as Node[] | undefined) ?? []) names.add(nameOf(spec.exported));
    } else if (st.type === 'ExportDefaultDeclaration') names.add('default');
  }
  return names;
}

/** The names `packages/<pkg>/src/index.ts` exports. */
export function barrelNames(pkg: string): Set<string> {
  return exportedNames(join(ROOT, 'packages', pkg, 'src/index.ts'));
}

/** The names a package's `public-api.txt` approves (one per line, `#` comments), or null when the package has no list yet. */
export function approvedApi(pkg: string): Set<string> | null {
  const file = join(ROOT, 'packages', pkg, 'public-api.txt');
  if (!existsSync(file)) return null;
  const names = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
  return new Set(names);
}

/** The floor of a package's public API: the guide's names and the repository's root imports. */
export function requiredApi(pkg: string): Set<string> {
  return new Set([...(rootImports().get(pkg) ?? []), ...(guideNames().get(pkg) ?? [])]);
}
