import type { TsPacket } from './ts-packet';

export interface PesPacket {
  readonly pid: number;
  readonly streamId: number;
  /** 90 kHz. */
  readonly pts?: number;
  readonly dts?: number;
  /** stream_id_extension of a 0xFD packet (Blu-ray: 0x76 AC-3 core, 0x72 TrueHD/MLP). */
  readonly streamIdExtension?: number;
  readonly payload: Uint8Array;
}

interface PidState {
  chunks: Uint8Array[];
  size: number;
  lastCc: number;
  broken: boolean;
  /** 6 + PES_packet_length when the header declares one (0: unbounded, ends at the next unit start). */
  expected: number;
  /** Handed over once complete; later packets until the next unit start are ignored. */
  done: boolean;
}

/** Stream ids whose PES packets carry no optional header (ISO 13818-1 Table 2-21). */
const NO_HEADER_STREAM_IDS = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff]);

export function readTimestamp(d: Uint8Array, o: number): number {
  return ((d[o] >> 1) & 0x07) * 0x40000000 + ((d[o + 1] << 22) | ((d[o + 2] >> 1) << 15) | (d[o + 3] << 7) | (d[o + 4] >> 1));
}

/**
 * Reassembles PES packets per PID. A PES whose header declares its length completes as soon as that many bytes arrived
 * (as libbluray's m2ts_demux); an unbounded one (length 0, usual for video) at the next unit start on its PID, or on flush().
 */
export class PesAssembler {
  continuityErrors = 0;
  private readonly states = new Map<number, PidState>();

  constructor(private readonly onPes: (pes: PesPacket) => void) {}

  push(packet: TsPacket): void {
    if (!packet.hasPayload) return; // CC does not advance on adaptation-only packets
    const state = this.states.get(packet.pid);
    if (packet.payloadUnitStart) {
      if (state && !state.broken && packet.continuityCounter !== state.lastCc && packet.continuityCounter !== ((state.lastCc + 1) & 0x0f)) {
        state.broken = true; // tail packets of the previous PES were lost
        this.continuityErrors++;
      }
      if (state && !state.done) this.emit(packet.pid, state);
      const p = packet.payload;
      const declared = p.length >= 6 ? (p[4]! << 8) | p[5]! : 0;
      const next: PidState = { chunks: [p], size: p.length, lastCc: packet.continuityCounter, broken: false, expected: declared > 0 ? 6 + declared : 0, done: false };
      this.states.set(packet.pid, next);
      this.completeIfWhole(packet.pid, next);
      return;
    }
    if (!state) return; // joined mid-PES (after a seek); wait for the next unit start
    if (packet.continuityCounter === state.lastCc) return; // duplicate packet
    if (packet.continuityCounter !== ((state.lastCc + 1) & 0x0f)) {
      state.broken = true;
      this.continuityErrors++;
    }
    state.lastCc = packet.continuityCounter;
    if (state.done) return;
    state.chunks.push(packet.payload);
    state.size += packet.payload.length;
    this.completeIfWhole(packet.pid, state);
  }

  /** A PES with a declared length is handed over once that many bytes arrived. */
  private completeIfWhole(pid: number, state: PidState): void {
    if (state.expected === 0 || state.size < state.expected) return;
    state.done = true;
    this.emit(pid, state);
    state.chunks = [];
  }

  flush(): void {
    for (const [pid, state] of this.states) if (!state.done) this.emit(pid, state);
    this.states.clear();
  }

  reset(): void {
    this.states.clear();
  }

  private emit(pid: number, state: PidState): void {
    if (state.broken) return;
    const data = new Uint8Array(state.size);
    let at = 0;
    for (const chunk of state.chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    const pes = parsePes(pid, data);
    if (pes) this.onPes(pes);
  }
}

function parsePes(pid: number, d: Uint8Array): PesPacket | null {
  if (d.length < 6 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return null;
  const streamId = d[3];
  const declared = (d[4] << 8) | d[5];
  if (declared !== 0 && d.length < 6 + declared) return null; // truncated PES: drop, do not emit short
  const end = declared === 0 ? d.length : 6 + declared;
  if (NO_HEADER_STREAM_IDS.has(streamId)) return { pid, streamId, payload: d.subarray(6, end) };
  if (d.length < 9) return null;
  const flags = d[7];
  const ptsDtsFlags = flags >> 6;
  const headerEnd = 9 + d[8];
  if (headerEnd > end) return null;
  return {
    pid,
    streamId,
    pts: ptsDtsFlags & 0x2 ? readTimestamp(d, 9) : undefined,
    dts: ptsDtsFlags === 0x3 ? readTimestamp(d, 14) : undefined,
    streamIdExtension: streamId === 0xfd ? readStreamIdExtension(d, flags, headerEnd) : undefined,
    payload: d.subarray(headerEnd, end),
  };
}

/** Walks the optional PES header fields (ISO 13818-1 §2.4.3.7) to PES_extension_2. */
function readStreamIdExtension(d: Uint8Array, flags: number, headerEnd: number): number | undefined {
  if (!(flags & 0x01)) return undefined;
  let o = 9;
  if ((flags >> 6) === 0x2) o += 5;
  else if ((flags >> 6) === 0x3) o += 10;
  if (flags & 0x20) o += 6; // ESCR
  if (flags & 0x10) o += 3; // ES_rate
  if (flags & 0x08) o += 1; // DSM trick mode
  if (flags & 0x04) o += 1; // additional copy info
  if (flags & 0x02) o += 2; // previous PES CRC
  if (o >= headerEnd) return undefined;
  const ext = d[o++];
  if (ext & 0x80) o += 16; // PES_private_data
  if (ext & 0x40) o += 1 + (o < headerEnd ? d[o] : 0); // pack_header_field
  if (ext & 0x20) o += 2; // program_packet_sequence_counter
  if (ext & 0x10) o += 2; // P-STD_buffer
  if (!(ext & 0x01) || o + 1 >= headerEnd) return undefined;
  const field = d[o + 1];
  return field & 0x80 ? undefined : field & 0x7f;
}
