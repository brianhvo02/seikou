import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { DiscRef, TitleDetail, TitleSummary } from '@seikou/nas/nas-api';
import { artistChoice, releaseName, VARIOUS_ID, VARIOUS_NAME } from './artist-model';
import { filingDisc } from './FileDifferently';
import type { NasClient } from './nas-client';
import { DiscCard } from './UnsortedScreen';

/** What an owner opened from a release's "⋯" menu: a form under the release's section. */
export type ReleaseAction = 'rename' | 'artist' | 'refile';

const MAX_NAME = 200;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface MusicReleaseMenuProps {
  readonly nas: NasClient;
  readonly title: TitleSummary;
  /** Opens a form for the release. */
  readonly onAction: (action: ReleaseAction) => void;
  /** Not this release, or Use this release again, was saved: the library fetches its titles again. */
  readonly onChanged: () => void;
  readonly onError: (message: string) => void;
}

/**
 * An owner's "⋯" menu on a release card (spec §3, owner corrections): Rename…, Set artist…, Not this release (only when
 * a lookup matched) or Use this release again (only when the match was dropped), and File differently…. An own title
 * has no lookup and no artist, so only Rename… and File differently….
 */
export function MusicReleaseMenu({ nas, title, onAction, onChanged, onError }: MusicReleaseMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const name = releaseName(title);
  const music = title.own ? undefined : title.music;

  const items = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(true);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const moveFocus = (e: ReactKeyboardEvent): void => {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    list[(next + list.length) % list.length]!.focus();
  };

  const pick = (action: ReleaseAction): void => {
    setOpen(false);
    onAction(action);
  };
  const setReject = (rejectMatch: boolean): void => {
    setBusy(true);
    nas.admin.setMusic(title.id, { rejectMatch }).then(
      () => {
        setBusy(false);
        close(false);
        onChanged();
      },
      (err: unknown) => {
        setBusy(false);
        close(true);
        onError(message(err));
      },
    );
  };

  return (
    <div className="music-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="title-icon-button music-menu-button"
        data-testid="music-release-menu"
        data-menu-id={title.id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change ${name}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <ul ref={listRef} role="menu" className="music-menu-list" aria-label={`Change ${name}`} onKeyDown={moveFocus}>
          <li role="none">
            <button type="button" role="menuitem" data-testid="music-rename" onClick={() => pick('rename')}>
              Rename…
            </button>
          </li>
          {music && (
            <li role="none">
              <button type="button" role="menuitem" data-testid="music-set-artist" onClick={() => pick('artist')}>
                Set artist…
              </button>
            </li>
          )}
          {music?.matched && !music.rejected && (
            <li role="none">
              <button type="button" role="menuitem" data-testid="music-reject" disabled={busy} onClick={() => setReject(true)}>
                Not this release
              </button>
            </li>
          )}
          {music?.rejected && (
            <li role="none">
              <button type="button" role="menuitem" data-testid="music-unreject" disabled={busy} onClick={() => setReject(false)}>
                Use this release again
              </button>
            </li>
          )}
          <li role="none">
            <button type="button" role="menuitem" data-testid="music-refile-open" onClick={() => pick('refile')}>
              File differently…
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

interface FormProps {
  readonly nas: NasClient;
  readonly title: TitleSummary;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

/** Rename…: an own title's name, or any other release's display name over its found name. */
export function RenameForm({ nas, title, onDone, onCancel }: FormProps): ReactElement {
  const [name, setName] = useState(releaseName(title));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const save = (value: string | null): void => {
    setBusy(true);
    setError(null);
    // an own title's name is the title's; any other music title's is a display name over its found name
    const done = title.own ? nas.admin.updateTitle(title.id, { name: value! }) : nas.admin.setName(title.id, value);
    done.then(
      () => {
        setBusy(false);
        onDone();
      },
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      },
    );
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      if (title.own) setError('Give the title a name.');
      else save(null);
      return;
    }
    save(trimmed);
  };

  return (
    <form className="owner-form" data-testid="music-rename-form" onSubmit={submit}>
      <label className="owner-field">
        <span>Display name</span>
        <input ref={input} type="text" data-testid="music-name" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && (
        <p className="owner-message" role="alert">
          {error}
        </p>
      )}
      <div className="owner-buttons">
        {!title.own && (
          <button type="button" data-testid="music-folder-name" disabled={busy || title.names.display === null} onClick={() => save(null)}>
            Use found name
          </button>
        )}
        <button type="submit" className="owner-primary" data-testid="music-save" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Set artist…: an existing artist's name, a typed one, or Various artists; "Use found artist" clears the owner's. */
export function SetArtistForm({ nas, title, artists, onDone, onCancel }: FormProps & { readonly artists: readonly string[] }): ReactElement {
  const current = title.music?.artist;
  const [name, setName] = useState(current ? (current.id === VARIOUS_ID ? VARIOUS_NAME : current.name) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => input.current?.select(), []);

  const save = (artist: string | null): void => {
    setBusy(true);
    setError(null);
    nas.admin.setMusic(title.id, { artist }).then(
      () => {
        setBusy(false);
        onDone();
      },
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      },
    );
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    save(artistChoice(name));
  };

  return (
    <form className="owner-form" data-testid="music-artist-form" onSubmit={submit}>
      <label className="owner-field">
        <span>Artist</span>
        <input ref={input} type="text" data-testid="music-artist" list={listId} value={name} maxLength={MAX_NAME} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        <datalist id={listId}>
          {artists.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </label>
      {error && (
        <p className="owner-message" role="alert">
          {error}
        </p>
      )}
      <div className="owner-buttons">
        <button type="button" data-testid="music-artist-found" disabled={busy} onClick={() => save(null)}>
          Use found artist
        </button>
        <button type="submit" className="owner-primary" data-testid="music-artist-save" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * File differently… on a release (ruling F3): a filing card for each of its discs, to file it under a title (out of
 * Music) or leave it out with "Don't list".
 */
export function MusicRefile({ nas, tmdb, title, loadDetail, onChanged }: { nas: NasClient; tmdb: boolean; title: TitleSummary; loadDetail: (id: string) => Promise<TitleDetail>; onChanged: () => void }): ReactElement {
  const [discs, setDiscs] = useState<DiscRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadDetail(title.id).then(
      (d) => {
        if (live) setDiscs([...d.seasons.flatMap((s) => [...s.discs, ...s.extras]), ...d.extras].flatMap((slot) => slot.copies));
      },
      (err: unknown) => {
        if (live) setError(message(err));
      },
    );
    return () => {
      live = false;
    };
  }, [title.id, loadDetail]);
  if (error) return <p className="owner-message" role="alert">{error}</p>;
  if (discs === null) return <p className="status">Loading…</p>;
  return (
    <div className="owner-cards" data-testid="music-refile">
      {discs.map((d) => (
        <DiscCard key={d.discId} nas={nas} tmdb={tmdb} disc={filingDisc(d)} onFiled={onChanged} onCreated={onChanged} />
      ))}
    </div>
  );
}
