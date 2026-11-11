// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The developer pages as static HTML: the index, a package, an export (function, class, interface, type or constant),
 * the integration guide and the 404, in the markup of the look's contract
 * (docs/superpowers/specs/2026-11-10-developer-site-look.md §7), which `site.css` styles. Every string from the model
 * or a README is escaped where it is text, and Markdown goes through `marked` with raw HTML shown as text.
 */
import { Marked, Parser, TextRenderer, type Token, type Tokens } from 'marked';
import { helpHref, uniqueSlugger } from '../../src/ui/help/help-pages.ts';
import type { DevExample, DevExport, DevMember, DevPackage, DevParam, DevSignature, DevTypeRef } from './model.ts';
import { devHref, firstSentence, plainText, summaryText } from './search-index.ts';
import { THEME_BOOT_SCRIPT } from './theme-boot.ts';

const GITHUB = 'https://github.com/brianhvo02/seikou';
const GITHUB_BLOB = `${GITHUB}/blob/main/`;
const SITE_NAME = 'Seikou developers';
const GUIDE_TITLE = 'Integrating the player';
const GUIDE_PATH = '/developers/integrating';
/** Signatures longer than this are set one parameter (or field, or union member) a line. */
const WIDTH = 72;
/** A constant whose type takes more lines than this shows a short signature, with the full type behind a disclosure. */
const COLLAPSE_LINES = 30;

/** The packages in the order the index groups them, with the group each belongs to. */
const PACKAGE_GROUPS: readonly {
  readonly title: string;
  readonly id: string;
  readonly packages: readonly string[];
}[] = [
  {
    title: 'Reading and playing media',
    id: 'media',
    packages: ['bdmv', 'pg', 'ass', 'engine', 'matroska'],
  },
  {
    title: 'Running a disc library',
    id: 'library',
    packages: ['nas', 'titles', 'fansubs'],
  },
];
const PACKAGE_ORDER = PACKAGE_GROUPS.flatMap((g) => g.packages);

/** Where a page's stylesheets and script come from; the build passes its hashed asset paths. */
export interface PageAssets {
  /** In order: Instrument Sans, the tokens, then `site.css` (or one file that bundles them in that order). */
  readonly stylesheets: readonly string[];
  /** The search and theme switch script, loaded at the end of the body. */
  readonly script: string;
}

/** The paths the plugin publishes: one stylesheet bundling the three, and the client script. */
export const DEFAULT_ASSETS: PageAssets = {
  stylesheets: ['/developers/site.css'],
  script: '/developers/search.js',
};

/** Escapes text for HTML content and double-quoted attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------------------------------------------
// The site's lookups

interface SiteIndex {
  /** Package name to its export names. */
  readonly names: ReadonlyMap<string, ReadonlySet<string>>;
  /** Export name to the packages that export it. */
  readonly byName: ReadonlyMap<string, readonly string[]>;
}

const indexes = new WeakMap<readonly DevPackage[], SiteIndex>();

function siteIndex(site: readonly DevPackage[]): SiteIndex {
  let idx = indexes.get(site);
  if (!idx) {
    const names = new Map<string, Set<string>>();
    const byName = new Map<string, string[]>();
    for (const p of site) {
      names.set(p.name, new Set(p.exports.map((e) => e.name)));
      for (const e of p.exports) byName.set(e.name, [...(byName.get(e.name) ?? []), p.name]);
    }
    idx = { names, byName };
    indexes.set(site, idx);
  }
  return idx;
}

/** The page of a public export named `name`, looked up in `pkg` first, then in any package; null when there is none. */
function exportPage(site: readonly DevPackage[], name: string, pkg: string | null): string | null {
  const idx = siteIndex(site);
  if (pkg !== null && idx.names.get(pkg)?.has(name)) return devHref(pkg, name);
  const any = idx.byName.get(name)?.[0];
  return any === undefined ? null : devHref(any, name);
}

/** The links a signature may make: each type it names that is a public export of the package the model says. */
function typeLinks(site: readonly DevPackage[], refs: readonly DevTypeRef[]): Map<string, string> {
  const idx = siteIndex(site);
  const out = new Map<string, string>();
  for (const r of refs) if (r.pkg !== null && idx.names.get(r.pkg)?.has(r.name)) out.set(r.name, devHref(r.pkg, r.name));
  return out;
}

/** The public exports an example imports from a `@seikou/<package>` root, by local name. */
function importLinks(site: readonly DevPackage[] | undefined, code: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!site) return out;
  const idx = siteIndex(site);
  const re = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@seikou\/([a-z]+)['"]/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const pkg = m[2]!;
    for (const spec of m[1]!.split(',')) {
      const s = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(spec);
      if (s && idx.names.get(pkg)?.has(s[1]!)) out.set(s[2] ?? s[1]!, devHref(pkg, s[1]!));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Highlighting

// Markers the layout leaves in signature text (the model's text never holds private-use characters).
const P_OPEN = ''; // a parameter or field name, linked to its row
const P_CLOSE = '';
const N_OPEN = ''; // the declared name
const N_CLOSE = '';
const K_OPEN = ''; // a keyword the layout chose (function, new, get, set, class, interface, type, const)
const K_CLOSE = '';
const param = (name: string): string => P_OPEN + name + P_CLOSE;
const declName = (name: string): string => N_OPEN + name + N_CLOSE;
const kw = (word: string): string => K_OPEN + word + K_CLOSE;
/** A marked string's length as drawn. */
const vlen = (s: string): number => s.replace(/[-]/g, '').length;

const CODE_KEYWORDS = new Set(
  'abstract as asserts async await break case catch class const continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void while yield'.split(
    ' ',
  ),
);
const SIG_KEYWORDS = new Set('asserts extends implements in infer is keyof new readonly typeof unique'.split(' '));

const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?\b)|([A-Za-z_$][\w$]*)|([])([^]*)[]|(\?:|=>|[:?|])/g;

/**
 * Code as HTML: `code` mode for examples and code blocks (comments, strings, numbers, keywords, and the exports an
 * example imports as links), `sig` mode for signatures (keywords, muted `:` `?` `=>` `|`, type links and the layout's
 * markers). A name directly before `:` or `?:` is a property, never a link or a keyword.
 */
function highlight(text: string, mode: 'code' | 'sig', links: ReadonlyMap<string, string>, paramHref: (name: string) => string = () => '#'): string {
  let out = '';
  let at = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    out += escapeHtml(text.slice(at, m.index));
    at = TOKEN.lastIndex;
    const [all, comment, str, num, ident, marker, markerText, punct] = m;
    if (comment !== undefined) out += mode === 'code' ? `<span class="tok-c">${escapeHtml(comment)}</span>` : escapeHtml(comment);
    else if (str !== undefined) out += `<span class="tok-s">${escapeHtml(str)}</span>`;
    else if (num !== undefined) out += `<span class="tok-n">${escapeHtml(num)}</span>`;
    else if (ident !== undefined) {
      const before = text[m.index - 1];
      const after = text.slice(at, at + 2);
      const property = after.startsWith(':') || after === '?:';
      const member = before === '.';
      const href = links.get(ident);
      if (!property && !member && href !== undefined) out += `<a class="type-link" href="${escapeHtml(href)}">${escapeHtml(ident)}</a>`;
      else if (!property && !member && (mode === 'code' ? CODE_KEYWORDS : SIG_KEYWORDS).has(ident)) out += `<span class="tok-k">${ident}</span>`;
      else out += escapeHtml(ident);
    } else if (marker !== undefined) {
      const t = escapeHtml(markerText ?? '');
      if (marker === P_OPEN) out += `<a class="sig-param" href="${escapeHtml(paramHref(markerText ?? ''))}">${t}</a>`;
      else if (marker === N_OPEN) out += `<span class="sig-name">${t}</span>`;
      else out += `<span class="tok-k">${t}</span>`;
    } else if (punct !== undefined) out += mode === 'sig' ? `<span class="tok-p">${escapeHtml(punct)}</span>` : escapeHtml(punct);
    else out += escapeHtml(all);
  }
  return out + escapeHtml(text.slice(at));
}

// ---------------------------------------------------------------------------------------------------------------
// Signature layout: one line when it fits in WIDTH, else one parameter, field or union member a line, as Prettier sets it

const pad = (n: number): string => ' '.repeat(n);
const OPENERS = '([{<';
const CLOSERS = ')]}>';

/** Calls `visit(i)` for each index of `s` outside strings, with the bracket depth there (before `s[i]` is counted). */
function scan(s: string, visit: (i: number, depth: number) => boolean | void): void {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (visit(i, depth) === true) return;
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c) && !(c === '>' && s[i - 1] === '=')) depth--;
  }
}

/** The index of the bracket that closes the one at `open`, or -1. */
function closing(s: string, open: number): number {
  let found = -1;
  scan(s, (i, depth) => {
    if (i > open && depth === 1 && CLOSERS.includes(s[i]!) && !(s[i] === '>' && s[i - 1] === '=')) {
      found = i;
      return true;
    }
    return undefined;
  });
  return found;
}

/** `s` split at each `sep` outside brackets and strings. */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  scan(s, (i, depth) => {
    if (depth === 0 && i >= start && s.startsWith(sep, i)) {
      parts.push(s.slice(start, i));
      start = i + sep.length;
    }
  });
  parts.push(s.slice(start));
  return parts;
}

/** The first index of `sub` outside brackets and strings, or -1. */
function indexTop(s: string, sub: string): number {
  let found = -1;
  scan(s, (i, depth) => {
    if (depth === 0 && s.startsWith(sub, i)) {
      found = i;
      return true;
    }
    return undefined;
  });
  return found;
}

/**
 * A type laid out from column `indent`: the first line continues the line it starts on (empty when the type starts on
 * the next line, as a broken union does), later lines carry their own indentation.
 */
function layoutType(t: string, indent: number): string[] {
  if (indent + vlen(t) <= WIDTH) return [t];
  const members = splitTop(t, ' | ');
  if (members.length > 1) {
    return [
      '',
      ...members.flatMap((m) => {
        const ls = layoutType(m, indent + 4);
        return [`${pad(indent + 2)}| ${ls[0]}`, ...ls.slice(1)];
      }),
    ];
  }
  if (t.startsWith('{ ') && t.endsWith(' }') && closing(t, 0) === t.length - 1) {
    const fields = splitTop(t.slice(2, -2), '; ');
    return ['{', ...fields.flatMap((f) => withSuffix(indented(layoutField(f, indent + 2), indent + 2), ';')), `${pad(indent)}}`];
  }
  return [t];
}

/** A field, property or parameter (`name?: type`, `[key: K]: V`, `name(args): ret`) laid out from column `indent`. */
function layoutField(f: string, indent: number): string[] {
  if (indent + vlen(f) <= WIDTH) return [f];
  const callable = /^(?:[^]* |readonly )?(?:[^]*|[^]*|[\w$]+)\??[(<]/.test(f);
  if (callable) return layoutCallable(f, indent);
  const colon = indexTop(f, ': ');
  if (colon < 0) return [f];
  const ls = layoutType(f.slice(colon + 2), indent);
  return [ls[0] === '' ? `${f.slice(0, colon)}:` : `${f.slice(0, colon)}: ${ls[0]}`, ...ls.slice(1)];
}

/** `head(params)rest` with one parameter a line when it does not fit from column `indent`. */
function layoutCallable(s: string, indent: number): string[] {
  if (indent + vlen(s) <= WIDTH) return [s];
  const open = indexTop(s, '(');
  const close = open < 0 ? -1 : closing(s, open);
  if (close < 0) return [s];
  const inner = s.slice(open + 1, close);
  if (!inner) return [s];
  const lines = [s.slice(0, open + 1)];
  for (const p of splitTop(inner, ', ')) lines.push(...withSuffix(indented(layoutField(p, indent + 2), indent + 2), ','));
  const rest = s.slice(close + 1);
  if (rest.startsWith(': ')) {
    const ls = layoutType(rest.slice(2), indent);
    lines.push(`${pad(indent)})${ls[0] === '' ? ':' : `: ${ls[0]}`}`, ...ls.slice(1));
  } else lines.push(`${pad(indent)})${rest}`);
  return lines;
}

/** A head and the type after its `sep` (`type X = T`, `const X: T`), the type laid out from column 0. */
function layoutDeclaration(head: string, sep: string, type: string): string[] {
  const ls = layoutType(type, vlen(head) + sep.length);
  if (ls.length === 1) return [head + sep + ls[0]];
  const again = layoutType(type, 0);
  return [again[0] === '' ? head + sep.trimEnd() : head + sep + again[0], ...again.slice(1)];
}

function indented(lines: string[], indent: number): string[] {
  return [pad(indent) + lines[0], ...lines.slice(1)];
}

function withSuffix(lines: string[], suffix: string): string[] {
  return [...lines.slice(0, -1), lines[lines.length - 1] + suffix];
}

/** TypeScript 5.9 spells out the default type argument of the typed arrays; the signatures leave it out. */
function tidy(type: string): string {
  return type.replace(/<ArrayBufferLike>/g, '');
}

/** A function, method, constructor or accessor signature from the model, with its name and parameters marked. */
function markCallable(text: string): string {
  const m = /^(function |new |get |set )?([\w$]+)/.exec(text);
  if (!m) return text;
  const prefix = m[1] ? `${kw(m[1].trim())} ` : '';
  let rest = text.slice(m[0].length);
  const open = indexTop(rest, '(');
  if (open < 0) return prefix + declName(m[2]!) + rest;
  const close = closing(rest, open);
  if (close < 0) return prefix + declName(m[2]!) + rest;
  const marked = splitTop(rest.slice(open + 1, close), ', ')
    .map((p) => p.replace(/^(\.\.\.)?([\w$]+)/, (_, dots: string | undefined, name: string) => `${dots ?? ''}${param(name)}`))
    .join(', ');
  rest = rest.slice(0, open + 1) + marked + rest.slice(close);
  return prefix + declName(m[2]!) + rest;
}

/** A property signature (`readonly name?: T`) with its name marked: as the declared name, or as a field link. */
function markProperty(text: string, name: string, as: 'decl' | 'field'): string {
  const ro = text.startsWith('readonly ') ? `${kw('readonly')} ` : '';
  const rest = (ro ? text.slice('readonly '.length) : text).slice(name.length);
  return ro + (as === 'decl' ? declName(name) : param(name)) + rest;
}

/** The lines of one signature on an export or member page. */
function signatureLines(s: DevSignature, kind: 'callable' | 'property' | 'type' | 'variable', name: string): string[] {
  const text = tidy(s.text);
  switch (kind) {
    case 'callable':
      return layoutCallable(markCallable(text), 0);
    case 'property':
      return layoutField(markProperty(text, name, 'decl'), 0);
    case 'type': {
      const eq = indexTop(text, ' = ');
      const head = text.slice('type '.length, eq);
      return layoutDeclaration(`${kw('type')} ${declName(name)}${head.slice(name.length)}`, ' = ', text.slice(eq + 3));
    }
    case 'variable':
      return layoutDeclaration(`${kw('const')} ${declName(name)}`, ': ', text.slice(`const ${name}: `.length));
  }
}

/** An interface's fields, one a line, each name a link to its row. */
function interfaceLines(e: DevExport): string[] {
  const lines = [`${kw(e.kind === 'enum' ? 'enum' : 'interface')} ${declName(e.name)} {`];
  for (const m of e.members) {
    for (const s of m.signatures) {
      const text = tidy(s.text);
      const field = m.kind === 'property' ? markProperty(text, m.name, 'field') : text.startsWith(m.name) ? param(m.name) + text.slice(m.name.length) : text;
      lines.push(...withSuffix(indented(layoutField(field, 2), 2), ';'));
    }
  }
  lines.push('}');
  return lines;
}

/** A signature well; each marked parameter or field links to the row `rowId` names. */
function pre(lines: readonly string[], links: ReadonlyMap<string, string>, rowId: (name: string) => string = (n) => n): string {
  return `<pre class="signature"><code>${highlight(lines.join('\n'), 'sig', links, (n) => `#${rowId(n)}`)}</code></pre>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown

/** The page a link in a README, doc comment or the guide goes to: a developer page, a help page or the file on GitHub. */
function linkTarget(link: string, fromFile: string, site: readonly DevPackage[] | undefined): string | null {
  if (link.startsWith('#')) return `#doc-${link.slice(1)}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(link) && !/^[\\/]{2}/.test(link)) {
    try {
      const base = new URL(`https://repo.invalid/${fromFile}`);
      const target = new URL(link, base);
      if (target.origin === base.origin) {
        const path = decodeURIComponent(target.pathname.slice(1));
        const hash = target.hash ? `#doc-${target.hash.slice(1)}` : '';
        if (path === 'docs/integrating.md') return GUIDE_PATH + hash;
        const readme = /^packages\/([a-z]+)\/README\.md$/.exec(path);
        if (readme && (site ? site.some((p) => p.name === readme[1]) : PACKAGE_ORDER.includes(readme[1]!))) return devHref(readme[1]!) + hash;
      }
    } catch {
      return null;
    }
  }
  return helpHref(link, fromFile);
}

/** A heading's visible text, as GitHub slugs it. */
function headingText(tokens: Token[]): string {
  return new Parser().parseInline(tokens, new TextRenderer());
}

/**
 * Markdown for one page: headings get `doc-` ids (unique on the page), links go through `linkTarget`, raw HTML is
 * shown as text (comments are dropped), images show their alt text, and fenced TypeScript is highlighted with the
 * exports it imports linked.
 */
class Markdown {
  private readonly slug = uniqueSlugger();
  private readonly marked: Marked;

  constructor(
    private readonly fromFile: string,
    private readonly site: readonly DevPackage[] | undefined,
  ) {
    const slug = this.slug;
    const target = (href: string): string | null => linkTarget(href, this.fromFile, this.site);
    const highlightBlock = (code: string, lang: string | undefined): string =>
      lang === undefined || /^(ts|tsx|typescript|js|jsx|javascript|mjs)$/i.test(lang)
        ? highlight(code, 'code', importLinks(this.site, code))
        : escapeHtml(code);
    this.marked = new Marked({
      gfm: true,
      renderer: {
        heading({ tokens, depth }: Tokens.Heading) {
          return `<h${depth} id="doc-${escapeHtml(slug(headingText(tokens)))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
        },
        link({ href, title, tokens }: Tokens.Link) {
          const text = this.parser.parseInline(tokens);
          const to = target(href);
          if (to === null) return text;
          return `<a href="${escapeHtml(to)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</a>`;
        },
        html({ text }: Tokens.HTML | Tokens.Tag) {
          return /^\s*<!--[\s\S]*-->\s*$/.test(text) ? '' : escapeHtml(text);
        },
        image({ text }: Tokens.Image) {
          return escapeHtml(text);
        },
        code({ text, lang }: Tokens.Code) {
          return `<pre><code>${highlightBlock(text, lang || undefined)}</code></pre>\n`;
        },
      },
    });
  }

  /** Block Markdown as HTML. */
  block(markdown: string): string {
    return this.marked.parse(markdown, { async: false });
  }

  /** Inline Markdown (a sentence in a table cell or list row) as HTML. */
  inline(markdown: string): string {
    return this.marked.parseInline(markdown.replace(/\s+/g, ' ').trim(), {
      async: false,
    });
  }

  /** Block Markdown without its leading `# ` heading, and that heading's text (null when there is none). */
  withoutTitle(markdown: string): { title: string | null; html: string } {
    const tokens = this.marked.lexer(markdown);
    const i = tokens.findIndex((t) => t.type !== 'space');
    const first = tokens[i];
    if (first?.type === 'heading' && (first as Tokens.Heading).depth === 1) {
      const title = headingText((first as Tokens.Heading).tokens);
      tokens.splice(i, 1);
      return { title, html: this.marked.parser(tokens) };
    }
    return { title: null, html: this.marked.parser(tokens) };
  }
}

/** A README's first sentence (after its title heading), as Markdown. */
function readmeSummary(readme: string): string {
  const tokens = new Marked({ gfm: true }).lexer(readme);
  const p = tokens.find((t): t is Tokens.Paragraph => t.type === 'paragraph');
  return p ? firstSentence(p.text) : '';
}

// ---------------------------------------------------------------------------------------------------------------
// The page frame

const THEME_SWITCH = `<fieldset class="theme-switch">
      <legend class="visually-hidden">Theme</legend>
      <label class="theme-option" title="Auto"><input type="radio" name="theme" value="auto" aria-label="Auto" checked><span class="theme-word" aria-hidden="true">Auto</span><svg class="theme-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.5v9a4.5 4.5 0 0 1 0-9Z"/></svg></label>
      <label class="theme-option" title="Light"><input type="radio" name="theme" value="light" aria-label="Light"><span class="theme-word" aria-hidden="true">Light</span><svg class="theme-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 .75v2M8 13.25v2M.75 8h2M13.25 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M2.9 13.1l1.4-1.4M11.7 4.3l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></label>
      <label class="theme-option" title="Dark"><input type="radio" name="theme" value="dark" aria-label="Dark"><span class="theme-word" aria-hidden="true">Dark</span><svg class="theme-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z"/></svg></label>
    </fieldset>`;

interface PageParts {
  readonly title: string;
  readonly description: string;
  readonly main: string;
  /** The navigation column, or null for a page without one (the index, the 404). */
  readonly nav: string | null;
  readonly assets: PageAssets;
}

function page({ title, description, main, nav, assets }: PageParts): string {
  const styles = assets.stylesheets.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f6f8fe">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a1330">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<script>${THEME_BOOT_SCRIPT}</script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${styles}
</head>
<body class="dev">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="dev-bar">
    <a class="dev-home" href="/developers"><img src="/favicon.svg" alt="" width="28" height="28"><span class="dev-home-name">Seikou</span><span class="dev-home-sub">developers</span></a>
    <form class="search" role="search" action="/developers" onsubmit="return false">
      <label class="visually-hidden" for="search-input">Search exports</label>
      <input class="search-input" id="search-input" type="search" placeholder="Search exports" autocomplete="off" aria-controls="search-results" aria-expanded="false">
      <ul class="search-results" id="search-results" role="listbox" hidden></ul>
    </form>
${nav === null ? '' : '    <a class="dev-bar-packages" href="#packages">Packages</a>\n'}    ${THEME_SWITCH}
  </header>
  <div class="dev-layout${nav === null ? ' dev-layout-wide' : ''}">
    <main class="dev-main" id="main">
${main}
    </main>
${nav ?? ''}  </div>
  <footer class="dev-foot"><a href="${GITHUB}">Source on GitHub</a></footer>
  <script src="${escapeHtml(assets.script)}" defer></script>
</body>
</html>
`;
}

type Kind = DevExport['kind'];
const KIND_GROUPS: readonly {
  readonly title: string;
  readonly id: string;
  readonly kinds: readonly Kind[];
}[] = [
  { title: 'Functions', id: 'functions', kinds: ['function'] },
  { title: 'Classes', id: 'classes', kinds: ['class'] },
  { title: 'Interfaces', id: 'interfaces', kinds: ['interface'] },
  { title: 'Types', id: 'types', kinds: ['type', 'enum'] },
  { title: 'Constants', id: 'constants', kinds: ['variable'] },
];

function grouped(p: DevPackage): { title: string; id: string; exports: DevExport[] }[] {
  return KIND_GROUPS.map((g) => ({
    title: g.title,
    id: g.id,
    exports: p.exports.filter((e) => g.kinds.includes(e.kind)),
  })).filter((g) => g.exports.length > 0);
}

/** The packages in the index's order: the known ones first, any other after them by name. */
function ordered(site: readonly DevPackage[]): DevPackage[] {
  const rank = (n: string): number => (PACKAGE_ORDER.includes(n) ? PACKAGE_ORDER.indexOf(n) : PACKAGE_ORDER.length);
  return [...site].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

interface NavAt {
  readonly pkg?: string;
  readonly exportName?: string;
  readonly guide?: boolean;
}

function navColumn(names: readonly string[], site: readonly DevPackage[] | undefined, at: NavAt): string {
  const items = names.map((name) => {
    const here = at.pkg === name;
    const current = here ? (at.exportName === undefined ? ' aria-current="page"' : ' aria-current="true"') : '';
    let exports = '';
    const p = site?.find((x) => x.name === name);
    if (here && at.exportName !== undefined && p) {
      exports = `\n        <div class="nav-exports">${grouped(p)
        .map(
          (g) =>
            `<h3 class="nav-kind">${g.title}</h3><ul>${g.exports
              .map(
                (e) =>
                  `<li><a href="${escapeHtml(devHref(name, e.name))}"${e.name === at.exportName ? ' aria-current="page"' : ''}><code>${escapeHtml(e.name)}</code></a></li>`,
              )
              .join('')}</ul>`,
        )
        .join('')}</div>\n      `;
    }
    return `      <li><a href="${escapeHtml(devHref(name))}"${current}>${escapeHtml(name)}</a>${exports}</li>`;
  });
  return `    <nav class="dev-nav" id="packages" aria-label="Packages">
      <h2 class="nav-heading">Packages</h2>
      <ul class="nav-list">
${items.join('\n')}
      </ul>
      <h2 class="nav-heading">Guide</h2>
      <ul class="nav-list"><li><a href="${GUIDE_PATH}"${at.guide ? ' aria-current="page"' : ''}>${GUIDE_TITLE}</a></li></ul>
    </nav>
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces of an export page

/** The example's code as shown: without the SPDX line every example file starts with. */
function exampleCode(ex: DevExample): string {
  return ex.code.replace(/^\/\/ SPDX-License-Identifier: [^\n]*\n/, '').replace(/\n+$/, '');
}

/** An example well; `owner` (the export it documents) is linked too, since a region of an example may not show its import. */
function exampleFigure(ex: DevExample, site: readonly DevPackage[], owner: { pkg: string; name: string }, extraClass = ''): string {
  const code = exampleCode(ex);
  const links = importLinks(site, code);
  if (!links.has(owner.name)) links.set(owner.name, devHref(owner.pkg, owner.name));
  return `<figure class="example${extraClass}">
  <figcaption class="example-file"><a href="${escapeHtml(GITHUB_BLOB + ex.file)}"><code>${escapeHtml(ex.file)}</code></a></figcaption>
  <pre class="code"><code>${highlight(code, 'code', links)}</code></pre>
</figure>`;
}

/** What a signature's parameter rows hold: each name once across the overloads, optional if any overload makes it so. */
function mergedParams(sigs: readonly DevSignature[]): DevParam[] {
  const out = new Map<string, DevParam>();
  for (const s of sigs) {
    for (const p of s.params) {
      const had = out.get(p.name);
      out.set(
        p.name,
        had
          ? {
              ...had,
              optional: had.optional || p.optional,
              doc: had.doc || p.doc,
            }
          : p,
      );
    }
  }
  return [...out.values()];
}

interface SectionIds {
  /** The heading level of the API sections: h2 on an export, h4 inside a class member. */
  readonly level: 2 | 4;
  /** `''` on an export page, `m-<member>-` inside a member. */
  readonly prefix: string;
  /** A parameter row's id. */
  readonly row: (name: string) => string;
}

function section(ids: SectionIds, name: string, title: string, body: string): string {
  return `<section class="api-section"><h${ids.level} id="${escapeHtml(ids.prefix + name)}">${title}</h${ids.level}>\n${body}\n</section>`;
}

function paramsTable(
  rows: readonly {
    id: string;
    name: string;
    type: string;
    doc: string;
    optional: boolean;
    links: ReadonlyMap<string, string>;
  }[],
  md: Markdown,
): string {
  const body = rows
    .map(
      (r) =>
        `  <tr id="${escapeHtml(r.id)}"${r.optional ? ' class="optional"' : ''}><th scope="row"><code>${escapeHtml(r.name)}</code></th><td class="param-type"><code>${highlight(tidy(r.type), 'sig', r.links)}</code></td><td class="param-doc">${md.inline(r.doc)}</td></tr>`,
    )
    .join('\n');
  return `<table class="params"><thead class="visually-hidden"><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>\n${body}\n</tbody></table>`;
}

/** `Throws` rows: an entry that starts with a type name puts that name first, linked when it is public. */
function throwsList(entries: readonly string[], site: readonly DevPackage[], pkg: string, md: Markdown): string {
  const items = entries.map((t) => {
    const m = /^`?([A-Z][\w$]*)`?(?=\s|$)\s*([\s\S]*)$/.exec(t);
    if (!m) return `<li>${md.inline(t)}</li>`;
    const href = exportPage(site, m[1]!, pkg);
    const name = href ? `<a class="type-link" href="${escapeHtml(href)}">${escapeHtml(m[1]!)}</a>` : escapeHtml(m[1]!);
    return `<li><code>${name}</code> ${md.inline(m[2]!)}</li>`;
  });
  return `<ul class="throws">${items.join('')}</ul>`;
}

/** Parameters, returns, throws and the example of a callable (a function, or a method or constructor of a class). */
function callableSections(
  sigs: readonly DevSignature[],
  ids: SectionIds,
  site: readonly DevPackage[],
  pkg: string,
  md: Markdown,
  opts: { returns: boolean; example?: DevExample },
  owner: { pkg: string; name: string },
): string {
  const out: string[] = [];
  const params = mergedParams(sigs);
  if (params.length) {
    out.push(
      section(
        ids,
        'parameters',
        'Parameters',
        paramsTable(
          params.map((p) => ({
            id: ids.row(p.name),
            name: p.name,
            type: p.type,
            doc: p.doc,
            optional: p.optional,
            links: typeLinks(site, p.typeRefs),
          })),
          md,
        ),
      ),
    );
  }
  if (opts.returns) {
    const seen = new Set<string>();
    const rows = sigs.filter((s) => {
      const key = s.returns.type + '\0' + s.returns.doc;
      if (seen.has(key) || (s.returns.type === 'void' && !s.returns.doc)) return false;
      seen.add(key);
      return true;
    });
    if (rows.length) {
      const body = rows
        .map(
          (s) =>
            `<p class="returns"><code class="returns-type">${highlight(tidy(s.returns.type), 'sig', typeLinks(site, s.typeRefs))}</code>${s.returns.doc ? ` ${md.inline(s.returns.doc)}` : ''}</p>`,
        )
        .join('\n');
      out.push(section(ids, 'returns', 'Returns', body));
    }
  }
  const throws = [...new Set(sigs.flatMap((s) => s.throws))];
  if (throws.length) out.push(section(ids, 'throws', 'Throws', throwsList(throws, site, pkg, md)));
  if (opts.example) out.push(section(ids, 'example', 'Example', exampleFigure(opts.example, site, owner)));
  return out.join('\n');
}

function prose(markdown: string, md: Markdown): string {
  return markdown.trim() ? `<div class="prose">${md.block(markdown)}</div>` : '';
}

function docOf(e: { summary: string; body?: string }): string {
  return [e.summary, e.body ?? ''].filter((s) => s.trim()).join('\n\n');
}

const MEMBER_KIND: Record<DevMember['kind'], string> = {
  method: 'Method',
  property: 'Property',
  accessor: 'Accessor',
  constructor: 'Constructor',
};

function memberSection(e: DevExport, m: DevMember, site: readonly DevPackage[], md: Markdown): string {
  const id = `m-${m.name}`;
  const ids: SectionIds = {
    level: 4,
    prefix: `${id}-`,
    row: (n) => `${id}-param-${n}`,
  };
  const links = typeLinks(
    site,
    m.signatures.flatMap((s) => s.typeRefs),
  );
  const callable = m.kind !== 'property' || m.signatures.some((s) => s.params.length > 0 || s.text.startsWith(`${m.name}(`));
  const sigs = m.signatures
    .map((s) => pre(callable ? signatureLines(s, 'callable', m.name) : signatureLines(s, 'property', m.name), links, ids.row))
    .join('\n');
  const sections = callable
    ? callableSections(
        m.signatures,
        ids,
        site,
        e.pkg,
        md,
        {
          returns: m.kind === 'method',
          ...(m.example ? { example: m.example } : {}),
        },
        e,
      )
    : m.example
      ? section(ids, 'example', 'Example', exampleFigure(m.example, site, e))
      : '';
  return `<section class="member" id="${escapeHtml(id)}">
<h3 class="member-name"><a class="member-anchor" href="#${escapeHtml(id)}"><code>${escapeHtml(m.name)}</code></a></h3>
<p class="member-kind">${MEMBER_KIND[m.kind]}</p>
${sigs}
${prose(m.summary, md)}
${sections}
</section>`;
}

const KIND_SENTENCE: Record<Kind, string> = {
  function: 'A function',
  class: 'A class',
  interface: 'An interface',
  type: 'A type',
  variable: 'A constant',
  enum: 'An enum',
};

function usedBy(e: DevExport, site: readonly DevPackage[]): string {
  if (!e.usedBy.length) return '';
  const items = e.usedBy.map((n) => {
    const href = exportPage(site, n, e.pkg);
    return href ? `<li><a href="${escapeHtml(href)}"><code>${escapeHtml(n)}</code></a></li>` : `<li><code>${escapeHtml(n)}</code></li>`;
  });
  return `<section class="api-section"><h2 id="used-by">Used by</h2><ul class="used-by">${items.join('')}</ul></section>`;
}

function sourceLink(e: DevExport): string {
  if (!e.source.file) return '';
  const href = `${GITHUB_BLOB}${e.source.file}${e.source.line ? `#L${e.source.line}` : ''}`;
  return `<p class="source-link">Source: <a href="${escapeHtml(href)}"><code>${escapeHtml(e.source.file)}${e.source.line ? `:${e.source.line}` : ''}</code></a></p>`;
}

/** A constant's signature, with a long type behind a disclosure under a short one. */
function variableSignature(e: DevExport, s: DevSignature, links: ReadonlyMap<string, string>): string {
  const lines = signatureLines(s, 'variable', e.name);
  if (lines.length <= COLLAPSE_LINES) return pre(lines, links);
  const object = lines[0]!.endsWith('{');
  const short = `${kw('const')} ${declName(e.name)}: ${object ? '{ … }' : '…'}`;
  const what = object ? `The whole type, ${lines.length - 2} fields` : 'The whole type';
  return `${pre([short], links)}
<details class="sig-full"><summary>${what}</summary>
${pre(lines, links)}
</details>`;
}

// ---------------------------------------------------------------------------------------------------------------
// The pages

/** `/developers`: the packages in their two groups, a snippet and the way to the guide. */
export function renderIndex(site: readonly DevPackage[], assets: PageAssets = DEFAULT_ASSETS): string {
  const md = new Markdown('docs/integrating.md', site);
  const hero = site.find((p) => p.name === 'bdmv')?.exports.find((e) => e.name === 'parseMpls')?.example;
  const groups = PACKAGE_GROUPS.map((g) => {
    const rows = g.packages
      .map((n) => site.find((p) => p.name === n))
      .filter((p): p is DevPackage => !!p)
      .map(
        (p) =>
          `        <li><a class="pkg-row" href="${escapeHtml(devHref(p.name))}"><code class="pkg-name">@seikou/${escapeHtml(p.name)}</code><span class="pkg-summary">${md.inline(readmeSummary(p.readme))}</span></a></li>`,
      );
    return rows.length
      ? `      <section class="pkg-group"><h2 id="${g.id}">${g.title}</h2><ul class="pkg-list">\n${rows.join('\n')}\n      </ul></section>`
      : '';
  }).filter(Boolean);
  const others = site.filter((p) => !PACKAGE_ORDER.includes(p.name));
  if (others.length) {
    groups.push(
      `      <section class="pkg-group"><h2 id="other">Other packages</h2><ul class="pkg-list">\n${others
        .map(
          (p) =>
            `        <li><a class="pkg-row" href="${escapeHtml(devHref(p.name))}"><code class="pkg-name">@seikou/${escapeHtml(p.name)}</code><span class="pkg-summary">${md.inline(readmeSummary(p.readme))}</span></a></li>`,
        )
        .join('\n')}\n      </ul></section>`,
    );
  }
  const main = `      <h1 class="index-title">Build on Seikou’s Blu-ray code</h1>
      <p class="lede">Eight TypeScript packages that read a disc’s files, demux its streams, draw its subtitles and play it in a browser. Every function here has an example the tests run.</p>
${hero ? exampleFigure(hero, site, { pkg: 'bdmv', name: 'parseMpls' }, ' hero-example') : ''}
      <a class="guide-link" href="${GUIDE_PATH}"><span class="guide-link-name">Put the player in a page</span><span class="guide-link-text">The integration guide: the engine worker, the controller and a disc from files or a server.</span></a>
${groups.join('\n')}`;
  return page({
    title: SITE_NAME,
    description: 'The reference for Seikou’s TypeScript packages: every export with its signature and an example.',
    main,
    nav: null,
    assets,
  });
}

/** `/developers/<package>`: its README, then its exports grouped by kind. */
export function renderPackage(p: DevPackage, site: readonly DevPackage[], assets: PageAssets = DEFAULT_ASSETS): string {
  const md = new Markdown(`packages/${p.name}/README.md`, site);
  const readme = md.withoutTitle(p.readme).html;
  const groups = grouped(p).map(
    (g) =>
      `      <section class="export-group"><h2 id="kind-${g.id}">${g.title}</h2><ul class="export-list">\n${g.exports
        .map(
          (e) =>
            `        <li><a class="export-row" href="${escapeHtml(devHref(p.name, e.name))}"><code class="export-row-name">${escapeHtml(e.name)}</code><span class="export-row-summary">${md.inline(firstSentence(e.summary))}</span></a></li>`,
        )
        .join('\n')}\n      </ul></section>`,
  );
  const main = `      <nav class="crumbs" aria-label="Breadcrumb"><a href="/developers">Packages</a><span class="crumb-sep" aria-hidden="true">/</span><span aria-current="page">${escapeHtml(p.name)}</span></nav>
      <h1 class="page-title">@seikou/${escapeHtml(p.name)}</h1>
${readme.trim() ? `      <div class="prose">${readme}</div>` : ''}
${groups.join('\n')}`;
  return page({
    title: `@seikou/${p.name} · ${SITE_NAME}`,
    description: plainText(readmeSummary(p.readme)),
    main,
    nav: navColumn(
      ordered(site).map((x) => x.name),
      site,
      { pkg: p.name },
    ),
    assets,
  });
}

/** `/developers/<package>/<export>`: the signature first, then what it does, takes, gives back and throws, its example and source. */
export function renderExport(e: DevExport, site: readonly DevPackage[], assets: PageAssets = DEFAULT_ASSETS): string {
  const md = new Markdown(e.source.file || `packages/${e.pkg}/README.md`, site);
  const pkgHref = escapeHtml(devHref(e.pkg));
  const head = `      <nav class="crumbs" aria-label="Breadcrumb"><a href="${pkgHref}">@seikou/${escapeHtml(e.pkg)}</a><span class="crumb-sep" aria-hidden="true">/</span><span aria-current="page">${escapeHtml(e.name)}</span></nav>
      <h1 class="page-title">${escapeHtml(e.name)}</h1>
      <p class="export-kind">${KIND_SENTENCE[e.kind]} in <a href="${pkgHref}"><code>@seikou/${escapeHtml(e.pkg)}</code></a>.</p>`;
  const parts: string[] = [head];
  const rows: SectionIds = { level: 2, prefix: '', row: (n) => `param-${n}` };
  switch (e.kind) {
    case 'function': {
      const links = typeLinks(
        site,
        e.signatures.flatMap((s) => s.typeRefs),
      );
      parts.push(e.signatures.map((s) => pre(signatureLines(s, 'callable', e.name), links, rows.row)).join('\n'));
      parts.push(prose(docOf(e), md));
      parts.push(callableSections(e.signatures, rows, site, e.pkg, md, { returns: true, ...(e.example ? { example: e.example } : {}) }, e));
      break;
    }
    case 'class': {
      parts.push(pre([`${kw('class')} ${declName(e.name)}`], new Map()));
      parts.push(prose(docOf(e), md));
      if (e.members.length) {
        parts.push(`<nav class="member-index" aria-labelledby="members">
<h2 id="members">Members</h2>
<ul>${e.members.map((m) => `<li><a href="#m-${escapeHtml(m.name)}"><code>${escapeHtml(m.name)}</code></a></li>`).join('')}</ul>
</nav>`);
      }
      parts.push(...e.members.map((m) => memberSection(e, m, site, md)));
      if (e.example && !e.members.some((m) => m.kind === 'constructor')) parts.push(section(rows, 'example', 'Example', exampleFigure(e.example, site, e)));
      parts.push(usedBy(e, site));
      break;
    }
    case 'interface':
    case 'enum': {
      const links = typeLinks(
        site,
        e.members.flatMap((m) => m.signatures.flatMap((s) => s.typeRefs)),
      );
      parts.push(pre(interfaceLines(e), links, (n) => `field-${n}`));
      parts.push(prose(docOf(e), md));
      if (e.members.length) {
        const fieldRows = e.members.map((m) => {
          const s = m.signatures[0];
          const type = !s
            ? 'unknown'
            : m.kind === 'property' && !s.params.length && !s.text.startsWith(`${m.name}(`)
              ? s.returns.type
              : tidy(s.text)
                  .replace(/^(?:get |set )?[\w$]+/, '')
                  .replace(/\): /, ') => ');
          const optional = s ? /^(?:readonly )?[\w$]+\?/.test(s.text) : false;
          return {
            id: `field-${m.name}`,
            name: m.name,
            type,
            doc: m.summary,
            optional,
            links: typeLinks(
              site,
              m.signatures.flatMap((x) => x.typeRefs),
            ),
          };
        });
        parts.push(`<section class="api-section"><h2 id="fields">Fields</h2>\n${paramsTable(fieldRows, md)}\n</section>`);
      }
      if (e.example) parts.push(section(rows, 'example', 'Example', exampleFigure(e.example, site, e)));
      parts.push(usedBy(e, site));
      break;
    }
    case 'type':
    case 'variable': {
      const links = typeLinks(
        site,
        e.signatures.flatMap((s) => s.typeRefs),
      );
      parts.push(e.signatures.map((s) => (e.kind === 'type' ? pre(signatureLines(s, 'type', e.name), links) : variableSignature(e, s, links))).join('\n'));
      parts.push(prose(docOf(e), md));
      if (e.example) parts.push(section(rows, 'example', 'Example', exampleFigure(e.example, site, e)));
      parts.push(usedBy(e, site));
      break;
    }
  }
  parts.push(sourceLink(e));
  return page({
    title: `${e.name} · @seikou/${e.pkg} · ${SITE_NAME}`,
    description: summaryText(e),
    main: parts.filter(Boolean).join('\n'),
    nav: navColumn(
      ordered(site).map((x) => x.name),
      site,
      { pkg: e.pkg, exportName: e.name },
    ),
    assets,
  });
}

/** `/developers/integrating`: `docs/integrating.md`, its code blocks as they are in the file. */
export function renderGuide(markdown: string, site?: readonly DevPackage[], assets: PageAssets = DEFAULT_ASSETS): string {
  const md = new Markdown('docs/integrating.md', site);
  const { title, html } = md.withoutTitle(markdown);
  const description = plainText(readmeSummary(markdown));
  const main = `      <h1 class="page-title">${escapeHtml(title ?? GUIDE_TITLE)}</h1>
      <div class="prose">${html}</div>`;
  const names = site ? ordered(site).map((p) => p.name) : PACKAGE_ORDER;
  return page({
    title: `${GUIDE_TITLE} · ${SITE_NAME}`,
    description,
    main,
    nav: navColumn(names, site, { guide: true }),
    assets,
  });
}

/** `/developers/404.html`, served at any developer address with no page; every link in it is absolute. */
export function render404(assets: PageAssets = DEFAULT_ASSETS): string {
  const main = `      <div class="not-found">
        <h1 class="page-title">No page at this address</h1>
        <p>It may name an export that was renamed or is no longer public. Search for it, or start from the packages.</p>
        <a class="guide-link" href="/developers"><span class="guide-link-name">All packages</span><span class="guide-link-text">The eight packages and the integration guide.</span></a>
      </div>`;
  return page({
    title: `Not found · ${SITE_NAME}`,
    description: 'No developer page at this address.',
    main,
    nav: null,
    assets,
  });
}
