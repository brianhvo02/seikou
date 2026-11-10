// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpisodeTitle } from '../api-types';
import type { AppApi } from './app-api';
import { toInfo } from './episode-info-model';

/** The Episodes page's chapter names (as typed, untrimmed) and episode titles, keyed by playlist chapter. */
export interface InfoDraft {
  readonly chapterNames: Readonly<Record<string, string>>;
  readonly titles: Readonly<Record<string, EpisodeTitle>>;
}

/** Where the saving stands: nothing changed yet, a change waiting or being sent, the last one stored, or the last one refused. */
export type SaveState = { readonly kind: 'idle' | 'saving' | 'saved' } | { readonly kind: 'failed'; readonly message: string };

/** The draft and its saving, as `useInfoDraft` gives them. */
export interface InfoDraftState {
  /** `loading` until the backend answers; `failed` (with `loadError`) when the saved info could not be read, and nothing can be changed then. */
  readonly status: 'loading' | 'ready' | 'failed';
  readonly loadError: string | null;
  /** The draft; empty until loaded. */
  readonly draft: InfoDraft;
  readonly save: SaveState;
  /** Changes the draft and saves it 500 ms after the last change; does nothing until the info is ready. */
  readonly update: (change: (draft: InfoDraft) => InfoDraft) => void;
  /** Sends the draft again after a failed save. */
  readonly retry: () => void;
}

/** How long the page waits after a change before it saves. */
export const SAVE_DELAY_MS = 500;

const EMPTY: InfoDraft = { chapterNames: {}, titles: {} };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Loads a disc playlist's episode info and saves the page's changes to it: debounced by `SAVE_DELAY_MS`, one save at
 * a time, each sending the whole draft as it is when it starts, so the last change wins. The draft stays the page's
 * own (an answer never replaces it), so a failed save keeps every edit for Retry. A change still waiting when the
 * page closes is sent at once.
 */
export function useInfoDraft(api: AppApi, discKey: string, playlistId: string): InfoDraftState {
  const [status, setStatus] = useState<InfoDraftState['status']>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<InfoDraft>(EMPTY);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const latest = useRef<InfoDraft>(EMPTY);
  const ready = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const again = useRef(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    ready.current = false;
    setStatus('loading');
    let current = true;
    Promise.resolve()
      .then(() => api.episodeInfo(discKey, playlistId))
      .then(
        (info) => {
          if (!current) return;
          const loaded: InfoDraft = info === null ? EMPTY : { chapterNames: info.chapterNames, titles: info.titles };
          latest.current = loaded;
          ready.current = true;
          setDraft(loaded);
          setStatus('ready');
        },
        (e: unknown) => {
          if (!current) return;
          setLoadError(messageOf(e));
          setStatus('failed');
        },
      );
    return () => {
      current = false;
    };
  }, [api, discKey, playlistId]);

  const send = useCallback((): void => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    again.current = false;
    const d = latest.current;
    Promise.resolve()
      .then(() => api.saveEpisodeInfo(discKey, playlistId, toInfo([], d.chapterNames, d.titles)))
      .then(
        () => {
          if (live.current && !again.current && timer.current === undefined) setSave({ kind: 'saved' });
        },
        (e: unknown) => {
          if (live.current && !again.current && timer.current === undefined) setSave({ kind: 'failed', message: messageOf(e) });
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (again.current) send();
      });
  }, [api, discKey, playlistId]);

  // a change still waiting is sent when the page goes
  useEffect(
    () => () => {
      live.current = false;
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
        send();
      }
    },
    [send],
  );

  const update = useCallback(
    (change: (draft: InfoDraft) => InfoDraft): void => {
      if (!ready.current) return;
      latest.current = change(latest.current);
      setDraft(latest.current);
      setSave({ kind: 'saving' });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        send();
      }, SAVE_DELAY_MS);
    },
    [send],
  );

  const retry = useCallback((): void => {
    setSave({ kind: 'saving' });
    send();
  }, [send]);

  return { status, loadError, draft, save, update, retry };
}
