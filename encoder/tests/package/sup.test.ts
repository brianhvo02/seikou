// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import type { SubtitleBlock } from '../../src/mux/mkv-writer';
import { SupError, toSup } from '../../src/package/sup';

async function* of(blocks: SubtitleBlock[]): AsyncGenerator<SubtitleBlock> {
  yield* blocks;
}

it("writes a PG header before every segment of every display set, with the block's PTS and DTS 0", async () => {
  const set = new Uint8Array([0x16, 0x00, 0x01, 0x07, 0x14, 0x00, 0x00, 0x80, 0x00, 0x00]);
  const sup = Buffer.from(await toSup(of([{ timeMs: 1000, data: set }, { timeMs: 50_000_000, data: new Uint8Array([0x80, 0, 0]) }])));
  const headers = [0, 14, 27, 40].map((o) => [sup.subarray(o, o + 2).toString('latin1'), sup.readUInt32BE(o + 2), sup.readUInt32BE(o + 6), sup[o + 10]]);
  expect(headers).toEqual([
    ['PG', 90_000, 0, 0x16],
    ['PG', 90_000, 0, 0x14],
    ['PG', 90_000, 0, 0x80],
    // 50,000 s is 4.5e9 ticks of 90 kHz: the 32-bit field keeps it modulo 2^32.
    ['PG', 4_500_000_000 % 2 ** 32, 0, 0x80],
  ]);
  expect(sup.length).toBe(4 * 10 + 4 + 3 + 3 + 3);
});

it('refuses a block whose last segment overruns it', async () => {
  await expect(toSup(of([{ timeMs: 0, data: new Uint8Array([0x16, 0x00, 0x05, 1, 2]) }]))).rejects.toBeInstanceOf(SupError);
});
