// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { EncodeShow } from '@seikou/nas/nas-api';
import { durationLabel, episodeMark, INDEXING_COPY, indexingRetryMs, showContaining, showGroups, untilIndexed, type EncodeProgress } from './encodes-model';
import type { NasClient } from './nas-client';
import type { NasHistory } from './nas-history';
import type { NasRoute } from './nas-route';
import { NasNotFound } from './NasNotFound';
import { Poster } from './Poster';
import { EpisodeRow } from './SeasonScreen';
import { formatTime } from '../format';
import { nameLang } from '../name-lang';

const ENCODES: NasRoute = { kind: 'encodes', q: '' };
/** How many shows a stale show id is looked for among (one request each), at most. */
const RESOLVE_LIMIT = 60;

interface EncodeShowScreenProps {
  readonly nas: NasClient;
  readonly history: NasHistory;
  readonly showId: string;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A show whose id answered 404: its AniList chain loaded and it is rooted at another entry now (docs/known-issues.md).
 * The show list is read again and the show whose seasons hold the old id is the one, from the list's `anilistIds` (or,
 * from a NAS without them, by fetching its shows in turn); null for none. It stops asking once `live()` is false (the
 * screen left).
 */
async function findMoved(nas: Pick<NasClient, 'encodeShow' | 'encodeShows'>, showId: string, live: () => boolean): Promise<string | null> {
  const anilistId = /^\d+$/.test(showId) ? Number(showId) : undefined;
  if (anilistId === undefined) return null;
  const { shows } = await nas.encodeShows();
  // the list names each show's AniList entries; a NAS from before them leaves them out, and its shows are walked
  const ids = (s: (typeof shows)[number]): readonly number[] | undefined => s.anilistIds as readonly number[] | undefined;
  if (shows.some((s) => ids(s) !== undefined)) return shows.find((s) => ids(s)?.includes(anilistId))?.id ?? null;
  for (const s of shows.slice(0, RESOLVE_LIMIT)) {
    if (!live()) return null;
    const detail = await nas.encodeShow(s.id);
    if (detail && showContaining([detail], { anilistId }) !== null) return detail.id;
  }
  return null;
}

/** An encodes show: its seasons in order, then its films and others, each episode with its progress and a resume link. */
export function EncodeShowScreen({ nas, history, showId }: EncodeShowScreenProps): ReactElement {
  const [show, setShow] = useState<EncodeShow | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<EncodeProgress | null>(null);
  /** The show answered 404 again after it was looked up once on this visit: the not-found screen, not another lookup. */
  const [missing, setMissing] = useState(false);
  const resolved = useRef(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setShow(null);
    setError(null);
    setProgress(null);
    setMissing(false);
    const load = (): void => {
      nas.encodeShow(showId).then(
        async (found) => {
          if (!live) return;
          setIndexing(false);
          if (found) {
            setShow(found);
            return;
          }
          if (resolved.current) {
            setMissing(true);
            return;
          }
          resolved.current = true;
          const moved = await findMoved(nas, showId, () => live).catch(() => null);
          if (live) history.replace(moved !== null && moved !== showId ? { kind: 'encodeShow', showId: moved } : ENCODES);
        },
        (err: unknown) => {
          if (!live) return;
          const wait = indexingRetryMs(err);
          if (wait === null) return setError(message(err));
          setIndexing(true);
          timer = setTimeout(load, wait);
        },
      );
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [nas, history, showId]);

  const loadedId = show?.id ?? null;
  useEffect(() => {
    if (loadedId === null) return;
    let live = true;
    // no progress (none yet, or the NAS can't say) leaves the rows without marks; while it indexes it is asked again
    const asking = untilIndexed(() => nas.titleProgress(loadedId, { library: 'encodes' }));
    asking.result.then(
      (p) => live && setProgress(p),
      () => {},
    );
    return () => {
      live = false;
      asking.cancel();
    };
  }, [nas, loadedId]);

  const back = (): void => history.back(ENCODES);
  const play = (encodeId: string, resumeUs: number | null): void =>
    history.push(resumeUs === null ? { kind: 'encodePlay', encodeId, timeS: null, resume: false } : { kind: 'encodePlay', encodeId, timeS: Math.floor(resumeUs / 1e6), resume: true });

  if (missing) return <NasNotFound reason="missing" onLeave={() => history.replace(ENCODES)} />;

  if (!show) {
    return (
      <section className="titles" data-testid="encode-show">
        <button type="button" className="title-back" aria-label="Back to Encodes" onClick={back}>
          <span aria-hidden="true">‹</span>
        </button>
        {error ? (
          <div className="error-banner" role="alert" data-testid="nas-error">
            {error}
          </div>
        ) : (
          <p className="status">{indexing ? INDEXING_COPY : 'Loading…'}</p>
        )}
      </section>
    );
  }

  return (
    <section className="titles encode-show" data-testid="encode-show">
      <header className="season-head encode-show-head">
        <button type="button" className="title-back" aria-label="Back to Encodes" onClick={back}>
          <span aria-hidden="true">‹</span>
        </button>
        <Poster nas={nas} artId={show.poster} name={show.name} size="small" className="encode-show-poster" />
        <div className="season-head-text">
          <span className="title-muted">Encodes</span>
          <h2 tabIndex={-1} data-focus-heading="" lang={nameLang(show.name)}>
            {show.name}
          </h2>
        </div>
      </header>
      {showGroups(show).map((g) => (
        <section key={g.key} className="encode-season" data-testid="encode-season" data-anilist-id={g.key} data-kind={g.kind}>
          <div className="encode-season-head">
            <h3 className="title-section" lang={nameLang(g.heading)}>
              {g.heading}
            </h3>
            {g.sub && (
              <span className="title-muted" lang={nameLang(g.sub)}>
                {g.sub}
              </span>
            )}
          </div>
          <ul className="title-list">
            {g.season.episodes.map((e) => {
              const mark = episodeMark(progress, e.id);
              return (
                <li key={e.id} className="encode-episode">
                  <EpisodeRow number={e.episode} name={e.title} meta={durationLabel(e.durationMs) ?? ''} percent={mark?.percent ?? null} data={{ 'encode-id': e.id }} onClick={() => play(e.id, null)}>
                    {mark?.finished && (
                      <span className="episode-watched" data-testid="episode-watched">
                        Watched
                      </span>
                    )}
                  </EpisodeRow>
                  {mark?.resumeUs != null && (
                    <button type="button" className="title-link episode-resume" data-testid="episode-resume" onClick={() => play(e.id, mark.resumeUs)}>
                      Resume at {formatTime(mark.resumeUs)}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
