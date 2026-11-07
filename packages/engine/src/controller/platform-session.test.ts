import { describe, expect, it, vi } from 'vitest';
import { INITIAL_SNAPSHOT, type PlayerSnapshot, type VisibilityLike } from './player-controller';
import { PlatformSession, type NavigatorLike } from './platform-session';

function setup(opts: { wakeLock?: boolean; mediaSession?: boolean; rejectLock?: boolean; deferLock?: boolean } = {}) {
  let snap: PlayerSnapshot = INITIAL_SNAPSHOT;
  const listeners = new Set<() => void>();
  const controller = {
    togglePlay: vi.fn(),
    seekBy: vi.fn(),
    getSnapshot: () => snap,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const set = (p: Partial<PlayerSnapshot>): void => {
    snap = { ...snap, ...p };
    listeners.forEach((l) => l());
  };
  const release = vi.fn(() => Promise.resolve());
  const releaseListeners: Array<() => void> = [];
  const sentinel = { release, addEventListener: (_t: 'release', cb: () => void) => void releaseListeners.push(cb) };
  let deferred: ((v: typeof sentinel) => void) | null = null;
  const request = vi.fn(() =>
    opts.rejectLock
      ? Promise.reject(new Error('no'))
      : opts.deferLock
        ? new Promise<typeof sentinel>((r) => void (deferred = r))
        : Promise.resolve(sentinel),
  );
  const handlers = new Map<string, ((d?: { seekOffset?: number }) => void) | null>();
  const mediaSession = {
    metadata: null as unknown,
    setActionHandler: (a: string, h: ((d?: { seekOffset?: number }) => void) | null) => void handlers.set(a, h),
  };
  class Meta {
    constructor(readonly init: { title: string; artist?: string }) {}
  }
  const nav: NavigatorLike = {
    ...(opts.wakeLock === false ? {} : { wakeLock: { request } }),
    ...(opts.mediaSession === false ? {} : { mediaSession, MediaMetadata: Meta }),
  };
  let hidden = false;
  let onVis = (): void => {};
  const visibility: VisibilityLike = { hidden: () => hidden, onChange: (cb) => void (onVis = cb) };
  const session = new PlatformSession(nav, controller, visibility);
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return { resolveLock: () => deferred?.(sentinel), fireRelease: () => releaseListeners.forEach((l) => l()), session, controller, set, request, release, handlers, mediaSession, flush, setHidden: (h: boolean) => { hidden = h; onVis(); } };
}

describe('PlatformSession', () => {
  it('requests the wake lock while playing and releases it on pause', async () => {
    const t = setup();
    t.set({ engineState: 'playing' });
    await t.flush();
    expect(t.request).toHaveBeenCalledWith('screen');
    t.set({ engineState: 'paused' });
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('holds the wake lock through buffering', async () => {
    const t = setup({ deferLock: true });
    t.set({ engineState: 'buffering' });
    expect(t.request).toHaveBeenCalledWith('screen');
    t.resolveLock(); // granted while still buffering: kept, not released
    await t.flush();
    expect(t.release).not.toHaveBeenCalled();
    t.set({ engineState: 'playing' });
    t.set({ engineState: 'buffering' });
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.release).not.toHaveBeenCalled();
    t.set({ engineState: 'paused' });
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('does not request twice while pending or held', async () => {
    const t = setup();
    t.set({ engineState: 'playing' });
    t.set({ timeUs: 5 });
    await t.flush();
    t.set({ timeUs: 6 });
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('re-requests on return to visible while playing', async () => {
    const t = setup();
    t.set({ engineState: 'playing' });
    await t.flush();
    // The browser drops the lock on hide; the sentinel is released by the platform.
    t.setHidden(true);
    expect(t.request).toHaveBeenCalledTimes(1);
    t.set({ engineState: 'paused' });
    t.set({ engineState: 'playing' });
    expect(t.request).toHaveBeenCalledTimes(1); // hidden: no request
    t.setHidden(false);
    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it('re-requests after the platform releases the lock on hide, with no pause', async () => {
    const t = setup();
    t.set({ engineState: 'playing' });
    await t.flush();
    t.setHidden(true);
    t.fireRelease();
    t.setHidden(false);
    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it('releases a lock that resolves after pause', async () => {
    const t = setup({ deferLock: true });
    t.set({ engineState: 'playing' });
    t.set({ engineState: 'paused' });
    t.resolveLock();
    await t.flush();
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('releases a lock that resolves after dispose', async () => {
    const t = setup({ deferLock: true });
    t.set({ engineState: 'playing' });
    t.session.dispose();
    t.resolveLock();
    await t.flush();
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected request', async () => {
    const t = setup({ rejectLock: true });
    t.set({ engineState: 'playing' });
    await t.flush();
    t.set({ timeUs: 1 });
    await t.flush();
    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it('seek handlers use 10 s by default and seekOffset when given', () => {
    const t = setup();
    t.handlers.get('seekforward')!();
    expect(t.controller.seekBy).toHaveBeenLastCalledWith(10_000_000);
    t.handlers.get('seekbackward')!({ seekOffset: 30 });
    expect(t.controller.seekBy).toHaveBeenLastCalledWith(-30_000_000);
  });

  it('play and pause toggle only when the state differs', () => {
    const t = setup();
    t.handlers.get('pause')!();
    expect(t.controller.togglePlay).not.toHaveBeenCalled();
    t.handlers.get('play')!();
    expect(t.controller.togglePlay).toHaveBeenCalledTimes(1);
    t.set({ engineState: 'playing' });
    t.handlers.get('play')!();
    expect(t.controller.togglePlay).toHaveBeenCalledTimes(1);
    t.handlers.get('pause')!();
    expect(t.controller.togglePlay).toHaveBeenCalledTimes(2);
  });

  it('updates metadata only when title or chapter changes', () => {
    const t = setup();
    t.set({ currentPlaylistId: '00800', chapters: [{ index: 0, startUs: 0 }, { index: 1, startUs: 100 }], timeUs: 10 });
    const first = t.mediaSession.metadata as { init: { title: string; artist?: string } };
    expect(first.init).toEqual({ title: '00800', artist: 'Chapter 1' });
    t.set({ timeUs: 50 });
    expect(t.mediaSession.metadata).toBe(first);
    t.set({ timeUs: 150 });
    expect((t.mediaSession.metadata as typeof first).init.artist).toBe('Chapter 2');
  });

  it('omits the artist without chapters and falls back to Blu-ray', () => {
    const t = setup();
    t.set({ timeUs: 1 });
    expect((t.mediaSession.metadata as { init: unknown }).init).toEqual({ title: 'Blu-ray' });
  });

  it('dispose releases the lock, nulls handlers and unsubscribes', async () => {
    const t = setup();
    t.set({ engineState: 'playing' });
    await t.flush();
    t.session.dispose();
    expect(t.release).toHaveBeenCalled();
    for (const a of ['play', 'pause', 'seekbackward', 'seekforward']) expect(t.handlers.get(a)).toBeNull();
    t.set({ engineState: 'paused' });
    t.set({ engineState: 'playing' });
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('does nothing and does not throw without wakeLock or mediaSession', () => {
    const t = setup({ wakeLock: false, mediaSession: false });
    expect(() => {
      t.set({ engineState: 'playing' });
      t.session.dispose();
    }).not.toThrow();
  });
});
