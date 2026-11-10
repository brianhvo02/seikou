// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { NasPairingRequest, NasStatus } from '../api-types';
import type { AppApi } from './app-api';

/** What the section needs: the backend client. */
export interface NasPairingProps {
  readonly api: Pick<AppApi, 'nas' | 'pairNas' | 'unpairNas'>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The request a filled form makes: the link when one is pasted, else the code and the address. */
export function pairingRequest(code: string, base: string, link: string): NasPairingRequest {
  return link.trim() !== '' ? { link: link.trim() } : { code: code.trim(), base: base.trim() };
}

/** The pairing form: a code with the NAS's address, or a pasted pairing link. */
function PairForm({ onPair }: { readonly onPair: (request: NasPairingRequest) => Promise<void> }) {
  const id = useId();
  const [code, setCode] = useState('');
  const [base, setBase] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = link.trim() !== '' || (code.trim() !== '' && base.trim() !== '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await onPair(pairingRequest(code, base, link));
    } catch (err) {
      setProblem(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <form className="nas-form" onSubmit={(e) => void submit(e)}>
      <div className="field-pair">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-code`}>
            Pairing code
          </label>
          <input id={`${id}-code`} type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="K7QM-4XP2-R9TD" spellCheck={false} autoComplete="off" />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-base`}>
            NAS address
          </label>
          <input id={`${id}-base`} type="text" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://…/bluray/api/" spellCheck={false} autoComplete="off" />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-link`}>
          Or paste the pairing link
        </label>
        <input id={`${id}-link`} type="text" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…?pair=…" spellCheck={false} autoComplete="off" />
        <span className="hint">The link under the code's QR code names the NAS, so it needs no address.</span>
      </div>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !ready}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
    </form>
  );
}

/** What the NAS says about encodes, in a line; null when there is nothing to add. */
function encodesLine(status: NasStatus & { paired: true }): string | null {
  if (!status.reachable) return "The NAS isn't answering right now. The encoder asks again when you come back to this page.";
  if (status.encodes === 'ready') return 'The NAS keeps encodes, so finished episodes can go to its Encodes library.';
  if (status.encodes === 'not-configured') return "The NAS has no encodes folder: ENCODES_MOUNT isn't set in its .env. Set it and restart the NAS to upload episodes.";
  return null;
}

/**
 * The Settings page's "Your NAS" section. Unpaired, a form takes an owner pairing code with the NAS's address, or a
 * pairing link; paired, it names the NAS's host and the person the encoder paired as, says whether the NAS answers
 * and keeps encodes, and offers Unpair after a confirmation.
 */
export function NasPairing({ api }: NasPairingProps) {
  const [status, setStatus] = useState<NasStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** False once the section is gone, so a late answer sets no state. */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    api.nas().then(
      (s) => mounted.current && setStatus(s),
      (e: unknown) => mounted.current && setLoadError(messageOf(e)),
    );
    return () => {
      mounted.current = false;
    };
  }, [api]);

  const unpair = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api.unpairNas();
      if (mounted.current) setStatus({ paired: false });
    } catch (e) {
      if (mounted.current) setProblem(messageOf(e));
    } finally {
      if (mounted.current) {
        setBusy(false);
        setConfirming(false);
      }
    }
  };

  let body;
  if (loadError !== null) {
    body = (
      <p className="error" role="alert">
        {loadError}
      </p>
    );
  } else if (status === null) {
    body = <p className="muted">Asking the NAS…</p>;
  } else if (!status.paired) {
    body = (
      <>
        <p className="muted nas-lead">
          Pair the encoder with Seikou's NAS to read discs from it and upload finished episodes. Make an owner pairing code in Seikou's admin
          screen, then type it here with the NAS's address.
        </p>
        <PairForm
          onPair={async (request) => {
            const paired = await api.pairNas(request);
            if (mounted.current) setStatus(paired);
          }}
        />
      </>
    );
  } else {
    const line = encodesLine(status);
    body = (
      <div className="nas-paired">
        <p className="nas-who">
          <span className={status.reachable ? 'nas-dot' : 'nas-dot nas-dot-off'} aria-hidden="true" />
          <span>
            Paired with <span className="nas-host">{status.host}</span> as {status.personName}
          </span>
        </p>
        {line !== null && <p className={status.reachable ? 'muted' : 'error'}>{line}</p>}
        {problem !== null && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
        <div className="profile-actions nas-actions">
          {confirming ? (
            <>
              <span className="muted">Unpair this encoder? Seikou's admin screen still lists it until an owner removes it.</span>
              <button type="button" className="quiet danger" disabled={busy} onClick={() => void unpair()}>
                Yes, unpair
              </button>
              <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="quiet" onClick={() => setConfirming(true)}>
              Unpair
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="nas-section" aria-labelledby="nas-heading">
      <h2 id="nas-heading">Your NAS</h2>
      {body}
    </section>
  );
}
