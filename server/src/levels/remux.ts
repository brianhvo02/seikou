import { NULL_PID, SOURCE_PACKET_SIZE } from '@seikou/bdmv/demux/constants';
import { readTimestamp } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { mpegCrc32, type KeptPacket, type KeptStreams } from './audio-core';
import type { IntervalPlan } from './levels';

const TS_PAYLOAD = 184;
/** The arrival time stamp is the low 30 bits of the TP_extra_header (27 MHz); the top 2 are copy_permission_indicator. */
const ATS_WRAP = 2 ** 30;
const DTS_WRAP = 2 ** 33;
const PCR_WRAP = DTS_WRAP * 300;
/** 100 ms at 27 MHz: the longest gap between two PCRs the re-muxer writes. */
export const PCR_PERIOD_27 = 2_700_000;
const PAT_PID = 0;
const BD_PMT_PID = 0x0100;

/** One encoded video PES and its decoding time stamp (90 kHz). */
export interface EncodedPes {
  readonly pes: Uint8Array;
  readonly dts90: number;
}

/** Where the source put a video PES: its DTS (its PTS when it has no DTS) and the ATS of its first packet. */
export interface VideoAnchor {
  readonly dts90: number;
  readonly ats: number;
}

/** A PCR of the source and the ATS of its packet: the clip's ATC and STC at one point, both 27 MHz. */
export interface PcrAnchor {
  readonly ats: number;
  readonly pcr27: number;
}

/** One EP interval's inputs for `remuxInterval`. */
export interface RemuxInput {
  /** The interval being built; `budgetBytes` is the exact size of its output. */
  readonly plan: IntervalPlan;
  /** The kept packets assigned to this interval (spn within [plan.srcSpnStart, plan.srcSpnEnd)), in any order. */
  readonly kept: readonly KeptPacket[];
  /** The encoded video of the interval, in decode order. */
  readonly video: readonly EncodedPes[];
  /** The primary video's PID, which the output keeps. */
  readonly videoPid: number;
  /** The source video's PES in the interval, in decode order: where the encode's PES go, by DTS. */
  readonly videoTimeline: readonly VideoAnchor[];
  /**
   * Non-null when the source carried PCR on its video PID: the re-muxer then carries PCR on `videoPid`, read from the ATC
   * through this anchor, and names `videoPid` as PCR_PID in the PMT. Null when PCR travels on a kept PID of its own.
   */
  readonly pcr: PcrAnchor | null;
  /** The ATS of the source packet at `plan.srcSpnEnd` (the next interval's first), when there is one: the padding runs up to it. */
  readonly endAts?: number;
  /** The clip's PMT PIDs (CLPI program_map_PID); default 0x0100. */
  readonly pmtPids?: readonly number[];
}

/** A packet of the output and its arrival time, unwrapped (it may pass 2^30). */
interface Slot {
  ats: number;
  readonly bytes: Uint8Array;
  readonly kind: 'kept' | 'video' | 'pcr' | 'null';
}

/** `raw` (modulo `wrap`) as the value nearest to `ref`. */
function unwrap(raw: number, ref: number, wrap: number): number {
  let d = (raw - ref) % wrap;
  if (d < 0) d += wrap;
  if (d >= wrap / 2) d -= wrap;
  return ref + d;
}

/** The arrival time stamp of a 192-byte source packet: the low 30 bits of its 4-byte TP_extra_header, 27 MHz ticks. */
export function atsOf(packet: Uint8Array): number {
  return ((packet[0]! & 0x3f) * 0x1000000) + ((packet[1]! << 16) | (packet[2]! << 8) | packet[3]!);
}

function setAts(packet: Uint8Array, ats: number): void {
  const a = ((ats % ATS_WRAP) + ATS_WRAP) % ATS_WRAP;
  packet[0] = (packet[0]! & 0xc0) | Math.floor(a / 0x1000000);
  packet[1] = (a >>> 16) & 0xff;
  packet[2] = (a >>> 8) & 0xff;
  packet[3] = a & 0xff;
}

function pidOf(packet: Uint8Array): number {
  return ((packet[5]! & 0x1f) << 8) | packet[6]!;
}

/** Payload sizes for `length` bytes over `count` packets (count ≤ length): full packets first, at least a byte each. */
function chunkSizes(length: number, count: number): number[] {
  const sizes: number[] = [];
  let left = length;
  for (let i = 0; i < count; i++) {
    const take = Math.min(TS_PAYLOAD, left - (count - 1 - i));
    sizes.push(take);
    left -= take;
  }
  return sizes;
}

/** A packet of `pid` with `payload` (at most 184 bytes), stuffed with an adaptation field; the counter is set later. */
function payloadPacket(pid: number, start: boolean, payload: Uint8Array): Uint8Array {
  const p = new Uint8Array(SOURCE_PACKET_SIZE);
  p[4] = 0x47;
  p[5] = (start ? 0x40 : 0) | (pid >> 8);
  p[6] = pid & 0xff;
  if (payload.length === TS_PAYLOAD) {
    p[7] = 0x10;
    p.set(payload, 8);
    return p;
  }
  const af = TS_PAYLOAD - 1 - payload.length;
  p[7] = 0x30;
  p[8] = af;
  if (af > 0) {
    p[9] = 0x00;
    p.fill(0xff, 10, 9 + af);
  }
  p.set(payload, 9 + af);
  return p;
}

/** An adaptation-only packet of `pid` carrying a PCR; the counter is set later (it doesn't advance on such a packet). */
function pcrPacket(pid: number, pcr27: number): Uint8Array {
  const p = new Uint8Array(SOURCE_PACKET_SIZE);
  p[4] = 0x47;
  p[5] = pid >> 8;
  p[6] = pid & 0xff;
  p[7] = 0x20;
  p[8] = 183;
  p[9] = 0x10; // PCR_flag
  const pcr = ((pcr27 % PCR_WRAP) + PCR_WRAP) % PCR_WRAP;
  const base = Math.floor(pcr / 300);
  const ext = pcr % 300;
  p[10] = Math.floor(base / 2 ** 25) & 0xff;
  p[11] = Math.floor(base / 2 ** 17) & 0xff;
  p[12] = Math.floor(base / 2 ** 9) & 0xff;
  p[13] = Math.floor(base / 2) & 0xff;
  p[14] = ((base % 2) << 7) | 0x7e | (ext >> 8);
  p[15] = ext & 0xff;
  p.fill(0xff, 16);
  return p;
}

function nullPacket(): Uint8Array {
  const p = new Uint8Array(SOURCE_PACKET_SIZE).fill(0xff);
  p.set([0, 0, 0, 0, 0x47, NULL_PID >> 8, NULL_PID & 0xff, 0x10]);
  return p;
}

/**
 * A copy of a PMT packet naming `pcrPid` as PCR_PID, with its CRC redone; the packet itself when it already does.
 * Throws when the section isn't whole in the packet (a Blu-ray PMT always is).
 */
function withPcrPid(packet: Uint8Array, pcrPid: number): Uint8Array {
  const ts = parseSourcePacket(packet, 0);
  if (!ts?.payloadUnitStart || !ts.hasPayload) return packet;
  const at = ts.payload.byteOffset - packet.byteOffset + 1 + ts.payload[0]!;
  const end = at + 12 > SOURCE_PACKET_SIZE ? Infinity : at + 3 + (((packet[at + 1]! & 0x0f) << 8) | packet[at + 2]!);
  if (end > SOURCE_PACKET_SIZE) throw new Error('levels: a PMT section spans packets; PCR_PID cannot be rewritten');
  if (packet[at] !== 0x02 || (((packet[at + 8]! & 0x1f) << 8) | packet[at + 9]!) === pcrPid) return packet;
  const out = packet.slice();
  out[at + 8] = 0xe0 | (pcrPid >> 8);
  out[at + 9] = pcrPid & 0xff;
  const crc = mpegCrc32(out.subarray(at, end - 4));
  out.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], end - 4);
  return out;
}

/**
 * Re-muxes one EP interval of a clip at a level: the kept packets and the encoded video, then null packets,
 * to exactly `plan.budgetBytes`.
 *
 * - **Kept packets** go in the order of their assigned SPN (stable within one SPN), each with its original ATS, raised
 *   where needed so the output's ATS never decreases (a filtered PES comes whole at its first packet's SPN, so its tail
 *   can arrive later than the next packets of other PIDs) and lowered to `endAts` (the tail of a PES that runs on past
 *   the interval's end). Their TS bytes are unchanged, except the PMT's PCR_PID when
 *   PCR moves onto the video PID.
 * - **Video** PES go onto `videoPid`, each at the ATS where the source put the video of the same DTS (interpolated
 *   between the source's PES starts, clamped to them), its packets spread up to the next PES's ATS. This keeps the
 *   source mux's lead of video over its decoding time, and needs no clock: it works the same on the ATC of a disc and
 *   on any monotonic count. The leading PSI (the PAT and PMT before the first EP entry of interval 0) stays in front.
 * - **Continuity counters** on `videoPid` run from 0 and the interval's video takes a multiple of 16 packets (a PES is
 *   split over more, smaller packets when needed), so the last one is 15 and the counters run on unbroken from one
 *   interval to the next, encoded apart. A break would make a demuxer drop the previous interval's last frame.
 * - **PCR**, when `pcr` is given: adaptation-only packets on `videoPid`, at the start and at least every 100 ms of ATS,
 *   through the padding too when `endAts` is known.
 * - **Padding**: null packets (PID 0x1FFF) after the content, their ATS spread up to `endAts`.
 *
 * Returns `overflow`, the content's bytes past the budget, when it doesn't fit; the caller re-encodes the video smaller.
 * Returns the whole interval as `bytes`, a multiple of the aligned unit, when it does.
 */
export function remuxInterval(input: RemuxInput): { bytes: Uint8Array } | { overflow: number } {
  const { plan, videoPid } = input;
  const pmtPids = new Set(input.pmtPids ?? [BD_PMT_PID]);
  const kept = input.kept
    .map((k, i) => ({ k, i }))
    .sort((a, b) => a.k.spn - b.k.spn || a.i - b.i)
    .map(({ k }) => k.bytes);
  const ref = kept[0] ? atsOf(kept[0]) : (input.videoTimeline[0]?.ats ?? input.pcr?.ats ?? 0);
  // A kept PES assigned here can run on past the interval's end: its tail takes the end's ATS, so the next interval's
  // packets (and PCRs) never arrive before this one's.
  const endAts = input.endAts === undefined ? Infinity : unwrap(input.endAts, ref, ATS_WRAP);

  // Kept packets at their own ATS, never earlier than the one before; the leading PSI run sets the video's floor.
  const keptSlots: Slot[] = [];
  let last = -Infinity;
  let floor = -Infinity;
  let leadingPsi = 0;
  for (const bytes of kept) {
    const pid = pidOf(bytes);
    const isPsi = pid === PAT_PID || pmtPids.has(pid);
    last = Math.max(last, Math.min(endAts, unwrap(atsOf(bytes), ref, ATS_WRAP)));
    if (leadingPsi === keptSlots.length && isPsi) {
      floor = last;
      leadingPsi++;
    }
    const out = input.pcr && pmtPids.has(pid) ? withPcrPid(bytes, videoPid) : bytes;
    keptSlots.push({ ats: last, bytes: out, kind: 'kept' });
  }

  const videoSlots = videoPackets(input, ref, floor);
  const merged = mergeByAts(keptSlots, videoSlots);
  const content = input.pcr ? withPcr(merged, input.pcr, ref, videoPid, leadingPsi) : merged;

  const total = plan.budgetBytes / SOURCE_PACKET_SIZE;
  if (content.length > total) return { overflow: (content.length - total) * SOURCE_PACKET_SIZE };

  const slots = [...content, ...padding(input, content, total - content.length, ref)];
  const out = new Uint8Array(plan.budgetBytes);
  let videoCc = 0;
  slots.forEach((s, i) => {
    const at = i * SOURCE_PACKET_SIZE;
    out.set(s.bytes, at);
    const p = out.subarray(at, at + SOURCE_PACKET_SIZE);
    setAts(p, s.ats);
    if (s.kind === 'video') {
      p[7] = (p[7]! & 0xf0) | videoCc;
      videoCc = (videoCc + 1) & 0x0f;
    } else if (s.kind === 'pcr') {
      p[7] = (p[7]! & 0xf0) | ((videoCc + 15) & 0x0f);
    }
  });
  return { bytes: out };
}

/** The encoded video as packets on `videoPid`, each with its ATS (see `remuxInterval`). */
function videoPackets(input: RemuxInput, ref: number, floor: number): Slot[] {
  const { video, videoPid } = input;
  if (video.length === 0) return [];
  const dtsRef = input.videoTimeline[0]?.dts90 ?? video[0]!.dts90;
  let maxAts = -Infinity;
  const anchors = input.videoTimeline.map((a) => {
    maxAts = Math.max(maxAts, unwrap(a.ats, ref, ATS_WRAP));
    return { dts: unwrap(a.dts90, dtsRef, DTS_WRAP), ats: maxAts };
  });
  const atsFor = (dts90: number): number => {
    const d = unwrap(dts90, dtsRef, DTS_WRAP);
    if (anchors.length === 0) return ref;
    if (d <= anchors[0]!.dts) return anchors[0]!.ats;
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1]!;
      const b = anchors[i]!;
      if (d <= b.dts) return b.dts === a.dts ? a.ats : a.ats + Math.floor(((b.ats - a.ats) * (d - a.dts)) / (b.dts - a.dts));
    }
    return anchors.at(-1)!.ats;
  };
  let prev = -Infinity;
  const starts = video.map((v) => (prev = Math.max(prev, floor, atsFor(v.dts90))));

  // Packets per PES, then extra (smaller) packets so the interval's count is a multiple of 16; the PES with the most
  // spare bytes take them.
  const counts = video.map((v) => Math.ceil(v.pes.length / TS_PAYLOAD));
  let extra = (16 - (counts.reduce((n, c) => n + c, 0) % 16)) % 16;
  while (extra > 0) {
    let best = -1;
    for (let i = 0; i < video.length; i++) if (counts[i]! < video[i]!.pes.length && (best < 0 || video[i]!.pes.length - counts[i]! > video[best]!.pes.length - counts[best]!)) best = i;
    if (best < 0) break; // every PES is one byte per packet already; the counters break at the next interval
    const add = Math.min(extra, video[best]!.pes.length - counts[best]!);
    counts[best]! += add;
    extra -= add;
  }

  const out: Slot[] = [];
  video.forEach((v, i) => {
    const start = starts[i]!;
    const end = starts[i + 1] ?? start;
    const sizes = chunkSizes(v.pes.length, counts[i]!);
    let at = 0;
    sizes.forEach((size, k) => {
      const ats = start + Math.floor(((end - start) * k) / sizes.length);
      out.push({ ats, bytes: payloadPacket(videoPid, k === 0, v.pes.subarray(at, at + size)), kind: 'video' });
      at += size;
    });
  });
  return out;
}

/** Both lists in ATS order; on equal ATS a kept packet goes first. Each list keeps its own order. */
function mergeByAts(kept: readonly Slot[], video: readonly Slot[]): Slot[] {
  const out: Slot[] = [];
  let i = 0;
  let j = 0;
  while (i < kept.length || j < video.length) {
    if (j >= video.length || (i < kept.length && kept[i]!.ats <= video[j]!.ats)) out.push(kept[i++]!);
    else out.push(video[j++]!);
  }
  return out;
}

function pcrAt(anchor: PcrAnchor, ref: number, ats: number): number {
  return anchor.pcr27 + (ats - unwrap(anchor.ats, ref, ATS_WRAP));
}

/**
 * `slots` with PCR packets on `videoPid`: one after the leading PSI (the first `leadingPsi` slots: the video never goes
 * before them), then whenever 100 ms of ATS would pass without one.
 */
function withPcr(slots: readonly Slot[], anchor: PcrAnchor, ref: number, videoPid: number, leadingPsi: number): Slot[] {
  const out: Slot[] = [];
  let lastPcr: number | null = null;
  const put = (ats: number): void => {
    out.push({ ats, bytes: pcrPacket(videoPid, pcrAt(anchor, ref, ats)), kind: 'pcr' });
    lastPcr = ats;
  };
  slots.forEach((s, i) => {
    if (i === leadingPsi) put(s.ats);
    while (lastPcr !== null && s.ats - lastPcr > PCR_PERIOD_27) put(lastPcr + PCR_PERIOD_27);
    out.push(s);
  });
  if (lastPcr === null) put(out.at(-1)?.ats ?? ref);
  return out;
}

/** `count` null packets, their ATS spread from the content's last up to `endAts`; with PCR on video, some carry it. */
function padding(input: RemuxInput, content: readonly Slot[], count: number, ref: number): Slot[] {
  const from = content.at(-1)?.ats ?? ref;
  const end = input.endAts === undefined ? from : Math.max(from, unwrap(input.endAts, ref, ATS_WRAP));
  const slots: Slot[] = [];
  for (let j = 0; j < count; j++) slots.push({ ats: from + Math.floor(((end - from) * (j + 1)) / (count + 1)), bytes: nullPacket(), kind: 'null' });
  const anchor = input.pcr;
  if (!anchor) return slots;
  let lastPcr = -Infinity;
  for (const s of content) if (s.kind === 'pcr') lastPcr = s.ats;
  for (let j = 0; j < slots.length; j++) {
    const next = slots[j + 1]?.ats ?? end;
    if (next - lastPcr > PCR_PERIOD_27) {
      const ats = slots[j]!.ats;
      slots[j] = { ats, bytes: pcrPacket(input.videoPid, pcrAt(anchor, ref, ats)), kind: 'pcr' };
      lastPcr = ats;
    }
  }
  return slots;
}

/** What `remuxInterval` needs from the source for one interval, besides its plan and the encoded video. */
export interface IntervalSource {
  /** The kept packets assigned to the interval. */
  readonly kept: KeptPacket[];
  /** The source video's PES starts in the interval. */
  readonly videoTimeline: VideoAnchor[];
  /** The PCR anchor when PCR rides on the video PID; else null. */
  readonly pcr: PcrAnchor | null;
  /** The ATS of the next interval's first source packet, when it is known. */
  readonly endAts?: number;
}

/** The PCR of an adaptation field, at 27 MHz, or null. */
function readPcr(packet: Uint8Array): number | null {
  if (!(packet[7]! & 0x20) || packet[8]! < 7 || !(packet[9]! & 0x10)) return null;
  const base = packet[10]! * 2 ** 25 + packet[11]! * 2 ** 17 + packet[12]! * 2 ** 9 + packet[13]! * 2 + (packet[14]! >> 7);
  return base * 300 + (((packet[14]! & 0x01) << 8) | packet[15]!);
}

/** What an `IntervalCollector` needs to know about the clip. */
export interface IntervalCollectorOptions {
  /** The primary video's PID. */
  readonly videoPid: number;
  /** The source's PCR PID (from the PMT); its PCRs are collected only when it is the video PID. */
  readonly pcrPid: number;
  /** The clip's intervals: the ATS at each one's end SPN is kept for its `endAts`, and no other. */
  readonly intervals: readonly IntervalPlan[];
  /** SPNs where the clip's STC sequences start (CLPI spnStcStart); a PCR anchor never carries across one. */
  readonly stcStarts?: readonly number[];
}

/**
 * Collects a clip's source packets, fed in order from an interval's start, into what each interval's re-mux needs: the
 * kept packets assigned to it, the source video's PES starts and, when PCR rides on the video PID, a PCR
 * (the interval's first, else the latest earlier one in the same STC sequence). A filtered PES that starts in an
 * interval completes only past its end, so an interval is ready once the source was fed past its end and no unit
 * started in it is still open (or `finish()` was called at the clip's end).
 */
export class IntervalCollector {
  private held: KeptPacket[] = [];
  private timeline: Array<VideoAnchor & { spn: number }> = [];
  private pcrs: Array<PcrAnchor & { spn: number }> = [];
  /** The latest PCR of the intervals already taken. */
  private earlierPcr: (PcrAnchor & { spn: number }) | null = null;
  private readonly endSpns: ReadonlySet<number>;
  private atsAt = new Map<number, number>();
  private lastSpn = -1;
  private finished = false;

  constructor(
    private readonly streams: KeptStreams,
    private readonly options: IntervalCollectorOptions,
  ) {
    this.endSpns = new Set(options.intervals.map((iv) => iv.srcSpnEnd));
  }

  /**
   * Feeds the source packet at `spn`. `packet` may be a view into a larger read buffer: the packets kept from it are
   * copied (only those), so they never pin the buffer.
   */
  push(packet: Uint8Array, spn: number): void {
    for (const k of this.streams.filter(packet, spn)) this.held.push(k.bytes.byteLength === k.bytes.buffer.byteLength ? k : { spn: k.spn, bytes: k.bytes.slice() });
    this.lastSpn = spn;
    if (this.endSpns.has(spn)) this.atsAt.set(spn, atsOf(packet));
    const { videoPid, pcrPid } = this.options;
    const ts = parseSourcePacket(packet, 0);
    if (!ts || ts.pid !== videoPid) return;
    if (pcrPid === videoPid) {
      const pcr = readPcr(packet);
      if (pcr !== null) this.pcrs.push({ spn, ats: atsOf(packet), pcr27: pcr });
    }
    const p = ts.payload;
    if (ts.payloadUnitStart && p.length >= 14 && p[0] === 0 && p[1] === 0 && p[2] === 1 && p[7]! & 0x80) {
      const hasDts = p[7]! >> 6 === 3 && p.length >= 19;
      this.timeline.push({ spn, ats: atsOf(packet), dts90: readTimestamp(p, hasDts ? 14 : 9) });
    }
  }

  /** The end of the clip: hands over a PES still open. */
  finish(): void {
    this.held.push(...this.streams.flush());
    this.finished = true;
  }

  /** Whether `take(plan)` has everything: the source is fed past the interval's end and no unit started in it is still open. */
  ready(plan: IntervalPlan): boolean {
    if (this.finished) return true;
    const open = this.streams.openSince();
    return this.lastSpn >= plan.srcSpnEnd && (open === null || open >= plan.srcSpnEnd);
  }

  /** The interval's source, once `ready`; what belongs to earlier intervals is dropped, later ones' is kept. */
  take(plan: IntervalPlan): IntervalSource {
    if (!this.ready(plan)) throw new Error(`levels: interval ${plan.index} isn't collected yet`);
    const inside = (spn: number): boolean => spn >= plan.srcSpnStart && spn < plan.srcSpnEnd;
    const after = (spn: number): boolean => spn >= plan.srcSpnEnd;
    const earlier = this.earlierPcr;
    const sameStc = (from: number): boolean => !(this.options.stcStarts ?? []).some((s) => s > from && s <= plan.srcSpnStart);
    const pcr = this.pcrs.find((p) => inside(p.spn)) ?? (earlier && earlier.spn < plan.srcSpnStart && sameStc(earlier.spn) ? earlier : undefined);
    const endAts = this.atsAt.get(plan.srcSpnEnd);
    const source: IntervalSource = {
      kept: this.held.filter((k) => inside(k.spn)),
      videoTimeline: this.timeline.filter((a) => inside(a.spn)).map(({ dts90, ats }) => ({ dts90, ats })),
      pcr: pcr ? { ats: pcr.ats, pcr27: pcr.pcr27 } : null,
      ...(endAts === undefined ? {} : { endAts }),
    };
    for (const p of this.pcrs) if (!after(p.spn)) this.earlierPcr = p;
    this.held = this.held.filter((k) => after(k.spn));
    this.timeline = this.timeline.filter((a) => after(a.spn));
    this.pcrs = this.pcrs.filter((p) => after(p.spn));
    for (const spn of this.atsAt.keys()) if (spn < plan.srcSpnEnd) this.atsAt.delete(spn);
    return source;
  }
}

/** The kept graphics streams by stream number (the play item's STN order): the order the last resort drops them in. */
export interface GraphicsByNumber {
  /** The kept PG (subtitle) PIDs, stream number 1 first. */
  readonly pg: readonly number[];
  /** The kept IG (menu) PIDs, stream number 1 first. */
  readonly ig: readonly number[];
}

/** A graphics stream the last resort dropped PES of. */
export interface DroppedGraphics {
  /** The stream's PID. */
  readonly pid: number;
  /** Which kind of stream it is. */
  readonly kind: 'pg' | 'ig';
}

/**
 * The re-mux's last resort, because a clip's graphics are the only thing the level may drop, when an interval's kept packets don't fit its budget even with its video at the
 * floor rate: drops whole PES of graphics streams from the interval, one stream after another, PG first from the
 * highest stream number, and IG (menus) only once every PG stream is gone, until it fits. A dropped stream loses every
 * PES that starts in the interval; the packets before its first PES start (the end of a PES that began in the interval
 * before) stay. `dropped` names only the streams that lost packets. Video and the kept audio are never dropped. Null
 * when it doesn't fit even with no graphics.
 */
export function shedGraphics(input: RemuxInput, graphics: GraphicsByNumber): { bytes: Uint8Array; dropped: DroppedGraphics[] } | null {
  const ordered = input.kept
    .map((k, i) => ({ k, i }))
    .sort((a, b) => a.k.spn - b.k.spn || a.i - b.i)
    .map(({ k }) => k);
  const order: DroppedGraphics[] = [
    ...[...graphics.pg].reverse().map((pid) => ({ pid, kind: 'pg' as const })),
    ...[...graphics.ig].reverse().map((pid) => ({ pid, kind: 'ig' as const })),
  ];
  for (let n = 1; n <= order.length; n++) {
    const shedding = new Set(order.slice(0, n).map((d) => d.pid));
    const started = new Set<number>();
    const lost = new Set<number>();
    const kept = ordered.filter((k) => {
      const pid = pidOf(k.bytes);
      if (!shedding.has(pid)) return true;
      if (k.bytes[5]! & 0x40) started.add(pid); // payload_unit_start_indicator: a PES starts here
      if (!started.has(pid)) return true;
      lost.add(pid);
      return false;
    });
    if (lost.size === 0) continue; // nothing of these streams starts here: dropping them makes no room
    const result = remuxInterval({ ...input, kept });
    if ('bytes' in result) return { bytes: result.bytes, dropped: order.slice(0, n).filter((d) => lost.has(d.pid)) };
  }
  return null;
}
