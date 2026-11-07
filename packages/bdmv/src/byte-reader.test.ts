import { describe, expect, it } from 'vitest';
import { ByteWriter } from '../../../tests/helpers/byte-writer';
import { ByteReader, ParseError } from './byte-reader';

describe('ByteReader', () => {
  it('reads big-endian integers including values above 2^31', () => {
    const bytes = new ByteWriter().u8(0xab).u16(0x1234).u32(0xfedcba98).toBytes();
    const r = new ByteReader(bytes);
    expect(r.u8()).toBe(0xab);
    expect(r.u16()).toBe(0x1234);
    expect(r.u32()).toBe(0xfedcba98);
    expect(r.remaining).toBe(0);
  });

  it('reads bit fields MSB first across byte boundaries', () => {
    const bytes = new ByteWriter().bits(2, 1).bits(14, 0x2abc).bits(18, 0x3ffff).bits(14, 0x1555).toBytes();
    const r = new ByteReader(bytes);
    expect(r.bits(2)).toBe(1);
    expect(r.bits(14)).toBe(0x2abc);
    expect(r.bits(18)).toBe(0x3ffff);
    expect(r.bits(14)).toBe(0x1555);
  });

  it('reads 32-bit bit fields without sign overflow', () => {
    const r = new ByteReader(new ByteWriter().bits(32, 0xffffffff).toBytes());
    expect(r.bits(32)).toBe(0xffffffff);
  });

  it('reads ascii strings and subarrays, and seeks', () => {
    const bytes = new ByteWriter().ascii('MPLS').u8(7).u8(9).toBytes();
    const r = new ByteReader(bytes);
    expect(r.ascii(4)).toBe('MPLS');
    expect(Array.from(r.take(2))).toEqual([7, 9]);
    r.seek(1);
    expect(r.ascii(2)).toBe('PL');
  });

  it('throws ParseError when reading past the end', () => {
    const r = new ByteReader(new Uint8Array([1]));
    r.u8();
    expect(() => r.u8()).toThrow(ParseError);
    expect(() => new ByteReader(new Uint8Array(2)).u32()).toThrow(ParseError);
  });

  it('throws ParseError on unaligned byte reads', () => {
    const r = new ByteReader(new Uint8Array([0xff, 0xff]));
    r.bits(3);
    expect(() => r.u8()).toThrow(ParseError);
  });

  it('skipBits handles more than 32 bits', () => {
    const r = new ByteReader(new ByteWriter().zeros(5).u8(0x42).toBytes());
    r.skipBits(40);
    expect(r.u8()).toBe(0x42);
  });

  it('rejects negative or non-integer lengths and offsets instead of misreading', () => {
    const r = new ByteReader(new Uint8Array(8));
    expect(() => r.take(-1)).toThrow(ParseError);
    expect(() => r.skip(Number.NaN)).toThrow(ParseError);
    expect(() => r.seek(1.5)).toThrow(ParseError);
    expect(() => new ByteReader(new Uint8Array(8), -2)).toThrow(ParseError);
    expect(r.position).toBe(0);
  });

  it('leaves the reader where it was when a bit read runs past the end', () => {
    const r = new ByteReader(new Uint8Array([0xff]));
    r.bits(4);
    expect(() => r.bits(8)).toThrow(ParseError);
    expect(r.bits(4)).toBe(0xf);
  });
});
