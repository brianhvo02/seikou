// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The developer site in the production build: `generateBundle` writes every page of `/developers` as static HTML
 * (the index, each package, each export, the integration guide and the 404), the search index, one stylesheet
 * (Instrument Sans, the player's tokens and `site.css`, in that order, with the font files beside it), the search
 * script, and the browser examples page under `/developers/_examples/`. The pages import nothing from the player.
 * The preview server answers a developer address with its folder's `index.html`, and an unknown one with
 * `developers/404.html`, as the static host does.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { build as esbuild } from 'esbuild';
import type { Plugin } from 'vite';
import { examplesPage } from './examples-page.ts';
import { exampleFiles, loadSite, type DevPackage } from './model.ts';
import { render404, renderExport, renderGuide, renderIndex, renderPackage } from './render.ts';
import { searchIndex } from './search-index.ts';

const EXAMPLES_ID = 'virtual:devsite-examples';
const RESOLVED_EXAMPLES_ID = `\0${EXAMPLES_ID}`;
const EXAMPLES_ENTRY = 'developers/_examples/examples-entry.js';
const FIXTURE_ROOT = 'fixtures/synthetic';
/** How a browser example names a fixture it fetches: `/developers/_examples/fixtures/<path under fixtures/synthetic>`. */
const FIXTURE_URL = /\/developers\/_examples\/fixtures\/([\w./-]+)/g;

/** Where the TypeDoc model lives, from the repository root (written by `npm run devsite:model`). */
export const MODEL_PATH = '.cache/devsite/model.json';

/** The browser examples: the `*.browser.ts` files under `packages/<pkg>/examples/`. */
export function browserExampleFiles(repoRoot: string): string[] {
  return exampleFiles(repoRoot).filter((f) => f.endsWith('.browser.ts'));
}

/** Every file under `fixtures/synthetic/` the browser examples fetch, as paths from the repository root (a folder brings its files). */
export function exampleFixtures(repoRoot: string, files: readonly string[]): string[] {
  const out = new Set<string>();
  const add = (rel: string): void => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) throw new Error(`developer site: an example fetches ${rel}, which does not exist`);
    if (statSync(abs).isDirectory()) for (const e of readdirSync(abs)) add(posix.join(rel, e));
    else out.add(rel);
  };
  for (const file of files) {
    for (const m of readFileSync(join(repoRoot, file), 'utf8').matchAll(FIXTURE_URL)) {
      const path = posix.normalize(m[1]!.replace(/\/$/, ''));
      if (path.startsWith('..')) throw new Error(`developer site: ${file} fetches a fixture outside ${FIXTURE_ROOT}`);
      add(posix.join(FIXTURE_ROOT, path));
    }
  }
  return [...out].sort();
}

/** The one stylesheet: Instrument Sans (its `url()`s pointed at `fonts/`), the tokens, then `site.css`; and the font files it names. */
export function siteStylesheet(repoRoot: string): { css: string; fonts: { name: string; source: Uint8Array }[] } {
  const require = createRequire(join(repoRoot, 'package.json'));
  const fontCssPath = require.resolve('@fontsource-variable/instrument-sans/wdth.css');
  const fonts: { name: string; source: Uint8Array }[] = [];
  const fontCss = readFileSync(fontCssPath, 'utf8').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_all, _q: string, url: string) => {
    const name = posix.basename(url);
    if (!fonts.some((f) => f.name === name)) fonts.push({ name, source: readFileSync(resolve(dirname(fontCssPath), url)) });
    return `url(fonts/${name})`;
  });
  const tokens = readFileSync(join(repoRoot, 'src/ui/tokens.css'), 'utf8');
  const site = readFileSync(join(repoRoot, 'vite/devsite/site.css'), 'utf8');
  return { css: `${fontCss}\n${tokens}\n${site}`, fonts };
}

/** The site's pages, by their file in the build output. */
export function sitePages(site: readonly DevPackage[], guide: string): Map<string, string> {
  const pages = new Map<string, string>();
  const put = (file: string, html: string): void => {
    const key = file.toLowerCase();
    for (const other of pages.keys()) if (other.toLowerCase() === key) throw new Error(`developer site: ${file} and ${other} differ only in case`);
    pages.set(file, html);
  };
  put('developers/index.html', renderIndex(site));
  put('developers/integrating/index.html', renderGuide(guide, site));
  put('developers/404.html', render404());
  for (const p of site) {
    put(`developers/${p.name}/index.html`, renderPackage(p, site));
    for (const e of p.exports) put(`developers/${p.name}/${e.name}/index.html`, renderExport(e, site));
  }
  return pages;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The Vite plugin that builds `/developers`; `repoRoot` holds the model, the packages and the guide. */
export function developerSite(repoRoot: string): Plugin {
  let building = false;
  let site: DevPackage[] | null = null;
  let examples: { files: string[]; fixtures: string[] } = { files: [], fixtures: [] };
  return {
    name: 'seikou-developer-site',
    configResolved(config) {
      building = config.command === 'build';
    },
    buildStart() {
      if (!building || this.environment.name !== 'client') return;
      const model = join(repoRoot, MODEL_PATH);
      if (!existsSync(model)) throw new Error(`developer site: no model at ${MODEL_PATH}: run npm run devsite:model`);
      site = loadSite(model, repoRoot); // throws on a model built from other sources
      const files = browserExampleFiles(repoRoot);
      examples = { files, fixtures: exampleFixtures(repoRoot, files) };
      this.emitFile({ type: 'chunk', id: EXAMPLES_ID, fileName: EXAMPLES_ENTRY });
    },
    resolveId(id) {
      return id === EXAMPLES_ID ? RESOLVED_EXAMPLES_ID : undefined;
    },
    load(id) {
      return id === RESOLVED_EXAMPLES_ID ? examplesPage(examples.files, examples.fixtures).entry : undefined;
    },
    async generateBundle() {
      if (!site) return;
      const emit = (fileName: string, source: string | Uint8Array): void => {
        this.emitFile({ type: 'asset', fileName, source });
      };
      for (const [file, html] of sitePages(site, readFileSync(join(repoRoot, 'docs/integrating.md'), 'utf8'))) emit(file, html);
      emit('developers/search.json', JSON.stringify(searchIndex(site)));
      const { css, fonts } = siteStylesheet(repoRoot);
      emit('developers/site.css', css);
      for (const f of fonts) emit(`developers/fonts/${f.name}`, f.source);
      const script = await esbuild({
        entryPoints: [join(repoRoot, 'vite/devsite/search.ts')],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        legalComments: 'none',
        write: false,
      });
      emit('developers/search.js', script.outputFiles[0]!.text);
      const page = examplesPage(examples.files, examples.fixtures, `/${EXAMPLES_ENTRY}`);
      emit('developers/_examples/index.html', page.html);
      for (const f of page.fixtures) emit(`developers/_examples/fixtures/${posix.relative(FIXTURE_ROOT, f)}`, readFileSync(join(repoRoot, f)));
    },
    configurePreviewServer(server) {
      const outDir = resolve(server.config.root, server.config.build.outDir);
      const devRoot = join(outDir, 'developers');
      server.middlewares.use((req, res, next) => {
        let path: string;
        try {
          path = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]!);
        } catch {
          return next();
        }
        if (!/^\/developers(\/|$)/.test(path)) return next();
        const file = join(outDir, path);
        const inside = relative(devRoot, file);
        if (inside.startsWith('..') || inside.split(sep).includes('..')) return next();
        if (isFile(file)) return next();
        // a page is its folder's index.html, which the preview's fallback to the player's shell would otherwise win over
        if (isFile(join(file, 'index.html'))) {
          req.url = `${path.replace(/\/$/, '')}/index.html`;
          return next();
        }
        if (!isFile(join(devRoot, '404.html'))) return next();
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(readFileSync(join(devRoot, '404.html')));
      });
    },
  };
}
