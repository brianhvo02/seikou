// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState, type ReactElement } from 'react';
import type { StoredSubtitle } from '@seikou/nas/nas-api';
import { uploadLine } from './admin-model';
import { NasHttpError, type NasClient } from './nas-client';
import { subtitleErrorMessage } from './subtitle-model';
import { displayName } from './title-model';

/**
 * NAS settings: every subtitle on the NAS, the ones not attached first, each with Delete after a confirm. It is where an
 * upload no title screen lists any more (its disc gone) is found; attached ones are edited from their title's screens.
 */
export function SubtitleUploadsSection({ nas }: { nas: Pick<NasClient, 'allSubtitles' | 'titles' | 'deleteSubtitle'> }): ReactElement | null {
  const [subs, setSubs] = useState<readonly StoredSubtitle[] | null>(null);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [failed, setFailed] = useState(false);
  /** A NAS from before `all=1` answers 400: no section. */
  const [unsupported, setUnsupported] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    nas.allSubtitles().then(
      (s) => live && setSubs(s),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof NasHttpError && err.status === 400) setUnsupported(true);
        else setFailed(true);
      },
    );
    // names only: without the title library (or if it fails) the rows say "A title no longer on the NAS" or "A disc"
    nas.titles().then(
      (t) => live && setNames(new Map(t.map((x) => [x.id, displayName(x)]))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [nas]);

  const remove = (id: string): void => {
    setBusy(true);
    setError(null);
    nas.deleteSubtitle(id).then(
      () => {
        setSubs((s) => s?.filter((x) => x.id !== id) ?? null);
        setConfirming(null);
        setBusy(false);
      },
      (err: unknown) => {
        setError(subtitleErrorMessage(err));
        setConfirming(null);
        setBusy(false);
      },
    );
  };

  if (unsupported || (subs === null && !failed)) return null;
  const ordered = subs === null ? [] : [...subs.filter((s) => s.attached === false), ...subs.filter((s) => s.attached !== false)];
  const loose = ordered.filter((s) => s.attached === false).length;
  return (
    <section className="admin-uploads" data-testid="nas-uploads" aria-labelledby="admin-uploads-head">
      <h3 id="admin-uploads-head">Subtitle uploads</h3>
      {failed ? (
        <p className="status">The subtitle uploads didn't load.</p>
      ) : ordered.length === 0 ? (
        <p className="status">No subtitles are stored on the NAS.</p>
      ) : (
        <details>
          <summary data-testid="nas-uploads-summary">
            {ordered.length} {ordered.length === 1 ? 'subtitle' : 'subtitles'}
            {loose > 0 ? `, ${loose} not attached` : ''}
          </summary>
          <ul className="library-rows">
            {ordered.map((s) => {
              const line = uploadLine(s, names);
              return (
                <li key={s.id} data-testid="nas-upload" data-attached={line.attached ? 'true' : 'false'}>
                  <span>
                    <strong>{line.name}</strong> <span className="title-muted">{line.language}</span>
                    <br />
                    <span className="title-muted" data-testid="nas-upload-where">{line.where}</span>
                  </span>
                  {confirming !== s.id ? (
                    <button type="button" data-testid="nas-upload-delete" disabled={busy} onClick={() => setConfirming(s.id)}>
                      Delete
                    </button>
                  ) : (
                    <div className="admin-confirm-box" role="group" aria-label="Confirm">
                      <p>Delete {line.name} and its fonts from the NAS? Nobody can pick it after this.</p>
                      <span className="admin-confirm">
                        <button type="button" data-testid="nas-upload-delete-confirm" disabled={busy} onClick={() => remove(s.id)}>
                          Delete
                        </button>
                        <button type="button" data-testid="nas-upload-delete-cancel" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-uploads-error">
          {error}
        </div>
      )}
    </section>
  );
}
