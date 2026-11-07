// SPDX-License-Identifier: LGPL-2.1-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { M2tsReader } from '@seikou/bdmv/demux/m2ts-reader';
import { parseMpls } from '@seikou/bdmv';
import type { ByteSource } from '@seikou/bdmv/byte-source';
import { PgSegmentDecoder, type PgDisplaySet } from '@seikou/pg';

const DISC = 'fixtures/synthetic/disc-subs';

function fileSource(): ByteSource {
  const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`${DISC}/${path}`));
  return {
    exists: () => true,
    size: (path) => read(path).length,
    list: () => [],
    read: async (path, offset, length) => read(path).subarray(offset, offset + length),
  };
}

it('decodes the PG stream of disc-subs into display sets with composition objects', async () => {
  const mpls = parseMpls(new Uint8Array(readFileSync(`${DISC}/BDMV/PLAYLIST/00000.mpls`)));
  const item = mpls.playItems[0]!;
  const pg = item.stn.pg.find((s) => s.streamType !== 2)!;
  const decoder = new PgSegmentDecoder();
  const reader = new M2tsReader({ source: fileSource(), path: `BDMV/STREAM/${item.clipId}.m2ts`, startSpn: 0, pids: new Set([pg.pid]) });
  const sets: PgDisplaySet[] = [];
  for (let batch = await reader.next(); batch; batch = await reader.next()) {
    for (const pes of batch) {
      const set = decoder.push(pes.payload, pes.pts ?? 0, pes.dts ?? null);
      if (set) sets.push(set);
    }
  }
  expect(decoder.errors).toBe(0);
  expect(sets.some((s) => s.composition.compositionObjects.length >= 1)).toBe(true);
});
