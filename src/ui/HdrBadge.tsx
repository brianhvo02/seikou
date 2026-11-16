import { useEffect, useState, type ReactElement } from 'react';

const HDR_QUERY = '(dynamic-range: high)';
const defaultMatchMedia = (q: string): MediaQueryList => window.matchMedia(q);

/**
 * The `HDR` badge, shown while `active` (an HDR stream plays on the video element) and the display can show HDR
 * (`(dynamic-range: high)`, read again when it changes, as when the window moves to another screen). `matchMedia`
 * is `window.matchMedia` unless a test gives its own.
 */
export function HdrBadge({ active, matchMedia = defaultMatchMedia }: { readonly active: boolean; readonly matchMedia?: (query: string) => MediaQueryList }): ReactElement | null {
  const [hdrDisplay, setHdrDisplay] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function' && matchMedia === defaultMatchMedia) return; // no media queries: no HDR display
    const list = matchMedia(HDR_QUERY);
    const read = (): void => setHdrDisplay(list.matches);
    read();
    list.addEventListener('change', read);
    return () => list.removeEventListener('change', read);
  }, [matchMedia]);
  if (!active || !hdrDisplay) return null;
  return (
    <span className="level-badge" data-testid="hdr-badge">
      HDR
    </span>
  );
}
