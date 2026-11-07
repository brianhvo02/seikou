import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ToshoReleaseFiles, ToshoSearchResult } from '@seikou/nas/nas-api';
import { fileLabel, LINING_UP, releaseDate, releaseLabel, sortTracks, trackLabel, type ToshoFile, type ToshoTrack } from './nas/tosho-search-model';

/** What the Subtitles menu's Anime Tosho search needs from the player (a NAS disc's), spec §9. */
export interface ToshoSearch {
  /** The search box's first words (defaultQuery). */
  readonly query: string;
  search(q: string): Promise<readonly ToshoSearchResult[]>;
  /** A release's files with their tracks, and the file of the episode playing. */
  release(id: number): Promise<ToshoReleaseFiles>;
  /** Lines a track up on the NAS and loads it as the viewer's pick; true once placed (a failure shows its own notice). */
  pick(releaseId: number, fileId: number, track: ToshoTrack): Promise<boolean>;
  /** The pick in the text set now, checked in its tracks. */
  readonly active: { readonly fileId: number; readonly track: number } | null;
}

type Step =
  | { readonly kind: 'query' }
  | { readonly kind: 'files'; readonly listed: ToshoReleaseFiles }
  /** `viaFiles`: Back goes to the release's files (no file matched the episode), else to the search. */
  | { readonly kind: 'tracks'; readonly listed: ToshoReleaseFiles; readonly file: ToshoFile; readonly viaFiles: boolean };

type Results = { readonly kind: 'idle' } | { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'done'; readonly items: readonly ToshoSearchResult[] };

/** The release's group, as its title's leading bracket names it (else the whole title), for the Back rows. */
const shortName = (r: ToshoSearchResult): string => /^\s*\[([^\]]+)\]/.exec(r.title)?.[1] ?? r.title;

/**
 * The search's steps inside the Subtitles menu (mockup A, one step per view so it fits a phone): the search box and the
 * releases, then the release's files when none matched the episode, then the file's tracks. Each step's first row goes
 * back a step; from the search, back to the menu (`onExit`). Renders the menu's rows (`li`) only.
 */
export function ToshoSearchView({ search, onExit }: { readonly search: ToshoSearch; onExit(): void }): ReactElement {
  const [step, setStep] = useState<Step>({ kind: 'query' });
  const [query, setQuery] = useState(search.query);
  // nothing to search with (no title or disc name): the empty box waits for words
  const [results, setResults] = useState<Results>(search.query.trim() === '' ? { kind: 'idle' } : { kind: 'loading' });
  const [opening, setOpening] = useState<number | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [liningUp, setLiningUp] = useState<string | null>(null);
  const live = useRef(true);
  const asked = useRef(0);
  const boxRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  /** The release row to focus when the search shows again. */
  const returnTo = useRef<number | null>(null);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = (q: string): void => {
    const words = q.trim();
    const n = ++asked.current;
    if (words === '') {
      setResults({ kind: 'idle' });
      return;
    }
    setResults({ kind: 'loading' });
    search.search(words).then(
      (items) => {
        if (live.current && n === asked.current) setResults({ kind: 'done', items });
      },
      (err: unknown) => {
        console.warn('searching Anime Tosho failed', err);
        if (live.current && n === asked.current) setResults({ kind: 'failed' });
      },
    );
  };
  // the first search, with the box's first words, once as the step opens
  useEffect(() => run(search.query), []);

  useEffect(() => {
    if (step.kind !== 'query') {
      backRef.current?.focus();
      return;
    }
    const back = returnTo.current;
    returnTo.current = null;
    const row = back === null ? null : document.querySelector<HTMLButtonElement>(`[data-testid="tosho-release-${back}"]`);
    (row ?? boxRef.current)?.focus();
  }, [step]);

  const open = (r: ToshoSearchResult): void => {
    setOpening(r.id);
    setOpenFailed(false);
    search.release(r.id).then(
      (listed) => {
        if (!live.current) return;
        setOpening(null);
        returnTo.current = r.id;
        const file = listed.files.find((f) => f.id === listed.matchedFileId);
        setStep(file ? { kind: 'tracks', listed, file, viaFiles: false } : { kind: 'files', listed });
      },
      (err: unknown) => {
        console.warn('listing the Anime Tosho release failed', err);
        if (!live.current) return;
        setOpening(null);
        setOpenFailed(true);
      },
    );
  };

  const pick = (listed: ToshoReleaseFiles, file: ToshoFile, t: ToshoTrack): void => {
    // one pick at a time; the rows stay enabled so the focus stays on the one picked
    if (liningUp !== null) return;
    const key = `${file.id}-${t.track}`;
    setLiningUp(key);
    void search.pick(listed.release.id, file.id, t).finally(() => {
      if (live.current) setLiningUp((k) => (k === key ? null : k));
    });
  };

  const back = (label: string, onClick: () => void): ReactElement => (
    <li role="none" className="tosho-back">
      <button ref={backRef} type="button" role="menuitem" data-testid="tosho-back" onClick={onClick}>
        ‹ {label}
      </button>
    </li>
  );
  const message = (text: string): ReactElement => (
    <li role="none" className="subtitle-group tosho-message" data-testid="tosho-message">
      {text}
    </li>
  );

  if (step.kind === 'files') {
    const toSearch = (): void => setStep({ kind: 'query' });
    return (
      <>
        {back(shortName(step.listed.release), toSearch)}
        {step.listed.files.length === 0 && message('No subtitle tracks in this release')}
        {step.listed.files.map((f) => (
          <li key={f.id} role="none">
            <button type="button" role="menuitem" data-testid={`tosho-file-${f.id}`} onClick={() => setStep({ kind: 'tracks', listed: step.listed, file: f, viaFiles: true })}>
              {fileLabel(f)}
            </button>
          </li>
        ))}
      </>
    );
  }

  if (step.kind === 'tracks') {
    const { listed, file } = step;
    const up = (): void => setStep(step.viaFiles ? { kind: 'files', listed } : { kind: 'query' });
    return (
      <>
        {back(`${shortName(listed.release)} · ${fileLabel(file)}`, up)}
        {sortTracks(file.tracks).map((t) => {
          const key = `${file.id}-${t.track}`;
          return (
            <li key={key} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={search.active?.fileId === file.id && search.active.track === t.track}
                data-testid={`tosho-track-${key}`}
                aria-busy={liningUp === key}
                onClick={() => pick(listed, file, t)}
              >
                {trackLabel(t)}
              </button>
            </li>
          );
        })}
        {liningUp !== null ? (
          <li role="status" className="subtitle-group" data-testid="tosho-status">
            {LINING_UP}
          </li>
        ) : (
          message('Lined up on this disc as it loads')
        )}
      </>
    );
  }

  return (
    <>
      {back('Search Anime Tosho', onExit)}
      <li role="none" className="tosho-query">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            run(query);
          }}
        >
          <input
            ref={boxRef}
            type="search"
            aria-label="Search Anime Tosho"
            data-testid="tosho-query"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
      </li>
      {results.kind === 'loading' && message('Searching…')}
      {results.kind === 'failed' && message("Couldn't reach Anime Tosho.")}
      {results.kind === 'done' && results.items.length === 0 && message('No releases found')}
      {openFailed && message("Couldn't list that release.")}
      {results.kind === 'done' &&
        results.items.map((r) => {
          const { text, badge } = releaseLabel(r);
          return (
            <li key={r.id} role="none">
              <button type="button" role="menuitem" className="tosho-release" data-testid={`tosho-release-${r.id}`} disabled={opening !== null} aria-busy={opening === r.id} onClick={() => open(r)}>
                <span className="tosho-release-title">{text}</span>
                {badge && <span className="tosho-badge">{badge}</span>}
                <span className="tosho-sub">{opening === r.id ? 'Loading…' : releaseDate(r)}</span>
              </button>
            </li>
          );
        })}
    </>
  );
}
