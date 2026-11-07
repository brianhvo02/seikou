import { describe, expect, it } from 'vitest';
import { asm, buildMovieObjects, encodeCmd, imm, psr, reg } from '../../../tests/helpers/hdmv-builders';
import { CmpOpt, InsnGroup, SetOpt, SetSub, parseMobjCmd, parseMovieObjects } from './mobj-parser';
import { ParseError } from './byte-reader';

describe('parseMobjCmd', () => {
  it('decodes the bit fields of a SET/MOVE with an immediate source', () => {
    const c = parseMobjCmd(asm.set('move', reg(5), imm(0x1234)));
    expect(c.insn).toEqual({ opCnt: 2, grp: InsnGroup.SET, subGrp: SetSub.SET, immOp1: false, immOp2: true, branchOpt: 0, cmpOpt: 0, setOpt: SetOpt.MOVE });
    expect([c.dst, c.src]).toEqual([5, 0x1234]);
  });

  it('keeps the PSR flag in register operands', () => {
    const c = parseMobjCmd(asm.cmp('eq', psr(10), imm(3)));
    expect([c.insn.grp, c.insn.cmpOpt, c.dst >>> 0, c.src]).toEqual([InsnGroup.CMP, CmpOpt.EQ, 0x8000000a, 3]);
  });

  it('round-trips arbitrary fields through encodeCmd', () => {
    const bytes = encodeCmd({ grp: 0, subGrp: 2, opCnt: 2, branchOpt: 1, dst: imm(7), src: imm(3) });
    expect(parseMobjCmd(bytes)).toMatchObject({ insn: { grp: 0, subGrp: 2, opCnt: 2, branchOpt: 1, immOp1: true, immOp2: true }, dst: 7, src: 3 });
  });
});

describe('parseMovieObjects', () => {
  it('reads objects, their flags and commands', () => {
    const mobj = parseMovieObjects(buildMovieObjects([
      { resumeIntention: true, menuCallMask: false, titleSearchMask: true, cmds: [asm.set('move', reg(0), imm(1)), asm.playPl(imm(1))] },
      { cmds: [asm.jumpTitle(imm(1))] },
    ]));
    expect(mobj.objects).toHaveLength(2);
    expect(mobj.objects[0]).toMatchObject({ resumeIntention: true, menuCallMask: false, titleSearchMask: true });
    expect(mobj.objects[0].cmds).toHaveLength(2);
    expect(mobj.objects[1].cmds[0].dst).toBe(1);
  });

  it('rejects a bad signature or a truncated object list', () => {
    const good = buildMovieObjects([{ cmds: [asm.nop()] }]);
    const badSig = good.slice(); badSig[0] = 0x58;
    expect(() => parseMovieObjects(badSig)).toThrow(ParseError);
    expect(() => parseMovieObjects(good.slice(0, good.length - 4))).toThrow(ParseError);
  });
});
