// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type Dispatch, type FormEvent } from 'react';
import type { HelperApi } from '../api';
import type { ReleaseAnswer, SeaDexAnswer, SeaDexRelease, TitleHit, ToshoHit } from '../api-types';
import type { HelperAction, HelperState, ReleaseSource } from '../helper-model';
import { errorText, plural, releaseSummary } from './release-model';

/** What step 1 needs: the backend client, the page's state and the dispatcher that changes it. */
export interface ReleaseStepProps {
  /** The backend client. */
  readonly api: HelperApi;
  /** The page's state; the step reads the show, the offset, the release and its match. */
  readonly state: HelperState;
  /** Applies an action to the page's state. */
  readonly dispatch: Dispatch<HelperAction>;
}

/** The file types the backend accepts as a user's own release. */
const OWN_FILE_TYPES = '.ass,.ssa,.srt,.ttf,.otf,.ttc,.woff,.woff2';

/** The reason a SeaDex release cannot be fetched, as shown on its row. */
const UNAVAILABLE_TEXT = { 'private-tracker': 'Private tracker', 'not-on-tosho': 'Not on Anime Tosho' } as const;

/** One line of a show's facts: year, format and episode count, as far as AniList knows them. */
function facts(hit: TitleHit): string {
  const parts: string[] = [];
  if (hit.year !== null) parts.push(String(hit.year));
  if (hit.format !== null) parts.push(hit.format);
  if (hit.episodes !== null) parts.push(plural(hit.episodes, 'episode'));
  return parts.join(', ');
}

/** A show's cover (or an empty frame of the same size), its names and its facts. */
function ShowLine({ hit }: { hit: TitleHit }) {
  return (
    <>
      {hit.poster !== null ? <img className="cover" src={hit.poster} alt="" loading="lazy" /> : <span className="cover" aria-hidden="true" />}
      <span className="show-text">
        <span className="show-title">{hit.title}</span>
        {hit.nativeTitle !== null && (
          <span className="show-native" lang="ja">
            {hit.nativeTitle}
          </span>
        )}
        <span className="muted num">{facts(hit)}</span>
      </span>
    </>
  );
}

/** A request's error, shown beside the control that caused it. */
function Problem({ text }: { text: string | null }) {
  return text === null ? null : (
    <p className="error problem" role="alert">
      {text}
    </p>
  );
}

/**
 * Step 1: the user searches AniList for the show and picks it, then picks a release for it from SeaDex, from an Anime
 * Tosho search or from their own files. SeaDex is asked only once a show is picked, and again whenever the picked show
 * changes; the Anime Tosho search and the user's own files need no show. A picked release is fetched at the episode
 * offset and handed to the page's state, which also holds the show and the offset. "Next" opens step 2.
 */
export function ReleaseStep({ api, state, dispatch }: ReleaseStepProps) {
  const { title, release, match, episodeOffset } = state;
  const alId = title?.alId ?? null;

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TitleHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [seadex, setSeadex] = useState<SeaDexAnswer | null>(null);
  const [seadexError, setSeadexError] = useState<string | null>(null);

  const [toshoQuery, setToshoQuery] = useState('');
  const [toshoHits, setToshoHits] = useState<ToshoHit[] | null>(null);
  const [toshoError, setToshoError] = useState<string | null>(null);

  const [offsetText, setOffsetText] = useState(String(episodeOffset));
  const [offsetError, setOffsetError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // the newest fetch wins: an answer that arrives after another request started is dropped
  const fetchSeq = useRef(0);

  // SeaDex belongs to the picked show: ask when one is picked (or restored), forget it when the show goes
  useEffect(() => {
    setSeadex(null);
    setSeadexError(null);
    if (alId === null) return;
    let live = true;
    api.seadex(alId).then(
      (answer) => live && setSeadex(answer),
      (e: unknown) => live && setSeadexError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [api, alId]);

  useEffect(() => setOffsetText(String(episodeOffset)), [episodeOffset]);

  const searchShows = async (e: FormEvent) => {
    e.preventDefault();
    const text = query.trim();
    if (text === '') return;
    setSearching(true);
    setSearchError(null);
    try {
      setHits(await api.searchTitles(text));
    } catch (err) {
      setHits(null);
      setSearchError(errorText(err));
    } finally {
      setSearching(false);
    }
  };

  const pickShow = (hit: TitleHit) => {
    setHits(null);
    setFetchError(null);
    dispatch({ type: 'setTitle', title: hit });
  };

  const changeShow = () => {
    fetchSeq.current += 1;
    setFetching(false);
    setFetchError(null);
    setUploadError(null);
    dispatch({ type: 'setTitle', title: null });
  };

  const searchTosho = async (e: FormEvent) => {
    e.preventDefault();
    const text = toshoQuery.trim();
    if (text === '') return;
    setToshoError(null);
    try {
      setToshoHits(await api.searchTosho(text));
    } catch (err) {
      setToshoHits(null);
      setToshoError(errorText(err));
    }
  };

  /** Runs `get`, hands its answer to the state as a release from `from`, and shows a failure with `onError`. */
  const take = async (get: () => Promise<ReleaseAnswer>, from: ReleaseSource, onError: (text: string | null) => void) => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setFetchError(null);
    setUploadError(null);
    onError(null);
    try {
      const answer = await get();
      if (seq === fetchSeq.current) dispatch({ type: 'setRelease', release: answer, from });
    } catch (err) {
      if (seq === fetchSeq.current) onError(errorText(err));
    } finally {
      if (seq === fetchSeq.current) setFetching(false);
    }
  };

  const pickToshoRelease = (toshoId: number, from: 'seadex' | 'tosho') =>
    take(() => api.fetchRelease(toshoId, episodeOffset), from, from === 'seadex' ? setFetchError : setToshoError);

  const addOwnFiles = (files: FileList | null) => {
    if (files === null || files.length === 0) return;
    void take(() => api.upload(Array.from(files), episodeOffset), 'local', setUploadError);
  };

  const commitOffset = () => {
    const n = Number(offsetText);
    if (offsetText.trim() === '' || !Number.isInteger(n) || n < 0) {
      setOffsetError('Use a whole number, 0 or more.');
      return;
    }
    setOffsetError(null);
    if (n === episodeOffset) return;
    dispatch({ type: 'setOffset', offset: n });
    if (release !== null && state.releaseSource !== null) {
      void take(() => api.release(release.key, n), state.releaseSource, setFetchError);
    }
  };

  const isChosen = (r: SeaDexRelease) => release !== null && r.toshoId !== null && release.key === `tosho-${r.toshoId}`;
  const summary = release === null ? null : releaseSummary(release, match);

  return (
    <div className="release-step">
      <section aria-labelledby="show-heading" className="block">
        <h2 id="show-heading">Show</h2>
        {title !== null ? (
          <div className="picked-show">
            <ShowLine hit={title} />
            <button type="button" className="quiet" onClick={changeShow}>
              Change
            </button>
          </div>
        ) : (
          <>
            <form className="search" role="search" onSubmit={(e) => void searchShows(e)}>
              <input type="search" aria-label="Search AniList for the show" placeholder="Search AniList for the show" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button type="submit" className="primary" disabled={searching}>
                Search
              </button>
            </form>
            <Problem text={searchError} />
            {hits !== null && hits.length === 0 && <p className="muted">AniList found nothing for that. Try another spelling.</p>}
            {hits !== null && hits.length > 0 && (
              <ul className="results">
                {hits.map((hit) => (
                  <li key={hit.alId}>
                    <button type="button" className="show-row" onClick={() => pickShow(hit)}>
                      <ShowLine hit={hit} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="offset-heading" className="block">
        <h2 id="offset-heading">Episode offset</h2>
        <div className="offset">
          <input
            type="number"
            className="num"
            aria-labelledby="offset-heading"
            aria-describedby="offset-help"
            min={0}
            step={1}
            value={offsetText}
            onChange={(e) => setOffsetText(e.target.value)}
            onBlur={commitOffset}
            onKeyDown={(e) => e.key === 'Enter' && commitOffset()}
          />
          <p id="offset-help" className="muted">
            How many episodes the release numbers before this disc's first, for a later season or disc.
          </p>
        </div>
        <Problem text={offsetError} />
      </section>

      <section aria-labelledby="release-heading" className="block">
        <h2 id="release-heading">Release</h2>
        {title === null ? (
          <p className="muted">Search for the show first to see the releases SeaDex lists for it.</p>
        ) : (
          <>
            {seadex === null && seadexError === null && <p className="muted">Asking SeaDex…</p>}
            <Problem text={seadexError} />
            {seadex !== null && (
              <>
                {seadex.notes !== '' && <p className="notes">{seadex.notes}</p>}
                <a className="seadex-link" href={seadex.url} target="_blank" rel="noreferrer">
                  Open on SeaDex
                </a>
                {seadex.releases.length === 0 ? (
                  <p className="muted">SeaDex lists no release for this show. Search Anime Tosho or add your own files.</p>
                ) : (
                  <ul className="releases">
                    {seadex.releases.map((r, i) => {
                      const blocked = r.unavailable !== null || r.toshoId === null;
                      return (
                        <li key={`${r.group}-${r.tracker}-${i}`}>
                          <button
                            type="button"
                            className="release-row"
                            aria-pressed={isChosen(r)}
                            disabled={blocked || fetching}
                            onClick={() => r.toshoId !== null && void pickToshoRelease(r.toshoId, 'seadex')}
                          >
                            <span className="release-group">{r.group}</span>
                            <span className="release-tags muted">
                              {[r.isBest ? 'Best' : null, ...r.tags, r.dualAudio && !r.tags.some((t) => /dual/i.test(t)) ? 'Dual audio' : null, r.unavailable !== null ? UNAVAILABLE_TEXT[r.unavailable] : null]
                                .filter((t): t is string => t !== null)
                                .join(', ')}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="tosho-heading" className="block">
        <h2 id="tosho-heading">Another release</h2>
        <form className="search" role="search" onSubmit={(e) => void searchTosho(e)}>
          <input type="search" aria-label="Search Anime Tosho" placeholder="Search Anime Tosho" value={toshoQuery} onChange={(e) => setToshoQuery(e.target.value)} />
          <button type="submit" className="quiet">
            Search
          </button>
        </form>
        <Problem text={toshoError} />
        {toshoHits !== null && toshoHits.length === 0 && <p className="muted">Anime Tosho found nothing for that.</p>}
        {toshoHits !== null && toshoHits.length > 0 && (
          <ul className="releases">
            {toshoHits.map((h) => (
              <li key={h.toshoId}>
                <button type="button" className="release-row" aria-pressed={release?.key === `tosho-${h.toshoId}`} disabled={fetching} onClick={() => void pickToshoRelease(h.toshoId, 'tosho')}>
                  <span className="release-group">{h.title}</span>
                  <span className="release-tags muted num">{new Date(h.date * 1000).toISOString().slice(0, 10)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="own-files">
          <span>Add your own files</span>
          <input
            type="file"
            multiple
            accept={OWN_FILE_TYPES}
            disabled={fetching}
            onChange={(e) => {
              addOwnFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <Problem text={uploadError} />
      </section>

      {fetching && <p className="muted" role="status">Fetching the release…</p>}
      <Problem text={fetchError} />

      {release !== null && summary !== null && (
        <section aria-labelledby="fetched-heading" className="block fetched">
          <h2 id="fetched-heading">Fetched release</h2>
          <p>{release.label}</p>
          <p className="muted num">
            {plural(summary.episodes, 'episode')}, {plural(summary.tracks, 'track')}
            {summary.languages.length > 0 && <>, {summary.languages.join(', ')}</>}, {plural(summary.fonts, 'font')}
          </p>
          {summary.unmatched > 0 && <p className="unmatched-note">{plural(summary.unmatched, 'file')} in the release matched no episode of this disc.</p>}
          <ul className="per-episode">
            {match
              .filter((r) => r.fileId !== null)
              .map((r) => {
                const file = release.files.find((f) => f.id === r.fileId);
                return (
                  <li key={r.episode} className="num">
                    <span>Episode {r.episode}</span>
                    <span className="muted">{plural(file?.tracks.length ?? 0, 'track')}</span>
                  </li>
                );
              })}
          </ul>
        </section>
      )}

      <div className="step-next">
        <button type="button" className="primary" disabled={release === null || fetching} onClick={() => dispatch({ type: 'goTo', step: 2 })}>
          Next
        </button>
      </div>
    </div>
  );
}
