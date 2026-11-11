// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceHash } from '../../tools/devsite/source-hash.mjs';
import { loadSite } from './model.ts';
import { exampleFixtures, siteStylesheet, sitePages } from './plugin.ts';

const fixtures = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function demoSite() {
  const model = JSON.parse(readFileSync(join(fixtures, 'model.json'), 'utf8')) as Record<string, unknown>;
  model.seikouSourceHash = sourceHash(fixtures);
  const path = join(mkdtempSync(join(tmpdir(), 'devsite-plugin-')), 'model.json');
  writeFileSync(path, JSON.stringify(model));
  return loadSite(path, fixtures);
}

describe('sitePages', () => {
  it('writes the index, the guide, the 404, each package and each export', () => {
    const pages = sitePages(demoSite(), '# Integrating\n\nPut the player in a page.\n');
    expect([...pages.keys()].sort()).toEqual([
      'developers/404.html',
      'developers/demo/DemoPlayer/index.html',
      'developers/demo/Mode/index.html',
      'developers/demo/ParseOptions/index.html',
      'developers/demo/index.html',
      'developers/demo/parse/index.html',
      'developers/demo/pick/index.html',
      'developers/index.html',
      'developers/integrating/index.html',
    ]);
    expect(pages.get('developers/demo/parse/index.html')).toContain('<h1 class="page-title">parse</h1>');
  });

  it('refuses two exports whose folders differ only in case', () => {
    const [demo] = demoSite();
    const parse = demo!.exports.find((e) => e.name === 'parse')!;
    const site = [{ ...demo!, exports: [...demo!.exports, { ...parse, name: 'Parse' }] }];
    expect(() => sitePages(site, '# Guide\n')).toThrow(/differ only in case/);
  });
});

describe('exampleFixtures', () => {
  it('lists the synthetic fixtures a browser example fetches, a folder with its files', () => {
    const root = mkdtempSync(join(tmpdir(), 'devsite-fixtures-'));
    mkdirSync(join(root, 'fixtures/synthetic/disc/BDMV'), { recursive: true });
    writeFileSync(join(root, 'fixtures/synthetic/disc/BDMV/index.bdmv'), 'x');
    writeFileSync(join(root, 'fixtures/synthetic/disc/BDMV/MovieObject.bdmv'), 'y');
    writeFileSync(join(root, 'fixtures/synthetic/one.bin'), 'z');
    writeFileSync(join(root, 'a.browser.ts'), "await fetch('/developers/_examples/fixtures/disc/');\nawait fetch(`/developers/_examples/fixtures/one.bin`);\n");
    expect(exampleFixtures(root, ['a.browser.ts'])).toEqual([
      'fixtures/synthetic/disc/BDMV/MovieObject.bdmv',
      'fixtures/synthetic/disc/BDMV/index.bdmv',
      'fixtures/synthetic/one.bin',
    ]);
    writeFileSync(join(root, 'b.browser.ts'), "await fetch('/developers/_examples/fixtures/missing.bin');\n");
    expect(() => exampleFixtures(root, ['b.browser.ts'])).toThrow(/does not exist/);
  });
});

describe('siteStylesheet', () => {
  it('puts Instrument Sans, the tokens and site.css in order, with the fonts beside it', () => {
    const { css, fonts } = siteStylesheet(repoRoot);
    const font = css.indexOf('@font-face');
    const tokens = css.indexOf('--laser');
    const site = css.indexOf('body.dev');
    expect(font).toBeGreaterThanOrEqual(0);
    expect(tokens).toBeGreaterThan(font);
    expect(site).toBeGreaterThan(tokens);
    expect(css).not.toContain('./files/');
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) {
      expect(css).toContain(`url(fonts/${f.name})`);
      expect(f.source.byteLength).toBeGreaterThan(1000);
    }
  });
});
