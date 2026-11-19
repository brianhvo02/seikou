import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { crc32 as nodeCrc, deflateRawSync, deflateSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DeflateEncoder, ZipArchive, ZipError, adler32, crc32, inflateAll, inflateRaw } from './zip';

const JARS = [
  '../../../bdj-classlib/rt-bdj.jar',
  '../../../bdj-classlib/libbluray-j2se.jar',
  '../../../bdj-classlib/libbluray-awt-j2se.jar',
  '../../../../tests/bdj/conformance.jar',
].map((p) => fileURLToPath(new URL(p, import.meta.url)));

interface TestEntry { name: string; data: Uint8Array; method: 0 | 8 }

function buildZip(entries: TestEntry[], comment = ''): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const body = e.method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = nodeCrc(e.data);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, 0x6000, true);
    lv.setUint16(12, 0x5a21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, 0x6000, true);
    cv.setUint16(14, 0x5a21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    parts.push(lh, body);
    central.push(ch);
    offset += lh.length + body.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const c = enc.encode(comment);
  const eocd = new Uint8Array(22 + c.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, c.length, true);
  eocd.set(c, 22);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * toEqual on a large Uint8Array compares element by element through Vitest's deep equality, about 0.75 s per MiB
 * locally and over 4 s on CI; this does the same check in milliseconds and still names the first differing byte.
 */
function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(actual.findIndex((b, i) => b !== expected[i])).toBe(-1);
}

function repeat(a: Uint8Array, n: number): Uint8Array {
  const o = new Uint8Array(a.length * n);
  for (let i = 0; i < n; i++) o.set(a, i * a.length);
  return o;
}

describe('crc32', () => {
  it('matches the check value', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });
  it('can be continued with a seed', () => {
    const d = text('123456789');
    expect(crc32(d, 4, 9, crc32(d, 0, 4))).toBe(0xcbf43926);
  });
});

describe('inflateAll', () => {
  const random = new Uint8Array(randomBytes(1 << 20));
  const repetitive = repeat(text('hello world, '), 50000);
  for (const level of [0, 1, 9]) {
    it(`matches deflateRawSync at level ${level}`, () => {
      for (const src of [random, repetitive]) {
        expectBytes(inflateAll(new Uint8Array(deflateRawSync(src, { level }))), src);
      }
    });
  }
  it('handles empty input', () => {
    expect(inflateAll(new Uint8Array(deflateRawSync(new Uint8Array(0))))).toEqual(new Uint8Array(0));
  });
  it('handles fixed-Huffman blocks', () => {
    const src = text('abcabcabcabc short');
    expect(inflateAll(new Uint8Array(deflateRawSync(src, { strategy: 4 })))).toEqual(src);
  });
  it('handles an empty deflated entry with an expected size of 0', () => {
    expect(inflateAll(new Uint8Array([0x03, 0x00]), 0)).toEqual(new Uint8Array(0));
  });
  for (const strategy of [2, 4]) {
    it(`finishes when output ends exactly at the ring pause point (strategy ${strategy})`, () => {
      const src = new Uint8Array(randomBytes(64512));
      const comp = new Uint8Array(deflateRawSync(src, { strategy }));
      expect(inflateAll(comp, src.length)).toEqual(src);
      expect(inflateAll(comp)).toEqual(src);
    });
  }
  it('rejects garbage', () => {
    expect(() => inflateAll(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
  });
});

describe('inflateRaw', () => {
  it('gives the same output fed in chunks of every size around a match (the fast and the waiting decode)', () => {
    const src = new Uint8Array([...repeat(text('chunked matches, chunked matches '), 2000), ...randomBytes(3000)]);
    const comp = new Uint8Array(deflateRawSync(src));
    for (let size = 1; size <= 13; size++) {
      const inf = inflateRaw();
      const out = new Uint8Array(src.length);
      let n = 0;
      for (let i = 0; i < comp.length; i += size) {
        inf.push(comp.subarray(i, i + size));
        n += inf.pull(out, n, out.length - n);
      }
      n += inf.pull(out, n, out.length - n);
      expect(inf.finished).toBe(true);
      expectBytes(out.subarray(0, n), src);
    }
  });
  it('gives the same output fed one byte at a time', () => {
    const src = new Uint8Array([...repeat(text('streaming data '), 3000), ...randomBytes(5000)]);
    const comp = new Uint8Array(deflateRawSync(src));
    const inf = inflateRaw();
    const out = new Uint8Array(src.length + 10);
    let n = 0;
    for (let i = 0; i < comp.length; i++) {
      inf.push(comp.subarray(i, i + 1));
      n += inf.pull(out, n, out.length - n);
    }
    n += inf.pull(out, n, out.length - n);
    expect(inf.finished).toBe(true);
    expect(out.subarray(0, n)).toEqual(src);
  });
  it('keeps needsInput implying remaining 0, and counts the tail after the end', () => {
    const src = new Uint8Array(randomBytes(3000));
    const comp = new Uint8Array(deflateRawSync(src));
    const stream = new Uint8Array([...comp, 9, 9, 9]);
    const inf = inflateRaw();
    const out = new Uint8Array(src.length);
    let n = 0;
    let pushed = 0;
    for (let i = 0; i < stream.length && !inf.finished; i++) {
      inf.push(stream.subarray(i, i + 1));
      pushed++;
      n += inf.pull(out, n, out.length - n);
      if (inf.needsInput) expect(inf.remaining).toBe(0);
    }
    expect(inf.finished).toBe(true);
    expect(out).toEqual(src);
    expect(pushed - inf.remaining).toBe(comp.length);
  });
  it('does not alias the pushed array', () => {
    const src = text('alias check '.repeat(100));
    const comp = new Uint8Array(deflateRawSync(src));
    const half = comp.length >> 1;
    const inf = inflateRaw();
    const buf = comp.slice(0, half);
    inf.push(buf);
    buf.fill(0);
    inf.push(comp.subarray(half));
    const out = new Uint8Array(src.length);
    inf.pull(out, 0, out.length);
    expect(out).toEqual(src);
  });
  it('reports the unconsumed tail', () => {
    const comp = new Uint8Array(deflateRawSync(text('tail test')));
    const inf = inflateRaw();
    inf.push(new Uint8Array([...comp, 1, 2, 3]));
    const out = new Uint8Array(100);
    inf.pull(out, 0, 100);
    expect(inf.finished).toBe(true);
    expect(inf.remaining).toBe(3);
  });
  it('drains in small pulls', () => {
    const src = text('x'.repeat(10000));
    const inf = inflateRaw();
    inf.push(new Uint8Array(deflateRawSync(src)));
    const out = new Uint8Array(src.length);
    let n = 0;
    for (;;) {
      const k = inf.pull(out, n, Math.min(7, out.length - n));
      if (k === 0) break;
      n += k;
    }
    expect(n).toBe(src.length);
    expect(out).toEqual(src);
  });
});

describe('ZipArchive', () => {
  const entries: TestEntry[] = [
    { name: 'a.txt', data: text('stored entry'), method: 0 },
    { name: 'dir/b.bin', data: repeat(text('deflate me '), 1000), method: 8 },
    { name: 'empty', data: new Uint8Array(0), method: 0 },
  ];
  it('reads stored and deflated entries in order', () => {
    const z = ZipArchive.open(buildZip(entries));
    expect(z.names).toEqual(['a.txt', 'dir/b.bin', 'empty']);
    for (const e of entries) expect(z.read(e.name)).toEqual(e.data);
    expect(z.read('missing')).toBeNull();
    expect(z.entries.get('a.txt')?.time).toBeGreaterThan(0);
  });
  it('reads an empty deflated entry and a pause-point sized one', () => {
    const big = new Uint8Array(randomBytes(64512));
    const z = ZipArchive.open(
      buildZip([
        { name: 'empty', data: new Uint8Array(0), method: 8 },
        { name: 'big', data: big, method: 8 },
      ]),
    );
    expect(z.read('empty')).toEqual(new Uint8Array(0));
    expect(z.read('big')).toEqual(big);
  });
  it('finds the EOCD behind a comment', () => {
    expect(ZipArchive.open(buildZip(entries, 'x'.repeat(1000))).names.length).toBe(3);
  });
  it('exposes the data offset', () => {
    const bytes = buildZip(entries);
    const z = ZipArchive.open(bytes);
    const e = z.entries.get('a.txt')!;
    const o = z.dataOffset(e);
    expect(bytes.subarray(o, o + e.compressedSize)).toEqual(entries[0]!.data);
  });
  it('throws ZipError on truncation', () => {
    const bytes = buildZip(entries);
    expect(() => ZipArchive.open(bytes.subarray(0, bytes.length - 40))).toThrow(ZipError);
    expect(() => ZipArchive.open(new Uint8Array(5))).toThrow(ZipError);
  });
  it('rejects a CRC mismatch', () => {
    const bytes = buildZip(entries);
    const z0 = ZipArchive.open(bytes);
    bytes[z0.dataOffset(z0.entries.get('a.txt')!)]! ^= 1;
    expect(() => ZipArchive.open(bytes).read('a.txt')).toThrow(ZipError);
  });
  it('opens and reads every entry of the committed jars', () => {
    for (const path of JARS) {
      const z = ZipArchive.open(new Uint8Array(readFileSync(path)));
      expect(z.names.length).toBeGreaterThan(0);
      for (const n of z.names) {
        const data = z.read(n);
        expect(data?.length).toBe(z.entries.get(n)!.size);
      }
    }
  });
});

describe('DeflateEncoder', () => {
  const periodic = new Uint8Array(100 * 1024).map((_, i) => (i * 31 + (i >> 8)) % 251);
  const inputs: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)],
    ['one byte', new Uint8Array([7])],
    ['text', new TextEncoder().encode('deflate me '.repeat(200))],
    ['periodic', periodic],
    ['random', new Uint8Array(randomBytes(70_000))],
  ];

  function encode(level: number, chunks: readonly Uint8Array[], flushes = false): Uint8Array {
    const enc = new DeflateEncoder(level);
    const parts: number[] = [];
    const drain = (): void => {
      const buf = new Uint8Array(333);
      for (let n; (n = enc.read(buf, 0, buf.length)) > 0; ) parts.push(...buf.subarray(0, n));
    };
    for (const c of chunks) {
      enc.write(c);
      if (flushes) enc.flush();
      drain();
    }
    enc.finish();
    drain();
    expect(enc.done).toBe(true);
    return new Uint8Array(parts);
  }

  it.each(inputs)('writes DEFLATE that zlib and inflateAll both read back (%s)', (_name, data) => {
    for (const level of [0, 1, 9]) {
      const z = encode(level, [data]);
      expect(new Uint8Array(inflateRawSync(z))).toEqual(data);
      expect(inflateAll(z)).toEqual(data);
    }
  });

  it('compresses repetitive data, including matches of distance 8962', () => {
    expect(encode(9, [periodic]).length).toBeLessThan(periodic.length / 10);
  });

  it('flushes to a byte-aligned point after each chunk', () => {
    const chunks = [new TextEncoder().encode('abcabcabc'), new Uint8Array(0), periodic.subarray(0, 5000)];
    const z = encode(6, chunks, true);
    expect(new Uint8Array(inflateRawSync(z))).toEqual(new Uint8Array([...chunks[0]!, ...chunks[2]!]));
  });
});

/** zlib's Adler-32: the trailer of a zlib stream. */
const nodeAdler = (data: Uint8Array): number => {
  const z = deflateSync(data);
  return new DataView(z.buffer, z.byteOffset + z.length - 4, 4).getUint32(0);
};

describe('adler32', () => {
  it('matches zlib, also across large inputs and with a seed', () => {
    const big = new Uint8Array(randomBytes(200_000));
    expect(adler32(new TextEncoder().encode('123456789'))).toBe(0x091e01de);
    expect(adler32(big)).toBe(nodeAdler(big));
    expect(adler32(big, 100_000, 200_000, adler32(big, 0, 100_000))).toBe(nodeAdler(big));
  });
});
