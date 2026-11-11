import { useEffect, useRef, useState, type ReactElement } from 'react';
import { LoadQueue, type LoadPriority } from './load-queue';
import type { NasClient } from './nas-client';
import { loadsEveryPoster, type ConnectionInfo } from './poster-reach';
import { initials } from './title-model';

interface PosterProps {
  readonly nas: NasClient;
  /** The art id, or null when the title has none. */
  readonly artId: string | null;
  readonly name: string;
  readonly size: 'small' | 'large';
  readonly className: string;
}

/** Posters loading at once: the browser's connections to one host. */
const LOADS_AT_ONCE = 6;
/** How far above and below the viewport counts as within scroll range: two screens. */
const SCROLL_RANGE = '200% 0px';

/**
 * Every poster on the page loads through this queue: those on screen first, then those within scroll range, then the
 * rest, when the connection allows them (`loadsEveryPoster`).
 */
const posters = new LoadQueue(LOADS_AT_ONCE);

/** One IntersectionObserver per margin, shared by every poster, calling each element's callback with whether it intersects. */
function watcher(rootMargin: string): (el: Element, onChange: (inside: boolean) => void) => () => void {
  const callbacks = new Map<Element, (inside: boolean) => void>();
  let observer: IntersectionObserver | null = null;
  return (el, onChange) => {
    observer ??= new IntersectionObserver((entries) => {
      for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
    }, { rootMargin });
    callbacks.set(el, onChange);
    observer.observe(el);
    return () => {
      callbacks.delete(el);
      observer?.unobserve(el);
    };
  };
}
const watchOnScreen = watcher('0px');
const watchInRange = watcher(SCROLL_RANGE);

/**
 * A poster or banner from the NAS, or the title's initials when it has none. Posters load through one queue that takes
 * those on screen first, then those within two screens of scrolling, then, on a fast connection, the rest, and
 * follows the scrolling. Its URL is made with the session token current when its turn comes, not when
 * it mounted; a failed load (a token that lapsed meanwhile, say) is tried once more with a fresh token before the
 * initials show.
 */
export function Poster(props: PosterProps): ReactElement {
  // a different poster is a fresh one: its own place in the queue, nothing left of the last one's state
  return <QueuedPoster key={`${props.artId ?? ''}:${props.size}`} {...props} />;
}

function QueuedPoster({ nas, artId, name, size, className }: PosterProps): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  const holder = useRef<HTMLSpanElement>(null);
  /** Ends this poster's turn in the queue: once the image loaded or failed for good. */
  const settle = useRef<(() => void) | null>(null);
  const finish = (): void => {
    settle.current?.();
    settle.current = null;
  };

  useEffect(() => {
    if (artId === null) return;
    let live = true;
    posters.setCeiling(loadsEveryPoster(nas.currentRoute(), (navigator as Navigator & { connection?: ConnectionInfo }).connection) ? 2 : 1);
    const el = holder.current;
    const observable = el !== null && typeof IntersectionObserver !== 'undefined';
    // without an observer to say, every poster counts as within scroll range
    const where = { onScreen: false, inRange: !observable };
    const priority = (): LoadPriority => (where.onScreen ? 0 : where.inRange ? 1 : 2);
    const ticket = posters.add(
      () =>
        new Promise<void>((resolve) => {
          if (!live) return resolve();
          settle.current = resolve;
          nas.artUrl(artId, size).then(
            (url) => {
              if (live) setSrc(url);
              else resolve();
            },
            () => {
              if (live) setFailed(true);
              resolve();
            },
          );
        }),
      priority(),
    );
    const unwatch = observable
      ? [
          watchOnScreen(el, (inside) => {
            where.onScreen = inside;
            ticket.setPriority(priority());
          }),
          watchInRange(el, (inside) => {
            where.inRange = inside;
            ticket.setPriority(priority());
          }),
        ]
      : [];
    return () => {
      live = false;
      for (const stop of unwatch) stop();
      ticket.cancel();
      finish();
    };
  }, [nas, artId, size]);

  const onError = (): void => {
    if (artId === null || src === null || retried.current) {
      setFailed(true);
      finish();
      return;
    }
    retried.current = true;
    nas.freshArtUrl(artId, size, src).then(setSrc, () => {
      setFailed(true);
      finish();
    });
  };

  if (artId === null || failed) {
    return (
      <span className={`${className} poster-placeholder`} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return src === null ? (
    <span ref={holder} className={className} aria-hidden="true" />
  ) : (
    <img className={className} src={src} alt="" decoding="async" onLoad={finish} onError={onError} />
  );
}
