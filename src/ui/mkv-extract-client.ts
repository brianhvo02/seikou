// SPDX-License-Identifier: LGPL-3.0-or-later
import type { MkvTextExtract } from '@seikou/engine/subs/mkv-extract';

/** Reads one MKV's text tracks, telling the share read (0 to 1) as it goes. */
export type ExtractMkv = (file: File, onProgress: (p: number) => void, signal?: AbortSignal) => Promise<MkvTextExtract>;

/** The default reader: the MKV worker, one file at a time (the caller's queue), ended with its answer. */
export const extractInWorker: ExtractMkv = (file, onProgress, signal) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./nas/mkv-extract-worker.ts', import.meta.url), { type: 'module' });
    const done = (): void => worker.terminate();
    signal?.addEventListener('abort', () => {
      done();
      reject(new Error('Cancelled.'));
    });
    worker.onmessage = (e: MessageEvent<{ progress?: number; extract?: MkvTextExtract; error?: string }>) => {
      const m = e.data;
      if (m.progress !== undefined) return onProgress(m.progress);
      done();
      if (m.extract) resolve(m.extract);
      else reject(new Error(m.error ?? 'The file could not be read.'));
    };
    worker.onerror = () => {
      done();
      reject(new Error('The file could not be read.'));
    };
    worker.postMessage({ id: 0, file });
  });
