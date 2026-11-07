import { describe, expect, it } from 'vitest';
import { buildMpls } from '../../../tests/helpers/bdmv-builders';
import { clearSegments, endSegment, pcsSegment, pdsSegment, odsSegment, subtitleSegments, wdsSegment } from '../../../tests/helpers/pg-builders';
import { parseMpls, type PlayItem } from '@seikou/bdmv/mpls-parser';
import type { UoOp } from '../hdmv/uo-mask';
import { PSR, RegisterFile } from '../hdmv/registers';
import { OverlayPlane } from '../graphics/overlay-plane';
import { PgStreamControl } from './subtitles';

const PG_CODING = 0x90;
const EMPTY = new OverlayPlane(1920, 1080).hash();

function item(streams: Array<{ pid: number; lang: string; streamType?: number }> = [{ pid: 0x1200, lang: 'eng' }, { pid: 0x1201, lang: 'jpn' }]): PlayItem {
  const mpls = parseMpls(buildMpls({
    playItems: [{
      clipId: '00001', inTime: 0, outTime: 45_000 * 60,
      video: [{ pid: 0x1011, codingType: 0x1b }],
      pg: streams.map((s) => ({ pid: s.pid, codingType: PG_CODING, lang: s.lang, streamType: s.streamType, subPathId: 0, subClipId: 0 })),
    }],
  }));
  return mpls.playItems[0]!;
}

function setup(opts: { masked?: UoOp[]; lang?: string } = {}) {
  const regs = new RegisterFile();
  if (opts.lang) regs.psrSettingWrite(PSR.PG_AND_SUB_LANG, ((opts.lang.charCodeAt(0) << 16) | (opts.lang.charCodeAt(1) << 8) | opts.lang.charCodeAt(2)) >>> 0);
  const pids: Array<number | null> = [];
  const masked = new Set(opts.masked ?? []);
  const pg = new PgStreamControl({ regs, isMasked: (op) => masked.has(op), pidChanged: (pid) => pids.push(pid) });
  return { regs, pg, pids, masked };
}

function push(pg: PgStreamControl, segs: Uint8Array[], ptsUs: number, dtsUs?: number): void {
  for (const data of segs) pg.push({ data, ptsUs, ...(dtsUs !== undefined ? { dtsUs } : {}) });
}

/** Turns stream 1 on with the display flag, as a user pick would. */
function showStream1(regs: RegisterFile): void {
  regs.psrWrite(PSR.PG_STREAM, 0x80000001);
}

describe('PgStreamControl', () => {
  it('initialises PSR2 from the subtitle language when it owns the registers', () => {
    const jpn = setup({ lang: 'jpn' });
    jpn.pg.playItemStarted(item(), true);
    expect(jpn.pg.selection).toEqual({ stream: 2, display: true });
    expect(jpn.pg.pid).toBe(0x1201);

    const def = setup();
    def.pg.playItemStarted(item(), true);
    expect(def.pg.selection).toEqual({ stream: 1, display: false });
    expect(def.pg.pid).toBe(0x1200);
    expect(def.pg.tracks()).toEqual([{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }]);
  });

  it('renders a display set at its PTS and clears it with the next one', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    push(pg, subtitleSegments({}), 5_000_000);
    push(pg, clearSegments(1), 7_000_000);
    pg.tick(4_999_999);
    expect(pg.plane.hash()).toBe(EMPTY);
    expect(pg.shown).toBeNull();
    pg.tick(5_000_000);
    expect(pg.plane.hash()).not.toBe(EMPTY);
    expect(pg.shown).toEqual({ objectsShown: 1, forced: 0 });
    pg.tick(6_999_999);
    expect(pg.plane.hash()).not.toBe(EMPTY);
    pg.tick(7_000_000);
    expect(pg.plane.hash()).toBe(EMPTY);
    expect(pg.shown).toEqual({ objectsShown: 0, forced: 0 });
  });

  it('presents a display set at its PTS, not its DTS', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    push(pg, subtitleSegments({}), 5_000_000, 4_000_000);
    pg.tick(4_000_000);
    expect(pg.plane.hash()).toBe(EMPTY);
    pg.tick(5_000_000);
    expect(pg.plane.hash()).not.toBe(EMPTY);
  });

  it('clears at once on a seek and never shows what was queued before it', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    push(pg, subtitleSegments({ x: 10 }), 1_000_000);
    push(pg, subtitleSegments({ x: 500 }), 3_000_000);
    pg.tick(1_000_000);
    expect(pg.plane.hash()).not.toBe(EMPTY);
    pg.seek();
    expect(pg.plane.hash()).toBe(EMPTY);
    pg.tick(3_000_000);
    expect(pg.plane.hash()).toBe(EMPTY);
    push(pg, subtitleSegments({ x: 200 }), 20_000_000);
    pg.tick(20_000_000);
    expect(pg.plane.rgba({ x: 200, y: 900, w: 1, h: 1 })[3]).toBe(255);
  });

  it('switching streams resets the plane at once and asks for the new PID', () => {
    const { regs, pg, pids } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    push(pg, subtitleSegments({}), 1_000_000);
    pg.tick(1_000_000);
    expect(pg.plane.hash()).not.toBe(EMPTY);
    expect(pg.select({ pg: 2 })).toBe(true);
    expect(pg.plane.hash()).toBe(EMPTY);
    expect(pids).toEqual([0x1201]);
    expect(pg.pid).toBe(0x1201);
    expect(pg.selection).toEqual({ stream: 2, display: true });
    push(pg, subtitleSegments({ x: 300 }), 1_000_000);
    pg.tick(1_100_000);
    expect(pg.plane.rgba({ x: 300, y: 900, w: 1, h: 1 })[3]).toBe(255);
  });

  it('off keeps the stream and shows only forced objects', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    expect(pg.select('off')).toBe(true);
    expect(pg.selection).toEqual({ stream: 1, display: false });
    push(pg, subtitleSegments({ x: 10 }), 1_000_000);
    pg.tick(1_000_000);
    expect(pg.plane.hash()).toBe(EMPTY);
    push(pg, subtitleSegments({ x: 20, forced: true }), 2_000_000);
    pg.tick(2_000_000);
    expect(pg.plane.rgba({ x: 20, y: 900, w: 1, h: 1 })[3]).toBe(255);
    expect(pg.shown).toEqual({ objectsShown: 1, forced: 1 });
  });

  it('turning the display off keeps display sets already queued, so a forced caption read ahead still shows', () => {
    const { regs, pg, pids } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    push(pg, subtitleSegments({ x: 10 }), 1_000_000);
    push(pg, subtitleSegments({ x: 20, forced: true }), 3_000_000);
    pg.tick(1_000_000);
    expect(pg.plane.rgba({ x: 10, y: 900, w: 1, h: 1 })[3]).toBe(255);
    expect(pg.select('off')).toBe(true);
    expect(pg.plane.hash()).toBe(EMPTY);
    expect(pids).toEqual([]); // same PID, nothing more to show now: no restart
    pg.tick(3_000_000);
    expect(pg.plane.rgba({ x: 20, y: 900, w: 1, h: 1 })[3]).toBe(255);
  });

  it('refuses masked changes and leaves PSR2 alone', () => {
    const { regs, pg, masked } = setup({ masked: ['pgChange'] });
    showStream1(regs);
    pg.playItemStarted(item(), false);
    expect(pg.select({ pg: 2 })).toBe(false);
    expect(regs.psrRead(PSR.PG_STREAM)).toBe(0x80000001);
    masked.clear();
    masked.add('pgEnableDisable');
    expect(pg.select('off')).toBe(false);
    expect(regs.psrRead(PSR.PG_STREAM)).toBe(0x80000001);
    expect(pg.select({ pg: 3 })).toBe(false); // no such stream
    expect(pg.select({ pg: 0 })).toBe(false);
  });

  it('keeps at most 64 completed display sets', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    for (let i = 0; i < 70; i++) push(pg, subtitleSegments({ x: 10 * i, w: 4, h: 2 }), 1_000_000 + i * 1000);
    pg.tick(2_000_000);
    expect(pg.plane.rgba({ x: 690, y: 900, w: 1, h: 1 })[3]).toBe(255);
    // each set clears the one before it, so only the newest is visible
    expect(pg.plane.rgba({ x: 680, y: 900, w: 1, h: 1 })[3]).toBe(0);
    expect(pg.queued).toBe(0);
    for (let i = 0; i < 70; i++) push(pg, subtitleSegments({ x: 10 * i, w: 4, h: 2 }), 5_000_000 + i * 1000);
    expect(pg.queued).toBe(64);
  });

  it('a PSR2 write by the disc program resets and asks for the new PID', () => {
    const { regs, pg, pids } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    push(pg, subtitleSegments({}), 1_000_000);
    pg.tick(1_000_000);
    regs.psrWrite(PSR.PG_STREAM, 0x80000002); // SET_STREAM
    pg.tick(1_010_000);
    expect(pg.plane.hash()).toBe(EMPTY);
    expect(pids).toEqual([0x1201]);
  });

  it('a play item start does not ask for a PID restart', () => {
    const { regs, pg, pids } = setup();
    pg.playItemStarted(item(), true);
    regs.psrWrite(PSR.PG_STREAM, 0x80000002); // the navigator's _update_clip_psrs before the next item opens
    pg.playItemStarted(item(), false);
    pg.tick(0);
    expect(pids).toEqual([]);
    expect(pg.pid).toBe(0x1201);
  });

  it('refuses a selection as a whole when any part of it is masked', () => {
    const { regs, pg } = setup({ masked: ['pgChange'] });
    pg.playItemStarted(item(), true); // stream 1, display off
    expect(pg.select({ pg: 2 })).toBe(false); // would turn the display on (allowed) and change the stream (masked)
    expect(regs.psrRead(PSR.PG_STREAM) & 0x80000fff).toBe(1);
  });

  it('keeps the previous play item\'s queued display sets until presentation reaches the next item', () => {
    const { regs, pg, pids } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false, 0);
    push(pg, subtitleSegments({ x: 10 }), 1_000_000);
    pg.playItemStarted(item(), false, 2_000_000); // the reader opened the next item while 1 s is still ahead
    push(pg, subtitleSegments({ x: 300 }), 2_500_000);
    pg.tick(1_000_000);
    expect(pg.plane.rgba({ x: 10, y: 900, w: 1, h: 1 })[3]).toBe(255);
    pg.tick(2_000_000);
    expect(pg.plane.hash()).toBe(EMPTY); // _init_pg_stream at the item change
    pg.tick(2_500_000);
    expect(pg.plane.rgba({ x: 300, y: 900, w: 1, h: 1 })[3]).toBe(255);
    expect(pids).toEqual([]);
  });

  it('keeps a subtitle on screen until presentation reaches the next play item, even with nothing queued', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false, 0);
    push(pg, subtitleSegments({ x: 10 }), 1_000_000); // its clear set lies past OUT (dropped) or in the next clip
    pg.tick(1_000_000);
    pg.playItemStarted(item(), false, 2_000_000); // the reader opens the next item 1 s ahead, queue empty
    pg.tick(1_500_000);
    expect(pg.plane.rgba({ x: 10, y: 900, w: 1, h: 1 })[3]).toBe(255);
    pg.tick(2_000_000);
    expect(pg.plane.hash()).toBe(EMPTY);
  });

  it('resets at each of two play item boundaries that the reader passes within its read-ahead', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false, 0);
    push(pg, subtitleSegments({ x: 10 }), 1_000_000); // item A: on screen up to its end at 2 s
    pg.tick(1_000_000);
    pg.playItemStarted(item(), false, 2_000_000); // a short item B
    push(pg, subtitleSegments({ x: 300 }), 2_500_000);
    pg.playItemStarted(item(), false, 3_000_000); // item C, read before presentation reaches B
    pg.tick(2_000_000);
    expect(pg.plane.hash()).toBe(EMPTY); // A's subtitle ends with A
    pg.tick(2_500_000);
    expect(pg.plane.rgba({ x: 300, y: 900, w: 1, h: 1 })[3]).toBe(255);
    pg.tick(3_000_000);
    expect(pg.plane.hash()).toBe(EMPTY); // and B's with B
  });

  it('after a seek starts the item at the target, a subtitle due at the target still shows', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false, 0);
    push(pg, subtitleSegments({ x: 10 }), 1_000_000);
    pg.tick(1_000_000);
    pg.seek();
    pg.playItemStarted(item(), false, 5_500_000); // the read starts at the keyframe before 5.5 s
    push(pg, subtitleSegments({ x: 40 }), 5_200_000);
    pg.tick(5_500_000);
    expect(pg.plane.rgba({ x: 40, y: 900, w: 1, h: 1 })[3]).toBe(255);
  });

  it('gives no PID for a sub-path stream', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item([{ pid: 0x1200, lang: 'eng', streamType: 2 }]), false);
    expect(pg.pid).toBeNull();
  });

  it('counts corrupt segments and stop closes the plane', () => {
    const { regs, pg } = setup();
    showStream1(regs);
    pg.playItemStarted(item(), false);
    const bad = [
      pcsSegment({ compositionState: 'epochStart', paletteId: 0, objects: [{ objectId: 0, windowId: 0, x: 0, y: 0 }] }).subarray(0, 12),
      wdsSegment([]), pdsSegment(0, 0, []), ...odsSegment(0, 0, 2, 2, [[1, 1], [1, 1]]), endSegment(),
    ];
    push(pg, bad, 1000);
    expect(pg.errors).toBe(1);
    push(pg, subtitleSegments({}), 2000);
    pg.tick(2000);
    expect(pg.plane.hash()).not.toBe(EMPTY);
    pg.stop();
    expect(pg.plane.hash()).toBe(EMPTY);
    expect(pg.pid).toBeNull();
  });
});
