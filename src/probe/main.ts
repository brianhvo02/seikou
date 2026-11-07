import { createByteSource } from '@seikou/engine/disc/disc-spec';
import { serverDiscSpec, serverLinkFromLocation } from '../ui/disc-server';
import { runChecks, type ProbeDisc, type ProbeEnv, type ProbeFile, type ProbeResult, type WorkerInput, type WorkerProbe } from './checks';

const root = document.getElementById('root') as HTMLElement;
const logView = document.createElement('pre');
const lines: string[] = [];
const t0 = performance.now();
/** Appends a timestamped line to the live log (kept in the copied JSON too). */
function log(line: string): void {
  lines.push(`${((performance.now() - t0) / 1000).toFixed(1)} s  ${line}`);
  logView.textContent = lines.join('\n');
}

function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const button = document.createElement('button');
    button.textContent = 'Pick a disc folder';
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.hidden = true;
    input.addEventListener('change', () => {
      log(`files handed over (${input.files?.length ?? 0})`);
      button.disabled = true;
      resolve([...(input.files ?? [])]);
    });
    button.addEventListener('click', () => {
      log('picker opened');
      input.click();
    });
    root.append(button, input, logView);
  });
}

/**
 * `probe.html?disc=<disc API base>&token=<token>` probes a disc on the development disc server (tools/disc-server) instead
 * of a picked folder, so tools/devices/probe.ts can run it without a human. It is read as the player reads a NAS disc:
 * the manifest, then range reads through RemoteSource.
 */
async function openServerDisc(base: string, token: string): Promise<ProbeDisc> {
  const spec = await serverDiscSpec({ name: 'the disc', base }, token);
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
  return pickFolder().then((files) => ({ route: 'folder', files }));
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

const env: ProbeEnv = {
  openDisc,
  createAudioContext: () => new AudioContext({ sampleRate: 48000 }),
  worker,
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
  root.append(table, copy, logView);
}).catch((err: unknown) => {
  published.__probeResults = { userAgent: navigator.userAgent, error: err instanceof Error ? err.message : String(err) };
  log(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  root.replaceChildren(logView);
});
