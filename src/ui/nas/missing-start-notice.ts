import { openFailed } from './library-model';

/** Shown when an episode's playlist isn't on the disc it was filed on. */
export const EPISODE_MISSING_NOTICE = "This episode isn't on this disc; it opened normally.";

/** What `noticeMissingStart` needs of the `PlayerController`. */
export interface StartingController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly startFailed: 'no-playlist' | 'past-end' | null; readonly engineState: string; readonly error: unknown };
  /** Bumped by every open and close, so a wait begun for one open never acts on another. */
  readonly discOpens: number;
  menuCall(): void;
  showNotice(code: string, message: string): void;
}

/**
 * The disc is opening at a playlist (an open with a `start`). If the disc hasn't that playlist the engine plays nothing
 * and stays idle (startFailed 'no-playlist'): this says so and opens the disc's top menu, the nearest to opening it
 * normally (a disc without menus is left at its playlist list). A time past the playlist's end needs nothing: the
 * engine plays it from the beginning.
 *
 * A plain subscription rather than an effect: the pre-flight unmounts as the disc's playlists arrive, before the
 * engine reports the start. It is scoped to that one open: it lets go once it has acted, when the open fails, when
 * another disc is opened or this one closed, and when the returned function is called (the pre-flight abandoning its
 * launch).
 */
export function noticeMissingStart(controller: StartingController): () => void {
  const open = controller.discOpens;
  let unsubscribe: (() => void) | null = null;
  const release = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  unsubscribe = controller.subscribe(() => {
    const snapshot = controller.getSnapshot();
    if (controller.discOpens !== open || openFailed(snapshot)) {
      release();
      return;
    }
    if (snapshot.startFailed === null) return;
    release();
    if (snapshot.startFailed !== 'no-playlist') return;
    controller.showNotice('episode-missing', EPISODE_MISSING_NOTICE);
    controller.menuCall();
  });
  return release;
}
