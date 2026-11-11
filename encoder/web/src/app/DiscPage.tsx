// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import type { LibraryDiscInfo, PlaylistSummary } from '../api-types';
import type { AppApi } from './app-api';
import { otherPlaceText, placeText, SCAN_POLL_MS, useDocumentTitle } from './place';
import { Link, type SeasonRef } from './router';

/** What the page needs: the backend client and the disc's key. */
export interface DiscPageProps {
  /** The backend client. */
  readonly api: AppApi;
  /** The library disc to show. */
  readonly discKey: string;
  /** The season page the disc was opened from (to check it); its Episodes links lead back there. */
  readonly from?: SeasonRef | undefined;
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
export function NotInLibrary() {
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

/** What a page shows while the library scan is still looking for its disc. */
export function ScanningLibrary() {
  return (
    <main className="content wide">
      <p className="muted" role="status">
        Scanning the library…
      </p>
    </main>
  );
}

/**
 * The Disc page: the disc's name and place, then its playlists longest first with length, clips and chapters, a mark on
 * the likely main one and on those with saved subtitle choices, and a link from each to its Episodes page. A disc the
 * library does not hold says so and links back to the Library, but only once the scan is over: while the library is
 * still being scanned the page says so and asks again every second.
 */
export function DiscPage({ api, discKey, from }: DiscPageProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [scanning, setScanning] = useState(false);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<{ readonly message: string; readonly unknownDisc: boolean } | null>(null);
  useDocumentTitle(loaded?.disc?.label ?? 'Seikou encoder');

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (): void => {
      setScanning(true);
      timer = setTimeout(() => setTick((t) => t + 1), SCAN_POLL_MS);
    };
    Promise.all([api.library(), api.playlists(discKey)]).then(
      ([library, playlists]) => {
        if (!live) return;
        if (library.scanning && !library.discs.some((d) => d.key === discKey)) return again();
        setScanning(false);
        const sorted = [...playlists].sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id));
        setLoaded({ disc: library.discs.find((d) => d.key === discKey) ?? null, rootCount: library.roots.length, playlists: sorted });
      },
      (e: unknown) => {
        if (!live) return;
        const unknownDisc = e instanceof ApiError && e.code === 'disc-changed';
        const fail = (): void => {
          setScanning(false);
          setError({ message: e instanceof Error ? e.message : String(e), unknownDisc });
        };
        if (!unknownDisc) return fail();
        // the disc may only be missing because the scan has not reached it yet
        api.library().then(
          (library) => {
            if (live) library.scanning ? again() : fail();
          },
          () => {
            if (live) fail();
          },
        );
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, discKey, tick]);

  if (scanning) return <ScanningLibrary />;
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
        {from !== undefined ? <Link to={{ kind: 'season', ...from }}>Back to the season</Link> : <Link to={{ kind: 'library' }}>Library</Link>}
      </p>
      <h1 className="page-title disc-title">{disc.label}</h1>
      {from !== undefined && <p className="muted">The NAS doesn't list this disc's episodes. Open the playlist that holds them to group its chapters and mark it checked.</p>}
      {place !== '' && <p className="muted">{place}</p>}
      {disc.otherPaths.map((o) => (
        <p key={`${o.root}|${o.relPath}`} className="muted" title={o.root}>
          Also at {otherPlaceText(o, loaded.rootCount)}
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
                {p.likelyMain && <span className="tag">Likely main</span>}
                {disc.recordPlaylists.includes(p.id) && <span className="mark">Subtitle choices saved</span>}
              </span>
              <Link to={{ kind: 'episodes', discKey, playlistId: p.id, ...(from !== undefined ? { from } : {}) }} className="playlist-go">
                Episodes
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
