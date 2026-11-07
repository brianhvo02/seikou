// SPDX-License-Identifier: LGPL-3.0-or-later

/** MSB-first bit reader implementing the AV1 spec descriptors f(n), uvlc() and leb128(). */
export class BitReader {
  private readonly bytes: Uint8Array;
  bitPosition: number;

  constructor(bytes: Uint8Array, bitOffset = 0) {
    this.bytes = bytes;
    this.bitPosition = bitOffset;
  }

  private bit(): number {
    const byte = this.bytes[this.bitPosition >> 3];
    if (byte === undefined) throw new RangeError('BitReader: read past end of data');
    const b = (byte >> (7 - (this.bitPosition & 7))) & 1;
    this.bitPosition++;
    return b;
  }

  /** f(n): n-bit unsigned value, most significant bit first. n may be up to 32. */
  f(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  /** uvlc(): leading zero count, a one bit, then that many value bits. */
  uvlc(): number {
    let leadingZeros = 0;
    while (this.bit() === 0) {
      leadingZeros++;
      if (leadingZeros >= 32) return 2 ** 32 - 1;
    }
    const value = this.f(leadingZeros);
    return 2 ** leadingZeros - 1 + value;
  }

  /** leb128(): up to 8 bytes of 7 bits each, little-endian. Reads on a byte boundary. */
  leb128(): number {
    let value = 0;
    for (let i = 0; i < 8; i++) {
      const byte = this.f(8);
      value += (byte & 0x7f) * 2 ** (i * 7);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }
}
