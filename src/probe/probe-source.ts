// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ByteSource } from '@seikou/bdmv/byte-source';
import { createByteSource } from '@seikou/engine/disc/disc-spec';
import type { WorkerInput } from './checks';

/** The probe workers read clips in order: a little read-ahead keeps them from fetching each chunk once per small read. */
const PROBE_READ_AHEAD_BYTES = 16 * 1024 * 1024;

/** The disc a probe worker reads: the picked files, or the served disc over HTTP. */
export function openProbeSource(input: WorkerInput): ByteSource {
  const disc = 'server' in input ? input.server : { kind: 'files' as const, entries: input.entries };
  return createByteSource(disc, { fetch: (url, init) => fetch(url, init), readAheadBytes: PROBE_READ_AHEAD_BYTES, onWaiting: () => undefined });
}
