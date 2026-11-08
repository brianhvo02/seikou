// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { LibraryAnswer, LibraryDiscInfo } from '../api-types';
import type { AppApi } from './app-api';
import { Link } from './router';

/** What the page needs: the backend client. */
export interface LibraryPageProps {
  /** The backend client. */
  readonly api: AppApi;
}

/** The discs whose name or path holds every word of `text`, in any letter case; all of them for blank text. */
export function filterDiscs(discs: readonly LibraryDiscInfo[], text: string): LibraryDiscInfo[] {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w !== '');
  return discs.filter((d) => {
    const hay = `${d.label} ${d.relPath}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** How long the page waits before asking again while a scan runs. */
const SCAN_POLL_MS = 1000;

/** The words for how many playlists a disc has. */
function playlistWords(n: number): string {
  return n === 1 ? '1 playlist' : `${n} playlists`;
}

interface RootsEditorProps {
  readonly roots: readonly string[];
  readonly unreadable: readonly string[];
  readonly onSave: (roots: readonly string[]) => Promise<void>;
}

/** The library folders: each with Remove, and a field to add one. */
function RootsEditor({ roots, unreadable, onSave }: RootsEditorProps) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (next: readonly string[]): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    try {
      await onSave(next);
      return true;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const given = path.trim();
    if (given === '' || roots.includes(given)) return;
    if (await save([...roots, given])) setPath('');
  };

  return (
    <section className="roots" aria-labelledby="roots-heading">
      <h2 id="roots-heading">Library folders</h2>
      {roots.length > 0 && (
        <ul className="root-list">
          {roots.map((r) => (
            <li key={r}>
              <span className="root-path">{r}</span>
              {unreadable.includes(r) && <span className="mark mark-warn">Cannot be read</span>}
              <button type="button" disabled={busy} aria-label={`Remove ${r}`} onClick={() => void save(roots.filter((x) => x !== r))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="root-add" onSubmit={(e) => void add(e)}>
        <label>
          <span className="visually-hidden">Folder path</span>
          <input type="text" value={path} placeholder="/path/to/your/discs" aria-label="Folder path" onChange={(e) => setPath(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || path.trim() === ''}>
          Add folder
        </button>
      </form>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/**
 * The Library page: the discs found under the library folders (name, path, playlist count, a mark when subtitle choices
 * are saved) with a filter, a Rescan button and the folders themselves, editable. With no folders it explains and asks
 * for one; a folder that cannot be read is named while its discs from the last scan stay listed. While a scan runs the
 * page asks again every second.
 */
export function LibraryPage({ api }: LibraryPageProps) {
  const [library, setLibrary] = useState<LibraryAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      setLibrary(await api.library());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const scanning = library?.scanning === true;
  useEffect(() => {
    if (!scanning) return;
    const timer = setTimeout(() => void load(), SCAN_POLL_MS);
    return () => clearTimeout(timer);
  }, [scanning, library, load]);

  const rescan = async () => {
    try {
      await api.rescan();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    await load();
  };

  const saveRoots = async (roots: readonly string[]) => {
    await api.setRoots(roots);
    await load();
  };

  if (library === null) {
    return (
      <main className="content wide">
        <h1 className="page-title">Library</h1>
        {error === null ? (
          <p className="muted">Reading the library…</p>
        ) : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
    );
  }

  const shown = filterDiscs(library.discs, filter);
  return (
    <main className="content wide">
      <div className="page-head">
        <h1 className="page-title">Library</h1>
        <button type="button" onClick={() => void rescan()} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {library.unreadableRoots.length > 0 && (
        <p className="error" role="alert">
          Cannot read {library.unreadableRoots.join(', ')}. Is the drive connected? The discs found there before stay listed.
        </p>
      )}

      {library.roots.length === 0 ? (
        <section className="empty">
          <h2>No library folders are set</h2>
          <p>Add the folder that holds your decrypted discs. The app looks up to four folders deep for BDMV folders.</p>
        </section>
      ) : (
        <>
          <input
            type="search"
            className="filter"
            aria-label="Filter discs"
            placeholder="Filter by name or path"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {library.discs.length === 0 ? (
            <p className="muted">{scanning ? 'Looking for discs…' : 'No discs found under the library folders.'}</p>
          ) : shown.length === 0 ? (
            <p className="muted">No disc matches “{filter.trim()}”.</p>
          ) : (
            <ul className="disc-list">
              {shown.map((d) => (
                <li key={d.key}>
                  <Link to={{ kind: 'disc', discKey: d.key }} className="disc-link">
                    <span className="disc-name">{d.label}</span>
                    <span className="disc-path muted">{d.relPath}</span>
                  </Link>
                  <span className="disc-facts">
                    <span className="num muted">{playlistWords(d.playlistCount)}</span>
                    {d.recordPlaylists.length > 0 && <span className="mark">Subtitle choices saved</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <RootsEditor roots={library.roots} unreadable={library.unreadableRoots} onSave={saveRoots} />
    </main>
  );
}
