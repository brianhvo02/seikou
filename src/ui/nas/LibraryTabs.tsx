// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ReactElement } from 'react';
import type { NasHistory } from './nas-history';
import { isEncodesRoute, type NasRoute } from './nas-route';

/** The two libraries the NAS screens switch between: the disc library and the Encodes library. */
export type LibraryTab = 'discs' | 'encodes';

/** Which library a NAS route belongs to: the encodes routes are the Encodes tab, every other one Discs. */
export function libraryTabOf(route: NasRoute | null): LibraryTab {
  return isEncodesRoute(route) ? 'encodes' : 'discs';
}

/** Where the bar puts the tabs on their own row, after its tools (the phone layout in styles.css). */
export const NARROW_BAR = '(max-width: 600px)';

const TABS: readonly { readonly id: LibraryTab; readonly label: string; readonly route: NasRoute }[] = [
  { id: 'discs', label: 'Discs', route: { kind: 'library', shelf: null, q: '' } },
  { id: 'encodes', label: 'Encodes', route: { kind: 'encodes', q: '' } },
];

/**
 * Discs and Encodes, the two libraries of a NAS: under the app bar at full width on a phone, at the left of the bar on
 * a wide screen, the open one underlined. Each leads to its library's first screen.
 */
export function LibraryTabs({ history, route, pending = false }: { readonly history: NasHistory; readonly route: NasRoute | null; readonly pending?: boolean }): ReactElement {
  const open = libraryTabOf(route);
  // `pending`: their room is kept while it isn't known yet whether they belong (no flash for a guest behind the gate)
  return (
    <nav className={pending ? 'library-tabs pending' : 'library-tabs'} aria-label="Libraries" aria-hidden={pending || undefined} inert={pending || undefined} data-testid="library-tabs">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className="library-tab"
          data-testid="library-tab"
          data-tab={t.id}
          aria-current={open === t.id ? 'page' : undefined}
          onClick={() => history.push(t.route)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
