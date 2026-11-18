import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Marked, Parser, TextRenderer, type Token, type Tokens } from 'marked';
import type { Plugin } from 'vite';
import { HELP_PAGES, helpHref, uniqueSlugger } from '../src/ui/help/help-pages.ts';

const MODULE_ID = 'virtual:help-pages';
const RESOLVED_ID = `\0${MODULE_ID}`;

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline Markdown as plain text: link text kept, emphasis and code marks dropped. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A heading's text as GitHub slugs it: the visible text, with link text kept and no Markdown marks. */
export function headingText(tokens: Token[]): string {
  return new Parser().parseInline(tokens, new TextRenderer());
}

/** The ids of a page's headings, in order, as the site (and GitHub) give them. */
export function headingIds(markdown: string): string[] {
  const slug = uniqueSlugger();
  return new Marked({ gfm: true })
    .lexer(markdown)
    .filter((t): t is Tokens.Heading => t.type === 'heading')
    .map((t) => slug(headingText(t.tokens)));
}

/** The licences file's address in the Markdown (it works on GitHub); the site's pages link its own copy instead. */
export const LICENSES_URL = 'https://bluray.pages.dev/third-party-licenses.txt';

export interface RenderedHelpPage {
  readonly html: string;
  /** The first paragraph, as plain text, for the index. */
  readonly summary: string;
}

/**
 * One help page's Markdown as HTML: links rewritten with `helpHref` (one it refuses shows as its text), headings given GitHub's ids, and raw HTML shown as
 * text (the pages are Markdown only, and nothing on the site may load from another origin).
 */
export function renderHelpPage(markdown: string, file: string): RenderedHelpPage {
  const slug = uniqueSlugger();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const id = slug(headingText(tokens));
        return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        const to = href === LICENSES_URL ? '/third-party-licenses.txt' : helpHref(href, file);
        if (to === null) return text;
        return `<a href="${escapeHtml(to)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</a>`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      image({ text }: Tokens.Image) {
        return escapeHtml(text);
      },
    },
  });
  const tokens = marked.lexer(markdown);
  const first = tokens.find((t): t is Tokens.Paragraph => t.type === 'paragraph');
  const summary = first ? plainText(first.text) : '';
  return { html: marked.parser(tokens), summary };
}

/** `virtual:help-pages`: every help page converted at build time, so no Markdown parser ships. */
export function helpPages(root: string): Plugin {
  return {
    name: 'help-pages',
    resolveId(id) {
      return id === MODULE_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const pages: Record<string, RenderedHelpPage> = {};
      for (const page of HELP_PAGES) {
        const path = resolve(root, page.file);
        this.addWatchFile(path);
        pages[page.slug] = renderHelpPage(readFileSync(path, 'utf8'), page.file);
      }
      return `export default ${JSON.stringify(pages)};`;
    },
  };
}
