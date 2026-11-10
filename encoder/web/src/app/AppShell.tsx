// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ReactNode } from 'react';
import { Link, type Route } from './router';

/** What the shell needs. */
export interface AppShellProps {
  /** The page on screen, which marks its section in the bar. */
  readonly route: Route;
  /** The line under the bar that says what is encoding; empty when nothing is. */
  readonly progress?: ReactNode;
  /** The page. */
  readonly children: ReactNode;
}

/** Whether `route` belongs to the bar's `section`. */
function inSection(route: Route, section: 'library' | 'queue' | 'settings'): boolean {
  switch (section) {
    case 'library':
      return route.kind === 'library' || route.kind === 'disc' || route.kind === 'episodes' || route.kind === 'helper' || route.kind === 'show' || route.kind === 'season';
    case 'queue':
      return route.kind === 'queue' || route.kind === 'job' || route.kind === 'queueNew' || route.kind === 'seasonQueue' || route.kind === 'test';
    case 'settings':
      return route.kind === 'settings';
  }
}

/**
 * The frame of every page: the app bar with the name and the Library, Queue and Settings links (the section on screen
 * marked with `aria-current`), then the `progress` slot, then the page.
 */
export function AppShell({ route, progress, children }: AppShellProps) {
  const link = (section: 'library' | 'queue' | 'settings', to: Route, text: string) => (
    <Link to={to} aria-current={inSection(route, section) ? 'page' : undefined}>
      {text}
    </Link>
  );
  return (
    <div className="shell">
      <header className="app-bar">
        <Link to={{ kind: 'library' }} className="app-name">
          Seikou <span className="app-name-sub">encoder</span>
        </Link>
        <nav aria-label="Sections">
          {link('library', { kind: 'library' }, 'Library')}
          {link('queue', { kind: 'queue' }, 'Queue')}
          {link('settings', { kind: 'settings' }, 'Settings')}
        </nav>
      </header>
      <div className="progress-slot" aria-live="polite">
        {progress}
      </div>
      {children}
    </div>
  );
}
