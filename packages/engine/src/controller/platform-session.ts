import type { PlayerController, PlayerSnapshot, VisibilityLike } from './player-controller';

interface SentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', cb: () => void): void;
}

type ActionHandler = (details?: { seekOffset?: number }) => void;

/** The slice of `navigator` this class uses, injectable so Node tests need no browser. */
export interface NavigatorLike {
  readonly wakeLock?: { request(type: 'screen'): Promise<SentinelLike> };
  readonly mediaSession?: {
    metadata: unknown;
    setActionHandler(action: string, handler: ActionHandler | null): void;
  };
  readonly MediaMetadata?: new (init: { title: string; artist?: string }) => unknown;
}

type ControllerLike = Pick<PlayerController, 'togglePlay' | 'seekBy' | 'getSnapshot' | 'subscribe'>;

const SEEK_SECONDS = 10;
const ACTIONS = ['play', 'pause', 'seekbackward', 'seekforward'] as const;

function chapterNumber(s: PlayerSnapshot): number | null {
  let n: number | null = null;
  s.chapters.forEach((c, i) => {
    if (c.startUs <= s.timeUs) n = i + 1;
  });
  return n ?? (s.chapters.length > 0 ? 1 : null);
}

/** Screen wake lock while playing, and Media Session metadata and transport handlers. */
export class PlatformSession {
  private sentinel: SentinelLike | null = null;
  private pending = false;
  private disposed = false;
  private metaKey: string | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly nav: NavigatorLike,
    private readonly controller: ControllerLike,
    private readonly visibility: VisibilityLike = documentVisibility(),
  ) {
    this.installHandlers();
    this.unsubscribe = controller.subscribe(() => this.sync());
    visibility.onChange(() => {
      // The platform releases the lock when the page hides.
      if (visibility.hidden()) this.sentinel = null;
      this.sync();
    });
    this.sync();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.releaseLock();
    const ms = this.nav.mediaSession;
    if (ms) {
      for (const a of ACTIONS) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          // Unsupported action in this browser.
        }
      }
    }
  }

  private installHandlers(): void {
    const ms = this.nav.mediaSession;
    if (!ms) return;
    const set = (action: string, h: ActionHandler): void => {
      try {
        ms.setActionHandler(action, h);
      } catch {
        // Unsupported action in this browser.
      }
    };
    set('play', () => {
      if (!this.playing()) this.controller.togglePlay();
    });
    set('pause', () => {
      if (this.playing()) this.controller.togglePlay();
    });
    set('seekbackward', (d) => this.controller.seekBy(-(d?.seekOffset ?? SEEK_SECONDS) * 1_000_000));
    set('seekforward', (d) => this.controller.seekBy((d?.seekOffset ?? SEEK_SECONDS) * 1_000_000));
  }

  /** Playing or buffering: the wake lock and the Media Session both treat buffering as playing. */
  private playing(): boolean {
    const st = this.controller.getSnapshot().engineState;
    return st === 'playing' || st === 'buffering';
  }

  private sync(): void {
    if (this.disposed) return;
    const s = this.controller.getSnapshot();
    if (this.playing()) {
      if (!this.visibility.hidden()) this.requestLock();
    } else {
      this.releaseLock();
    }
    this.syncMetadata(s);
  }

  private requestLock(): void {
    const wl = this.nav.wakeLock;
    if (!wl || this.sentinel || this.pending) return;
    this.pending = true;
    let p: Promise<SentinelLike>;
    try {
      p = wl.request('screen');
    } catch {
      this.pending = false;
      return;
    }
    p.then(
      (sentinel) => {
        this.pending = false;
        if (this.disposed || !this.playing()) {
          sentinel.release().catch(() => {});
          return;
        }
        this.sentinel = sentinel;
        sentinel.addEventListener?.('release', () => {
          if (this.sentinel === sentinel) this.sentinel = null;
        });
      },
      () => {
        this.pending = false; // No user activation or battery saver: stay silent.
      },
    );
  }

  private releaseLock(): void {
    const s = this.sentinel;
    this.sentinel = null;
    s?.release().catch(() => {});
  }

  private syncMetadata(s: PlayerSnapshot): void {
    const ms = this.nav.mediaSession;
    const Meta = this.nav.MediaMetadata;
    if (!ms || !Meta) return;
    const title = s.currentPlaylistId ?? 'Blu-ray';
    const n = chapterNumber(s);
    const key = `${title}\u0000${n ?? ''}`;
    if (key === this.metaKey) return;
    this.metaKey = key;
    try {
      ms.metadata = new Meta(n === null ? { title } : { title, artist: `Chapter ${n}` });
    } catch {
      // Metadata unsupported.
    }
  }
}

function documentVisibility(): VisibilityLike {
  return {
    hidden: () => typeof document !== 'undefined' && document.hidden,
    onChange: (cb) => {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', cb);
    },
  };
}
