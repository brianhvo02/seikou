import { describe, expect, it } from 'vitest';
import { asm } from '../../../tests/helpers/hdmv-builders';
import { endSegment, icsSegment, odsSegment, pdsSegment, type IcsSpec } from '../../../tests/helpers/ig-builders';
import { RegisterFile } from '../hdmv/registers';
import { BdVk, GcStatus, GraphicsController } from './graphics-controller';
import { IgSegmentDecoder, type IgDisplaySet } from './ig-decoder';
import type { OverlayOp } from '@seikou/pg';

type ButtonSpec = IcsSpec['pages'][number]['bogs'][number]['buttons'][number];

// Object ids double as widths (height 4), so a draw's w tells which object was drawn.
const NONE = 0xffff;
const objectIds = (spec: IcsSpec): number[] => {
  const ids = new Set<number>();
  for (const p of spec.pages) {
    for (const bog of p.bogs) {
      for (const b of bog.buttons) {
        for (const [s, e] of [b.normal, b.selected, b.activated]) {
          for (let i = s; i <= e && s !== NONE && e !== NONE; i++) ids.add(i);
        }
      }
    }
  }
  return [...ids];
};

function button(id: number, x: number, y: number, extra: Partial<ButtonSpec> = {}): ButtonSpec {
  const base = id * 10; // normal base, selected base + 1, activated base + 2
  return {
    id, x, y, normal: [base, base], selected: [base + 1, base + 1], activated: [base + 2, base + 2],
    selectedSound: id + 100, activatedSound: id + 200, cmds: [asm.nop()], ...extra,
  };
}

/** Page 0: buttons 1 (default), 2, 3 in separate bogs, in a column. Page 1: button 5. Page 2: no buttons. */
function menuSpec(over: Partial<IcsSpec> = {}, b1: Partial<ButtonSpec> = {}): IcsSpec {
  return {
    compositionState: 'epochStart',
    uiModel: 'alwaysOn',
    pages: [
      {
        id: 0, defaultSelected: 1, paletteId: 0,
        bogs: [
          { defaultValid: 1, buttons: [button(1, 100, 100, { neighbours: [NONE, 2, 1, 1], cmds: [asm.nop(), asm.goto(7)], ...b1 })] },
          { defaultValid: 2, buttons: [button(2, 100, 200, { neighbours: [1, 3, 2, 2] })] },
          { defaultValid: 3, buttons: [button(3, 100, 300, { neighbours: [2, 3, 3, 3] })] },
        ],
      },
      { id: 1, defaultSelected: 5, paletteId: 0, bogs: [{ defaultValid: 5, buttons: [button(5, 500, 50, { neighbours: [5, 5, 5, 5] })] }] },
      { id: 2, defaultSelected: 9, paletteId: 0, bogs: [] },
    ],
    ...over,
  };
}

function displaySet(spec: IcsSpec): IgDisplaySet {
  const dec = new IgSegmentDecoder();
  const segs: Uint8Array[] = [
    ...icsSegment(spec),
    pdsSegment(0, 0, [[1, 100, 128, 128, 255]]),
    ...objectIds(spec).flatMap((id) => odsSegment(id, 0, id, 4, Array.from({ length: 4 }, () => new Array<number>(id).fill(1)))),
    endSegment(),
  ];
  let set: IgDisplaySet | null = null;
  for (const s of segs) set = dec.push(s, 5000, null) ?? set;
  return set!;
}

function setup(spec: IcsSpec = menuSpec()) {
  const regs = new RegisterFile();
  const ops: OverlayOp[] = [];
  const clock = { now: 0 };
  const gc = new GraphicsController({ regs, onOverlay: (op) => ops.push(op), nowScr: () => clock.now });
  expect(gc.decodeDisplaySet(displaySet(spec))).toBe(true);
  return { gc, regs, ops, clock, take: () => ops.splice(0) };
}

const draws = (ops: OverlayOp[]): Array<[x: number, y: number, w: number]> =>
  ops.filter((o) => o.cmd === 'draw').map((o) => [o.x, o.y, o.w]);
const cmdsOf = (ops: OverlayOp[]): string[] => ops.map((o) => o.cmd);

describe('GraphicsController', () => {
  it('initMenu on an always-on menu opens the plane and draws every button', () => {
    const { gc, regs, ops } = setup();
    const { cmds } = gc.run('initMenu');
    expect(regs.psrRead(11)).toBe(0);
    expect(regs.psrRead(10)).toBe(1);
    expect(cmdsOf(ops)).toEqual(['init', 'draw', 'draw', 'draw', 'flush']);
    expect(ops[0]).toMatchObject({ cmd: 'init', pts: -1, x: 0, y: 0, w: 1920, h: 1080 });
    expect(draws(ops)).toEqual([[100, 100, 11], [100, 200, 20], [100, 300, 30]]); // 1 selected, 2 and 3 normal
    expect(ops[1]).toMatchObject({ pts: -1, h: 4, paletteUpdate: false });
    expect(ops[1]!.palette![1]).toEqual({ y: 100, cr: 128, cb: 128, t: 255 });
    expect(ops[1]!.img!.length).toBeGreaterThan(0);
    expect(ops[4]).toMatchObject({ cmd: 'flush', pts: -1 });
    expect(cmds.status & GcStatus.MENU_OPEN).toBeTruthy();
    expect(cmds.status & GcStatus.POPUP).toBe(0);
    expect(cmds.navCmds).toBeNull();
    expect(cmds.soundId).toBe(-1);
  });

  it('navigates with the neighbour references', () => {
    const { gc, regs, take } = setup();
    gc.run('initMenu');
    take();
    const r = gc.run('vkKey', BdVk.DOWN);
    expect(r.result).toBe(1);
    expect(regs.psrRead(10)).toBe(2);
    expect(draws(take())).toEqual([[100, 100, 10], [100, 200, 21]]); // 1 back to normal, 2 selected
    expect(r.cmds.soundId).toBe(102); // selected_sound_id_ref of the new button

    // RIGHT where right points at the button itself keeps the selection
    const same = gc.run('vkKey', BdVk.RIGHT);
    expect(same.result).toBe(0);
    expect(regs.psrRead(10)).toBe(2);
    expect(take()).toEqual([]);
  });

  it('follows libbluray when a neighbour reference is 0xffff: the selection becomes 0xffff', () => {
    const { gc, regs, take } = setup();
    gc.run('initMenu');
    take();
    // button 1 has no upper neighbour (0xffff); _user_input() does not special-case it
    expect(gc.run('vkKey', BdVk.UP).result).toBe(1);
    expect(regs.psrRead(10)).toBe(0xffff);
    expect(draws(take())).toEqual([[100, 100, 10]]);
  });

  it('selects by numeric value', () => {
    const { gc, regs } = setup(menuSpec({}, {}));
    gc.run('initMenu');
    expect(gc.run('vkKey', BdVk.D0).result).toBe(0); // numericValue is 0xffff everywhere
    expect(regs.psrRead(10)).toBe(1);
  });

  it('activates with ENTER and returns the commands and sound', () => {
    const { gc, regs, take } = setup();
    gc.run('initMenu');
    take();
    const r = gc.run('vkKey', BdVk.ENTER);
    expect(r.result).toBe(1);
    expect(r.cmds.navCmds).toHaveLength(2);
    expect(r.cmds.soundId).toBe(201);
    expect(regs.psrRead(10)).toBe(1);
    expect(draws(take())).toEqual([[100, 100, 12]]); // activated object
  });

  it('triggers an auto-action button once, right when it is selected', () => {
    const { gc, take } = setup(menuSpec({}, { autoAction: true }));
    const first = gc.run('initMenu');
    expect(first.cmds.navCmds).toHaveLength(2);
    expect(draws(take())[0]).toEqual([100, 100, 12]); // rendered activated
    const again = gc.run('igEnd');
    expect(again.cmds.navCmds).toBeNull();
  });

  it('holds back the auto action while a single-loop animation is running', () => {
    const { gc, clock } = setup(menuSpec({}, { autoAction: true, activated: [60, 62] }));
    const first = gc.run('initMenu');
    expect(first.cmds.navCmds).toBeNull();
    const fired: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      clock.now += 2136;
      fired.push(gc.run('nop').cmds.navCmds !== null);
    }
    expect(fired).toEqual([false, true, false, false]); // fires once the animation reaches its last object
  });

  it('moves the selection when the selected button is disabled and restores enabling', () => {
    const { gc, regs, take } = setup();
    gc.run('initMenu');
    take();

    gc.run('disableButton', 1);
    expect(regs.psrRead(10)).toBe(0xffff);
    const end = gc.run('igEnd');
    expect(regs.psrRead(10)).toBe(2); // _find_selected_button_id: first valid button
    expect(draws(take())).toEqual([[100, 200, 21]]);
    expect(end.cmds.navCmds).toBeNull();

    gc.run('enableButton', 1); // button 1's group is not the selected one
    expect(regs.psrRead(10)).toBe(2);
    gc.run('igEnd');
    expect(draws(take())).toEqual([[100, 100, 10]]);

    gc.run('enableButton', 2); // the selected button's own group: marks PSR10 for _update_selected_button
    expect(regs.psrRead(10)).toBe(0x10002);
    gc.run('igEnd');
    expect(regs.psrRead(10)).toBe(2);
  });

  it('setButtonPage with the page flag shows page 1 with its default button', () => {
    const { gc, regs, take } = setup();
    gc.run('initMenu');
    take();
    const r = gc.run('setButtonPage', (0x80000000 | (1 << 16)) >>> 0);
    expect(regs.psrRead(11)).toBe(1);
    expect(regs.psrRead(10)).toBe(5);
    expect(cmdsOf(take())).toEqual(['clear', 'draw', 'flush']);
    expect(r.cmds.status & GcStatus.MENU_OPEN).toBeTruthy();
    // the current page is ignored
    gc.run('setButtonPage', (0x80000000 | (1 << 16)) >>> 0);
    expect(take()).toEqual([]);
  });

  it('shows a pop-up menu only on request', () => {
    const { gc, regs, take } = setup(menuSpec({ uiModel: 'popup' }));
    const init = gc.run('initMenu');
    expect(take()).toEqual([]);
    expect(init.cmds.status & GcStatus.POPUP).toBeTruthy();
    expect(init.cmds.status & GcStatus.MENU_OPEN).toBe(0);
    expect(regs.psrRead(10)).toBe(1);

    expect(gc.run('vkKey', BdVk.DOWN).result).toBe(-1); // hidden: no input
    const shown = gc.run('vkKey', BdVk.POPUP);
    expect(cmdsOf(take())).toEqual(['init', 'draw', 'draw', 'draw', 'flush']);
    expect(shown.cmds.status & GcStatus.MENU_OPEN).toBeTruthy();

    const hidden = gc.run('popup', 0);
    expect(cmdsOf(take())).toEqual(['close']);
    expect(hidden.cmds.status & GcStatus.MENU_OPEN).toBe(0);
    expect(hidden.cmds.status & GcStatus.POPUP).toBeTruthy();

    gc.run('popup', 1);
    expect(cmdsOf(take())[0]).toBe('init');
    gc.run('vkKey', BdVk.POPUP); // toggles off
    expect(cmdsOf(take())).toEqual(['close']);
  });

  it('selects on mouse move and activates on a click over a button', () => {
    const { gc, regs, take } = setup();
    gc.run('initMenu');
    take();
    // button 2: x 100.., y 200.., selected object is 21 wide and 4 high
    const move = gc.run('mouseMove', (110 << 16) | 202);
    expect(move.result).toBe(1);
    expect(regs.psrRead(10)).toBe(2);
    expect(move.cmds.soundId).toBe(102);
    expect(draws(take())).toEqual([[100, 100, 10], [100, 200, 21]]);

    const click = gc.run('vkKey', BdVk.MOUSE_ACTIVATE);
    expect(click.cmds.navCmds).toHaveLength(1);
    expect(click.cmds.soundId).toBe(202);

    expect(gc.run('mouseMove', (900 << 16) | 900).result).toBe(0);
    expect(gc.run('vkKey', BdVk.MOUSE_ACTIVATE).result).toBe(-1);
  });

  it('runs the user timeout from the injected clock', () => {
    const spec = menuSpec({ userTimeout: 1000 });
    const { gc, regs, clock, take } = setup(spec);
    gc.run('initMenu');
    expect(gc.run('nop').cmds.status & GcStatus.ANIMATE).toBe(0); // page 0, always on: no timeout
    gc.run('setButtonPage', (0x80000000 | (1 << 16)) >>> 0);
    take();
    clock.now = 500;
    expect(gc.run('nop').cmds.status & GcStatus.ANIMATE).toBeTruthy();
    expect(regs.psrRead(11)).toBe(1);
    clock.now = 1001;
    const r = gc.run('nop');
    expect(regs.psrRead(11)).toBe(0);
    expect(regs.psrRead(10)).toBe(1);
    expect(cmdsOf(take())).toEqual(['clear', 'draw', 'draw', 'draw', 'flush']);
    expect(r.cmds.status & GcStatus.ANIMATE).toBe(0);
  });

  it('hides a pop-up menu when the user timeout expires', () => {
    const { gc, clock, take } = setup(menuSpec({ uiModel: 'popup', userTimeout: 1000 }));
    gc.run('initMenu');
    gc.run('vkKey', BdVk.POPUP);
    take();
    clock.now = 1000;
    gc.run('nop');
    expect(take()).toEqual([]);
    clock.now = 1001;
    gc.run('nop');
    expect(cmdsOf(take())).toEqual(['close']);
  });

  it('animates a selected button every frame interval', () => {
    const spec = menuSpec({}, { selected: [41, 43], selectedRepeat: true });
    const { gc, clock, take } = setup(spec);
    const init = gc.run('initMenu');
    expect(init.cmds.status & GcStatus.ANIMATE).toBeTruthy();
    expect(draws(take())[0]).toEqual([100, 100, 41]);

    // frame_rate code 1 (24000/1001): 89 * 24 = 2136 ticks per frame
    clock.now = 2135;
    expect(gc.run('nop').result).toBe(0);
    expect(take()).toEqual([]);
    clock.now = 2136;
    expect(gc.run('nop').result).toBe(1);
    expect(draws(take())).toEqual([[100, 100, 42]]);
    clock.now = 4272;
    gc.run('nop');
    expect(draws(take())).toEqual([[100, 100, 43]]);
    clock.now = 6408;
    gc.run('nop');
    expect(draws(take())).toEqual([[100, 100, 41]]); // repeat
    expect(gc.run('nop').cmds.status & GcStatus.ANIMATE).toBeTruthy();
  });

  it('plays a single-loop animation to its last object and blocks input meanwhile', () => {
    const spec = menuSpec({}, { selected: [41, 43] });
    const { gc, regs, clock, take } = setup(spec);
    gc.run('initMenu');
    take();
    expect(gc.run('vkKey', BdVk.DOWN).result).toBe(0); // button_effect_running
    expect(regs.psrRead(10)).toBe(1);
    for (const w of [42, 43]) {
      clock.now += 2136;
      gc.run('nop');
      expect(draws(take())).toEqual([[100, 100, w]]);
    }
    clock.now += 2136;
    gc.run('nop');
    expect(gc.run('vkKey', BdVk.DOWN).result).toBe(1);
  });

  it('plays page effects with the effect durations', () => {
    const spec = menuSpec();
    spec.pages[1]!.inEffects = {
      windows: [[0, 0, 0, 1920, 1080]],
      effects: [
        { duration: 1000, paletteId: 0, objects: [{ objectId: 50, windowId: 0, x: 5, y: 6 }] },
        { duration: 500, paletteId: 0, objects: [] },
      ],
    };
    const { gc, clock, take } = setup(spec);
    gc.run('initMenu');
    take();
    clock.now = 10;
    const r = gc.run('setButtonPage', (0x80000000 | (1 << 16)) >>> 0);
    expect(r.cmds.status & GcStatus.ANIMATE).toBeTruthy();
    expect(cmdsOf(take())).toEqual(['clear', 'clear', 'draw', 'flush']); // _select_page's clear, then effect 0
    clock.now = 1009;
    gc.run('nop');
    expect(take()).toEqual([]);
    clock.now = 1010;
    gc.run('nop');
    expect(cmdsOf(take())).toEqual(['clear', 'flush']); // effect 1
    clock.now = 1510;
    gc.run('nop');
    expect(cmdsOf(take())).toEqual(['clear', 'draw', 'flush']); // effects done: the page itself
  });

  it('survives input right after a page change and unknown button ids', () => {
    const { gc, regs, take } = setup();
    gc.run('initMenu');
    gc.run('setButtonPage', (0x80000000 | (1 << 16)) >>> 0);
    take();
    expect(() => gc.run('vkKey', BdVk.DOWN)).not.toThrow();
    expect(gc.run('vkKey', BdVk.DOWN).cmds.navCmds).toBeNull();
    expect(regs.psrRead(10)).toBe(5);
    expect(() => gc.run('mouseMove', (110 << 16) | 202)).not.toThrow(); // page 0's button 2 area on page 1
    expect(regs.psrRead(10)).toBe(5);
    expect(gc.run('mouseMove', (510 << 16) | 52).result).toBe(1); // button 5 is already selected
    expect(gc.run('vkKey', BdVk.MOUSE_ACTIVATE).cmds.navCmds).toHaveLength(1);

    expect(() => gc.run('enableButton', 77)).not.toThrow();
    expect(() => gc.run('disableButton', 77)).not.toThrow();
    expect(() => gc.run('enableButton', 1)).not.toThrow(); // belongs to page 0
    expect(regs.psrRead(10)).toBe(5);
    expect(gc.run('vkKey', BdVk.ENTER).cmds.navCmds).toHaveLength(1);

    // unknown page / button in set_button_page are ignored
    gc.run('setButtonPage', (0x80000000 | (9 << 16)) >>> 0);
    expect(regs.psrRead(11)).toBe(1);
    gc.run('setButtonPage', (0x20000000 | 99) >>> 0);
    expect(regs.psrRead(10)).toBe(5);

    // a page whose selection cannot be resolved
    gc.run('setButtonPage', (0x80000000 | (2 << 16)) >>> 0);
    expect(regs.psrRead(11)).toBe(2);
    expect(regs.psrRead(10)).toBe(0xffff);
    expect(() => gc.run('vkKey', BdVk.DOWN)).not.toThrow();
    expect(() => gc.run('mouseMove', (10 << 16) | 10)).not.toThrow();
    expect(gc.run('vkKey', BdVk.ENTER).cmds.navCmds).toBeNull();
  });

  it('answers hitTest from the buttons of the shown page', () => {
    const { gc } = setup();
    expect(gc.hitTest(105, 205)).toBeNull(); // nothing shown yet
    gc.run('initMenu');
    expect(gc.hitTest(100, 200)).toBe(2);
    expect(gc.hitTest(100 + 19, 200 + 3)).toBe(2); // selected object is 21 wide
    expect(gc.hitTest(100 + 21, 200)).toBeNull();
    expect(gc.hitTest(105, 204)).toBeNull();
    expect(gc.hitTest(99, 200)).toBeNull();
    expect(gc.hitTest(0, 0)).toBeNull();
  });

  it('restores the enabled buttons after a PSR save and restore', () => {
    const { gc, regs, take } = setup();
    gc.run('initMenu');
    regs.saveState();
    gc.run('disableButton', 2);
    gc.run('igEnd');
    take();
    regs.restoreState();
    expect(regs.psrRead(11)).toBe(0);
    gc.run('igEnd');
    expect(draws(take())).toHaveLength(3); // draw state was cleared: every restored button is drawn again
  });

  it('reset closes the plane and drops the display set', () => {
    const { gc, take } = setup();
    gc.run('initMenu');
    take();
    const r = gc.run('reset');
    expect(r.result).toBe(0);
    expect(cmdsOf(take())).toEqual(['close']);
    expect(gc.run('vkKey', BdVk.DOWN).result).toBe(-1);
    expect(gc.run('initMenu').cmds.status).toBe(0);
  });
});
