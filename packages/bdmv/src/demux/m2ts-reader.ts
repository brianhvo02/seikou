import type { ByteSource } from '../byte-source';
import { PACKETS_PER_ALIGNED_UNIT, SOURCE_PACKET_SIZE } from './constants';
import { PesAssembler, type PesPacket } from './pes-assembler';
import { parseSourcePacket } from './ts-packet';

/** What an M2tsReader reads: a range of one clip, the PIDs to keep, and how much to read at a time. */
export interface M2tsReaderOptions {
  /** The disc the clip is on. */
  readonly source: ByteSource;
  /** The clip's path on the disc, such as `BDMV/STREAM/00001.m2ts`. */
  readonly path: string;
  /** The source packet number to start at, rounded down to an aligned unit. */
  readonly startSpn: number;
  /** The source packet number to stop before (exclusive); defaults to the end of the file. */
  readonly endSpn?: number;
  /** The PIDs whose PES packets are reassembled and returned; packets of other PIDs are dropped. */
  readonly pids: ReadonlySet<number>;
  /**
   * A lead-in read before `startSpn`: reading starts at `fromSpn` (rounded down to an aligned unit), but until the aligned
   * unit `startSpn` is in, only the packets of `pids` pass. The other PIDs see exactly what a read from `startSpn` sees.
   */
  readonly lead?: { readonly fromSpn: number; readonly pids: ReadonlySet<number> };
  /** Packets per read; rounded to whole aligned units. Default ≈ 2 MB. */
  readonly chunkPackets?: number;
}

/** Damage the reader met and skipped so far. */
export interface DemuxStats {
  /** Source packets `parseSourcePacket` rejected (lost sync byte, transport error, bad adaptation field length). */
  readonly corruptPackets: number;
  /** Continuity counter gaps on the selected PIDs; the PES each one broke was dropped. */
  readonly continuityErrors: number;
}

/**
 * The default `chunkPackets`: 341 aligned units, about 2 MB per read.
 * @internal
 */
export const DEFAULT_CHUNK_PACKETS = PACKETS_PER_ALIGNED_UNIT * 341;

/**
 * Reads a clip in aligned chunks, prefetching the next chunk while the current one is demuxed, and hands out the PES
 * packets of the selected PIDs. A PES that started before the first packet read is skipped, and one with a declared
 * length that `endSpn` cuts off is dropped. Read errors from the source reject `next()`; damaged packets are counted
 * in `stats` and skipped.
 */
export class M2tsReader {
  private readonly assembler: PesAssembler;
  private readonly out: PesPacket[] = [];
  private readonly endSpn: number;
  private readonly chunkPackets: number;
  private cursor: number;
  /** Aligned packet where every PID of `pids` passes; before it only the lead's PIDs do. */
  private readonly mainSpn: number;
  private prefetch: Promise<Uint8Array> | null = null;
  private readonly abort = new AbortController();
  private done = false;
  private corruptPackets = 0;

  constructor(private readonly opts: M2tsReaderOptions) {
    this.assembler = new PesAssembler((pes) => this.out.push(pes));
    const total = Math.floor(opts.source.size(opts.path) / SOURCE_PACKET_SIZE);
    this.endSpn = Math.min(opts.endSpn ?? total, total);
    const requested = opts.chunkPackets ?? DEFAULT_CHUNK_PACKETS;
    this.chunkPackets = Math.max(1, Math.round(requested / PACKETS_PER_ALIGNED_UNIT)) * PACKETS_PER_ALIGNED_UNIT;
    this.mainSpn = Math.floor(opts.startSpn / PACKETS_PER_ALIGNED_UNIT) * PACKETS_PER_ALIGNED_UNIT;
    const lead = opts.lead;
    this.cursor = lead && lead.fromSpn < this.mainSpn ? Math.floor(lead.fromSpn / PACKETS_PER_ALIGNED_UNIT) * PACKETS_PER_ALIGNED_UNIT : this.mainSpn;
  }

  /** Source packet where the chunks handed out by next() end (the prefetch is not counted): what was delivered. */
  get deliveredSpn(): number {
    return this.cursor;
  }

  /** Counts of the damage met so far. */
  get stats(): DemuxStats {
    return { corruptPackets: this.corruptPackets, continuityErrors: this.assembler.continuityErrors };
  }

  /** Stops reading: an in-flight read or prefetch is cancelled, and next() returns null from now on. */
  cancel(): void {
    this.done = true;
    this.prefetch = null;
    this.abort.abort(new DOMException('reader cancelled', 'AbortError'));
  }

  /** PES packets completed by the next chunk (possibly empty), or null once the range is exhausted. */
  async next(): Promise<PesPacket[] | null> {
    if (this.done) return null;
    if (this.cursor >= this.endSpn) {
      this.done = true;
      this.assembler.flush();
      return this.out.splice(0);
    }
    const chunkStart = this.cursor;
    const count = Math.min(this.chunkPackets, this.endSpn - chunkStart);
    const data = await (this.prefetch ?? this.readPackets(chunkStart, count));
    if (this.done) return null; // cancelled while the read was in flight
    this.cursor = chunkStart + count;
    this.prefetch = this.cursor < this.endSpn ? this.readPackets(this.cursor, Math.min(this.chunkPackets, this.endSpn - this.cursor)) : null;

    const packets = Math.floor(data.length / SOURCE_PACKET_SIZE);
    const leadPids = this.opts.lead?.pids;
    for (let k = 0; k < packets; k++) {
      const packet = parseSourcePacket(data, k * SOURCE_PACKET_SIZE);
      if (!packet) {
        this.corruptPackets++;
        continue;
      }
      const pids = chunkStart + k < this.mainSpn && leadPids ? leadPids : this.opts.pids;
      if (pids.has(packet.pid)) this.assembler.push(packet);
    }
    return this.out.splice(0);
  }

  private readPackets(spn: number, count: number): Promise<Uint8Array> {
    const read = this.opts.source.read(this.opts.path, spn * SOURCE_PACKET_SIZE, count * SOURCE_PACKET_SIZE, this.abort.signal);
    read.catch(() => undefined); // an abandoned prefetch must not surface as an unhandled rejection
    return read;
  }
}
