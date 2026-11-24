import type { PlayerController, PlayerSnapshot, VisibilityLike } from './player-controller';

interface SentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', cb: () => void): void;
}

type ActionHandler = (details?: { seekOffset?: number; seekTime?: number }) => void;

/** The slice of `navigator` this class uses, injectable so Node tests need no browser. */
export interface NavigatorLike {
  readonly wakeLock?: { request(type: 'screen'): Promise<SentinelLike> };
  readonly mediaSession?: {
    metadata: unknown;
    setActionHandler(action: string, handler: ActionHandler | null): void;
    /** Whether the system shows the media as playing or paused. */
    playbackState?: 'none' | 'paused' | 'playing';
    /** Where the system's controls (lock screen, Picture in Picture) draw their position; Safari and Chrome have it. */
    setPositionState?(state?: { duration: number; position: number; playbackRate: number }): void;
  };
  readonly MediaMetadata?: new (init: { title: string; artist?: string }) => unknown;
}

type ControllerLike = Pick<PlayerController, 'togglePlay' | 'seekBy' | 'getSnapshot' | 'subscribe'> & Partial<Pick<PlayerController, 'seek'>>;

const SEEK_SECONDS = 10;
const ACTIONS = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'] as const;
/** How far (seconds) the system's own reckoning of the position may drift from the player's before it is told again. */
const POSITION_SLACK_S = 1;

function chapterNumber(s: PlayerSnapshot): number | null {
  let n: number | null = null;
  s.chapters.forEach((c, i) => {
    if (c.startUs <= s.timeUs) n = i + 1;
  });
  return n ?? (s.chapters.length > 0 ? 1 : null);
}

/**
 * Screen wake lock while playing, and Media Session metadata, position and transport handlers (play, pause, seek by 10 s,
 * and a seek to a time, from a system scrubber).
 * Main thread only; it follows a `PlayerController` through its store interface and has no worker of its own.
 * @example ../../examples/platform-session.ts#construct
 */
export class PlatformSession {
  private sentinel: SentinelLike | null = null;
  private pending = false;
  private disposed = false;
  private metaKey: string | null = null;
  private readonly unsubscribe: () => void;
  /** The position last told to the Media Session: playlist, length, position (s), when (ms), whether it ran. */
  private told: { readonly key: string; readonly positionS: number; readonly atMs: number; readonly playing: boolean } | null = null;

  /** `nowMs` (performance.now by default) times the position told to the Media Session. */
  constructor(
    private readonly nav: NavigatorLike,
    private readonly controller: ControllerLike,
    private readonly visibility: VisibilityLike = documentVisibility(),
    private readonly nowMs: () => number = () => performance.now(),
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

  /**
   * Stops following the controller: releases the wake lock and removes the Media Session handlers.
   * @example ../../examples/platform-session.ts#dispose
   */
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
    set('seekto', (d) => {
      if (d?.seekTime !== undefined && Number.isFinite(d.seekTime)) this.controller.seek?.(Math.max(0, d.seekTime) * 1_000_000);
    });
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
    this.syncPosition(s);
  }

  /**
   * Tells the Media Session the playlist's length and position when they change beyond what it reckons itself (it
   * runs the position on at the playback rate while playing): a new playlist, a pause or play, or a seek.
   */
  private syncPosition(s: PlayerSnapshot): void {
    const ms = this.nav.mediaSession;
    if (!ms?.setPositionState || s.durationUs <= 0) return;
    const duration = s.durationUs / 1e6;
    const positionS = Math.min(Math.max(0, s.timeUs / 1e6), duration);
    const playing = s.engineState === 'playing';
    const key = `${s.currentPlaylistId ?? ''}\u0000${duration}`;
    const now = this.nowMs();
    const t = this.told;
    if (t && t.key === key && t.playing === playing) {
      const reckoned = t.positionS + (t.playing ? (now - t.atMs) / 1000 : 0);
      if (Math.abs(reckoned - positionS) <= POSITION_SLACK_S) return;
    }
    this.told = { key, positionS, atMs: now, playing };
    try {
      // a paused position is told with rate 1 too (0 is refused); playbackState says it holds
      if ('playbackState' in ms) ms.playbackState = playing ? 'playing' : 'paused';
      ms.setPositionState({ duration, position: positionS, playbackRate: 1 });
    } catch {
      // a position the browser rejects: the system keeps its own
    }
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
