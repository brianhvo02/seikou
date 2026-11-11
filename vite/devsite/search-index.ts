// SPDX-License-Identifier: LGPL-3.0-or-later
import type { DevExport, DevPackage } from './model.ts';

/** One export as the search box lists it: `summary` is the first sentence of its doc comment, as plain text. */
export interface SearchEntry {
  readonly pkg: string;
  readonly name: string;
  readonly kind: string;
  readonly summary: string;
  readonly href: string;
}

/** The site path of a package's page, or of one of its exports. */
export function devHref(pkg: string, name?: string): string {
  return name === undefined ? `/developers/${pkg}` : `/developers/${pkg}/${encodeURIComponent(name)}`;
}

/**
 * The first sentence of a Markdown paragraph, with its line breaks folded: the text up to the first `.`, `?` or `!`
 * outside a code span that is followed by a space and a capital, a digit or a code span, or that ends the text.
 */
export function firstSentence(markdown: string): string {
  const text = markdown.replace(/\s+/g, ' ').trim();
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') inCode = !inCode;
    else if (!inCode && (c === '.' || c === '?' || c === '!')) {
      if (i === text.length - 1) return text;
      if (text[i + 1] === ' ' && /[A-Z0-9`]/.test(text[i + 2] ?? '')) return text.slice(0, i + 1);
    }
  }
  return text;
}

/** Inline Markdown as plain text: link text kept, code and emphasis marks dropped. */
export function plainText(markdown: string): string {
  const spans: string[] = [];
  return markdown
    .replace(/`([^`]*)`/g, (_, code: string) => `\u0000${spans.push(code) - 1}\u0000`)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|\*)(\S(?:[^]*?\S)?)\1/g, '$2')
    .replace(/(^|[^\w])(__|_)(\S(?:[^]*?\S)?)\2(?!\w)/g, '$1$3')
    .replace(/\u0000(\d+)\u0000/g, (_, n: string) => spans[Number(n)]!)
    .replace(/\s+/g, ' ')
    .trim();
}

/** An export's one-line summary as plain text, for search and the page's description. */
export function summaryText(e: DevExport): string {
  return plainText(firstSentence(e.summary));
}

/** One entry per public export of every package, in package then name order. */
export function searchIndex(site: readonly DevPackage[]): SearchEntry[] {
  return site.flatMap((p) =>
    p.exports.map((e) => ({
      pkg: p.name,
      name: e.name,
      kind: e.kind,
      summary: summaryText(e),
      href: devHref(p.name, e.name),
    })),
  );
}
