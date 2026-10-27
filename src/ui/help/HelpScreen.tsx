import { useEffect, useRef, type MouseEvent, type ReactElement } from 'react';
import pages from 'virtual:help-pages';
import type { NasHistory } from '../nas/nas-history';
import { HELP_PAGES, helpPath } from './help-pages';
import { AppLink, isPlainClick } from './HelpLink';

interface HelpScreenProps {
  readonly history: NasHistory;
  /** The page shown; null is the index. */
  readonly slug: string | null;
  /** The address bar's `#…`, for a link to a heading. */
  readonly hash: string;
}

const APP_TITLE = '青光 Seikou';

/** The player documentation (`docs/*.md`, converted at build time) under `/help`. */
export function HelpScreen({ history, slug, hash }: HelpScreenProps): ReactElement {
  const page = slug === null ? undefined : HELP_PAGES.find((p) => p.slug === slug);
  const article = useRef<HTMLElement>(null);

  useEffect(() => {
    document.title = page ? `${page.title} · Help · ${APP_TITLE}` : `Help · ${APP_TITLE}`;
  }, [page]);
  useEffect(() => () => void (document.title = APP_TITLE), []);

  // A page opened by a link starts at its top, or at the heading the link names; going back keeps the browser's scroll.
  useEffect(() => {
    if (history.lastMove() === 'pop') return;
    const id = decodeHash(hash);
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
    // for a screen reader, the new page's heading takes focus (as the NAS screens' headings do)
    const h1 = history.lastMove() === 'push' && !target ? article.current?.querySelector('h1') : null;
    if (h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  }, [history, slug, hash]);

  /** Links between help pages stay in the app; anything else (GitHub, other sites) is an ordinary link. */
  const onArticleClick = (e: MouseEvent): void => {
    const link = (e.target as Element).closest('a');
    const href = link?.getAttribute('href');
    if (!href || !isPlainClick(e) || !href.startsWith('/help')) return;
    e.preventDefault();
    history.pushPath(href);
  };

  return (
    <main className="help" data-testid="help">
      <header className="help-head">
        <AppLink history={history} to="/" className="help-home" testId="help-home">
          {APP_TITLE}
        </AppLink>
      </header>
      <div className="help-layout">
        <nav className="help-nav" aria-label="Help pages">
          <ul>
            <li>
              <AppLink history={history} to={helpPath(null)} current={page === undefined}>
                Contents
              </AppLink>
            </li>
            {HELP_PAGES.map((p) => (
              <li key={p.slug}>
                <AppLink history={history} to={helpPath(p.slug)} current={p === page}>
                  {p.title}
                </AppLink>
              </li>
            ))}
          </ul>
        </nav>
        {page ? (
          // The pages' own content, converted from the repo's Markdown at build time (raw HTML in it is escaped).
          <article
            ref={article}
            key={page.slug}
            className="help-page"
            data-testid="help-page"
            data-page={page.slug}
            onClick={onArticleClick}
            dangerouslySetInnerHTML={{ __html: pages[page.slug]?.html ?? '' }}
          />
        ) : (
          <article ref={article} className="help-page" data-testid="help-index">
            <h1>Help</h1>
            <ul className="help-index">
              {HELP_PAGES.map((p) => (
                <li key={p.slug}>
                  <AppLink history={history} to={helpPath(p.slug)}>
                    {p.title}
                  </AppLink>
                  {pages[p.slug]?.summary && <p>{pages[p.slug]?.summary}</p>}
                </li>
              ))}
            </ul>
          </article>
        )}
      </div>
    </main>
  );
}

function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return '';
  }
}
