import type { RemoteDiscSpec } from '@seikou/engine/disc/disc-spec';

export interface ProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface WorkerProbe {
  /** null only when the folder has no HEVC clip; `error` is set when probing it failed. */
  readonly hevc: { hvc1: boolean; hev1: boolean; decoded: boolean; error?: string } | null;
  readonly raf: { present: boolean; p95Ms: number };
  readonly webgl: { float: boolean; half: boolean };
}

/** The parts of a picked `File` the checks read; a file of a served disc imitates them (`slice` reads a byte range). */
export interface ProbeFile {
  readonly name: string;
  readonly size: number;
  readonly webkitRelativePath: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** A disc served by tools/disc-server, as the NAS's RemoteDiscSpec (manifest, API base `…/api/discs/<id>/`, token). */
export type ProbeServerRef = RemoteDiscSpec;

/** The disc under test: a folder picked on the device, or a disc on the development disc server (spec 2026-10-17 §4.5). */
export type ProbeDisc = { readonly route: 'folder'; readonly files: readonly File[] } | { readonly route: 'server'; readonly files: readonly ProbeFile[]; readonly server: ProbeServerRef };

/** What the worker probes: the picked files, or the served disc (the worker reads it over HTTP itself). */
export type WorkerInput = { readonly entries: ReadonlyArray<readonly [string, File]> } | { readonly server: ProbeServerRef };

export interface ProbeEnv {
  openDisc(): Promise<ProbeDisc>;
  createAudioContext(): BaseAudioContext;
  worker(input: WorkerInput): Promise<WorkerProbe>;
  globals: Record<string, unknown>;
  /** Progress lines (files received, each check's start and end with its duration), shown live by the page. */
  log?(line: string): void;
}

const FOUR_GIB = 2 ** 32;
const WORKER_TIMEOUT_MS = 15000;
/** Every other check gives up after this, so a stalled read (e.g. a file provider fetching a huge file) still reports. */
const CHECK_TIMEOUT_MS = 60000;
const SOURCE_PACKET = 192;
const ALIGNED_UNIT = SOURCE_PACKET * 32;

/** On the server route the slice is an HTTP range read past 4 GiB (the detail says `server:`). */
async function blobSlice(disc: ProbeDisc): Promise<ProbeResult> {
  const files: readonly ProbeFile[] = disc.files;
  const name = 'blob-slice-over-4gib';
  const big = files.filter((f) => f.name.toLowerCase().endsWith('.m2ts')).sort((a, b) => b.size - a.size)[0];
  if (!big || big.size <= FOUR_GIB + SOURCE_PACKET) return { name, ok: false, detail: `untested: no .m2ts over 4 GiB ${disc.route === 'server' ? 'on the disc' : 'in the folder'}` };
  const offset = Math.floor((big.size - SOURCE_PACKET) / ALIGNED_UNIT) * ALIGNED_UNIT;
  const bytes = new Uint8Array(await big.slice(offset, offset + SOURCE_PACKET).arrayBuffer());
  const ok = bytes.length === SOURCE_PACKET && bytes[4] === 0x47;
  const route = disc.route === 'server' ? 'server: ' : '';
  return { name, ok, detail: `${route}offset ${offset} in ${big.name}: ${ok ? 'sync byte found' : `byte 4 is 0x${(bytes[4] ?? 0).toString(16)}`}` };
}

/** iOS folder picks may carry no folder paths; `normalizeDiscPaths` needs `BDMV/` in them to open a disc. */
function relativePath(disc: ProbeDisc): ProbeResult {
  const name = 'relative-path';
  if (disc.route === 'server') return { name, ok: false, detail: 'untested: server route (paths come from the manifest)' };
  const files = disc.files;
  const paths = files.map((f) => f.webkitRelativePath);
  const empty = paths.filter((p) => !p).length;
  const ok = paths.some((p) => p !== '' && (p.includes('/BDMV/') || p.startsWith('BDMV/')));
  return { name, ok, detail: `${paths[0] || '(empty)'} — ${empty}/${paths.length} empty` };
}

function proto(globals: Record<string, unknown>, key: string): object | undefined {
  const ctor = globals[key] as { prototype?: object } | undefined;
  return ctor?.prototype;
}

/** Draws a white square with and without `prop` set and reports whether the pixels differ. */
function canvasEffect(globals: Record<string, unknown>, prop: 'filter' | 'letterSpacing', value: string): ProbeResult {
  const name = prop === 'filter' ? 'canvas-filter' : 'letter-spacing';
  const p = proto(globals, 'OffscreenCanvasRenderingContext2D');
  if (!p || !(prop in p)) return { name, ok: false, detail: 'property missing' };
  const Canvas = globals.OffscreenCanvas as typeof OffscreenCanvas;
  const render = (apply: boolean): Uint8ClampedArray => {
    const ctx = new Canvas(64, 32).getContext('2d') as OffscreenCanvasRenderingContext2D;
    if (apply) (ctx as unknown as Record<string, string>)[prop] = value;
    ctx.fillStyle = '#fff';
    if (prop === 'filter') ctx.fillRect(24, 8, 16, 16);
    else {
      ctx.font = '16px sans-serif';
      ctx.fillText('iiiiii', 2, 20);
    }
    return ctx.getImageData(0, 0, 64, 32).data;
  };
  const a = render(false);
  const b = render(true);
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  return { name, ok: changed > 0, detail: `${changed} channel values differ` };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function attempt(name: string, fn: () => Promise<ProbeResult> | ProbeResult, log: (line: string) => void): Promise<ProbeResult> {
  const start = Date.now();
  log(`${name}: started`);
  let result: ProbeResult;
  try {
    result = await withTimeout(Promise.resolve().then(fn), CHECK_TIMEOUT_MS);
  } catch (err) {
    result = { name, ok: false, detail: err instanceof Error && err.message === 'timed out' ? 'timed out' : `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  log(`${name}: ${result.ok ? 'ok' : 'FAIL'} after ${Date.now() - start} ms`);
  return result;
}

const GIB = 2 ** 30;

export async function runChecks(env: ProbeEnv): Promise<ProbeResult[]> {
  const disc = await env.openDisc();
  const log = env.log ?? ((): void => undefined);
  const total = disc.files.reduce((sum, f) => sum + f.size, 0);
  log(`${disc.route === 'server' ? 'listed' : 'received'} ${disc.files.length} files, ${(total / GIB).toFixed(2)} GiB`);
  const g = env.globals;
  const nav = g.navigator as object | undefined;
  const input: WorkerInput = disc.route === 'server' ? { server: disc.server } : { entries: disc.files.map((f) => [f.webkitRelativePath || f.name, f] as const) };
  const workerProbe = withTimeout(env.worker(input), WORKER_TIMEOUT_MS);
  workerProbe.catch(() => undefined); // each worker-backed check reports the failure itself

  return [
    await attempt('blob-slice-over-4gib', () => blobSlice(disc), log),
    await attempt('audio-sample-rate', () => {
      const context = env.createAudioContext();
      const rate = context.sampleRate;
      void (context as { close?: () => Promise<void> }).close?.().catch(() => undefined);
      return { name: 'audio-sample-rate', ok: rate === 48000, detail: String(rate) };
    }, log),
    await attempt('audio-session', () => {
      const ok = !!nav && 'audioSession' in nav;
      return { name: 'audio-session', ok, detail: ok ? 'present' : 'missing' };
    }, log),
    await attempt('worker-raf', async () => {
      const { raf } = await workerProbe;
      return { name: 'worker-raf', ok: raf.present, detail: `${raf.present ? 'rAF' : 'setTimeout'} p95 ${raf.p95Ms.toFixed(1)} ms` };
    }, log),
    await attempt('hevc', async () => {
      const { hevc } = await workerProbe;
      if (!hevc) return { name: 'hevc', ok: false, detail: `no HEVC clip ${disc.route === 'server' ? 'on the disc' : 'in the folder'}` };
      if (hevc.error) return { name: 'hevc', ok: false, detail: `error: ${hevc.error}` };
      const form = hevc.hvc1 ? 'hvc1' : hevc.hev1 ? 'hev1' : 'unsupported';
      return { name: 'hevc', ok: (hevc.hvc1 || hevc.hev1) && hevc.decoded, detail: hevc.decoded ? form : `${form}, first GOP did not decode` };
    }, log),
    await attempt('webgl2-float', async () => {
      const { webgl } = await workerProbe;
      return { name: 'webgl2-float', ok: webgl.float, detail: `float ${webgl.float}, half-float ${webgl.half}` };
    }, log),
    await attempt('canvas-filter', () => canvasEffect(g, 'filter', 'blur(4px)'), log),
    await attempt('letter-spacing', () => canvasEffect(g, 'letterSpacing', '8px'), log),
    await attempt('fullscreen', () => {
      const ok = (g.document as { fullscreenEnabled?: boolean } | undefined)?.fullscreenEnabled === true;
      return { name: 'fullscreen', ok, detail: String(ok) };
    }, log),
    await attempt('webkitdirectory', () => {
      const p = proto(g, 'HTMLInputElement');
      const ok = !!p && 'webkitdirectory' in p;
      return { name: 'webkitdirectory', ok, detail: String(ok) };
    }, log),
    await attempt('relative-path', () => relativePath(disc), log),
  ];
}
