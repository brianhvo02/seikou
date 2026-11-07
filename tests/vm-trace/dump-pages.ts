/** Readable dump of IG menus (pages, buttons, rectangles, neighbours, commands), for writing trace scripts against real discs. */
import { BranchSub, CmpOpt, GotoOpt, InsnGroup, JumpOpt, PlayOpt, SetOpt, SetSub, SetSystemOpt, type MobjCmd } from '@seikou/bdmv/mobj-parser';
import { IgSegmentDecoder, type IgComposition } from '@seikou/engine/graphics/ig-decoder';
import type { PgObject } from '@seikou/pg';
import type { IgUnit } from '@seikou/engine/nav/navigator';

const NONE = 0xffff;
const name = (table: Record<string, number>, value: number): string => Object.keys(table).find((k) => table[k] === value) ?? `?${value}`;
const operand = (value: number, imm: boolean): string => (imm ? (value > 0xffff ? `0x${value.toString(16)}` : String(value)) : value & 0x80000000 ? `PSR${value & 0x7f}` : `GPR${value & 0xfff}`);

/** One HDMV command, as "JUMP_TITLE 1" or "SET.MOVE GPR3, 5". */
export function describeCmd(cmd: MobjCmd): string {
  const { insn, dst, src } = cmd;
  const args = [operand(dst, insn.immOp1), operand(src, insn.immOp2)].slice(0, insn.opCnt).join(', ');
  const op = ((): string => {
    switch (insn.grp) {
      case InsnGroup.BRANCH: {
        const table = insn.subGrp === BranchSub.GOTO ? GotoOpt : insn.subGrp === BranchSub.JUMP ? JumpOpt : PlayOpt;
        return name(table, insn.branchOpt);
      }
      case InsnGroup.CMP: return `CMP.${name(CmpOpt, insn.cmpOpt)}`;
      case InsnGroup.SET: return insn.subGrp === SetSub.SET ? `SET.${name(SetOpt, insn.setOpt)}` : name(SetSystemOpt, insn.setOpt);
      default: return `?grp${insn.grp}`;
    }
  })();
  return args ? `${op} ${args}` : op;
}

function describeComposition(c: IgComposition, objects: ReadonlyMap<number, PgObject>): string[] {
  const id = (v: number): string => (v === NONE ? '-' : String(v));
  const lines = [`composition ${c.compositionNumber}: ${c.uiModel === 1 ? 'pop-up' : 'always-on'}, ${c.videoWidth}x${c.videoHeight}, ${c.pages.length} page(s), user timeout ${c.userTimeoutDuration}`];
  for (const page of c.pages) {
    lines.push(`  page ${page.id}: default selected ${id(page.defaultSelectedButton)}, default activated ${id(page.defaultActivatedButton)}`);
    page.bogs.forEach((bog, b) => {
      lines.push(`    bog ${b} (default valid ${id(bog.defaultValidButton)})`);
      for (const btn of bog.buttons) {
        const obj = objects.get(btn.normalStart) ?? objects.get(btn.selectedStart);
        const size = obj ? `${obj.width}x${obj.height}` : '?x?';
        const centre = obj ? ` centre (${btn.x + (obj.width >> 1)}, ${btn.y + (obj.height >> 1)})` : '';
        const extra = [btn.numericSelectValue !== NONE ? `numeric ${btn.numericSelectValue}` : '', btn.autoActionFlag ? 'auto-action' : ''].filter(Boolean).join(', ');
        lines.push(`      button ${btn.id}: ${size} at (${btn.x}, ${btn.y})${centre}; up ${id(btn.upper)} down ${id(btn.lower)} left ${id(btn.left)} right ${id(btn.right)}${extra ? `; ${extra}` : ''}`);
        for (const cmd of btn.navCmds) lines.push(`        ${describeCmd(cmd)}`);
      }
    });
  }
  return lines;
}

/** Every complete IG display set with a composition among `units` (in stream order), described. */
export function dumpIgPages(units: readonly IgUnit[]): string {
  const decoder = new IgSegmentDecoder();
  const objects = new Map<number, PgObject>();
  const lines: string[] = [];
  for (const unit of units) {
    const ds = decoder.push(unit.data, Math.round((unit.ptsUs * 90) / 1000), null);
    if (!ds) continue;
    for (const [k, o] of ds.objects) objects.set(k, o);
    if (ds.composition) lines.push(...describeComposition(ds.composition, objects));
  }
  return lines.join('\n');
}
