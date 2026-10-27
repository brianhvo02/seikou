/**
 * The help pages: the player documentation in `docs/`, shown on the site under `/help`. The Markdown is converted at
 * build time (`vite/markdown.ts`), which rewrites each link with `helpHref`; this file has no Markdown parser, so the
 * app can import it.
 */

export interface HelpPage {
  readonly slug: string;
  /** Path from the repo root. */
  readonly file: string;
  /** The page's own `# ` heading. */
  readonly title: string;
}

export const HELP_PAGES: readonly HelpPage[] = [
  { slug: 'getting-started', file: 'docs/getting-started.md', title: 'Getting started' },
  { slug: 'playing-discs', file: 'docs/playing-discs.md', title: 'Playing discs' },
  { slug: 'nas', file: 'docs/nas.md', title: 'NAS' },
  { slug: 'troubleshooting', file: 'docs/troubleshooting.md', title: 'Troubleshooting' },
  { slug: 'self-hosting', file: 'docs/self-hosting.md', title: 'Run your own server' },
];

const GITHUB_BLOB = 'https://github.com/brianhvo02/seikou/blob/main/';
const REPO_BASE = 'https://repo.invalid/';

/**
 * Where a link in a help page's Markdown goes on the site: another help page → `/help/<slug>[#hash]`; any other repo
 * file → that file on GitHub; `http(s):` and `mailto:` URLs and in-page anchors unchanged. Anything else (another
 * scheme such as `javascript:`, a scheme-relative `//host` link) is null: the site shows the link's text with no link.
 */
export function helpHref(link: string, fromFile: string): string | null {
  if (link.startsWith('#')) return link;
  if (/^(https?|mailto):/i.test(link)) return link;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) || /^[\\/]{2}/.test(link)) return null;
  const base = new URL(REPO_BASE + fromFile);
  let target: URL;
  try {
    // A leading `/` is the repo root, as GitHub reads it.
    target = new URL(link, base);
  } catch {
    return null;
  }
  // the URL parser drops tabs and newlines, so a scheme can still appear here: only a path in the repo goes on
  if (target.origin !== base.origin) return null;
  const path = target.pathname.slice(1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const page = HELP_PAGES.find((p) => p.file === decoded);
  if (page) return helpPath(page.slug) + target.hash;
  return GITHUB_BLOB + path + target.search + target.hash;
}

export function helpPath(slug: string | null): string {
  return slug === null ? '/help' : `/help/${slug}`;
}

/** The help page a path names (`slug: null` is the index, also for an unknown page); null outside `/help`. */
export function parseHelpPath(pathname: string): { slug: string | null } | null {
  const seg = pathname.split('/');
  if (seg[0] !== '' || seg[1] !== 'help') return null;
  const rest = seg.slice(2);
  if (rest.length > 0 && rest[rest.length - 1] === '') rest.pop();
  if (rest.length !== 1) return { slug: null };
  return { slug: HELP_PAGES.some((p) => p.slug === rest[0]) ? rest[0] : null };
}

/** A heading's id as GitHub makes it (github-slugger): lower case, punctuation dropped, spaces to hyphens. */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** githubSlug, numbering repeats in one page (`notes`, `notes-1`, …). */
export function uniqueSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = githubSlug(text);
    let slug = base;
    let n = seen.get(base) ?? 0;
    while (seen.has(slug)) slug = `${base}-${++n}`;
    seen.set(base, n);
    seen.set(slug, seen.get(slug) ?? 0);
    return slug;
  };
}
