import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { DiscEntry } from '../../engine/disc/nas-api';
import type { PlayerController } from '../../player/player-controller';
import { breadcrumbs, discBadges, folderMemory, formatSize, sortRows, type DiscFacts, type LibraryRow } from './library-model';
import { AdminScreen } from './AdminScreen';
import { NasHttpError, type NasClient } from './nas-client';
import { useNasRoute, type NasHistory } from './nas-history';
import type { NasPairing } from './nas-store';
import type { PlayingRoute } from './playing-route';
import type { PlaceSaver } from '../place-saver';
import { Preflight } from './Preflight';
import { nameLang } from '../name-lang';

interface LibraryScreenProps {
  readonly nas: NasClient;
  readonly controller: PlayerController;
  readonly history: NasHistory;
  /** Kept current by playback once a pre-flight here launches a disc. */
  readonly playingRoute: PlayingRoute;
  /** Saves the place of the disc Play opens. */
  readonly places: PlaceSaver;
  /** A pre-flight here is launching its disc: its play route is about to be pushed, with this folder still shown. */
  readonly onLaunch: () => void;
  /** The folder shown, from the address bar (on the play route a pre-flight here pushed, the folder it was opened in). */
  readonly path: string;
  readonly onClose: () => void;
}

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** The folder the browser showed last, where "Browse by folder instead" opens it. */
export const rememberedFolder = (): string => folderMemory(storage()).get();

/** Which discs turned out to be UHD (from their manifests), kept for the session so their rows show it. */
const uhdDiscs = new Map<string, boolean>();

/** The NAS's folders and discs: breadcrumbs, folders first, then discs with size and badges; a disc opens its pre-flight. */
export function LibraryScreen({ nas, controller, history, playingRoute, places, onLaunch, path, onClose }: LibraryScreenProps): ReactElement {
  const onPlayRoute = useNasRoute(history)?.kind === 'play';
  const [memory] = useState(() => folderMemory(storage()));
  const [rows, setRows] = useState<LibraryRow[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DiscEntry | null>(null);
  const [, setUhdVersion] = useState(0);
  const [pairing, setPairing] = useState<NasPairing | null>(null);
  const [settings, setSettings] = useState(false);
  /** Bumped on leaving the settings, so a rescan started there shows in the listing. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    // Back from the settings, `me` first: an owner may have changed this device's owner status meanwhile.
    (reload === 0 ? Promise.resolve() : nas.me().then(() => {}, () => {})).then(() => nas.pairing()).then(
      (p) => {
        if (live) setPairing(p);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [nas, reload]);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    nas.library(path).then(
      (listing) => {
        if (!live) return;
        setRows(sortRows(listing));
        setScanning(listing.scanning);
        memory.set(path);
      },
      (err: unknown) => {
        if (!live) return;
        // A remembered folder that is gone (renamed, or its drive removed): start from the top.
        if (err instanceof NasHttpError && err.status === 404 && path !== '') history.replace({ kind: 'folders', path: '' });
        else setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [nas, path, memory, reload, history]);

  // The pre-flight belongs to the folder it was opened in: another folder (Back, Forward) closes it, and so does leaving
  // the play route its Play pushed.
  useEffect(() => setSelected(null), [path]);
  useEffect(() => {
    if (!onPlayRoute) setSelected(null);
  }, [onPlayRoute]);

  const onFacts = useCallback((discId: string, facts: DiscFacts) => {
    if (uhdDiscs.get(discId) === facts.uhd) return;
    uhdDiscs.set(discId, facts.uhd);
    setUhdVersion((v) => v + 1);
  }, []);

  const open = (folder: string): void => {
    setSelected(null);
    history.push({ kind: 'folders', path: folder });
  };

  if (settings) {
    return (
      <AdminScreen
        nas={nas}
        thisDeviceId={pairing?.deviceId ?? null}
        onClose={() => {
          setSettings(false);
          setReload((r) => r + 1);
        }}
      />
    );
  }

  const crumbs = breadcrumbs(path);

  return (
    <section className="library" data-testid="nas-library">
      <div className="library-head">
        <nav className="crumbs" aria-label="Folder" data-testid="nas-crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span aria-hidden="true"> › </span>}
              {i === crumbs.length - 1 && !selected ? (
                <span aria-current="page">{c.label}</span>
              ) : (
                <button type="button" className="crumb" onClick={() => open(c.path)}>
                  {c.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <div className="library-actions">
          {pairing?.owner && (
            <button type="button" data-testid="nas-settings" onClick={() => setSettings(true)}>
              NAS settings
            </button>
          )}
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {scanning && (
        <p className="status" role="status">
          Rescanning…
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-error">
          {error}
        </div>
      )}
      {selected ? (
        <Preflight
          nas={nas}
          controller={controller}
          disc={selected}
          history={history}
          playingRoute={playingRoute}
          places={places}
          onLaunch={onLaunch}
          onFacts={onFacts}
          onCancel={() => setSelected(null)}
        />
      ) : rows === null ? (
        !error && <p className="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="status">No discs here.</p>
      ) : (
        <ul className="library-rows">
          {rows.map((row) =>
            row.kind === 'folder' ? (
              <li key={`f:${row.folder.path}`}>
                <button type="button" className="library-row" data-testid="nas-folder" data-name={row.folder.name} onClick={() => open(row.folder.path)}>
                  <span className="library-name" lang={nameLang(row.folder.name)}>
                    {row.folder.name}/
                  </span>
                  <span className="library-meta">{row.folder.discs === 1 ? '1 disc' : `${row.folder.discs} discs`}</span>
                </button>
              </li>
            ) : (
              <li key={`d:${row.disc.id}`}>
                <button type="button" className="library-row" data-testid="nas-disc" data-name={row.disc.name} onClick={() => setSelected(row.disc)}>
                  <span className="library-name" lang={nameLang(row.disc.name)}>
                    {row.disc.name}
                  </span>
                  <span className="library-meta">
                    {discBadges(row.disc, uhdDiscs.get(row.disc.id)).map((b) => (
                      <span key={b} className="badge">
                        {b}
                      </span>
                    ))}
                    {formatSize(row.disc.sizeBytes)}
                  </span>
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
