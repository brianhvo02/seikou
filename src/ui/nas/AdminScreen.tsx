import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { TitleSummary } from '../../engine/disc/nas-api';
import { TMDB_ATTRIBUTION, codeListed, codePollEnd, countdown, countdownTickMs, deleteTitleQuestion, gateSwitchOn, matchingStatus, newCode, ownTitleKind, ownTitles, withGate } from './admin-model';
import { NasHttpError, type NasClient, type NasPerson, type NasTitleStatus } from './nas-client';
import { FansubLanguages } from './FansubLanguages';
import { EncodingNowSection } from './EncodingNowSection';
import { RelaySettings } from './RelaySettings';
import { PeopleSection } from './PeopleSection';
import { MAX_PERSON_NAME, NEW_PERSON, codeSummary, rendezvousNotice } from './people-model';
import { displayName } from './title-model';
import { parseNumber } from './unsorted-model';
import { qrSvg } from './qr';

interface AdminScreenProps {
  readonly nas: NasClient;
  /** This device's id, to mark its row; null when it isn't known. */
  readonly thisDeviceId: string | null;
  readonly onClose: () => void;
  /** An own title was renamed or deleted: the library fetches its titles again. */
  readonly onTitlesChanged?: () => void;
  /**
   * The NAS refused this device's admin call with 403: it is no longer an owner (another owner, or this screen, took
   * that away). The caller leaves the settings and checks `me` again. Defaults to `onClose`.
   */
  readonly onAccessLost?: () => void;
  /** The clock for the countdown and the last-seen times. */
  readonly now?: () => number;
}

/** While a code is shown, the people list is reloaded this often, so the device that redeems it turns up. */
const PEOPLE_POLL_MS = 3_000;
/** While titles are being matched, the status is reloaded this often. */
const STATUS_POLL_MS = 5_000;

interface ShownCode {
  readonly code: string;
  readonly link: string;
  readonly expiresAt: number;
  readonly mintedAt: number;
  readonly personId: string;
  readonly personName: string;
  readonly invite: boolean;
  /** Whether the rendezvous service registered the code: without it, a code is found only on the home network. */
  readonly rendezvous: boolean;
  readonly qr: { size: number; path: string };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The title library's part of NAS settings: the matching status, the release gate (as the NAS reports it; turning it on
 * asks first) and TMDB's attribution. Absent when the NAS has no title library (its status route answers 404).
 */
const MAX_NAME = 200;

/** What an own title's row has open: nothing, an inline editor, or the confirm step before deleting. */
type OwnEdit = { readonly id: string; readonly what: 'rename' | 'seasons' | 'delete' } | null;

/**
 * Own titles (spec §9, ruling T11g): each with its kind, Rename, Seasons (a series only) and Delete behind a confirm
 * step, through the admin titles routes; the list is fetched again after each change.
 */
function OwnTitlesSettings({ nas, onChanged }: { nas: NasClient; onChanged: () => void }): ReactElement {
  const [titles, setTitles] = useState<TitleSummary[] | null>(null);
  const [edit, setEdit] = useState<OwnEdit>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (): Promise<void> =>
      nas.titles().then(
        (list) => setTitles(ownTitles(list)),
        (err: unknown) => setError(message(err)),
      ),
    [nas],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const open = (t: TitleSummary, what: 'rename' | 'seasons' | 'delete'): void => {
    setError(null);
    setEdit({ id: t.id, what });
    setValue(what === 'rename' ? displayName(t) : what === 'seasons' ? String(t.seasons) : '');
  };

  const run = (work: Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    work.then(
      () => {
        setBusy(false);
        setEdit(null);
        onChanged();
        void load();
      },
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      },
    );
  };

  const save = (t: TitleSummary, e: FormEvent): void => {
    e.preventDefault();
    if (edit?.what === 'rename') {
      const name = value.trim();
      if (name === '') {
        setError('Give the title a name.');
        return;
      }
      run(nas.admin.updateTitle(t.id, { name }));
    } else {
      const seasons = parseNumber(value);
      if (seasons === undefined || seasons === null) {
        setError('Seasons is a number from 1 to 1000.');
        return;
      }
      run(nas.admin.updateTitle(t.id, { seasons }));
    }
  };

  return (
    <div className="admin-own" data-testid="nas-own-titles">
      <h4>Own titles</h4>
      {titles === null ? (
        !error && <p className="status">Loading…</p>
      ) : titles.length === 0 ? (
        <p className="status">No own titles. Make one from Unsorted with “New title…”.</p>
      ) : (
        <ul className="library-rows">
          {titles.map((t) => {
            const name = displayName(t);
            const editing = edit?.id === t.id ? edit.what : null;
            return (
              <li key={t.id} className="admin-own-row" data-testid="nas-own-title" data-name={name}>
                <div className="admin-own-main">
                  <span className="library-name">
                    {name} <span className="status">· {ownTitleKind(t)}</span>
                  </span>
                  <span className="admin-own-actions">
                    <button type="button" onClick={() => open(t, 'rename')} aria-label={`Rename ${name}`}>
                      Rename
                    </button>
                    {t.kind === 'series' && (
                      <button type="button" onClick={() => open(t, 'seasons')} aria-label={`Seasons of ${name}`}>
                        Seasons
                      </button>
                    )}
                    <button type="button" onClick={() => open(t, 'delete')} aria-label={`Delete ${name}`}>
                      Delete
                    </button>
                  </span>
                </div>
                {editing === 'delete' ? (
                  <div className="admin-confirm-box" role="group" aria-label="Confirm">
                    <p>{deleteTitleQuestion(name)}</p>
                    <span className="admin-confirm">
                      <button type="button" data-testid="nas-own-delete-confirm" disabled={busy} onClick={() => run(nas.admin.deleteTitle(t.id))}>
                        Delete
                      </button>
                      <button type="button" onClick={() => setEdit(null)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : editing !== null ? (
                  <form className="admin-own-form" onSubmit={(e) => save(t, e)}>
                    <label>
                      {editing === 'rename' ? 'Name' : 'Seasons'}{' '}
                      <input
                        type="text"
                        inputMode={editing === 'seasons' ? 'numeric' : undefined}
                        maxLength={editing === 'rename' ? MAX_NAME : 4}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                      />
                    </label>
                    <span className="admin-confirm">
                      <button type="submit" data-testid="nas-own-save" disabled={busy}>
                        Save
                      </button>
                      <button type="button" onClick={() => setEdit(null)}>
                        Cancel
                      </button>
                    </span>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="status" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function TitleLibrarySettings({ nas, now, onTitlesChanged }: { nas: NasClient; now: () => number; onTitlesChanged: () => void }): ReactElement {
  const [status, setStatus] = useState<NasTitleStatus | null>(null);
  /** The NAS has no title library: its status route answered 404. */
  const [missing, setMissing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const load = (): void => {
      nas.admin.titleStatus().then(
        (s) => {
          if (!live) return;
          setStatus(s);
          setStatusError(null);
          if (s.running) timer = window.setTimeout(load, STATUS_POLL_MS);
        },
        (err: unknown) => {
          if (!live) return;
          if (err instanceof NasHttpError && err.status === 404) setMissing(true);
          else setStatusError(message(err));
        },
      );
    };
    load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [nas, attempt]);

  const setGate = (open: boolean): void => {
    setBusy(true);
    setError(null);
    nas.admin.setTitleLibrary(open ? 'everyone' : 'owners').then(
      () => {
        setBusy(false);
        setConfirming(false);
        setStatus((s) => withGate(s, open ? 'everyone' : 'owners'));
      },
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      },
    );
  };

  const shown = status === null ? null : matchingStatus(status, now());
  return (
    <section className="admin-titles" data-testid="nas-title-settings" aria-labelledby="admin-titles-head">
      <h3 id="admin-titles-head">Title library</h3>
      {shown && (
        <div data-testid="nas-matching">
          <p className="status">{shown.progress}</p>
          <p className="status">{shown.counts}</p>
          {shown.tmdb && <p className="status">{shown.tmdb}</p>}
        </div>
      )}
      {statusError && (
        <div className="admin-confirm-box" role="alert" data-testid="nas-matching-error">
          <p>The matching status didn't load: {statusError}</p>
          <button
            type="button"
            data-testid="nas-matching-retry"
            onClick={() => {
              setStatusError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {!missing && status !== null && (
        <>
          <label className="admin-switch">
            <input
              type="checkbox"
              role="switch"
              data-testid="nas-gate"
              checked={gateSwitchOn(status, confirming)}
              disabled={busy}
              onChange={(e) => (e.target.checked ? setConfirming(true) : confirming ? setConfirming(false) : setGate(false))}
            />{' '}
            Show the title library to everyone
          </label>
          {confirming && (
            <div className="admin-confirm-box" role="group" aria-label="Confirm">
              <p>Guests will browse by title from their next app load. Hidden discs stay hidden.</p>
              <span className="admin-confirm">
                <button type="button" data-testid="nas-gate-confirm" disabled={busy} onClick={() => setGate(true)}>
                  Show to everyone
                </button>
                <button type="button" data-testid="nas-gate-cancel" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </span>
            </div>
          )}
        </>
      )}
      {!missing && <OwnTitlesSettings nas={nas} onChanged={onTitlesChanged} />}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <p className="admin-tmdb" data-testid="nas-tmdb">
        <img src={`${import.meta.env.BASE_URL}tmdb-logo.svg`} alt="TMDB" width={92} height={12} />
        <span data-testid="nas-tmdb-text">{TMDB_ATTRIBUTION}</span>
      </p>
    </section>
  );
}

/**
 * NAS settings, for owners: a new pairing code for a person (or a new one, optionally as a 3-day invite) with its QR and
 * countdown, the People list (spec §4.3), and Rescan.
 */
export function AdminScreen({ nas, thisDeviceId, onClose, onAccessLost, now = Date.now, onTitlesChanged }: AdminScreenProps): ReactElement {
  const [people, setPeople] = useState<NasPerson[] | null>(null);
  /** The person picker: a person's id, or NEW_PERSON. */
  const [picked, setPicked] = useState(NEW_PERSON);
  const [newName, setNewName] = useState('');
  const [newOwner, setNewOwner] = useState(false);
  const [invite, setInvite] = useState(false);
  const [code, setCode] = useState<ShownCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLElement>(null);
  const [, setTick] = useState(0);

  // Kept in a ref: callers pass a new function each render, and loadPeople must stay the same one.
  const accessLost = useRef(onAccessLost ?? onClose);
  accessLost.current = onAccessLost ?? onClose;
  /**
   * Loads the people. A failing poll only shows its error when no other is showing, so it can't hide a refusal unread.
   * A 403 means this device is no longer an owner: the settings close.
   */
  const loadPeople = useCallback(
    (poll: boolean): Promise<void> =>
      nas.admin.people().then(setPeople, (err: unknown) => {
        if (err instanceof NasHttpError && err.status === 403) accessLost.current();
        else setError((shown) => (poll && shown !== null ? shown : message(err)));
      }),
    [nas],
  );
  useEffect(() => {
    void loadPeople(false);
  }, [loadPeople]);
  const reloadPeople = useCallback(() => void loadPeople(false), [loadPeople]);

  // A person picked who was listed and has since gone (removed here) falls back to "New person…".
  const listedBefore = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (people === null) return;
    const ids = new Set(people.map((p) => p.id));
    if (picked !== NEW_PERSON && listedBefore.current.has(picked) && !ids.has(picked)) setPicked(NEW_PERSON);
    listedBefore.current = ids;
  }, [people, picked]);

  const live = code !== null && now() < code.expiresAt;
  const tickMs = code === null ? 1_000 : countdownTickMs(code.expiresAt, now());
  useEffect(() => {
    if (!live) return;
    const tick = window.setInterval(() => setTick((t) => t + 1), tickMs);
    return () => window.clearInterval(tick);
  }, [live, tickMs]);

  // The people list is polled so the device that redeems the code turns up: until the NAS no longer lists the code,
  // for at most 10 minutes (an invite may wait 3 days).
  const [codeGone, setCodeGone] = useState(false);
  const polling = code !== null && !codeGone && now() < codePollEnd(code.expiresAt, code.mintedAt);
  useEffect(() => {
    if (!polling || code === null) return;
    const shown = code;
    const poll = window.setInterval(() => {
      nas.admin.codes().then(
        (codes) => {
          if (!codeListed(codes, shown)) setCodeGone(true);
          void loadPeople(true);
        },
        () => void loadPeople(true),
      );
    }, PEOPLE_POLL_MS);
    return () => window.clearInterval(poll);
  }, [polling, code, nas, loadPeople]);

  const onNewCode = (e: FormEvent): void => {
    e.preventDefault();
    setError(null);
    setMinting(true);
    newCode(nas.admin, picked, newName, newOwner, invite).then(
      (minted) => {
        setCode({ ...minted, mintedAt: now(), qr: qrSvg(minted.link) });
        setCodeGone(false);
        setCopied(false);
        setMinting(false);
        // A new person is on the NAS now, listed at once: the next code goes to them unless another is picked.
        setPeople((list) =>
          list === null || list.some((p) => p.id === minted.personId)
            ? list
            : [...list, { id: minted.personId, name: minted.personName, owner: newOwner, createdAt: now(), savedBytes: 0, devices: [] }],
        );
        setPicked(minted.personId);
        setNewName('');
        setNewOwner(false);
        void loadPeople(false);
      },
      (err: unknown) => {
        setError(message(err));
        setMinting(false);
      },
    );
  };

  /** Without a clipboard (no secure context, some webviews), or when writing fails, the code is selected instead. */
  const canCopy = typeof navigator.clipboard?.writeText === 'function';
  const selectCode = (): void => {
    const el = codeRef.current;
    if (el) window.getSelection()?.selectAllChildren(el);
  };
  const onCopy = (): void => {
    if (!code) return;
    let writing: Promise<void>;
    try {
      writing = navigator.clipboard.writeText(code.code);
    } catch {
      selectCode();
      return;
    }
    writing.then(
      () => setCopied(true),
      () => {
        setCopied(false);
        selectCode();
      },
    );
  };

  const onRescan = (): void => {
    setError(null);
    nas.admin.rescan().then(
      () => setStatus('Rescanning…'),
      (err: unknown) => setError(message(err)),
    );
  };

  const at = now();

  return (
    <section className="library admin" data-testid="nas-admin">
      <div className="library-head">
        <h2>NAS settings</h2>
        <button type="button" onClick={onClose}>
          Back
        </button>
      </div>
      <form className="admin-new-code" onSubmit={onNewCode}>
        <label>
          For{' '}
          <select data-testid="nas-code-person" value={picked} onChange={(e) => setPicked(e.target.value)} disabled={minting}>
            {(people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PERSON}>New person…</option>
          </select>
        </label>
        {picked === NEW_PERSON && (
          <>
            <label>
              Name{' '}
              <input
                type="text"
                data-testid="nas-new-person-name"
                maxLength={MAX_PERSON_NAME}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={minting}
              />
            </label>
            <label className="admin-owner">
              <input type="checkbox" data-testid="nas-new-person-owner" checked={newOwner} onChange={(e) => setNewOwner(e.target.checked)} disabled={minting} /> Owner
            </label>
          </>
        )}
        <label className="admin-owner">
          <input type="checkbox" data-testid="nas-code-invite" checked={invite} onChange={(e) => setInvite(e.target.checked)} disabled={minting} /> Send as an invite
          (valid 3 days)
        </label>
        <button type="submit" className="primary" data-testid="nas-new-code" disabled={minting}>
          New pairing code
        </button>
      </form>
      {code && (
        <div className="admin-code">
          <svg
            data-testid="nas-code-qr"
            className="admin-qr"
            role="img"
            aria-label="QR code of the pairing link"
            viewBox={`0 0 ${code.qr.size} ${code.qr.size}`}
            shapeRendering="crispEdges"
          >
            <rect width={code.qr.size} height={code.qr.size} fill="#fff" />
            <path d={code.qr.path} fill="#000" />
          </svg>
          <p>
            <code ref={codeRef} className="admin-code-text" data-testid="nas-code">
              {code.code}
            </code>{' '}
            {canCopy && (
              <button type="button" data-testid="nas-code-copy" onClick={onCopy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </p>
          <p className="status" data-testid="nas-code-for">
            {codeSummary(code.personName, code.invite)}
          </p>
          <p className="status" data-testid="nas-code-expiry">
            {countdown(code.expiresAt, at)}
          </p>
          {rendezvousNotice(code.rendezvous) && (
            <p className="status" role="note" data-testid="nas-code-rendezvous">
              {rendezvousNotice(code.rendezvous)}
            </p>
          )}
        </div>
      )}
      <h3>People</h3>
      <PeopleSection nas={nas} people={people} thisDeviceId={thisDeviceId} now={at} onChanged={reloadPeople} onError={setError} />
      <div>
        <button type="button" data-testid="nas-rescan" onClick={onRescan}>
          Rescan
        </button>
      </div>
      <RelaySettings nas={nas} />
      <EncodingNowSection nas={nas} />
      <FansubLanguages nas={nas} />
      <TitleLibrarySettings nas={nas} now={now} onTitlesChanged={onTitlesChanged ?? (() => {})} />
      {status && (
        <p className="status" role="status" data-testid="nas-admin-status">
          {status}
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-admin-error">
          {error}
        </div>
      )}
    </section>
  );
}
