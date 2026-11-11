// SPDX-License-Identifier: LGPL-3.0-or-later
// Keep the screen awake while a disc plays and give the system's media controls play, pause and seek.
import { PlatformSession, type NavigatorLike, type PlayerController, type PlayerSnapshot } from '@seikou/engine';

type Store = Pick<PlayerController, 'togglePlay' | 'seekBy' | 'getSnapshot' | 'subscribe'>;

export default async function example(): Promise<void> {
  // In a page these are `navigator.wakeLock`, `navigator.mediaSession` and `MediaMetadata`, and the store is the
  // PlayerController; here a stand-in for each records what the session does.
  const locks: string[] = [];
  const handlers = new Map<string, ((details?: { seekOffset?: number }) => void) | null>();
  const nav: NavigatorLike = {
    wakeLock: { request: async (type) => (locks.push(type), { release: async () => void locks.pop() }) },
    mediaSession: { metadata: null, setActionHandler: (action, handler) => void handlers.set(action, handler) },
    MediaMetadata: class {
      constructor(readonly init: { title: string; artist?: string }) {}
    },
  };
  let snapshot = { engineState: 'paused', currentPlaylistId: '00000', timeUs: 3_000_000, chapters: [{ startUs: 0 }, { startUs: 2_000_000 }] } as unknown as PlayerSnapshot;
  const listeners = new Set<() => void>();
  const seeks: number[] = [];
  const set = (engineState: string): void => {
    snapshot = { ...snapshot, engineState } as PlayerSnapshot;
    for (const l of listeners) l();
  };
  const controller: Store = {
    getSnapshot: () => snapshot,
    subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
    togglePlay: () => set(snapshot.engineState === 'playing' ? 'paused' : 'playing'),
    seekBy: (us) => void seeks.push(us),
  };
  const visibility = { hidden: () => false, onChange: () => {} };

  // #region construct
  // In a page: new PlatformSession({ wakeLock: navigator.wakeLock, mediaSession: navigator.mediaSession, MediaMetadata }, controller)
  const session = new PlatformSession(nav, controller, visibility);
  // #endregion

  handlers.get('play')?.(); // the system's play button
  await Promise.resolve();
  handlers.get('seekforward')?.({ seekOffset: 30 });
  const meta = nav.mediaSession!.metadata as { init: { title: string; artist?: string } };
  console.log('lock:', locks, 'now playing:', meta.init, 'seeks:', seeks);
  if (snapshot.engineState !== 'playing' || !locks.includes('screen')) throw new Error('play did not take the wake lock');
  if (meta.init.artist !== 'Chapter 2' || seeks[0] !== 30_000_000) throw new Error('unexpected media session');

  // #region dispose
  session.dispose(); // the player screen closed: the lock goes and the media handlers are removed
  // #endregion
  await Promise.resolve();
  if (locks.length !== 0 || handlers.get('play') !== null) throw new Error('dispose left the session in place');
}
