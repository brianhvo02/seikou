// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceHash } from '../../tools/devsite/source-hash.mjs';
import { loadSite, type DevExport, type DevPackage, type DevSignature } from './model.ts';
import { render404, renderExport, renderGuide, renderIndex, renderPackage } from './render.ts';
import { searchIndex } from './search-index.ts';
import { THEME_BOOT_SCRIPT } from './theme-boot.ts';

const repo = process.cwd();

/** The site built from the committed TypeDoc fixture, through the real loader. */
function fixtureSite(): DevPackage[] {
  const root = join(repo, 'vite/devsite/__fixtures__/');
  const model = JSON.parse(readFileSync(join(root, 'model.json'), 'utf8')) as Record<string, unknown>;
  model.seikouSourceHash = sourceHash(root);
  const path = join(mkdtempSync(join(tmpdir(), 'devsite-render-')), 'model.json');
  writeFileSync(path, JSON.stringify(model));
  return loadSite(path, root);
}

const sig = (text: string, more: Partial<DevSignature> = {}): DevSignature => ({
  text,
  params: [],
  returns: { type: 'void', doc: '' },
  throws: [],
  typeRefs: [],
  ...more,
});

/** A made-up package whose comments and types hold what must be escaped. */
const tricky: DevPackage = {
  name: 'bdmv',
  readme:
    "# @seikou/bdmv\n\nThe made-up disc format. It reads `Thing` values.\n\n## Example\n\n```ts\nimport { readThing } from '@seikou/bdmv';\nreadThing(bytes);\n```\n",
  exports: [
    {
      pkg: 'bdmv',
      name: 'readThing',
      kind: 'function',
      summary: 'Reads a `Thing` from <script>alert(1)</script> bytes.',
      body: 'Takes Array<string> names too.',
      signatures: [
        sig('function readThing(bytes: Uint8Array<ArrayBufferLike>, names?: Array<string>): Thing', {
          params: [
            {
              name: 'bytes',
              type: 'Uint8Array<ArrayBufferLike>',
              doc: 'The whole file.',
              optional: false,
              typeRefs: [{ name: 'Uint8Array', pkg: null }],
            },
            {
              name: 'names',
              type: 'Array<string>',
              doc: 'Names to keep.',
              optional: true,
              typeRefs: [],
            },
          ],
          returns: { type: 'Thing', doc: 'The thing read.' },
          throws: ['ParseError for a bad signature.'],
          typeRefs: [
            { name: 'Thing', pkg: 'bdmv' },
            { name: 'Array', pkg: null },
          ],
        }),
      ],
      members: [],
      example: {
        file: 'packages/bdmv/examples/read-thing.ts',
        code: "// SPDX-License-Identifier: LGPL-3.0-or-later\nimport { readThing } from '@seikou/bdmv';\nconst thing = readThing(new Uint8Array(4)); // a <b>comment</b>\n",
      },
      usedBy: [],
      source: { file: 'packages/bdmv/src/thing.ts', line: 12 },
    },
    {
      pkg: 'bdmv',
      name: 'openLongly',
      kind: 'function',
      summary: 'Opens something with a [long](https://example.com/) list of parameters.',
      body: '',
      signatures: [
        sig('function openLongly(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBufferLike>>', {
          params: ['path', 'offset', 'length', 'signal'].map((n) => ({
            name: n,
            type: n === 'path' ? 'string' : n === 'signal' ? 'AbortSignal' : 'number',
            doc: '',
            optional: n === 'signal',
            typeRefs: [],
          })),
          returns: { type: 'Promise<Uint8Array<ArrayBufferLike>>', doc: '' },
          throws: ['If the bytes are short, nothing is read.', '`RangeTrouble` past the end.', 'MadeUpError when the disc is lost.', 'Thing when it is odd.'],
        }),
      ],
      members: [],
      usedBy: [],
      source: { file: 'packages/bdmv/src/thing.ts', line: 40 },
    },
    {
      pkg: 'bdmv',
      name: 'Thing',
      kind: 'interface',
      summary: 'A thing.',
      body: '',
      signatures: [],
      members: [
        {
          name: 'id',
          kind: 'property',
          summary: 'Its id.',
          signatures: [
            sig('readonly id: string', {
              returns: { type: 'string', doc: '' },
            }),
          ],
        },
        {
          name: 'next',
          kind: 'property',
          summary: 'The next one.',
          signatures: [
            sig('readonly next?: Thing', {
              returns: { type: 'Thing', doc: '' },
              typeRefs: [{ name: 'Thing', pkg: 'bdmv' }],
            }),
          ],
        },
      ],
      usedBy: ['readThing', 'Shared', 'Lonely'],
      source: { file: 'packages/bdmv/src/thing.ts', line: 3 },
    },
    {
      pkg: 'bdmv',
      name: 'ParseError',
      kind: 'class',
      summary: 'Bytes that do not parse.',
      body: '',
      signatures: [],
      heritage: {
        extends: [{ text: 'Error', typeRefs: [{ name: 'Error', pkg: null }] }],
        implements: [{ text: 'Thing', typeRefs: [{ name: 'Thing', pkg: 'bdmv' }] }],
      },
      example: { file: 'packages/bdmv/examples/parse-error-class.ts', code: "throw new ParseError('bad');\n" },
      members: [
        {
          name: 'constructor',
          kind: 'constructor',
          summary: '',
          signatures: [
            sig('new ParseError(message: string)', {
              params: [
                {
                  name: 'message',
                  type: 'string',
                  doc: 'What is wrong.',
                  optional: false,
                  typeRefs: [],
                },
              ],
              returns: { type: 'ParseError', doc: '' },
            }),
          ],
          example: { file: 'packages/bdmv/examples/parse-error-new.ts', code: "const e = new ParseError('x');\n" },
        },
        {
          name: 'open',
          kind: 'method',
          summary: 'Opens it.',
          signatures: [
            sig('open(thing: Thing): void', {
              params: [
                {
                  name: 'thing',
                  type: 'Thing',
                  doc: '',
                  optional: false,
                  typeRefs: [{ name: 'Thing', pkg: 'bdmv' }],
                },
              ],
              typeRefs: [{ name: 'Thing', pkg: 'bdmv' }],
            }),
          ],
          example: {
            file: 'packages/bdmv/examples/parse-error.ts',
            code: "import { ParseError } from '@seikou/bdmv';\nnew ParseError('x').open(t);\n",
          },
        },
      ],
      usedBy: [],
      source: { file: 'packages/bdmv/src/errors.ts', line: 1 },
    },
    {
      pkg: 'bdmv',
      name: 'Event',
      kind: 'type',
      summary: 'What the engine says.',
      body: '',
      signatures: [
        sig(
          "type Event = { readonly type: 'opened'; readonly thing: Thing } | { readonly type: 'closed' } | { readonly type: 'failed'; readonly reason: string }",
          { typeRefs: [{ name: 'Thing', pkg: 'bdmv' }] },
        ),
      ],
      members: [],
      usedBy: [],
      source: { file: 'packages/bdmv/src/event.ts', line: 1 },
    },
    {
      pkg: 'bdmv',
      name: 'Ids',
      kind: 'variable',
      summary: 'Element ids.',
      body: '',
      signatures: [sig(`const Ids: { ${Array.from({ length: 40 }, (_, i) => `readonly Field${i}: ${i * 1000}`).join('; ')} }`)],
      members: [],
      usedBy: [],
      source: { file: 'packages/bdmv/src/ids.ts', line: 1 },
    },
  ],
};
/** A made-up export of `pkg` with nothing but a name. */
const bare = (pkg: string, name: string): DevExport => ({
  pkg,
  name,
  kind: 'type',
  summary: `${name}.`,
  body: '',
  signatures: [sig(`type ${name} = string`)],
  members: [],
  usedBy: [],
  source: { file: `packages/${pkg}/src/x.ts`, line: 1 },
});
const other: DevPackage = {
  name: 'engine',
  readme: '# @seikou/engine\n\nThe made-up engine, from [the guide](../../docs/integrating.md). More.\n',
  exports: [bare('engine', 'Shared'), bare('engine', 'Lonely')],
};
const third: DevPackage = { name: 'nas', readme: '# @seikou/nas\n\nThe made-up wire.\n', exports: [bare('nas', 'Shared')] };
const site = [tricky, other, third];
const exp = (name: string): DevExport => tricky.exports.find((e) => e.name === name)!;

const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));

/** The open tags left unclosed or closed out of order, as messages; empty when the markup nests properly. */
function tagProblems(html: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const body = html
    .replace(/<script>[\s\S]*?<\/script>/g, '<script></script>')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^<!doctype html>/i, '');
  const re = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const [, close, rawName, selfClose] = m;
    const name = rawName!.toLowerCase();
    if (close) {
      const top = stack.pop();
      if (top !== name) problems.push(`</${name}> closes <${top ?? 'nothing'}> at ${m.index}`);
    } else if (!VOID.has(name) && !selfClose && !['path', 'circle'].includes(name)) {
      if (name === 'a' && stack.includes('a')) problems.push(`<a> inside <a> at ${m.index}`);
      stack.push(name);
    }
  }
  if (stack.length) problems.push(`unclosed: ${stack.join(' > ')}`);
  for (const m of body.matchAll(/<[^>]*</g)) problems.push(`'<' inside a tag at ${m.index}`);
  return problems;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function ids(doc: Document): string[] {
  return [...doc.querySelectorAll('[id]')].map((e) => e.id);
}

describe('export page', () => {
  const html = renderExport(exp('readThing'), site);
  const doc = parse(html);

  it('shows a comment’s <script> and a signature’s Array<string> as text', () => {
    expect(html).not.toContain('<script>alert');
    expect(doc.querySelector('main script')).toBeNull();
    expect(doc.querySelector('main .prose')!.textContent).toContain('<script>alert(1)</script>');
    expect(doc.querySelector('main .prose')!.textContent).toContain('Array<string> names');
    expect(doc.querySelector('pre.signature')!.textContent).toContain('names?: Array<string>');
    expect(html).toContain('Array&lt;string&gt;');
    expect(doc.querySelector('.example pre code')!.textContent).toContain('// a <b>comment</b>');
  });

  it('renders a code span as <code>', () => {
    expect(doc.querySelector('main .prose code')!.textContent).toBe('Thing');
  });

  it('links a public type to its page, and leaves the others plain', () => {
    const links = [...doc.querySelectorAll('pre.signature a.type-link')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['Thing', '/developers/bdmv/Thing']]);
    expect(doc.querySelector('.returns a.type-link')!.getAttribute('href')).toBe('/developers/bdmv/Thing');
    expect(doc.querySelector('pre.signature')!.textContent).toContain('bytes: Uint8Array,');
  });

  it('links each parameter name to its row', () => {
    const params = [...doc.querySelectorAll('pre.signature a.sig-param')].map((a) => a.getAttribute('href'));
    expect(params).toEqual(['#param-bytes', '#param-names']);
    expect(doc.getElementById('param-names')!.classList.contains('optional')).toBe(true);
  });

  it('follows the head contract: title, theme boot script first, stylesheets', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(doc.title).toBe('readThing · @seikou/bdmv · Seikou developers');
    expect(doc.head.querySelector('script')!.textContent).toBe(THEME_BOOT_SCRIPT);
    expect(doc.head.querySelector('meta[name="description"]')!.getAttribute('content')).toBe('Reads a Thing from <script>alert(1)</script> bytes.');
    expect([...doc.head.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'))).toEqual(['/developers/site.css']);
    expect(doc.querySelector('footer.dev-foot a')!.getAttribute('href')).toBe('https://github.com/brianhvo02/seikou');
    expect(doc.querySelector('form.search #search-input')).not.toBeNull();
    expect(doc.querySelector('.dev-bar-packages')!.getAttribute('href')).toBe('#packages');
  });

  it('puts the current export in the navigation', () => {
    expect(doc.querySelector('.dev-nav a[aria-current="true"]')!.textContent).toBe('bdmv');
    expect(doc.querySelector('.nav-exports a[aria-current="page"]')!.textContent).toBe('readThing');
  });

  it('names the error first in Throws, and the source line', () => {
    expect(doc.querySelector('.throws li code')!.textContent).toBe('ParseError');
    expect(doc.querySelector('.throws a.type-link')!.getAttribute('href')).toBe('/developers/bdmv/ParseError');
    expect(doc.querySelector('.source-link a')!.getAttribute('href')).toBe('https://github.com/brianhvo02/seikou/blob/main/packages/bdmv/src/thing.ts#L12');
  });

  it('shows the example without its SPDX line, imported exports linked', () => {
    const code = doc.querySelector('.example pre.code code')!;
    expect(code.textContent!.startsWith("import { readThing } from '@seikou/bdmv';")).toBe(true);
    expect([...code.querySelectorAll('a.type-link')].map((a) => a.getAttribute('href'))).toEqual(['/developers/bdmv/readThing', '/developers/bdmv/readThing']);
  });

  it('breaks a signature over 72 characters into one parameter a line', () => {
    const text = parse(renderExport(exp('openLongly'), site)).querySelector('pre.signature')!.textContent;
    expect(text).toBe('function openLongly(\n  path: string,\n  offset: number,\n  length: number,\n  signal?: AbortSignal,\n): Promise<Uint8Array>');
  });

  it('breaks a long union type into one member a line', () => {
    const text = parse(renderExport(exp('Event'), site)).querySelector('pre.signature')!.textContent;
    expect(text).toBe(
      "type Event =\n  | { readonly type: 'opened'; readonly thing: Thing }\n  | { readonly type: 'closed' }\n  | { readonly type: 'failed'; readonly reason: string }",
    );
  });

  it('shows a huge constant type short, with the whole type in a disclosure', () => {
    const d = parse(renderExport(exp('Ids'), site));
    const sigs = d.querySelectorAll('pre.signature');
    expect(sigs[0]!.textContent).toBe('const Ids: { … }');
    expect(d.querySelector('details.sig-full pre.signature')!.textContent).toContain('\n  readonly Field39: 39000;\n}');
  });
});

describe('interface and class pages', () => {
  it('lists an interface’s fields in the signature, each linked to its row', () => {
    const doc = parse(renderExport(exp('Thing'), site));
    expect(doc.querySelector('pre.signature')!.textContent).toBe('interface Thing {\n  readonly id: string;\n  readonly next?: Thing;\n}');
    expect([...doc.querySelectorAll('pre.signature a.sig-param')].map((a) => a.getAttribute('href'))).toEqual(['#field-id', '#field-next']);
    expect(doc.getElementById('field-next')!.classList.contains('optional')).toBe(true);
    expect(doc.querySelector('#used-by + .used-by a')!.getAttribute('href')).toBe('/developers/bdmv/readThing');
    expect(doc.querySelector('.export-kind')!.textContent).toBe('An interface in @seikou/bdmv.');
  });

  it('gives a class page an anchor per member', () => {
    const doc = parse(renderExport(exp('ParseError'), site));
    expect([...doc.querySelectorAll('.member-index a')].map((a) => a.getAttribute('href'))).toEqual(['#m-constructor', '#m-open']);
    expect(doc.querySelector('section.member#m-open .member-anchor')!.getAttribute('href')).toBe('#m-open');
    expect(doc.querySelector('#m-open pre.signature a.sig-param')!.getAttribute('href')).toBe('#m-open-param-thing');
    expect(doc.getElementById('m-open-param-thing')).not.toBeNull();
    expect(doc.getElementById('m-open-example')!.tagName).toBe('H4');
    expect(doc.getElementById('m-constructor-parameters')).not.toBeNull();
    expect(doc.querySelector('#m-constructor pre.signature')!.textContent).toBe('new ParseError(message: string)');
  });
});

describe('review fixes', () => {
  it('never puts a link inside a row link: a summary’s link is its text', () => {
    for (const html of [renderPackage(tricky, site), renderIndex(site)]) {
      expect(tagProblems(html)).toEqual([]);
      for (const row of parse(html).querySelectorAll('a.export-row, a.pkg-row')) expect(row.querySelector('a')).toBeNull();
    }
    const row = [...parse(renderPackage(tricky, site)).querySelectorAll('a.export-row')].find((a) => a.querySelector('code')!.textContent === 'openLongly')!;
    expect(row.querySelector('.export-row-summary')!.textContent).toBe('Opens something with a long list of parameters.');
    expect(tagProblems('<a href="#x"><span><a href="#y">y</a></span></a>')).toEqual(['<a> inside <a> at 19']);
  });

  it('shows a class’s heritage after its name, public types linked', () => {
    const doc = parse(renderExport(exp('ParseError'), site));
    const sig = doc.querySelector('pre.signature')!;
    expect(sig.textContent).toBe('class ParseError extends Error implements Thing');
    expect([...sig.querySelectorAll('a.type-link')].map((a) => a.getAttribute('href'))).toEqual(['/developers/bdmv/Thing']);
    expect([...sig.querySelectorAll('.tok-k')].map((k) => k.textContent)).toEqual(['class', 'extends', 'implements']);
  });

  it('shows the class example and the constructor’s own one', () => {
    const doc = parse(renderExport(exp('ParseError'), site));
    expect([...doc.querySelectorAll('.example-file code')].map((c) => c.textContent)).toEqual([
      'packages/bdmv/examples/parse-error-class.ts',
      'packages/bdmv/examples/parse-error-new.ts',
      'packages/bdmv/examples/parse-error.ts',
    ]);
    expect(doc.getElementById('example')).not.toBeNull();
  });

  it('takes a Throws entry’s first word as a type only when it is backticked, public or an Error', () => {
    const items = [...parse(renderExport(exp('openLongly'), site)).querySelectorAll('.throws li')];
    expect(items.map((li) => [li.querySelector(':scope > code:first-child')?.textContent ?? null, li.textContent])).toEqual([
      [null, 'If the bytes are short, nothing is read.'],
      ['RangeTrouble', 'RangeTrouble past the end.'],
      ['MadeUpError', 'MadeUpError when the disc is lost.'],
      ['Thing', 'Thing when it is odd.'],
    ]);
    expect(items[3]!.querySelector('a.type-link')!.getAttribute('href')).toBe('/developers/bdmv/Thing');
  });

  it('links a Used by name in the one package that exports it, and no link when several do', () => {
    const items = [...parse(renderExport(exp('Thing'), site)).querySelectorAll('.used-by li')];
    expect(items.map((li) => [li.textContent, li.querySelector('a')?.getAttribute('href') ?? null])).toEqual([
      ['readThing', '/developers/bdmv/readThing'],
      ['Shared', null],
      ['Lonely', '/developers/engine/Lonely'],
    ]);
  });

  it('points an in-page link at a prose heading only when the page has it', () => {
    const hashy: DevExport = {
      ...bare('bdmv', 'hashy'),
      summary: 'See [usage](#usage), the [members](#members) and [elsewhere](#nowhere).',
      body: '## Usage\n\nCall it.',
    };
    const links = [...parse(renderExport(hashy, site)).querySelectorAll('.prose a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['#doc-usage', '#members', '#nowhere']);
  });
});

describe('package, index, guide and 404', () => {
  it('a package page shows its README without the title, headings prefixed, then its exports by kind', () => {
    const doc = parse(renderPackage(tricky, site));
    expect(doc.title).toBe('@seikou/bdmv · Seikou developers');
    expect(doc.querySelector('h1')!.textContent).toBe('@seikou/bdmv');
    expect(doc.querySelector('.prose h1')).toBeNull();
    expect(doc.getElementById('doc-example')).not.toBeNull();
    expect([...doc.querySelectorAll('.export-group h2')].map((h) => h.id)).toEqual([
      'kind-functions',
      'kind-classes',
      'kind-interfaces',
      'kind-types',
      'kind-constants',
    ]);
    expect(doc.querySelector('.dev-nav a[aria-current="page"]')!.textContent).toBe('bdmv');
    expect(doc.querySelector('.nav-exports')).toBeNull();
    expect(doc.querySelector('.prose pre a.type-link')!.getAttribute('href')).toBe('/developers/bdmv/readThing');
  });

  it('the index lists the packages in their groups, with no navigation column', () => {
    const doc = parse(renderIndex(site));
    expect(doc.title).toBe('Seikou developers');
    expect([...doc.querySelectorAll('.pkg-row')].map((a) => [a.getAttribute('href'), a.querySelector('.pkg-summary')!.textContent])).toEqual([
      ['/developers/bdmv', 'The made-up disc format.'],
      ['/developers/engine', 'The made-up engine, from the guide.'],
      ['/developers/nas', 'The made-up wire.'],
    ]);
    expect(doc.querySelector('.dev-nav')).toBeNull();
    expect(doc.querySelector('.dev-bar-packages')).toBeNull();
    expect(doc.querySelector('.dev-layout')!.classList.contains('dev-layout-wide')).toBe(true);
  });

  it('the guide keeps its example block verbatim', () => {
    const markdown = readFileSync(join(repo, 'docs/integrating.md'), 'utf8');
    const example = /<!-- example:minimal-player -->\n```ts\n([\s\S]*?)```\n<!-- \/example -->/.exec(markdown)![1]!;
    const html = renderGuide(markdown, site);
    const doc = parse(html);
    expect(doc.title).toBe('Integrating the player · Seikou developers');
    expect([...doc.querySelectorAll('.prose pre code')].map((c) => c.textContent)).toContain(example.replace(/\n$/, ''));
    expect(html).not.toContain('example:minimal-player');
    expect(doc.querySelector('.dev-nav a[href="/developers/integrating"]')!.getAttribute('aria-current')).toBe('page');
    expect(tagProblems(html)).toEqual([]);
  });

  it('the 404 links absolutely and has no navigation column', () => {
    const doc = parse(render404());
    expect(doc.title).toBe('Not found · Seikou developers');
    expect(doc.querySelector('.not-found .guide-link')!.getAttribute('href')).toBe('/developers');
    expect(doc.querySelector('.dev-nav, .dev-bar-packages')).toBeNull();
    expect([...doc.querySelectorAll('a[href]')].every((a) => /^(\/|#|https:)/.test(a.getAttribute('href')!))).toBe(true);
  });
});

describe('every page', () => {
  const real = fixtureSite();
  const sites: [string, DevPackage[]][] = [
    ['made-up', site],
    ['fixture', real],
  ];
  for (const [label, s] of sites) {
    const pages: [string, string][] = [
      ['index', renderIndex(s)],
      ['404', render404()],
      ['guide', renderGuide(readFileSync(join(repo, 'docs/integrating.md'), 'utf8'), s)],
      ...s.map((p): [string, string] => [p.name, renderPackage(p, s)]),
      ...s.flatMap((p) => p.exports.map((e): [string, string] => [`${p.name}/${e.name}`, renderExport(e, s)])),
    ];
    it(`${label}: nests its tags properly, has one h1 and no repeated id`, () => {
      for (const [name, html] of pages) {
        expect(tagProblems(html), name).toEqual([]);
        const doc = parse(html);
        expect(doc.querySelectorAll('h1').length, name).toBe(1);
        const all = ids(doc);
        expect(all.length, name).toBe(new Set(all).size);
        for (const a of doc.querySelectorAll('a[href^="#"]')) {
          const target = a.getAttribute('href')!.slice(1);
          if (target) expect(doc.getElementById(target), `${name} ${target}`).not.toBeNull();
        }
      }
    });
  }
});

describe('searchIndex', () => {
  it('has one entry per public export, with a plain first sentence', () => {
    const entries = searchIndex(site);
    expect(entries.length).toBe(site.reduce((n, p) => n + p.exports.length, 0));
    expect(entries[0]).toEqual({
      pkg: 'bdmv',
      name: 'readThing',
      kind: 'function',
      summary: 'Reads a Thing from <script>alert(1)</script> bytes.',
      href: '/developers/bdmv/readThing',
    });
    const real = fixtureSite();
    expect(searchIndex(real).map((e) => e.name)).toEqual(real.flatMap((p) => p.exports.map((e) => e.name)));
  });
});
