// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState, type ReactElement } from 'react';
import type { EncodeShow } from '@seikou/nas/nas-api';
import { durationLabel, episodeMark, INDEXING_COPY, indexingRetryMs, showContaining, showGroups, type EncodeProgress } from './encodes-model';
import type { NasClient } from './nas-client';
import type { NasHistory } from './nas-history';
import type { NasRoute } from './nas-route';
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
 * The show list is read again and the show whose seasons hold the old id is the one; null for none.
 */
async function findMoved(nas: Pick<NasClient, 'encodeShow' | 'encodeShows'>, showId: string): Promise<string | null> {
  const anilistId = /^\d+$/.test(showId) ? Number(showId) : undefined;
  if (anilistId === undefined) return null;
  const { shows } = await nas.encodeShows();
  for (const s of shows.slice(0, RESOLVE_LIMIT)) {
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

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setShow(null);
    setError(null);
    setProgress(null);
    const load = (): void => {
      nas.encodeShow(showId).then(
        async (found) => {
          if (!live) return;
          setIndexing(false);
          if (found) {
            setShow(found);
            return;
          }
          const moved = await findMoved(nas, showId).catch(() => null);
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
    // no progress (none yet, or the NAS can't say) leaves the rows without marks
    nas.titleProgress(loadedId, { library: 'encodes' }).then(
      (p) => live && setProgress(p),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [nas, loadedId]);

  const back = (): void => history.back(ENCODES);
  const play = (encodeId: string, resumeUs: number | null): void =>
    history.push(resumeUs === null ? { kind: 'encodePlay', encodeId, timeS: null, resume: false } : { kind: 'encodePlay', encodeId, timeS: Math.floor(resumeUs / 1e6), resume: true });

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
