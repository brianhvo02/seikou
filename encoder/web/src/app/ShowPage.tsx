// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { NasEncodeTitle, NasSeason, NasSeasonDisc, NasShowAnswer } from '../api-types';
import type { AppApi } from './app-api';
import { useDocumentTitle } from './place';
import { QueueDialog } from './QueueDialog';
import { Link, navigate, routeHref, type SeasonRef } from './router';
import { checkTarget, needsCheck, queueBlock, seasonCounts, seasonState } from './shows-model';

// A NAS show (its seasons and films), one season disc by disc with what is encoded and what is checked, and the batch
// queue of what the season has left.

/** The words for `n` of a thing. */
export const countOf = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The show's answer, an error to show, or null while it is read. */
function useShow(api: AppApi, titleId: string): { readonly show: NasShowAnswer | null; readonly error: ReactNode | null } {
  const [show, setShow] = useState<NasShowAnswer | null>(null);
  const [error, setError] = useState<ReactNode | null>(null);
  useEffect(() => {
    let live = true;
    setShow(null);
    setError(null);
    api.nasShow(titleId).then(
      (s) => {
        if (live) setShow(s);
      },
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === 'nas-not-paired') {
          setError(
            <>
              {e.message} <Link to={{ kind: 'settings' }}>Open Settings</Link>
            </>,
          );
        } else if (e instanceof ApiError && e.code === 'not-found') setError('The NAS no longer lists this show. It may have been filed under another title.');
        else setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, titleId]);
  return { show, error };
}

/** The page while the show is read, or its error. */
function Waiting({ error, what }: { readonly error: ReactNode | null; readonly what: string }) {
  return (
    <main className="content wide">
      <p className="crumb">
        <Link to={{ kind: 'library' }}>Library</Link>
      </p>
      {error === null ? (
        <p className="muted">Reading {what} from the NAS…</p>
      ) : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

/** The line saying the listing is the last one kept, or may be out of date. */
function StaleLine({ show }: { readonly show: Pick<NasShowAnswer, 'reachable' | 'stale'> }) {
  if (!show.reachable) {
    return (
      <p className="notice" role="status">
        The NAS can't be reached. This is its last listing, and nothing can be checked or queued until it answers.
      </p>
    );
  }
  if (show.stale) {
    return (
      <p className="notice" role="status">
        The NAS didn't answer every part of this, so some of it may be out of date.
      </p>
    );
  }
  return null;
}

/** A poster, or a plain block with the name's first letter when there is none. */
export function Poster({ src, name, large = false }: { readonly src: string | null; readonly name: string; readonly large?: boolean }) {
  const className = large ? 'show-poster show-poster-large' : 'show-poster';
  if (src !== null) return <img className={className} src={src} alt="" loading="lazy" />;
  return (
    <span className={`${className} show-poster-none`} aria-hidden="true">
      {[...name.trim()][0] ?? ''}
    </span>
  );
}

/** How much of `total` is encoded, as words and a thin bar. */
export function EncodedMeter({ encoded, total }: { readonly encoded: number; readonly total: number }) {
  const words =
    total === 0 ? 'No episode list' : encoded === 0 ? `None of ${total} encoded` : encoded === total ? `All ${total} encoded` : `${encoded} of ${total} encoded`;
  return (
    <span className="encoded-meter num">
      <span className={encoded > 0 && encoded === total ? 'encoded-all' : undefined}>{words}</span>
      {total > 0 && (
        <span className="encoded-track" aria-hidden="true">
          <span style={{ width: `${Math.round((encoded / total) * 100)}%` }} />
        </span>
      )}
    </span>
  );
}

/** Where a season's encodes are filed: its AniList entry, TMDB season or film, or own title. */
function titleWords(title: NasEncodeTitle | null): string {
  if (title === null) return "The NAS hasn't loaded this entry yet";
  switch (title.source) {
    case 'anilist':
      return `AniList ${title.anilistId}`;
    case 'tmdb-tv':
      return `TMDB ${title.tmdbId}, season ${title.season}`;
    case 'tmdb-movie':
      return `TMDB film ${title.tmdbId}`;
    case 'own':
      return title.season === null ? 'Your own title' : `Your own title, season ${title.season}`;
  }
}

/** One season or film as a row of the show page. */
function SeasonRow({ titleId, season }: { readonly titleId: string; readonly season: NasSeason }) {
  const counts = seasonCounts(season);
  return (
    <li>
      <Link to={{ kind: 'season', titleId, seasonId: season.id }} className="season-link">
        <span className="season-name">{season.label}</span>
        <span className="muted season-meta">
          {countOf(season.discs.length, 'disc', 'discs')}
          {season.title === null && ', entry not loaded yet'}
        </span>
        <EncodedMeter encoded={counts.encoded} total={counts.episodes} />
      </Link>
    </li>
  );
}

/** What the show page needs. */
export interface ShowPageProps {
  readonly api: AppApi;
  /** The NAS's title id. */
  readonly titleId: string;
}

/** A NAS show: its poster and name, its seasons, then its films and other unnumbered groups, each leading to its page. */
export function ShowPage({ api, titleId }: ShowPageProps) {
  const { show, error } = useShow(api, titleId);
  useDocumentTitle(show === null ? 'Seikou encoder' : `${show.title.name} · Seikou encoder`);
  if (show === null) return <Waiting error={error} what="the show" />;
  const seasons = show.seasons.filter((s) => s.number !== null);
  const others = show.seasons.filter((s) => s.number === null);
  const all = show.seasons.map(seasonCounts);
  const encoded = all.reduce((n, c) => n + c.encoded, 0);
  const total = all.reduce((n, c) => n + c.episodes, 0);
  return (
    <main className="content wide show-page">
      <p className="crumb">
        <Link to={{ kind: 'library' }}>Library</Link>
      </p>
      <div className="show-head">
        <Poster src={show.title.poster} name={show.title.name} large />
        <div className="show-head-text">
          <h1 className="page-title">{show.title.name}</h1>
          <p className="muted">
            {[
              seasons.length > 0 ? countOf(seasons.length, 'season', 'seasons') : null,
              others.length > 0 ? countOf(others.length, 'film or extra', 'films and extras') : null,
            ]
              .filter((p) => p !== null)
              .join(', ')}
          </p>
          <EncodedMeter encoded={encoded} total={total} />
        </div>
      </div>
      <StaleLine show={show} />
      {seasons.length > 0 && (
        <section aria-labelledby="seasons-heading" className="show-section">
          <h2 id="seasons-heading">Seasons</h2>
          <ul className="season-list">
            {seasons.map((s) => (
              <SeasonRow key={s.id} titleId={titleId} season={s} />
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="films-heading" className="show-section">
          <h2 id="films-heading">Films and extras</h2>
          <ul className="season-list">
            {others.map((s) => (
              <SeasonRow key={s.id} titleId={titleId} season={s} />
            ))}
          </ul>
        </section>
      )}
      {show.seasons.length === 0 && <p className="muted">The NAS lists no discs under this show.</p>}
    </main>
  );
}

/** Episode numbers as `eps 5–8`, `ep 5`, or the list when they aren't a run. */
function episodesWords(numbers: readonly number[]): string {
  if (numbers.length === 0) return '';
  if (numbers.length === 1) return `episode ${numbers[0]}`;
  const run = numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1);
  return run ? `episodes ${numbers[0]}–${numbers[numbers.length - 1]}` : `episodes ${numbers.join(', ')}`;
}

/** One disc of a season: its playlists and episodes, Encoded or To encode, and whether it is checked. */
function DiscBlock({
  disc,
  from,
  needsCheck,
  reachable,
}: {
  readonly disc: NasSeasonDisc;
  readonly from: SeasonRef;
  readonly needsCheck: boolean;
  /** False while the NAS doesn't answer: a disc can't be checked then. */
  readonly reachable: boolean;
}) {
  const headingId = `disc-${disc.discId}`;
  const target = checkTarget(disc);
  const listed = disc.playlists.filter((p) => p.episodes.length > 0);
  const left = listed.flatMap((p) => p.episodes).filter((e) => !e.encoded).length;
  let state: ReactNode;
  if (!disc.available) state = <span className="disc-state disc-state-missing">Not in this app's NAS listing</span>;
  else if (disc.checked && !needsCheck) state = <span className="disc-state disc-state-checked">Checked</span>;
  else if (needsCheck && !reachable) state = <span className="disc-state">Not checked</span>;
  else if (needsCheck && target !== null) {
    const to =
      target.kind === 'playlist'
        ? ({
            kind: 'episodes',
            discKey: disc.key!,
            playlistId: target.playlistId,
            from,
          } as const)
        : ({ kind: 'disc', discKey: disc.key!, from } as const);
    state = (
      <Link to={to} className="disc-check">
        Check episodes
      </Link>
    );
  } else if (listed.length > 0 && left === 0) state = <span className="disc-state disc-state-checked">All encoded</span>;
  else state = null;
  return (
    <section className="season-disc" aria-labelledby={headingId}>
      <div className="season-disc-head">
        <h2 id={headingId} className="season-disc-name">
          {disc.label}
        </h2>
        <span className="muted season-disc-playlists num">
          {listed.length > 0
            ? listed.map((p) => `playlist ${p.id}, ${episodesWords(p.episodes.map((e) => e.number))}`).join('; ')
            : disc.checkedPlaylists.length > 0
              ? disc.checkedPlaylists.map((p) => `playlist ${p.id}, ${countOf(p.episodeSpec.split(',').length, 'episode', 'episodes')}`).join('; ')
              : 'no episode list on the NAS'}
        </span>
        {state}
      </div>
      {listed.length > 0 ? (
        <ol className="season-episodes">
          {listed.flatMap((p) =>
            p.episodes.map((e) => (
              <li key={`${p.id}:${e.number}`} className={e.encoded ? 'is-encoded' : undefined}>
                <span className="season-ep-number num">{e.number}</span>
                <span className={e.name === null ? 'season-ep-name muted' : 'season-ep-name'}>{e.name ?? `Episode ${e.number}`}</span>
                <span className={e.encoded ? 'season-ep-state encoded' : 'season-ep-state'}>{e.encoded ? 'Encoded' : 'To encode'}</span>
              </li>
            )),
          )}
        </ol>
      ) : (
        <p className="season-disc-note muted">
          {!disc.available
            ? 'Rescan the Library to read it.'
            : disc.checked
              ? "The NAS doesn't list its episodes, so its checked grouping is queued whole."
              : needsCheck
                ? "The NAS doesn't say which episodes this disc holds. Check episodes to group its chapters."
                : 'No episodes listed on this disc.'}
        </p>
      )}
    </section>
  );
}

/** What the season page needs. */
export interface SeasonPageProps {
  readonly api: AppApi;
  readonly titleId: string;
  /** The season's id, as the NAS gives it. */
  readonly seasonId: string;
}

/**
 * One season (or film) of a NAS show, disc by disc: each episode Encoded or To encode, each disc with episodes left
 * Checked or with Check episodes (the Episodes page, which leads back here), and Queue for what the season has left,
 * disabled with the reason until every such disc is checked and the NAS answers.
 */
export function SeasonPage({ api, titleId, seasonId }: SeasonPageProps) {
  const { show, error } = useShow(api, titleId);
  const season = show?.seasons.find((s) => s.id === seasonId) ?? null;
  useDocumentTitle(show === null ? 'Seikou encoder' : `${season?.label ?? 'Season'} · ${show.title.name} · Seikou encoder`);
  if (show === null) return <Waiting error={error} what="the season" />;
  if (season === null) {
    return (
      <Waiting
        error={
          <>
            The NAS no longer lists this season. <Link to={{ kind: 'show', titleId }}>Back to {show.title.name}</Link>
          </>
        }
        what="the season"
      />
    );
  }
  const from: SeasonRef = { titleId, seasonId };
  const state = seasonState(season);
  const blocked = queueBlock(season, show.reachable);
  const counts = seasonCounts(season);
  const queued = blocked === null ? state.jobs.reduce((n, j) => n + (j.only?.length ?? j.episodeSpec.split(',').length), 0) : state.toEncode;
  const queue = (): void => navigate(routeHref({ kind: 'seasonQueue', titleId, seasonId }, location.search));
  return (
    <main className="content wide season-page">
      <p className="crumb">
        <Link to={{ kind: 'library' }}>Library</Link> / <Link to={{ kind: 'show', titleId }}>{show.title.name}</Link>
      </p>
      <h1 className="page-title">{season.label}</h1>
      <p className="muted num">
        {titleWords(season.title)}
        {counts.episodes > 0 && `, ${countOf(counts.episodes, 'episode', 'episodes')}, ${counts.toEncode} to encode`}
      </p>
      <StaleLine show={show} />
      {season.discs.length === 0 && <p className="muted">The NAS lists no discs here.</p>}
      {season.discs.map((d) => (
        <DiscBlock key={d.discId} disc={d} from={from} needsCheck={needsCheck(season, d)} reachable={show.reachable} />
      ))}
      <div className="season-queue">
        {blocked !== null && <span className="season-queue-why">{blocked}</span>}
        <button type="button" className="primary" disabled={blocked !== null} onClick={queue}>
          Queue {countOf(queued, 'episode', 'episodes')} to the NAS
        </button>
      </div>
    </main>
  );
}

/** The batch queue of a season: its jobs worked out again from the NAS's answer, or why it can't be queued. */
export function SeasonQueue({ api, titleId, seasonId }: SeasonPageProps) {
  const { show, error } = useShow(api, titleId);
  if (show === null) return <Waiting error={error} what="the season" />;
  const season = show.seasons.find((s) => s.id === seasonId) ?? null;
  const blocked = season === null ? 'The NAS no longer lists this season.' : queueBlock(season, show.reachable);
  if (season === null || blocked !== null) {
    return (
      <main className="content wide">
        <p className="crumb">
          <Link to={{ kind: 'season', titleId, seasonId }}>Back to the season</Link>
        </p>
        <p className="error" role="alert">
          {blocked}
        </p>
      </main>
    );
  }
  return <QueueDialog api={api} batch={seasonState(season).jobs} from={{ titleId, seasonId }} />;
}
