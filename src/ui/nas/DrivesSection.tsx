// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState, type ReactElement } from 'react';
import type { NasDrive } from '@seikou/nas/nas-api';
import { driveLine, forgetDriveError, forgetDriveQuestion } from './admin-model';
import { NasHttpError, type NasClient } from './nas-client';

/**
 * NAS settings: the library's drives (its roots) with their discs. A drive the last scan didn't find keeps its discs, so
 * a drive briefly unmounted doesn't empty the library; "Forget its discs" drops them, after a confirm, for one gone for
 * good. The root stays configured: the next scan that finds it lists its discs again.
 */
export function DrivesSection({ nas }: { nas: { admin: Pick<NasClient['admin'], 'drives' | 'forgetDrive'> } }): ReactElement | null {
  const [drives, setDrives] = useState<readonly NasDrive[] | null>(null);
  const [failed, setFailed] = useState(false);
  /** A NAS from before the drives route (404): no section. */
  const [unsupported, setUnsupported] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    nas.admin.drives().then(
      (d) => live && setDrives(d),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof NasHttpError && err.status === 404) setUnsupported(true);
        else setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [nas]);

  const forget = (name: string): void => {
    setBusy(true);
    setError(null);
    nas.admin.forgetDrive(name).then(
      (d) => {
        setDrives(d);
        setConfirming(null);
        setBusy(false);
      },
      (err: unknown) => {
        setError(forgetDriveError(err));
        setConfirming(null);
        setBusy(false);
      },
    );
  };

  if (unsupported || (drives === null && !failed)) return null;
  return (
    <section className="admin-drives" data-testid="nas-drives" aria-labelledby="admin-drives-head">
      <h3 id="admin-drives-head">Drives</h3>
      {failed && drives === null ? (
        <p className="status">The drives didn't load.</p>
      ) : (
        <ul className="library-rows">
          {drives!.map((d) => {
            const line = driveLine(d);
            return (
              <li key={d.name} data-testid="nas-drive">
                <span>
                  <strong>{line.name}</strong> <span className="title-muted" data-testid="nas-drive-status">{line.status}</span>
                </span>
                {line.canForget && confirming !== d.name && (
                  <button type="button" data-testid="nas-drive-forget" disabled={busy} onClick={() => setConfirming(d.name)}>
                    Forget its discs
                  </button>
                )}
                {confirming === d.name && (
                  <div className="admin-confirm-box" role="group" aria-label="Confirm">
                    <p>{forgetDriveQuestion(d)}</p>
                    <span className="admin-confirm">
                      <button type="button" data-testid="nas-drive-forget-confirm" disabled={busy} onClick={() => forget(d.name)}>
                        Forget
                      </button>
                      <button type="button" data-testid="nas-drive-forget-cancel" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-drives-error">
          {error}
        </div>
      )}
    </section>
  );
}
