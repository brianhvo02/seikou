// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { EncodeShowList, EncodesStatus } from '@seikou/nas/nas-api';
import type { PlayerController } from '@seikou/engine/controller/player-controller';
import type { PlaceSaver } from '../place-saver';
import { ContinueRow } from './ContinueRow';
import { EncodePreflight } from './EncodePreflight';
import type { PlayingRoute } from './playing-route';
import { EncodeShowScreen } from './EncodeShowScreen';
import { encodesEmptyState, episodeCountLabel, INDEXING_COPY, indexingRetryMs, ownerNotices, searchShows, UNFILED_COPY } from './encodes-model';
import { formatSize } from './library-model';
import type { NasClient } from './nas-client';
import type { NasHistory } from './nas-history';
import type { EncodesRoute } from './nas-route';
import { Poster } from './Poster';
import { AppLink } from '../help/HelpLink';
import { nameLang } from '../name-lang';

interface EncodesLibraryProps {
  readonly nas: NasClient;
  readonly history: NasHistory;
  /** From `GET me`: owners get the setup states, the folder's notices and the files left unfiled. */
  readonly owner: boolean;
  readonly route: EncodesRoute;
  readonly onClose: () => void;
  /** What an episode opens in: the player's controller, its place saver and the address bar's following. */
  readonly player: { readonly controller: PlayerController; readonly places: PlaceSaver; readonly playingRoute: PlayingRoute };
}

/** The search goes into the address bar this long after the last keystroke (as in the title library). */
const SEARCH_WRITE_DELAY_MS = 300;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Loaded = { readonly status: EncodesStatus; readonly list: EncodeShowList };

/** The encodes folder's state and its shows; `indexing` while the NAS still reads the folder for the first time. */
function useEncodes(nas: NasClient): { loaded: Loaded | null; indexing: boolean; error: string | null } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const status = await nas.encodesStatus();
        if (!live) return;
        if (status.scanning) throw new IndexingWait(5000);
        // no encodes folder: there is no list to ask for
        const list = status.configured ? await nas.encodeShows() : { shows: [] };
        if (!live) return;
        setLoaded({ status, list });
        setIndexing(false);
        setError(null);
      } catch (err) {
        if (!live) return;
        const wait = err instanceof IndexingWait ? err.ms : indexingRetryMs(err);
        if (wait === null) {
          setError(message(err));
          return;
        }
        setIndexing(true);
        timer = setTimeout(() => void load(), wait);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [nas]);
  return { loaded, indexing, error };
}

/** `status` said the first scan is still running. */
class IndexingWait {
  constructor(readonly ms: number) {}
}

/** An empty encodes library: a bare shelf, what it means, and for an owner without the folder where to read how. */
function EmptyShelf({ title, text, help, history }: { title: string; text: string; help?: string; history: NasHistory }): ReactElement {
  return (
    <div className="encodes-empty" data-testid="encodes-empty">
      <div className="encodes-shelf" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <strong>{title}</strong>
      <p>{text}</p>
      {help && (
        <AppLink history={history} to={help} className="title-link" testId="encodes-help">
          How to set it up
        </AppLink>
      )}
    </div>
  );
}

/** The Encodes tab: the owner's encoded episodes by AniList show, with their own Continue watching row. */
export function EncodesLibrary({ nas, history, owner, route, onClose, player }: EncodesLibraryProps): ReactElement {
  if (route.kind === 'encodeShow') return <EncodeShowScreen nas={nas} history={history} showId={route.showId} />;
  if (route.kind === 'encodePlay') {
    return (
      <section className="titles" data-testid="encode-play">
        <EncodePreflight
          key={route.encodeId}
          nas={nas}
          controller={player.controller}
          places={player.places}
          history={history}
          playingRoute={player.playingRoute}
          encodeId={route.encodeId}
          startTimeS={route.timeS}
          resume={route.resume}
        />
      </section>
    );
  }
  return <EncodesList nas={nas} history={history} owner={owner} query={route.q} onClose={onClose} />;
}

function EncodesList({ nas, history, owner, query, onClose }: { nas: NasClient; history: NasHistory; owner: boolean; query: string; onClose: () => void }): ReactElement {
  const { loaded, indexing, error } = useEncodes(nas);
  const [draft, setDraft] = useState(query);
  const timer = useRef<number | null>(null);
  const cancelWrite = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    cancelWrite();
    setDraft(query);
  }, [query]);
  useEffect(() => cancelWrite, []);
  const writeSearch = (q: string): void => {
    cancelWrite();
    if (history.route()?.kind === 'encodes') history.replace({ kind: 'encodes', q });
  };

  const status = loaded?.status ?? null;
  const shows = loaded?.list.shows ?? [];
  const empty = loaded ? encodesEmptyState(status, owner, shows.length) : null;
  const notices = ownerNotices(status, owner);
  const unfiled = owner ? (loaded?.list.unfiled ?? []) : [];
  const searching = draft.trim() !== '';
  const results = searchShows(shows, draft);

  return (
    <section className="titles encodes-library" data-testid="encodes-library">
      <header className="titles-head">
        <h2 tabIndex={-1} data-focus-heading="">
          Encodes
        </h2>
        <div className="titles-actions">
          <button type="button" className="title-icon-button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      {shows.length > 0 && (
        <input
          type="search"
          className="title-search"
          data-testid="encodes-search"
          placeholder="Search shows"
          aria-label="Search shows"
          value={draft}
          onChange={(e) => {
            const q = e.target.value;
            setDraft(q);
            cancelWrite();
            timer.current = window.setTimeout(() => writeSearch(q), SEARCH_WRITE_DELAY_MS);
          }}
          onBlur={() => {
            if (timer.current !== null) writeSearch(draft);
          }}
        />
      )}
      {notices.map((n) => (
        <p key={n} className="owner-notice" role="status" data-testid="encodes-notice">
          {n}
        </p>
      ))}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-error">
          {error}
        </div>
      )}
      {!loaded ? (
        !error && <p className="status">{indexing ? INDEXING_COPY : 'Loading…'}</p>
      ) : empty ? (
        <EmptyShelf title={empty.title} text={empty.text} help={empty.kind === 'unconfigured' ? empty.help : undefined} history={history} />
      ) : (
        <>
          {!searching && <ContinueRow nas={nas} history={history} library="encodes" />}
          <h3 className="title-section">{searching ? 'Results' : 'Shows'}</h3>
          {results.length === 0 ? (
            <p className="status">No shows match “{draft.trim()}”.</p>
          ) : (
            <ul className="title-grid">
              {results.map((s) => (
                <li key={s.id}>
                  <button type="button" className="title-card" data-testid="encode-show-card" data-show-id={s.id} onClick={() => history.push({ kind: 'encodeShow', showId: s.id })}>
                    <Poster nas={nas} artId={s.poster} name={s.name} size="large" className="title-poster" />
                    <span className="title-card-name" lang={nameLang(s.name)}>
                      {s.name}
                    </span>
                    <span className="title-muted">{episodeCountLabel(s.episodeCount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {unfiled.length > 0 && (
        <section className="encodes-unfiled" data-testid="encodes-unfiled">
          <h3 className="title-section">Not filed</h3>
          <p className="title-muted">{UNFILED_COPY}</p>
          <ul className="title-list">
            {unfiled.map((u) => (
              <li key={u.path} className="encodes-unfiled-row">
                <span className="encodes-unfiled-path">{u.path}</span>
                <span className="title-muted">{formatSize(u.size)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
