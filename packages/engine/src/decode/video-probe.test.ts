// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { WorkerLike } from '../bdj-types';
import { PROBE_DEADLINE_MS, probeVideoDecoderSpeed, splitPictures } from './video-probe';
import type { FromVideoWorker, ToVideoWorker } from './video-worker-protocol';

describe('probeVideoDecoderSpeed', () => {
  it('a probe that never answers settles null at the deadline, and stops its worker', async () => {
    const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
    const workers: Array<{ terminated: boolean }> = [];
    const result = probeVideoDecoderSpeed({
      nowMs: () => 0,
      setTimer: (ms, fn) => {
        const t = { ms, fn, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
      videoWasm: {
        wasmUrl: 'video.wasm',
        // a worker that is started and never says it opened
        createWorker: () => {
          const w = { terminated: false };
          workers.push(w);
          const worker: WorkerLike<ToVideoWorker, FromVideoWorker> = { onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => void (w.terminated = true) };
          return worker;
        },
        bench: { mpeg2Url: 'a', vc1Url: 'b', fetchBytes: async () => Uint8Array.of(0, 0, 1, 0, 1, 2) },
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(workers).toHaveLength(1);
    const deadline = timers.find((t) => t.ms === PROBE_DEADLINE_MS && t.live);
    expect(deadline, 'a timer for the overall deadline').toBeDefined();
    expect(PROBE_DEADLINE_MS).toBe(20_000);
    deadline!.fn();
    await expect(result).resolves.toBeNull();
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it('splits a stream at its picture start codes', () => {
    const data = Uint8Array.of(9, 9, 0, 0, 1, 0xb3, 1, 0, 0, 1, 0, 5, 0, 0, 1, 0xb8, 0, 0, 1, 0, 6);
    // the headers before the first picture go with it, and a header between pictures with the picture before
    expect(splitPictures(data, 0).map((u) => u.length)).toEqual([16, 5]);
    expect(splitPictures(new Uint8Array(0), 0)).toEqual([]);
    expect(splitPictures(Uint8Array.of(1, 2, 3), 0)).toHaveLength(1);
  });
});
