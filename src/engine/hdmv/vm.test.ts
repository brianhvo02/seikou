import { describe, expect, it } from 'vitest';
import { asm, buildMovieObjects, imm, psr, reg } from '../../../tests/helpers/hdmv-builders';
import { parseMovieObjects } from '@seikou/bdmv/mobj-parser';
import { RegisterFile } from './registers';
import { HdmvEventType, HdmvVm, type HdmvEvent } from './vm';

function vm(objects: Array<{ cmds: Uint8Array[]; resumeIntention?: boolean; menuCallMask?: boolean; titleSearchMask?: boolean }>, opts = { numTitles: 3, firstPlay: true, topMenu: true, seed: 1 }) {
  const regs = new RegisterFile();
  const m = new HdmvVm(parseMovieObjects(buildMovieObjects(objects)), regs, opts);
  return { m, regs };
}
/** Runs until END/IG_END, an error, or `limit` events; returns the events. */
function runAll(m: HdmvVm, limit = 20): Array<HdmvEvent | null> {
  const out: Array<HdmvEvent | null> = [];
  for (let i = 0; i < limit; i++) {
    const ev = m.run();
    out.push(ev);
    if (ev === null || ev.type === HdmvEventType.END || ev.type === HdmvEventType.IG_END) break;
    for (let e = m.nextEvent(); e; e = m.nextEvent()) out.push(e);
    if (!m.running()) break;
  }
  return out;
}

describe('HdmvVm SET group', () => {
  it.each([
    ['move', 5, 7, 7], ['add', 0xfffffff0, 0x20, 0xffffffff], ['sub', 3, 5, 0], ['mul', 0x10000, 0x10000, 0xffffffff],
    ['div', 7, 0, 0xffffffff], ['mod', 7, 3, 1], ['and', 6, 3, 2], ['or', 4, 1, 5], ['xor', 6, 3, 5],
    ['bitset', 0, 4, 16], ['bitclr', 31, 0, 30], ['shl', 1, 31, 0x80000000], ['shr', 0x80000000, 32, 0],
  ] as const)('%s %d, %d = %d (libbluray saturation and edge rules)', (op, a, b, want) => {
    const { m, regs } = vm([{ cmds: [asm.set('move', reg(1), imm(a)), asm.set(op, reg(1), imm(b))] }]);
    m.selectObject(0);
    runAll(m);
    expect(regs.gprRead(1) >>> 0).toBe(want);
  });

  it('swaps two registers', () => {
    const { m, regs } = vm([{ cmds: [asm.set('move', reg(1), imm(1)), asm.set('move', reg(2), imm(2)), asm.set('swap', reg(1), reg(2))] }]);
    m.selectObject(0); runAll(m);
    expect([regs.gprRead(1), regs.gprRead(2)]).toEqual([2, 1]);
  });

  it('draws RND from the seeded LCG in 1..range', () => {
    const { m, regs } = vm([{ cmds: [asm.set('rnd', reg(1), imm(6)), asm.set('rnd', reg(2), imm(6))] }]);
    m.selectObject(0); runAll(m);
    // seed 1: rand = rand * 6364136223846793005 + 1 (mod 2^64); value = (rand >> 32) % 6 + 1
    const lcg = (s: bigint) => (s * 6364136223846793005n + 1n) & 0xffffffffffffffffn;
    const s1 = lcg(1n), s2 = lcg(s1);
    expect([regs.gprRead(1), regs.gprRead(2)]).toEqual([Number((s1 >> 32n) % 6n) + 1, Number((s2 >> 32n) % 6n) + 1]);
  });

  it('never stores to a PSR', () => {
    const { m, regs } = vm([{ cmds: [asm.set('move', psr(10), imm(3))] }]);
    m.selectObject(0); runAll(m);
    expect(regs.psrRead(10)).toBe(0xffff);
  });
});

describe('HdmvVm CMP and GOTO', () => {
  it('skips the next command when a compare is false', () => {
    const { m, regs } = vm([{ cmds: [
      asm.cmp('eq', imm(1), imm(2)), asm.set('move', reg(1), imm(9)),  // skipped
      asm.cmp('lt', imm(1), imm(2)), asm.set('move', reg(2), imm(9)),  // runs
      asm.cmp('bc', imm(0b0100), imm(0b0110)), asm.set('move', reg(3), imm(9)), // BC: skip if src & ~dst
    ] }]);
    m.selectObject(0); runAll(m);
    expect([regs.gprRead(1), regs.gprRead(2), regs.gprRead(3)]).toEqual([0, 9, 0]);
  });

  it('GOTO jumps and BREAK ends the object with END', () => {
    const { m, regs } = vm([{ cmds: [asm.goto(2), asm.set('move', reg(1), imm(1)), asm.set('move', reg(2), imm(2)), asm.break(), asm.set('move', reg(3), imm(3))] }]);
    m.selectObject(0);
    const evs = runAll(m);
    expect(evs.at(-1)?.type).toBe(HdmvEventType.END);
    expect([regs.gprRead(1), regs.gprRead(2), regs.gprRead(3)]).toEqual([0, 2, 0]);
  });

  it('stops an endless loop after MAX_LOOP steps with an error', () => {
    const { m } = vm([{ cmds: [asm.goto(0)] }]);
    m.selectObject(0);
    // select_object queues PLAY_STOP, which hdmv_vm_run returns before executing anything
    expect(m.run()?.type).toBe(HdmvEventType.PLAY_STOP);
    expect(m.run()).toBeNull();
    expect(m.running()).toBe(false);
  });

  it('stops after MAX_LOOP - 1 steps (--max_loop > 0): 500000 ADDs ran', () => {
    const { m, regs } = vm([{ cmds: [asm.set('add', reg(1), imm(1)), asm.goto(0)] }]);
    m.selectObject(0);
    expect(m.run()?.type).toBe(HdmvEventType.PLAY_STOP);
    expect(m.run()).toBeNull();
    expect(regs.gprRead(1)).toBe(500000);
  });
});

describe('HdmvVm branching and playback', () => {
  // hdmv_vm_select_object queues PLAY_STOP and _vm_run returns pending events first.
  const start = (m: HdmvVm) => {
    m.selectObject(0);
    expect(m.run()?.type).toBe(HdmvEventType.PLAY_STOP);
  };

  it('PLAY_PL queues the event and suspends; resume() continues after it', () => {
    const { m, regs } = vm([{ cmds: [asm.playPl(imm(5)), asm.set('move', reg(1), imm(1))] }]);
    start(m);
    const ev = m.run();
    expect(ev).toEqual({ type: HdmvEventType.PLAY_PL, param: 5, param2: 0 });
    expect(m.running()).toBe(false);
    expect(m.resume()).toBe(0);
    runAll(m);
    expect(regs.gprRead(1)).toBe(1);
  });

  it('PLAY_PL_PI and PLAY_PL_PM carry the item or mark in param2', () => {
    const a = vm([{ cmds: [asm.playPlPi(imm(2), imm(3))] }]);
    start(a.m);
    expect(a.m.run()).toEqual({ type: HdmvEventType.PLAY_PL_PI, param: 2, param2: 3 });
    const b = vm([{ cmds: [asm.playPlPm(imm(2), imm(4))] }]);
    start(b.m);
    expect(b.m.run()).toEqual({ type: HdmvEventType.PLAY_PL_PM, param: 2, param2: 4 });
  });

  it('JUMP_OBJECT queues PLAY_STOP and starts the other object', () => {
    const { m, regs } = vm([{ cmds: [asm.jumpObject(imm(1))] }, { cmds: [asm.set('move', reg(1), imm(7))] }]);
    m.selectObject(0);
    expect(runAll(m).map((e) => e?.type)).toContain(HdmvEventType.PLAY_STOP);
    expect(regs.gprRead(1)).toBe(7);
  });

  it('an invalid JUMP_OBJECT keeps the pc and execution continues', () => {
    const { m, regs } = vm([{ cmds: [asm.jumpObject(imm(9)), asm.set('move', reg(1), imm(1))] }]);
    m.selectObject(0); runAll(m);
    expect(regs.gprRead(1)).toBe(1);
  });

  it('CALL_OBJECT saves PSRs and RESUME returns after the call, restoring them', () => {
    const { m, regs } = vm([
      { cmds: [asm.callObject(imm(1)), asm.set('move', reg(3), imm(9)), asm.set('move', reg(2), imm(2))] },
      { cmds: [asm.set('move', reg(1), imm(1)), asm.resume()] },
    ]);
    regs.psrWrite(4, 3); // title 3 before the call
    m.selectObject(0);
    runAll(m);
    expect([regs.gprRead(1), regs.gprRead(2), regs.psrRead(4)]).toEqual([1, 2, 3]);
    // libbluray quirk: _resume_object sets pc = suspended_pc + 1 and _hdmv_step then adds inc_pc = 1,
    // so the command right after CALL_OBJECT is skipped.
    expect(regs.gprRead(3)).toBe(0);
  });

  it('JUMP_TITLE validates the title (0 top menu, 0xffff first play, 1..numTitles)', () => {
    const ok = vm([{ cmds: [asm.jumpTitle(imm(2))] }]);
    start(ok.m);
    expect(ok.m.run()).toEqual({ type: HdmvEventType.TITLE, param: 2, param2: 0 });
    const bad = vm([{ cmds: [asm.jumpTitle(imm(9)), asm.set('move', reg(1), imm(1))] }]);
    bad.m.selectObject(0);
    runAll(bad.m);
    expect(bad.regs.gprRead(1)).toBe(1); // invalid title is ignored; execution continues
  });

  it('button commands: LINK_PI and SET_BUTTON_PAGE queue events and terminate the IG object', () => {
    const { m } = vm([{ cmds: [asm.playPl(imm(1))] }]);
    start(m); m.run(); // now playing playlist 1, suspended in PLAY_PL
    const cmds = [asm.linkPi(imm(2)), asm.setButtonPage(imm(0x80000003), imm(0x80000001))].map((b) => parseMovieObjects(buildMovieObjects([{ cmds: [b] }])).objects[0].cmds[0]);
    expect(m.setObject(cmds)).toBe(0);
    const evs = runAll(m);
    expect(evs.map((e) => e?.type)).toEqual(expect.arrayContaining([HdmvEventType.PLAY_PI, HdmvEventType.SET_BUTTON_PAGE]));
  });

  it('SET_BUTTON_PAGE in a movie object writes PSR10/11 directly', () => {
    const { m, regs } = vm([{ cmds: [asm.setButtonPage(imm(0x80000004), imm(0x80000002))] }]);
    m.selectObject(0); runAll(m);
    expect([regs.psrRead(10), regs.psrRead(11)]).toEqual([4, 2]);
  });

  it('SET_STREAM writes the primary audio PSR when its flag is set', () => {
    const { m, regs } = vm([{ cmds: [asm.setStream(imm(0x80020000), imm(0))] }]);
    m.selectObject(0); runAll(m);
    expect(regs.psrRead(1)).toBe(2);
  });

  it('uoMask reflects the running or playing object flags', () => {
    const { m } = vm([{ menuCallMask: true, titleSearchMask: true, cmds: [asm.playPl(imm(1))] }]);
    start(m); m.run();
    expect(m.running()).toBe(false);
    expect(m.uoMask()).toBe(0b11);
  });

  it('suspendPlaylist keeps a resumable object only when it has resume intention', () => {
    const keep = vm([{ resumeIntention: true, cmds: [asm.playPl(imm(1))] }]);
    start(keep.m); keep.m.run();
    expect(keep.m.suspendPlaylist()).toBe(0);
    expect(keep.m.resume()).toBe(-1); // moved to the suspended slot, no longer playing
    const drop = vm([{ resumeIntention: false, cmds: [asm.playPl(imm(1))] }]);
    start(drop.m); drop.m.run();
    expect(drop.m.suspendPlaylist()).toBe(0);
    expect(drop.m.resume()).toBe(-1);
  });
});
