// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import type { LibraryDiscInfo, PlaylistSummary } from '../api-types';
import type { AppApi } from './app-api';
import { placeText, useDocumentTitle } from './place';
import { Link } from './router';

/** What the page needs: the backend client and the disc's key. */
export interface DiscPageProps {
  /** The backend client. */
  readonly api: AppApi;
  /** The library disc to show. */
  readonly discKey: string;
}

/** A length as `h:mm:ss` (`m:ss` under an hour). */
export function formatLength(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface Loaded {
  readonly disc: LibraryDiscInfo | null;
  readonly rootCount: number;
  readonly playlists: readonly PlaylistSummary[];
}

/** The message and way back for a disc the library does not hold (it may have moved, or the library needs a rescan). */
function NotInLibrary() {
  return (
    <main className="content wide">
      <p className="error" role="alert">
        This disc is not in the library. It may have moved, or the library may need a rescan.
      </p>
      <p>
        <Link to={{ kind: 'library' }}>Back to the library</Link>
      </p>
    </main>
  );
}

/**
 * The Disc page: the disc's name and place, then its playlists longest first with length, clips and chapters, a mark on
 * the likely main one and on those with saved subtitle choices, and a link from each to its Episodes page. A disc the
 * library does not hold says so and links back to the Library.
 */
export function DiscPage({ api, discKey }: DiscPageProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ readonly message: string; readonly unknownDisc: boolean } | null>(null);
  useDocumentTitle(loaded?.disc?.label ?? 'Seikou encoder');

  useEffect(() => {
    let live = true;
    Promise.all([api.library(), api.playlists(discKey)]).then(
      ([library, playlists]) => {
        if (!live) return;
        const sorted = [...playlists].sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id));
        setLoaded({ disc: library.discs.find((d) => d.key === discKey) ?? null, rootCount: library.roots.length, playlists: sorted });
      },
      (e: unknown) => {
        if (live) setError({ message: e instanceof Error ? e.message : String(e), unknownDisc: e instanceof ApiError && e.code === 'disc-changed' });
      },
    );
    return () => {
      live = false;
    };
  }, [api, discKey]);

  if (error !== null) {
    if (error.unknownDisc) return <NotInLibrary />;
    return (
      <main className="content wide">
        <p className="error" role="alert">
          {error.message}
        </p>
        <p>
          <Link to={{ kind: 'library' }}>Back to the library</Link>
        </p>
      </main>
    );
  }
  if (loaded === null) {
    return (
      <main className="content wide">
        <p className="muted">Reading the disc…</p>
      </main>
    );
  }
  const { disc, playlists } = loaded;
  if (disc === null) return <NotInLibrary />;

  const place = placeText(disc, loaded.rootCount);
  return (
    <main className="content wide">
      <p className="crumb">
        <Link to={{ kind: 'library' }}>Library</Link>
      </p>
      <h1 className="page-title disc-title">{disc.label}</h1>
      {place !== '' && <p className="muted">{place}</p>}
      {disc.otherPaths.map((o) => (
        <p key={`${o.root}|${o.relPath}`} className="muted">
          Also at {o.relPath} ({o.root})
        </p>
      ))}
      {playlists.length === 0 ? (
        <p className="muted">This disc has no playlists the app can read.</p>
      ) : (
        <ul className="playlist-list">
          {playlists.map((p) => (
            <li key={p.id}>
              <span className="playlist-id num" data-testid="playlist-id">
                {p.id}
              </span>
              <span className="playlist-length num">{formatLength(p.durationMs)}</span>
              <span className="playlist-facts muted num">
                <span>{count(p.clips, 'clip', 'clips')}</span>
                <span>{count(p.chapters, 'chapter', 'chapters')}</span>
              </span>
              <span className="playlist-marks">
                {p.likelyMain && <span className="mark">Likely main</span>}
                {disc.recordPlaylists.includes(p.id) && <span className="mark">Subtitle choices saved</span>}
              </span>
              <Link to={{ kind: 'episodes', discKey, playlistId: p.id }} className="playlist-go">
                Episodes
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
