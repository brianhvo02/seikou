import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { OwnerChoice, TitleKind, TitleSummary, UnsortedItem, UnsortedReason, UnsortedSuggestion } from '../../engine/disc/nas-api';
import type { NasClient, SkippedDisc } from './nas-client';
import { Poster } from './Poster';
import { displayName } from './title-model';
import { applyNumber, blurayComSearchUrl, discPlace, extrasChoice, lookupFailure, mergeResults, parseNumber, reasonText, seasonOnPick, skippedText, suggestionLine, titleChoice } from './unsorted-model';
import { nameLang } from '../name-lang';

const PAGE = 50;
const MAX_NAME = 200;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The disc a filing card is for: an Unsorted item, or a hidden, filed or music disc being filed differently (no reason,
 * no suggestions).
 */
export interface FilingDisc {
  readonly discId: string;
  readonly path: string;
  readonly discTitles: UnsortedItem['discTitles'];
  readonly reason: UnsortedReason | null;
  readonly suggestions: readonly UnsortedSuggestion[];
  readonly catalogueNumber: string | null;
  readonly groupSize: number;
}

/** What a card tells its screen once the owner decided: the choice made and how to say it. */
export interface Filed {
  readonly disc: FilingDisc;
  readonly choice: OwnerChoice;
  readonly text: string;
}

interface DiscCardProps {
  readonly nas: NasClient;
  readonly disc: FilingDisc;
  /** Whether the NAS has a TMDB key; without one, search asks AniList and own titles only. */
  readonly tmdb: boolean;
  readonly onFiled: (filed: Filed) => void;
  /** An own title was created: the title list changed. */
  readonly onCreated: () => void;
  /** Skip, on the Unsorted screen; absent elsewhere. */
  readonly onSkip?: () => void;
}

const KINDS: readonly { readonly id: TitleKind; readonly label: string }[] = [
  { id: 'series', label: 'Series' },
  { id: 'movie', label: 'Movie' },
  { id: 'music', label: 'Music' },
];

/** "New title…" (ruling T11e): a kind, a name of at most 200 characters and, for a series, its number of seasons. */
function NewTitleForm({ nas, onCreated, onCancel }: { nas: NasClient; onCreated: (t: TitleSummary) => void; onCancel: () => void }): ReactElement {
  const id = useId();
  const [kind, setKind] = useState<TitleKind>('series');
  const [name, setName] = useState('');
  const [seasons, setSeasons] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Give the title a name.');
      return;
    }
    const count = kind === 'series' ? parseNumber(seasons) : null;
    if (count === undefined || (kind === 'series' && count === null)) {
      setError('Seasons is a number from 1 to 1000.');
      return;
    }
    setBusy(true);
    setError(null);
    nas.admin.createTitle(kind, trimmed, count).then(
      (t) => {
        setBusy(false);
        onCreated({
          id: t.id, kind: t.kind, names: { english: null, romaji: null, native: null, synonyms: [], display: t.name },
          poster: null, year: null, seasons: t.seasons ?? 0, discs: 0, addedAt: 0, own: true,
        });
      },
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      },
    );
  };

  return (
    <form className="owner-form" data-testid="new-title-form" onSubmit={submit}>
      <fieldset className="owner-kinds">
        <legend>Kind</legend>
        {KINDS.map((k) => (
          <label key={k.id} className="owner-radio">
            <input type="radio" name={`${id}-kind`} value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} /> {k.label}
          </label>
        ))}
      </fieldset>
      <label className="owner-field">
        <span>Name</span>
        <input type="text" data-testid="new-title-name" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
      </label>
      {kind === 'series' && (
        <label className="owner-field owner-number">
          <span>Seasons</span>
          <input type="text" inputMode="numeric" data-testid="new-title-seasons" value={seasons} onChange={(e) => setSeasons(e.target.value)} />
        </label>
      )}
      {error && (
        <p className="owner-message" role="alert">
          {error}
        </p>
      )}
      <div className="owner-buttons">
        <button type="submit" className="owner-primary" data-testid="new-title-create" disabled={busy}>
          Create
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function TitleOption({ nas, title, selected, onPick }: { nas: NasClient; title: TitleSummary; selected: boolean; onPick: () => void }): ReactElement {
  const name = displayName(title);
  return (
    <li>
      <button type="button" className={`owner-option${selected ? ' selected' : ''}`} aria-pressed={selected} data-testid="title-option" data-name={name} onClick={onPick}>
        <Poster nas={nas} artId={title.poster} name={name} size="small" className="owner-option-poster" />
        <span className="title-row-text">
          <span className="title-row-name" lang={nameLang(name)}>
            {name}
          </span>
          <span className="title-muted">{suggestionLine(title)}</span>
        </span>
      </button>
    </li>
  );
}

/** One disc to file (spec §9, mockup 4): why it's unsure, suggestions, search, season and disc, and the other choices. */
export function DiscCard({ nas, disc, tmdb, onFiled, onCreated, onSkip }: DiscCardProps): ReactElement {
  const id = useId();
  const [picked, setPicked] = useState<TitleSummary | null>(null);
  const [season, setSeason] = useState('');
  /** Whether Season holds a suggestion's hint rather than the owner's typing. */
  const [hinted, setHinted] = useState(false);
  const [discNo, setDiscNo] = useState('');
  /** Whether the disc goes with the title's or season's extras rather than its discs. */
  const [asExtras, setAsExtras] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TitleSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<TitleSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const place = discPlace(disc.path);
  const ownTitle = disc.discTitles[0]?.name ?? null;

  const pick = (t: TitleSummary | UnsortedSuggestion): void => {
    setPicked(t);
    // Season starts at the suggestion's hint; without one it is blank and must be given (ruling F2), but what the
    // owner typed stays (N2)
    const next = seasonOnPick(t, { season, hinted });
    setSeason(next.season);
    setHinted(next.hinted);
  };

  const choose = (choice: OwnerChoice, text: string): void => {
    setBusy(true);
    setError(null);
    nas.admin.setChoice(disc.discId, choice).then(
      () => {
        setBusy(false);
        onFiled({ disc, choice, text });
      },
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      },
    );
  };

  const fileUnder = (title: TitleSummary): void => {
    const s = parseNumber(season);
    if (asExtras) {
      // a blank season puts it with the title's own extras
      if (title.kind === 'series' && s === undefined) {
        setError('Season is a number from 1 to 1000, or blank for the title\'s extras.');
        return;
      }
      const choice = extrasChoice(title, s ?? null);
      const where = choice.kind === 'extras' && choice.season !== null ? `season ${choice.season} of ${displayName(title)}` : displayName(title);
      choose(choice, `Filed with the extras of ${where}.`);
      return;
    }
    const d = parseNumber(discNo);
    if (title.kind === 'series' && (s === undefined || s === null)) {
      setError('Season is a number from 1 to 1000.');
      return;
    }
    if (d === undefined) {
      setError('Disc / volume is a number from 1 to 1000, or blank.');
      return;
    }
    choose(titleChoice(title, s ?? null, d), `Filed under ${displayName(title)}.`);
  };

  /** Search runs on submit (ruling T11a): own titles, then AniList, then TMDB, one source at a time as the NAS allows. */
  const search = (e: FormEvent): void => {
    e.preventDefault();
    const q = query.trim();
    if (q === '' || searching) return;
    setSearching(true);
    setSearchNote(null);
    void (async () => {
      const lists: TitleSummary[][] = [];
      let note: string | null = null;
      for (const source of ['own', 'anilist', ...(tmdb ? ['tmdb' as const] : [])] as const) {
        try {
          lists.push(await nas.admin.lookup(q, source));
        } catch (err) {
          note = lookupFailure(err);
          break;
        }
      }
      const found = mergeResults(lists);
      setResults(found);
      // a picked title that is no longer on screen isn't filed by mistake
      setPicked((p) => (p !== null && (found.some((t) => t.id === p.id) || disc.suggestions.slice(0, 3).some((t) => t.id === p.id)) ? p : null));
      setSearchNote(note ?? (found.length === 0 ? `Nothing found for “${q}”.` : null));
      setSearching(false);
    })();
  };

  const seasonUsed = picked === null || picked.kind === 'series';
  return (
    <article className="owner-card" data-testid="unsorted-card" data-folder={place.name} data-disc-id={disc.discId}>
      {disc.reason !== null && (
        <p className="owner-why" data-testid="unsorted-reason">
          Why unsure: {reasonText(disc.reason)}
        </p>
      )}
      <div className="owner-disc">
        <strong className="owner-disc-name" lang={nameLang(place.name)}>
          {place.name}
        </strong>
        {place.parent !== '' && <span className="title-muted">{place.parent}</span>}
        {ownTitle !== null && ownTitle !== place.name && <span className="title-muted">{ownTitle}</span>}
      </div>
      {disc.suggestions.length > 0 && (
        <>
          <h4 className="owner-subhead">Suggestions</h4>
          <ul className="owner-options" aria-label="Suggestions">
            {disc.suggestions.slice(0, 3).map((t) => (
              <TitleOption key={t.id} nas={nas} title={t} selected={picked?.id === t.id} onPick={() => pick(t)} />
            ))}
          </ul>
        </>
      )}
      <form className="owner-search" role="search" onSubmit={search}>
        <label className="visually-hidden" htmlFor={`${id}-q`}>
          Search AniList, TMDB and own titles
        </label>
        <input
          id={`${id}-q`}
          type="search"
          className="title-search"
          data-testid="unsorted-search"
          placeholder="Search AniList, TMDB and own titles"
          maxLength={MAX_NAME}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" data-testid="unsorted-search-button" disabled={searching || query.trim() === ''}>
          Search
        </button>
      </form>
      {searching && <p className="status">Searching…</p>}
      {searchNote && (
        <p className="owner-message" role="status" data-testid="unsorted-search-note">
          {searchNote}
        </p>
      )}
      {results !== null && results.length > 0 && (
        <ul className="owner-options" aria-label="Search results">
          {results.map((t) => (
            <TitleOption key={t.id} nas={nas} title={t} selected={picked?.id === t.id} onPick={() => pick(t)} />
          ))}
        </ul>
      )}
      <div className="owner-numbers">
        <label className="owner-field">
          <span>Season</span>
          <input type="text" inputMode="numeric" data-testid="unsorted-season" value={season} disabled={!seasonUsed} onChange={(e) => {
            setSeason(e.target.value);
            setHinted(false);
          }} />
        </label>
        <label className="owner-field">
          <span>Disc / volume</span>
          <input type="text" inputMode="numeric" data-testid="unsorted-disc" value={discNo} disabled={asExtras} onChange={(e) => setDiscNo(e.target.value)} />
        </label>
      </div>
      <label className="owner-check">
        <input type="checkbox" data-testid="unsorted-extras" checked={asExtras} onChange={(e) => setAsExtras(e.target.checked)} /> Extras (a bonus disc)
      </label>
      {asExtras && seasonUsed && <p className="status">Season blank: with the title's extras.</p>}
      {error && (
        <p className="owner-message" role="alert" data-testid="unsorted-error">
          {error}
        </p>
      )}
      <button type="button" className="owner-primary" data-testid="unsorted-file" disabled={busy || picked === null} onClick={() => picked && fileUnder(picked)}>
        File it
      </button>
      {created ? (
        <div className="owner-notice" data-testid="new-title-created">
          <p>Created “{displayName(created)}”. File this disc under it?</p>
          <div className="owner-buttons">
            <button type="button" className="owner-primary" data-testid="new-title-file" disabled={busy} onClick={() => fileUnder(created)}>
              File it under {displayName(created)}
            </button>
            <button type="button" data-testid="new-title-later" onClick={() => setCreated(null)}>
              Not now
            </button>
          </div>
        </div>
      ) : creating ? (
        <NewTitleForm
          nas={nas}
          onCancel={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setCreated(t);
            pick(t);
            onCreated();
          }}
        />
      ) : null}
      <div className="owner-links">
        <button type="button" className="title-link" onClick={() => setCreating(true)} disabled={creating}>
          New title…
        </button>
        <button type="button" className="title-link" data-testid="unsorted-music" disabled={busy} onClick={() => choose({ kind: 'music', name: null }, 'Marked as Music.')}>
          Mark as Music
        </button>
        <button type="button" className="title-link" data-testid="unsorted-hide" disabled={busy} onClick={() => choose({ kind: 'hidden' }, 'Not listed. It stays in the folder view, and Hidden can undo it.')}>
          Don't list
        </button>
        {onSkip && (
          <button type="button" className="title-link" data-testid="unsorted-skip" onClick={onSkip}>
            Skip
          </button>
        )}
      </div>
      {disc.catalogueNumber !== null && (
        <p className="title-muted owner-catalogue">
          <a href={blurayComSearchUrl(disc.catalogueNumber)} target="_blank" rel="noopener noreferrer" data-testid="unsorted-bluray-com">
            Look up {disc.catalogueNumber} on Blu-ray.com
          </a>
        </p>
      )}
    </article>
  );
}

interface Notice {
  readonly text: string;
  /** "Apply to the other N discs in this folder", offered after filing one disc of a group under a title. */
  readonly apply?: { readonly disc: FilingDisc; readonly choice: OwnerChoice; readonly others: number };
  /** Discs "apply" left as they were (ruling T11c), with their folder. */
  readonly skipped?: readonly { readonly discId: string; readonly folder: string; readonly reason: SkippedDisc['reason'] }[];
}

interface UnsortedScreenProps {
  readonly nas: NasClient;
  readonly tmdb: boolean;
  readonly onBack: () => void;
  readonly onHidden: () => void;
  /** An owner change altered the catalogue: the library fetches its titles again. */
  readonly onChanged: () => void;
}

/** Unsorted (spec §9, mockup 4), for owners: each disc the NAS couldn't file, with what to do about it. */
export function UnsortedScreen({ nas, tmdb, onBack, onHidden, onChanged }: UnsortedScreenProps): ReactElement {
  const [items, setItems] = useState<UnsortedItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [applying, setApplying] = useState(false);
  /** The Disc / volume field of the apply offer: the server numbers the other discs from it (ruling T11h). */
  const [applyDisc, setApplyDisc] = useState('');
  const noticeRef = useRef<HTMLDivElement>(null);
  // a decision unmounts its card and the focused control with it: focus goes to the notice saying what happened
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  /** Loads the first `count` items again (after a change, the list shifts). */
  const load = useCallback(
    (count: number): Promise<void> =>
      nas.admin.unsorted(0, Math.max(count, PAGE)).then(
        (page) => {
          setItems(page.items);
          setTotal(page.total);
          setError(null);
        },
        (err: unknown) => setError(message(err)),
      ),
    [nas],
  );
  useEffect(() => {
    void load(PAGE);
  }, [load]);

  const more = (): void => {
    const have = items?.length ?? 0;
    nas.admin.unsorted(have, PAGE).then(
      (page) => {
        setItems((list) => [...(list ?? []), ...page.items]);
        setTotal(page.total);
      },
      (err: unknown) => setError(message(err)),
    );
  };

  const folderOf = (discId: string): string => {
    const item = items?.find((i) => i.discId === discId);
    // a disc filed separately is no longer in Unsorted, so its folder isn't known here
    return item ? discPlace(item.path).name : 'A disc in this folder';
  };

  const onFiled = ({ disc, choice, text }: Filed): void => {
    const others = disc.groupSize - 1;
    setNotice(choice.kind === 'title' && others > 0 ? { text, apply: { disc, choice, others } } : { text });
    setApplyDisc(choice.kind === 'title' && choice.disc !== null ? String(choice.disc) : '');
    onChanged();
    void load(items?.length ?? PAGE);
  };

  const applyToGroup = (apply: NonNullable<Notice['apply']>, disc: number): void => {
    setApplying(true);
    const choice = apply.choice.kind === 'title' ? { ...apply.choice, disc } : apply.choice;
    nas.admin.setChoice(apply.disc.discId, choice, true).then(
      (left) => {
        setApplying(false);
        const filed = apply.others - left.length;
        setNotice({
          text: filed > 0 ? `Filed ${plural(filed, 'more disc')} from this folder.` : 'No other disc in this folder was filed.',
          ...(left.length > 0 ? { skipped: left.map((s) => ({ discId: s.discId, folder: folderOf(s.discId), reason: s.reason })) } : {}),
        });
        onChanged();
        void load(items?.length ?? PAGE);
      },
      (err: unknown) => {
        setApplying(false);
        setNotice((n) => (n ? { ...n, text: `${n.text} ${message(err)}` } : n));
      },
    );
  };

  const shown = items?.filter((i) => !skipped.has(i.discId)) ?? [];
  return (
    <section className="titles owner-screen" data-testid="unsorted-screen">
      <header className="season-head">
        <button type="button" className="title-back" aria-label="Back to the library" onClick={onBack}>
          <span aria-hidden="true">‹</span>
        </button>
        <div className="season-head-text">
          <h2 tabIndex={-1} data-focus-heading>
            Unsorted
          </h2>
          {items !== null && <span className="title-muted">{total === 1 ? '1 disc isn’t filed under a title' : `${total} discs aren’t filed under a title`}</span>}
        </div>
      </header>
      {notice && (
        <div className="owner-notice" role="status" data-testid="unsorted-notice" ref={noticeRef} tabIndex={-1}>
          <p>{notice.text}</p>
          {notice.apply && (
            <>
              <label className="owner-field owner-number">
                <span>Disc / volume of {discPlace(notice.apply.disc.path).name}</span>
                <input type="text" inputMode="numeric" data-testid="unsorted-apply-disc" value={applyDisc} onChange={(e) => setApplyDisc(e.target.value)} />
              </label>
              {applyNumber(applyDisc) === null && (
                <p className="owner-message" data-testid="unsorted-apply-hint">
                  Enter this disc's number first
                </p>
              )}
              <div className="owner-buttons">
                <button
                  type="button"
                  className="owner-primary"
                  data-testid="unsorted-apply"
                  disabled={applying || applyNumber(applyDisc) === null}
                  onClick={() => {
                    const n = applyNumber(applyDisc);
                    if (n !== null) applyToGroup(notice.apply!, n);
                  }}
                >
                  Apply to the other {plural(notice.apply.others, 'disc')} in this folder
                </button>
                <button type="button" onClick={() => setNotice(null)}>
                  No thanks
                </button>
              </div>
            </>
          )}
          {notice.skipped && (
            <>
              <p>These were left as they were:</p>
              <ul className="owner-skipped" data-testid="unsorted-skipped">
                {notice.skipped.map((s) => (
                  <li key={s.discId}>
                    {s.folder} <span className="title-muted">({skippedText(s.reason)})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-error">
          {error}
        </div>
      )}
      {items === null ? (
        !error && <p className="status">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="status">{skipped.size > 0 ? 'You skipped the rest. They come back next time.' : 'Nothing is unsorted.'}</p>
      ) : (
        <div className="owner-cards">
          {shown.map((item) => (
            <DiscCard
              key={item.discId}
              nas={nas}
              disc={item}
              tmdb={tmdb}
              onFiled={onFiled}
              onCreated={onChanged}
              onSkip={() => setSkipped((s) => new Set(s).add(item.discId))}
            />
          ))}
        </div>
      )}
      {items !== null && items.length < total && (
        <button type="button" onClick={more}>
          Show more
        </button>
      )}
      <button type="button" className="title-link" data-testid="open-hidden" onClick={onHidden}>
        Hidden discs
      </button>
    </section>
  );
}
