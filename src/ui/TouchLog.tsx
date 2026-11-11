import { useEffect, useState, type ReactElement } from 'react';

/**
 * Test-only (`?touchlog=1`): a box over the page listing the last touch, pointer and click events and what each one
 * landed on (an alphabet bar key by its letter), plus the bar keys picked, for debugging a device without Web
 * Inspector. It takes no input itself.
 */
export const TOUCH_LOG = new URLSearchParams(globalThis.location?.search ?? '').get('touchlog') === '1';

/** Sent by the alphabet bars when a key is picked, for the touch log. */
export const RAIL_PICK_EVENT = 'bluray-rail-pick';

const TYPES = ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click'] as const;
const LINES = 14;

function describe(e: Event): string {
  const target = e.target instanceof Element ? e.target : null;
  const key = target?.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey;
  const where = key !== undefined ? `key ${key}` : target ? (target.className && typeof target.className === 'string' ? target.className.split(' ')[0]! : target.tagName.toLowerCase()) : '?';
  // TouchEvent is missing in desktop browsers without touch
  const point = typeof TouchEvent !== 'undefined' && e instanceof TouchEvent ? e.changedTouches[0] : e instanceof MouseEvent ? e : undefined;
  const at = point ? ` @${Math.round(point.clientX)},${Math.round(point.clientY)}` : '';
  const kind = e instanceof PointerEvent ? ` ${e.pointerType}` : '';
  return `${e.type}${kind} ${where}${at}${e.defaultPrevented ? ' prevented' : ''}`;
}

/** The debugging box: shows the last 14 lines of event log, each stamped with seconds since it mounted, plus the viewport size and any uncaught error. It is hidden from assistive technology. */
export function TouchLog(): ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const t0 = performance.now();
    const add = (line: string): void => setLines((ls) => [...ls.slice(-(LINES - 1)), `${((performance.now() - t0) / 1000).toFixed(2)} ${line}`]);
    const onEvent = (e: Event): void => add(describe(e));
    const onPick = (e: Event): void => add(`PICK ${(e as CustomEvent<string>).detail} → scrollY ${Math.round(scrollY)}`);
    const onError = (e: ErrorEvent): void => add(`ERROR ${e.message}`);
    for (const t of TYPES) window.addEventListener(t, onEvent, { capture: true, passive: true });
    window.addEventListener(RAIL_PICK_EVENT, onPick);
    window.addEventListener('error', onError);
    add(`viewport ${innerWidth}×${innerHeight} zoom ${visualViewport?.scale ?? 1}`);
    return () => {
      for (const t of TYPES) window.removeEventListener(t, onEvent, { capture: true });
      window.removeEventListener(RAIL_PICK_EVENT, onPick);
      window.removeEventListener('error', onError);
    };
  }, []);
  return (
    <pre className="touch-log" data-testid="touch-log" aria-hidden="true">
      {lines.join('\n')}
    </pre>
  );
}
