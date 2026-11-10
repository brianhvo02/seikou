// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { NasEncodeTitle, NasSeason, NasSeasonDisc, NasShowAnswer } from '../api-types';
import type { AppApi } from './app-api';
import { useDocumentTitle } from './place';
import { QueueDialog } from './QueueDialog';
import { Link, navigate, routeHref, type SeasonRef } from './router';
import { useJobs } from './jobs-context';
import {
  checkTarget,
  groupsOf,
  isGroupQueued,
  isQueued,
  needsCheck,
  queueBlock,
  queuedKeys,
  seasonCounts,
  seasonState,
  unmappedText,
  type Unmapped,
} from './shows-model';

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
        else if (e instanceof ApiError && e.code === 'nas-unreachable') setError("The NAS isn't answering, and this app has no earlier listing of it. Try again in a moment.");
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
function StaleLine({ show }: { readonly show: Pick<NasShowAnswer, 'reachable' | 'stale' | 'encodedKnown'> }) {
  if (!show.reachable) {
    return (
      <p className="notice" role="status">
        The NAS can't be reached. This is its last listing, and nothing can be checked or queued until it answers.
      </p>
    );
  }
  if (!show.encodedKnown) {
    return (
      <p className="notice" role="status">
        The NAS didn't say which episodes its Encodes library holds, so the Encoded marks may be out of date and nothing can be queued until it does.
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
export function EncodedMeter({ encoded, total, known = true }: { readonly encoded: number; readonly total: number; readonly known?: boolean }) {
  const words = !known
    ? total === 0
      ? 'Not checked yet'
      : `${encoded} of ${total} so far encoded`
    : total === 0
      ? 'No episode list'
      : encoded === 0
        ? `None of ${total} encoded`
        : encoded === total
          ? `All ${total} encoded`
          : `${encoded} of ${total} encoded`;
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
        <EncodedMeter encoded={counts.encoded} total={counts.episodes} known={counts.known} />
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

/** Episode numbers as `episodes 5–8`, `episode 5`, or the list when they aren't a run. */
function episodesWords(numbers: readonly number[]): string {
  if (numbers.length === 0) return '';
  if (numbers.length === 1) return `episode ${numbers[0]}`;
  const run = numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1);
  return run ? `episodes ${numbers[0]}–${numbers[numbers.length - 1]}` : `episodes ${numbers.join(', ')}`;
}

/** An episode row: its number, name and mark. */
function EpisodeRow({ number, name, mark }: { readonly number: number | null; readonly name: string; readonly mark: 'encoded' | 'queued' | 'todo' }) {
  return (
    <li className={mark === 'todo' ? undefined : 'is-encoded'}>
      <span className="season-ep-number num">{number ?? ''}</span>
      <span className="season-ep-name">{name}</span>
      <span className={`season-ep-state ${mark === 'encoded' ? 'encoded' : mark === 'queued' ? 'queued' : ''}`.trim()}>
        {mark === 'encoded' ? 'Encoded' : mark === 'queued' ? 'Queued' : 'To encode'}
      </span>
    </li>
  );
}

interface DiscBlockProps {
  readonly season: NasSeason;
  readonly disc: NasSeasonDisc;
  readonly from: SeasonRef;
  /** False while the NAS doesn't answer: a disc can't be checked then. */
  readonly reachable: boolean;
  /** The episodes a NAS job in the queue already encodes (`queuedKeys`). */
  readonly queued: ReadonlySet<string>;
  /** The disc's NAS episodes to encode that no checked group gives, when there are any. */
  readonly unmapped: Unmapped | undefined;
}

/** One disc of a season: its playlists and episodes, Encoded, Queued or To encode, and whether it is checked. */
function DiscBlock({ season, disc, from, reachable, queued, unmapped }: DiscBlockProps) {
  const headingId = `disc-${disc.discId}`;
  const listed = disc.playlists.filter((p) => p.episodes.length > 0);
  const recheck = needsCheck(season, disc) || unmapped !== undefined;
  const target = unmapped !== undefined ? ({ kind: 'playlist', playlistId: unmapped.playlistId } as const) : checkTarget(disc);
  const left = listed.flatMap((p) => p.episodes).filter((e) => !e.encoded).length;
  let state: ReactNode;
  if (!disc.available) state = <span className="disc-state disc-state-missing">Not in this app's NAS listing</span>;
  else if (!recheck && disc.checked) state = <span className="disc-state disc-state-checked">Checked</span>;
  else if (recheck && !reachable) state = <span className="disc-state">Not checked</span>;
  else if (recheck && target !== null && disc.key !== null) {
    const to =
      target.kind === 'playlist'
        ? ({ kind: 'episodes', discKey: disc.key, playlistId: target.playlistId, from } as const)
        : ({ kind: 'disc', discKey: disc.key, from } as const);
    state = (
      <Link to={to} className="disc-check">
        Check episodes
      </Link>
    );
  } else if (listed.length > 0 && left === 0) state = <span className="disc-state disc-state-checked">All encoded</span>;
  else state = null;
  const checkedGroups = disc.checked ? disc.checkedPlaylists : [];
  return (
    <section className="season-disc" aria-labelledby={headingId}>
      <div className="season-disc-head">
        <h2 id={headingId} className="season-disc-name">
          {disc.label}
        </h2>
        <span className="muted season-disc-playlists num">
          {listed.length > 0
            ? listed.map((p) => `playlist ${p.id}, ${episodesWords(p.episodes.map((e) => e.number))}`).join('; ')
            : checkedGroups.length > 0
              ? checkedGroups.map((p) => `playlist ${p.id}, ${countOf(groupsOf(p.episodeSpec), 'episode', 'episodes')}`).join('; ')
              : 'no episode list on the NAS'}
        </span>
        {state}
      </div>
      {unmapped !== undefined && (
        <p className="season-disc-warn" role="status">
          {unmappedText(unmapped)}.
        </p>
      )}
      {listed.length > 0 ? (
        <ol className="season-episodes">
          {listed.flatMap((p) =>
            p.episodes.map((e) => (
              <EpisodeRow
                key={`${p.id}:${e.number}`}
                number={e.number}
                name={e.name ?? `Episode ${e.number}`}
                mark={e.encoded ? 'encoded' : isQueued(season, disc, e.number, queued) ? 'queued' : 'todo'}
              />
            )),
          )}
        </ol>
      ) : checkedGroups.length > 0 ? (
        <ol className="season-episodes">
          {checkedGroups.flatMap((p) =>
            p.groups.map((g) => (
              <EpisodeRow
                key={`${p.id}:${g.index}`}
                number={g.episode}
                name={g.episode === null ? `Episode ${g.index} of playlist ${p.id}, untitled` : `Episode ${g.episode}`}
                mark={g.encoded ? 'encoded' : isGroupQueued(disc, g, queued) ? 'queued' : 'todo'}
              />
            )),
          )}
        </ol>
      ) : (
        <p className="season-disc-note muted">
          {!disc.available
            ? 'Rescan the Library to read it.'
            : recheck
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

/** How long the season pages wait for the app's queue before saying it can't be read. */
export const QUEUE_WAIT_MS = 5000;

/**
 * The episodes of `season` that a NAS job in the app's queue already encodes, null until the queue has been read; and
 * while it hasn't, why Queue can't be used: the queue stream's problem, else "Reading the queue…" for `QUEUE_WAIT_MS`
 * and "Can't read the queue" after (`failed` true then too).
 */
function useQueued(season: NasSeason | null): { readonly queued: ReadonlySet<string> | null; readonly why: string | null; readonly failed: boolean } {
  const { jobs, problem } = useJobs();
  const [late, setLate] = useState(false);
  const loaded = jobs !== null;
  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => setLate(true), QUEUE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [loaded]);
  if (jobs !== null) return { queued: season === null ? new Set() : queuedKeys(season, jobs), why: null, failed: false };
  if (problem !== null) return { queued: null, why: `Can't read the queue: ${problem}`, failed: true };
  return late ? { queued: null, why: "Can't read the queue", failed: true } : { queued: null, why: 'Reading the queue…', failed: false };
}

const NONE: ReadonlySet<string> = new Set();

/**
 * One season (or film) of a NAS show, disc by disc: each episode Encoded, Queued (a NAS job here already encodes it)
 * or To encode, each disc with episodes left Checked or with Check episodes (the Episodes page, which leads back here),
 * and Queue for what the season has left, disabled with the reason until every such disc is checked and the NAS
 * answers.
 */
export function SeasonPage({ api, titleId, seasonId }: SeasonPageProps) {
  const { show, error } = useShow(api, titleId);
  const season = show?.seasons.find((s) => s.id === seasonId) ?? null;
  const queue = useQueued(season);
  const queued = queue.queued ?? NONE;
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
  const state = seasonState(season, queued);
  const blocked = queueBlock(season, show, queued) ?? queue.why;
  const counts = seasonCounts(season);
  const queuedNow = state.jobs.reduce((n, j) => n + (j.only?.length ?? groupsOf(j.episodeSpec)), 0);
  const label =
    blocked === null
      ? `Queue ${countOf(queuedNow, 'episode', 'episodes')} to the NAS`
      : state.known
        ? `Queue ${countOf(state.toEncode, 'episode', 'episodes')} to the NAS`
        : 'Queue to the NAS';
  const openQueue = (): void => navigate(routeHref({ kind: 'seasonQueue', titleId, seasonId }, location.search));
  const facts = [titleWords(season.title)];
  if (!counts.known) facts.push('some discs not checked yet');
  else if (counts.episodes > 0) facts.push(countOf(counts.episodes, 'episode', 'episodes'), `${state.toEncode} to encode`);
  if (state.queued > 0) facts.push(`${state.queued} in the queue`);
  return (
    <main className="content wide season-page">
      <p className="crumb">
        <Link to={{ kind: 'library' }}>Library</Link> / <Link to={{ kind: 'show', titleId }}>{show.title.name}</Link>
      </p>
      <h1 className="page-title">{season.label}</h1>
      <p className="muted num">{facts.join(', ')}</p>
      <StaleLine show={show} />
      {season.discs.length === 0 && <p className="muted">The NAS lists no discs here.</p>}
      {season.discs.map((d) => (
        <DiscBlock
          key={d.discId}
          season={season}
          disc={d}
          from={from}
          reachable={show.reachable}
          queued={queued}
          unmapped={state.unmapped.find((u) => u.discId === d.discId)}
        />
      ))}
      <div className="season-queue">
        {blocked !== null && (
          <span id="season-queue-why" className="season-queue-why">
            {blocked}
          </span>
        )}
        <button type="button" className="primary" disabled={blocked !== null} aria-describedby={blocked !== null ? 'season-queue-why' : undefined} onClick={openQueue}>
          {label}
        </button>
      </div>
    </main>
  );
}

/** The batch queue of a season: its jobs worked out again from the NAS's answer and the app's queue, or why it can't be queued. */
export function SeasonQueue({ api, titleId, seasonId }: SeasonPageProps) {
  const { show, error } = useShow(api, titleId);
  const season = show?.seasons.find((s) => s.id === seasonId) ?? null;
  const { queued, why, failed } = useQueued(season);
  // the queue as it was when the page opened: the batch's own jobs must not take their episodes out of it as they go in
  const [jobs, setJobs] = useState<ReturnType<typeof seasonState>['jobs'] | null>(null);
  const blocked =
    show === null ? null : season === null ? 'The NAS no longer lists this season.' : queued === null ? (failed ? why : null) : queueBlock(season, show, queued);
  useEffect(() => {
    if (jobs === null && season !== null && queued !== null && blocked === null) setJobs(seasonState(season, queued).jobs);
  }, [jobs, season, blocked, queued]);
  if (show === null) return <Waiting error={error} what="the season" />;
  if (jobs !== null) return <QueueDialog api={api} batch={jobs} from={{ titleId, seasonId }} />;
  if (blocked !== null) {
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
  return <Waiting error={null} what="the season" />;
}
