// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** Whether a media query matches, kept current; false where `matchMedia` is missing (tests without it). */
export function useMediaQuery(query: string): boolean {
  const list = useMemo(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null), [query]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!list) return () => {};
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [list],
  );
  return useSyncExternalStore(subscribe, () => list?.matches ?? false, () => false);
}
