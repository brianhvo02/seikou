// SPDX-License-Identifier: LGPL-3.0-or-later
import type { EncodeTitle } from '@seikou/nas/encode-title';
import type { TitleSummary } from '@seikou/nas/nas-api';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TitleHit } from '../api-types';
import type { AppApi } from './app-api';
import { aniListIdOf, type EpisodeRow } from './episode-info-model';

/** What one episode's title line needs. */
export interface EpisodeTitlePickerProps {
  /** The backend client, for the search. */
  readonly api: AppApi;
  /** The episode's row. */
  readonly row: EpisodeRow;
  /** The row's entry as AniList names it; null while unknown (not loaded, or the lookup failed). */
  readonly show: TitleHit | null;
  /** The next season of the row's entry, offered first in Change; null when there is none or it is unknown. */
  readonly sequel: TitleHit | null;
  /** True while the choices cannot be changed. */
  readonly disabled: boolean;
  /** True when the encoder is paired with a NAS: the search then covers AniList, TMDB and the owner's own titles, and a title can be added by hand. */
  readonly nasPaired?: boolean;
  /** The season to offer first for a series the NAS has not matched this disc to (from the NAS's match; 1 without). */
  readonly seasonHint?: number | null;
  /** An AniList entry was picked for this episode. */
  readonly onPick: (hit: TitleHit) => void;
  /** A title of another source was picked (a TMDB season or film, an own title), with the show's name for the file's `TITLE_NAME`. */
  readonly onPickTitle?: (title: EncodeTitle, showName: string) => void;
  /** The episode's number in its entry was changed. */
  readonly onNumber: (episode: number) => void;
}

/** A show's year and format, as far as AniList knows them. */
function facts(hit: TitleHit): string {
  return [hit.year === null ? null : String(hit.year), hit.format].filter((p): p is string => p !== null).join(', ');
}

/** A show's cover, or an empty frame of the same size. */
function Cover({ hit, className }: { readonly hit: TitleHit | null; readonly className: string }) {
  return hit !== null && hit.poster !== null ? <img className={className} src={hit.poster} alt="" loading="lazy" /> : <span className={className} aria-hidden="true" />;
}

/** A pickable show: its cover, its name and its facts. */
function HitButton({ hit, label, onPick }: { readonly hit: TitleHit; readonly label?: string; readonly onPick: () => void }) {
  return (
    <button type="button" className="show-row" onClick={onPick}>
      <Cover hit={hit} className="cover cover-small" />
      <span className="show-text">
        {label !== undefined && <span className="mark">{label}</span>}
        <span className="show-title">{hit.title}</span>
        <span className="muted num">{facts(hit)}</span>
      </span>
    </button>
  );
}

/** A NAS result's name: the owner's own name, else English, romaji, native. */
function summaryName(t: TitleSummary): string {
  return t.names.display ?? t.names.english ?? t.names.romaji ?? t.names.native ?? t.id;
}

/** Which source a NAS result came from, for its mark. */
function sourceMark(t: TitleSummary): string {
  return t.own ? 'Yours' : t.id.startsWith('tmdb-') ? 'TMDB' : 'AniList';
}

/** A result's year and shape: `2019, 2 seasons`, `2020, film`. */
function summaryFacts(t: TitleSummary): string {
  const shape = t.kind === 'movie' ? 'film' : t.seasons > 0 ? `${t.seasons} season${t.seasons === 1 ? '' : 's'}` : null;
  return [t.year === null ? null : String(t.year), shape].filter((p): p is string => p !== null).join(', ');
}

/** The AniList entry of a NAS result `anilist:<n>`, as the page's `TitleHit`; its poster is the backend's route (`lookupTitles` made it a URL). */
function hitOf(t: TitleSummary): TitleHit {
  return { alId: Number(t.id.slice('anilist:'.length)), title: summaryName(t), nativeTitle: t.names.native, year: t.year, format: null, episodes: null, poster: t.poster };
}

/** A title of another source, as the rows show it: its show name and, when it has one, its season. */
function otherTitleName(t: EncodeTitle, showName: string | null | undefined): string {
  const name = showName ?? 'Chosen title';
  return 'season' in t && t.season !== null ? `${name}, season ${t.season}` : name;
}

/** A pickable NAS result: its source, name and facts. */
function SummaryButton({ title, onPick }: { readonly title: TitleSummary; readonly onPick: () => void }) {
  return (
    <button type="button" className="show-row" onClick={onPick}>
      {title.poster === null ? <span className="cover cover-small" aria-hidden="true" /> : <img className="cover cover-small" src={title.poster} alt="" loading="lazy" />}
      <span className="show-text">
        <span className="mark">{sourceMark(title)}</span>
        <span className="show-title">{summaryName(title)}</span>
        <span className="muted num">{summaryFacts(title)}</span>
      </span>
    </button>
  );
}

/** A season number from the text, or null when it is not a whole number from 1. */
function seasonOf(text: string): number | null {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null;
}

/** The season a picked series is used for: a number field with its own error, so no series is chosen without one. */
function SeasonForm({ name, initial, onUse }: { readonly name: string; readonly initial: number; readonly onUse: (season: number) => void }) {
  const [text, setText] = useState(String(initial));
  const [bad, setBad] = useState(false);
  const use = (e: FormEvent): void => {
    e.preventDefault();
    const season = seasonOf(text);
    setBad(season === null);
    if (season !== null) onUse(season);
  };
  return (
    <form className="title-season" onSubmit={use}>
      <label>
        <span className="muted">Season</span>
        <input type="number" className="num" min={1} step={1} aria-label={`Season of ${name}`} aria-invalid={bad} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button type="submit" className="quiet">
        Use this season
      </button>
      {bad && <span className="error">Use a whole number from 1.</span>}
    </form>
  );
}

/** Add by hand: a name, series or film, and the season for a series; made on the NAS as an own title. */
function ByHandForm({ api, initialSeason, onMade }: { readonly api: AppApi; readonly initialSeason: number; readonly onMade: (title: EncodeTitle, name: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'series' | 'movie'>('series');
  const [season, setSeason] = useState(String(initialSeason));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const make = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    const n = seasonOf(season);
    if (trimmed === '') return setError('Give the title a name.');
    if (kind === 'series' && n === null) return setError('Use a whole number from 1 for the season.');
    setError(null);
    setBusy(true);
    api.createOwnTitle({ kind, name: trimmed, seasons: kind === 'series' ? n : null }).then(
      (made) => onMade({ source: 'own', ownId: made.id.replace(/^own:/, ''), season: kind === 'series' ? n : null }, trimmed),
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  return (
    <form className="title-by-hand" onSubmit={make}>
      <label>
        <span className="muted">Name</span>
        <input type="text" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset>
        <legend className="muted">Kind</legend>
        <label>
          <input type="radio" name="own-kind" checked={kind === 'series'} onChange={() => setKind('series')} /> Series
        </label>
        <label>
          <input type="radio" name="own-kind" checked={kind === 'movie'} onChange={() => setKind('movie')} /> Film
        </label>
      </fieldset>
      {kind === 'series' && (
        <label>
          <span className="muted">Season</span>
          <input type="number" className="num" min={1} step={1} aria-label="Season" value={season} onChange={(e) => setSeason(e.target.value)} />
        </label>
      )}
      <button type="submit" className="quiet" disabled={busy}>
        Add and use
      </button>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * One episode's title and number: the entry's cover and name, the number (a field; a new one renumbers the
 * episodes after it in the same entry), AniList's episode title, a "Suggested" mark on a prefill not yet saved, and
 * Change (Choose when there is none), which opens a search under the line with the entry's next season offered first.
 * Paired with a NAS the search asks the NAS for AniList, TMDB and the owner's own titles at once (AniList first, then
 * TMDB, then own; a source that does not answer is named and the rest listed), a TMDB series or own series asks its
 * season before it is used, and Add by hand makes an own title on the NAS. Unpaired it searches AniList only.
 */
export function EpisodeTitlePicker({ api, row, show, sequel, disabled, nasPaired = false, seasonHint = null, onPick, onPickTitle, onNumber }: EpisodeTitlePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TitleHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [found, setFound] = useState<TitleSummary[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [season, setSeason] = useState<TitleSummary | null>(null);
  const [byHand, setByHand] = useState(false);
  const seq = useRef(0);
  /** Stops the lookups of the search it belongs to when another search or a pick replaces it. */
  const lookups = useRef<AbortController | null>(null);
  const episode = row.title?.episode ?? null;
  const [numberText, setNumberText] = useState(episode === null ? '' : String(episode));
  const [numberError, setNumberError] = useState(false);
  useEffect(() => () => lookups.current?.abort(), []);
  useEffect(() => {
    setNumberText(episode === null ? '' : String(episode));
    setNumberError(false);
  }, [episode]);

  const search = (e: FormEvent): void => {
    e.preventDefault();
    const text = query.trim();
    if (text === '') return;
    const mine = ++seq.current;
    lookups.current?.abort();
    const stop = new AbortController();
    lookups.current = stop;
    setSearching(true);
    setSearchError(null);
    setSkipped([]);
    setSeason(null);
    if (nasPaired) {
      const sources = [
        ['AniList', 'anilist'],
        ['TMDB', 'tmdb'],
        ['your own titles', 'own'],
      ] as const;
      Promise.allSettled(sources.map(([, source]) => Promise.resolve().then(() => api.lookupTitles(text, source, stop.signal)))).then((answers) => {
        if (mine !== seq.current) return;
        setSearching(false);
        const ok = answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : []));
        const failed = answers.flatMap((a, i) => (a.status === 'rejected' ? [i] : []));
        setSkipped(failed.map((i) => sources[i]![0]));
        if (failed.length === answers.length) {
          setFound(null);
          setSearchError(failed.map((i) => `${sources[i]![0]}: ${answers[i]!.status === 'rejected' && (answers[i] as PromiseRejectedResult).reason instanceof Error ? ((answers[i] as PromiseRejectedResult).reason as Error).message : 'no answer'}`).join(' '));
        } else {
          setFound(ok);
        }
      });
      return;
    }
    Promise.resolve()
      .then(() => api.searchAniList(text))
      .then(
        (list) => {
          if (mine === seq.current) setHits(list);
        },
        (err: unknown) => {
          if (mine !== seq.current) return;
          setHits(null);
          setSearchError(err instanceof Error ? err.message : String(err));
        },
      )
      .finally(() => {
        if (mine === seq.current) setSearching(false);
      });
  };

  const close = (): void => {
    seq.current += 1;
    lookups.current?.abort();
    setOpen(false);
    setHits(null);
    setFound(null);
    setSkipped([]);
    setSeason(null);
    setByHand(false);
    setQuery('');
    setSearching(false);
  };
  const pick = (hit: TitleHit): void => {
    close();
    onPick(hit);
  };
  const pickTitle = (title: EncodeTitle, showName: string): void => {
    close();
    onPickTitle?.(title, showName);
  };
  /** A NAS result chosen: an AniList entry at once, a film at once, a series after its season is asked. */
  const pickSummary = (t: TitleSummary): void => {
    if (t.id.startsWith('anilist:')) return pick(hitOf(t));
    if (t.id.startsWith('tmdb-movie:')) return pickTitle({ source: 'tmdb-movie', tmdbId: Number(t.id.slice('tmdb-movie:'.length)) }, summaryName(t));
    if (t.id.startsWith('own:') && t.kind === 'movie') return pickTitle({ source: 'own', ownId: t.id.slice('own:'.length), season: null }, summaryName(t));
    setSeason(t);
  };
  const useSeason = (t: TitleSummary, n: number): void => {
    if (t.id.startsWith('own:')) pickTitle({ source: 'own', ownId: t.id.slice('own:'.length), season: n }, summaryName(t));
    else pickTitle({ source: 'tmdb-tv', tmdbId: Number(t.id.slice('tmdb-tv:'.length)), season: n }, summaryName(t));
  };

  const commitNumber = (): void => {
    const n = Number(numberText);
    if (numberText.trim() === '' || !Number.isInteger(n) || n < 1) {
      setNumberError(true);
      return;
    }
    setNumberError(false);
    if (n !== episode) onNumber(n);
  };

  const alId = aniListIdOf(row.title);
  const name = row.title === null ? null : alId === null ? otherTitleName(row.title.title, row.title.showName) : (show?.title ?? `AniList ${alId}`);
  const offerSequel = sequel !== null && sequel.alId !== alId;

  return (
    <div className={`episode-anilist${row.prefilled ? ' episode-anilist-suggested' : ''}`}>
      <div className="episode-anilist-line">
        {row.title !== null && <Cover hit={show} className="cover cover-small" />}
        <div className="episode-anilist-text">
          {name === null ? (
            <span className="muted">{nasPaired ? 'No title' : 'No AniList entry'}</span>
          ) : (
            <span className="episode-anilist-show">
              {name}
              {row.prefilled && <span className="mark"> Suggested</span>}
            </span>
          )}
          {row.title !== null && (
            <span className="episode-anilist-number">
              <label>
                <span className="muted">Episode</span>
                <input
                  type="number"
                  className="num"
                  min={1}
                  step={1}
                  aria-label={`AniList episode number of episode ${row.index}`}
                  aria-invalid={numberError}
                  value={numberText}
                  disabled={disabled}
                  onChange={(e) => setNumberText(e.target.value)}
                  onBlur={commitNumber}
                  onKeyDown={(e) => e.key === 'Enter' && commitNumber()}
                />
              </label>
              {row.title.name !== null && <span className="episode-anilist-title">{row.title.name}</span>}
            </span>
          )}
          {numberError && <span className="error">Use a whole number from 1.</span>}
        </div>
        <button
          type="button"
          className="quiet"
          aria-expanded={open}
          aria-label={`${row.title === null ? 'Choose' : 'Change'} the AniList entry of episode ${row.index}`}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          {row.title === null ? 'Choose title' : 'Change title'}
        </button>
      </div>
      {open && (
        <div className="episode-anilist-change">
          {offerSequel && (
            <ul className="results">
              <li>
                <HitButton hit={sequel} label="Next season" onPick={() => pick(sequel)} />
              </li>
            </ul>
          )}
          <form className="search" role="search" onSubmit={search}>
            <input
              type="search"
              aria-label={nasPaired ? `Search for episode ${row.index}` : `Search AniList for episode ${row.index}`}
              placeholder={nasPaired ? 'Search AniList, TMDB and your titles' : 'Search AniList'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="quiet" disabled={searching}>
              Search
            </button>
          </form>
          {searchError !== null && (
            <p className="error" role="alert">
              {searchError}
            </p>
          )}
          {skipped.length > 0 && searchError === null && (
            <p className="error" role="alert">
              {skipped.join(' and ')} did not answer. The rest is listed.
            </p>
          )}
          {!nasPaired && hits !== null && hits.length === 0 && <p className="muted">AniList found nothing for that. Try another spelling.</p>}
          {!nasPaired && hits !== null && hits.length > 0 && (
            <ul className="results">
              {hits.map((hit) => (
                <li key={hit.alId}>
                  <HitButton hit={hit} onPick={() => pick(hit)} />
                </li>
              ))}
            </ul>
          )}
          {nasPaired && found !== null && found.length === 0 && <p className="muted">Nothing found for that. Try another spelling, or add it by hand.</p>}
          {nasPaired && found !== null && found.length > 0 && (
            <ul className="results">
              {found.map((t) => (
                <li key={t.id}>
                  <SummaryButton title={t} onPick={() => pickSummary(t)} />
                </li>
              ))}
            </ul>
          )}
          {nasPaired && season !== null && <SeasonForm key={season.id} name={summaryName(season)} initial={seasonHint ?? 1} onUse={(n) => useSeason(season, n)} />}
          {nasPaired && (
            <div className="title-by-hand-box">
              <button type="button" className="quiet" aria-expanded={byHand} onClick={() => setByHand((b) => !b)}>
                Add by hand
              </button>
              {byHand && <ByHandForm api={api} initialSeason={seasonHint ?? 1} onMade={pickTitle} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
