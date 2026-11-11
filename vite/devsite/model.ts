// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { sourceHash } from '../../tools/devsite/source-hash.mjs';

/** A code example read from a file under a package's `examples/`. */
export interface DevExample {
  readonly file: string;
  readonly code: string;
  readonly region?: string;
}
/** A type name an item's text mentions, with the package that exports it (null for the standard library or another project). */
export interface DevTypeRef {
  readonly name: string;
  readonly pkg: string | null;
}
export interface DevParam {
  readonly name: string;
  readonly type: string;
  readonly doc: string;
  readonly optional: boolean;
  readonly typeRefs: readonly DevTypeRef[];
}
export interface DevSignature {
  readonly text: string;
  readonly params: readonly DevParam[];
  readonly returns: { type: string; doc: string };
  readonly throws: readonly string[];
  readonly typeRefs: readonly DevTypeRef[];
}
export interface DevMember {
  readonly name: string;
  readonly kind: 'method' | 'property' | 'accessor' | 'constructor';
  readonly summary: string;
  readonly signatures: readonly DevSignature[];
  readonly example?: DevExample;
}
export interface DevExport {
  readonly pkg: string;
  readonly name: string;
  readonly kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum';
  readonly summary: string;
  readonly body: string;
  readonly signatures: readonly DevSignature[];
  readonly members: readonly DevMember[];
  readonly example?: DevExample;
  readonly usedBy: readonly string[];
  readonly source: { file: string; line: number };
}
export interface DevPackage {
  readonly name: string;
  readonly readme: string;
  readonly exports: readonly DevExport[];
}

// --- TypeDoc JSON (the parts read) ---

interface Part {
  kind: string;
  text: string;
  tag?: string;
}
interface Tag {
  tag: string;
  content: Part[];
}
interface Comment {
  summary?: Part[];
  blockTags?: Tag[];
}
interface TType {
  type: string;
  [k: string]: unknown;
}
interface Refl {
  name: string;
  kind: number;
  flags?: Record<string, boolean>;
  comment?: Comment;
  sources?: { fileName: string; line: number }[];
  children?: Refl[];
  signatures?: Refl[];
  getSignature?: Refl;
  setSignature?: Refl;
  parameters?: Refl[];
  typeParameters?: Refl[];
  type?: TType;
  defaultValue?: string;
}

const K = { Enum: 8, Variable: 32, Function: 64, Class: 128, Interface: 256, Constructor: 512, Property: 1024, Method: 2048, Accessor: 262144, TypeAlias: 2097152 } as const;

// --- comments ---

function parts(ps: readonly Part[] | undefined): string {
  return (ps ?? []).map((p) => (p.kind === 'inline-tag' ? `\`${p.text}\`` : p.text)).join('');
}

function tagsOf(c: Comment | undefined, name: string): Tag[] {
  return (c?.blockTags ?? []).filter((t) => t.tag === name);
}

/** The first paragraph and the rest of a comment's summary. */
function splitSummary(c: Comment | undefined): { summary: string; body: string } {
  const text = parts(c?.summary).trim();
  const m = /\n\s*\n/.exec(text);
  if (!m) return { summary: text, body: '' };
  return { summary: text.slice(0, m.index).trim(), body: text.slice(m.index + m[0].length).trim() };
}

// --- types ---

type Collect = (name: string, pkg: string | null) => void;

function typeText(t: TType | undefined, refs: Collect, ctx: 'top' | 'arr' | 'union' | 'inter' | 'op' = 'top'): string {
  if (!t) return 'unknown';
  const r = (x: unknown, c: typeof ctx = 'top'): string => typeText(x as TType, refs, c);
  const list = (x: unknown): TType[] => (x as TType[] | undefined) ?? [];
  const paren = (s: string, needs: boolean): string => (needs ? `(${s})` : s);
  switch (t.type) {
    case 'intrinsic':
      return String(t.name);
    case 'literal': {
      const v = t.value;
      if (v === null) return 'null';
      if (typeof v === 'string') return JSON.stringify(v).replace(/^"|"$/g, "'").replace(/\\"/g, '"');
      if (typeof v === 'object') {
        const b = v as { value: string; negative?: boolean };
        return `${b.negative ? '-' : ''}${b.value}n`;
      }
      return String(v);
    }
    case 'reference': {
      const name = String(t.name);
      const pkg = typeof t.package === 'string' && t.package.startsWith('@seikou/') ? t.package.slice('@seikou/'.length) : null;
      // Type parameters and names the model does not document (an unresolved target) have no page to link.
      const documented = !t.refersToTypeParameter && !(pkg !== null && typeof t.target === 'object' && t.target !== null);
      if (documented) refs(name.includes('.') ? name.split('.')[0]! : name, pkg);
      const args = list(t.typeArguments);
      return args.length ? `${name}<${args.map((a) => r(a)).join(', ')}>` : name;
    }
    case 'array':
      return `${r(t.elementType, 'arr')}[]`;
    case 'union':
      return paren(list(t.types).map((x) => r(x, 'union')).join(' | '), ctx === 'arr' || ctx === 'inter' || ctx === 'op');
    case 'intersection':
      return paren(list(t.types).map((x) => r(x, 'inter')).join(' & '), ctx === 'arr' || ctx === 'op');
    case 'tuple':
      return `[${list(t.elements).map((x) => r(x)).join(', ')}]`;
    case 'namedTupleMember':
      return `${String(t.name)}${t.isOptional ? '?' : ''}: ${r(t.element)}`;
    case 'optional':
      return `${r(t.elementType, 'arr')}?`;
    case 'rest':
      return `...${r(t.elementType, 'arr')}`;
    case 'typeOperator':
      return `${String(t.operator)} ${r(t.target, 'op')}`;
    case 'query':
      return `typeof ${r(t.queryType)}`;
    case 'indexedAccess':
      return `${r(t.objectType, 'arr')}[${r(t.indexType)}]`;
    case 'conditional':
      return paren(`${r(t.checkType, 'op')} extends ${r(t.extendsType, 'op')} ? ${r(t.trueType)} : ${r(t.falseType)}`, ctx !== 'top');
    case 'inferred':
      return `infer ${String(t.name)}`;
    case 'predicate': {
      const target = t.targetType ? ` is ${r(t.targetType)}` : '';
      return `${t.asserts ? 'asserts ' : ''}${String(t.name)}${target}`;
    }
    case 'templateLiteral': {
      const tail = (t.tail as [TType, string][] | undefined) ?? [];
      return '`' + String(t.head ?? '') + tail.map(([x, s]) => `\${${r(x)}}${s}`).join('') + '`';
    }
    case 'mapped': {
      const mod = (m: unknown, ch: string): string => (m === '+' ? `+${ch}` : m === '-' ? `-${ch}` : '');
      const ro = t.readonlyModifier ? `${mod(t.readonlyModifier, 'readonly') || 'readonly'} ` : '';
      const opt = t.optionalModifier ? mod(t.optionalModifier, '?') || '?' : '';
      const nm = t.nameType ? ` as ${r(t.nameType)}` : '';
      return `{ ${ro}[${String(t.parameter)} in ${r(t.parameterType)}${nm}]${opt}: ${r(t.templateType)} }`;
    }
    case 'reflection': {
      const d = t.declaration as Refl;
      const text = declText(d, refs);
      const fn = (d.signatures?.length ?? 0) > 0 && !d.children?.length;
      if (!fn || ctx === 'top') return text;
      // One signature is a bare arrow type; several were already joined with `|` and parenthesised one by one.
      return d.signatures!.length === 1 || ctx !== 'union' ? `(${text})` : text;
    }
    case 'unknown':
      return String(t.name);
    default:
      return 'unknown';
  }
}

function paramsText(ps: readonly Refl[] | undefined, refs: Collect): string {
  return (ps ?? []).map((p) => paramText(p, refs)).join(', ');
}

function paramText(p: Refl, refs: Collect): string {
  const rest = p.flags?.isRest ? '...' : '';
  const opt = p.flags?.isOptional || p.defaultValue !== undefined ? '?' : '';
  return `${rest}${p.name}${opt}: ${typeText(p.type, refs)}`;
}

function tparamsText(tp: readonly Refl[] | undefined, refs: Collect): string {
  if (!tp?.length) return '';
  const one = (p: Refl & { default?: TType }): string => {
    const c = p.type ? ` extends ${typeText(p.type, refs)}` : '';
    const d = p.default ? ` = ${typeText(p.default, refs)}` : '';
    return `${p.name}${c}${d}`;
  };
  return `<${tp.map(one).join(', ')}>`;
}

/** An object literal or function type from a reflection's declaration. */
function declText(d: Refl, refs: Collect): string {
  if (d.signatures?.length && !d.children?.length) {
    return d.signatures.map((s) => `${d.signatures!.length > 1 ? '(' : ''}${tparamsText(s.typeParameters, refs)}(${paramsText(s.parameters, refs)}) => ${typeText(s.type, refs)}${d.signatures!.length > 1 ? ')' : ''}`).join(' | ');
  }
  const members: string[] = [];
  for (const c of d.children ?? []) {
    const ro = c.flags?.isReadonly ? 'readonly ' : '';
    const opt = c.flags?.isOptional ? '?' : '';
    if (c.signatures?.length && !c.type) {
      const s = c.signatures[0]!;
      members.push(`${c.name}${opt}${tparamsText(s.typeParameters, refs)}(${paramsText(s.parameters, refs)}): ${typeText(s.type, refs)}`);
    } else {
      members.push(`${ro}${c.name}${opt}: ${typeText(c.type, refs)}`);
    }
  }
  const idx = ((d as unknown as { indexSignatures?: Refl[] }).indexSignatures ?? []).map((s) => `[${paramsText(s.parameters, refs)}]: ${typeText(s.type, refs)}`);
  const all = [...idx, ...members];
  return all.length ? `{ ${all.join('; ')} }` : '{}';
}

// --- signatures ---

function makeSignature(name: string, s: Refl, mode: 'function' | 'method' | 'constructor' | 'get' | 'set', className: string | undefined): DevSignature {
  const found = new Map<string, DevTypeRef>();
  const refs: Collect = (n, pkg) => {
    if (!found.has(`${pkg}:${n}`)) found.set(`${pkg}:${n}`, { name: n, pkg });
  };
  const tp = tparamsText(s.typeParameters, refs);
  const args = paramsText(s.parameters, refs);
  const ret = typeText(s.type, refs);
  let text: string;
  switch (mode) {
    case 'function':
      text = `function ${name}${tp}(${args}): ${ret}`;
      break;
    case 'constructor':
      text = `new ${className ?? name}${tp}(${args})`;
      break;
    case 'get':
      text = `get ${name}(): ${ret}`;
      break;
    case 'set':
      text = `set ${name}(${args})`;
      break;
    default:
      text = `${name}${tp}(${args}): ${ret}`;
  }
  const params: DevParam[] = (s.parameters ?? []).map((p) => {
    const pr = new Map<string, DevTypeRef>();
    const type = typeText(p.type, (n, pkg) => {
      pr.set(`${pkg}:${n}`, { name: n, pkg });
    });
    return { name: p.name, type, doc: parts(p.comment?.summary).trim(), optional: !!(p.flags?.isOptional || p.defaultValue !== undefined), typeRefs: [...pr.values()] };
  });
  const returns = tagsOf(s.comment, '@returns')[0];
  return {
    text,
    params,
    returns: { type: mode === 'constructor' ? (className ?? name) : ret, doc: returns ? parts(returns.content).trim() : '' },
    throws: tagsOf(s.comment, '@throws').map((t) => parts(t.content).trim()),
    typeRefs: [...found.values()],
  };
}

function propertySignature(name: string, d: Refl): DevSignature {
  const found = new Map<string, DevTypeRef>();
  const type = typeText(d.type, (n, pkg) => {
    found.set(`${pkg}:${n}`, { name: n, pkg });
  });
  const ro = d.flags?.isReadonly ? 'readonly ' : '';
  const opt = d.flags?.isOptional ? '?' : '';
  return { text: `${ro}${name}${opt}: ${type}`, params: [], returns: { type, doc: '' }, throws: [], typeRefs: [...found.values()] };
}

// --- examples ---

function exampleRef(c: Comment | undefined, item: string): string | undefined {
  const tags = tagsOf(c, '@example');
  if (tags.length > 1) throw new Error(`${item} has ${tags.length} @example tags; an item takes one`);
  const tag = tags[0];
  if (!tag) return undefined;
  const raw = parts(tag.content)
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  return raw || undefined;
}

function readExample(ref: string, sourceFile: string, repoRoot: string): DevExample {
  const hash = ref.indexOf('#');
  const path = hash < 0 ? ref : ref.slice(0, hash);
  const region = hash < 0 ? undefined : ref.slice(hash + 1);
  const file = posix.normalize(posix.join(posix.dirname(sourceFile), path));
  const full = join(repoRoot, file);
  if (!existsSync(full)) throw new Error(`example not found: ${ref} (from ${sourceFile}, looked for ${file})`);
  const text = readFileSync(full, 'utf8');
  if (region === undefined) return { file, code: text.replace(/\n+$/, '\n') };
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*//\\s*#region\\s+${region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l));
  if (start < 0) throw new Error(`example region not found: #${region} in ${file}`);
  const out: string[] = [];
  let depth = 1;
  for (const l of lines.slice(start + 1)) {
    if (/^\s*\/\/\s*#region\b/.test(l)) depth++;
    else if (/^\s*\/\/\s*#endregion\b/.test(l) && --depth === 0) {
      return { file, region, code: dedent(out).join('\n') + '\n' };
    }
    out.push(l);
  }
  throw new Error(`example region #${region} in ${file} has no #endregion`);
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n));
}

// --- reflections to the site's shapes ---

function sourceOf(r: Refl, fallback?: Refl): { file: string; line: number } {
  const s = r.sources?.[0] ?? fallback?.sources?.[0];
  return { file: s?.fileName ?? '', line: s?.line ?? 0 };
}

function kindOf(k: number): DevExport['kind'] | null {
  switch (k) {
    case K.Function:
      return 'function';
    case K.Class:
      return 'class';
    case K.Interface:
      return 'interface';
    case K.TypeAlias:
      return 'type';
    case K.Variable:
      return 'variable';
    case K.Enum:
      return 'enum';
    default:
      return null;
  }
}

function makeMember(c: Refl, className: string, repoRoot: string): DevMember | null {
  if (c.flags?.isPrivate || c.flags?.isProtected) return null;
  let kind: DevMember['kind'];
  let signatures: DevSignature[];
  let comment: Comment | undefined = c.comment;
  let src = c;
  if (c.kind === K.Constructor) {
    kind = 'constructor';
    signatures = (c.signatures ?? []).map((s) => makeSignature(c.name, s, 'constructor', className));
    comment = c.signatures?.[0]?.comment ?? comment;
    src = c.signatures?.[0] ?? c;
  } else if (c.kind === K.Method) {
    kind = 'method';
    signatures = (c.signatures ?? []).map((s) => makeSignature(c.name, s, 'method', className));
    comment = c.signatures?.[0]?.comment ?? comment;
    src = c.signatures?.[0] ?? c;
  } else if (c.kind === K.Accessor) {
    kind = 'accessor';
    signatures = [c.getSignature && makeSignature(c.name, c.getSignature, 'get', className), c.setSignature && makeSignature(c.name, c.setSignature, 'set', className)].filter((x): x is DevSignature => !!x);
    comment = c.getSignature?.comment ?? c.setSignature?.comment ?? comment;
  } else if (c.kind === K.Property) {
    kind = 'property';
    signatures = c.signatures?.length ? c.signatures.map((s) => makeSignature(c.name, s, 'method', className)) : [propertySignature(c.name, c)];
  } else {
    return null;
  }
  const ref = exampleRef(comment, `${className}.${c.name}`);
  const file = sourceOf(src, c).file;
  const member: DevMember = { name: c.name, kind, summary: splitSummary(comment).summary, signatures };
  return ref ? { ...member, example: readExample(ref, file, repoRoot) } : member;
}

function makeExport(pkg: string, r: Refl, repoRoot: string): DevExport | null {
  const kind = kindOf(r.kind);
  if (!kind) return null;
  const first = r.signatures?.[0];
  const comment = kind === 'function' ? (first?.comment ?? r.comment) : r.comment;
  const { summary, body } = splitSummary(comment);
  const source = sourceOf(r, first);
  let signatures: DevSignature[] = [];
  let members: DevMember[] = [];
  if (kind === 'function') {
    signatures = (r.signatures ?? []).map((s) => makeSignature(r.name, s, 'function', undefined));
  } else if (kind === 'class' || kind === 'interface' || kind === 'enum') {
    members = (r.children ?? []).map((c) => makeMember(c, r.name, repoRoot)).filter((m): m is DevMember => !!m);
  } else if (kind === 'type' || kind === 'variable') {
    const found = new Map<string, DevTypeRef>();
    const t = typeText(r.type, (n, p) => {
      found.set(`${p}:${n}`, { name: n, pkg: p });
    });
    const text = kind === 'type' ? `type ${r.name}${tparamsText(r.typeParameters, () => {})} = ${t}` : `const ${r.name}: ${t}`;
    signatures = [{ text, params: [], returns: { type: t, doc: '' }, throws: [], typeRefs: [...found.values()] }];
  }
  const ref = exampleRef(comment, `${pkg}/${r.name}`);
  const example = ref ? readExample(ref, source.file, repoRoot) : undefined;
  // A class's example is its constructor's unless the constructor has its own.
  if (kind === 'class' && example) members = members.map((m) => (m.kind === 'constructor' && !m.example ? { ...m, example } : m));
  const base = { pkg, name: r.name, kind, summary, body, signatures, members, usedBy: [] as string[], source };
  return example ? { ...base, example } : base;
}

/** Fills `usedBy`: the exports whose examples (or whose members' examples) mention each name. */
function linkUsedBy(pkgs: DevPackage[]): DevPackage[] {
  const mentions = new Map<DevExport, string>();
  for (const p of pkgs) {
    for (const e of p.exports) {
      const code = [e.example?.code, ...e.members.map((m) => m.example?.code)].filter(Boolean).join('\n');
      mentions.set(e, code);
    }
  }
  return pkgs.map((p) => ({
    ...p,
    exports: p.exports.map((e) => {
      if (e.kind === 'function') return e;
      const re = new RegExp(`(?<![\\w$])${e.name.replace(/\$/g, '\\$')}(?![\\w$])`);
      const usedBy = [...mentions].filter(([o, code]) => o !== e && code && re.test(code)).map(([o]) => o.name);
      return { ...e, usedBy: [...new Set(usedBy)].sort() };
    }),
  }));
}

/**
 * Reads the TypeDoc model at `modelPath` and the package READMEs and examples under `repoRoot`.
 *
 * @throws Error `stale model: run npm run devsite:model` when the model was built from other sources.
 */
export function loadSite(modelPath: string, repoRoot: string): DevPackage[] {
  const model = JSON.parse(readFileSync(modelPath, 'utf8')) as { seikouSourceHash?: string; children?: (Refl & { children?: Refl[] })[] };
  if (model.seikouSourceHash !== sourceHash(repoRoot)) throw new Error('stale model: run npm run devsite:model');
  const pkgs = (model.children ?? []).map((mod): DevPackage => {
    const readmePath = join(repoRoot, 'packages', mod.name, 'README.md');
    return {
      name: mod.name,
      readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '',
      exports: (mod.children ?? []).map((c) => makeExport(mod.name, c, repoRoot)).filter((e): e is DevExport => !!e).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
  return linkUsedBy(pkgs.sort((a, b) => a.name.localeCompare(b.name)));
}

/** The names that need an example: a function, or a class's constructor and public methods. Interfaces, types and variables need none. */
export function needsExample(e: DevExport): readonly string[] {
  if (e.kind === 'function') return [e.name];
  if (e.kind !== 'class') return [];
  return e.members.filter((m) => m.kind === 'constructor' || m.kind === 'method').map((m) => m.name);
}

/** The names `needsExample` lists that have none (a class's example covers its constructor). */
export function missingExamples(e: DevExport): readonly string[] {
  if (e.kind === 'function') return e.example ? [] : [e.name];
  return needsExample(e).filter((n) => {
    const m = e.members.find((x) => x.name === n);
    return !(m?.example ?? (m?.kind === 'constructor' ? e.example : undefined));
  });
}


/** Every `.ts` file under `packages/<pkg>/examples/`, as a path from `repoRoot`, sorted. */
export function exampleFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), posix.join(rel, entry.name));
      else if (entry.name.endsWith('.ts')) out.push(posix.join(rel, entry.name));
    }
  };
  const packages = join(repoRoot, 'packages');
  if (!existsSync(packages)) return out;
  for (const pkg of readdirSync(packages)) {
    const dir = join(packages, pkg, 'examples');
    if (existsSync(dir)) walk(dir, `packages/${pkg}/examples`);
  }
  return out.sort();
}

/** The module specifiers an example's source imports (static, dynamic and re-exports). */
function importsOf(source: string): string[] {
  const found: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
  for (let m = re.exec(source); m; m = re.exec(source)) found.push(m[2]!);
  return found;
}

/**
 * What is wrong with the examples: every name `needsExample` lists that has none, every file under
 * `packages/<pkg>/examples/` that no export or member names, and every example that imports anything but a
 * `@seikou/<package>` root (or a Node built-in). An empty list means the examples are complete.
 */
export function exampleProblems(site: readonly DevPackage[], repoRoot: string = process.cwd()): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const p of site) {
    for (const e of p.exports) {
      for (const n of missingExamples(e)) problems.push(`${p.name}: ${e.name === n ? n : `${e.name}.${n}`} has no example`);
      if (e.example) used.add(e.example.file);
      for (const m of e.members) if (m.example) used.add(m.example.file);
    }
  }
  const named = new Set(site.map((p) => p.name));
  for (const file of exampleFiles(repoRoot)) {
    if (named.has(file.split('/')[1]!) && !used.has(file)) problems.push(`${file} is named by no export`);
    for (const spec of importsOf(readFileSync(join(repoRoot, file), 'utf8'))) {
      if (spec.startsWith('node:') || /^@seikou\/[a-z]+$/.test(spec)) continue;
      problems.push(`${file} imports ${spec}; an example imports only a @seikou/<package> root`);
    }
  }
  return problems;
}
