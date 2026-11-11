// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceHash } from '../../tools/devsite/source-hash.mjs';
import { loadSite, missingExamples, needsExample, type DevExport } from './model.ts';

const root = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const fixture = join(root, 'model.json');

function modelWithHash(hash: string): string {
  const model = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>;
  model.seikouSourceHash = hash;
  const path = join(mkdtempSync(join(tmpdir(), 'devsite-model-')), 'model.json');
  writeFileSync(path, JSON.stringify(model));
  return path;
}

const site = loadSite(modelWithHash(sourceHash(root)), root);
const demo = site[0]!;
const find = (name: string): DevExport => demo.exports.find((e) => e.name === name)!;

describe('loadSite', () => {
  it('reads the package and its README', () => {
    expect(demo.name).toBe('demo');
    expect(demo.readme).toContain('Demo package');
    expect(demo.exports.map((e) => e.name)).toEqual(['DemoPlayer', 'Mode', 'parse', 'ParseOptions', 'pick']);
  });

  it('writes a function signature, its params, return and throws', () => {
    const parse = find('parse');
    expect(parse.kind).toBe('function');
    expect(parse.signatures[0]!.text).toBe('function parse(text: string, options?: ParseOptions): number');
    expect(parse.signatures[0]!.params[0]).toMatchObject({ name: 'text', type: 'string', doc: 'What to parse.', optional: false });
    expect(parse.signatures[0]!.params[1]).toMatchObject({ optional: true, typeRefs: [{ name: 'ParseOptions', pkg: 'demo' }] });
    expect(parse.signatures[0]!.returns).toEqual({ type: 'number', doc: 'The length.' });
    expect(parse.signatures[0]!.throws).toEqual(['RangeError when the text is empty.']);
    expect(parse.summary).toBe('Parses text.');
    expect(parse.body).toBe('The second paragraph says more.');
    expect(parse.source).toEqual({ file: 'packages/demo/src/parse.ts', line: 6 });
  });

  it('resolves @example to the whole file, relative to the source', () => {
    const ex = find('parse').example!;
    expect(ex.file).toBe('packages/demo/examples/parse.ts');
    expect(ex.region).toBeUndefined();
    expect(ex.code).toContain("console.log(parse('abc', options));");
  });

  it('resolves @example#region to the block, dedented and without the markers', () => {
    const ex = find('DemoPlayer').members.find((m) => m.name === 'open')!.example!;
    expect(ex.region).toBe('open');
    expect(ex.code).toBe("async function main(): Promise<void> {\n  await player.open('/disc');\n}\n");
    expect(find('DemoPlayer').example!.code).toBe("const player = new DemoPlayer('main');\n");
  });

  it('lists public class members and leaves out private ones', () => {
    const members = find('DemoPlayer').members;
    expect(members.map((m) => `${m.kind}:${m.name}`)).toEqual(['constructor:constructor', 'method:open', 'accessor:last']);
    expect(members[0]!.signatures[0]!.text).toBe('new DemoPlayer(name: string)');
    expect(members[1]!.signatures[0]!.text).toBe('open(path: string): Promise<void>');
    expect(members[2]!.signatures[0]!.text).toBe('get last(): string');
  });

  it('renders interfaces and type aliases', () => {
    expect(find('ParseOptions').members[0]!.signatures[0]!.text).toBe('strict?: boolean');
    expect(find('ParseOptions').members[1]!.signatures[0]!.text).toBe('onData: ((data: string) => void) | null');
    expect(find('Mode').signatures[0]!.text).toBe("type Mode = 'fast' | 'exact' | ParseOptions[]");
  });

  it('lists as usedBy the exports whose examples mention a type', () => {
    expect(find('ParseOptions').usedBy).toEqual(['parse', 'pick']);
    expect(find('Mode').usedBy).toEqual([]);
  });

  it('gives a class constructor the class example when it has none', () => {
    const ctor = find('DemoPlayer').members.find((m) => m.kind === 'constructor')!;
    expect(ctor.example).toEqual(find('DemoPlayer').example);
    for (const e of site[0]!.exports) for (const n of needsExample(e)) expect(n === e.name ? e.example : e.members.find((m) => m.name === n)!.example).toBeDefined();
  });

  it('leaves type parameters and undocumented names out of typeRefs', () => {
    const sig = find('pick').signatures[0]!;
    expect(sig.text).toBe('function pick<T>(items: T[], via: Via): T');
    expect(sig.typeRefs).toEqual([]);
    expect(sig.params.flatMap((p) => p.typeRefs)).toEqual([]);
  });

  it('refuses an item with two @example tags', () => {
    const model = JSON.parse(readFileSync(fixture, 'utf8')) as { children: { children: { name: string; signatures: { comment: { blockTags: unknown[] } }[] }[] }[]; seikouSourceHash: string };
    const parse = model.children[0]!.children.find((c) => c.name === 'parse')!;
    parse.signatures[0]!.comment.blockTags.push({ tag: '@example', content: [{ kind: 'text', text: '../examples/player.ts' }] });
    model.seikouSourceHash = sourceHash(root);
    const path = join(mkdtempSync(join(tmpdir(), 'devsite-model-')), 'model.json');
    writeFileSync(path, JSON.stringify(model));
    expect(() => loadSite(path, root)).toThrow('demo/parse has 2 @example tags');
  });

  it('reads a class’s heritage, and leaves out what it inherits from outside the packages', () => {
    type Node = { name: string; kind: number; children?: Node[]; [k: string]: unknown };
    const model = JSON.parse(readFileSync(fixture, 'utf8')) as { children: Node[]; seikouSourceHash: string };
    const player = model.children[0]!.children!.find((c) => c.name === 'DemoPlayer')!;
    player.extendedTypes = [{ type: 'reference', target: { packageName: 'typescript', qualifiedName: 'Error' }, name: 'Error', package: 'typescript' }];
    player.implementedTypes = [{ type: 'reference', target: 1, name: 'ParseOptions', package: '@seikou/demo' }];
    const open = player.children!.find((c) => c.name === 'open')!;
    player.children!.push({ ...open, id: 901, name: 'stack', inheritedFrom: { type: 'reference', target: -1, name: 'Error.stack' } });
    player.children!.push({ ...open, id: 902, name: 'fromBase', inheritedFrom: { type: 'reference', target: 13, name: 'Base.fromBase' } });
    // A documented member that itself comes from outside: what inherits it is left out too.
    const options = model.children[0]!.children!.find((c) => c.name === 'ParseOptions')!;
    options.children!.find((c) => c.name === 'strict')!.inheritedFrom = { type: 'reference', target: -1, name: 'Error.strict' };
    player.children!.push({ ...open, id: 903, name: 'viaStrict', inheritedFrom: { type: 'reference', target: 7, name: 'ParseOptions.strict' } });
    model.seikouSourceHash = sourceHash(root);
    const path = join(mkdtempSync(join(tmpdir(), 'devsite-model-')), 'model.json');
    writeFileSync(path, JSON.stringify(model));
    const cls = loadSite(path, root)[0]!.exports.find((e) => e.name === 'DemoPlayer')!;
    expect(cls.heritage).toEqual({
      extends: [{ text: 'Error', typeRefs: [{ name: 'Error', pkg: null }] }],
      implements: [{ text: 'ParseOptions', typeRefs: [{ name: 'ParseOptions', pkg: 'demo' }] }],
    });
    expect(cls.members.map((m) => m.name)).toEqual(['constructor', 'open', 'last', 'fromBase']);
    expect(find('DemoPlayer').heritage).toBeUndefined();
  });

  it('throws on a model built from other sources', () => {
    expect(() => loadSite(modelWithHash('0'.repeat(64)), root)).toThrow('stale model: run npm run devsite:model');
  });
});

describe('needsExample', () => {
  it('lists a function, and a class constructor and public methods, but not an interface', () => {
    expect(needsExample(find('parse'))).toEqual(['parse']);
    expect(needsExample(find('DemoPlayer'))).toEqual(['constructor', 'open']);
    expect(needsExample(find('ParseOptions'))).toEqual([]);
    expect(needsExample(find('Mode'))).toEqual([]);
  });

  it('missingExamples counts the class example as the constructor', () => {
    expect(missingExamples(find('DemoPlayer'))).toEqual([]);
  });
});
