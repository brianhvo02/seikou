import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChecks, type DecodeRateReply, type DecodeRateRequest, type ProbeEnv, type ProbeFile, type WorkerInput, type WorkerProbe } from './checks';
import type { DecodeRate } from './decode-rate';

const GIB = 2 ** 30;

/** A File-like whose slice(a, b) returns 192 bytes: sync at byte 4 and the offset (as given by `encode`) in the rest. */
function fakeBigFile(name: string, size: number, wrap: boolean): File {
  const blob = {
    size,
    name,
    webkitRelativePath: `disc/BDMV/STREAM/${name}`,
    slice(a: number, b: number) {
      return {
        size: b - a,
        arrayBuffer: async () => {
          const bytes = new Uint8Array(b - a);
          bytes[4] = 0x47;
          if (wrap && a >= 2 ** 32) bytes[4] = 0; // a wrapped read lands elsewhere
          new DataView(bytes.buffer).setFloat64(8, a, true);
          return bytes.buffer;
        },
      };
    },
  };
  return blob as unknown as File;
}

/** A picked file with only the fields the relative-path check reads. */
function pathed(webkitRelativePath: string): File {
  return { name: webkitRelativePath.split('/').pop() ?? '', size: 1, webkitRelativePath } as unknown as File;
}

const okWorker: WorkerProbe = {
  hevc: { hvc1: true, hev1: false, decoded: true },
  raf: { present: true, p95Ms: 16.7 },
  webgl: { float: true, half: true },
};

const okRate: DecodeRate = { clip: '00001', codec: 'avc1.640029', frameRate: 24000 / 1001, units: 240, decodeFps: 80, drawFps: 45, width: 1920, height: 1080 };

function env(over: Partial<ProbeEnv> & { files?: File[]; rate?: number } = {}): ProbeEnv {
  return {
    decodeRate: over.decodeRate ?? (async ({ coding }: DecodeRateRequest): Promise<DecodeRateReply> => ({ rate: coding === 'h264' ? okRate : null })),
    openDisc: over.openDisc ?? (async () => ({ route: 'folder', files: over.files ?? [fakeBigFile('00001.m2ts', 5 * GIB, false)] })),
    createAudioContext: () => ({ sampleRate: over.rate ?? 48000 }) as unknown as BaseAudioContext,
    worker: over.worker ?? (async () => okWorker),
    globals: over.globals ?? {},
    log: over.log,
  };
}

afterEach(() => vi.useRealTimers());

const find = async (e: ProbeEnv, name: string) => (await runChecks(e)).find((r) => r.name === name);

describe('runChecks', () => {
  it('blob-slice-over-4gib passes when the offset above 2^32 is read faithfully', async () => {
    const r = await find(env(), 'blob-slice-over-4gib');
    expect(r?.ok).toBe(true);
    expect(Number(/\d+/.exec(r?.detail ?? '')?.[0])).toBeGreaterThanOrEqual(4294967296);
  });

  it('blob-slice-over-4gib fails when the offset wraps at 2^32', async () => {
    const r = await find(env({ files: [fakeBigFile('00001.m2ts', 5 * GIB, true)] }), 'blob-slice-over-4gib');
    expect(r?.ok).toBe(false);
  });

  it('reports audio sample rate', async () => {
    expect(await find(env({ rate: 44100 }), 'audio-sample-rate')).toEqual({ name: 'audio-sample-rate', ok: false, detail: '44100' });
    expect((await find(env({ rate: 48000 }), 'audio-sample-rate'))?.ok).toBe(true);
  });

  it('reports hevc support from the worker', async () => {
    expect(await find(env(), 'hevc')).toEqual({ name: 'hevc', ok: true, detail: 'hvc1' });
  });

  it('keeps going when a check throws', async () => {
    const r = await runChecks(env({ worker: async () => { throw new Error('boom'); } }));
    expect(r.find((x) => x.name === 'hevc')?.ok).toBe(false);
    expect(r.find((x) => x.name === 'audio-sample-rate')?.ok).toBe(true);
  });

  it('reports no m2ts over 4 GiB as untested and not ok', async () => {
    const r = await find(env({ files: [fakeBigFile('00001.m2ts', GIB, false)] }), 'blob-slice-over-4gib');
    expect(r?.ok).toBe(false);
    expect(r?.detail.startsWith('untested:')).toBe(true);
  });

  it('hevc: hev1-only passes, decode failure and worker error fail, no clip fails', async () => {
    const w = (hevc: WorkerProbe['hevc']) => async (): Promise<WorkerProbe> => ({ ...okWorker, hevc });
    expect(await find(env({ worker: w({ hvc1: false, hev1: true, decoded: true }) }), 'hevc')).toEqual({ name: 'hevc', ok: true, detail: 'hev1' });
    expect(await find(env({ worker: w({ hvc1: true, hev1: true, decoded: false }) }), 'hevc')).toEqual({ name: 'hevc', ok: false, detail: 'hvc1, first GOP did not decode' });
    expect(await find(env({ worker: w({ hvc1: false, hev1: false, decoded: false, error: 'bad sps' }) }), 'hevc')).toEqual({ name: 'hevc', ok: false, detail: 'error: bad sps' });
    expect(await find(env({ worker: w(null) }), 'hevc')).toEqual({ name: 'hevc', ok: false, detail: 'no HEVC clip in the folder' });
  });

  it('relative-path: paths under a disc folder pass and report the first path and empty count', async () => {
    const files = [pathed('disc1/BDMV/index.bdmv'), pathed('disc1/BDMV/PLAYLIST/00000.mpls'), pathed('')];
    expect(await find(env({ files }), 'relative-path')).toEqual({ name: 'relative-path', ok: true, detail: 'disc1/BDMV/index.bdmv — 1/3 empty' });
    const all = [pathed('disc1/BDMV/index.bdmv'), pathed('disc1/BDMV/STREAM/00001.m2ts')];
    expect((await find(env({ files: all }), 'relative-path'))?.detail).toBe('disc1/BDMV/index.bdmv — 0/2 empty');
  });

  it('relative-path: all-empty paths fail with (empty) in the detail', async () => {
    const r = await find(env({ files: [pathed(''), pathed('')] }), 'relative-path');
    expect(r?.ok).toBe(false);
    expect(r?.detail.startsWith('(empty) — ')).toBe(true);
    expect(r?.detail).toBe('(empty) — 2/2 empty');
  });

  it('relative-path: paths rooted at BDMV pass', async () => {
    const r = await find(env({ files: [pathed('BDMV/index.bdmv'), pathed('BDMV/STREAM/00001.m2ts')] }), 'relative-path');
    expect(r).toEqual({ name: 'relative-path', ok: true, detail: 'BDMV/index.bdmv — 0/2 empty' });
  });

  it('passes [path, File] entries to the worker', async () => {
    const file = fakeBigFile('00001.m2ts', 5 * GIB, false);
    let seen: WorkerInput | null = null;
    await runChecks(env({ files: [file], worker: async (input) => { seen = input; return okWorker; } }));
    const entries = seen && 'entries' in seen ? (seen as { entries: ReadonlyArray<readonly [string, File]> }).entries : [];
    expect(entries[0][0]).toBe('disc/BDMV/STREAM/00001.m2ts');
    expect(entries[0][1]).toBe(file);
  });

  it('server route: the slice is a range read, the worker gets the server ref, relative-path is untested', async () => {
    const server = { kind: 'remote', base: 'http://127.0.0.1:8080/api/discs/abc/', token: 't', manifest: { discId: 'abc', name: 'Disc', files: [], inline: {} } } as const;
    const big = fakeBigFile('00001.M2TS', 5 * GIB, false) as unknown as ProbeFile;
    let seen: WorkerInput | null = null;
    const r = await runChecks(env({ openDisc: async () => ({ route: 'server', files: [big], server }), worker: async (input) => { seen = input; return okWorker; } }));
    expect(r.find((x) => x.name === 'blob-slice-over-4gib')).toMatchObject({ ok: true });
    expect(r.find((x) => x.name === 'blob-slice-over-4gib')?.detail.startsWith('server: offset ')).toBe(true);
    expect(r.find((x) => x.name === 'relative-path')).toMatchObject({ ok: false, detail: 'untested: server route (paths come from the manifest)' });
    expect(seen).toEqual({ server });
  });

  it('worker rows report timed out after 15 s while other rows still run', async () => {
    vi.useFakeTimers();
    const pending = runChecks(env({ worker: () => new Promise<WorkerProbe>(() => undefined) }));
    await vi.advanceTimersByTimeAsync(15000);
    const r = await pending;
    for (const name of ['worker-raf', 'hevc', 'webgl2-float']) expect(r.find((x) => x.name === name)).toMatchObject({ ok: false, detail: 'timed out' });
    expect(r.find((x) => x.name === 'audio-sample-rate')?.ok).toBe(true);
  });

  it('logs the files received and each check with its duration', async () => {
    const lines: string[] = [];
    await runChecks(env({ log: (l) => lines.push(l) }));
    expect(lines[0]).toBe('received 1 files, 5.00 GiB');
    expect(lines).toContain('blob-slice-over-4gib: started');
    expect(lines.some((l) => /^blob-slice-over-4gib: ok after \d+ ms$/.test(l))).toBe(true);
    expect(lines.some((l) => /^relative-path: (ok|FAIL) after \d+ ms$/.test(l))).toBe(true);
  });

  it('a read that never finishes times out after 60 s instead of hanging the probe', async () => {
    vi.useFakeTimers();
    const stalled = { ...fakeBigFile('00001.m2ts', 5 * GIB, false), slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined) }) } as unknown as File;
    const run = runChecks(env({ files: [stalled] }));
    await vi.advanceTimersByTimeAsync(60_000);
    const r = (await run).find((x) => x.name === 'blob-slice-over-4gib');
    expect(r).toEqual({ name: 'blob-slice-over-4gib', ok: false, detail: 'timed out' });
  });

  it('cross-origin-isolated passes only with isolation and SharedArrayBuffer', async () => {
    expect(await find(env({ globals: { crossOriginIsolated: true, SharedArrayBuffer } }), 'cross-origin-isolated')).toEqual({
      name: 'cross-origin-isolated',
      ok: true,
      detail: 'crossOriginIsolated true, SharedArrayBuffer present',
    });
    expect((await find(env({ globals: { crossOriginIsolated: false, SharedArrayBuffer } }), 'cross-origin-isolated'))?.ok).toBe(false);
    expect((await find(env({ globals: { crossOriginIsolated: true } }), 'cross-origin-isolated'))?.detail).toBe('crossOriginIsolated true, SharedArrayBuffer missing');
  });

  it('device always passes and names what the device reports', async () => {
    const globals = { navigator: { hardwareConcurrency: 4, deviceMemory: 2 }, screen: { width: 1920, height: 1080 }, devicePixelRatio: 1, tizen: {} };
    expect(await find(env({ globals }), 'device')).toEqual({ name: 'device', ok: true, detail: 'cores 4, memory 2 GB, screen 1920×1080 @1, tizen yes, webapis no' });
  });

  it('decode-rate passes at 1.25 times real time drawn, and reports both rates', async () => {
    expect(await find(env(), 'decode-rate-h264')).toEqual({
      name: 'decode-rate-h264',
      ok: true,
      detail: '00001 1920×1080 avc1.640029: decode 80.0 fps, decode+draw 45.0 fps (needs 30.0)',
    });
    const slow = async (): Promise<DecodeRateReply> => ({ rate: { ...okRate, drawFps: 28 } });
    expect((await find(env({ decodeRate: slow }), 'decode-rate-h264'))?.ok).toBe(false);
  });

  it('decode-rate fails on a decoder error, a worker error, and a disc without the coding', async () => {
    const broken = async (): Promise<DecodeRateReply> => ({ rate: { ...okRate, error: 'only 12 of 240 frames came out' } });
    expect(await find(env({ decodeRate: broken }), 'decode-rate-h264')).toMatchObject({ ok: false, detail: expect.stringContaining('; only 12 of 240 frames came out') as string });
    expect(await find(env({ decodeRate: async () => ({ error: 'timed out' }) }), 'decode-rate-h264')).toEqual({ name: 'decode-rate-h264', ok: false, detail: 'error: timed out' });
    expect(await find(env(), 'decode-rate-hevc')).toEqual({ name: 'decode-rate-hevc', ok: false, detail: 'untested: no HEVC clip in the folder' });
  });

  it('decode-rate asks the worker for each coding with the same disc input as the other worker', async () => {
    const asked: DecodeRateRequest[] = [];
    let seen: WorkerInput | null = null;
    await runChecks(env({ worker: async (input) => { seen = input; return okWorker; }, decodeRate: async (r) => { asked.push(r); return { rate: null }; } }));
    expect(asked.map((r) => r.coding)).toEqual(['h264', 'hevc']);
    expect(asked[0].input).toBe(seen);
  });
});
