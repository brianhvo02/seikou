# Milestone 3: HDMV Menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HDMV discs boot through First Play into working disc menus (keyboard, mouse, on-screen remote, pop-up menus, menu sounds, UO masks), verified against real libbluray with a trace harness.

**Architecture:** libbluray's movie-object parser, register file, HDMV VM, IG decoder, graphics controller and navigation glue are ported to TypeScript in the engine worker. A `Navigator` owns the VM, registers and graphics controller and drives the existing `Player` through a narrow `PlaybackPort`. IG units are queued by PTS and drawn onto an IG plane that the compositor puts over the video. A native harness builds libbluray from source with a register-write log and records traces that our Node replay must match.

**Tech Stack:** TypeScript (strict), React 19, Vite 8, Vitest 5, Playwright 1.64 (Chrome); C (libbluray 448f896, gcc) in Docker for the harness.

**Spec:** `docs/superpowers/specs/2026-10-14-m3-hdmv-menus-design.md` (parent: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`). Read both.

## How port tasks are written

About 6,000 lines of libbluray C are ported. The plan does not restate that C. For each port task it names the **exact libbluray functions** to translate. Their source is the reference implementation and must be followed line by line, as the M1 parsers were. Interfaces, tests and acceptance checks are given in full. Get the source with `scripts/fetch-libbluray.sh` (Task 1). It clones `https://code.videolan.org/videolan/libbluray.git` at commit `448f896` into the gitignored `.cache/libbluray/`. Paths below are relative to `.cache/libbluray/src/libbluray/`.

## Global Constraints

- Ported code lives in `src/engine/`, is LGPL-2.1-or-later, has the SPDX/copyright header used by `src/engine/bdmv/mpls-parser.ts`, and is listed in `src/engine/NOTICE` with its source file.
- Port from libbluray commit `448f896` only. Keep libbluray's names in comments where the TypeScript name differs, so a reviewer can find the C.
- Engine code must not import React or anything from `src/ui/` or `src/player/`.
- Determinism: `HdmvVm` takes an optional RNG `seed` (default `Math.floor(Date.now() / 1000)`, as libbluray's `time(NULL)`). Graphics timers take an injected `nowScr(): number` (90 kHz ticks), mirroring `bd_get_scr()`. Tests and the trace replay use seed `1` and a fake clock.
- Initial PSR values are libbluray's `bd_psr_init` exactly, including region B and profile 2. This deliberately differs from the parent spec's "HDMV-only" wording, so that traces match libbluray's defaults.
- No new runtime dependencies. The harness uses Docker (`linux/amd64`, image pinned by digest), like `src/wasm/audio/build.sh`.
- TypeScript strict with `noUnusedLocals`, `noUnusedParameters` and `verbatimModuleSyntax`. Match the surrounding style: few comments, explaining why; `readonly` interface fields.
- Existing behaviour stays: BD-J discs and discs without `MovieObject.bdmv` open to the picker exactly as today, and every existing test keeps passing.

### Deviations from the spec (decided while planning)

1. **Trace times are not compared.** libbluray feeds IG data to the graphics controller with `stc = -1` (no PTS gating), and the harness reads as fast as it can. Comparisons check the order and values of entries only, with media times kept for diagnostics. Task 20 updates spec §5.4.
2. **Graphics are compared through plane hashes.** Both sides apply overlay operations to an in-memory palette-index plane (`graphics/overlay-plane.ts`) and record a hash at every script step. Raw per-frame animation operations depend on wall time, so they are not compared one-for-one.
3. **The IG plane is updated by dirty rectangle** from the palette plane, instead of an `ImageBitmap` per object as the parent spec sketches. The result on screen is the same, and the code is simpler.

## Review Focus

1. **A First Play program that loops or bounces between titles forever.** It must stop with an error notice and the picker, not hang the worker. This is libbluray's 100-iteration guard in `_read_ext`. Task 6 has a test.
2. **Seeking while a menu is shown.** The IG queue and controller reset, the menu reappears from the next epoch, and no stale buttons are drawn. Task 12 has a test.
3. **Fast keys or mouse moves while a page or menu is changing** (button IDs that no longer exist). These must be ignored without a crash or a wrong activation. Task 11 has a test.
4. **Masked operations triggered by keyboard shortcuts** (arrow-seek during an unskippable intro). They must be refused with a notice and no seek. Task 15 has a test.
5. **Opening another disc, or picking a raw playlist, while the VM is suspended or a menu is open.** The navigator resets, the overlay clears, and no stale menu or VM program continues. Tasks 7 and 12 have tests.

---

## File map

| File | Status | Task |
|---|---|---|
| `scripts/fetch-libbluray.sh`, `.gitignore` (`.cache/`) | create / modify | 1 |
| `src/engine/bdmv/mobj-parser.ts`, `tests/helpers/hdmv-builders.ts` | create | 1 |
| `src/engine/hdmv/registers.ts` | create | 2 |
| `src/engine/hdmv/uo-mask.ts` | create | 2 |
| `src/engine/hdmv/vm.ts` | create | 3, 4 |
| `src/engine/disc/open-disc.ts` (movie objects, sound) | modify | 5 |
| `src/engine/bdmv/sound-parser.ts` | create | 5 |
| `src/engine/nav/navigator.ts` | create | 6, 12 |
| `src/engine/nav/timeline.ts` (mark times) | modify | 6 |
| `src/engine/player.ts`, `protocol.ts`, `worker.ts`, `playback/pipeline.ts` | modify | 7, 12, 15 |
| `scripts/make-vm-disc.ts`, `fixtures/synthetic/disc-vm` | create | 8 |
| `tools/vm-trace/*`, `tests/vm-trace/*`, `.github/workflows/vm-trace.yml` | create | 8, 13 |
| `src/engine/graphics/ig-decoder.ts`, `segments.ts` | create | 9 |
| `src/engine/graphics/rle.ts`, `palette.ts`, `overlay-plane.ts` | create | 10 |
| `src/engine/graphics/graphics-controller.ts` | create | 11 |
| `src/engine/render/compositor.ts` (IG plane) | modify | 12 |
| `scripts/make-menu-disc.ts`, `fixtures/synthetic/disc-menu` | create | 13 |
| `src/ui/keyboard.ts`, `PlayerScreen.tsx`, `src/ui/pointer.ts` | modify / create | 14 |
| `src/player/player-controller.ts` | modify | 14, 15, 16, 17 |
| `src/ui/ControlBar.tsx`, `PlaylistPicker.tsx`, `RemotePad.tsx` | modify / create | 16 |
| `src/player/audio-output.ts` (effects) | modify | 17 |
| `tests/e2e/menus.spec.ts`, `tests/e2e/local-discs.spec.ts` | create / modify | 18, 19 |
| docs | modify | 20 |

---

## Phase A: VM and navigation

### Task 1: libbluray reference, movie-object parser and HDMV test builders

**Files:**
- Create: `scripts/fetch-libbluray.sh`, `src/engine/bdmv/mobj-parser.ts`, `tests/helpers/hdmv-builders.ts`
- Modify: `.gitignore` (add `.cache/`), `src/engine/NOTICE`
- Test: `src/engine/bdmv/mobj-parser.test.ts`

**Port:** `hdmv/mobj_parse.c`: `mobj_parse_cmd`, `_mobj_parse_object`, `_mobj_parse` (header via the existing `src/engine/bdmv/version.ts` `checkVersion`, signature `MOBJ`).

**Interfaces (produces):**
```ts
export interface HdmvInsn {
  readonly opCnt: number; readonly grp: number; readonly subGrp: number;
  readonly immOp1: boolean; readonly immOp2: boolean;
  readonly branchOpt: number; readonly cmpOpt: number; readonly setOpt: number;
}
export interface MobjCmd { readonly insn: HdmvInsn; readonly dst: number; readonly src: number }
export interface MovieObject { readonly resumeIntention: boolean; readonly menuCallMask: boolean; readonly titleSearchMask: boolean; readonly cmds: readonly MobjCmd[] }
export interface MovieObjects { readonly version: string; readonly objects: readonly MovieObject[] }
export function parseMobjCmd(bytes: Uint8Array, offset?: number): MobjCmd; // 12 bytes
export function parseMovieObjects(bytes: Uint8Array): MovieObjects;       // throws ParseError
// tests/helpers/hdmv-builders.ts
export const reg: (n: number) => Operand;  export const psr: (n: number) => Operand;  export const imm: (v: number) => Operand;
export interface Operand { readonly value: number; readonly imm: boolean }  // psr(n) = 0x80000000 | n
export function encodeCmd(c: { grp: number; subGrp: number; opCnt: number; branchOpt?: number; cmpOpt?: number; setOpt?: number; dst?: Operand; src?: Operand }): Uint8Array;
export const asm: { // one helper per instruction, returns 12 bytes
  nop(): Uint8Array; goto(target: number): Uint8Array; break(): Uint8Array;
  jumpObject(o: Operand): Uint8Array; jumpTitle(t: Operand): Uint8Array; callObject(o: Operand): Uint8Array; callTitle(t: Operand): Uint8Array; resume(): Uint8Array;
  playPl(pl: Operand): Uint8Array; playPlPi(pl: Operand, pi: Operand): Uint8Array; playPlPm(pl: Operand, pm: Operand): Uint8Array;
  terminatePl(): Uint8Array; linkPi(pi: Operand): Uint8Array; linkMk(pm: Operand): Uint8Array;
  cmp(op: 'bc' | 'eq' | 'ne' | 'ge' | 'gt' | 'le' | 'lt', a: Operand, b: Operand): Uint8Array;
  set(op: 'move' | 'swap' | 'add' | 'sub' | 'mul' | 'div' | 'mod' | 'rnd' | 'and' | 'or' | 'xor' | 'bitset' | 'bitclr' | 'shl' | 'shr', dst: Operand, src: Operand): Uint8Array;
  setStream(dst: Operand, src: Operand): Uint8Array; setButtonPage(dst: Operand, src: Operand): Uint8Array;
  enableButton(b: Operand): Uint8Array; disableButton(b: Operand): Uint8Array; popupOff(): Uint8Array; stillOn(): Uint8Array; stillOff(): Uint8Array; setNvTimer(o: Operand, t: Operand): Uint8Array;
};
export function buildMovieObjects(objects: Array<{ resumeIntention?: boolean; menuCallMask?: boolean; titleSearchMask?: boolean; cmds: Uint8Array[] }>): Uint8Array<ArrayBuffer>;
```
The bit layout comes from `mobj_parse_cmd`. Byte 0 is `op_cnt(3) grp(2) sub_grp(3)`. Byte 1 is `imm_op1(1) imm_op2(1) reserved(2) branch_opt(4)`. Byte 2 is `reserved(4) cmp_opt(4)`. Byte 3 is `reserved(3) set_opt(5)`. Then `dst` and `src` are each 32-bit big-endian. Instruction constants come from `hdmv/hdmv_insn.h`. Export them from `mobj-parser.ts` as `InsnGroup`, `BranchSub`, `GotoOpt`, `JumpOpt`, `PlayOpt`, `CmpOpt`, `SetSub`, `SetOpt` and `SetSystemOpt`. The `MovieObject.bdmv` layout comes from `_mobj_parse`: header with signature and version, `extension_data_start` at byte 8, objects at byte 40 (`data_len` u32, reserved u32, `num_objects` u16, then per object three flag bits, 13 padding bits, `num_cmds` u16, and the commands).

- [ ] **Step 1: Add the fetch script and ignore `.cache/`.**

```bash
#!/usr/bin/env bash
# Clones libbluray at the commit bluray-web ports from, into .cache/libbluray (gitignored).
set -euo pipefail
COMMIT=448f896
DEST="$(cd "$(dirname "$0")/.." && pwd)/.cache/libbluray"
if [[ -d "$DEST/.git" ]] && [[ "$(git -C "$DEST" rev-parse --short=7 HEAD)" == "$COMMIT" ]]; then exit 0; fi
rm -rf "$DEST"
git clone --quiet https://code.videolan.org/videolan/libbluray.git "$DEST"
git -C "$DEST" checkout --quiet "$COMMIT"
```

Make it executable, append `.cache/` to `.gitignore`, and run it. Expected: `.cache/libbluray/src/libbluray/hdmv/mobj_parse.c` exists.

- [ ] **Step 2: Write the failing tests** in `src/engine/bdmv/mobj-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { asm, buildMovieObjects, encodeCmd, imm, psr, reg } from '../../../tests/helpers/hdmv-builders';
import { CmpOpt, InsnGroup, SetOpt, SetSub, parseMobjCmd, parseMovieObjects } from './mobj-parser';
import { ParseError } from '../util/byte-reader';

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
```

- [ ] **Step 3: Run the tests and check that they fail.** Run: `npx vitest run src/engine/bdmv/mobj-parser.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `tests/helpers/hdmv-builders.ts` (`buildMovieObjects` writes `MOBJ` and `0200`, `extension_data_start` = 0, pads to byte 40, then `data_len`, reserved, `num_objects` and the objects, using `tests/helpers/byte-writer.ts`). Then port `mobj-parser.ts` from the functions above using `ByteReader`.
- [ ] **Step 5: Run the tests and check that they pass.** Run the same command. Expected: PASS. Then run `npm run typecheck`.
- [ ] **Step 6:** Add `bdmv/mobj-parser.ts from src/libbluray/hdmv/mobj_parse.c` to `src/engine/NOTICE`, then commit: `feat(hdmv): MovieObject.bdmv parser and HDMV command builders`.

---

### Task 2: register file and UO masks

**Files:** Create `src/engine/hdmv/registers.ts`, `src/engine/hdmv/uo-mask.ts`. Tests: `registers.test.ts`, `uo-mask.test.ts`.

**Port:**
- `register.c`: `bd_psr_init` (the exact table), `bd_registers_init`, `bd_psr_save_state`, `bd_psr_reset_backup_registers`, `bd_psr_restore_state`, `bd_gpr_write`, `bd_gpr_read`, `bd_psr_read`, `bd_psr_write`, `bd_psr_write_bits`, `bd_psr_setting_write`, and the PSR event generation in `_bd_psr_write` (event types `BD_PSR_SAVE`, `BD_PSR_WRITE`, `BD_PSR_CHANGE`, `BD_PSR_RESTORE`).
- `bdnav/uo_mask_table.h` / `uo_mask.h`: `BD_UO_MASK` fields and order, `uo_mask_combine`, and the MPLS/ICS 64-bit table parse (`_decode_uo_mask_table` in `ig_decode.c`, and `mpls_parse` UO parsing).

**Interfaces (produces):**
```ts
// registers.ts
export const PSR = { IG_STREAM_ID: 0, PRIMARY_AUDIO_ID: 1, PG_STREAM: 2, ANGLE_NUMBER: 3, TITLE_NUMBER: 4, CHAPTER: 5, PLAYLIST: 6, PLAYITEM: 7, TIME: 8, NAV_TIMER: 9, SELECTED_BUTTON_ID: 10, MENU_PAGE_ID: 11, STYLE: 12, PARENTAL: 13, SECONDARY_AUDIO_VIDEO: 14, AUDIO_CAP: 15, AUDIO_LANG: 16, PG_AND_SUB_LANG: 17, MENU_LANG: 18, COUNTRY: 19, REGION: 20, OUTPUT_PREFER: 21, '3D_STATUS': 22, PROFILE_VERSION: 31 } as const;
export type PsrEventType = 'save' | 'write' | 'change' | 'restore';
export interface PsrEvent { readonly type: PsrEventType; readonly psr: number; readonly oldValue: number; readonly newValue: number }
export interface RegisterWrite { readonly kind: 'gpr' | 'psr'; readonly index: number; readonly value: number }
export class RegisterFile {
  gprRead(i: number): number; gprWrite(i: number, v: number): number;           // 0 ok, -1 invalid (as libbluray)
  psrRead(i: number): number; psrWrite(i: number, v: number): number /* 0, -1 invalid, -2 player setting */; psrWriteBits(i: number, v: number, mask: number): number;
  psrSettingWrite(i: number, v: number): number;                                 // player-setting PSRs (13, 15–21, 23–31, 48–61)
  saveState(): void; restoreState(): void; resetBackupRegisters(): void;
  onPsrEvent(listener: (e: PsrEvent) => void): () => void;
  onWrite: ((w: RegisterWrite) => void) | null;                                  // trace hook: every GPR/PSR write, as trace.patch logs
}
// uo-mask.ts
export type UoOp = 'menuCall' | 'titleSearch' | 'chapterSearch' | 'timeSearch' | 'skipToNextPoint' | 'skipBackToPreviousPoint' | 'playFirstPlay' | 'stop' | 'pauseOn' | 'pauseOff' | 'stillOff' | 'forwardPlay' | 'backwardPlay' | 'resume' | 'moveUp' | 'moveDown' | 'moveLeft' | 'moveRight' | 'select' | 'activate' | 'selectAndActivate' | 'primaryAudioChange' | 'angleChange' | 'popupOn' | 'popupOff' | 'pgEnableDisable' | 'pgChange' | 'secondaryVideoEnableDisable' | 'secondaryVideoChange' | 'secondaryAudioEnableDisable' | 'secondaryAudioChange' | 'pipPgChange';
export type UoMask = ReadonlySet<UoOp>;
export const EMPTY_UO_MASK: UoMask;
export function parseUoMaskTable(bytes: Uint8Array, offset?: number): UoMask;   // 8-byte table, bit order of uo_mask.h
export function combineUoMasks(a: UoMask, b: UoMask): UoMask;                    // uo_mask_combine (union)
```

- [ ] **Step 1: Write the failing tests.**

```ts
// registers.test.ts
import { describe, expect, it } from 'vitest';
import { PSR, RegisterFile, type PsrEvent, type RegisterWrite } from './registers';

describe('RegisterFile', () => {
  it('starts with libbluray initial PSR values and zeroed GPRs', () => {
    const r = new RegisterFile();
    expect([r.psrRead(PSR.IG_STREAM_ID), r.psrRead(PSR.PRIMARY_AUDIO_ID), r.psrRead(PSR.PG_STREAM), r.psrRead(PSR.SELECTED_BUTTON_ID), r.psrRead(PSR.REGION)]).toEqual([1, 0xff, 0x0fff0fff, 0xffff, 1 << 1]);
    expect(r.gprRead(4095)).toBe(0);
  });

  it('rejects out-of-range registers like libbluray', () => {
    const r = new RegisterFile();
    expect(r.gprWrite(4096, 1)).toBe(-1);
    expect(r.psrRead(128)).toBe(0xffffffff); // bd_psr_read returns (uint32_t)-1 for an invalid PSR
    expect(r.gprRead(4096)).toBe(0);           // bd_gpr_read returns 0 for an invalid GPR
  });

  it('reports write and change events and logs every write for traces', () => {
    const r = new RegisterFile();
    const events: PsrEvent[] = [];
    const writes: RegisterWrite[] = [];
    r.onPsrEvent((e) => events.push(e));
    r.onWrite = (w) => writes.push(w);
    r.psrWrite(PSR.SELECTED_BUTTON_ID, 3);
    r.psrWrite(PSR.SELECTED_BUTTON_ID, 3);
    r.gprWrite(7, 9);
    // bd_psr_setting_write: one event per write, CHANGE when the value differs, WRITE when it is the same
    expect(events.map((e) => [e.type, e.psr, e.oldValue, e.newValue])).toEqual([
      ['change', 10, 0xffff, 3], ['write', 10, 3, 3],
    ]);
    expect(writes).toEqual([{ kind: 'psr', index: 10, value: 3 }, { kind: 'psr', index: 10, value: 3 }, { kind: 'gpr', index: 7, value: 9 }]);
  });

  it('refuses player-setting PSRs through psrWrite (-2) but allows psrSettingWrite', () => {
    const r = new RegisterFile();
    expect(r.psrWrite(PSR.REGION, 4)).toBe(-2);
    expect(r.psrSettingWrite(PSR.REGION, 4)).toBe(0);
    expect(r.psrRead(PSR.REGION)).toBe(4);
  });

  it('saves playback PSRs to the backup registers and restores them', () => {
    const r = new RegisterFile();
    r.psrWrite(PSR.TITLE_NUMBER, 2); r.psrWrite(PSR.PLAYLIST, 5); r.psrWrite(PSR.SELECTED_BUTTON_ID, 4);
    r.saveState();
    r.psrWrite(PSR.TITLE_NUMBER, 0); r.psrWrite(PSR.PLAYLIST, 1);
    r.restoreState();
    expect([r.psrRead(PSR.TITLE_NUMBER), r.psrRead(PSR.PLAYLIST), r.psrRead(PSR.SELECTED_BUTTON_ID)]).toEqual([2, 5, 4]);
  });
});
```


```ts
// uo-mask.test.ts
import { describe, expect, it } from 'vitest';
import { EMPTY_UO_MASK, combineUoMasks, parseUoMaskTable } from './uo-mask';

describe('UO masks', () => {
  it('parses the 64-bit table in uo_mask.h order', () => {
    const t = new Uint8Array(8);
    t[0] = 0x80;          // first bit: menu_call
    t[0] |= 0x08;         // fifth bit: skip_to_next_point
    expect([...parseUoMaskTable(t)].sort()).toEqual(['menuCall', 'skipToNextPoint']);
  });

  it("decodes HDMV_DISC_A's menu playlist mask 3cb805ff40000000", () => {
    const t = Uint8Array.of(0x3c, 0xb8, 0x05, 0xff, 0x40, 0, 0, 0);
    expect([...parseUoMaskTable(t)].sort()).toEqual([
      'angleChange', 'backwardPlay', 'chapterSearch', 'forwardPlay', 'pauseOn', 'pgChange', 'pgEnableDisable', 'pipPgChange',
      'popupOff', 'popupOn', 'primaryAudioChange', 'secondaryAudioChange', 'secondaryAudioEnableDisable', 'secondaryVideoChange',
      'secondaryVideoEnableDisable', 'skipBackToPreviousPoint', 'skipToNextPoint', 'stillOff', 'timeSearch',
    ].sort());
  });

  it('combines masks as a union', () => {
    const a = parseUoMaskTable(Uint8Array.of(0x80, 0, 0, 0, 0, 0, 0, 0));
    expect([...combineUoMasks(a, EMPTY_UO_MASK)]).toEqual(['menuCall']);
  });
});
```

Bit order (`bdnav/uo_mask.c` `uo_mask_parse`, MSB first): menu_call, title_search, chapter_search, time_search, skip_to_next_point, skip_to_prev_point, play_firstplay, stop, pause_on, pause_off, still_off, forward, backward, resume, move_up, move_down, move_left, move_right, select, activate, select_and_activate, primary_audio_change, *(reserved)*, angle_change, popup_on, popup_off, pg_enable_disable, pg_change, secondary_video_enable_disable, secondary_video_change, secondary_audio_enable_disable, secondary_audio_change, *(reserved)*, pip_pg_change.

- [ ] **Step 2: Run the tests and check that they fail.** Run: `npx vitest run src/engine/hdmv`. Expected: FAIL.
- [ ] **Step 3: Port** `registers.ts` and `uo-mask.ts` from the functions above.
- [ ] **Step 4: Run the tests and check that they pass.** Then run `npm run typecheck`.
- [ ] **Step 5:** Add NOTICE entries (`hdmv/registers.ts from src/libbluray/register.c`; `hdmv/uo-mask.ts from src/libbluray/bdnav/uo_mask*.h`). Commit: `feat(hdmv): player register file and UO masks`.

---

### Task 3: HDMV VM core (operands, SET, CMP, GOTO, run loop)

**Files:** Create `src/engine/hdmv/vm.ts`. Test: `src/engine/hdmv/vm.test.ts`.

**Port** (`hdmv/hdmv_vm.c`):
- `_is_valid_reg`, `_store_reg`, `_read_reg`, `_read_setstream_regs`, `_read_setbuttonpage_reg`, `_store_result`, `_fetch_operand`, `_fetch_operands`
- `RAND_u32`, `ADD_u32`, `MUL_u32`
- `_hdmv_step` (all groups; the BRANCH/JUMP/PLAY and SETSYSTEM cases call methods implemented in Task 4, which are stubs here that return `-1`)
- the event queue (`_get_event`, `_queue_event`, `_queue_event2`, five slots)
- `_vm_run` with `MAX_LOOP = 1000000`, plus `hdmv_vm_run`, `hdmv_vm_get_event` and `hdmv_vm_running`

**Interfaces (produces):**
```ts
export const HdmvEventType = { NONE: 0, END: 1, IG_END: 2, TITLE: 3, PLAY_PL: 4, PLAY_PL_PM: 5, PLAY_PL_PI: 6, PLAY_PI: 7, PLAY_PM: 8, PLAY_STOP: 9, STILL: 10, SET_BUTTON_PAGE: 11, ENABLE_BUTTON: 12, DISABLE_BUTTON: 13, POPUP_OFF: 14 } as const;
export type HdmvEventType = (typeof HdmvEventType)[keyof typeof HdmvEventType];
export interface HdmvEvent { readonly type: HdmvEventType; readonly param: number; readonly param2: number }
export interface HdmvVmOptions { readonly numTitles: number; readonly firstPlay: boolean; readonly topMenu: boolean; readonly seed?: number }
export class HdmvVm {
  constructor(objects: MovieObjects, regs: RegisterFile, opts: HdmvVmOptions);
  selectObject(id: number): number;                   // hdmv_vm_select_object
  setObject(cmds: readonly MobjCmd[]): number;        // hdmv_vm_set_object (button commands)
  run(): HdmvEvent | null;                            // hdmv_vm_run; null = error (-1)
  nextEvent(): HdmvEvent | null;                      // hdmv_vm_get_event; null when the queue is empty
  running(): boolean;                                 // hdmv_vm_running
  uoMask(): number;                                   // hdmv_vm_get_uo_mask: bit 0 menu call, bit 1 title search
  resume(): number;                                   // hdmv_vm_resume
  suspendPlaylist(): number;                          // hdmv_vm_suspend_pl
}
```

- [ ] **Step 1: Write the failing tests.** Put a helper at the top of `vm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { asm, buildMovieObjects, imm, psr, reg } from '../../../tests/helpers/hdmv-builders';
import { parseMovieObjects } from '../bdmv/mobj-parser';
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
```

Then these tests, each derived from `_hdmv_step` semantics:

```ts
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
    expect(m.run()).toBeNull();
    expect(m.running()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail.** Run: `npx vitest run src/engine/hdmv/vm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Port** the functions listed above. Use `bigint` for the 64-bit `rand` state (as the test computes), and `>>> 0` for every `uint32_t`.
- [ ] **Step 4: Run the tests and check that they pass.** Then run `npm run typecheck`.
- [ ] **Step 5:** Add the NOTICE entry (`hdmv/vm.ts from src/libbluray/hdmv/hdmv_vm.c`) and commit: `feat(hdmv): VM core with SET, CMP and GOTO`.

---

### Task 4: HDMV VM branching, playback and system commands

**Files:** Modify `src/engine/hdmv/vm.ts`. Test: `src/engine/hdmv/vm.test.ts`.

**Port** (`hdmv/hdmv_vm.c`):
- `_suspended_at_play_pl`, `_suspend_for_play_pl`, `_resume_from_play_pl`, `_suspend_object`, `_resume_object`
- `_is_valid_title`, `_jump_object`, `_jump_title`, `_call_object`, `_call_title`
- `_play_at`, `_link_at`, `_play_stop`
- `_set_stream`, `_set_sec_stream`, `_set_stream_ss`, `_setsystem_0x10`, `_set_button_page`, `_enable_button`, `_set_still_mode`, `_popup_off`, `_set_output_mode`, `_set_nv_timer` (stores the expiry; `_check_nv_timer` is unused in libbluray and is not ported)
- `_set_object`, `hdmv_vm_set_object`, `hdmv_vm_get_uo_mask`, `hdmv_vm_resume`, `hdmv_vm_suspend_pl`, plus `_free_ig_object` semantics

Replace the Task 3 stubs.

- [ ] **Step 1: Write the failing tests** (append to `vm.test.ts`):

```ts
describe('HdmvVm branching and playback', () => {
  it('PLAY_PL queues the event and suspends; resume() continues after it', () => {
    const { m, regs } = vm([{ cmds: [asm.playPl(imm(5)), asm.set('move', reg(1), imm(1))] }]);
    m.selectObject(0);
    const ev = m.run();
    expect(ev).toEqual({ type: HdmvEventType.PLAY_PL, param: 5, param2: 0 });
    expect(m.running()).toBe(false);
    expect(m.resume()).toBe(0);
    runAll(m);
    expect(regs.gprRead(1)).toBe(1);
  });

  it('PLAY_PL_PI and PLAY_PL_PM carry the item or mark in param2', () => {
    const a = vm([{ cmds: [asm.playPlPi(imm(2), imm(3))] }]);
    a.m.selectObject(0);
    expect(a.m.run()).toEqual({ type: HdmvEventType.PLAY_PL_PI, param: 2, param2: 3 });
    const b = vm([{ cmds: [asm.playPlPm(imm(2), imm(4))] }]);
    b.m.selectObject(0);
    expect(b.m.run()).toEqual({ type: HdmvEventType.PLAY_PL_PM, param: 2, param2: 4 });
  });

  it('JUMP_OBJECT queues PLAY_STOP and starts the other object; an invalid object is an error that keeps the pc', () => {
    const { m, regs } = vm([{ cmds: [asm.jumpObject(imm(1))] }, { cmds: [asm.set('move', reg(1), imm(7))] }]);
    m.selectObject(0);
    expect(runAll(m).map((e) => e?.type)).toContain(HdmvEventType.PLAY_STOP);
    expect(regs.gprRead(1)).toBe(7);
  });

  it('CALL_OBJECT saves PSRs and RESUME returns after the call, restoring them', () => {
    const { m, regs } = vm([
      { cmds: [asm.callObject(imm(1)), asm.set('move', reg(2), imm(2))] },
      { cmds: [asm.set('move', reg(1), imm(1)), asm.resume()] },
    ]);
    regs.psrWrite(4, 3); // title 3 before the call
    m.selectObject(0);
    runAll(m);
    expect([regs.gprRead(1), regs.gprRead(2), regs.psrRead(4)]).toEqual([1, 2, 3]);
  });

  it('JUMP_TITLE validates the title (0 top menu, 0xffff first play, 1..numTitles)', () => {
    const ok = vm([{ cmds: [asm.jumpTitle(imm(2))] }]);
    ok.m.selectObject(0);
    expect(ok.m.run()).toEqual({ type: HdmvEventType.TITLE, param: 2, param2: 0 });
    const bad = vm([{ cmds: [asm.jumpTitle(imm(9)), asm.set('move', reg(1), imm(1))] }]);
    bad.m.selectObject(0);
    runAll(bad.m);
    expect(bad.regs.gprRead(1)).toBe(1); // invalid title is ignored; execution continues
  });

  it('button commands: LINK_PI and SET_BUTTON_PAGE queue events and terminate the IG object', () => {
    const { m } = vm([{ cmds: [asm.playPl(imm(1))] }]);
    m.selectObject(0); m.run(); // now playing playlist 1, suspended in PLAY_PL
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
    m.selectObject(0); m.run();
    expect(m.uoMask()).toBe(0b11);
  });

  it('suspendPlaylist keeps a resumable object only when it has resume intention', () => {
    const keep = vm([{ resumeIntention: true, cmds: [asm.playPl(imm(1))] }]);
    keep.m.selectObject(0); keep.m.run();
    expect(keep.m.suspendPlaylist()).toBe(0);
    const drop = vm([{ resumeIntention: false, cmds: [asm.playPl(imm(1))] }]);
    drop.m.selectObject(0); drop.m.run();
    expect(drop.m.suspendPlaylist()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail.** Run: `npx vitest run src/engine/hdmv/vm.test.ts`. Expected: FAIL in the new block.
- [ ] **Step 3: Port** the functions listed above.
- [ ] **Step 4: Run the tests and check that they pass.** Then run `npm run typecheck`.
- [ ] **Step 5:** Commit: `feat(hdmv): VM branching, playback and system commands`.

---

### Task 5: movie objects, sounds and index titles in the disc model

**Files:**
- Create: `src/engine/bdmv/sound-parser.ts`
- Modify: `src/engine/disc/open-disc.ts`, `tests/helpers/bdmv-builders.ts` (add `buildSoundBdmv`)
- Test: `src/engine/bdmv/sound-parser.test.ts`, `src/engine/disc/open-disc.test.ts`

**Port:** `bdnav/sound_parse.c` (`_sound_parse_attributes`, `_sound_read_samples`, `_sound_parse_index`, `sound_parse`).

**Interfaces (produces):**
```ts
export interface SoundClip { readonly channels: 1 | 2; readonly sampleRate: 48000; readonly samples: Int16Array /* interleaved */ }
export interface SoundData { readonly clips: readonly SoundClip[] }
export function parseSoundBdmv(bytes: Uint8Array): SoundData;  // throws ParseError
// DiscModel gains:
readonly movieObjects: MovieObjects | null;   // null when MovieObject.bdmv is missing or damaged (a warning is added)
readonly sounds: SoundData | null;            // BDMV/AUXDATA/sound.bdmv, null when absent or damaged (no warning)
```

- [ ] **Step 1: Write the failing tests.** `sound-parser.test.ts`: a `buildSoundBdmv([{ channels: 2, samples: Int16Array.of(1, -1, 2, -2) }, { channels: 1, samples: Int16Array.of(5) }])` round-trip, plus a bad-signature `ParseError`. `open-disc.test.ts`:
  1. A disc with `MovieObject.bdmv` (via `buildMovieObjects`) gives `model.movieObjects.objects.length > 0`.
  2. A disc with a corrupt `MovieObject.bdmv` gives `movieObjects: null` and a warning that starts with `MovieObject.bdmv`.
  3. A disc without `AUXDATA` gives `sounds: null` and no warning.
- [ ] **Step 2: Run the tests and check that they fail.**
- [ ] **Step 3: Implement.** Port the sound parser. In `openDisc`, read `BDMV/MOVIEOBJECT.BDMV` and `BDMV/AUXDATA/SOUND.BDMV` (FileSource paths are upper case). Catch `ParseError` as described in the interfaces.
- [ ] **Step 4: Run the tests and check that they pass** (whole `src/engine` suite), then run `npm run typecheck`.
- [ ] **Step 5:** NOTICE entry. Commit: `feat(disc): load movie objects and menu sounds with the disc`.

---

### Task 6: Navigator (headless): titles, VM events, end of playlist, stills, UO masks

**Files:**
- Create: `src/engine/nav/navigator.ts`
- Modify: `src/engine/nav/timeline.ts` (add `markTimeUs(index)` over **all** marks, entry and link, as libbluray's `mark_list`)
- Test: `src/engine/nav/navigator.test.ts`, `timeline.test.ts`

**Port** (`bluray.c`):
- `_play_title`, `_play_hdmv`, `_process_hdmv_vm_event`, `_run_hdmv`
- the VM part of `_read_ext`, including the `loops++ > 100` guard
- end of title: `hdmv_vm_resume` when no next clip
- `_try_menu_call` / `bd_menu_call`
- `_update_uo_mask`, `_update_hdmv_uo_mask`, `_is_uo_masked`
- the PSR updates `_update_playlist_psrs`, `_update_clip_psrs`, `_update_stream_psr_by_lang` and `_update_chapter_psr` (PSR 4, 5, 6, 7 and stream PSRs)
- play-item stills: the `still_mode` / `still_time` handling in `_bd_read_locked` and `bd_read_skip_still`

**Interfaces (produces):**
```ts
export interface PlaybackPort {
  playPlaylist(id: string, at: { readonly item?: number; readonly mark?: number }): Promise<boolean>; // false if the playlist is missing
  seekPlayItem(item: number): void;
  seekMark(mark: number): void;
  stopPlaylist(): void;
  hold(on: boolean): void;                       // still: freeze presentation (clock stops), keep the frame
}
export type NavigatorEvent =
  | { readonly type: 'uoMask'; readonly mask: UoMask }
  | { readonly type: 'menu'; readonly active: boolean }
  | { readonly type: 'popup'; readonly available: boolean }
  | { readonly type: 'sound'; readonly id: number }
  | { readonly type: 'title'; readonly title: number }
  | { readonly type: 'bdjTitle'; readonly title: number }
  | { readonly type: 'error'; readonly message: string };
export interface NavigatorDeps {
  readonly disc: DiscModel;                 // with movieObjects non-null
  readonly regs: RegisterFile;
  readonly port: PlaybackPort;
  emit(event: NavigatorEvent): void;
  nowScr(): number;                         // 90 kHz monotonic, as bd_get_scr()
  readonly seed?: number;
}
export class Navigator {
  constructor(deps: NavigatorDeps);
  start(): void;                            // First Play (_play_title(0xffff))
  playTitle(title: number): boolean;        // bd_play_title with UO check (title search); 0 = top menu
  menuCall(): boolean;                      // _try_menu_call (UO menu call)
  tick(): void;                             // _read_ext VM part + gc NOP (gc added in Task 12)
  playlistStarted(playlistId: string, item: number): void; // from the player: update PSRs 6/7, playlist UO mask
  playItemChanged(item: number): void;
  chapterChanged(chapter: number): void;
  playlistEnded(): void;                    // still handling, then hdmv_vm_resume
  isMasked(op: UoOp): boolean;
  readonly uoMask: UoMask;
  stop(): void;                             // disc closed or a raw playlist picked: drop VM/program state
}
```

- [ ] **Step 1: Write the failing tests** with a `FakePort` recording calls, and discs built by `buildSyntheticDisc` plus `buildMovieObjects` (index First Play → object 0, Top Menu → object 1, titles → objects 2 and 3):

```ts
// helpers inside navigator.test.ts
class FakePort implements PlaybackPort {
  calls: string[] = [];
  missing = new Set<string>();
  async playPlaylist(id: string, at: { item?: number; mark?: number }) { this.calls.push(`play ${id} ${at.item ?? '-'} ${at.mark ?? '-'}`); return !this.missing.has(id); }
  seekPlayItem(i: number) { this.calls.push(`item ${i}`); }
  seekMark(m: number) { this.calls.push(`mark ${m}`); }
  stopPlaylist() { this.calls.push('stop'); }
  hold(on: boolean) { this.calls.push(`hold ${on}`); }
}
```

Tests:
1. `start()` runs First Play: an object `[playPl(imm(0))]` → `calls` = `['play 00000 - -']` and PSR4 = `0xffff`.
2. A title jump: First Play `[jumpTitle(imm(1))]`, title 1 → object 2 `[playPlPm(imm(0), imm(1))]` → `['play 00000 - 1']`, PSR4 = 1, and a `{ type: 'title', title: 1 }` event.
3. End of playlist resumes the program: First Play `[playPl(imm(0)), playPl(imm(1))]`. After `playlistEnded()` → `['play 00000 - -', 'play 00001 - -']`.
4. A missing playlist resumes the VM (libbluray's `hdmv_num_invalid_pl` < 10): `port.missing = {'00000'}` → the program continues to its next command.
5. The infinite-loop guard (**Review Focus 1**): First Play `[jumpTitle(imm(1))]` and title 1 `[jumpTitle(imm(1))]` (never suspends). `tick()` returns with an `error` event within one call and `running` stops; no hang (the test has a 2 s timeout).
6. `menuCall()` with `menuCallMask` set on the playing object → refused (`false`), no top-menu jump. Without the mask → Top Menu runs (object 1).
7. Play-item still: a playlist whose last play item has `stillMode` 1 (time) and `stillTime` 2. `playlistEnded()` → `hold true`. After `nowScr` advances 2 s × 90 000 and `tick()` → `hold false`, then the VM resumes. With `stillMode` 2 (infinite) there's no automatic resume.
8. UO masks: a playlist with a `timeSearch` bit → `isMasked('timeSearch')` is true after `playlistStarted`, and a `uoMask` event is emitted once.
9. A BD-J title in the index → a `bdjTitle` event and no VM run.

The `Timeline.markTimeUs(index)` tests: on a playlist with entry and link marks, the index counts all marks.

- [ ] **Step 2: Run the tests and check that they fail.**
- [ ] **Step 3: Port** the functions listed above into `Navigator`. The graphics-controller calls (`_run_gc`, `_init_ig_stream`) are no-ops until Task 12, so keep a `private gc: null` field.
- [ ] **Step 4: Run the tests and check that they pass.** Then run `npm run typecheck`.
- [ ] **Step 5:** NOTICE entry (`nav/navigator.ts from src/libbluray/bluray.c (HDMV title and navigation parts)`). Commit: `feat(nav): Navigator runs titles and VM programs`.

---

### Task 7: Player integration: boot through First Play, playTitle, PSR-driven audio

**Files:** Modify `src/engine/player.ts`, `src/engine/protocol.ts`, `src/engine/worker.ts`. Test: `src/engine/player.test.ts`.

**Behaviour:**
- After `open`, if `disc.movieObjects` is non-null and the index First Play is HDMV, the player creates a `Navigator` (port implemented by the player) and calls `start()`. Otherwise it is idle at the picker as today.
- The port's `playPlaylist(id, at)` maps to the existing `playPlaylist` path, extended with an optional start. A play item maps to `timeline.items[item].start`, a mark to `timeline.markTimeUs(mark)`.
- `stopPlaylist` tears down the session and keeps the disc open. `hold` freezes the clock and keeps the last frame.
- `Player.tick` calls `navigator.tick()` before presentation.
- At session start and item changes, `navigator.playlistStarted` / `playItemChanged` are called. The chapter PSR follows the existing chapter logic.
- Audio follows PSR1: a PSR1 change event selects that STN audio stream (re-seek, as `selectAudio`). The user's `selectAudio` writes PSR1 (`psrWrite`), and the navigator refuses it when `primaryAudioChange` is masked.
- Picking a raw playlist (`playPlaylist` command) calls `navigator.stop()`, then plays as today. `close` stops the navigator (**Review Focus 5**).
- Pipeline end-of-playlist calls `navigator.playlistEnded()` instead of entering `ended` when a navigator is active.

**Protocol:**
```ts
| { readonly type: 'indexTitles'; readonly titles: ReadonlyArray<{ readonly number: number; readonly kind: 'hdmv' | 'bdj' }>; readonly hasTopMenu: boolean } // after 'titles'
| { readonly type: 'uoMask'; readonly masked: readonly UoOp[] }
| { readonly type: 'menuActive'; readonly active: boolean; readonly popupAvailable: boolean }
// commands
| { readonly type: 'playTitle'; readonly title: number }   // 0 = top menu
| { readonly type: 'menuCall' }
```

- [ ] **Step 1: Write the failing tests** (`player.test.ts`, with a synthetic disc carrying `MovieObject.bdmv`):
  1. `open` boots First Play (`[playPl(imm(0))]`) → the session plays `00000` with no `playPlaylist` command, and events include `indexTitles`.
  2. `playTitle { title: 1 }` → title 1's object plays `00001` at mark 1 (`playPlPm`). Check the first presented frame is at that mark's time ±1 frame.
  3. End of playlist with `[playPl(imm(0)), playPl(imm(1))]` → `00001` starts automatically.
  4. A VM `setStream` to audio stream 2 → `tracks` reports `selectedAudio: 2`.
  5. A picked raw playlist while a VM program is suspended → after it ends there's no further VM playback.
  6. A disc without `MovieObject.bdmv` → behaves exactly as before (existing tests stay green).
- [ ] **Step 2: Run the tests and check that they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and check that they pass** (whole suite), then `npm run typecheck` and `npm run build`.
- [ ] **Step 5:** Commit: `feat(engine): boot HDMV discs through First Play`.

---

## Phase B: the libbluray trace harness (VM)

### Task 8: harness, `disc-vm` fixture, golden traces and our replay (VM only)

**Files:**
- Create: `tools/vm-trace/Dockerfile`, `tools/vm-trace/build.sh`, `tools/vm-trace/trace.patch`, `tools/vm-trace/vm_trace.c`, `tools/vm-trace/README.md`
- Create: `scripts/make-vm-disc.ts`, `fixtures/synthetic/disc-vm/**`
- Create: `tests/vm-trace/format.ts`, `tests/vm-trace/script.ts`, `tests/vm-trace/replay.ts`, `tests/vm-trace/compare.ts`, `tests/vm-trace/golden/disc-vm.*.jsonl`, `tests/vm-trace/scripts/disc-vm.*.keys`, `tests/vm-trace/vm-trace.test.ts`
- Create: `.github/workflows/vm-trace.yml`
- Modify: `package.json` (`vm-trace:build`, `vm-trace:golden`, `vm-trace`)

**Trace format** (`tests/vm-trace/format.ts`, one JSON object per line):
```ts
export type TraceEntry =
  | { k: 'gpr' | 'psr'; i: number; v: number; t?: number }           // register writes (PSR 8 TIME excluded on both sides: time-dependent)
  | { k: 'title'; v: number; t?: number } | { k: 'playlist'; v: number; t?: number } | { k: 'playitem'; v: number; t?: number } | { k: 'chapter'; v: number; t?: number }
  | { k: 'menu' | 'popup'; v: 0 | 1; t?: number } | { k: 'uo'; v: string /* hex of libbluray compressed mask */; t?: number } | { k: 'sound'; v: number; t?: number } | { k: 'still'; v: 0 | 1; t?: number }
  | { k: 'step'; n: number; plane?: string /* IG plane hash, Task 13 */ } | { k: 'end'; why: 'eof' | 'error' | 'limit' };
```

**Script format** (`tests/vm-trace/script.ts` parses it; both sides use it). One step per line, `#` for comments:
- `wait title N`, `wait playlist N`, `wait menu`, `wait popup`, `wait end`
- `key up|down|left|right|ok|0..9|topmenu|popup`
- `mouse X Y` (move) and `click X Y`
- `play title N`

Every step emits `{ k: 'step', n }` after it completes, so divergences are located by step.

**Harness** (`vm_trace.c`):
- `bd_open`, `bd_get_event`, `bd_register_overlay_proc` (records IG overlay operations into an in-memory palette plane for Task 13; registering it also enables the graphics controller), then `bd_play()`.
- A loop of `bd_read_ext(buf, 6144, &ev)` that translates `BD_EVENT_*` into entries and executes script steps when their `wait` condition is met. Keys map to `bd_user_input(bd, -1, BD_VK_*)`, mouse to `bd_mouse_select`, `play title` to `bd_play_title`.
- It exits after the last step plus 200 more reads, or at EOF/error, or after 10 000 000 reads (`limit`).
- `trace.patch` makes three changes:
  - In `register.c`, a global `void (*bd_trace_write_cb)(int psr, int reg, uint32_t val)` called from `bd_gpr_write` and from the PSR write path for every successful write.
  - In `hdmv_vm.c`, `p->rand = 1` always, for determinism.
  - In `util/time.c`, `bd_get_scr()` returns a counter advanced by 1800 (20 ms at 90 kHz) per `bd_read_ext` call. This makes timers deterministic: the harness exports `void bd_trace_tick(void)`.
- `build.sh`: Docker (`ubuntu:24.04` pinned by digest, `linux/amd64`). It installs `build-essential autoconf automake libtool pkg-config git`, clones libbluray at `448f896`, applies the patch, runs `./bootstrap && ./configure --disable-shared --disable-bdjava-jar --without-freetype --without-libxml2 --without-fontconfig --disable-examples`, runs `make`, and compiles `vm_trace.c` statically into `tools/vm-trace/out/vm_trace` (gitignored). The disc is mounted read-only at run time: `npm run vm-trace:golden` runs it on the synthetic discs and writes `tests/vm-trace/golden/*.jsonl`.

**Our replay** (`replay.ts`):
- Opens the disc with `openDisc` over an fd-backed `FileSource` (reuse the `fileBlob` helper from `tests/local/real-discs.test.ts`; move it to `tests/helpers/file-blob.ts`).
- Runs the `Navigator` with `seed: 1`, a `nowScr` advancing 1800 per simulated read step, and a `PlaybackPort` that simulates playback: playlist time advances by the duration of 6144 bytes at the clip's mux rate per step (`clpi` `TS_recording_rate`; fall back to 48 Mbit/s); play items and chapters change as time crosses them; the end of the playlist calls `playlistEnded`.
- `RegisterFile.onWrite` writes `gpr`/`psr` entries (skipping PSR 8), and the navigator events and port calls write the others.

**Compare** (`compare.ts`): entry by entry on `k` and its values, ignoring `t`. The first mismatch throws with the step number and five entries of context on each side.

**`disc-vm`** (`scripts/make-vm-disc.ts`, reusing `buildSyntheticDisc` with 2 s clips): playlists `00000`–`00002`.
- First Play:
  - sets GPRs with every SET op;
  - compares and branches;
  - `callObject(4)`, where object 4 does `rnd` and `resume`;
  - `playPl(0)`;
  - `jumpTitle(1)`.
- Title 1: `playPlPi(1, 1)`, then `playPlPm(2, 1)`, then `jumpTitle(2)`.
- Title 2: `setStream` audio 1, then `playPl(0)`, then `jumpObject(5)` → end.
- Scripts: `disc-vm.boot.keys` (`wait end`) and `disc-vm.title2.keys` (`play title 2`, `wait end`).

- [ ] **Step 1:** Write `scripts/make-vm-disc.ts` and generate `fixtures/synthetic/disc-vm` (append it to `fixture:synthetic`).
- [ ] **Step 2:** Write `tools/vm-trace/*`, pin the Ubuntu digest (`docker pull --platform linux/amd64 ubuntu:24.04` then `docker inspect`), run `npm run vm-trace:build`, then `npm run vm-trace:golden`. Expected: two non-empty golden files that start with First Play's `psr 4 65535`.
- [ ] **Step 3: Write the failing test** `tests/vm-trace/vm-trace.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareTraces } from './compare';
import { parseTrace } from './format';
import { replay } from './replay';

const GOLDEN = new URL('./golden/', import.meta.url);
const SCRIPTS = new URL('./scripts/', import.meta.url);

describe('libbluray trace parity', () => {
  for (const name of readdirSync(GOLDEN).filter((f) => f.endsWith('.jsonl'))) {
    it(`matches libbluray: ${name}`, async () => {
      const [disc, script] = name.replace('.jsonl', '').split('.');
      const ours = await replay(new URL(`../../fixtures/synthetic/${disc}`, import.meta.url), readFileSync(new URL(`${disc}.${script}.keys`, SCRIPTS), 'utf8'));
      expect(() => compareTraces(parseTrace(readFileSync(new URL(name, GOLDEN), 'utf8')), ours)).not.toThrow();
    }, 60_000);
  }
});
```

Add `tests/vm-trace/**/*.test.ts` to Vitest's `include` in `vite.config.ts`.

- [ ] **Step 4:** Run `npx vitest run tests/vm-trace` and check that it fails until `replay.ts` and `compare.ts` exist. Then implement them, and run again until it passes. A real divergence is a VM or Navigator porting bug: fix it in the ported code and record it in the report. Never edit a golden file by hand.
- [ ] **Step 5:** Add `.github/workflows/vm-trace.yml` (paths `tools/vm-trace/**`, `scripts/make-vm-disc.ts`, `scripts/make-menu-disc.ts`, `fixtures/synthetic/disc-vm/**`, `fixtures/synthetic/disc-menu/**`, `.github/workflows/vm-trace.yml`). It runs `npm run vm-trace:build && npm run vm-trace:golden && git diff --exit-code tests/vm-trace/golden/`. Add `npm run vm-trace -- <disc> <script>` to run both sides live and compare (prints the first divergence).
- [ ] **Step 6:** Commit: `test(vm-trace): libbluray trace harness and VM parity on disc-vm`.

---

## Phase C: interactive graphics

### Task 9: IG segments and the interactive composition decoder

**Files:** Create `src/engine/graphics/segments.ts`, `src/engine/graphics/ig-decoder.ts`, `tests/helpers/ig-builders.ts`. Tests: `segments.test.ts`, `ig-decoder.test.ts`.

**Port:**
- `decoders/graphics_processor.c`: `_join_fragments`, `_join_segment_fragments`, `_decode_ods`, `_decode_pds`, `_check_epoch_start`, `_decode_ics`, `_decode_segment`, `graphics_processor_decode_pes`. The TS packet layer `graphics_processor_decode_ts` is replaced by our PES units.
- `decoders/ig_decode.c`: all of it.
- The `pg.h` / `ig.h` structures as readonly TS interfaces.

**Interfaces (produces):**
```ts
export interface PgPaletteEntry { readonly y: number; readonly cr: number; readonly cb: number; readonly t: number }
export interface PgPalette { readonly id: number; readonly version: number; readonly entries: readonly PgPaletteEntry[] /* 256 */ }
export interface RleElem { readonly len: number; readonly color: number }
export interface PgObject { readonly id: number; readonly version: number; readonly width: number; readonly height: number; readonly img: readonly RleElem[] }
export interface IgButton { /* fields of BD_IG_BUTTON, camelCase */ readonly id: number; readonly numericSelectValue: number; readonly autoActionFlag: boolean; readonly x: number; readonly y: number; readonly upper: number; readonly lower: number; readonly left: number; readonly right: number; readonly normalStart: number; readonly normalEnd: number; readonly normalRepeat: boolean; readonly selectedSound: number; readonly selectedStart: number; readonly selectedEnd: number; readonly selectedRepeat: boolean; readonly activatedSound: number; readonly activatedStart: number; readonly activatedEnd: number; readonly navCmds: readonly MobjCmd[] }
export interface IgBog { readonly defaultValidButton: number; readonly buttons: readonly IgButton[] }
export interface IgPage { readonly id: number; readonly version: number; readonly uoMask: UoMask; readonly inEffects: IgEffectSequence; readonly outEffects: IgEffectSequence; readonly animationFrameRateCode: number; readonly defaultSelectedButton: number; readonly defaultActivatedButton: number; readonly paletteId: number; readonly bogs: readonly IgBog[] }
export interface IgComposition { readonly streamModel: number; readonly uiModel: 0 | 1; readonly compositionTimeoutPts: number; readonly selectionTimeoutPts: number; readonly userTimeoutDuration: number; readonly pages: readonly IgPage[] }
export interface IgDisplaySet { readonly pts: number; readonly epochStart: boolean; readonly composition: IgComposition | null; readonly palettes: ReadonlyMap<number, PgPalette>; readonly objects: ReadonlyMap<number, PgObject>; readonly complete: boolean }
export class IgSegmentDecoder {           // graphics_processor for IG
  push(payload: Uint8Array, pts: number, dts: number | null): IgDisplaySet | null; // a completed display set (END segment), else null
  reset(): void;
  errors: number;                          // corrupt segments dropped
}
// tests/helpers/ig-builders.ts
export function pdsSegment(id: number, version: number, entries: Array<[index: number, y: number, cr: number, cb: number, t: number]>): Uint8Array;
export function odsSegment(id: number, version: number, width: number, height: number, rows: number[][] /* palette indices */): Uint8Array[]; // fragmented if large
export function icsSegment(spec: IcsSpec): Uint8Array[];
export function endSegment(): Uint8Array;
export interface IcsSpec { width?: number; height?: number; compositionNumber?: number; compositionState: 'epochStart' | 'acquisition' | 'normal'; uiModel: 'alwaysOn' | 'popup'; userTimeout?: number; pages: Array<{ id: number; defaultSelected: number; defaultActivated?: number; paletteId: number; uoMask?: Uint8Array; bogs: Array<{ defaultValid: number; buttons: Array<{ id: number; x: number; y: number; neighbours?: [up: number, down: number, left: number, right: number]; normal: [start: number, end: number]; selected: [start: number, end: number]; activated: [start: number, end: number]; selectedSound?: number; activatedSound?: number; autoAction?: boolean; numericValue?: number; cmds: Uint8Array[] }> }> }> }
```

- [ ] **Step 1: Write the failing tests.**
  - The builders round-trip: an ICS with 2 pages, 2 BOGs and 3 buttons, with neighbour links and two commands, decodes to the same values.
  - An ODS larger than one segment is joined from fragments.
  - A PDS sets entries.
  - A display set completes only at END.
  - An epoch start clears earlier objects.
  - A truncated ICS increments `errors` and returns `null` (**spec §6 corrupt IG**).
- [ ] **Step 2: Run the tests and check that they fail.** **Step 3: Port.** **Step 4: Run the tests and check that they pass**, then typecheck. **Step 5:** NOTICE entries. Commit: `feat(graphics): IG segment and composition decoding`.

---

### Task 10: RLE, palette and the overlay plane

**Files:** Create `src/engine/graphics/rle.ts`, `src/engine/graphics/palette.ts`, `src/engine/graphics/overlay-plane.ts`. Tests alongside.

**Port:** `decoders/rle.c` (`rle_crop_object` and decoding as in `graphics_processor.c` `_decode_ods`, already producing `RleElem[]`). The overlay command semantics come from `decoders/overlay.h`.

**Interfaces (produces):**
```ts
// rle.ts
export function cropRle(img: readonly RleElem[], width: number, x: number, y: number, w: number, h: number): RleElem[]; // rle_crop_object
// palette.ts: BT.709 limited range to sRGB, as players present libbluray's YCbCr palettes
export function paletteToRgba(entries: readonly PgPaletteEntry[]): Uint32Array; // 256 × 0xAABBGGRR (little-endian ImageData order)
// overlay-plane.ts
export type OverlayCmd = 'init' | 'close' | 'clear' | 'draw' | 'wipe' | 'hide' | 'flush';
export interface OverlayOp { readonly cmd: OverlayCmd; readonly pts: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly palette?: readonly PgPaletteEntry[]; readonly img?: readonly RleElem[]; readonly paletteUpdate?: boolean }
export class OverlayPlane {                // 1920×1080, one palette entry (Y, Cr, Cb, T) per pixel
  constructor(width?: number, height?: number);
  apply(op: OverlayOp): void;              // draw decodes RLE at (x, y); wipe/clear set T = 0; init/close reset
  dirty(): { x: number; y: number; w: number; h: number } | null; // union of changes since takeDirty
  takeDirty(): { x: number; y: number; w: number; h: number } | null;
  rgba(rect: { x: number; y: number; w: number; h: number }): Uint8ClampedArray; // for ImageData
  hash(): string;                          // FNV-1a 64-bit hex over Y,Cr,Cb,T of every pixel: the trace plane hash
}
```

- [ ] **Step 1: Write the failing tests.**
  - `paletteToRgba` maps `(Y=235, Cr=128, Cb=128, T=255)` to opaque white and `(16, 128, 128, 255)` to opaque black. `T=0` gives alpha 0.
  - A `draw` of a 3×2 RLE image at (10, 20) followed by `flush` gives a dirty rect of exactly that area and a changed `hash()`.
  - `wipe` of the same area restores the original hash.
  - `cropRle` of a 4×2 image to its right 2×1 matches a hand-computed RLE.
- [ ] **Step 2: Run them and check that they fail.** **Step 3: Implement.** **Step 4: Run them and check that they pass.** **Step 5:** NOTICE (`graphics/rle.ts from src/libbluray/decoders/rle.c`). Commit: `feat(graphics): RLE, palette and overlay plane`.

---

### Task 11: graphics controller

**Files:** Create `src/engine/graphics/graphics-controller.ts`. Test: `graphics-controller.test.ts`.

**Port:** `decoders/graphics_controller.c`, everything except TextST and PG. This means:
- `_find_*` helpers, `_areas_overlap`, `_is_button_enabled`
- `_find_selected_button_id`, `_reset_user_timeout`, `_save_page_state`, `_restore_page_state`, `_reset_page_state`
- `_open_osd`, `_close_osd`, `_flush_osd`, `_hide_osd`, `_clear_osd_area`, `_clear_osd`, `_clear_bog_area`
- `_render_object`, `_render_composition_object`, `_render_rle`
- `_select_button`, `_select_page`, `_gc_reset`, `_process_psr_event`
- `_render_button`, `_render_ig_composition_object`, `_render_effect`, `_render_page`
- `_user_input`, `_set_button_page`, `_enable_button`, `_update_selected_button`, `_mouse_move`, `_animate`, `_run_timers`
- `gc_run` for the IG controls, and the IG branch of `gc_decode_ts` (display-set handling and page-state save and restore, called with a decoded `IgDisplaySet`)
- The BD_VK key codes from `keys.h`.

**Interfaces (produces):**
```ts
export const BdVk = { D0: 0, D1: 1, D2: 2, D3: 3, D4: 4, D5: 5, D6: 6, D7: 7, D8: 8, D9: 9, ROOT_MENU: 10, POPUP: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, ENTER: 16, MOUSE_ACTIVATE: 17, NONE: 0xffff } as const; // keys.h
export type GcCtrl = 'initMenu' | 'nop' | 'reset' | 'vkKey' | 'mouseMove' | 'enableButton' | 'disableButton' | 'setButtonPage' | 'popup' | 'igEnd';
export const GcStatus = { NONE: 0, POPUP: 1, MENU_OPEN: 2, ANIMATE: 4 } as const;
export interface GcNavCmds { readonly navCmds: readonly MobjCmd[] | null; readonly soundId: number /* -1 none */; readonly status: number; readonly pageUoMask: UoMask; readonly wantMouse: boolean }
export interface GraphicsControllerDeps { readonly regs: RegisterFile; onOverlay(op: OverlayOp): void; nowScr(): number }
export class GraphicsController {
  constructor(deps: GraphicsControllerDeps);
  decodeDisplaySet(ds: IgDisplaySet): boolean;     // gc_decode_ts IG branch; true when a new composition was taken
  run(ctrl: GcCtrl, param?: number): { readonly result: number; readonly cmds: GcNavCmds };
  hitTest(x: number, y: number): number | null;    // button id under (x, y) on the shown page (for the cursor), from _mouse_move's search
}
```

- [ ] **Step 1: Write the failing tests** with menus built by `ig-builders.ts`, fed through `IgSegmentDecoder`, and a recording `onOverlay`:
  1. `initMenu` on an always-on composition: PSR11 = page 0, PSR10 = the default selected button, overlay operations `init`, `draw` × buttons, `flush`. `status & MENU_OPEN`.
  2. Neighbour navigation: `vkKey DOWN` selects the `lower` button (PSR10 changes, the selected-state object is drawn). `vkKey RIGHT` with `right = 0xffff` keeps the selection.
  3. Activation: `vkKey ENTER` returns that button's `navCmds` and `activatedSound`.
  4. Auto-action: selecting an auto-action button returns its commands immediately.
  5. `disableButton` of the selected button moves the selection per `_update_selected_button`. `enableButton` restores it.
  6. `setButtonPage` with the page flag → page 1 is shown with its default button.
  7. Pop-up: on a pop-up composition, `initMenu` keeps it hidden (`status & POPUP`, not `MENU_OPEN`). `vkKey POPUP` shows it, `popup 0` hides it.
  8. `mouseMove` to the centre of a button selects it. Clicking means `vkKey MOUSE_ACTIVATE`, which activates.
  9. A user timeout with the fake `nowScr`: after `userTimeoutDuration` passes, `nop` goes back to page 0 (always-on) or hides the pop-up.
  10. Animation: a button with `selectedStart` ≠ `selectedEnd` advances its object every `frame_interval` as `nowScr` moves on, and `status & ANIMATE` is set.
  11. **Review Focus 3:** `vkKey` or `mouseMove` right after `setButtonPage` to a page whose button IDs differ, and `enableButton` of an unknown ID → no throw, no activation, the selection stays valid.
  12. `hitTest` returns the button ID inside a button's rectangle and `null` outside.
- [ ] **Step 2: Run them and check that they fail.** **Step 3: Port.** **Step 4: Run them and check that they pass**, then typecheck. **Step 5:** NOTICE entry. Commit: `feat(graphics): graphics controller for IG menus`.

---

### Task 12: wiring menus into playback (pipeline, navigator, compositor, telemetry)

**Files:** Modify `src/engine/playback/pipeline.ts`, `src/engine/nav/navigator.ts`, `src/engine/player.ts`, `src/engine/render/compositor.ts`, `src/engine/protocol.ts`. Tests: `pipeline.test.ts`, `navigator.test.ts`, `player.test.ts`, `compositor.test.ts`.

**Behaviour:**
- **Pipeline:** an `ig(unit: PipelineUnit)` sink and `setIgStream(stream: number | null)`. The IG PID comes from `item.stn.ig[stream - 1]`, like audio.
- **Player:** uses the IG stream from PSR0 (IG stream number).
- **Navigator:**
  - Owns an `IgSegmentDecoder` and `GraphicsController` (port of `_run_gc` and `_init_ig_stream` for the main path; IG in sub-paths is out of scope).
  - Queues IG units sorted by playlist PTS and, in `tick(clockUs)`, decodes only units with `pts ≤ clock` (spec §3.3).
  - Runs `nop` each tick. Maps `GcNavCmds` to `vm.setObject`, `menu`/`popup` events, `sound` and the page UO mask.
  - On seek (`resetGraphics()` from the player's `startAt`), clears the queue and decoder state and runs `reset` (**Review Focus 2**).
  - The overlay operations go to an `OverlayPlane`.
- **Compositor:** `drawIg(plane: OverlayPlane)`. After video, if the plane is dirty, copy its dirty rect into a 1920×1080 `OffscreenCanvas` via `putImageData(plane.rgba(rect))`, then `drawImage` that canvas letterboxed with `fitRect(1920, 1080, …)` over the video. `CompositorLike` gains an optional `drawIg?`.
- **Telemetry:** gains `menu: { page: number; selectedButton: number; buttonsDrawn: number } | null` (PSR11, PSR10, draw operations in the last render) and `igErrors`.
- Emit `menuActive` when it changes.

- [ ] **Step 1: Write the failing tests.**
  - The pipeline delivers IG units for the selected IG stream only.
  - The navigator doesn't hand an IG display set whose PTS is ahead of the clock to the controller until the clock reaches it.
  - After `resetGraphics()`, a menu built before the seek isn't drawn again until a new epoch start arrives (**Review Focus 2**).
  - A player test with a synthetic disc carrying an IG stream (built with `ig-builders` and muxed on PID 0x1400 by `buildSyntheticDisc`; extend the builder with `igUnits` per clip) boots into a menu: telemetry `menu.page === 0`, `buttonsDrawn > 0`, `menuActive` emitted.
  - `close` while a menu is shown → the IG plane is cleared and no `menu` telemetry follows (**Review Focus 5**).
  - Compositor: `drawIg` with a dirty plane calls `putImageData` on the IG canvas once and `drawImage` with the fitted rect (use a fake 2D context).
- [ ] **Step 2: Run them and check that they fail.** **Step 3: Implement.** **Step 4: Run them and check that they pass** (whole suite), then `npm run typecheck` and `npm run build`. **Step 5:** Commit: `feat(engine): draw disc menus over the video`.

---

### Task 12b: IG menus in sub-paths (preloaded IG)

*Added during execution (controller ruling R17).* HDMV_DISC_A carries every IG stream in a sub-path, with STN IG entries of `subPath: true` and no IG PID in any main clip. `mpls-parser.ts` does not parse sub-paths, so as planned its menus would never appear and exit criterion 2 would fail.

**Files:**
- Modify: `src/engine/bdmv/mpls-parser.ts` (sub-paths and STN sub-path references), `src/engine/nav/navigator.ts`, `src/engine/disc/open-disc.ts`
- Modify: `tests/helpers/bdmv-builders.ts` and `tests/helpers/synthetic-disc.ts` (sub-paths, IG in a sub-path clip)
- Tests: `mpls-parser.test.ts`, `navigator.test.ts`, `player.test.ts`

**Port:**
- `bdnav/mpls_parse.c`: `_parse_subplayitem`, `_parse_subpath` and the sub-path loop in `_parse_playlist`; the STN stream entry's `subpath_id`/`subclip_id` for `stream_type` 2/3/4 (`_parse_stream`, lines ~130-145); `_parse_subpath_extension` only if needed for IG (it is not needed for HDMV IG).
- `bluray.c`:
  - `_find_ig_stream`, which finds the PID, sub-path and sub-clip from PSR0 and the STN;
  - `_preload_ig_subpath` and `_preload_subpaths`, called at playlist open: the whole sub-path clip is read into memory (`_preload_m2ts`);
  - the sub-path branch of `_init_ig_stream`, which decodes the whole preloaded buffer with no timing gate (`stc = -1`) on every IG initialisation (INIT after a playlist starts, and after a PSR restore).

**Interfaces (produces):**
```ts
// mpls-parser.ts
export interface SubPlayItem { readonly clipId: string; readonly codecId: string; readonly connectionCondition: number; readonly isMultiClip: boolean; readonly stcId: number; readonly inTime: number; readonly outTime: number; readonly syncPlayItemId: number; readonly syncPts: number }
export interface SubPath { readonly type: number; readonly isRepeat: boolean; readonly items: readonly SubPlayItem[] }
// Mpls gains: readonly subPaths: readonly SubPath[]
// StreamEntry gains: readonly subPathId: number; readonly subClipId: number   (0 for main-path entries)
```

**Behaviour:** the Navigator resolves the IG stream with `_find_ig_stream`.
- **Sub-path IG:** at playlist open it reads the sub-path clip's `.m2ts` in full through the disc source, demuxes the IG PID into PES units with the existing `M2tsReader`/`PesAssembler`, and stores them. On every IG initialisation it feeds them all to `IgSegmentDecoder` in stream order with no timing gate, then runs `INIT_MENU`, as libbluray does.
- **Main-path IG:** unchanged; Task 12's pipeline path.

The preloaded buffer is dropped when the playlist closes.

- [ ] **Step 1: Write the failing tests.**
  - The MPLS parser reads sub-paths and sub-play-items, built with an extended `buildMpls` (`subPaths`), and the STN `subPathId`/`subClipId`. Add a cross-check on HDMV_DISC_A in `tests/local` that the IG entry's sub-path resolves to an existing clip.
  - Navigator: a synthetic disc whose IG lives in a sub-path clip (extend `buildSyntheticDisc` with `subPathIg`) boots into the menu with buttons drawn, and the menu survives a PSR restore.
  - Player: the same disc, with telemetry `menu` non-null and `buttonsDrawn > 0`.
- [ ] **Step 2: Run them and check that they fail.** **Step 3: Port and implement.** **Step 4: Run them and check that they pass**, plus `npm run typecheck`, `npm run build` and `npm run test:e2e`. Also check `LOCAL_DISCS`-free behaviour: HDMV_DISC_A opened with a headless Chrome script should report `menu` telemetry within 30 s.
- [ ] **Step 5:** NOTICE entry (mpls sub-path parsing). Commit: `feat(nav): IG menus carried in sub-paths`.

---

## Phase D: menu traces

### Task 13: `disc-menu` fixture, graphics traces and the HDMV_DISC_A script

**Files:**
- Create: `scripts/make-menu-disc.ts`, `fixtures/synthetic/disc-menu/**`, `tests/vm-trace/scripts/disc-menu.*.keys`, `tests/vm-trace/golden/disc-menu.*.jsonl`, `tests/vm-trace/scripts/hdmv_disc_a.menu-to-feature.keys`, `tests/vm-trace/scripts/hdmv_disc_a.popup.keys`
- Modify: `tools/vm-trace/vm_trace.c` (plane hash), `tests/vm-trace/replay.ts`

**`disc-menu`** (built with `ig-builders`):
- First Play → `playPl(00001)`. `00001` is a 10 s menu playlist with an always-on IG composition:
  - page 0 has buttons A (plays title 1) and B (goes to page 1), neighbours linked, B with an animated selected state;
  - page 1 has button C (back to page 0).
- Title 1 plays `00000` (8 s) with a pop-up IG composition: one button that does `popupOff` and `linkMk(1)`.
- A `sound.bdmv` with two short clips, used by A and B.

Scripts:
- `disc-menu.nav.keys`: `wait menu`, `key down`, `key ok`, `wait menu`, `key ok`, `key down`, `key ok`, `wait playlist 0`
- `disc-menu.mouse.keys`: `wait menu`, then `mouse` over B, `click` B, `click` C, `click` A
- `disc-menu.popup.keys`: `play title 1`, `wait playlist 0`, `key popup`, `wait popup`, `key ok`

**Plane hashes:** both sides apply IG overlay operations to an `OverlayPlane` (the harness keeps a C port of `apply`, with the hash identical to `overlay-plane.ts`'s FNV-1a over `Y,Cr,Cb,T`). Each `step` entry carries `plane`. Script steps on animated pages wait for one `nop` boundary, so both sides hash the same animation frame under the deterministic 1800-tick clock.

- [ ] **Step 1:** Write the disc script, generate the fixture, add it to `fixture:synthetic`. Regenerate goldens with `npm run vm-trace:golden`.
- [ ] **Step 2:** Run `npx vitest run tests/vm-trace`. Expected: the new `disc-menu.*` cases run. Fix divergences in the ported graphics controller or navigator until they pass (never edit goldens).
- [ ] **Step 3:** Write the two HDMV_DISC_A scripts by reading the disc's menu (use `npm run vm-trace -- fixtures/local/HDMV_DISC_A <script>` with `wait menu` and the page dump the harness prints with `--dump-pages`, implemented in this task). Run the live comparison. Expected: both match. Record the outcome in the report. This is local only, as the disc is gitignored.
- [ ] **Step 4:** Commit: `test(vm-trace): menu, mouse and pop-up parity with plane hashes`.

---

## Phase E: input and UI

### Task 14: menu keys and pointer input

**Files:**
- Modify: `src/engine/protocol.ts`, `src/engine/player.ts`, `src/engine/nav/navigator.ts`, `src/ui/keyboard.ts`, `src/ui/PlayerScreen.tsx`, `src/player/player-controller.ts`
- Create: `src/ui/pointer.ts`
- Tests: `keyboard.test.ts`, `pointer.test.ts`, `player-controller.test.ts`, `player.test.ts`

**Protocol commands:**
```ts
| { readonly type: 'menuKey'; readonly key: 'up' | 'down' | 'left' | 'right' | 'ok' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'topMenu' | 'popup' }
| { readonly type: 'pointer'; readonly kind: 'move' | 'click'; readonly x: number; readonly y: number } // 1920×1080 menu space
// event
| { readonly type: 'pointerTarget'; readonly button: number | null } // after a pointer move, for the cursor
```

**Behaviour:**
- **Engine:** `menuKey` maps to `bd_user_input` semantics, ported in the navigator as `userInput(key)`: the UO check by `_get_key_uo_index`, then `gc vkKey`. `topMenu` maps to `menuCall`. `popup` is checked against `popupOn`/`popupOff`. `pointer move` maps to `gc mouseMove` and replies with `pointerTarget`; `click` maps to `vkKey MOUSE_ACTIVATE`.
- **Keyboard** (`keyToAction(key, ctx: { menuActive: boolean })`): arrows, Enter and digits become `menuKey` when `menuActive`. `m`/`M` is `topMenu` and `p`/`P` is `popup` always. Otherwise behaviour is unchanged.
- **`pointer.ts`:** `toMenuSpace(clientX, clientY, canvasRect: DOMRect): { x: number; y: number } | null` using `fitRect(1920, 1080, rect.width, rect.height)`. Returns `null` outside the letterboxed picture.
- **`PlayerScreen`:** canvas `pointermove` is throttled to one per animation frame and sends `pointer move` only while `menuActive`. `click` sends `pointer click` while `menuActive`, else toggles play as today. The cursor becomes `pointer` while `pointerTarget.button !== null`.

- [ ] **Step 1: Write the failing tests.**
  - `keyToAction('ArrowDown', { menuActive: true })` gives `{ type: 'menuKey', key: 'down' }`; with `menuActive: false` it's the existing volume action. `'m'` gives `topMenu`.
  - `toMenuSpace` maps the centre of a 1000×1000 canvas rect to (960, 540), and a point in the top letterbox bar to `null`.
  - The controller posts `menuKey`/`pointer` commands.
  - A player test: `menuKey down` then `ok` on the synthetic menu disc activates button A, which starts playlist `00000`.
- [ ] **Step 2: Run them and check that they fail.** **Step 3: Implement.** **Step 4: Run them and check that they pass.** **Step 5:** Commit: `feat: menu keys and pointer input`.

---

### Task 15: UO masks in the UI and enforcement

**Files:** Modify `src/engine/player.ts`, `src/player/player-controller.ts`, `src/ui/ControlBar.tsx`, `src/ui/PlayerScreen.tsx`. Tests: `player.test.ts`, `player-controller.test.ts`.

**Behaviour:**
- **Engine refusals.** The engine refuses masked commands and emits `notice { code: 'uo-masked', message: "The disc doesn't allow this here." }`:

| Command | Masked when |
|---|---|
| `seek` | `timeSearch` |
| `nextChapter` | `skipToNextPoint` |
| `prevChapter` | `skipBackToPreviousPoint` |
| `pause` | `pauseOn` |
| `selectAudio` | `primaryAudioChange` |
| `menuCall` | `menuCall` |
| `playTitle` | `titleSearch` |
| `menuKey` arrows / ok | `moveUp` / `moveDown` / `moveLeft` / `moveRight` / `activate` |

- **Controller.** The snapshot has `uoMask: readonly UoOp[]`. The control bar disables the seek bar, chapter buttons, pause, the audio menu, Top Menu and Pop-up per the mask, each with the tooltip "The disc doesn't allow this here".
- **Keyboard.** `PlayerScreen`'s key handler checks the mask before sending, and shows the same notice locally if masked. The engine check stays authoritative.

- [ ] **Step 1: Write the failing tests.**
  - **Review Focus 4:** a player test with a playlist whose UO mask has `timeSearch` → a `seek` command produces a `uo-masked` notice and no seek (the clock keeps advancing from its position, no `buffering` state).
  - A controller test: a `uoMask` event with `['timeSearch']` makes `controller.isMasked('timeSearch')` true.
- [ ] **Step 2: Run them and check that they fail.** **Step 3: Implement.** **Step 4: Run them and check that they pass.** **Step 5:** Commit: `feat: respect disc UO masks with explanations`.

---

### Task 16: control bar buttons, titles in the picker, on-screen remote

**Files:** Modify `src/ui/ControlBar.tsx`, `src/ui/PlaylistPicker.tsx`, `src/ui/styles.css`, `src/player/player-controller.ts`. Create `src/ui/RemotePad.tsx`. Tests: `player-controller.test.ts`, `tests/e2e` (Task 18).

**Behaviour:**
- **Control bar:** Top Menu (`data-testid="top-menu"`, shown when `indexTitles.hasTopMenu`), Pop-up (`data-testid="popup"`, shown when `popupAvailable`), Titles (`data-testid="titles"`, opens the picker), Remote (`data-testid="remote-toggle"`).
- **Picker:** lists `indexTitles` as "Title N" buttons (`data-testid="title-N"`, BD-J ones disabled with "Needs BD-J") above the playlists. Picking one sends `playTitle`.
- **`RemotePad`:** `role="group"`, `aria-label="Remote control"`, with buttons ↑ ↓ ← → OK 0–9, Top Menu and Pop-up (`data-testid="remote-<key>"`) sending `menuKey`. Visible while toggled on, hidden with the controls. Every button has an `aria-label` ("Up", "OK", "Digit 3"…).
- **Controller:** `playTitle(n)`, `menuKey(key)`, and the snapshot fields `indexTitles`, `menuActive`, `popupAvailable`.

- [ ] **Step 1: Write the failing tests** (controller): `indexTitles` and `menuActive` events populate the snapshot; `playTitle(1)` posts the command; `menuKey('ok')` posts it.
- [ ] **Step 2: Run them and check that they fail.** **Step 3: Implement.** **Step 4: Run them and check that they pass**, then `npm run typecheck`. **Step 5:** Commit: `feat(ui): Top Menu, Pop-up, Titles and an on-screen remote`.

---

### Task 17: menu sound effects

**Files:** Modify `src/engine/player.ts`, `src/engine/protocol.ts`, `src/player/player-controller.ts`, `src/player/audio-output.ts`. Tests: `player.test.ts`, `player-controller.test.ts`.

**Behaviour:**
- After `open`, if `disc.sounds`, the engine emits `soundEffects { clips: ReadonlyArray<{ channels: 1 | 2; samples: Int16Array }> }` once. Navigator `sound` events become `soundEffect { id }`.
- The controller hands clips to `AudioOutputLike.loadEffects(clips)` and ids to `playEffect(id)`.
- `AudioOutput` builds one `AudioBuffer` per clip (48 kHz) and plays it with an `AudioBufferSourceNode` into the existing gain node, so volume and mute apply. An unknown id is ignored.

- [ ] **Step 1: Write the failing tests.**
  - A player test on a disc with `sound.bdmv`: `soundEffects` is emitted once with the right clip count, and activating button A emits `soundEffect { id: 0 }`.
  - A controller test with `FakeAudio` recording `loadEffects`/`playEffect`.
- [ ] **Step 2: Run them and check that they fail.** **Step 3: Implement.** **Step 4: Run them and check that they pass.** **Step 5:** Commit: `feat: play disc menu sounds`.

---

## Phase F: end to end and gate

### Task 18: menus E2E in Chrome

**Files:** Create `tests/e2e/menus.spec.ts`.

Tests on `fixtures/synthetic/disc-menu`, using telemetry `menu` and the shared helpers in `tests/e2e/telemetry.ts`:
1. Opening the disc goes straight to the menu (no picker), with `menu.page === 0` and `buttonsDrawn > 0`.
2. `ArrowDown` then `Enter` reaches page 1 (`menu.page === 1`). `Enter` returns to page 0. `ArrowUp` then `Enter` (button A) starts playlist `00000`, which plays in sync (reuse `collectWindows` / `expectInSync`).
3. Mouse: hovering B selects it (`menu.selectedButton`), and clicking A starts the feature.
4. The remote pad: `remote-toggle`, `remote-down`, `remote-ok` reach page 1.
5. Pop-up: during title 1, `P` shows the pop-up (`popup` button visible, `menu` non-null), and `Enter` closes it and jumps to mark 1.
6. A masked control: on a playlist with a `timeSearch` mask (add one to `disc-menu`'s title 1), the seek bar is disabled and `ArrowRight` shows the "doesn't allow" notice.
7. Sounds: activating A increments a `soundEffects` counter exposed in telemetry (`soundsPlayed`).

- [ ] **Step 1:** Write the spec. **Step 2:** Run `npm run test:e2e -- menus` and fix failures in product code (not in assertions). **Step 3:** Run the full `npm run test:e2e`. **Step 4:** Commit: `test(e2e): disc menus in Chrome`.

---

### Task 19: real-disc gate

**Files:** Modify `tests/e2e/local-discs.spec.ts`.

- For HDMV local discs (`indexTitles` non-empty and not BD-J), the test expects the disc to boot into its menu (`menu` telemetry non-null within 30 s). It then presses `Enter` up to five times or until a playlist longer than 30 minutes is playing, and then runs the existing seek and audio checks.
- For BD-J discs, it expects the picker and the main feature as today.
- Run `LOCAL_DISCS=1 npx playwright test local-discs` and `npm run vm-trace -- fixtures/local/HDMV_DISC_A tests/vm-trace/scripts/hdmv_disc_a.menu-to-feature.keys` (and `hdmv_disc_a.popup.keys`). Expected: all pass. Record the per-disc lines.
- [ ] **Step 1:** Implement. **Step 2:** Run. **Step 3:** Commit: `test(local): HDMV discs boot into their menus`.

---

### Task 20: docs and final verification

**Files:** `docs/superpowers/specs/2026-10-14-m3-hdmv-menus-design.md`, the parent spec §11, `docs/known-issues.md`, `README.md`, `CLAUDE.md`, `src/engine/NOTICE`.

- [ ] **Step 1: The M3 spec.** In §5.4, replace "media times must agree within one frame" with "order and values must match; media times are diagnostic, since libbluray decodes IG as it reads". In §5.2/§5.4, add plane hashes per step. In §3.4, note dirty-rect plane updates. Add the initial-PSR note (libbluray defaults).
- [ ] **Step 2: Known issues.** Add these entries:
  - menu sounds verified on synthetic data only;
  - IG in sub-paths not supported;
  - `composition_timeout_pts`/`selection_timeout_pts` not implemented (as in libbluray);
  - initial PSRs are libbluray's (region B, profile 2).
- [ ] **Step 3: README and CLAUDE.md.**
  - README: `npm run vm-trace:build`, `vm-trace:golden` and `vm-trace` (Docker), and `scripts/fetch-libbluray.sh`.
  - CLAUDE.md: Milestones 1–3 done, the navigator and graphics architecture in two sentences, and the libbluray reference workflow.
- [ ] **Step 4: Final verification.** Run `npm run typecheck && npm test && npm run test:e2e`, then `LOCAL_DISCS=1 npx playwright test local-discs`, then the HDMV_DISC_A `vm-trace` scripts. Paste the results.
- [ ] **Step 5:** Commit: `docs: record milestone 3 HDMV menus`.
