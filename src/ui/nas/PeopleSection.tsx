import { useState, type FormEvent, type ReactElement } from 'react';
import type { NasClient, NasPerson } from './nas-client';
import { MAX_PERSON_NAME, adminFailure, clearSavedQuestion, loseSettingsMessage, losesNasSettings, moveTargets, personRows, removePersonQuestion } from './people-model';

interface PeopleSectionProps {
  readonly nas: NasClient;
  /** null while loading. */
  readonly people: readonly NasPerson[] | null;
  /** This device's id, to mark its row; null when it isn't known. */
  readonly thisDeviceId: string | null;
  readonly now: number;
  /** A change went through: the list is fetched again. */
  readonly onChanged: () => void;
  /** Shows a failure on the admin screen, or clears it (null). */
  readonly onError: (message: string | null) => void;
}

/** What is open: an inline editor or confirm step on a person, or on a device. */
type Edit =
  | { readonly personId: string; readonly what: 'rename' | 'remove' | 'clear' | 'remove-owner' }
  | { readonly deviceId: string; readonly what: 'move' | 'revoke' }
  | null;

/**
 * The People list of NAS settings: each person with an owner badge, their devices and their saved data;
 * Rename, Make owner/Remove owner, Clear saved data and Remove (both after a confirm step), and per device Move to…
 * and Revoke (this device's own row asks first). Removing owner from this device's person, or moving this device to
 * someone who isn't an owner, asks first too: this device would lose NAS settings.
 */
export function PeopleSection({ nas, people, thisDeviceId, now, onChanged, onError }: PeopleSectionProps): ReactElement {
  const [edit, setEdit] = useState<Edit>(null);
  const [name, setName] = useState('');
  /** The person picked in an open "Move to…". */
  const [moveTo, setMoveTo] = useState('');
  const [busy, setBusy] = useState(false);

  const run = (work: () => Promise<unknown>): void => {
    setBusy(true);
    onError(null);
    work().then(
      () => {
        setBusy(false);
        setEdit(null);
        onChanged();
      },
      (err: unknown) => {
        setBusy(false);
        onError(adminFailure(err));
      },
    );
  };

  const rename = (person: NasPerson, e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      onError('Give the person a name.');
      return;
    }
    run(() => nas.admin.updatePerson(person.id, { name: trimmed }));
  };

  if (people === null) return <p className="status">Loading…</p>;
  const byId = new Map(people.map((p) => [p.id, p]));
  const cancel = (
    <button type="button" onClick={() => setEdit(null)}>
      Cancel
    </button>
  );

  return (
    <ul className="library-rows admin-people" data-testid="nas-people">
      {personRows(people, now, thisDeviceId).map((row) => {
        const person = byId.get(row.id)!;
        const editing = edit !== null && 'personId' in edit && edit.personId === row.id ? edit.what : null;
        return (
          <li key={row.id} className="admin-person" data-testid={`nas-person-${row.name}`} data-person-id={row.id}>
            <div className="admin-person-head">
              <span className="library-name">
                <strong>{row.name}</strong> {row.badge && <span className="badge">{row.badge}</span>}{' '}
                <span className="status" data-testid="nas-person-saved">
                  · {row.saved}
                </span>
              </span>
              <span className="admin-person-actions">
                <button
                  type="button"
                  data-testid="nas-person-rename"
                  disabled={busy}
                  onClick={() => {
                    onError(null);
                    setName(row.name);
                    setEdit({ personId: row.id, what: 'rename' });
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  data-testid="nas-person-owner"
                  disabled={busy}
                  onClick={() =>
                    row.owner && losesNasSettings(people, thisDeviceId, { kind: 'remove-owner', personId: row.id })
                      ? setEdit({ personId: row.id, what: 'remove-owner' })
                      : run(() => nas.admin.updatePerson(row.id, { owner: !row.owner }))
                  }
                >
                  {row.owner ? 'Remove owner' : 'Make owner'}
                </button>
                {row.canClearSaved && (
                  <button type="button" data-testid="nas-person-clear" disabled={busy} onClick={() => setEdit({ personId: row.id, what: 'clear' })}>
                    Clear saved data
                  </button>
                )}
                <button type="button" data-testid="nas-person-remove" disabled={busy} onClick={() => setEdit({ personId: row.id, what: 'remove' })}>
                  Remove
                </button>
              </span>
            </div>
            {editing === 'rename' && (
              <form className="admin-own-form" onSubmit={(e) => rename(person, e)}>
                <label>
                  Name <input type="text" data-testid="nas-person-name" maxLength={MAX_PERSON_NAME} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <span className="admin-confirm">
                  <button type="submit" data-testid="nas-person-save" disabled={busy}>
                    Save
                  </button>
                  {cancel}
                </span>
              </form>
            )}
            {editing === 'remove-owner' && (
              <div className="admin-confirm-box" role="group" aria-label="Confirm">
                <p>{loseSettingsMessage}</p>
                <span className="admin-confirm">
                  <button type="button" data-testid="nas-person-owner-confirm" disabled={busy} onClick={() => run(() => nas.admin.updatePerson(row.id, { owner: false }))}>
                    Remove owner
                  </button>
                  {cancel}
                </span>
              </div>
            )}
            {(editing === 'remove' || editing === 'clear') && (
              <div className="admin-confirm-box" role="group" aria-label="Confirm">
                <p>{editing === 'remove' ? removePersonQuestion(person, thisDeviceId) : clearSavedQuestion(person)}</p>
                <span className="admin-confirm">
                  <button
                    type="button"
                    data-testid={editing === 'remove' ? 'nas-person-remove-confirm' : 'nas-person-clear-confirm'}
                    disabled={busy}
                    onClick={() => run(() => (editing === 'remove' ? nas.admin.removePerson(row.id) : nas.admin.clearSavedData(row.id)))}
                  >
                    {editing === 'remove' ? 'Remove' : 'Clear saved data'}
                  </button>
                  {cancel}
                </span>
              </div>
            )}
            {row.noDevices && <p className="status">{row.noDevices}</p>}
            {row.devices.length > 0 && (
              <ul className="library-rows">
                {row.devices.map((d) => {
                  const deviceEdit = edit !== null && 'deviceId' in edit && edit.deviceId === d.id ? edit.what : null;
                  const targets = moveTargets(people, row.id);
                  return (
                    <li key={d.id} className="admin-device" data-testid="nas-device" data-device-id={d.id}>
                      <span className="library-name">
                        {d.text}
                        {d.route && (
                          <span className="status" data-testid="nas-device-route">
                            {' '}
                            · {d.route}
                          </span>
                        )}
                      </span>
                      {deviceEdit === 'move' ? (
                        <span className="admin-confirm">
                          <label>
                            Move to{' '}
                            <select data-testid="nas-device-move-to" value={moveTo} disabled={busy} onChange={(e) => setMoveTo(e.target.value)}>
                              <option value="" disabled>
                                Choose…
                              </option>
                              {targets.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          {moveTo !== '' && losesNasSettings(people, thisDeviceId, { kind: 'move', deviceId: d.id, toPersonId: moveTo }) && (
                            <span role="alert" data-testid="nas-device-move-warning">
                              {loseSettingsMessage}
                            </span>
                          )}
                          <button type="button" data-testid="nas-device-move-confirm" disabled={busy || moveTo === ''} onClick={() => run(() => nas.admin.moveDevice(d.id, moveTo))}>
                            Move
                          </button>
                          {cancel}
                        </span>
                      ) : deviceEdit === 'revoke' ? (
                        <span className="admin-confirm">
                          Revoke this device?{' '}
                          <button type="button" data-testid="nas-revoke-confirm" disabled={busy} onClick={() => run(() => nas.admin.revokeDevice(d.id))}>
                            Revoke
                          </button>{' '}
                          <button type="button" data-testid="nas-revoke-cancel" onClick={() => setEdit(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="admin-confirm">
                          {targets.length > 0 && (
                            <button
                              type="button"
                              data-testid="nas-device-move"
                              disabled={busy}
                              onClick={() => {
                                setMoveTo('');
                                setEdit({ deviceId: d.id, what: 'move' });
                              }}
                            >
                              Move to…
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid="nas-revoke"
                            disabled={busy}
                            onClick={() => (d.thisDevice ? setEdit({ deviceId: d.id, what: 'revoke' }) : run(() => nas.admin.revokeDevice(d.id)))}
                          >
                            Revoke
                          </button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
