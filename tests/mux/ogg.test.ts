// SPDX-License-Identifier: LGPL-3.0-or-later
import { createReadStream, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { opusPacketDuration, readOggOpus } from '../../src/mux/ogg';

async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

function page(
  opts: { flags: number; granule: bigint; seq: number; serial?: number },
  packetsOnPage: Uint8Array[],
  lastContinues = false,
): Buffer {
  const lacing: number[] = [];
  packetsOnPage.forEach((p, i) => {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    if (!(lastContinues && i === packetsOnPage.length - 1 && n === 0)) lacing.push(n);
  });
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'ascii');
  header[5] = opts.flags;
  header.writeBigUInt64LE(opts.granule, 6);
  header.writeUInt32LE(opts.serial ?? 1, 14);
  header.writeUInt32LE(opts.seq, 18);
  header[26] = lacing.length;
  lacing.forEach((v, i) => (header[27 + i] = v));
  return Buffer.concat([header, ...packetsOnPage.map((p) => Buffer.from(p))]);
}

function opusHead(): Uint8Array {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b[8] = 1;
  b[9] = 2;
  b.writeUInt16LE(312, 10);
  b.writeUInt32LE(48000, 12);
  return b;
}

const tags = Buffer.from('OpusTags\0\0\0\0\0\0\0\0', 'ascii');

describe('opusPacketDuration', () => {
  it('computes packet durations from the TOC byte', () => {
    expect(opusPacketDuration(new Uint8Array([0b11111000]))).toBe(960); // CELT config 31, code 0: 20 ms
    expect(opusPacketDuration(new Uint8Array([0b00000001]))).toBe(960); // SILK config 0, code 1: two 10 ms frames
    expect(opusPacketDuration(new Uint8Array([0b01100011, 0x03]))).toBe(1440); // config 12 (hybrid 10 ms) code 3, three frames
  });

  it('reads the frame count from the low 6 bits when VBR and padding bits are set', () => {
    expect(opusPacketDuration(new Uint8Array([0b11111011, 0xc2]))).toBe(1920);
  });

  it('rejects zero frames and durations over 120 ms', () => {
    expect(() => opusPacketDuration(new Uint8Array([0b11111011, 0x00]))).toThrow();
    expect(() => opusPacketDuration(new Uint8Array([0b11111011, 0x07]))).toThrow(); // 7 x 960 = 6720
    expect(() => opusPacketDuration(new Uint8Array([]))).toThrow();
  });
});

describe('readOggOpus', () => {
  it('reads tone.opus: head, packets, end trimming', async () => {
    const ogg = await readOggOpus(createReadStream('fixtures/tone.opus'));
    expect(ogg.head.channels).toBe(2);
    expect(ogg.head.preSkip).toBeGreaterThan(0);
    expect(ogg.head.raw).toHaveLength(19);
    const packets = await collectAll(ogg.packets);
    expect(packets.every((p) => p.durationSamples === 960)).toBe(true);
    expect(packets[1]!.pts48).toBe(960);
    const end = await ogg.end;
    expect(end.lastGranule - ogg.head.preSkip).toBe(24000);
    expect(end.discardPadding48).toBeGreaterThanOrEqual(0);
    expect(end.discardPadding48).toBeLessThan(960);
    expect(end.totalSamples).toBe(packets.length * 960);
  });

  it('yields the same result from 1-byte chunks', async () => {
    const file = readFileSync('fixtures/tone.opus');
    const ref = await readOggOpus(Readable.from([file]));
    const refPackets = await collectAll(ref.packets);
    const ogg = await readOggOpus(Readable.from(Array.from(file, (b) => Buffer.from([b]))));
    const packets = await collectAll(ogg.packets);
    expect(packets).toEqual(refPackets);
    expect(await ogg.end).toEqual(await ref.end);
  });

  it('reassembles a packet spanning several pages', async () => {
    const big = new Uint8Array(600).fill(7);
    big[0] = 0b11111000; // CELT 20 ms, code 0
    const small = new Uint8Array([0b11111000, 1, 2]);
    const stream = Buffer.concat([
      page({ flags: 2, granule: 0n, seq: 0 }, [opusHead()]),
      page({ flags: 0, granule: 0n, seq: 1 }, [tags]),
      // first 600-byte packet: 255 + 255 on page 2, 90 on page 3 with continuation
      page({ flags: 0, granule: 0xffffffffffffffffn, seq: 2 }, [big.subarray(0, 510)], true),
      page({ flags: 1, granule: 1920n, seq: 3 }, [big.subarray(510), small]),
    ]);
    const ogg = await readOggOpus(Readable.from([stream]));
    expect(ogg.head.preSkip).toBe(312);
    const packets = await collectAll(ogg.packets);
    expect(packets).toHaveLength(2);
    expect(packets[0]!.data).toEqual(big);
    expect(packets[1]!.data).toEqual(small);
    expect(packets[1]!.pts48).toBe(960);
    const end = await ogg.end;
    expect(end).toEqual({ totalSamples: 1920, lastGranule: 1920, discardPadding48: 0 });
  });

  it('sets discardPadding48 to 0 when the last granule exceeds the total', async () => {
    const stream = Buffer.concat([
      page({ flags: 2, granule: 0n, seq: 0 }, [opusHead()]),
      page({ flags: 0, granule: 0n, seq: 1 }, [tags]),
      page({ flags: 4, granule: 5000n, seq: 2 }, [new Uint8Array([0b11111000, 9])]),
    ]);
    const ogg = await readOggOpus(Readable.from([stream]));
    await collectAll(ogg.packets);
    expect(await ogg.end).toEqual({ totalSamples: 960, lastGranule: 5000, discardPadding48: 0 });
  });

  it('ignores pages from other serial numbers', async () => {
    const stream = Buffer.concat([
      page({ flags: 2, granule: 0n, seq: 0 }, [opusHead()]),
      page({ flags: 0, granule: 0n, seq: 1 }, [tags]),
      page({ flags: 0, granule: 99999n, seq: 0, serial: 2 }, [new Uint8Array([0b11111000, 1])]),
      page({ flags: 4, granule: 960n, seq: 2 }, [new Uint8Array([0b11111000, 9])]),
    ]);
    const ogg = await readOggOpus(Readable.from([stream]));
    expect(await collectAll(ogg.packets)).toHaveLength(1);
    expect((await ogg.end).lastGranule).toBe(960);
  });

  it('rejects a stream whose first packet is not OpusHead', async () => {
    const stream = page({ flags: 2, granule: 0n, seq: 0 }, [Buffer.from('NotOpusHeadAtAllxx')]);
    await expect(readOggOpus(Readable.from([stream]))).rejects.toThrow(/OpusHead/);
  });

  it('rejects a stream that ends before OpusTags', async () => {
    const stream = page({ flags: 2, granule: 0n, seq: 0 }, [opusHead()]);
    await expect(readOggOpus(Readable.from([stream]))).rejects.toThrow();
  });

  it('rejects a granule position beyond 2^53', async () => {
    const stream = Buffer.concat([
      page({ flags: 2, granule: 0n, seq: 0 }, [opusHead()]),
      page({ flags: 0, granule: 0n, seq: 1 }, [tags]),
      page({ flags: 4, granule: 1n << 54n, seq: 2 }, [new Uint8Array([0b11111000, 9])]),
    ]);
    const ogg = await readOggOpus(Readable.from([stream]));
    await collectAll(ogg.packets).catch(() => undefined);
    await expect(ogg.end).rejects.toThrow(/granule/);
  });
});
