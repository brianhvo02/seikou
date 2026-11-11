import { useSyncExternalStore } from 'react';
import { nasRoutePath, parseNasRoute, type NasRoute } from './nas-route';

/** The parts of `window` that `NasHistory` uses, so tests can substitute them. */
export interface HistoryLike {
  readonly location: { readonly href: string };
  readonly history: {
    readonly state: unknown;
    pushState(s: unknown, u: '', url: string): void;
    replaceState(s: unknown, u: '', url: string): void;
    back(): void;
  };
  addEventListener(type: 'popstate', l: () => void): void;
  removeEventListener(type: 'popstate', l: () => void): void;
}

type Move = 'push' | 'pop' | 'replace' | 'load';

function pathOf(route: NasRoute | null): string {
  return route === null ? '/' : nasRoutePath(route);
}

/** The one place that pushes, replaces and listens for popstate. */
export class NasHistory {
  private readonly listeners = new Set<() => void>();
  private move: Move = 'load';

  constructor(private readonly win: HistoryLike) {}

  route(): NasRoute | null {
    return parseNasRoute(new URL(this.win.location.href));
  }

  /** How many app entries are behind this one (0 for a cold load or a link); kept in history.state as { nasDepth }. */
  depth(): number {
    const s = this.win.history.state as { nasDepth?: unknown } | null;
    return typeof s?.nasDepth === 'number' ? s.nasDepth : 0;
  }

  push(route: NasRoute | null): void {
    this.pushUrl(pathOf(route), false);
  }

  /** Pushes a path outside the NAS routes (the help pages), hash included. */
  pushPath(path: string): void {
    this.pushUrl(path, true);
  }

  private pushUrl(url: string, withHash: boolean): void {
    if (this.isCurrent(url, withHash)) return;
    if (!this.attempt(() => this.win.history.pushState({ ...this.stateObject(), nasDepth: this.depth() + 1 }, '', url))) return;
    this.changed('push');
  }

  replace(route: NasRoute | null): void {
    const url = pathOf(route);
    if (this.isCurrent(url)) return;
    if (!this.attempt(() => this.win.history.replaceState({ ...this.stateObject(), nasDepth: this.depth() }, '', url))) return;
    this.changed('replace');
  }

  /** history.back() when depth() > 0, else replace(fallback). */
  back(fallback: NasRoute | null): void {
    if (this.depth() > 0) this.win.history.back();
    else this.replace(fallback);
  }

  /** The last navigation's direction, for focus. */
  lastMove(): Move {
    return this.move;
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) this.win.addEventListener('popstate', this.onPop);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.win.removeEventListener('popstate', this.onPop);
    };
  };

  getSnapshot = (): string => this.win.location.href;

  private readonly onPop = (): void => this.changed('pop');

  private warned = false;

  /** Safari throws SecurityError past about 100 history changes in 30 s: a refused write is dropped. */
  private attempt(write: () => void): boolean {
    try {
      write();
      return true;
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn('History write refused', e);
      }
      return false;
    }
  }

  private changed(move: Move): void {
    this.move = move;
    for (const l of [...this.listeners]) l();
  }

  private stateObject(): Record<string, unknown> {
    const s = this.win.history.state;
    return typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
  }

  private isCurrent(url: string, withHash = false): boolean {
    const cur = new URL(this.win.location.href);
    const next = new URL(url, cur);
    return next.pathname === cur.pathname && next.search === cur.search && (!withHash || next.hash === cur.hash);
  }
}

/** The current NAS route, read with React's external store hook so the component renders again when the route changes; null when the address is not under `/nas`. */
export function useNasRoute(h: NasHistory): NasRoute | null {
  useSyncExternalStore(h.subscribe, h.getSnapshot);
  return h.route();
}

let shared: NasHistory | null = null;

/** The shared instance over window. */
export function getNasHistory(): NasHistory {
  shared ??= new NasHistory(window);
  return shared;
}
