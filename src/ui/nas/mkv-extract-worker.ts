// SPDX-License-Identifier: LGPL-3.0-or-later
/// <reference lib="webworker" />
import { extractMkvText } from '@seikou/engine/subs/mkv-extract';
import { blobRangeReader } from '@seikou/matroska';

/**
 * Reads one MKV's text tracks and fonts off the main thread. It takes `{ id, file }` and posts `{ id, progress }` as
 * the file is read, then `{ id, extract }` or `{ id, error }`.
 */
self.onmessage = (e: MessageEvent<{ id: number; file: File }>): void => {
  const { id, file } = e.data;
  extractMkvText(blobRangeReader(file), { onProgress: (read, total) => self.postMessage({ id, progress: total > 0 ? read / total : 0 }) }).then(
    (extract) => self.postMessage({ id, extract }),
    (err: unknown) => self.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
};
