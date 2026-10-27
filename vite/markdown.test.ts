import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_PAGES } from '../src/ui/help/help-pages.ts';
import { headingIds, renderHelpPage } from './markdown.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string): string => readFileSync(repo + file, 'utf8');

describe('renderHelpPage', () => {
  it('rewrites links and gives headings their GitHub ids', () => {
    const { html, summary } = renderHelpPage('# Title\n\nSee [NAS](nas.md#pairing) and [notes](contributing.md).\n\n## Audio & text\n', 'docs/x.md');
    expect(html).toContain('<a href="/help/nas#pairing">NAS</a>');
    expect(html).toContain('href="https://github.com/brianhvo02/seikou/blob/main/docs/contributing.md"');
    expect(html).toContain('<h2 id="audio--text">Audio &amp; text</h2>');
    expect(summary).toBe('See NAS and notes.');
  });

  it('gives a heading with a link, code and emphasis the id GitHub gives it, the same in headingIds', () => {
    const md = '# Title\n\n## See [NAS](nas.md) for `code` and *more*\n\n## Title\n';
    const { html } = renderHelpPage(md, 'docs/x.md');
    expect(headingIds(md)).toEqual(['title', 'see-nas-for-code-and-more', 'title-1']);
    for (const id of headingIds(md)) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('<h2 id="see-nas-for-code-and-more">See <a href="/help/nas">NAS</a> for <code>code</code> and <em>more</em></h2>');
  });

  it('shows a link with a refused scheme as its text', () => {
    const { html } = renderHelpPage('[click](javascript:alert(1)) and [ok](https://example.com "Example")\n', 'docs/x.md');
    expect(html).not.toContain('javascript');
    expect(html).toContain('click and <a href="https://example.com" title="Example">ok</a>');
  });

  it('shows raw HTML and images as text', () => {
    const { html } = renderHelpPage('A badge reads "<level> · on" ![logo](https://example.com/a.png)\n\n<img src="x.png">\n', 'docs/x.md');
    expect(html).toContain('&lt;level&gt;');
    expect(html).not.toMatch(/<(img|level)\b/);
    expect(html).toContain('&lt;img src=');
  });

  it('renders every page with nothing that loads from elsewhere', () => {
    for (const page of HELP_PAGES) {
      const { html } = renderHelpPage(read(page.file), page.file);
      expect(html, page.file).not.toMatch(/<(img|script|iframe|link|video|audio|source|object|embed|style)\b/i);
      expect(html, page.file).not.toMatch(/\.md(#|")/);
    }
  });
});
