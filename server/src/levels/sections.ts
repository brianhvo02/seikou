/**
 * Shared by the CLPI and MPLS writers: a big-endian writer, and the rebuild of a BDMV file whose
 * header lists section start addresses (each section opens with a 32-bit length of what follows).
 * The layout is the one libbluray's `clpi_parse.c` (`_clpi_parse`) and `mpls_parse.c` (`_parse_playlist`) read back.
 */

/**
 * A growing big-endian byte writer, with a bit-level `bits` for the packed fields of the CLPI EP map. Reading its
 * `position` or `toBytes()` or writing whole bytes while a partial byte is pending throws, so a field layout that
 * doesn't add up to whole bytes fails at once.
 */
export class BeWriter {
  private buf = new Uint8Array(256);
  private len = 0;
  private acc = 0;
  private accBits = 0;

  /** The number of bytes written so far; where the next byte lands. Throws while bits are pending. */
  get position(): number {
    this.aligned();
    return this.len;
  }

  /** Appends the low 8 bits of `v`. */
  u8(v: number): this {
    this.aligned();
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  /** Appends the low 16 bits of `v`, big-endian. */
  u16(v: number): this {
    return this.u8(v >>> 8).u8(v);
  }

  /** Appends the low 32 bits of `v`, big-endian; `v` may exceed 2^31 (it is not treated as signed). */
  u32(v: number): this {
    return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff);
  }

  /** Appends a copy of `b`. */
  bytes(b: Uint8Array): this {
    this.aligned();
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** The low `n` bits of `v`, most significant first. */
  bits(n: number, v: number): this {
    for (let i = n - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | (Math.floor(v / 2 ** i) & 1);
      if (++this.accBits === 8) {
        this.ensure(1);
        this.buf[this.len++] = this.acc;
        this.acc = 0;
        this.accBits = 0;
      }
    }
    return this;
  }

  /** Overwrites the byte at offset `at` (already written) with the low 8 bits of `v`. */
  patchU8(at: number, v: number): this {
    this.buf[at] = v & 0xff;
    return this;
  }

  /** Overwrites the two bytes at `at` with `v`, big-endian. */
  patchU16(at: number, v: number): this {
    this.buf[at] = (v >>> 8) & 0xff;
    this.buf[at + 1] = v & 0xff;
    return this;
  }

  /** Overwrites the four bytes at `at` with `v`, big-endian; used to fill a length or address once it is known. */
  patchU32(at: number, v: number): this {
    return this.patchU16(at, Math.floor(v / 0x10000) & 0xffff).patchU16(at + 2, v & 0xffff);
  }

  /** A copy of everything written. Throws while bits are pending. */
  toBytes(): Uint8Array {
    this.aligned();
    return this.buf.slice(0, this.len);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  private aligned(): void {
    if (this.accBits !== 0) throw new Error(`levels: ${this.accBits} bits pending`);
  }
}

/** The big-endian 16-bit value at `at`; throws an `Error` when it lies past the end of `b`. */
export function readU16(b: Uint8Array, at: number): number {
  if (at + 2 > b.length) throw new Error(`levels: read past the end at ${at}`);
  return (b[at]! << 8) | b[at + 1]!;
}

/** The big-endian 32-bit value at `at` as a non-negative number; throws past the end of `b`. */
export function readU32(b: Uint8Array, at: number): number {
  return readU16(b, at) * 0x10000 + readU16(b, at + 2);
}

/** Overwrites four bytes of `b` at `at` with `v`, big-endian, in place. No bounds check beyond typed-array semantics. */
export function writeU32(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

/**
 * A section's bytes, [start, start + 4 + length): BDMV sections open with a 32-bit length of what follows it. Throws when
 * the length runs past the end of `b`.
 */
export function sectionBytes(b: Uint8Array, start: number): Uint8Array {
  const end = start + 4 + readU32(b, start);
  if (end > b.length) throw new Error(`levels: section at ${start} runs past the end`);
  return b.subarray(start, end);
}

/**
 * Rebuilds a file from its header's sections. `addressAt` lists the header offsets of the section
 * start addresses; `replace` maps an address offset to the section's new bytes (or null to drop
 * it, which writes address 0). Bytes before the first section, between sections and after the
 * last are copied, and every address is rewritten to where its section now starts.
 */
export function rebuildSections(original: Uint8Array, addressAt: readonly number[], replace: ReadonlyMap<number, Uint8Array | null>): Uint8Array {
  const sections = addressAt
    .map((at) => ({ at, start: readU32(original, at) }))
    .filter((s) => s.start !== 0)
    .sort((a, b) => a.start - b.start);
  if (sections.length === 0) return original.slice();
  const w = new BeWriter();
  w.bytes(original.subarray(0, sections[0]!.start));
  const newStart = new Map<number, number>(addressAt.map((at) => [at, 0]));
  sections.forEach((s, i) => {
    const old = sectionBytes(original, s.start);
    const next = sections[i + 1]?.start ?? original.length;
    const oldEnd = s.start + old.length;
    if (oldEnd > next) throw new Error(`levels: section at ${s.start} overlaps the next at ${next}`);
    const bytes = replace.has(s.at) ? replace.get(s.at)! : old;
    if (bytes) {
      newStart.set(s.at, w.position);
      w.bytes(bytes);
    }
    w.bytes(original.subarray(oldEnd, next));
  });
  const out = w.toBytes();
  for (const [at, start] of newStart) writeU32(out, at, start);
  return out;
}
