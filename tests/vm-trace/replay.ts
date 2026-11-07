import { fileURLToPath } from 'node:url';
import type { Mpls } from '@seikou/bdmv/mpls-parser';
import type { Clpi } from '@seikou/bdmv/clpi-parser';
import { ALIGNED_UNIT_SIZE, PACKETS_PER_ALIGNED_UNIT, SOURCE_PACKET_SIZE } from '@seikou/bdmv/demux/constants';
import { M2tsReader } from '@seikou/bdmv/demux/m2ts-reader';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import type { ByteSource } from '@seikou/bdmv/byte-source';
import { FileSource } from '../../src/engine/disc/file-source';
import { loadClips, openDisc, streamPath, type DiscModel } from '../../src/engine/disc/open-disc';
import { BdVk } from '../../src/engine/graphics/graphics-controller';
import { OverlayPlane } from '../../src/engine/graphics/overlay-plane';
import { normalizeDiscPaths } from '../../src/engine/disc/paths';
import { PSR, RegisterFile, type PsrEvent } from '../../src/engine/hdmv/registers';
import type { UoMask, UoOp } from '../../src/engine/hdmv/uo-mask';
import { Navigator, type IgUnit, type NavigatorEvent, type PlayAt, type PlaybackPort } from '../../src/engine/nav/navigator';
import { PgStreamControl } from '../../src/engine/nav/subtitles';
import { directoryEntries } from '../helpers/file-blob';
import { dumpIgPages } from './dump-pages';
import type { TraceEntry } from './format';
import { parseScript, type KeyName, type ScriptStep } from './script';

const READ_SIZE = 6144;
const SCR_PER_READ = 1800;
const MAX_READS = 10_000_000;
const TAIL_READS = 200;
const NO_CHAPTER = 0xffff;
const IG_PIDS = new Set(Array.from({ length: 0x20 }, (_, k) => 0x1400 + k)); // IS_HDMV_PID_IG
const PG_PIDS = new Set(Array.from({ length: 0x20 }, (_, k) => 0x1200 + k)); // IS_HDMV_PID_PG
const READ_CHUNK = ALIGNED_UNIT_SIZE * 341;

const KEY_VK: Record<KeyName, number> = {
  up: BdVk.UP, down: BdVk.DOWN, left: BdVk.LEFT, right: BdVk.RIGHT, ok: BdVk.ENTER, topmenu: BdVk.ROOT_MENU, popup: BdVk.POPUP,
  '0': BdVk.D0, '1': BdVk.D1, '2': BdVk.D2, '3': BdVk.D3, '4': BdVk.D4, '5': BdVk.D5, '6': BdVk.D6, '7': BdVk.D7, '8': BdVk.D8, '9': BdVk.D9,
};

const pts90ToUs = (pts: number): number => (pts * 1000) / 90;

/** A main-path graphics (IG or PG) PES and the clip packet that completes it (m2ts_demux hands a PES over with its last packet). */
interface MainIgUnit {
  readonly endPkt: number;
  readonly unit: IgUnit & { readonly pid: number };
}

/**
 * The graphics PES units of a clip (PIDs in `pids`), in stream order, each with the packet that completes it. They declare
 * their length, and like m2ts_demux the assembler hands one over from inside the push of its last packet.
 */
async function scanMainGraphics(source: ByteSource, clipId: string, pids: ReadonlySet<number>): Promise<MainIgUnit[]> {
  const path = streamPath(clipId);
  const units: MainIgUnit[] = [];
  let pkt = 0;
  const assembler = new PesAssembler((pes) => {
    units.push({ endPkt: pkt, unit: { pid: pes.pid, data: pes.payload, ptsUs: pts90ToUs(pes.pts ?? 0), dtsUs: pes.dts === undefined ? undefined : pts90ToUs(pes.dts) } });
  });
  const size = source.size(path);
  for (let offset = 0; offset < size; offset += READ_CHUNK) {
    const buf = await source.read(path, offset, READ_CHUNK);
    for (let o = 0; o + SOURCE_PACKET_SIZE <= buf.length; o += SOURCE_PACKET_SIZE) {
      const packet = parseSourcePacket(buf, o);
      if (!packet || !pids.has(packet.pid)) continue;
      pkt = (offset + o) / SOURCE_PACKET_SIZE;
      assembler.push(packet);
    }
  }
  assembler.flush();
  return units;
}

/** _preload_m2ts for an IG sub-path, as Player.preloadSubPathIg. */
async function preloadSubPathIg(source: ByteSource, clipId: string): Promise<IgUnit[]> {
  const reader = new M2tsReader({ source, path: streamPath(clipId), startSpn: 0, pids: IG_PIDS });
  const units: IgUnit[] = [];
  for (let pes = await reader.next(); pes !== null; pes = await reader.next()) {
    for (const p of pes) units.push({ pid: p.pid, data: p.payload, ptsUs: pts90ToUs(p.pts ?? 0), dtsUs: p.dts === undefined ? undefined : pts90ToUs(p.dts) });
  }
  return units;
}

/** bd_event_e BLURAY_UO_* bits of libbluray's _compressed_mask (playFirstPlay and pauseOff have none). */
const UO_BIT: Partial<Record<UoOp, number>> = {
  menuCall: 0x1, titleSearch: 0x2, chapterSearch: 0x4, timeSearch: 0x8, skipToNextPoint: 0x10, skipBackToPreviousPoint: 0x20,
  stop: 0x40, pauseOn: 0x80, stillOff: 0x100, forwardPlay: 0x200, backwardPlay: 0x400, resume: 0x800,
  moveUp: 0x1000, moveDown: 0x2000, moveLeft: 0x4000, moveRight: 0x8000, select: 0x10000, activate: 0x20000,
  selectAndActivate: 0x40000, primaryAudioChange: 0x80000, angleChange: 0x100000, popupOn: 0x200000, popupOff: 0x400000,
  pgEnableDisable: 0x800000, pgChange: 0x1000000, secondaryVideoEnableDisable: 0x2000000, secondaryVideoChange: 0x4000000,
  secondaryAudioEnableDisable: 0x8000000, secondaryAudioChange: 0x10000000, pipPgChange: 0x20000000,
};

function compressedMask(mask: UoMask): number {
  let value = 0;
  for (const op of mask) value |= UO_BIT[op] ?? 0;
  return value >>> 0;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Simulated player, positioned in source packets like libbluray's read loop: a read takes the rest of the current 6144-byte
 * aligned unit of the play item's clip, seeks land on the EP map entry at or before the target (clpi_lookup_spn), and
 * every play item starts at packet 0 (true of disc-vm: first item and seamless connections, see _fill_clip). The Navigator
 * hears about play items, play marks and the end of the playlist as the position crosses them.
 */
class SimPort implements PlaybackPort {
  navigator!: Navigator;
  pg!: PgStreamControl;
  held = false;
  private mpls: Mpls | null = null;
  private clips: ReadonlyMap<string, Clpi> = new Map();
  private item = 0;
  /** Byte position in the current play item's clip (clip_pos). */
  private bytes = 0;
  private ended = false;
  /** libbluray's next_mark: the first play mark after the position, -1 when none is left. */
  private nextMark = -1;

  /** Main-path IG and PG units of each clip, by completing packet. */
  mainIg: ReadonlyMap<string, readonly MainIgUnit[]> = new Map();
  mainPg: ReadonlyMap<string, readonly MainIgUnit[]> = new Map();

  constructor(private readonly disc: DiscModel, private readonly regs: RegisterFile, private readonly onHold: (on: boolean) => void) {}

  setClips(clips: ReadonlyMap<string, Clpi>): void {
    this.clips = clips;
  }

  /** A playlist is open and has not reached its end. */
  get active(): boolean {
    return this.mpls !== null && !this.ended;
  }

  playPlaylist(id: string, at: PlayAt): Promise<boolean> {
    const mpls = this.disc.playlists.get(id);
    if (!mpls) return Promise.resolve(false);
    this.mpls = mpls;
    this.ended = false;
    this.held = false;
    let item = 0;
    let pkt = 0;
    if (at.mark !== undefined && mpls.marks[at.mark]) {
      const mark = mpls.marks[at.mark]!;
      item = mark.playItemRef;
      pkt = this.lookupPkt(item, mark.time);
    } else if (at.item !== undefined && at.item < mpls.playItems.length) {
      item = at.item;
    }
    if (at.clipTime45 !== undefined && mpls.playItems[item] && at.clipTime45 < mpls.playItems[item]!.outTime) pkt = this.lookupPkt(item, at.clipTime45);
    this.item = item;
    this.bytes = pkt * 192;
    this.findNextMark();
    this.navigator.playlistStarted(id, item); // synchronously, as the real player does
    this.pg.playItemStarted(mpls.playItems[item]!, false); // _open_m2ts: _update_clip_psrs, then _init_pg_stream
    return Promise.resolve(true);
  }

  seekPlayItem(item: number): void {
    if (!this.mpls || item >= this.mpls.playItems.length) return;
    this.moveTo(item, 0, true);
  }

  seekMark(mark: number): void {
    const m = this.mpls?.marks[mark];
    if (this.mpls && m) this.moveTo(m.playItemRef, this.lookupPkt(m.playItemRef, m.time), true);
  }

  stopPlaylist(): void {
    this.mpls = null;
  }

  hold(on: boolean): void {
    this.held = on;
    this.onHold(on);
  }

  /** _update_time_psr_from_stream: nav_clip_packet_search at the read position. */
  currentClipTime45(): number | undefined {
    const pi = this.mpls?.playItems[this.item];
    if (!pi) return undefined;
    const pkt = Math.floor(this.bytes / 192);
    const eps = this.epEntries(this.item);
    let time = 0;
    for (const e of eps) if (e.spn <= pkt) time = e.pts;
    return time !== 0 && time < pi.inTime ? pi.inTime : time; // the EP map does not store the low 8 bits
  }

  /** One bd_read_ext() worth of stream data (_bd_read). */
  read(): void {
    const mpls = this.mpls;
    if (!mpls || this.ended || this.held) return;
    if (this.bytes >= this.clipBytes(this.item)) {
      // the clip is used up: still, next play item, or the end of the title
      if (this.item >= mpls.playItems.length - 1) {
        this.ended = true;
        this.navigator.playlistEnded();
        return;
      }
      this.navigator.playItemEnded(this.item);
      if (this.held || this.mpls !== mpls || this.ended) return;
      this.moveTo(this.item + 1, 0, false);
    }
    this.deliverIg();
    this.deliverPg();
    this.bytes = Math.min(this.clipBytes(this.item), (Math.floor(this.bytes / READ_SIZE) + 1) * READ_SIZE);
    this.playmarkReached();
  }

  /**
   * _read_block reads the whole aligned unit around the position and gc_decode_ts demuxes all of it: the IG PES units of
   * the PID PSR0 names (st0.ig_pid, main path only) that complete in this unit go to the navigator.
   */
  private deliverIg(): void {
    const pi = this.mpls!.playItems[this.item]!;
    const stream = this.regs.psrRead(PSR.IG_STREAM_ID);
    const entry = stream > 0 ? pi.stn.ig[stream - 1] : undefined;
    if (!entry || entry.streamType === 2) return;
    const first = Math.floor(this.bytes / READ_SIZE) * PACKETS_PER_ALIGNED_UNIT;
    const end = first + PACKETS_PER_ALIGNED_UNIT;
    let pushed = false;
    for (const u of this.mainIg.get(pi.clipId) ?? []) {
      if (u.endPkt >= first && u.endPkt < end && u.unit.pid === entry.pid) {
        this.navigator.pushIg(u.unit);
        pushed = true;
      }
    }
    if (pushed) this.navigator.tick(Number.MAX_SAFE_INTEGER); // decoded (and INIT_MENU run) inside the read, before play marks
  }

  /** The PG PES units of st0.pg_pid that complete in this aligned unit: decoded and rendered inside the read (stc -1). */
  private deliverPg(): void {
    const pid = this.pg.pid;
    if (pid === null) return;
    const pi = this.mpls!.playItems[this.item]!;
    const first = Math.floor(this.bytes / READ_SIZE) * PACKETS_PER_ALIGNED_UNIT;
    const end = first + PACKETS_PER_ALIGNED_UNIT;
    for (const u of this.mainPg.get(pi.clipId) ?? []) {
      if (u.endPkt >= first && u.endPkt < end && u.unit.pid === pid) {
        this.pg.push(u.unit);
        this.pg.tick(Number.MAX_SAFE_INTEGER);
      }
    }
  }

  private epEntries(item: number): readonly { pts: number; spn: number }[] {
    return this.clips.get(this.mpls!.playItems[item]!.clipId)?.epMaps[0]?.entries ?? [];
  }

  /** clpi_lookup_spn(before): the packet of the last EP map entry at or before `time45`. */
  private lookupPkt(item: number, time45: number): number {
    let pkt = 0;
    for (const e of this.epEntries(item)) if (e.pts <= time45) pkt = e.spn;
    return pkt;
  }

  private clipBytes(item: number): number {
    const clip = this.clips.get(this.mpls!.playItems[item]!.clipId);
    return (clip?.numSourcePackets ?? 0) * 192;
  }

  /** Byte position in the whole playlist (s_pos). */
  private position(): number {
    let pos = this.bytes;
    for (let i = 0; i < this.item; i++) pos += this.clipBytes(i);
    return pos;
  }

  private markPosition(index: number): number {
    const m = this.mpls!.marks[index]!;
    let pos = this.lookupPkt(m.playItemRef, m.time) * 192;
    for (let i = 0; i < m.playItemRef; i++) pos += this.clipBytes(i);
    return pos;
  }

  /** _find_next_playmark (the chapter PSR part is the Navigator's). */
  private findNextMark(): void {
    const here = this.position();
    this.nextMark = -1;
    for (let i = 0; i < this.mpls!.marks.length; i++) {
      if (this.markPosition(i) > here) {
        this.nextMark = i;
        break;
      }
    }
  }

  /** _playmark_reached: marks the position has passed, one chapter update for all of them. */
  private playmarkReached(): void {
    const here = this.position();
    let reached = -1;
    while (this.nextMark >= 0 && here > this.markPosition(this.nextMark)) {
      reached = this.nextMark;
      this.nextMark = this.nextMark + 1 < this.mpls!.marks.length ? this.nextMark + 1 : -1;
    }
    if (reached >= 0) this.navigator.markReached(this.item, Math.floor(this.bytes / 192));
  }

  /** `seek`: _seek_internal (restarts mark tracking); otherwise the next clip is simply opened. */
  private moveTo(item: number, pkt: number, seek: boolean): void {
    const changed = item !== this.item;
    this.item = item;
    this.bytes = pkt * 192;
    if (seek) {
      this.findNextMark();
      this.navigator.seekGraphics();
      this.pg.seek(); // GC_CTRL_PG_RESET in _seek_internal
    }
    if (changed) {
      this.navigator.playItemChanged(item);
      this.pg.playItemStarted(this.mpls!.playItems[item]!, false);
    }
  }
}

/** Runs the disc in `discDir` (a BDMV folder tree) through our Navigator, driven by a trace script. */
export interface ReplayOptions {
  /** Receives a description of every IG menu the replay reads (main-path clips up front, sub-path clips as they preload). */
  readonly dumpPages?: (text: string) => void;
}

export async function replay(discDir: URL, scriptText: string, opts: ReplayOptions = {}): Promise<TraceEntry[]> {
  const steps = parseScript(scriptText);
  const source = new FileSource(normalizeDiscPaths(await directoryEntries(fileURLToPath(discDir))));
  const disc = await openDisc(source);
  const clipIds = [...new Set([...disc.playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)))];
  const clips = await loadClips(source, clipIds);
  const mainIg = new Map<string, MainIgUnit[]>();
  for (const pl of disc.playlists.values()) {
    for (const pi of pl.playItems) {
      if (mainIg.has(pi.clipId) || !pi.stn.ig.some((e) => e.streamType !== 2)) continue;
      const units = await scanMainGraphics(source, pi.clipId, IG_PIDS);
      mainIg.set(pi.clipId, units);
      opts.dumpPages?.(`clip ${pi.clipId} (main path):\n${dumpIgPages(units.map((u) => u.unit))}`);
    }
  }

  const mainPg = new Map<string, MainIgUnit[]>();
  for (const pl of disc.playlists.values()) {
    for (const pi of pl.playItems) {
      if (!mainPg.has(pi.clipId) && pi.stn.pg.some((e) => e.streamType !== 2)) mainPg.set(pi.clipId, await scanMainGraphics(source, pi.clipId, PG_PIDS));
    }
  }

  const trace: TraceEntry[] = [];
  const regs = new RegisterFile();
  let lastPage = -1;
  regs.onWrite = (w): void => {
    if (w.kind === 'psr' && w.index === PSR.MENU_PAGE_ID) lastPage = w.value;
    if (w.kind === 'psr' && w.index === PSR.TIME) return;
    trace.push({ k: w.kind, i: w.index, v: w.value });
  };

  // libbluray's _process_psr_event queues BD_EVENT_TITLE/PLAYLIST/PLAYITEM/CHAPTER from PSR writes, inside the dispatch
  // and so before the register write itself is logged. Registered before the Navigator, as libbluray's callback is.
  let lastTitle = -1;
  let lastPlaylist = -1;
  regs.onPsrEvent((e: PsrEvent) => {
    if (e.type === 'restore') {
      if (e.psr === PSR.TITLE_NUMBER) trace.push({ k: 'title', v: (lastTitle = e.newValue) });
      return;
    }
    if (e.type !== 'write' && e.type !== 'change') return;
    if (e.psr === PSR.TITLE_NUMBER) trace.push({ k: 'title', v: (lastTitle = e.newValue) });
    else if (e.psr === PSR.PLAYLIST) trace.push({ k: 'playlist', v: (lastPlaylist = e.newValue) });
    else if (e.psr === PSR.PLAYITEM) trace.push({ k: 'playitem', v: e.newValue });
    else if (e.psr === PSR.CHAPTER && e.type === 'change' && e.newValue !== NO_CHAPTER) trace.push({ k: 'chapter', v: e.newValue });
  });

  let menuOpen = false;
  let popupOpen = false;
  let errored = false;
  let scr = 0;
  let readsDone = 0;
  let readsBase = 0;
  const port = new SimPort(disc, regs, (on) => trace.push({ k: 'still', v: on ? 1 : 0 }));
  port.setClips(clips);
  port.mainIg = mainIg;
  port.mainPg = mainPg;
  const preloads = new Set<Promise<IgUnit[]>>();
  const emit = (e: NavigatorEvent): void => {
    switch (e.type) {
      case 'uoMask': trace.push({ k: 'uo', v: compressedMask(e.mask).toString(16) }); break;
      case 'menu': menuOpen = e.active; trace.push({ k: 'menu', v: e.active ? 1 : 0 }); break;
      case 'popup': popupOpen = e.available; trace.push({ k: 'popup', v: e.available ? 1 : 0 }); break;
      case 'sound': trace.push({ k: 'sound', v: e.id }); break;
      case 'seek': trace.push({ k: 'seek', what: e.what, v: e.value }); break;
      case 'error': errored = true; break;
      default: break; // title events come from the PSR listener above
    }
  };
  const navigator = new Navigator({ disc, regs, port, emit, nowScr: () => scr, seed: 1,
    preloadSubPathIg: (clipId) => {
      const load = preloadSubPathIg(source, clipId).then((units) => {
        opts.dumpPages?.(`clip ${clipId} (sub-path):\n${dumpIgPages(units)}`);
        return units;
      });
      preloads.add(load);
      return load;
    },
  });
  const emptyPlane = new OverlayPlane().hash();
  const planeHash = (): string => navigator.igPlane?.hash() ?? emptyPlane;
  port.navigator = navigator;
  // the pipeline restart a PID change asks for has no counterpart here: the next read already uses the new PID
  const pg = new PgStreamControl({ regs, isMasked: (op) => navigator.isMasked(op), pidChanged: () => undefined });
  port.pg = pg;

  /**
   * IG units reach the navigator only as they are read (stc = -1 in libbluray): no time gate beyond that. libbluray reads
   * a sub-path IG clip synchronously when the playlist opens (_preload_m2ts), so settling waits for preloads in flight.
   */
  const settle = async (): Promise<void> => {
    for (;;) {
      navigator.tick(Number.MAX_SAFE_INTEGER);
      pg.tick(Number.MAX_SAFE_INTEGER); // a PSR2 change (SET_STREAM) runs _init_pg_stream at once in libbluray
      await flush();
      if (preloads.size === 0) return;
      const pending = [...preloads];
      preloads.clear();
      await Promise.allSettled(pending);
      await flush(); // the deferred INIT_MENU may leave the VM runnable: tick again, as the harness polls until quiet
    }
  };
  /** bd_trace_finished: the program has ended and no playlist is playing. */
  const finished = (): boolean => !navigator.vmRunning && !port.active;
  const waitMet = (s: ScriptStep): boolean => {
    if (s.op !== 'wait') return true;
    switch (s.what) {
      case 'title': return lastTitle === s.n;
      case 'playlist': return lastPlaylist === s.n;
      case 'reads': return readsDone - readsBase >= s.n;
      case 'page': return lastPage === s.n;
      case 'menu': return menuOpen;
      case 'popup': return popupOpen;
      case 'end': return finished();
    }
  };
  const run = (s: ScriptStep): void => {
    switch (s.op) {
      case 'play': navigator.playTitle(s.title); break;
      case 'key': navigator.userInput(KEY_VK[s.key]); break;
      case 'mouse': navigator.mouseSelect(s.x, s.y); break;
      case 'subs': pg.select(s.what === 'off' ? 'off' : { pg: s.stream }); break;
      case 'click':
        navigator.mouseSelect(s.x, s.y);
        navigator.userInput(BdVk.MOUSE_ACTIVATE);
        break;
      default: break;
    }
  };

  // BLURAY_PLAYER_SETTING_DECODE_PG sets PSR2's display flag before the trace starts
  const onWrite = regs.onWrite;
  regs.onWrite = null;
  regs.psrWriteBits(PSR.PG_STREAM, 0x80000000, 0x80000000);
  regs.onWrite = onWrite;

  navigator.start();
  await flush();
  let idx = 0;
  let tail = 0;
  for (let reads = 0; reads < MAX_READS; reads++) {
    await settle();
    while (idx < steps.length && !errored && waitMet(steps[idx]!)) {
      run(steps[idx]!);
      await settle();
      trace.push({ k: 'step', n: idx, plane: planeHash(), pg: pg.plane.hash() });
      readsBase = readsDone;
      idx++;
    }
    if (errored) {
      trace.push({ k: 'end', why: 'error' });
      return trace;
    }
    if (idx === steps.length && (finished() || tail++ >= TAIL_READS)) {
      trace.push({ k: 'end', why: 'eof' });
      return trace;
    }
    scr += SCR_PER_READ;
    port.read();
    readsDone++;
    await flush();
  }
  trace.push({ k: 'end', why: 'limit' });
  return trace;
}
