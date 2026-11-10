// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TitleHit } from '../api-types';
import type { AppApi } from './app-api';
import type { EpisodeRow } from './episode-info-model';

/** What one episode's AniList line needs. */
export interface EpisodeAniListProps {
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
  /** An entry was picked for this episode. */
  readonly onPick: (hit: TitleHit) => void;
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

/**
 * One episode's AniList entry and number: the entry's cover and name, the number (a field; a new one renumbers the
 * episodes after it in the same entry), AniList's episode title, a "Suggested" mark on a prefill not yet saved, and
 * Change (Choose when there is none), which opens a search under the line with the entry's next season offered first.
 */
export function EpisodeAniList({ api, row, show, sequel, disabled, onPick, onNumber }: EpisodeAniListProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TitleHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const seq = useRef(0);
  const episode = row.anilist?.episode ?? null;
  const [numberText, setNumberText] = useState(episode === null ? '' : String(episode));
  const [numberError, setNumberError] = useState(false);
  useEffect(() => {
    setNumberText(episode === null ? '' : String(episode));
    setNumberError(false);
  }, [episode]);

  const search = (e: FormEvent): void => {
    e.preventDefault();
    const text = query.trim();
    if (text === '') return;
    const mine = ++seq.current;
    setSearching(true);
    setSearchError(null);
    Promise.resolve()
      .then(() => api.searchAniList(text))
      .then(
        (found) => {
          if (mine === seq.current) setHits(found);
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

  const pick = (hit: TitleHit): void => {
    seq.current += 1;
    setOpen(false);
    setHits(null);
    setQuery('');
    setSearching(false);
    onPick(hit);
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

  const name = row.anilist === null ? null : (show?.title ?? `AniList ${row.anilist.anilistId}`);
  const offerSequel = sequel !== null && sequel.alId !== row.anilist?.anilistId;

  return (
    <div className={`episode-anilist${row.prefilled ? ' episode-anilist-suggested' : ''}`}>
      <div className="episode-anilist-line">
        {row.anilist !== null && <Cover hit={show} className="cover cover-small" />}
        <div className="episode-anilist-text">
          {name === null ? (
            <span className="muted">No AniList entry</span>
          ) : (
            <span className="episode-anilist-show">
              {name}
              {row.prefilled && <span className="mark"> Suggested</span>}
            </span>
          )}
          {row.anilist !== null && (
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
              {row.anilist.title !== null && <span className="episode-anilist-title">{row.anilist.title}</span>}
            </span>
          )}
          {numberError && <span className="error">Use a whole number from 1.</span>}
        </div>
        <button
          type="button"
          className="quiet"
          aria-expanded={open}
          aria-label={`${row.anilist === null ? 'Choose' : 'Change'} the AniList entry of episode ${row.index}`}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          {row.anilist === null ? 'Choose' : 'Change'}
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
            <input type="search" aria-label={`Search AniList for episode ${row.index}`} placeholder="Search AniList" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button type="submit" className="quiet" disabled={searching}>
              Search
            </button>
          </form>
          {searchError !== null && (
            <p className="error" role="alert">
              {searchError}
            </p>
          )}
          {hits !== null && hits.length === 0 && <p className="muted">AniList found nothing for that. Try another spelling.</p>}
          {hits !== null && hits.length > 0 && (
            <ul className="results">
              {hits.map((hit) => (
                <li key={hit.alId}>
                  <HitButton hit={hit} onPick={() => pick(hit)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
