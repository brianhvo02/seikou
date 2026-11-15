import { createByteSource } from '@seikou/engine/disc/disc-spec';
import { serverDiscSpec, serverLinkFromLocation } from '../ui/disc-server';
import type { RemoteDiscSpec } from '@seikou/engine/disc/disc-spec';
import { qrSvg } from '../ui/nas/qr';
import { runChecks, type DecodeRateReply, type DecodeRateRequest, type ProbeDisc, type ProbeEnv, type ProbeFile, type ProbeResult, type WorkerInput, type WorkerProbe } from './checks';
import { pickNasDisc } from './nas-pick';

const root = document.getElementById('root') as HTMLElement;
const logView = document.createElement('pre');
const lines: string[] = [];
const t0 = performance.now();
/** Appends a timestamped line to the live log (kept in the copied JSON too). */
function log(line: string): void {
  lines.push(`${((performance.now() - t0) / 1000).toFixed(1)} s  ${line}`);
  logView.textContent = lines.join('\n');
}

/** The folder picker's button and the files it hands over. */
function folderPicker(): { button: HTMLButtonElement; input: HTMLInputElement; files: Promise<File[]> } {
  const button = document.createElement('button');
  button.textContent = 'Pick a disc folder';
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.setAttribute('webkitdirectory', '');
  input.hidden = true;
  const files = new Promise<File[]>((resolve) => {
    input.addEventListener('change', () => {
      log(`files handed over (${input.files?.length ?? 0})`);
      button.disabled = true;
      resolve([...(input.files ?? [])]);
    });
  });
  button.addEventListener('click', () => {
    log('picker opened');
    input.click();
  });
  return { button, input, files };
}

/** A served disc as the checks read it: its file list, and a byte-range read per file through RemoteSource. */
function servedDisc(spec: RemoteDiscSpec): ProbeDisc {
  // the probe reads a few ranges: no read-ahead beyond the chunk a read needs
  const source = createByteSource(spec, { fetch: (input, init) => fetch(input, init), readAheadBytes: 0, onWaiting: () => undefined });
  const files = source.paths().map((path): ProbeFile => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    size: source.size(path),
    webkitRelativePath: path,
    slice: (start, end) => ({ arrayBuffer: async () => (await source.read(path, start, end - start)).slice().buffer }),
  }));
  return { route: 'server', files, server: spec };
}

/**
 * Asks where the disc comes from: a picked folder (where the browser can pick folders) or a disc on the paired NAS
 * (the only way on a TV, which has no folder picker).
 */
function chooseDisc(): Promise<ProbeDisc> {
  return new Promise((resolve, reject) => {
    const nasButton = document.createElement('button');
    nasButton.textContent = 'Use a disc on the NAS';
    nasButton.addEventListener('click', () => {
      log('NAS route chosen');
      pickNasDisc(root, log).then((spec) => {
        root.replaceChildren(logView);
        resolve(servedDisc(spec));
      }, reject);
    });
    const choices: HTMLElement[] = [nasButton];
    if ('webkitdirectory' in HTMLInputElement.prototype) {
      const picker = folderPicker();
      picker.files.then((files) => resolve({ route: 'folder', files }), reject);
      choices.unshift(picker.button, picker.input);
    }
    root.replaceChildren(...choices, logView);
    (choices[0] as HTMLButtonElement).focus();
  });
}

/**
 * `probe.html?disc=<disc API base>&token=<token>` probes a disc on the development disc server (tools/disc-server) instead
 * of a picked folder, so tools/devices/probe.ts can run it without a human. It is read as the player reads a NAS disc:
 * the manifest, then range reads through RemoteSource.
 */
async function openServerDisc(base: string, token: string): Promise<ProbeDisc> {
  return servedDisc(await serverDiscSpec({ name: 'the disc', base }, token));
}

function openDisc(): Promise<ProbeDisc> {
  const params = new URL(window.location.href).searchParams;
  // same origin only: the token goes back to the server that served this page and nowhere else
  const link = serverLinkFromLocation(window.location.href);
  if (params.has('disc') && !link?.disc) return Promise.reject(new Error('the disc URL must be on the same server as this page'));
  if (link?.disc) {
    root.replaceChildren(logView);
    log('probing the disc on the disc server');
    return openServerDisc(link.disc, link.token);
  }
  return chooseDisc();
}

function worker(input: WorkerInput): Promise<WorkerProbe> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerProbe>) => {
      resolve(e.data);
      w.terminate();
    };
    const fail = (message: string) => (): void => {
      reject(new Error(message));
      w.terminate();
    };
    w.onerror = fail('worker failed');
    w.onmessageerror = fail('worker message failed');
    w.postMessage(input);
  });
}

/** The decode-rate worker gives up a little before its check does, and is stopped, so it can't hold the decoder for the next. */
const DECODE_RATE_WORKER_TIMEOUT_MS = 170_000;

function decodeRate(request: DecodeRateRequest): Promise<DecodeRateReply> {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./decode-rate-worker.ts', import.meta.url), { type: 'module' });
    const finish = (reply: DecodeRateReply): void => {
      clearTimeout(timer);
      w.terminate();
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ error: 'timed out' }), DECODE_RATE_WORKER_TIMEOUT_MS);
    w.onmessage = (e: MessageEvent<DecodeRateReply>) => finish(e.data);
    w.onerror = () => finish({ error: 'worker failed' });
    w.onmessageerror = () => finish({ error: 'worker message failed' });
    w.postMessage(request);
  });
}

/**
 * Arrow keys move focus through the page's buttons and fields in order, since a TV remote has no pointer and the TV's
 * browser doesn't move focus by itself; Enter on a focused button clicks it as usual. Left and right stay with a field.
 */
function arrowFocus(): void {
  document.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const all = [...document.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([hidden])')];
    if (all.length === 0) return;
    const at = active instanceof HTMLElement ? all.indexOf(active) : -1;
    const next = all[Math.min(all.length - 1, Math.max(0, at + step))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  });
}

/** A QR of the results (no log), so they can be read off a TV with a phone; null when they don't fit in one. */
function resultsQr(results: readonly ProbeResult[]): SVGSVGElement | null {
  let qr: { size: number; path: string };
  try {
    qr = qrSvg(JSON.stringify({ ua: navigator.userAgent, r: results.map((r) => [r.name, r.ok ? 1 : 0, r.detail]) }));
  } catch {
    return null;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${qr.size} ${qr.size}`);
  svg.setAttribute('class', 'qr');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(qr.size));
  bg.setAttribute('height', String(qr.size));
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', qr.path);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

arrowFocus();

const env: ProbeEnv = {
  openDisc,
  createAudioContext: () => new AudioContext({ sampleRate: 48000 }),
  worker,
  decodeRate,
  globals: globalThis as unknown as Record<string, unknown>,
  log,
};

/** Read by tools/devices/probe.ts once the checks finish. */
const published = window as unknown as { __probeResults?: { userAgent: string; results?: ProbeResult[]; error?: string } };

runChecks(env).then((results) => {
  log('done');
  published.__probeResults = { userAgent: navigator.userAgent, results };
  root.replaceChildren();
  const table = document.createElement('table');
  for (const r of results) {
    const row = table.insertRow();
    row.insertCell().textContent = r.name;
    const status = row.insertCell();
    status.textContent = r.ok ? 'ok' : 'FAIL';
    status.className = r.ok ? 'ok' : 'fail';
    row.insertCell().textContent = r.detail;
  }
  const copy = document.createElement('button');
  copy.textContent = 'Copy as JSON';
  copy.addEventListener('click', () => {
    const json = JSON.stringify({ userAgent: navigator.userAgent, results, log: lines }, null, 2);
    void navigator.clipboard.writeText(json).catch(() => window.prompt('Copy:', json));
  });
  const qr = resultsQr(results);
  // the QR sits beside the table: a TV remote moves focus, it doesn't scroll
  const resultsRow = document.createElement('div');
  resultsRow.className = 'results';
  const left = document.createElement('div');
  left.append(table, copy);
  resultsRow.append(left, ...(qr ? [qr] : []));
  root.append(resultsRow, logView);
  copy.focus();
}).catch((err: unknown) => {
  published.__probeResults = { userAgent: navigator.userAgent, error: err instanceof Error ? err.message : String(err) };
  log(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  root.replaceChildren(logView);
});
