// SPDX-License-Identifier: LGPL-3.0-or-later
import type { RemoteDiscSpec } from '@seikou/engine/disc/disc-spec';
import { NasClient, defaultDeviceName } from '../ui/nas/nas-client';
import { idbNasStore } from '../ui/nas/nas-store';

/**
 * The probe's way to a NAS disc on a device with no folder picker (a TV): it pairs with the NAS by code if this origin
 * isn't paired yet (the pairing is the app's own, kept in this origin's IndexedDB, so the app finds it later), lets the
 * user walk the NAS's folders with the remote, and gives the picked disc's spec. HTTPS only: a disc reached over WebRTC
 * is read through a fetch port on the page, which the probe's workers don't have.
 */
export async function pickNasDisc(root: HTMLElement, log: (line: string) => void): Promise<RemoteDiscSpec> {
  const nas = new NasClient({
    fetch: (input, init) => fetch(input, init),
    subtle: crypto.subtle,
    store: idbNasStore(),
    now: Date.now,
    rendezvousUrl: import.meta.env.VITE_RENDEZVOUS_URL as string | undefined,
  });
  if (!(await nas.pairing())) await pair(nas, root, log);
  const id = await browse(nas, root, '');
  log(`disc ${id} picked`);
  const [session, base, manifest] = await Promise.all([nas.session(), nas.discBase(id), nas.manifest(id)]);
  if (!base.startsWith('https://') && !base.startsWith('http://')) throw new Error('the NAS was reached over WebRTC; the probe reads NAS discs over HTTPS only');
  return { kind: 'remote', base, token: session.token, manifest };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Asks for a pairing code (minted on the NAS, `deploy.sh --owner-code` or People in NAS settings) until one pairs. */
function pair(nas: NasClient, root: HTMLElement, log: (line: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const heading = element('h2', 'Pair with your NAS');
    const note = element('p', 'Type a pairing code from the NAS (NAS settings → People, or deploy.sh --owner-code).');
    const input = element('input');
    input.placeholder = 'Pairing code';
    input.autocapitalize = 'characters';
    const button = element('button', 'Pair');
    const status = element('p');
    const deviceName = 'tizen' in globalThis ? 'Samsung TV' : defaultDeviceName(navigator.userAgent, navigator.maxTouchPoints);
    const submit = (): void => {
      button.disabled = true;
      status.textContent = 'Pairing…';
      nas.pair(input.value, deviceName).then(
        () => {
          log(`paired as ${deviceName}`);
          resolve();
        },
        (err: unknown) => {
          status.textContent = err instanceof Error ? err.message : String(err);
          button.disabled = false;
        },
      );
    };
    button.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    root.replaceChildren(heading, note, input, button, status);
    input.focus();
  });
}

/** Lists a NAS folder as buttons (Up, its folders, its discs) and resolves with the id of the disc picked. */
async function browse(nas: NasClient, root: HTMLElement, path: string): Promise<string> {
  root.replaceChildren(element('p', `Loading ${path || 'the library'}…`));
  const { folders, discs } = await nas.library(path);
  return new Promise((resolve) => {
    const list = element('div');
    list.className = 'pick-list';
    const add = (label: string, onClick: () => void): HTMLButtonElement => {
      const button = element('button', label);
      button.addEventListener('click', onClick);
      list.append(button);
      return button;
    };
    if (path !== '') {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      add('↑ Up', () => void browse(nas, root, parent).then(resolve));
    }
    for (const f of folders) add(`📁 ${f.name} (${f.discs})`, () => void browse(nas, root, f.path).then(resolve));
    for (const d of discs) add(`💿 ${d.name} — ${(d.sizeBytes / 2 ** 30).toFixed(1)} GiB`, () => resolve(d.id));
    root.replaceChildren(element('h2', path || 'NAS library'), element('p', 'Pick a disc with H.264 or HEVC video (a large Blu-ray is the most telling).'), list);
    (list.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
}
