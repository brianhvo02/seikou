// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { HelperApi } from './api';

/** AniList's episode titles asked so far, per client and show, so the page and step 2 ask only once. */
const asked = new WeakMap<HelperApi, Map<number, Promise<Readonly<Record<number, string>>>>>();

/**
 * AniList's episode titles for a show, asked of the backend once per client and show and shared by every caller. A
 * failed answer is forgotten, so a later caller asks again.
 */
export function episodeTitlesOnce(api: HelperApi, alId: number): Promise<Readonly<Record<number, string>>> {
  const byShow = asked.get(api) ?? new Map<number, Promise<Readonly<Record<number, string>>>>();
  asked.set(api, byShow);
  const known = byShow.get(alId);
  if (known) return known;
  const pending = api.episodeTitles(alId);
  byShow.set(alId, pending);
  pending.catch(() => byShow.delete(alId));
  return pending;
}

/**
 * The episode titles of the show `alId` (keyed by episode number), or null while they are on their way, when the
 * request failed, or when there is no show. Asks through `episodeTitlesOnce`, so several components share one request.
 */
export function useEpisodeTitles(api: HelperApi, alId: number | null): Readonly<Record<number, string>> | null {
  const [answer, setAnswer] = useState<{ readonly alId: number; readonly titles: Readonly<Record<number, string>> } | null>(null);
  useEffect(() => {
    if (alId === null) return;
    let live = true;
    episodeTitlesOnce(api, alId).then(
      (titles) => {
        if (live) setAnswer({ alId, titles });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, alId]);
  return answer !== null && answer.alId === alId ? answer.titles : null;
}
