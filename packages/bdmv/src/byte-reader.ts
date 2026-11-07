/*
 * Original implementation, modelled on the bitstream reader in libbluray (src/util/bits.c).
 * No libbluray code is copied.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Big-endian reader with MSB-first bit access, modelled on libbluray's BITSTREAM. */
export class ByteReader {
  private pos: number;
  private bitPos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
  ) {
    this.pos = 0;
    this.seek(start);
  }

  get position(): number {
    return this.pos;
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  seek(pos: number): void {
    if (!Number.isInteger(pos) || pos < 0 || pos > this.bytes.length) {
      throw new ParseError(`seek to ${pos} outside 0..${this.bytes.length}`);
    }
    this.pos = pos;
    this.bitPos = 0;
  }

  skip(n: number): void {
    this.requireAligned();
    this.requireCount(n);
    this.seek(this.pos + n);
  }

  u8(): number {
    this.requireAligned();
    this.require(1);
    return this.bytes[this.pos++];
  }

  u16(): number {
    const hi = this.u8();
    return (hi << 8) | this.u8();
  }

  u32(): number {
    const hi = this.u16();
    return hi * 0x10000 + this.u16();
  }

  take(n: number): Uint8Array {
    this.requireAligned();
    this.requireCount(n);
    this.require(n);
    const view = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return view;
  }

  ascii(n: number): string {
    return String.fromCharCode(...this.take(n));
  }

  bits(n: number): number {
    if (n < 1 || n > 32) throw new ParseError(`bits(${n}) out of range`);
    if ((this.bytes.length - this.pos) * 8 - this.bitPos < n) throw new ParseError('bit read past end'); // check first: no partial advance
    let value = 0;
    for (let i = 0; i < n; i++) {
      const bit = (this.bytes[this.pos] >> (7 - this.bitPos)) & 1;
      value = value * 2 + bit;
      if (++this.bitPos === 8) {
        this.bitPos = 0;
        this.pos++;
      }
    }
    return value;
  }

  flag(): boolean {
    return this.bits(1) === 1;
  }

  skipBits(n: number): void {
    let left = n;
    while (left > 0) {
      const k = Math.min(left, 32);
      this.bits(k);
      left -= k;
    }
  }

  private require(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new ParseError(`need ${n} bytes at ${this.pos}, have ${this.remaining}`);
    }
  }

  private requireCount(n: number): void {
    if (!Number.isInteger(n) || n < 0) throw new ParseError(`invalid byte count ${n} at ${this.pos}`);
  }

  private requireAligned(): void {
    if (this.bitPos !== 0) throw new ParseError(`unaligned byte read at ${this.pos}.${this.bitPos}`);
  }
}
