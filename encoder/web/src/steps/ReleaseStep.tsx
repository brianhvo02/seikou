// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type Dispatch, type FormEvent } from 'react';
import type { HelperApi } from '../api';
import type { ReleaseAnswer, SeaDexAnswer, SeaDexRelease, TitleHit, ToshoHit } from '../api-types';
import { releaseOf, type HelperAction, type HelperState, type ReleaseSource } from '../helper-model';
import { anyEpisodeHasFile, errorText, plural, refetchNotice, releaseSummary, sourceText } from './release-model';

/** What step 1 needs: the backend client, the page's state and the dispatcher that changes it. */
export interface ReleaseStepProps {
  /** The backend client. */
  readonly api: HelperApi;
  /** The page's state; the step reads the show, the offset and the pooled releases. */
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
 * offset and added to the page's pool, which the state holds with the show and the offset; picking a pooled release
 * again fetches it again. "Releases in use" lists the pool with a summary of each and a Remove button. A new offset
 * fetches every pooled release again: the answers that arrive are added back in pool order and one last pass gives
 * the episodes still without a file the first matched one, and releases that could not be fetched are named beside
 * the offset and keep their old match. A pick fetched at an offset the user has changed meanwhile is fetched again at
 * the new one. "Next" opens step 2 once some episode has a file.
 */
export function ReleaseStep({ api, state, dispatch }: ReleaseStepProps) {
  const { title, releases, episodeOffset } = state;
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
  const [pending, setPending] = useState(0);
  const fetching = pending > 0;
  const [refetchProblem, setRefetchProblem] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // bumped when the show is cleared: a pick still on its way for the old show is dropped
  const fetchSeq = useRef(0);
  // what an answer arriving later must be checked against: the offset now in force, and the pool as it is now
  const offsetNow = useRef(episodeOffset);
  offsetNow.current = episodeOffset;
  const poolNow = useRef(state);
  poolNow.current = state;
  // the same rule for the two searches: only the newest submit may set its results
  const searchSeq = useRef(0);
  const toshoSeq = useRef(0);

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
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    try {
      const found = await api.searchTitles(text);
      if (seq === searchSeq.current) setHits(found);
    } catch (err) {
      if (seq === searchSeq.current) {
        setHits(null);
        setSearchError(errorText(err));
      }
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  };

  const pickShow = (hit: TitleHit) => {
    searchSeq.current += 1;
    setSearching(false);
    setHits(null);
    setFetchError(null);
    dispatch({ type: 'setTitle', title: hit });
  };

  const changeShow = () => {
    fetchSeq.current += 1;
    setFetchError(null);
    setUploadError(null);
    dispatch({ type: 'setTitle', title: null });
  };

  const searchTosho = async (e: FormEvent) => {
    e.preventDefault();
    const text = toshoQuery.trim();
    if (text === '') return;
    const seq = ++toshoSeq.current;
    setToshoError(null);
    try {
      const found = await api.searchTosho(text);
      if (seq === toshoSeq.current) setToshoHits(found);
    } catch (err) {
      if (seq === toshoSeq.current) {
        setToshoHits(null);
        setToshoError(errorText(err));
      }
    }
  };

  /**
   * Runs `get` at the offset in force, hands its answer to the state as a release from `from`, and shows a failure with
   * `onError`. An answer fetched at an offset the user has changed since is fetched again at the new one, so a pick is
   * never added with a match for the wrong offset.
   */
  const take = async (get: (offset: number) => Promise<ReleaseAnswer>, from: ReleaseSource, onError: (text: string | null) => void) => {
    const epoch = fetchSeq.current;
    setPending((n) => n + 1);
    setFetchError(null);
    setUploadError(null);
    onError(null);
    try {
      let offset = offsetNow.current;
      let answer = await get(offset);
      while (offset !== offsetNow.current) {
        offset = offsetNow.current;
        answer = await get(offset);
      }
      if (epoch === fetchSeq.current) dispatch({ type: 'addRelease', release: answer, from });
    } catch (err) {
      if (epoch === fetchSeq.current) onError(errorText(err));
    } finally {
      setPending((n) => n - 1);
    }
  };

  const pickToshoRelease = (toshoId: number, from: 'seadex' | 'tosho') =>
    take((offset) => api.fetchRelease(toshoId, offset), from, from === 'seadex' ? setFetchError : setToshoError);

  const addOwnFiles = (files: FileList | null) => {
    if (files === null || files.length === 0) return;
    void take((offset) => api.upload(Array.from(files), offset), 'local', setUploadError);
  };

  const commitOffset = () => {
    const n = Number(offsetText);
    if (offsetText.trim() === '' || !Number.isInteger(n) || n < 0) {
      setOffsetError('Use a whole number, 0 or more.');
      return;
    }
    setOffsetError(null);
    if (n === episodeOffset) return;
    offsetNow.current = n;
    setRefetchProblem(null);
    dispatch({ type: 'setOffset', offset: n });
    if (releases.length > 0) void refetchPool(n);
  };

  /**
   * Fetches every pooled release again at `offset`. The answers that arrive are added back in pool order, then one pass
   * fills the episodes still without a file; releases that failed are named in a notice and keep their old match. The
   * answers are applied even when a pick started meanwhile, but only for releases still in the pool and only while
   * `offset` is still the offset in force (a newer offset change has its own refetch).
   */
  const refetchPool = async (offset: number) => {
    setPending((n) => n + 1);
    try {
      const settled = await Promise.allSettled(releases.map((p) => api.release(p.release.key, offset)));
      if (offsetNow.current !== offset) return;
      const failed: string[] = [];
      settled.forEach((result, i) => {
        const pooled = releases[i]!;
        if (result.status === 'rejected') failed.push(pooled.release.label);
        else if (releaseOf(poolNow.current, pooled.release.key) !== null) dispatch({ type: 'addRelease', release: result.value, from: pooled.source });
      });
      dispatch({ type: 'fillFromPool' });
      setRefetchProblem(refetchNotice(failed));
    } finally {
      setPending((n) => n - 1);
    }
  };

  const isChosen = (r: SeaDexRelease) => r.toshoId !== null && releaseOf(state, `tosho-${r.toshoId}`) !== null;

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
        <Problem text={refetchProblem} />
      </section>

      {releases.length > 0 && (
        <section aria-labelledby="in-use-heading" className="block">
          <h2 id="in-use-heading">Releases in use</h2>
          <ul className="releases-in-use">
            {releases.map(({ release, source }) => {
              const summary = releaseSummary(release, release.match.rows);
              return (
                <li key={release.key} className="release-in-use">
                  <div className="in-use-text">
                    <span className="release-group">{release.label}</span>
                    <span className="muted">{[release.group !== '' ? release.group : null, sourceText(source)].filter((t): t is string => t !== null).join(', ')}</span>
                    <span className="muted num">
                      {plural(summary.episodes, 'episode')}, {plural(summary.tracks, 'track')}
                      {summary.languages.length > 0 && <>, {summary.languages.join(', ')}</>}, {plural(summary.fonts, 'font')}
                    </span>
                    {summary.unmatched > 0 && <span className="unmatched-note">{plural(summary.unmatched, 'file')} matched no episode of this disc.</span>}
                  </div>
                  <button type="button" className="quiet" aria-label={`Remove ${release.label}`} onClick={() => dispatch({ type: 'removeRelease', key: release.key })}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

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
                              {[r.isBest ? 'Best' : null, ...r.tags, r.dualAudio && !r.tags.some((t) => /dual/i.test(t)) ? 'Dual audio' : null, r.unavailable !== null ? UNAVAILABLE_TEXT[r.unavailable] : null, isChosen(r) ? 'Added' : null]
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
                <button type="button" className="release-row" aria-pressed={releaseOf(state, `tosho-${h.toshoId}`) !== null} disabled={fetching} onClick={() => void pickToshoRelease(h.toshoId, 'tosho')}>
                  <span className="release-group">{h.title}</span>
                  <span className="release-tags muted num">
                    {new Date(h.date * 1000).toISOString().slice(0, 10)}
                    {releaseOf(state, `tosho-${h.toshoId}`) !== null && ', Added'}
                  </span>
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

      <div className="step-next">
        <button type="button" className="primary" disabled={!anyEpisodeHasFile(state) || fetching} onClick={() => dispatch({ type: 'goTo', step: 2 })}>
          Next
        </button>
      </div>
    </div>
  );
}
