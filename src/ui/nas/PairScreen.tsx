import { useState, type FormEvent, type ReactElement } from 'react';
import { normalizeCode } from '../../engine/disc/pairing-code';
import { NAS_MESSAGES, defaultDeviceName, groupCodeInput, type NasClient } from './nas-client';
import { allowedPairUrl, foreignHosts, isLoopbackHost, type PairLink } from './pair-link';

interface PairScreenProps {
  readonly client: NasClient;
  /** A `?pair=` link, with the server or Worker it names (already checked by `parsePairLink`). */
  readonly link?: PairLink;
  readonly onPaired: () => void;
  /** Cancel on the confirmation: the link isn't offered again. */
  readonly onLinkDropped?: () => void;
  /** Whether `http:` loopback addresses are accepted (the app served from a loopback origin, ruling R1). */
  readonly dev?: boolean;
  /** This device is already paired, so pairing again replaces that pairing (said on the confirmation). */
  readonly paired?: boolean;
}

/**
 * The pairing code, this device's name and a Pair button. A link that names a server or Worker other than the app's
 * own is shown to the person first (`pair-confirm`), and nothing is sent until they continue. A typed code goes to the
 * built-in Worker, or to the one entered under "Use another rendezvous" (folded away by default).
 */
export function PairScreen({ client, link, onPaired, onLinkDropped, dev = isLoopbackHost(window.location.hostname), paired = false }: PairScreenProps): ReactElement {
  const [code, setCode] = useState(() => groupCodeInput(link?.code ?? ''));
  const [deviceName, setDeviceName] = useState(() => defaultDeviceName(navigator.userAgent, navigator.maxTouchPoints));
  const [busy, setBusy] = useState(false);
  /** What the link named (cleared by Cancel), and whether the person still has to confirm its hosts. */
  const [via, setVia] = useState<{ readonly nas?: string; readonly rv?: string }>(() =>
    (link?.dropped?.length ?? 0) > 0
      ? {}
      : { ...(link?.nas === undefined ? {} : { nas: link.nas }), ...(link?.rv === undefined ? {} : { rv: link.rv }) },
  );
  /** A link with an address that failed its check: its code goes nowhere until the person changes it. */
  const [refused, setRefused] = useState(() => (link?.dropped?.length ?? 0) > 0);
  const [hosts] = useState(() => (link && !refused ? foreignHosts(link, client.builtInRendezvousUrl) : []));
  const [confirming, setConfirming] = useState(hosts.length > 0);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherRv, setOtherRv] = useState('');
  const [error, setError] = useState<string | null>(() =>
    refused ? NAS_MESSAGES.badLink : link && link.nas === undefined && link.rv === undefined && !client.canPairByCode ? NAS_MESSAGES.noRendezvous : null,
  );

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (refused) return;
    setError(null);
    let target = via;
    if (via.nas === undefined && via.rv === undefined && otherOpen && otherRv.trim() !== '') {
      const rv = allowedPairUrl(otherRv, { dev });
      if (rv === null) {
        setError(NAS_MESSAGES.badRendezvous);
        return;
      }
      target = { rv };
    }
    setBusy(true);
    client.pair(code, deviceName, target).then(onPaired, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
  };

  if (confirming)
    return (
      <section className="pair" data-testid="pair-screen">
        <h2>Pair with a NAS</h2>
        <div role="alertdialog" aria-labelledby="pair-confirm-text" data-testid="pair-confirm">
          <p id="pair-confirm-text">
            This link pairs with: <strong data-testid="pair-confirm-hosts">{hosts.join(', ')}</strong>. Only continue if you trust them.
          </p>
          {paired && <p data-testid="pair-confirm-replaces">This device is already paired: continuing replaces its current pairing.</p>}
          <p>
            <button type="button" data-testid="pair-confirm-continue" onClick={() => setConfirming(false)}>
              Continue
            </button>{' '}
            <button
              type="button"
              data-testid="pair-confirm-cancel"
              onClick={() => {
                // the link's code goes nowhere: what it named is dropped, and so is the code
                setVia({});
                setCode('');
                setConfirming(false);
                onLinkDropped?.();
              }}
            >
              Cancel
            </button>
          </p>
        </div>
      </section>
    );

  const fromLink = via.nas !== undefined || via.rv !== undefined;
  return (
    <section className="pair" data-testid="pair-screen">
      <h2>Pair with a NAS</h2>
      <form onSubmit={onSubmit}>
        <label>
          Pairing code{' '}
          <input
            data-testid="pair-code"
            value={code}
            onChange={(e) => {
              setCode(groupCodeInput(e.target.value));
              if (refused) {
                setRefused(false);
                setError(null);
              }
            }}
            placeholder="XXXX-XXXX-XXXX"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>{' '}
        <label>
          Device name{' '}
          <input data-testid="pair-device-name" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={100} disabled={busy} />
        </label>{' '}
        <button type="submit" className="primary" data-testid="pair-button" disabled={busy || refused || normalizeCode(code) === null || deviceName.trim() === ''}>
          Pair
        </button>
      </form>
      {fromLink ? (
        hosts.length > 0 && (
          <p className="status" data-testid="pair-via">
            Pairing with {hosts.join(', ')}.
          </p>
        )
      ) : (
        <div className="pair-other">
          <button
            type="button"
            className="link-button"
            data-testid="pair-other-rendezvous"
            aria-expanded={otherOpen}
            aria-controls="pair-other-rendezvous-field"
            onClick={() => setOtherOpen((open) => !open)}
            disabled={busy}
          >
            Use another rendezvous
          </button>
          {otherOpen && (
            <label id="pair-other-rendezvous-field">
              Rendezvous address{' '}
              <input
                data-testid="pair-rendezvous-url"
                type="url"
                value={otherRv}
                onChange={(e) => setOtherRv(e.target.value)}
                placeholder="https://rendezvous.example.workers.dev"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          )}
        </div>
      )}
      {busy && (
        <p className="status" role="status">
          {NAS_MESSAGES.allowLocalNetwork}
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="pair-error">
          {error}
        </div>
      )}
    </section>
  );
}
