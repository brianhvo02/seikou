import { describe, expect, it, vi } from 'vitest';
import { buildIndex, buildMpls, type IndexObjectSpec, type MarkSpec, type PlayItemSpec, type SubPathSpec } from '../../../../tests/helpers/bdmv-builders';
import { asm, buildMovieObjects, imm, reg } from '../../../../tests/helpers/hdmv-builders';
import { endSegment, icsSegment, odsSegment, pdsSegment, simpleMenuSegments } from '../../../../tests/helpers/ig-builders';
import type { Clpi } from '@seikou/bdmv/clpi-parser';
import { parseIndex } from '@seikou/bdmv/index-parser';
import { parseMovieObjects } from '@seikou/bdmv/mobj-parser';
import { parseMpls, type Mpls } from '@seikou/bdmv/mpls-parser';
import type { DiscModel } from '../disc/open-disc';
import { PSR, RegisterFile } from '../hdmv/registers';
import { BdVk } from '../graphics/graphics-controller';
import { HdmvEventType } from '../hdmv/vm';
import { Navigator, type IgUnit, type NavigatorDeps, type NavigatorEvent, type PlaybackPort, type PlayAt } from './navigator';

class FakePort implements PlaybackPort {
  calls: string[] = [];
  missing = new Set<string>();
  lastAt: PlayAt | null = null;
  clipTime: number | undefined;
  /** R8 contract: the port reports playlistStarted from inside playPlaylist. */
  onOpen: ((id: string, at: PlayAt) => void) | null = null;
  async playPlaylist(id: string, at: PlayAt) {
    this.calls.push(`play ${id} ${at.item ?? '-'} ${at.mark ?? '-'}`);
    this.lastAt = at;
    if (this.missing.has(id)) return false;
    this.onOpen?.(id, at);
    return true;
  }
  currentClipTime45() { return this.clipTime; }
  seekPlayItem(i: number) { this.calls.push(`item ${i}`); }
  seekMark(m: number) { this.calls.push(`mark ${m}`); }
  stopPlaylist() { this.calls.push('stop'); }
  hold(on: boolean) { this.calls.push(`hold ${on}`); }
}

interface ObjectSpec { cmds: Uint8Array[]; resumeIntention?: boolean; menuCallMask?: boolean; titleSearchMask?: boolean }
interface PlaylistSpec { items: PlayItemSpec[]; uoMask?: number[]; marks?: MarkSpec[]; subPaths?: SubPathSpec[] }

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const item = (extra: Partial<PlayItemSpec> = {}): PlayItemSpec => ({ clipId: '00001', inTime: 0, outTime: 90000, ...extra });
const idle: ObjectSpec = { cmds: [] };

/** A clip with an EP map entry every 45000 ticks from `inTime` (packet 6 + 100 per entry) and 100 packets after the last. */
function fakeClip(inTime: number, outTime: number): Clpi {
  const entries = [];
  for (let k = 0; inTime + k * 45000 <= outTime; k++) entries.push({ pts: inTime + k * 45000, spn: 6 + k * 100 });
  return { version: '0200', numSourcePackets: 6 + entries.length * 100, recordingRate: 0, atcSequences: [], programs: [], epMaps: [{ pid: 0x1011, epStreamType: 1, entries }] };
}

function setup(opts: {
  objects: ObjectSpec[];
  titles?: IndexObjectSpec[];
  firstPlay?: IndexObjectSpec;
  playlists?: Record<string, PlaylistSpec>;
  preloadSubPathIg?: NavigatorDeps['preloadSubPathIg'];
}) {
  const index = parseIndex(buildIndex({
    firstPlay: opts.firstPlay ?? { kind: 'hdmv', movieObjectId: 0 },
    topMenu: { kind: 'hdmv', movieObjectId: 1 },
    titles: opts.titles ?? [{ kind: 'hdmv', movieObjectId: 2 }, { kind: 'hdmv', movieObjectId: 3 }],
  }));
  const playlists = new Map<string, Mpls>();
  for (const [id, p] of Object.entries(opts.playlists ?? { '00000': { items: [item()] }, '00001': { items: [item()] } })) {
    playlists.set(id, parseMpls(buildMpls({ playItems: p.items, uoMask: p.uoMask, marks: p.marks, subPaths: p.subPaths })));
  }
  const clips = new Map<string, Clpi>();
  for (const p of Object.values(opts.playlists ?? { a: { items: [item()] } })) {
    for (const i of p.items) {
      const old = clips.get(i.clipId);
      clips.set(i.clipId, fakeClip(Math.min(i.inTime, old?.epMaps[0]?.entries[0]?.pts ?? i.inTime), Math.max(i.outTime, old ? old.epMaps[0]!.entries.at(-1)!.pts : i.outTime)));
    }
  }
  const disc = { index, playlists, clips, movieObjects: parseMovieObjects(buildMovieObjects(opts.objects)) } as unknown as DiscModel;
  const port = new FakePort();
  const regs = new RegisterFile();
  const events: NavigatorEvent[] = [];
  const clock = { scr: 0 };
  const nav = new Navigator({ disc, regs, port, emit: (e) => events.push(e), nowScr: () => clock.scr, seed: 1, preloadSubPathIg: opts.preloadSubPathIg });
  return { nav, port, regs, events, clock };
}

describe('Navigator titles', () => {
  it('start() runs First Play and sets PSR4 to 0xffff', () => {
    const { nav, port, regs } = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }] });
    nav.start();
    expect(port.calls).toEqual(['play 00000 - -']);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(0xffff);
  });

  it('jumps to a title and plays a playlist at a mark', () => {
    const { nav, port, regs, events } = setup({
      objects: [{ cmds: [asm.jumpTitle(imm(1))] }, idle, { cmds: [asm.playPlPm(imm(0), imm(1))] }, idle],
    });
    nav.start();
    expect(port.calls).toEqual(['play 00000 - 1']);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(1);
    expect(events).toContainEqual({ type: 'title', title: 1 });
  });

  it('plays a playlist at a play item', () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPlPi(imm(1), imm(0))] }] });
    nav.start();
    expect(port.calls).toEqual(['play 00001 0 -']);
  });

  it('reports a BD-J title and does not run the VM', () => {
    const { nav, port, events, regs } = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], firstPlay: { kind: 'bdj', name: '00000' } });
    nav.start();
    expect(events).toEqual([{ type: 'bdjTitle', title: 0xffff }]);
    expect(nav.vmRunning).toBe(false);
    expect(port.calls).toEqual([]);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(0xffff);
  });

  it('reports an error when First Play points at a missing movie object', () => {
    const { nav, events } = setup({ objects: [idle], firstPlay: { kind: 'hdmv', movieObjectId: 9 } });
    nav.start();
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('playTitle() refuses before start() and plays titles afterwards', () => {
    const { nav, port } = setup({ objects: [idle, idle, { cmds: [asm.playPl(imm(1))] }, idle] });
    expect(nav.playTitle(1)).toBe(false);
    nav.start();
    expect(nav.playTitle(1)).toBe(true);
    expect(port.calls).toEqual(['play 00001 - -']);
    expect(nav.playTitle(7)).toBe(false);
  });

  it('refuses a title search when the playing object masks it', () => {
    const { nav, port } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], titleSearchMask: true }, idle, { cmds: [asm.playPl(imm(1))] }, idle],
    });
    nav.start();
    expect(nav.isMasked('titleSearch')).toBe(true);
    expect(nav.playTitle(1)).toBe(false);
    expect(port.calls).toEqual(['play 00000 - -']);
  });
});

describe('Navigator startTitle (after a raw playlist pick stopped it)', () => {
  it('starts a title without running First Play', async () => {
    const { nav, port, events } = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.playPl(imm(1))] }, idle] });
    expect(nav.startTitle(1)).toBe(true);
    await flush();
    expect(port.calls).toEqual(['play 00001 - -']);
    expect(events).toContainEqual({ type: 'title', title: 1 });
  });

  it('starts the top menu for title 0', async () => {
    const { nav, port } = setup({ objects: [idle, { cmds: [asm.playPl(imm(1))] }, idle, idle] });
    expect(nav.startTitle(0)).toBe(true);
    await flush();
    expect(port.calls).toEqual(['play 00001 - -']);
  });

  it('refuses a title that does not exist', () => {
    const { nav } = setup({ objects: [idle, idle, idle, idle] });
    expect(nav.startTitle(9)).toBe(false);
  });
});

describe('Navigator resumeTitle', () => {
  it('resumes a title at a playlist and time, continuing its program after it', async () => {
    const { nav, port, regs, events } = setup({
      objects: [
        idle, idle,
        { cmds: [asm.playPl(imm(0)), asm.set('move', reg(3), imm(1)), asm.playPl(reg(3)), asm.playPl(imm(0))] },
        idle,
      ],
      playlists: { '00000': { items: [item()] }, '00001': { items: [item(), item()] } },
    });
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    regs.gprWrite(3, 1);
    expect(nav.resumeTitle(1, 1, { item: 1, clipTime45: 45000 })).toBe(true);
    await flush();
    expect(port.calls).toEqual(['play 00001 1 -']);
    expect(port.lastAt).toEqual({ item: 1, clipTime45: 45000 });
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(1);
    expect(events).toContainEqual({ type: 'title', title: 1 });
    nav.playlistEnded();
    await flush();
    expect(port.calls).toEqual(['play 00001 1 -', 'play 00000 - -']);
  });

  it('refuses a title that never plays that playlist', async () => {
    const { nav, port, regs, events } = setup({
      objects: [idle, idle, { cmds: [asm.playPl(imm(0)), asm.playPl(reg(3))] }, idle],
    });
    regs.gprWrite(3, 0);
    expect(nav.resumeTitle(1, 1, { item: 0, clipTime45: 0 })).toBe(false);
    expect(nav.resumeTitle(9, 1, { item: 0, clipTime45: 0 })).toBe(false);
    await flush();
    expect(port.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(0xffff);
  });
});

describe('Navigator playlists', () => {
  it('resumes the program at the end of the playlist', () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }] });
    nav.start();
    nav.playlistEnded();
    expect(port.calls).toEqual(['play 00000 - -', 'play 00001 - -']);
  });

  it('resumes the program after a missing playlist', async () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }] });
    port.missing = new Set(['00000']);
    nav.start();
    await flush();
    expect(port.calls).toEqual(['play 00000 - -', 'play 00001 - -']);
  });

  it('ignores the result of a playlist that was superseded', async () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }] });
    port.missing = new Set(['00000']);
    nav.start();
    nav.stop();
    await flush();
    expect(port.calls).toEqual(['play 00000 - -']);
  });

  it('stops the VM and reports an error when a program never settles', () => {
    const { nav, port, events } = setup({ objects: [{ cmds: [asm.jumpTitle(imm(1))] }, idle, { cmds: [asm.jumpTitle(imm(1))] }, idle] });
    nav.start();
    nav.tick(0);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(nav.vmRunning).toBe(false);
    const before = events.length;
    nav.tick(0);
    expect(events).toHaveLength(before);
    expect(port.calls).toEqual([]);
  }, 2000);
});

describe('Navigator menu call', () => {
  const objects = (menuCallMask: boolean): ObjectSpec[] => [
    { cmds: [asm.playPl(imm(0))], menuCallMask },
    { cmds: [asm.playPl(imm(1))] },
    idle,
    idle,
  ];

  it('is refused when the playing object masks menu call', () => {
    const { nav, port } = setup({ objects: objects(true) });
    nav.start();
    expect(nav.isMasked('menuCall')).toBe(true);
    expect(nav.menuCall()).toBe(false);
    expect(port.calls).toEqual(['play 00000 - -']);
  });

  it('runs the top menu otherwise, stopping the playlist first', () => {
    const { nav, port, regs } = setup({ objects: objects(false) });
    nav.start();
    expect(nav.menuCall()).toBe(true);
    expect(port.calls).toEqual(['play 00000 - -', 'stop', 'play 00001 - -']);
    expect(regs.psrRead(PSR.TITLE_NUMBER)).toBe(0);
  });

  it('is refused before start()', () => {
    const { nav } = setup({ objects: objects(false) });
    expect(nav.menuCall()).toBe(false);
  });

  it('returns to the interrupted program with RESUME, reopening the stored playlist and play item', async () => {
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0)), asm.nop()], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle],
      playlists: { '00000': { items: [item(), item()] }, '00001': { items: [item()] } },
    });
    nav.start();
    nav.playlistStarted('00000', 1);
    expect(regs.psrRead(PSR.PLAYITEM)).toBe(1);
    nav.menuCall();
    await flush();
    expect(port.calls).toEqual(['play 00000 - -', 'stop', 'play 00000 1 -']);
  });
});

describe('Navigator play item stills', () => {
  const stillDisc = (stillMode: number) => setup({
    objects: [{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }],
    playlists: { '00000': { items: [item({ stillMode, stillTime: 2 })] }, '00001': { items: [item()] } },
  });

  it('holds for the still time, then resumes the program', () => {
    const { nav, port, clock } = stillDisc(1);
    nav.start();
    nav.playlistStarted('00000', 0);
    nav.playlistEnded();
    expect(port.calls).toEqual(['play 00000 - -', 'hold true']);
    clock.scr = 2 * 90000 - 1;
    nav.tick(0);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true']);
    clock.scr = 2 * 90000;
    nav.tick(0);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true', 'hold false', 'play 00001 - -']);
  });

  it('holds an infinite still without resuming', () => {
    const { nav, port, clock } = stillDisc(2);
    nav.start();
    nav.playlistEnded();
    clock.scr = 1e9;
    nav.tick(0);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true']);
  });

  it('moves on to the next play item after a time still in the middle of a playlist', () => {
    const { nav, port, clock } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: { '00000': { items: [item({ stillMode: 1, stillTime: 1 }), item()] } },
    });
    nav.start();
    nav.playItemEnded(0);
    clock.scr = 90000;
    nav.tick(0);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true', 'hold false', 'item 1']);
  });

  it('releases the hold when the title changes', () => {
    const { nav, port } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }, idle, idle, idle],
      playlists: { '00000': { items: [item({ stillMode: 2 })] } },
    });
    nav.start();
    nav.playlistEnded();
    nav.playTitle(1);
    expect(port.calls).toEqual(['play 00000 - -', 'hold true', 'stop', 'hold false']);
  });
});

describe('Navigator UO masks and PSRs', () => {
  const timeSearch = [0x10, 0, 0, 0, 0, 0, 0, 0];
  const uoEvents = (events: NavigatorEvent[]) => events.filter((e) => e.type === 'uoMask');

  it('applies the playlist and play item masks once', () => {
    const { nav, events } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: { '00000': { items: [item({ uoMask: [0, 0, 0, 0, 0, 0, 0x40, 0] })], uoMask: timeSearch } },
    });
    nav.start();
    nav.playlistStarted('00000', 0);
    expect(nav.isMasked('timeSearch')).toBe(true);
    expect(uoEvents(events)).toHaveLength(1);
    nav.playlistStarted('00000', 0);
    expect(uoEvents(events)).toHaveLength(1);
  });

  it('clears the playlist mask when the playlist closes', () => {
    const { nav, events } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }, idle, idle, idle],
      playlists: { '00000': { items: [item()], uoMask: timeSearch } },
    });
    nav.start();
    nav.playlistStarted('00000', 0);
    nav.playTitle(1);
    expect(nav.uoMask.has('timeSearch')).toBe(false);
    expect(uoEvents(events)).toHaveLength(2);
  });

  it('updates the playlist and clip PSRs and selects streams by language', () => {
    const { nav, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: {
        '00000': {
          items: [item({
            inTime: 12345,
            audio: [{ pid: 0x1100, codingType: 0x80, lang: 'eng' }, { pid: 0x1101, codingType: 0x80, lang: 'jpn' }],
            pg: [{ pid: 0x1200, codingType: 0x90, lang: 'eng' }, { pid: 0x1201, codingType: 0x90, lang: 'jpn' }],
          })],
        },
      },
    });
    regs.psrSettingWrite(PSR.AUDIO_LANG, 0x6a706e); // jpn
    regs.psrSettingWrite(PSR.PG_AND_SUB_LANG, 0x656e67); // eng
    nav.start();
    nav.playlistStarted('00000', 0);
    expect(regs.psrRead(PSR.PLAYLIST)).toBe(0);
    expect(regs.psrRead(PSR.CHAPTER)).toBe(0xffff);
    expect(regs.psrRead(PSR.PLAYITEM)).toBe(0);
    expect(regs.psrRead(PSR.TIME)).toBe(12345);
    expect(regs.psrRead(PSR.PRIMARY_AUDIO_ID)).toBe(2);
    // preferred subtitle language eng exists and the audio is jpn, so subtitles are enabled
    expect(regs.psrRead(PSR.PG_STREAM)).toBe(0x8fff0001); // psr_write_bits keeps the bits outside 0x80000fff
  });

  it('writes the chapter PSR only for non-interactive titles', () => {
    const marks = [{ playItemRef: 0, time: 0 }, { playItemRef: 0, time: 45000 }];
    const run = (playbackType: number): number[] => {
      const { nav, regs } = setup({
        objects: [{ cmds: [asm.playPl(imm(0))] }],
        firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType },
        playlists: { '00000': { items: [item()], marks } },
      });
      const seen: number[] = [];
      regs.onWrite = (w) => { if (w.kind === 'psr' && w.index === PSR.CHAPTER) seen.push(w.value); };
      nav.start();
      nav.playlistStarted('00000', 0);
      nav.markReached(0, 120);
      return seen;
    };
    expect(run(0)).toEqual([0xffff, 1, 2]);
    expect(run(1)).toEqual([0xffff]);
  });

  it('follows libbluray for a start item: PSR5 after the first clip, again after the seek, and on every mark (LINK too)', () => {
    const marks = [
      { playItemRef: 0, time: 0 }, { playItemRef: 0, time: 45000, type: 2 },
      { playItemRef: 1, time: 0 }, { playItemRef: 1, time: 45000 },
    ];
    const { nav, regs, port } = setup({
      objects: [{ cmds: [asm.playPlPi(imm(0), imm(1)), asm.playPlPm(imm(0), imm(3))] }],
      firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: 0 },
      playlists: { '00000': { items: [item(), item()], marks } },
    });
    const writes: string[] = [];
    regs.onWrite = (w) => { if (w.kind === 'psr' && (w.index === PSR.CHAPTER || w.index === PSR.PLAYITEM)) writes.push(`${w.index}=${w.value}`); };
    port.onOpen = (id, at) => nav.playlistStarted(id, at.mark !== undefined ? 1 : at.item ?? 0);
    nav.start();
    expect(writes).toEqual(['5=65535', '7=0', '5=1', '7=1', '5=2']);
    nav.markReached(1, 50); // a LINK mark would do the same: PSR5 is written even when unchanged
    nav.markReached(1, 51);
    expect(writes.slice(5)).toEqual(['5=2', '5=2']);
  });

  it('compares packets: a start item with a seamless connection begins before the first EP entry, so the chapter at its start mark is not reached', () => {
    const marks = [{ playItemRef: 0, time: 0 }, { playItemRef: 1, time: 0 }];
    const run = (connectionCondition: number): number => {
      const { nav, regs, port } = setup({
        objects: [{ cmds: [asm.playPlPi(imm(0), imm(1))] }],
        firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: 0 },
        playlists: { '00000': { items: [item(), item({ connectionCondition })], marks } },
      });
      port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
      nav.start();
      return regs.psrRead(PSR.CHAPTER);
    };
    expect(run(5)).toBe(1); // start_pkt 0 < the mark's packet 6 (libbluray)
    expect(run(1)).toBe(2); // start_pkt = the EP entry at the item's IN time = the mark's packet
  });

  it('updates the chapter PSR after PLAY_PM and PLAY_PI within the playlist', async () => {
    // LINK_MK / LINK_PI only run in button objects (Task 12), so the VM events are injected
    const marks = [{ playItemRef: 0, time: 0 }, { playItemRef: 0, time: 45000 }, { playItemRef: 1, time: 0 }];
    const { nav, regs, port } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: 0 },
      playlists: { '00000': { items: [item(), item()], marks } },
    });
    port.onOpen = (id) => nav.playlistStarted(id, 0);
    nav.start();
    await flush();
    const seen: number[] = [];
    regs.onWrite = (w) => { if (w.kind === 'psr' && w.index === PSR.CHAPTER) seen.push(w.value); };
    const inject = (type: HdmvEventType, param: number): void =>
      (nav as unknown as { processHdmvVmEvent(e: { type: HdmvEventType; param: number; param2: number }): void }).processHdmvVmEvent({ type, param, param2: 0 });
    inject(HdmvEventType.PLAY_PM, 1);
    inject(HdmvEventType.PLAY_PI, 1);
    inject(HdmvEventType.PLAY_PM, 9); // out of range: libbluray's bd_seek_mark fails without touching anything
    expect(port.calls.slice(1)).toEqual(['mark 1', 'item 1', 'mark 9']);
    expect(seen).toEqual([2, 3]);
  });
});

describe('Navigator review fixes', () => {
  it('keeps the presentation time across menu call and resume', () => {
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle],
      playlists: { '00000': { items: [item({ inTime: 1000, outTime: 91000 })] } },
    });
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    expect(regs.psrRead(PSR.TIME)).toBe(1000);
    port.clipTime = 40000;
    nav.menuCall();
    expect(port.lastAt).toEqual({ item: 0, clipTime45: 40000 });
    expect(port.calls).toEqual(['play 00000 - -', 'stop', 'play 00000 0 -']);
    expect(regs.psrRead(PSR.TIME)).toBe(40000); // playlistStarted does not clobber the restored time
  });

  it('restores the time inside a later play item', () => {
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle],
      playlists: { '00000': { items: [item({ inTime: 1000, outTime: 91000 }), item({ inTime: 5000, outTime: 95000 })] } },
    });
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    nav.playItemChanged(1);
    port.clipTime = 60000;
    nav.menuCall();
    expect(port.lastAt).toEqual({ item: 1, clipTime45: 60000 });
    expect(regs.psrRead(PSR.PLAYITEM)).toBe(1);
    expect(regs.psrRead(PSR.TIME)).toBe(60000);
  });

  it('does not store a position outside the play item', () => {
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle],
      playlists: { '00000': { items: [item({ inTime: 1000, outTime: 91000 })] } },
    });
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    port.clipTime = 500;
    nav.menuCall();
    expect(port.lastAt?.clipTime45).toBe(1000);
    expect(regs.psrRead(PSR.TIME)).toBe(1000);
  });

  it('opens the first clip before moving to the requested play item', () => {
    const stream = (lang: string) => [{ pid: 0x1100, codingType: 0x80, lang }];
    const { nav, regs } = setup({
      objects: [{ cmds: [asm.playPlPi(imm(0), imm(1))] }],
      playlists: { '00000': { items: [item({ audio: stream('eng') }), item({ audio: [...stream('eng'), ...stream('jpn')] })] } },
    });
    const writes: string[] = [];
    regs.onWrite = (w) => { if (w.kind === 'psr') writes.push(`${w.index}=${w.value}`); };
    regs.psrSettingWrite(PSR.AUDIO_LANG, 0x6a706e); // jpn
    writes.length = 0;
    const port = (nav as unknown as { deps: { port: FakePort } }).deps.port;
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    const psr7 = writes.filter((w) => w.startsWith('7='));
    expect(psr7).toEqual(['7=0', '7=1']);
    // item 0 only has eng, so PSR1 = 1 there; item 1 keeps 1 (valid) as in _update_clip_psrs
    expect(regs.psrRead(PSR.PRIMARY_AUDIO_ID)).toBe(1);
    expect(writes.indexOf('1=1')).toBeGreaterThan(writes.indexOf('7=0'));
  });

  it('orders register writes and UO mask events as libbluray does', () => {
    const order: string[] = [];
    const { nav, port, regs } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))], menuCallMask: true }],
      playlists: { '00000': { items: [item()], uoMask: [0x10, 0, 0, 0, 0, 0, 0, 0] } },
    });
    regs.onWrite = (w) => { if (w.kind === 'psr') order.push(`psr${w.index}`); };
    (nav as unknown as { deps: { emit: (e: NavigatorEvent) => void } }).deps.emit = (e) => { if (e.type === 'uoMask') order.push(`uo:${[...e.mask].sort().join('+')}`); };
    port.onOpen = (id, at) => nav.playlistStarted(id, at.item ?? 0);
    nav.start();
    // The first _run_hdmv pass returns the pending PLAY_STOP and publishes the object's menu-call mask;
    // PLAY_PL then opens the playlist: playlist PSRs, play item UO mask, clip PSRs.
    expect(order).toEqual(['psr4', 'uo:menuCall', 'psr6', 'psr3', 'psr5', 'uo:menuCall+timeSearch', 'psr7', 'psr8']);
  });

  it('does not seek at every seamless item boundary', () => {
    const { nav, port } = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], playlists: { '00000': { items: [item(), item()] } } });
    nav.start();
    nav.playItemEnded(0);
    expect(port.calls).toEqual(['play 00000 - -']);
  });

  it('ignores a missing-playlist result after a title change', async () => {
    const { nav, port } = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.playPl(imm(1)), asm.playPl(imm(0))] }, idle],
    });
    port.missing = new Set(['00000']);
    nav.start();
    nav.playTitle(1);
    await flush();
    expect(port.calls).toEqual(['play 00000 - -', 'stop', 'play 00001 - -']);
  });
});

describe('Navigator interactive graphics', () => {
  const pushMenu = (nav: Navigator, ptsUs: number, opts: Parameters<typeof simpleMenuSegments>[0] = {}): void => {
    for (const data of simpleMenuSegments(opts)) nav.pushIg({ data, ptsUs });
  };
  const IG = { pid: 0x1400, codingType: 0x91 };
  async function menuSetup() {
    const t = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], playlists: { '00000': { items: [item({ ig: [IG] })] } } });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    t.nav.start();
    await flush();
    return t;
  }
  const menuEvents = (events: NavigatorEvent[]) => events.filter((e) => e.type === 'menu');

  it('holds a display set back until the clock reaches its PTS', async () => {
    const { nav, events } = await menuSetup();
    pushMenu(nav, 5_000_000);
    nav.tick(4_999_999);
    expect(nav.igPlane).toBeNull();
    expect(menuEvents(events)).toEqual([]);
    nav.tick(5_000_000);
    expect(nav.igPlane).not.toBeNull();
    expect(menuEvents(events)).toEqual([{ type: 'menu', active: true }]);
    expect(nav.takeDrawCount()).toBeGreaterThan(0);
  });

  it('keeps stream order and gates by DTS when the ICS is presented after its objects are decoded', async () => {
    const { nav, events } = await menuSetup();
    const segs = simpleMenuSegments();
    // ICS first in the stream, presented at 5 s but decoded at 0.9 s; the rest carry the earlier time
    segs.forEach((data, i) => nav.pushIg(i === 0 ? { data, ptsUs: 5_000_000, dtsUs: 900_000 } : { data, ptsUs: 900_000, dtsUs: 900_000 }));
    nav.tick(899_999);
    expect(menuEvents(events)).toEqual([]);
    nav.tick(900_000);
    expect(menuEvents(events)).toEqual([{ type: 'menu', active: true }]);
    expect(nav.takeDrawCount()).toBeGreaterThan(0);
    expect(nav.igErrors).toBe(0);
  });

  it('does not release a unit behind one that is not due', async () => {
    const { nav, events } = await menuSetup();
    const segs = simpleMenuSegments();
    nav.pushIg({ data: segs[0]!, ptsUs: 2_000_000, dtsUs: 2_000_000 });
    segs.slice(1).forEach((data) => nav.pushIg({ data, ptsUs: 0, dtsUs: 0 }));
    nav.tick(1_000_000);
    expect(menuEvents(events)).toEqual([]);
    nav.tick(2_000_000);
    expect(menuEvents(events)).toEqual([{ type: 'menu', active: true }]);
  });

  it('a seek drops queued and half-received sets but keeps the menu that is shown', async () => {
    const { nav, events } = await menuSetup();
    pushMenu(nav, 0);
    nav.tick(0);
    const plane = nav.igPlane!;
    const shown = plane.hash();
    nav.takeDrawCount();

    pushMenu(nav, 9_000_000); // old read position, not yet due
    nav.seekGraphics();
    nav.tick(10_000_000);
    expect(nav.takeDrawCount()).toBe(0);

    const [ics, ...rest] = simpleMenuSegments({ compositionState: 'normal' });
    nav.pushIg({ data: ics!, ptsUs: 10_000_000 });
    nav.tick(10_000_000); // the set is half received
    nav.seekGraphics();
    for (const data of rest) nav.pushIg({ data, ptsUs: 10_000_000 });
    nav.tick(10_000_000);
    expect(nav.takeDrawCount()).toBe(0);
    expect(menuEvents(events)).toEqual([{ type: 'menu', active: true }]);
    expect(plane.hash()).toBe(shown);
    expect(nav.uoMask).toBeDefined();
  });

  it('closing the playlist resets silently and waits for a new epoch start', async () => {
    const { nav, events } = await menuSetup();
    pushMenu(nav, 0);
    nav.tick(0);
    const plane = nav.igPlane!;
    const shown = plane.hash();
    nav.stop();
    expect(plane.hash()).not.toBe(shown);
    expect(menuEvents(events)).toEqual([{ type: 'menu', active: true }]); // _close_playlist sends no menu event

    nav.start();
    await flush();
    nav.takeDrawCount();
    pushMenu(nav, 0, { compositionState: 'normal' });
    nav.tick(0);
    expect(nav.takeDrawCount()).toBe(0);
    pushMenu(nav, 0);
    nav.tick(0);
    expect(menuEvents(events).at(-1)).toEqual({ type: 'menu', active: true });
    expect(plane.hash()).toBe(shown);
  });

  it('resizes the plane to the composition video size', async () => {
    const { nav } = await menuSetup();
    pushMenu(nav, 0, { width: 1280, height: 720 });
    nav.tick(0);
    expect(nav.igPlane).toMatchObject({ width: 1280, height: 720 });
  });

  it('ignores IG units without an open playlist and when the playlist has no IG stream', async () => {
    const t = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], playlists: { '00000': { items: [item()] } } });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    pushMenu(t.nav, 0); // nothing open yet
    t.nav.start();
    await flush();
    pushMenu(t.nav, 0);
    t.nav.tick(0);
    expect(t.nav.igPlane).toBeNull();
    expect(menuEvents(t.events)).toEqual([]);
  });

  it('clears the overlay and drops stale units when stopped', async () => {
    const { nav } = await menuSetup();
    pushMenu(nav, 0);
    nav.tick(0);
    const plane = nav.igPlane!;
    nav.stop();
    const cleared = plane.hash();
    pushMenu(nav, 0);
    nav.tick(0);
    expect(plane.hash()).toBe(cleared);
    expect(plane.hasContent).toBe(false);
  });
});

describe('Navigator user input', () => {
  const IG = { pid: 0x1400, codingType: 0x91 };
  /** First Play plays 00000, whose always-on menu has buttons 1 and 2 (button 1 selected); activating one sets GPR 5 to 42. */
  async function menuSetup() {
    const t = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }, idle], playlists: { '00000': { items: [item({ ig: [IG] })] } } });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    t.nav.start();
    await flush();
    for (const data of simpleMenuSegments({ cmds: [asm.set('move', reg(5), imm(42))] })) t.nav.pushIg({ data, ptsUs: 0 });
    t.nav.tick(0);
    return t;
  }

  /** The activated state is drawn first; its commands come with a later NOP and the VM runs them on the next _read_ext. */
  async function settle(nav: Navigator): Promise<void> {
    for (let i = 0; i < 3; i++) {
      nav.tick(0);
      await flush();
    }
  }

  it('moves the selection with arrow keys (bd_user_input -> GC_CTRL_VK_KEY)', async () => {
    const { nav, regs } = await menuSetup();
    expect(regs.psrRead(PSR.SELECTED_BUTTON_ID)).toBe(1);
    nav.userInput(BdVk.DOWN);
    expect(regs.psrRead(PSR.SELECTED_BUTTON_ID)).toBe(2);
    nav.userInput(BdVk.UP);
    expect(regs.psrRead(PSR.SELECTED_BUTTON_ID)).toBe(1);
  });

  it('runs the selected button commands on ENTER', async () => {
    const { nav, regs } = await menuSetup();
    nav.userInput(BdVk.ENTER);
    await settle(nav);
    expect(regs.gprRead(5)).toBe(42);
  });

  it('selects the button under the mouse and activates it with MOUSE_ACTIVATE', async () => {
    const { nav, regs } = await menuSetup();
    nav.mouseSelect(104, 202); // button 2: 8x4 at (100, 200)
    expect(regs.psrRead(PSR.SELECTED_BUTTON_ID)).toBe(2);
    nav.userInput(BdVk.MOUSE_ACTIVATE);
    await settle(nav);
    expect(regs.gprRead(5)).toBe(42);
  });

  it('treats ROOT_MENU as a menu call', async () => {
    const { nav, events } = await menuSetup();
    events.length = 0;
    nav.userInput(BdVk.ROOT_MENU);
    expect(events).toContainEqual({ type: 'title', title: 0 });
  });

  it('ignores input before start() without throwing', () => {
    const t = setup({ objects: [idle] });
    expect(t.nav.userInput(BdVk.ENTER)).toBe(-1);
    expect(t.nav.mouseSelect(10, 10)).toBe(-1);
  });
});

describe('Navigator IG menus in sub-paths', () => {
  const SUB_IG = { pid: 0x1400, codingType: 0x91, streamType: 2, subPathId: 0, subClipId: 0 };
  const subPaths: SubPathSpec[] = [{ type: 3, items: [{ clipId: '00002', inTime: 0, outTime: 90000 }] }];
  const menuUnits = (opts: Parameters<typeof simpleMenuSegments>[0] = {}): IgUnit[] =>
    simpleMenuSegments(opts).map((data) => ({ data, ptsUs: 9_000_000_000, pid: 0x1400 })); // far beyond the clock: no timing gate applies
  const flushAll = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const menuEvents = (events: NavigatorEvent[]) => events.filter((e) => e.type === 'menu');

  function subSetup(preload: NonNullable<NavigatorDeps['preloadSubPathIg']>, objects?: ObjectSpec[]) {
    const t = setup({
      objects: objects ?? [{ cmds: [asm.playPl(imm(0))] }],
      playlists: { '00000': { items: [item({ ig: [SUB_IG] })], subPaths } },
      preloadSubPathIg: preload,
    });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    return t;
  }

  it('preloads the sub-path clip at playlist open and boots into the menu without any tick', async () => {
    const calls: string[] = [];
    const t = subSetup(async (clipId) => { calls.push(clipId); return menuUnits(); });
    t.nav.start();
    await flushAll();
    expect(calls).toEqual(['00002']);
    expect(t.nav.igPlane).not.toBeNull();
    expect(t.nav.igPlane!.hasContent).toBe(true);
    expect(menuEvents(t.events)).toEqual([{ type: 'menu', active: true }]);
    expect(t.nav.takeDrawCount()).toBeGreaterThan(0);
  });

  it('runs the init when the preload settles after the playlist opened', async () => {
    let resolve!: (u: IgUnit[]) => void;
    const t = subSetup(() => new Promise<IgUnit[]>((r) => { resolve = r; }));
    t.nav.start();
    await flushAll();
    expect(t.nav.igPlane).toBeNull();
    resolve(menuUnits());
    await flushAll();
    expect(t.nav.igPlane?.hasContent).toBe(true);
    expect(menuEvents(t.events)).toEqual([{ type: 'menu', active: true }]);
  });

  it('keeps the menu across a PSR restore (the playlist reopens and the preload runs again)', async () => {
    let loads = 0;
    const t = subSetup(async () => { loads++; return menuUnits(); }, [
      { cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle,
    ]);
    t.nav.start();
    await flushAll();
    expect(loads).toBe(1);
    t.nav.menuCall();
    await flushAll();
    expect(loads).toBe(2);
    expect(t.nav.igPlane?.hasContent).toBe(true);
    expect(menuEvents(t.events).at(-1)).toEqual({ type: 'menu', active: true });
  });

  it('does not flicker the menu while the preload reloads after a restore: INIT waits for it, and NOP runs only while animating', async () => {
    let resolve: ((u: IgUnit[]) => void) | null = null;
    const t = subSetup((): Promise<IgUnit[]> => (resolve === null ? Promise.resolve(menuUnits()) : new Promise<IgUnit[]>((r) => { resolve = r; })), [
      { cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle,
    ]);
    t.nav.start();
    await flushAll();
    expect(menuEvents(t.events)).toEqual([{ type: 'menu', active: true }]);
    resolve = (): void => {}; // the next load stays pending until resolved below
    const writes: string[] = [];
    t.regs.onWrite = (w): void => { if (w.kind === 'psr' && (w.index === PSR.MENU_PAGE_ID || w.index === PSR.SELECTED_BUTTON_ID)) writes.push(`psr ${w.index}`); };
    t.nav.menuCall();
    await flushAll();
    t.nav.tick(0);
    t.nav.tick(0);
    expect(menuEvents(t.events)).toEqual([{ type: 'menu', active: true }]);
    expect(writes).toEqual([]);
    resolve!(menuUnits());
    await flushAll();
    expect(menuEvents(t.events)).toEqual([{ type: 'menu', active: true }]);
    expect(writes.length).toBeGreaterThan(0); // the deferred INIT_MENU ran
    expect(t.nav.igPlane?.hasContent).toBe(true);
  });

  it('decodes only up to the first complete display set of the preloaded stream, as gc_decode_ts does', async () => {
    const shownFor = async (units: IgUnit[]): Promise<string> => {
      const t = subSetup(async () => units);
      t.nav.start();
      await flushAll();
      return t.nav.igPlane!.hash();
    };
    const first = menuUnits({ buttons: 1 });
    const second = menuUnits({ buttons: 3 });
    const both = await shownFor([...first, ...second]);
    expect(both).toBe(await shownFor(first));
    expect(both).not.toBe(await shownFor(second));
  });

  it('counts a failed preload as an IG error: no menu, no crash', async () => {
    const t = subSetup(async () => { throw new Error('read failed'); });
    t.nav.start();
    await flushAll();
    expect(t.nav.igPlane).toBeNull();
    expect(t.nav.igErrors).toBe(1);
    expect(t.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('aborts the read and ignores the result when the playlist closes first', async () => {
    let signal!: AbortSignal;
    let resolve!: (u: IgUnit[]) => void;
    const t = subSetup((_c, s) => { signal = s; return new Promise<IgUnit[]>((r) => { resolve = r; }); });
    t.nav.start();
    await flushAll();
    expect(signal.aborted).toBe(false);
    t.nav.stop();
    expect(signal.aborted).toBe(true);
    resolve(menuUnits());
    await flushAll();
    expect(t.nav.igPlane).toBeNull();
    expect(menuEvents(t.events)).toEqual([]);
  });

  it('treats an abort rejection after close as no error', async () => {
    const t = subSetup((_c, s) => new Promise<IgUnit[]>((_r, reject) => s.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    t.nav.start();
    await flushAll();
    t.nav.stop();
    await flushAll();
    expect(t.nav.igErrors).toBe(0);
  });

  it('shows no menu when the sub-clip reference is invalid or no loader is injected', async () => {
    let called = 0;
    const bad = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: { '00000': { items: [item({ ig: [{ ...SUB_IG, subClipId: 3 }] })], subPaths } },
      preloadSubPathIg: async () => { called++; return menuUnits(); },
    });
    bad.port.onOpen = (id, at) => bad.nav.playlistStarted(id, at.item ?? 0);
    bad.nav.start();
    await flushAll();
    expect(called).toBe(0);
    expect(bad.nav.igPlane).toBeNull();
    const t = setup({ objects: [{ cmds: [asm.playPl(imm(0))] }], playlists: { '00000': { items: [item({ ig: [SUB_IG] })], subPaths } } });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    t.nav.start();
    await flushAll();
    expect(t.nav.igPlane).toBeNull();
  });

  /** Counts the INIT_MENU messages that reach the graphics controller. */
  function countInit(nav: Navigator): { count: () => number } {
    const gc = (nav as unknown as { gc: { run: (msg: string, param?: number) => unknown } }).gc;
    const run = gc.run.bind(gc);
    let n = 0;
    gc.run = (msg, param) => { if (msg === 'initMenu') n++; return run(msg, param); };
    return { count: () => n };
  }

  it('runs INIT_MENU exactly once per sub-path init: decoding the preload does not run it (gc_decode_ts never does)', async () => {
    const t = subSetup(async () => menuUnits());
    const init = countInit(t.nav);
    t.nav.start();
    await flushAll();
    expect(t.nav.igPlane?.hasContent).toBe(true);
    expect(init.count()).toBe(1);
  });

  it('runs INIT_MENU once when the preload settles after INIT, and once per restore', async () => {
    let resolve!: (u: IgUnit[]) => void;
    const t = subSetup(() => new Promise<IgUnit[]>((r) => { resolve = r; }));
    const init = countInit(t.nav);
    t.nav.start();
    await flushAll();
    const before = init.count(); // the caller's INIT ran with nothing decoded yet
    resolve(menuUnits());
    await flushAll();
    expect(init.count() - before).toBe(1);
    expect(t.nav.igPlane?.hasContent).toBe(true);

    const r = subSetup(async () => menuUnits(), [{ cmds: [asm.playPl(imm(0))], resumeIntention: true }, { cmds: [asm.resume()] }, idle, idle]);
    const restoreInit = countInit(r.nav);
    r.nav.start();
    await flushAll();
    expect(restoreInit.count()).toBe(1);
    r.nav.menuCall();
    await flushAll();
    expect(restoreInit.count()).toBe(2);
  });

  it('does not preload IG entries of stream_type 3 or 4: they decode from the main path with their PID', async () => {
    for (const streamType of [3, 4]) {
      let called = 0;
      const t = setup({
        objects: [{ cmds: [asm.playPl(imm(0))] }],
        playlists: { '00000': { items: [item({ ig: [{ pid: 0x1400, codingType: 0x91, streamType, subPathId: 0 }] })], subPaths } },
        preloadSubPathIg: async () => { called++; return menuUnits(); },
      });
      t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
      t.nav.start();
      await flushAll();
      expect(called).toBe(0);
      for (const data of simpleMenuSegments()) t.nav.pushIg({ data, ptsUs: 0 });
      t.nav.tick(0);
      expect(t.nav.igPlane?.hasContent, `type ${streamType}`).toBe(true);
    }
  });

  it('decodes the preloaded buffer filtered by the PID PSR0 names at init, without a new preload', async () => {
    let loads = 0;
    const other = simpleMenuSegments({ buttons: 1 }).map((data) => ({ data, ptsUs: 0, pid: 0x1401 }));
    const mine = menuUnits({ buttons: 2 });
    const t = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: { '00000': { items: [item({ ig: [SUB_IG, { ...SUB_IG, pid: 0x1401 }] })], subPaths } },
      preloadSubPathIg: async () => { loads++; return [...other, ...mine]; },
    });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    t.regs.psrWrite(PSR.IG_STREAM_ID, 2); // names the second entry (pid 0x1401) when the playlist opens
    t.nav.start();
    await flushAll();
    expect(loads).toBe(1);
    const second = t.nav.igPlane!.hash();
    const ref = subSetup(async () => other.map((u) => ({ ...u, pid: 0x1400 })));
    ref.nav.start();
    await flushAll();
    expect(second).toBe(ref.nav.igPlane!.hash());
  });
});

describe('Navigator IG button commands reach the graphics controller with their parameter', () => {
  const SUB_IG = { pid: 0x1400, codingType: 0x91, streamType: 2, subPathId: 0, subClipId: 0 };
  const subPaths: SubPathSpec[] = [{ type: 3, items: [{ clipId: '00002', inTime: 0, outTime: 90000 }] }];
  const flushAll = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const event = (type: number, param: number) => ({ type, param, param2: 0 });
  type Internals = { processHdmvVmEvent(e: unknown): void };

  async function boot(units: IgUnit[]) {
    const t = setup({
      objects: [{ cmds: [asm.playPl(imm(0))] }],
      playlists: { '00000': { items: [item({ ig: [SUB_IG] })], subPaths } },
      preloadSubPathIg: async () => units,
    });
    t.port.onOpen = (id, at) => t.nav.playlistStarted(id, at.item ?? 0);
    t.nav.start();
    await flushAll();
    return t;
  }
  const toUnits = (segs: Uint8Array[]): IgUnit[] => segs.map((data) => ({ data, ptsUs: 0, pid: 0x1400 }));

  it('SET_BUTTON_PAGE from a page-0 routing button changes the page (TSURUNE clip 00021 pattern)', async () => {
    const page = (id: number, cmds: Uint8Array[], autoAction: boolean, objectBase: number) => ({
      id, defaultSelected: 1, paletteId: 0,
      bogs: [{ defaultValid: 1, buttons: [{ id: 1, x: 10, y: 10, normal: [objectBase, objectBase] as [number, number], selected: [objectBase, objectBase] as [number, number], activated: [objectBase, objectBase] as [number, number], autoAction, cmds }] }],
    });
    const segs = [
      ...icsSegment({
        compositionState: 'epochStart', uiModel: 'alwaysOn',
        pages: [page(0, [asm.setButtonPage(imm(0), imm(0x80000001))], true, 0xffff), page(1, [], false, 10)],
      }),
      pdsSegment(0, 0, [[1, 100, 128, 128, 255]]),
      ...odsSegment(10, 0, 8, 4, Array.from({ length: 4 }, () => new Array<number>(8).fill(1))),
      endSegment(),
    ].flat() as Uint8Array[];
    const t = await boot(toUnits(segs));
    t.nav.tick(0);
    await flushAll();
    expect(t.regs.psrRead(PSR.MENU_PAGE_ID)).toBe(1);
    expect(t.nav.igPlane?.hasContent).toBe(true);
  });

  it('ENABLE_BUTTON and DISABLE_BUTTON act on the button they name', async () => {
    const t = await boot(toUnits(simpleMenuSegments({ buttons: 2 })));
    expect(t.regs.psrRead(PSR.SELECTED_BUTTON_ID)).toBe(1);
    const nav = t.nav as unknown as Internals;
    nav.processHdmvVmEvent(event(HdmvEventType.DISABLE_BUTTON, 1));
    expect(t.regs.psrRead(PSR.SELECTED_BUTTON_ID)).toBe(0xffff); // the selected button was disabled
    nav.processHdmvVmEvent(event(HdmvEventType.ENABLE_BUTTON, 1));
    expect(t.regs.psrRead(PSR.SELECTED_BUTTON_ID) & 0xffff).not.toBe(0xffff);
  });

  it('SET_BUTTON_PAGE passes its parameter (page flag and page id)', async () => {
    const t = await boot(toUnits(simpleMenuSegments({ buttons: 2 })));
    const spy = vi.spyOn((t.nav as unknown as { gc: { run: (m: string, p?: number) => unknown } }).gc, 'run');
    (t.nav as unknown as Internals).processHdmvVmEvent(event(HdmvEventType.SET_BUTTON_PAGE, 0x80010000));
    expect(spy).toHaveBeenCalledWith('setButtonPage', 0x80010000);
  });
});
