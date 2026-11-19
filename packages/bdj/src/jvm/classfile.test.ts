import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClassFormatError, UnsupportedClassVersionError, decodeModifiedUtf8, parseClassFile } from './classfile';
import { ZipArchive } from './zip';

const JARS = [
  '../../../bdj-classlib/rt-bdj.jar',
  '../../../bdj-classlib/libbluray-j2se.jar',
  '../../../bdj-classlib/libbluray-awt-j2se.jar',
  '../../../../tests/bdj/conformance.jar',
].map((p) => fileURLToPath(new URL(p, import.meta.url)));

const jars = (): ZipArchive[] => JARS.map((p) => ZipArchive.open(new Uint8Array(readFileSync(p))));

function find(name: string): Uint8Array {
  for (const z of jars()) {
    const d = z.read(name);
    if (d) return d;
  }
  throw new Error(`missing ${name}`);
}

describe('parseClassFile', () => {
  it('parses every class in the four jars', () => {
    let count = 0;
    for (const z of jars()) {
      for (const n of z.names) {
        if (!n.endsWith('.class')) continue;
        const cf = parseClassFile(z.read(n)!);
        expect(cf.name + '.class').toBe(n);
        cf.cp.forEach((e, i) => {
          if (e && (e.tag === 'long' || e.tag === 'double')) expect(cf.cp[i + 1]).toBeNull();
        });
        count++;
      }
    }
    expect(count).toBeGreaterThan(100);
  });
  it('reads native methods of Object', () => {
    const cf = parseClassFile(find('java/lang/Object.class'));
    expect(cf.superName).toBeNull();
    const m = cf.methods.find((x) => x.name === 'hashCode' && x.desc === '()I')!;
    expect(m.access & 0x0100).toBe(0x0100);
    expect(m.code).toBeNull();
  });
  it('reads code of Bare.sum', () => {
    const cf = parseClassFile(find('conformance/Bare.class'));
    const m = cf.methods.find((x) => x.name === 'sum' && x.desc === '()I')!;
    expect(m.code).not.toBeNull();
    expect(m.code!.code.length).toBeGreaterThan(0);
    expect(cf.sourceFile).toBe('Bare.java');
  });
  it('keeps code and annotations in one buffer of their own, so the class file is not kept', () => {
    const bytes = find('java/awt/Color.class');
    const cf = parseClassFile(bytes);
    const annotated = cf.methods.find((m) => m.annotations)!;
    const code = cf.methods.find((m) => m.code)!.code!.code;
    expect(annotated.annotations!.buffer).toBe(code.buffer);
    expect(code.buffer).not.toBe(bytes.buffer);
    const bare = find('conformance/Bare.class');
    const b = parseClassFile(bare);
    const kept = b.methods.flatMap((m) => (m.code ? [m.code.code] : []));
    expect(kept.length).toBeGreaterThan(1);
    expect(new Set(kept.map((c) => c.buffer)).size).toBe(1);
    expect(kept[0]!.buffer).not.toBe(bare.buffer);
    expect(b.retainedBytes).toBe(kept.reduce((n, c) => n + c.length, 0) + b.methods.reduce((n, m) => n + (m.annotations?.length ?? 0), 0));
    expect(kept[0]!.buffer.byteLength).toBe(b.retainedBytes);
    // the bytes are the class file's
    const sum = b.methods.find((x) => x.name === 'sum')!.code!.code;
    expect(sum[sum.length - 1]).toBe(0xac); // ireturn
  });
  it('reads the LineNumberTable as (pc, line) pairs', () => {
    const m = parseClassFile(find('conformance/Bare.class')).methods.find((x) => x.name === 'sum')!;
    const lines = m.code!.lineNumbers;
    expect(lines).toBeInstanceOf(Uint16Array);
    expect(lines.length % 2).toBe(0);
    expect(lines[0]).toBe(0);
    expect(lines[1]).toBeGreaterThan(0);
  });
  it('reads BootstrapMethods of Lambdas', () => {
    const cf = parseClassFile(find('conformance/Lambdas.class'));
    expect(cf.bootstrapMethods.length).toBeGreaterThan(0);
    expect(cf.cp.some((e) => e?.tag === 'indy')).toBe(true);
  });
  it('rejects versions above 52', () => {
    const b = find('conformance/Bare.class').slice();
    b[6] = 0;
    b[7] = 53;
    expect(() => parseClassFile(b)).toThrow(UnsupportedClassVersionError);
  });
  it('rejects truncated and bad-magic files', () => {
    const b = find('conformance/Bare.class');
    expect(() => parseClassFile(b.subarray(0, b.length - 5))).toThrow(ClassFormatError);
    expect(() => parseClassFile(b.subarray(0, 3))).toThrow(ClassFormatError);
    const bad = b.slice();
    bad[0] = 0;
    expect(() => parseClassFile(bad)).toThrow(ClassFormatError);
  });
});

describe('decodeModifiedUtf8', () => {
  it('decodes C0 80 as NUL', () => {
    expect(decodeModifiedUtf8(new Uint8Array([0x61, 0xc0, 0x80]))).toBe('a\u0000');
  });
  it('decodes surrogate pairs as two 3-byte sequences', () => {
    const b = new Uint8Array([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]);
    expect(decodeModifiedUtf8(b)).toBe('\u{1F600}');
  });
  it('decodes 2- and 3-byte characters', () => {
    expect(decodeModifiedUtf8(new Uint8Array([0xc3, 0xa9, 0xe3, 0x81, 0x82]))).toBe('éあ');
  });
});
