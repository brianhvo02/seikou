// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HelperApi } from '../api';
import type { EpisodeInfo, SessionInfo } from '../api-types';
import { firstChapters, sameChapterNames, withChapterNames } from './metadata-model';

/** The session's episode info as the page holds it, and how to save chapter names into it. */
export interface EpisodeInfoState {
  /** The info as loaded or last saved; null when none is saved (or before it has loaded). */
  readonly info: EpisodeInfo | null;
  /** `loading` until the backend answers, `failed` when it could not be loaded (chapter names cannot be changed then). */
  readonly status: 'loading' | 'ready' | 'failed';
  /** The message of the last chapter save that failed, null once one succeeds. */
  readonly saveError: string | null;
  /**
   * Saves episode `episode`'s chapter fields (field `i` is the episode's first playlist chapter, from the session's
   * episode list, plus `i`; `withChapterNames`), keeping the AniList choices. Saves run one after another, each from
   * the info the last one stored; one that changes nothing is not sent. Does nothing until the info is ready.
   */
  readonly saveChapterNames: (episode: number, fields: readonly string[]) => void;
}

/**
 * Loads the episode info of the session's disc and playlist once the session is known and keeps the chapter-name
 * saves. It lives with the page, not the Details sheet, so a save that fails after the sheet closed still reports.
 */
export function useEpisodeInfo(api: HelperApi, session: SessionInfo | null): EpisodeInfoState {
  const [info, setInfo] = useState<EpisodeInfo | null>(null);
  const [status, setStatus] = useState<EpisodeInfoState['status']>('loading');
  const [saveError, setSaveError] = useState<string | null>(null);
  // the latest stored info, which every save starts from
  const latest = useRef<EpisodeInfo | null>(null);
  const ready = useRef(false);
  const saving = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (session === null) return;
    let live = true;
    ready.current = false;
    setStatus('loading');
    api.episodeInfo(session.discKey, session.playlistId).then(
      (loaded) => {
        if (!live) return;
        latest.current = loaded;
        ready.current = true;
        setInfo(loaded);
        setStatus('ready');
      },
      () => {
        if (live) setStatus('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [api, session]);

  const saveChapterNames = useCallback(
    (episode: number, fields: readonly string[]) => {
      const first = session === null ? undefined : firstChapters(session.episodeSpec)[episode - 1];
      if (session === null || first === undefined || !ready.current) return;
      saving.current = saving.current.then(async () => {
        const current = latest.current?.chapterNames ?? {};
        const chapterNames = withChapterNames(current, first, fields);
        if (sameChapterNames(chapterNames, current)) return;
        try {
          const saved = await api.saveEpisodeInfo(session.discKey, session.playlistId, { chapterNames, anilist: latest.current?.anilist ?? {} });
          latest.current = saved;
          setInfo(saved);
          setSaveError(null);
        } catch (e) {
          setSaveError(e instanceof Error ? e.message : String(e));
        }
      });
    },
    [api, session],
  );

  return { info, status, saveError, saveChapterNames };
}
