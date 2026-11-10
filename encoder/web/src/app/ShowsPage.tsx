// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { NasShow, NasShowsAnswer } from '../api-types';
import type { AppApi } from './app-api';
import { Link } from './router';
import { countOf, EncodedMeter, Poster } from './ShowPage';

// The Library's By show view: the NAS's shows with what is encoded of each, and the discs the NAS hasn't filed.

/** What the view needs. */
export interface ShowsListProps {
  readonly api: AppApi;
  /** Changes when the Library's Rescan asks for the shows again; above 0 it reads every show's detail again. */
  readonly refresh: number;
  /** Words to keep: a show or unsorted disc whose name (or path) holds every one, in any letter case. */
  readonly filter: string;
}

/** The shows and unsorted discs whose name (or path) holds every word of `text`. */
export function filterShows(answer: NasShowsAnswer, text: string): Pick<NasShowsAnswer, 'shows' | 'unsorted'> {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const keep = (hay: string): boolean => words.every((w) => hay.toLowerCase().includes(w));
  return {
    shows: answer.shows.filter((s) => keep(s.name)),
    unsorted: answer.unsorted.filter((u) => keep(`${u.label} ${u.relPath}`)),
  };
}

/** A show's seasons, films and discs in words. */
function showMeta(show: NasShow): string {
  const parts: string[] = [];
  if (show.seasons > 0) parts.push(countOf(show.seasons, 'season', 'seasons'));
  if (show.films > 0) parts.push(show.kind === 'movie' && show.seasons === 0 ? 'Film' : countOf(show.films, 'film or extra', 'films and extras'));
  parts.push(countOf(show.discs, 'disc', 'discs'));
  return parts.join(', ');
}

/**
 * The NAS's shows, each with its poster, seasons and films, disc count and how much of it the Encodes library holds,
 * leading to the show; then the discs the NAS hasn't sorted, which open as discs do. While the NAS can't be reached,
 * the last listing is shown and says so.
 */
export function ShowsList({ api, refresh, filter }: ShowsListProps) {
  const [answer, setAnswer] = useState<NasShowsAnswer | null>(null);
  const [error, setError] = useState<ReactNode | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api.nasShows(refresh > 0 ? { refresh: true } : undefined).then(
      (a) => {
        if (live) setAnswer(a);
      },
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === 'nas-not-paired') {
          setError(
            <>
              {e.message} <Link to={{ kind: 'settings' }}>Open Settings</Link>
            </>,
          );
        } else setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, refresh]);

  if (answer === null) {
    return error === null ? (
      <p className="muted">Reading the NAS's shows…</p>
    ) : (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  const shown = filterShows(answer, filter);
  return (
    <>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!answer.reachable ? (
        <p className="notice" role="status">
          The NAS can't be reached. These are its shows from the last listing.
        </p>
      ) : (
        answer.stale && (
          <p className="notice" role="status">
            The NAS didn't answer every part of this, so some counts may be out of date.
          </p>
        )
      )}
      {answer.shows.length === 0 && answer.unsorted.length === 0 ? (
        <p className="muted">{answer.reachable ? 'The NAS has no shows or films filed yet.' : 'Nothing from the NAS has been listed here yet.'}</p>
      ) : shown.shows.length === 0 && shown.unsorted.length === 0 ? (
        <p className="muted">Nothing matches “{filter.trim()}”.</p>
      ) : null}
      {shown.shows.length > 0 && (
        <ul className="show-list" aria-label="Shows">
          {shown.shows.map((s) => (
            <li key={s.titleId}>
              <Link to={{ kind: 'show', titleId: s.titleId }} className="show-link">
                <Poster src={s.poster} name={s.name} />
                <span className="show-link-text">
                  <span className="show-link-name">{s.name}</span>
                  <span className="muted show-link-meta">{showMeta(s)}</span>
                </span>
                <EncodedMeter encoded={s.encoded} total={s.encoded + s.toEncode} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {shown.unsorted.length > 0 && (
        <section aria-labelledby="unsorted-heading" className="unsorted">
          <h2 id="unsorted-heading">
            Not sorted by the NAS yet <span className="muted num">{countOf(shown.unsorted.length, 'disc', 'discs')}</span>
          </h2>
          <p className="muted">File these from the player's owner screens on the NAS. They can still be opened and encoded from here.</p>
          <ul className="disc-list">
            {shown.unsorted.map((u) => (
              <li key={u.key}>
                <Link to={{ kind: 'disc', discKey: u.key }} className="disc-link">
                  <span className="disc-name">{u.label}</span>
                  <span className="disc-path muted">{u.relPath}</span>
                </Link>
                <span className="disc-facts">
                  <span className="mark mark-unsorted">Unsorted</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
