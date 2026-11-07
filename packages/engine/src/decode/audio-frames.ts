export type FramerKind = 'ac3' | 'eac3' | 'dts';

export interface AudioFrame {
  readonly data: Uint8Array;
  readonly ptsUs: number;
  /** Duration in 48 kHz sample frames. */
  readonly samples: number;
}

interface Parsed {
  readonly size: number;
  readonly samples: number;
  /** Starts an access unit (E-AC-3: independent substream 0); other frames join the open one. */
  readonly startsUnit: boolean;
  readonly drop?: boolean;
}

const SAMPLE_RATE = 48_000;
/** AC-3 frame size in 16-bit words per frmsizecod at 48 kHz (ATSC A/52 Table 5.18). */
const AC3_WORDS_48K = [
  64, 64, 80, 80, 96, 96, 112, 112, 128, 128, 160, 160, 192, 192, 224, 224, 256, 256, 320, 320, 384, 384, 448, 448, 512, 512, 640, 640, 768, 768, 896,
  896, 1024, 1024, 1152, 1152, 1280, 1280,
];
const EAC3_BLOCKS = [1, 2, 3, 6];
const DTS_SYNC = 0x7ffe8001;
const EXSS_SYNC = 0x64582025;

function readBits(b: Uint8Array, bitPos: number, count: number): number {
  let v = 0;
  for (let i = 0; i < count; i++) {
    const p = bitPos + i;
    v = v * 2 + ((b[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return v;
}

/** Splits a codec's PES payloads into frames (or E-AC-3 access units) and gives each a PTS. */
export class AudioFramer {
  private carry: Uint8Array = new Uint8Array(0);
  private nextPtsUs: number | null = null;
  /** PTS of the push a frame started in, for the carried frame that was cut off at that push's end. */
  private carryPtsUs: number | null = null;
  private group: { parts: Uint8Array[]; ptsUs: number; samples: number } | null = null;

  constructor(private readonly kind: FramerKind) {}

  push(data: Uint8Array, ptsUs: number): AudioFrame[] {
    const buf = this.carry.length === 0 ? data : concat(this.carry, data);
    const newFrom = this.carry.length;
    const out: AudioFrame[] = [];
    let ptsPending = true;
    let at = 0;
    while (at < buf.length) {
      const parsed = this.kind === 'dts' ? this.parseDts(buf, at) : this.parseAc3(buf, at);
      if (parsed === 'resync') {
        at++;
        continue;
      }
      if (parsed === null) {
        // Header cut off by the push boundary: keep this push's PTS for it unless it turns out to be a dependent frame.
        if (at >= newFrom && ptsPending) {
          this.carryPtsUs = ptsUs;
          ptsPending = false;
        }
        break;
      }
      const start = at;
      if (at + parsed.size > buf.length) {
        if (start >= newFrom && ptsPending && parsed.startsUnit) {
          this.carryPtsUs = ptsUs;
          ptsPending = false;
        }
        break;
      }
      const carriedPtsUs = start < newFrom ? this.carryPtsUs : null;
      this.carryPtsUs = null;
      const bytes = buf.slice(at, at + parsed.size);
      at += parsed.size;
      if (parsed.drop) continue;
      if (!parsed.startsUnit) {
        this.group?.parts.push(bytes);
        continue;
      }
      let frameUs = this.nextPtsUs ?? ptsUs;
      if (carriedPtsUs !== null) {
        frameUs = carriedPtsUs;
      } else if (ptsPending && start >= newFrom) {
        frameUs = ptsUs;
        ptsPending = false;
      }
      this.nextPtsUs = frameUs + (parsed.samples * 1e6) / SAMPLE_RATE;
      if (this.kind === 'eac3') {
        if (this.group) out.push(finish(this.group));
        this.group = { parts: [bytes], ptsUs: frameUs, samples: parsed.samples };
      } else {
        out.push({ data: bytes, ptsUs: frameUs, samples: parsed.samples });
      }
    }
    this.carry = buf.slice(at);
    return out;
  }

  reset(): void {
    this.carry = new Uint8Array(0);
    this.nextPtsUs = null;
    this.carryPtsUs = null;
    this.group = null;
  }

  private parseAc3(b: Uint8Array, at: number): Parsed | 'resync' | null {
    if (b.length - at < 2) return null;
    if (b[at] !== 0x0b || b[at + 1] !== 0x77) return 'resync';
    if (b.length - at < 6) return null;
    const bsid = b[at + 5] >> 3;
    const fscod = b[at + 4] >> 6;
    if (bsid <= 10) {
      const frmsizecod = b[at + 4] & 0x3f;
      if (fscod !== 0 || frmsizecod >= AC3_WORDS_48K.length) return 'resync'; // Blu-ray AC-3 is always 48 kHz
      return { size: AC3_WORDS_48K[frmsizecod] * 2, samples: 1536, startsUnit: true };
    }
    if (bsid > 16) return 'resync';
    const strmtyp = b[at + 2] >> 6;
    if (strmtyp === 3) return 'resync';
    if (fscod !== 0) return 'resync'; // reduced-rate header: corrupt or a false sync; real non-48 kHz streams fail the decoder's rate check
    const substreamId = (b[at + 2] >> 3) & 0x07;
    const frmsiz = ((b[at + 2] & 0x07) << 8) | b[at + 3];
    const blocks = EAC3_BLOCKS[(b[at + 4] >> 4) & 0x03];
    const startsUnit = this.kind !== 'eac3' || (strmtyp !== 1 && substreamId === 0);
    return { size: (frmsiz + 1) * 2, samples: blocks * 256, startsUnit };
  }

  private parseDts(b: Uint8Array, at: number): Parsed | 'resync' | null {
    if (b.length - at < 4) return null;
    const sync = ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
    if (sync === DTS_SYNC) {
      if (b.length - at < 8) return null;
      const nblks = ((b[at + 4] & 0x01) << 6) | (b[at + 5] >> 2);
      const fsize = (((b[at + 5] & 0x03) << 12) | (b[at + 6] << 4) | (b[at + 7] >> 4)) + 1;
      if (fsize < 96) return 'resync';
      return { size: fsize, samples: (nblks + 1) * 32, startsUnit: true };
    }
    if (sync === EXSS_SYNC) {
      if (b.length - at < 12) return null;
      const base = at * 8 + 32 + 8 + 2; // after sync, UserDefinedBits(8), nExtSSIndex(2)
      const wide = readBits(b, base, 1) === 1;
      const fsize = readBits(b, base + 1 + (wide ? 12 : 8), wide ? 20 : 16) + 1;
      return { size: fsize, samples: 0, startsUnit: false, drop: true };
    }
    return 'resync';
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function finish(group: { parts: Uint8Array[]; ptsUs: number; samples: number }): AudioFrame {
  return { data: group.parts.length === 1 ? group.parts[0] : concat(...group.parts), ptsUs: group.ptsUs, samples: group.samples };
}
