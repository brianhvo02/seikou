import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { DiscRef } from '../../engine/disc/nas-api';
import { NasHttpError, type NasClient } from './nas-client';
import { DiscCard } from './UnsortedScreen';
import { nameLang } from '../name-lang';

interface HiddenScreenProps {
  readonly nas: NasClient;
  readonly tmdb: boolean;
  readonly onBack: () => void;
  /** An owner change altered the catalogue: the library fetches its titles again. */
  readonly onChanged: () => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const lastSegment = (folder: string): string => folder.slice(folder.lastIndexOf('/') + 1);

/** A hidden copy whose choice follows its source's (ruling T11b): what to do instead of unhiding it. */
interface FollowsCopy {
  readonly discId: string;
  /** The source's folder, when it is known here. */
  readonly sourceFolder: string | null;
  readonly filing: boolean;
}

/** Hidden (spec §9), for owners: discs left out of the title library with "Don't list", each with Unhide. */
export function HiddenScreen({ nas, tmdb, onBack, onChanged }: HiddenScreenProps): ReactElement {
  const [discs, setDiscs] = useState<DiscRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [follows, setFollows] = useState<FollowsCopy | null>(null);
  /** After Unhide, focus goes to the row now at the unhidden one's place, else the heading. */
  const focusAt = useRef<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusAt.current === null || discs === null) return;
    const at = focusAt.current;
    focusAt.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-testid="hidden-unhide"]') ?? [];
    (buttons[Math.min(at, buttons.length - 1)] ?? headingRef.current)?.focus();
  }, [discs]);

  const load = useCallback(
    (): Promise<void> =>
      nas.admin.hidden().then(
        (list) => {
          setDiscs(list);
          setError(null);
        },
        (err: unknown) => setError(message(err)),
      ),
    [nas],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const working = (id: string, on: boolean): void =>
    setBusy((ids) => {
      const next = new Set(ids);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const changed = (): void => {
    setFollows(null);
    onChanged();
    void load();
  };

  const unhide = (disc: DiscRef): void => {
    working(disc.discId, true);
    setError(null);
    nas.admin.clearChoice(disc.discId).then(
      () => {
        working(disc.discId, false);
        focusAt.current = discs?.findIndex((d) => d.discId === disc.discId) ?? 0;
        changed();
      },
      (err: unknown) => {
        working(disc.discId, false);
        if (err instanceof NasHttpError && err.status === 409 && err.code === 'copy-follows-source') {
          const source = discs?.find((d) => d.discId === err.detail.source);
          setFollows({ discId: disc.discId, sourceFolder: source ? `${source.root}/${source.folder}` : null, filing: false });
        } else {
          setError(message(err));
        }
      },
    );
  };

  /** "Don't list this copy": a hidden choice of its own, so it no longer follows its source. */
  const hideOwn = (discId: string): void => {
    working(discId, true);
    setError(null);
    nas.admin.setChoice(discId, { kind: 'hidden' }).then(
      () => {
        working(discId, false);
        changed();
      },
      (err: unknown) => {
        working(discId, false);
        setError(message(err));
      },
    );
  };

  return (
    <section className="titles owner-screen" data-testid="hidden-screen">
      <header className="season-head">
        <button type="button" className="title-back" aria-label="Back to Unsorted" onClick={onBack}>
          <span aria-hidden="true">‹</span>
        </button>
        <div className="season-head-text">
          <h2 tabIndex={-1} data-focus-heading ref={headingRef}>
            Hidden
          </h2>
          <span className="title-muted">Left out of the title library for everyone. They stay in the folder view.</span>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-error">
          {error}
        </div>
      )}
      {discs === null ? (
        !error && <p className="status">Loading…</p>
      ) : discs.length === 0 ? (
        <p className="status">No hidden discs.</p>
      ) : (
        <ul className="title-list" ref={listRef}>
          {discs.map((d) => {
            const name = d.displayName ?? lastSegment(d.folder);
            const followsHere = follows?.discId === d.discId ? follows : null;
            return (
              <li key={d.discId} className="owner-row" data-testid="hidden-row" data-folder={lastSegment(d.folder)}>
                <div className="owner-row-main">
                  <span className="title-row-text">
                    <span className="title-row-name" lang={nameLang(name)}>
                      {name}
                    </span>
                    <span className="title-muted">
                      {d.root} · {d.folder}
                    </span>
                  </span>
                  <button type="button" data-testid="hidden-unhide" disabled={busy.has(d.discId)} onClick={() => unhide(d)}>
                    Unhide
                  </button>
                </div>
                {followsHere && (
                  <div className="owner-notice" role="status" data-testid="hidden-follows">
                    <p>
                      This disc follows its copy at {followsHere.sourceFolder ?? 'another folder'}, so it can't be unhidden on its own.
                    </p>
                    <div className="owner-buttons">
                      <button type="button" data-testid="hidden-own" disabled={busy.has(d.discId)} onClick={() => hideOwn(d.discId)}>
                        Don't list this copy
                      </button>
                      <button type="button" data-testid="hidden-file" onClick={() => setFollows({ ...followsHere, filing: true })}>
                        File it differently
                      </button>
                    </div>
                    {followsHere.filing && (
                      <DiscCard
                        nas={nas}
                        tmdb={tmdb}
                        disc={{ discId: d.discId, path: `${d.root}/${d.folder}`, discTitles: [], reason: null, suggestions: [], catalogueNumber: null, groupSize: 1 }}
                        onFiled={changed}
                        onCreated={onChanged}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
