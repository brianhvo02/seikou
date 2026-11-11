import type { ReactElement } from 'react';
import { BDJ_RUNTIME } from '@seikou/engine/bdj-provider';
import type { PlaylistSummary } from '@seikou/engine/disc/open-disc';
import type { IndexTitles } from '@seikou/engine/controller/player-controller';
import { formatTime } from './format';

interface PlaylistPickerProps {
  readonly playlists: readonly PlaylistSummary[];
  readonly usesBdj: boolean;
  /** The engine runs BD-J titles: they are listed like any other. */
  readonly bdjSupported?: boolean;
  /** What this browser lacks to run BD-J, named in the hint. */
  readonly bdjMissing?: readonly string[];
  /** HDMV discs: the index titles, listed above the playlists (picking one runs its movie object). */
  readonly titles?: IndexTitles['titles'];
  onPickTitle?(title: number): void;
  /** Current error and unsupported-* messages, shown inline so the backdrop can't hide them. */
  readonly messages?: readonly string[];
  onPick(playlistId: string): void;
  readonly onClose?: () => void;
  onCloseDisc(): void;
}

/**
 * The dialog for choosing what to play: the disc's playlists (the likely main feature marked), and for an HDMV disc its
 * index titles above them (`onPickTitle`). It lists the files a disc lacks when no playlist can play, shows `messages`
 * (errors and unsupported-codec notices) inline, and for a BD-J disc (`usesBdj`) explains that the menus are not
 * available when `bdjSupported` is false, naming what the browser lacks (`bdjMissing`). `onPick` plays a playlist,
 * `onClose` dismisses the dialog (absent when there is nothing to go back to) and `onCloseDisc` closes the disc.
 */
export function PlaylistPicker({ playlists, usesBdj, bdjSupported = false, bdjMissing = [], titles = [], onPickTitle, messages = [], onPick, onClose, onCloseDisc }: PlaylistPickerProps): ReactElement {
  const mainId = playlists.find((p) => p.playable)?.id;
  const missing = playlists.length > 0 && !mainId ? [...new Set(playlists.flatMap((p) => p.missingPaths))] : [];
  return (
    <div className="picker-backdrop">
      <div className="picker" role="dialog" aria-label="Choose a playlist" data-testid="playlist-picker">
        <h2>Choose what to play</h2>
        {messages.length > 0 && (
          <div className="picker-error" role="alert" data-testid="picker-error">
            {messages.map((m) => (
              <p key={m}>{m}</p>
            ))}
          </div>
        )}
        {missing.length > 0 && (
          <div className="picker-error" role="alert" data-testid="missing-files">
            <p>This disc can't be played because these files are missing. Choose the whole disc folder, including BDMV/STREAM and BDMV/CLIPINF.</p>
            <ul className="missing-list">
              {missing.slice(0, 10).map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            {missing.length > 10 && <p>…and {missing.length - 10} more</p>}
          </div>
        )}
        {usesBdj && !bdjSupported && (
          <p className="hint" data-testid="bdj-unsupported">
            {bdjMissing.length === 1 && bdjMissing[0] === BDJ_RUNTIME
              ? 'This disc uses BD-J menus, which this player does not include. Choose a playlist; the likely main feature is marked.'
              : bdjMissing.length > 0
              ? `This disc uses BD-J menus, which this browser can't run: it lacks ${bdjMissing.join(', ')}. Choose a playlist; the likely main feature is marked.`
              : "This disc uses BD-J menus, which aren't supported. Choose a playlist; the likely main feature is marked."}
          </p>
        )}
        {titles.length > 0 && (
          <>
            <h3>Titles</h3>
            <ul data-testid="title-list">
              {titles.map((t) => {
                const unsupported = t.kind === 'bdj' && !bdjSupported;
                return (
                  <li key={t.number}>
                    <button
                      type="button"
                      className="playlist"
                      disabled={unsupported}
                      title={unsupported ? 'Needs BD-J, which is not supported' : undefined}
                      data-testid={`title-${t.number}`}
                      onClick={() => onPickTitle?.(t.number)}
                    >
                      <span>Title {t.number}</span>
                      {unsupported && <span className="badge">Needs BD-J</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <h3>Playlists</h3>
          </>
        )}
        <ul>
          {playlists.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="playlist"
                disabled={!p.playable}
                title={p.playable ? undefined : `Missing: ${p.missingPaths.join(', ')}`}
                data-testid={`playlist-${p.id}`}
                onClick={() => onPick(p.id)}
              >
                <span className="playlist-id">{p.id}</span>
                <span>{formatTime(p.durationUs)}</span>
                <span>{p.chapterCount} chapters</span>
                {p.id === mainId && <span className="badge">Main feature</span>}
              </button>
              {!p.playable && p.missingPaths.length > 0 && <small className="playlist-missing">Missing: {p.missingPaths.join(', ')}</small>}
            </li>
          ))}
        </ul>
        <div className="picker-actions">
          <button type="button" onClick={onCloseDisc}>
            Open another disc
          </button>
          {onClose && (
            <button type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
