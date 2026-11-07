// SPDX-License-Identifier: LGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readIvf } from '../../src/mux/ivf';

async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('readIvf', () => {
  it('reads header, packets and keyframes of small.ivf', async () => {
    const ivf = await readIvf(createReadStream('fixtures/small.ivf'));
    expect(ivf.header).toMatchObject({ fourcc: 'AV01', width: 64, height: 64 });
    const packets = await collectAll(ivf.packets);
    expect(packets.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(packets.filter((p) => p.keyframe).map((p) => p.index)).toEqual([0, 4, 8]);
  });

  it('yields the same packets when the stream arrives in 1-byte chunks', async () => {
    const { readFileSync } = await import('node:fs');
    const file = readFileSync('fixtures/small.ivf');
    const chunks = Array.from(file, (b) => Buffer.from([b]));
    const ivf = await readIvf(Readable.from(chunks));
    const packets = await collectAll(ivf.packets);
    expect(packets).toHaveLength(10);
    expect(packets.filter((p) => p.keyframe).map((p) => p.index)).toEqual([0, 4, 8]);
  });

  it('rejects sequenceHeader when the stream has no sequence header', async () => {
    const header = Buffer.alloc(32);
    header.write('DKIF', 0, 'latin1');
    header.writeUInt16LE(32, 6);
    header.write('AV01', 8, 'latin1');
    const ivf = await readIvf(Readable.from([header]));
    const seq = ivf.sequenceHeader;
    seq.catch(() => undefined);
    await expect(collectAll(ivf.packets)).rejects.toThrow(/sequence header/);
    await expect(seq).rejects.toThrow();
  });
});
