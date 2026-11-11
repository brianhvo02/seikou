/*
 * Ported from libbluray src/libbluray/decoders/graphics_controller.c (IG paths only; PG and TextST are not
 * ported), graphics_controller.h and keys.h
 * Copyright (C) 2010-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { MobjCmd } from '@seikou/bdmv/mobj-parser';
import { EMPTY_UO_MASK, type UoMask } from '../hdmv/uo-mask';
import { PSR, type PsrEvent, type RegisterFile } from '../hdmv/registers';
import { compositionObjectOp } from '@seikou/pg/composition';
import type { OverlayCmd, OverlayOp, PgCompositionObject, PgObject, PgPalette } from '@seikou/pg';
import type { IgButton, IgComposition, IgDisplaySet, IgEffect, IgEffectSequence, IgPage } from './ig-decoder';

/**
 * The virtual keys the graphics controller handles: libbluray's `bd_vk_key_e` in `keys.h`. D0 to D9 are the number keys,
 * ROOT_MENU the menu key, POPUP the pop-up menu toggle, ENTER and MOUSE_ACTIVATE activate the selected button, and NONE
 * is no key.
 */
export const BdVk = {
  D0: 0, D1: 1, D2: 2, D3: 3, D4: 4, D5: 5, D6: 6, D7: 7, D8: 8, D9: 9,
  ROOT_MENU: 10, POPUP: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, ENTER: 16, MOUSE_ACTIVATE: 17, NONE: 0xffff,
} as const;

/**
 * What the navigator asks of the graphics controller (the IG members of libbluray's `gc_ctrl_e`): set up the menu
 * (`initMenu`), advance animations and timers (`nop`), reset, a key, the mouse (position packed as x in the high 16 bits
 * and y in the low), enable or disable a button, change page, toggle the pop-up, or the end of a button command list.
 */
export type GcCtrl =
  | 'initMenu' | 'nop' | 'reset' | 'vkKey' | 'mouseMove' | 'enableButton' | 'disableButton' | 'setButtonPage'
  | 'popup' | 'igEnd';

/** Bits of the controller's status (libbluray `GC_STATUS_*`): a pop-up menu exists, a menu is showing, animations or timers run. */
export const GcStatus = { NONE: 0, POPUP: 1, MENU_OPEN: 2, ANIMATE: 4 } as const;

/**
 * What one `GraphicsController.run` asks of its caller: libbluray's `GC_NAV_CMDS`. `wantMouse` has no counterpart in
 * libbluray (`GC_NAV_CMDS` carries `wakeup_time` for TextST only); it is always false.
 */
export interface GcNavCmds {
  /** The commands of an activated button, for the VM to run as the IG object; null when none (`nav_cmds`). */
  readonly navCmds: readonly MobjCmd[] | null;
  /** The `sound.bdmv` sound to play (`sound_id_ref`); -1 for none, and 0xFF also means none. */
  readonly soundId: number;
  /** `GcStatus` bits after the run. */
  readonly status: number;
  /** The user operations the shown page forbids (`page_uo_mask`); empty while no menu is open. */
  readonly pageUoMask: UoMask;
  /** Always false. */
  readonly wantMouse: boolean;
}

/** What a `GraphicsController` is built from. */
export interface GraphicsControllerDeps {
  /** The register file; PSR10 (selected button) and PSR11 (menu page) are read and written through it. */
  readonly regs: RegisterFile;
  /** Receives the drawing operations that change the IG overlay plane. */
  onOverlay(op: OverlayOp): void;
  /** `bd_get_scr()`: a monotonic clock in 90 kHz ticks, for effect, animation and user timeout timing. */
  nowScr(): number;
}

const MAX_NUM_BOGS = 256;
const IG_UI_MODEL_POPUP = 1;

/** BOG_DATA: the state of one button overlap group while a page shows (enabled button, its place, the object drawn, animation position). */
class BogData {
  enabledButton = 0;
  x = 0;
  y = 0;
  w = 0;
  h = 0;
  visibleObjectId = 0;
  animateIndx = 0;
  effectRunning = 0;

  copyFrom(o: BogData): void {
    this.enabledButton = o.enabledButton;
    this.x = o.x;
    this.y = o.y;
    this.w = o.w;
    this.h = o.h;
    this.visibleObjectId = o.visibleObjectId;
    this.animateIndx = o.animateIndx;
    this.effectRunning = o.effectRunning;
  }
}

/** GC_NAV_CMDS while gc_run fills it in */
interface MutableCmds {
  navCmds: readonly MobjCmd[] | null;
  soundId: number;
  status: number;
  pageUoMask: UoMask;
}

const BTN_NORMAL = 0;
const BTN_SELECTED = 1;
const BTN_ACTIVATED = 2;

// _reset_page_state's frame_interval[] (C integer arithmetic); codes past the table are 0
const FRAME_INTERVAL = [
  0,
  Math.trunc(90000 / 1001) * 24,
  Math.trunc(90000 / 1000) * 24,
  Math.trunc(90000 / 1000) * 25,
  Math.trunc(90000 / 1001) * 30,
  Math.trunc(90000 / 1000) * 50,
  Math.trunc(90000 / 1001) * 60,
  0,
];

/** _areas_overlap */
function areasOverlap(a: BogData, b: BogData): boolean {
  return !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h);
}

/**
 * The interactive graphics controller: libbluray's `GRAPHICS_CONTROLLER` in `graphics_controller.c`, IG paths only (PG and
 * TextST are handled elsewhere). It follows PSR10 and PSR11, draws the shown page's buttons into the overlay through
 * `onOverlay`, handles keys and the mouse, plays in and out effects and button animations, runs the user timeout, and
 * hands back the commands of an activated button. Runs on the engine worker, driven by the `Navigator`.
 */
export class GraphicsController {
  private readonly regs: RegisterFile;
  private readonly deps: GraphicsControllerDeps;
  private readonly unregister: () => void;

  private igOpen = false;
  private igDrawn = false;
  private igDirty = false;
  private popupVisible = false;
  private validMousePosition = false;
  private autoActionTriggered = false;
  private bogData: BogData[] = GraphicsController.newBogs();
  private savedBogData: BogData[] | null = null;
  private pageUoMask: UoMask = EMPTY_UO_MASK;

  private effectIdx = 0;
  private inEffects: IgEffectSequence | null = null;
  private outEffects: IgEffectSequence | null = null;
  private nextEffectTime = 0; // 90 kHz

  private userTimeout = 0;

  private frameInterval = 0;
  private buttonEffectRunning = 0;
  private buttonAnimationRunning = 0;

  private igs: IgDisplaySet | null = null;

  constructor(deps: GraphicsControllerDeps) {
    this.deps = deps;
    this.regs = deps.regs;
    this.unregister = this.regs.onPsrEvent((ev) => this.processPsrEvent(ev)); // bd_psr_register_cb
  }

  private static newBogs(): BogData[] {
    return Array.from({ length: MAX_NUM_BOGS }, () => new BogData());
  }

  /** `gc_free`: stops listening to the registers and resets the controller. */
  dispose(): void {
    this.unregister();
    this.gcReset();
  }

  /*
   * object lookup
   */

  private findObject(id: number): PgObject | null {
    return this.igs?.objects.get(id) ?? null;
  }

  private findPalette(id: number): PgPalette | null {
    return this.igs?.palettes.get(id) ?? null;
  }

  private findButtonBog(buttons: readonly IgButton[], id: number): IgButton | null {
    for (const b of buttons) if (b.id === id) return b;
    return null;
  }

  private findButtonPage(page: IgPage, id: number): { readonly button: IgButton; readonly bogIdx: number } | null {
    for (let ii = 0; ii < page.bogs.length; ii++) {
      const button = this.findButtonBog(page.bogs[ii]!.buttons, id);
      if (button) return { button, bogIdx: ii };
    }
    return null;
  }

  private findPage(c: IgComposition, id: number): IgPage | null {
    for (const p of c.pages) if (p.id === id) return p;
    return null;
  }

  private get comp(): IgComposition {
    return this.igs!.composition!;
  }

  /** _find_object_for_button */
  private findObjectForButton(button: IgButton, state: number, bog: BogData | null): PgObject | null {
    let objectId = 0xffff;
    let objectIdEnd = 0xffff;
    let repeat = false;

    switch (state) {
      case BTN_NORMAL:
        objectId = button.normalStart;
        objectIdEnd = button.normalEnd;
        repeat = button.normalRepeat;
        break;
      case BTN_SELECTED:
        objectId = button.selectedStart;
        objectIdEnd = button.selectedEnd;
        repeat = button.selectedRepeat;
        break;
      case BTN_ACTIVATED:
        objectId = button.activatedStart;
        objectIdEnd = button.activatedEnd;
        break;
    }

    if (bog) {
      bog.effectRunning = 0;
      if (bog.animateIndx >= 0) {
        const range = objectIdEnd - objectId;

        if (range > 0 && objectId < 0xffff && objectIdEnd < 0xffff) {
          objectId += bog.animateIndx % (range + 1);
          bog.animateIndx++;
          if (!repeat) {
            if (bog.animateIndx > range) {
              // terminate animation to the last object
              bog.animateIndx = -1;
            } else {
              bog.effectRunning = 1;
            }
          }
        } else {
          // no animation for this button
          bog.animateIndx = -1;
        }
      } else if (objectIdEnd < 0xfffe) {
        objectId = objectIdEnd;
      }
    }

    return this.findObject(objectId);
  }

  /*
   * util
   */

  /** _is_button_enabled */
  private isButtonEnabled(page: IgPage, buttonId: number): boolean {
    for (let ii = 0; ii < page.bogs.length; ii++) {
      if (this.bogData[ii]!.enabledButton === buttonId) return true;
    }
    return false;
  }

  /** _find_selected_button_id */
  private findSelectedButtonId(): number {
    const pageId = this.regs.psrRead(PSR.MENU_PAGE_ID);
    const buttonId = this.regs.psrRead(PSR.SELECTED_BUTTON_ID);

    const page = this.findPage(this.comp, pageId);
    if (!page) return 0xffff;

    // run 5.9.8.3

    // 1) always use page->default_selected_button_id_ref if it is valid
    if (this.findButtonPage(page, page.defaultSelectedButton) && this.isButtonEnabled(page, page.defaultSelectedButton)) {
      return page.defaultSelectedButton;
    }

    // 2) fallback to current PSR10 value if it is valid
    for (let ii = 0; ii < page.bogs.length; ii++) {
      const enabled = this.bogData[ii]!.enabledButton;
      if (buttonId === enabled && this.findButtonBog(page.bogs[ii]!.buttons, enabled)) return enabled;
    }

    // 3) fallback to find first valid_button_id_ref from page
    for (let ii = 0; ii < page.bogs.length; ii++) {
      const enabled = this.bogData[ii]!.enabledButton;
      if (this.findButtonBog(page.bogs[ii]!.buttons, enabled)) return enabled;
    }

    return 0xffff;
  }

  /** _reset_user_timeout */
  private resetUserTimeout(): void {
    this.userTimeout = 0;

    const c = this.comp;
    if (c.uiModel === IG_UI_MODEL_POPUP || this.regs.psrRead(PSR.MENU_PAGE_ID) !== 0) {
      this.userTimeout = c.userTimeoutDuration;
      if (this.userTimeout) this.userTimeout += this.deps.nowScr();
    }
  }

  /** _save_page_state */
  private savePageState(): number {
    if (!this.igs || !this.igs.composition) return -1;

    const page = this.findPage(this.comp, this.regs.psrRead(PSR.MENU_PAGE_ID));
    if (!page) return -1;

    // copy enabled button state, clear draw state
    const saved = GraphicsController.newBogs();
    for (let ii = 0; ii < page.bogs.length; ii++) {
      saved[ii]!.enabledButton = this.bogData[ii]!.enabledButton;
      saved[ii]!.animateIndx = this.bogData[ii]!.animateIndx >= 0 ? 0 : -1;
    }
    this.savedBogData = saved;

    return 1;
  }

  /** _restore_page_state */
  private restorePageState(): number {
    this.inEffects = null;
    this.outEffects = null;

    if (this.savedBogData) {
      for (let ii = 0; ii < MAX_NUM_BOGS; ii++) this.bogData[ii]!.copyFrom(this.savedBogData[ii]!);
      this.savedBogData = null;
      return 1;
    }
    return -1;
  }

  /** _reset_page_state */
  private resetPageState(): void {
    const c = this.comp;
    const page = this.findPage(c, this.regs.psrRead(PSR.MENU_PAGE_ID));
    if (!page) return;

    this.bogData = GraphicsController.newBogs(); // memset(gc->bog_data, 0, ...)

    for (let ii = 0; ii < page.bogs.length; ii++) {
      this.bogData[ii]!.enabledButton = page.bogs[ii]!.defaultValidButton;
      this.bogData[ii]!.animateIndx = 0;
      this.bogData[ii]!.visibleObjectId = -1;
    }

    // animation frame rate
    this.frameInterval = (FRAME_INTERVAL[c.frameRate] ?? 0) * (page.animationFrameRateCode + 1);

    // effects
    this.effectIdx = 0;
    this.inEffects = null;
    this.outEffects = null;

    // timers
    this.resetUserTimeout();
  }

  /*
   * overlay operations
   */

  private emit(cmd: OverlayCmd, pts: number, x = 0, y = 0, w = 0, h = 0): void {
    this.deps.onOverlay({ cmd, pts, x, y, w, h });
  }

  /** _open_osd */
  private openOsd(x0: number, y0: number, width: number, height: number): void {
    this.emit('init', -1, x0, y0, width, height);
    this.igOpen = true;
  }

  /** _close_osd */
  private closeOsd(): void {
    this.emit('close', -1);
    this.igOpen = false;
    this.igDrawn = false;
  }

  /** _flush_osd */
  private flushOsd(pts: number): void {
    this.emit('flush', pts);
  }

  /** _clear_osd_area */
  private clearOsdArea(pts: number, x: number, y: number, w: number, h: number): void {
    this.emit('wipe', pts, x, y, w, h);
  }

  /** _clear_osd */
  private clearOsd(): void {
    this.emit('clear', -1);
    this.igDrawn = false;
  }

  /** _clear_bog_area */
  private clearBogArea(bog: BogData): void {
    if (this.igDrawn && bog.w && bog.h) {
      this.clearOsdArea(-1, bog.x, bog.y, bog.w, bog.h);

      bog.x = bog.y = bog.w = bog.h = 0;
      bog.visibleObjectId = -1;

      this.igDirty = true;
    }
  }

  /** _render_object; a kept failed object (img []) draws without an image, like C's NULL img */
  private renderObject(pts: number, x: number, y: number, object: PgObject, palette: PgPalette): void {
    const op: OverlayOp = {
      cmd: 'draw', pts, x, y, w: object.width, h: object.height, palette: palette.entries,
      ...(object.img.length ? { img: object.img } : {}),
      paletteUpdate: false,
    };
    this.deps.onOverlay(op);
  }

  /** _render_composition_object */
  private renderCompositionObject(pts: number, cobj: PgCompositionObject, object: PgObject, palette: PgPalette, paletteUpdateFlag: boolean): void {
    const op = compositionObjectOp(pts, cobj, object, palette, paletteUpdateFlag);
    if (op) this.deps.onOverlay(op);
  }

  /*
   * page selection and IG effects
   */

  /** _select_button */
  private selectButton(buttonId: number): void {
    const page = this.findPage(this.comp, this.regs.psrRead(PSR.MENU_PAGE_ID));

    // reset animation
    const found = page ? this.findButtonPage(page, buttonId) : null;
    if (found) {
      this.bogData[found.bogIdx]!.animateIndx = 0;
      this.nextEffectTime = this.deps.nowScr();
    }

    // select page
    this.regs.psrWrite(PSR.SELECTED_BUTTON_ID, buttonId);
    this.autoActionTriggered = false;
  }

  /** _select_page */
  private selectPage(pageId: number, outEffects: boolean): void {
    const curPageId = this.regs.psrRead(PSR.MENU_PAGE_ID);

    this.regs.psrWrite(PSR.MENU_PAGE_ID, pageId);

    this.resetPageState();

    const buttonId = this.findSelectedButtonId();
    this.selectButton(buttonId);

    this.validMousePosition = false;

    if (outEffects) {
      const cur = this.findPage(this.comp, curPageId);
      if (cur && cur.outEffects.effects.length) {
        this.nextEffectTime = this.deps.nowScr();
        this.outEffects = cur.outEffects;
      }
    }

    const page = this.findPage(this.comp, pageId);
    if (page && page.inEffects.effects.length) {
      this.nextEffectTime = this.deps.nowScr();
      this.inEffects = page.inEffects;
    }

    if (this.igOpen && !this.outEffects) this.clearOsd();
  }

  /** _gc_reset */
  private gcReset(): void {
    if (this.igOpen) this.closeOsd();

    this.popupVisible = false;
    this.validMousePosition = false;
    this.pageUoMask = EMPTY_UO_MASK;

    this.igs = null;

    this.bogData = GraphicsController.newBogs();
  }

  /** _process_psr_event */
  private processPsrEvent(ev: PsrEvent): void {
    if (ev.type === 'save') {
      this.savePageState();
      return;
    }
    if (ev.type === 'restore' && ev.psr === PSR.MENU_PAGE_ID) {
      // restore menus
      this.restorePageState();
    }
    // PSR_SELECTED_BUTTON_ID and others: ignore
  }

  /*
   * graphics stream input
   */

  /**
   * `gc_decode_ts`, IG branch: takes the display set that `IgSegmentDecoder` decoded, in place of
   * `graphics_processor_decode_ts`. True when the set is complete (the menu then needs an `initMenu` run).
   */
  decodeDisplaySet(ds: IgDisplaySet): boolean {
    this.igs = ds;
    return ds.complete;
  }

  /*
   * IG rendering
   */

  /** _render_button */
  private renderButton(button: IgButton, palette: PgPalette, state: number, bog: BogData): void {
    const object = this.findObjectForButton(button, state, bog);
    if (!object) {
      this.clearBogArea(bog);
      return;
    }

    // object already rendered ?
    if (bog.visibleObjectId === object.id && bog.x === button.x && bog.y === button.y && bog.w === object.width && bog.h === object.height) {
      return;
    }

    // new object is smaller than already drawn one, or in different position ? -> need to render background
    if (bog.w > object.width || bog.h > object.height || bog.x !== button.x || bog.y !== button.y) {
      // make sure we won't wipe other buttons
      let skip = false;
      for (let ii = 0; this.bogData[ii] !== bog; ii++) {
        if (areasOverlap(bog, this.bogData[ii]!)) skip = true;
        // FIXME: clean non-overlapping area
      }

      if (!skip) this.clearBogArea(bog);
    }

    this.renderObject(-1, button.x, button.y, object, palette);

    bog.x = button.x;
    bog.y = button.y;
    bog.w = object.width;
    bog.h = object.height;
    bog.visibleObjectId = object.id;

    this.igDrawn = true;
    this.igDirty = true;
  }

  /** _render_ig_composition_object */
  private renderIgCompositionObject(pts: number, cobj: PgCompositionObject, palette: PgPalette): number {
    const object = this.findObject(cobj.objectId);
    if (!object) return -1;

    // render object using composition parameters
    this.renderCompositionObject(pts, cobj, object, palette, false);
    return 0;
  }

  /** _render_effect */
  private renderEffect(effect: IgEffect): number {
    const pts = -1;

    if (!this.igOpen) this.openOsd(0, 0, this.comp.videoWidth, this.comp.videoHeight);

    this.clearOsd();

    const palette = this.findPalette(effect.paletteId);
    if (!palette) return -1;

    for (const cobj of effect.compositionObjects) this.renderIgCompositionObject(pts, cobj, palette);

    this.flushOsd(pts);

    this.resetUserTimeout();

    return 0;
  }

  /** _render_page */
  private renderPage(activatedButtonId: number, cmds: MutableCmds | null): number {
    const c = this.comp;
    const pageId = this.regs.psrRead(PSR.MENU_PAGE_ID);
    const selectedButtonId = this.regs.psrRead(PSR.SELECTED_BUTTON_ID);
    let autoActivateButton: IgButton | null = null;

    this.buttonEffectRunning = 0;
    this.buttonAnimationRunning = 0;

    if (c.uiModel === IG_UI_MODEL_POPUP && !this.popupVisible) {
      this.pageUoMask = EMPTY_UO_MASK;

      if (this.igOpen) {
        this.closeOsd();
        return 1;
      }

      return 0;
    }

    // running page effects ?
    if (this.outEffects) {
      if (this.effectIdx < this.outEffects.effects.length) {
        this.renderEffect(this.outEffects.effects[this.effectIdx]!);
        return 1;
      }
      this.outEffects = null;
    }

    const page = this.findPage(c, pageId);
    if (!page) return -1;

    this.pageUoMask = page.uoMask;

    if (this.inEffects) {
      if (this.effectIdx < this.inEffects.effects.length) {
        this.renderEffect(this.inEffects.effects[this.effectIdx]!);
        return 1;
      }
      this.inEffects = null;
    }

    const palette = this.findPalette(page.paletteId);
    if (!palette) return -1;

    if (!this.igOpen) this.openOsd(0, 0, c.videoWidth, c.videoHeight);

    for (let ii = 0; ii < page.bogs.length; ii++) {
      const bog = this.bogData[ii]!;
      const button = this.findButtonBog(page.bogs[ii]!.buttons, bog.enabledButton);

      if (!button) {
        // render background
        this.clearBogArea(bog);
      } else if (button.id === activatedButtonId) {
        this.renderButton(button, palette, BTN_ACTIVATED, bog);
      } else if (button.id === selectedButtonId) {
        if (button.autoActionFlag && !this.autoActionTriggered) {
          if (cmds && !autoActivateButton) autoActivateButton = button;

          this.renderButton(button, palette, BTN_ACTIVATED, bog);
        } else {
          this.renderButton(button, palette, BTN_SELECTED, bog);
        }
      } else {
        this.renderButton(button, palette, BTN_NORMAL, bog);
      }

      this.buttonEffectRunning += bog.effectRunning;
      this.buttonAnimationRunning += bog.animateIndx >= 0 ? 1 : 0;
    }

    // process auto-activate
    if (autoActivateButton) {
      // do not trigger auto action before single-loop animations have been terminated
      if (this.buttonEffectRunning) {
        // not triggered (ANIMATING)
      } else if (cmds) {
        cmds.navCmds = autoActivateButton.navCmds;
        this.autoActionTriggered = true;
      }
    }

    if (this.igDirty) {
      this.flushOsd(-1);
      this.igDirty = false;
      return 1;
    }

    return 0;
  }

  /*
   * user actions
   */

  /** _user_input */
  private userInput(keyIn: number, cmds: MutableCmds): number {
    const c = this.comp;
    const pageId = this.regs.psrRead(PSR.MENU_PAGE_ID);
    const curBtnId = this.regs.psrRead(PSR.SELECTED_BUTTON_ID);
    let newBtnId = curBtnId;
    let activatedBtnId = -1;
    let key = keyIn;

    if (c.uiModel === IG_UI_MODEL_POPUP && !this.popupVisible) return -1;
    if (!this.igOpen) return -1;
    if (!this.igDrawn) return 0;

    this.resetUserTimeout();

    if (this.buttonEffectRunning) return 0;

    const page = this.findPage(c, pageId);
    if (!page) return -1;

    if (key === BdVk.MOUSE_ACTIVATE) {
      if (!this.validMousePosition) return -1;
      key = BdVk.ENTER;
    }

    for (let ii = 0; ii < page.bogs.length; ii++) {
      const button = this.findButtonBog(page.bogs[ii]!.buttons, this.bogData[ii]!.enabledButton);
      if (!button) continue;

      if (key <= BdVk.D9) {
        // numeric select
        if (button.numericSelectValue === key - BdVk.D0) newBtnId = button.id;
      } else if ((key >= BdVk.UP && key <= BdVk.RIGHT) || key === BdVk.ENTER) {
        // cursor keys
        if (button.id === curBtnId) {
          switch (key) {
            case BdVk.UP:
              newBtnId = button.upper;
              break;
            case BdVk.DOWN:
              newBtnId = button.lower;
              break;
            case BdVk.LEFT:
              newBtnId = button.left;
              break;
            case BdVk.RIGHT:
              newBtnId = button.right;
              break;
            case BdVk.ENTER:
              activatedBtnId = curBtnId;
              cmds.navCmds = button.navCmds;
              cmds.soundId = button.activatedSound;
              break;
          }
        }

        if (newBtnId !== curBtnId) {
          const found = this.findButtonPage(page, newBtnId);
          if (found) cmds.soundId = found.button.selectedSound;
        }
      }
    }

    // render page ?
    if (newBtnId !== curBtnId || activatedBtnId >= 0) {
      this.selectButton(newBtnId);

      this.renderPage(activatedBtnId, cmds);

      // found one
      return 1;
    }

    return 0;
  }

  /** _set_button_page */
  private setButtonPage(param: number): void {
    const pageFlag = (param & 0x80000000) !== 0;
    const effectFlag = (param & 0x40000000) !== 0;
    const buttonFlag = (param & 0x20000000) !== 0;
    let pageId = (param >>> 16) & 0xff;
    const buttonId = param & 0xffff;
    let bogIdx = 0;

    let page: IgPage | null;
    let button: IgButton | null = null;

    // 10.4.3.4 (D)

    if (!pageFlag && !buttonFlag) return;

    if (pageFlag) {
      // current page --> command is ignored
      if (pageId === this.regs.psrRead(PSR.MENU_PAGE_ID)) return;

      page = this.findPage(this.comp, pageId);

      // invalid page --> command is ignored
      if (!page) return;

      // page changes
      this.selectPage(pageId, !effectFlag);
    } else {
      // page does not change
      pageId = this.regs.psrRead(PSR.MENU_PAGE_ID);
      page = this.findPage(this.comp, pageId);

      if (!page) return;
    }

    if (buttonFlag) {
      // find correct button and overlap group
      const found = this.findButtonPage(page, buttonId);
      button = found ? found.button : null;
      bogIdx = found ? found.bogIdx : 0;

      if (!pageFlag) {
        // page not given, invalid button --> ignore command
        if (!button) return;
        // page not given, current button --> ignore command
        if (buttonId === this.regs.psrRead(PSR.SELECTED_BUTTON_ID)) return;
      }
    }

    if (button) {
      this.bogData[bogIdx]!.enabledButton = buttonId;
      this.selectButton(buttonId);
    }

    this.renderPage(0xffff, null); // auto action not triggered yet
  }

  /** _enable_button */
  private enableButton(buttonId: number, enable: boolean): void {
    const pageId = this.regs.psrRead(PSR.MENU_PAGE_ID);
    const curBtnId = this.regs.psrRead(PSR.SELECTED_BUTTON_ID);

    const page = this.findPage(this.comp, pageId);
    if (!page) return;

    // find correct button overlap group
    const found = this.findButtonPage(page, buttonId);
    if (!found) return;
    const bog = this.bogData[found.bogIdx]!;

    if (enable) {
      if (bog.enabledButton === curBtnId) {
        // selected button goes to disabled state
        this.regs.psrWrite(PSR.SELECTED_BUTTON_ID, 0x10000 | buttonId);
      }
      bog.enabledButton = buttonId;
      bog.animateIndx = 0;
    } else {
      if (bog.enabledButton === buttonId) bog.enabledButton = 0xffff;

      if (curBtnId === buttonId) this.regs.psrWrite(PSR.SELECTED_BUTTON_ID, 0xffff);
    }
  }

  /** _update_selected_button */
  private updateSelectedButton(): void {
    // executed after IG command sequence terminates
    let buttonId = this.regs.psrRead(PSR.SELECTED_BUTTON_ID);

    // special case: triggered only after enable button disables selected button
    if (buttonId & 0x10000) {
      buttonId &= 0xffff;
      this.selectButton(buttonId);
      return;
    }

    if (buttonId === 0xffff) {
      buttonId = this.findSelectedButtonId();
      this.selectButton(buttonId);
    }
  }

  /** The enabled button of the current page under (x, y), as _mouse_move's search finds it. */
  private buttonAt(page: IgPage, x: number, y: number): IgButton | null {
    for (let ii = 0; ii < page.bogs.length; ii++) {
      const button = this.findButtonBog(page.bogs[ii]!.buttons, this.bogData[ii]!.enabledButton);
      if (!button) continue;

      if (x < button.x || y < button.y) continue;

      // Check for SELECTED state object (button that can be selected)
      const object = this.findObjectForButton(button, BTN_SELECTED, null);
      if (!object) continue;

      if (x >= button.x + object.width || y >= button.y + object.height) continue;

      return button;
    }
    return null;
  }

  /** _mouse_move */
  private mouseMove(x: number, y: number, cmds: MutableCmds): number {
    const pageId = this.regs.psrRead(PSR.MENU_PAGE_ID);
    const curBtnId = this.regs.psrRead(PSR.SELECTED_BUTTON_ID);
    let newBtnId = 0xffff;

    this.validMousePosition = false;

    if (!this.igDrawn) return -1;

    if (this.buttonEffectRunning) return -1;

    const page = this.findPage(this.comp, pageId);
    if (!page) return -1;

    const button = this.buttonAt(page, x, y);
    if (button) {
      // mouse is over button
      this.validMousePosition = true;

      // is button already selected?
      if (button.id === curBtnId) return 1;

      newBtnId = button.id;
      cmds.soundId = button.selectedSound;
    }

    if (newBtnId !== 0xffff) {
      this.selectButton(newBtnId);

      this.renderPage(-1, cmds);

      this.resetUserTimeout();
    }

    return this.validMousePosition ? 1 : 0;
  }

  /** The id of the button under (x, y), in IG plane pixels, on the shown page, or null; the cursor's view of `_mouse_move`'s search, with no side effects. */
  hitTest(x: number, y: number): number | null {
    if (!this.igs || !this.igs.composition || !this.igs.complete || !this.igDrawn) return null;
    const page = this.findPage(this.comp, this.regs.psrRead(PSR.MENU_PAGE_ID));
    if (!page) return null;
    return this.buttonAt(page, x, y)?.id ?? null;
  }

  /** _animate */
  private animate(cmds: MutableCmds): number {
    let result = -1;

    if (this.igOpen) {
      result = 0;

      if (this.outEffects) {
        const pts = this.deps.nowScr();
        const duration = this.outEffects.effects[this.effectIdx]?.duration ?? 0;
        if (pts >= this.nextEffectTime + duration) {
          this.nextEffectTime += duration;
          this.effectIdx++;
          if (this.effectIdx >= this.outEffects.effects.length) {
            this.outEffects = null;
            this.effectIdx = 0;
            this.clearOsd();
          }
          result = this.renderPage(0xffff, cmds);
        }
      } else if (this.inEffects) {
        const pts = this.deps.nowScr();
        const duration = this.inEffects.effects[this.effectIdx]?.duration ?? 0;
        if (pts >= this.nextEffectTime + duration) {
          this.nextEffectTime += duration;
          this.effectIdx++;
          if (this.effectIdx >= this.inEffects.effects.length) {
            this.inEffects = null;
            this.effectIdx = 0;
            this.clearOsd();
          }
          result = this.renderPage(0xffff, cmds);
        }
      } else if (this.buttonAnimationRunning) {
        const pts = this.deps.nowScr();
        if (pts >= this.nextEffectTime + this.frameInterval) {
          this.nextEffectTime += this.frameInterval;
          result = this.renderPage(0xffff, cmds);
        }
      }
    }

    return result;
  }

  /** _run_timers */
  private runTimers(cmds: MutableCmds): number {
    let result = -1;

    if (this.igOpen) {
      result = 0;

      if (this.userTimeout) {
        const pts = this.deps.nowScr();
        if (pts > this.userTimeout) {
          if (this.comp.uiModel !== IG_UI_MODEL_POPUP) {
            if (this.regs.psrRead(PSR.MENU_PAGE_ID) !== 0) {
              this.selectPage(0, false);
              result = this.renderPage(0xffff, cmds);
            }
          } else {
            this.popupVisible = false;
            result = this.renderPage(0xffff, cmds);
          }
        }
      }
    }

    return result;
  }

  /**
   * `gc_run` for the IG controls. `param` is the control's numeric parameter (the key, the button or page number, or
   * the packed mouse position; 0 when absent). `result` is gc_run's value: negative when nothing could be done (no
   * complete display set, a key that does not apply, a mouse move outside a drawn menu); for the mouse 1 inside a
   * button and 0 outside; `cmds` holds what the caller must act on.
   */
  run(ctrl: GcCtrl, param = 0): { readonly result: number; readonly cmds: GcNavCmds } {
    const cmds: MutableCmds = { navCmds: null, soundId: -1, status: GcStatus.NONE, pageUoMask: EMPTY_UO_MASK };
    const done = (result: number): { readonly result: number; readonly cmds: GcNavCmds } => ({
      result,
      cmds: { ...cmds, wantMouse: false },
    });
    let result = -1;

    // always accept reset
    if (ctrl === 'reset') {
      this.gcReset();
      return done(0);
    }

    // other operations require complete display set
    if (!this.igs || !this.igs.composition || !this.igs.complete) return done(result);

    switch (ctrl) {
      case 'setButtonPage':
        this.setButtonPage(param);
        break;

      case 'vkKey':
      case 'popup': {
        let on = param;
        if (ctrl === 'vkKey') {
          if (param !== BdVk.POPUP) {
            result = this.userInput(param, cmds);
            break;
          }
          // BD_VK_POPUP => GC_CTRL_POPUP
          on = this.popupVisible ? 0 : 1;
        }

        if (this.comp.uiModel !== IG_UI_MODEL_POPUP) break; // not pop-up menu

        this.popupVisible = !!on;

        if (this.popupVisible) this.selectPage(0, false);

        result = this.renderPage(0xffff, cmds);
        break;
      }

      case 'nop':
        result = this.animate(cmds);
        this.runTimers(cmds);
        break;

      case 'initMenu':
        this.selectPage(0, false);
        this.renderPage(0xffff, cmds);
        break;

      case 'igEnd':
        this.updateSelectedButton();
        this.renderPage(0xffff, cmds);
        break;

      case 'enableButton':
        this.enableButton(param, true);
        break;

      case 'disableButton':
        this.enableButton(param, false);
        break;

      case 'mouseMove':
        result = this.mouseMove(param >>> 16, param & 0xffff, cmds);
        break;
    }

    if (this.comp.uiModel === IG_UI_MODEL_POPUP) cmds.status |= GcStatus.POPUP;
    if (this.igDrawn) cmds.status |= GcStatus.MENU_OPEN;
    if (this.inEffects || this.outEffects || this.buttonAnimationRunning || this.userTimeout) {
      // do not trigger if unopened pop-up menu has animations
      if (this.igOpen) {
        cmds.status |= GcStatus.ANIMATE;
        // user input is still not handled, but user "sees" the menu.
        cmds.status |= GcStatus.MENU_OPEN;
      }
    }

    if (this.igOpen) cmds.pageUoMask = this.pageUoMask;

    return done(result);
  }
}
