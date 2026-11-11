/*
 * Ported from libbluray src/libbluray/bluray.c (HDMV title and navigation parts)
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2012-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 * Copyright (C) 2012  Libbluray team
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { IndexObject } from '@seikou/bdmv/index-parser';
import { BranchSub, InsnGroup, PlayOpt, type MovieObject } from '@seikou/bdmv/mobj-parser';
import type { Mpls, StreamEntry } from '@seikou/bdmv/mpls-parser';
import type { DiscModel } from '../disc/open-disc';
import { BdVk, GraphicsController, GcStatus, type GcCtrl as GraphicsCtrl } from '../graphics/graphics-controller';
import { IgSegmentDecoder, type IgDisplaySet } from '../graphics/ig-decoder';
import { OverlayPlane, type OverlayOp } from '@seikou/pg';
import { PSR, type PsrEvent, type RegisterFile } from '../hdmv/registers';
import { combineUoMasks, EMPTY_UO_MASK, parseUoMaskTable, type UoMask, type UoOp } from '../hdmv/uo-mask';
import { HdmvEventType, HdmvVm, type HdmvEvent } from '../hdmv/vm';
import { itemPackets, type ItemPackets } from './packets';
import {
  clipTimeSearch, indexObjectOf, markTitlePkt, titlePkt, updateChapterPsrAtPkt, updateClipPsrs, updatePlaylistPsrs, updateTimePsr,
  type PlaybackPsrContext, type TitleType,
} from './playback-psrs';

/**
 * What the navigator asks of the player: opening, seeking, stopping and freezing the playlist it runs a menu program
 * for. The `Player` implements it on the engine worker.
 */
export interface PlaybackPort {
  /**
   * Opens playlist `id` (such as `00001`) at `at`; resolves false if the playlist is missing. Contract (as libbluray's _open_playlist): once the playlist is open the port
   * calls Navigator.playlistStarted() synchronously from inside this call, before returning, so that PSR and UO mask
   * updates happen in libbluray's order relative to the rest of the VM step. `clipTime45` asks for a start at that
   * 45 kHz clip time within `item` (restore after a menu call).
   */
  playPlaylist(id: string, at: PlayAt): Promise<boolean>;
  /** Jumps to the start of play item `item` (0-based) of the open playlist. */
  seekPlayItem(item: number): void;
  /** Jumps to playlist mark `mark` (0-based, over all marks, entry and link). */
  seekMark(mark: number): void;
  /** Stops the open playlist. */
  stopPlaylist(): void;
  /** A still: with `on`, freezes presentation (the clock stops) and keeps the frame; with false, lets it run again. */
  hold(on: boolean): void;
  /** 45 kHz clip time of the current presentation position (bd_get_scr-less _update_time_psr_from_stream), if known. */
  currentClipTime45(): number | undefined;
}

/** Where within a playlist to start: at most one of a play item, a mark, or a time (the latter with its item). */
export interface PlayAt {
  /** Play item index, 0-based (PLAY_PL_PI of a movie object). */
  readonly item?: number;
  /** Playlist mark index, 0-based (PLAY_PL_PM of a movie object). */
  readonly mark?: number;
  /** A time within `item`, in 45 kHz ticks of the clip's own PTS (the value PSR8 holds); set when a menu call is restored. */
  readonly clipTime45?: number;
}

/** What the navigator tells the player, in the order it happens. */
export type NavigatorEvent =
  /** The combined user operation mask changed. */
  | { readonly type: 'uoMask'; readonly mask: UoMask }
  /** An IG menu opened or closed. */
  | { readonly type: 'menu'; readonly active: boolean }
  /** A pop-up menu became available or unavailable. */
  | { readonly type: 'popup'; readonly available: boolean }
  /** A button asked for sound `id` of `sound.bdmv` to play. */
  | { readonly type: 'sound'; readonly id: number }
  /** The current title changed (PSR4): its index number, 0xFFFF for First Play, 0 for the Top Menu. */
  | { readonly type: 'title'; readonly title: number }
  /** A seek the program asked for was accepted (bd_seek_playitem, bd_seek_mark, _clip_seek_time); `value` is the item, mark or 45 kHz clip time. */
  | { readonly type: 'seek'; readonly what: 'item' | 'mark' | 'time'; readonly value: number }
  /** The program jumped to a BD-J title, which the navigator leaves to the BD-J runtime. */
  | { readonly type: 'bdjTitle'; readonly title: number }
  /** The program cannot go on (a movie object failed to start, the VM errored or did not settle). */
  | { readonly type: 'error'; readonly message: string };

/** What a `Navigator` is built from. */
export interface NavigatorDeps {
  /** The opened disc; its `movieObjects` must be non-null (a disc without them has no navigator). */
  readonly disc: DiscModel;
  /** The register file the program, the VM and the graphics controller share. */
  readonly regs: RegisterFile;
  /** How the navigator drives playback. */
  readonly port: PlaybackPort;
  /** Receives every `NavigatorEvent`. */
  emit(event: NavigatorEvent): void;
  /** A monotonic clock in 90 kHz ticks, as libbluray's `bd_get_scr()`; times still frames and the graphics controller's timers. */
  nowScr(): number;
  /** Seed of the VM's RND instruction; the wall clock in seconds when absent (tests and traces pin it). */
  readonly seed?: number;
  /**
   * _preload_m2ts for an IG sub-path: reads the whole sub-path clip and returns the PES units of all its IG PIDs (each
   * unit carries its `pid`) in stream order; the navigator filters by the PID PSR0 names at each init. Rejects when the
   * clip cannot be read (no menu, counted as an IG error); the read stops when `signal` aborts. Without it, IG streams carried in sub-paths show no menu.
   */
  preloadSubPathIg?(clipId: string, signal: AbortSignal): Promise<IgUnit[]>;
}

const TITLE_FIRST_PLAY = 0xffff;
const TITLE_TOP_MENU = 0;
const STILL_TIME = 1;
const STILL_INFINITE = 2;
const SCR_HZ = 90000;
const MAX_VM_LOOPS = 100;
const MAX_INVALID_PL = 10;
const HDMV_MENU_CALL_MASK = 1;
const HDMV_TITLE_SEARCH_MASK = 2;
const INDEX_ID_NONE = 0xffff;
const NO_PLAYLIST = 0xffff;
const PSR_REG_FLAG = 0x80000000;

/** gc_ctrl_e values the navigator sends to the graphics controller. */
type GcCtrl = 'INIT_MENU' | 'ENABLE_BUTTON' | 'DISABLE_BUTTON' | 'SET_BUTTON_PAGE' | 'POPUP' | 'IG_END' | 'NOP' | 'VK_KEY' | 'MOUSE_MOVE';

const GC_CTRL: Readonly<Record<GcCtrl, GraphicsCtrl>> = {
  INIT_MENU: 'initMenu', ENABLE_BUTTON: 'enableButton', DISABLE_BUTTON: 'disableButton',
  SET_BUTTON_PAGE: 'setButtonPage', POPUP: 'popup', IG_END: 'igEnd', NOP: 'nop', VK_KEY: 'vkKey', MOUSE_MOVE: 'mouseMove',
};

const DEFAULT_PLANE_WIDTH = 1920;
const DEFAULT_PLANE_HEIGHT = 1080;
const COMPOSITION_ACQUISITION_POINT = 1;
/** initIgStream(): a sub-path preload is still loading; INIT_MENU waits for it. */
const IG_INIT_PENDING = -1;

/** A graphics PES payload of the IG stream, in playlist time. */
export interface IgUnit {
  /** PID of a preloaded sub-path unit (main-path units come from one PID and carry none). */
  readonly pid?: number;
  /** The PES payload: one or more graphics segments (ICS, PDS, ODS, END). */
  readonly data: Uint8Array;
  /** Presentation time in playlist microseconds. */
  readonly ptsUs: number;
  /** Decode time: segments carry it ahead of the ICS's presentation time, and gating follows it (graphics_processor_decode_pes). */
  readonly dtsUs?: number;
}

function sameMask(a: UoMask, b: UoMask): boolean {
  if (a.size !== b.size) return false;
  for (const op of a) if (!b.has(op)) return false;
  return true;
}

interface SubIgPreload {
  readonly clipId: string;
  readonly abort: AbortController;
  /** null while the clip is loading; the whole stream's units once loaded. */
  units: readonly IgUnit[] | null;
  /** The read failed: no menu until the playlist closes (no retry, as libbluray). */
  failed: boolean;
  /** _init_ig_stream ran while the clip was still loading: decode when it settles. */
  initPending: boolean;
}

/**
 * The HDMV navigator: libbluray's title and playlist logic from `bluray.c` (`bd_play`, `bd_play_title`, `bd_menu_call`,
 * `_open_playlist`, `_read_ext`'s VM and graphics parts), without its reader. It owns the HDMV VM, runs a title's movie
 * object, reacts to the VM's playlist and title events by driving the `Player` through `PlaybackPort`, keeps the
 * playback registers (PSR4 title, PSR5 chapter, PSR6 playlist, PSR7 play item, PSR8 time) current, combines the UO masks,
 * and decodes the IG stream into the graphics controller and the overlay plane. It runs on the engine worker and
 * is driven by the player's calls and its `tick`. BD-J titles are only reported (`bdjTitle`); the player starts
 * BD-J and drops the navigator meanwhile. `tests/vm-trace` compares it with libbluray's traces.
 */
export class Navigator {
  private readonly gc: GraphicsController;
  private readonly igDecoder = new IgSegmentDecoder();
  /** The IG overlay (main path only), sized by the composition's video descriptor; null before the first display set. */
  private plane: OverlayPlane | null = null;
  /** IG units not yet due, in stream order (an ICS follows the ODS/PDS segments of an earlier DTS in the same set). */
  private igQueue: IgUnit[] = [];
  /** st0.ig_pid > 0: set by _init_ig_stream, cleared when a playlist opens or closes. */
  private igReady = false;
  /** After a reset, display sets are ignored until one that carries a whole epoch (epoch start or acquisition point). */
  private igNeedsEpoch = true;
  /** st_ig: the sub-path IG clip preloaded at playlist open, dropped when the playlist closes. */
  private subIg: SubIgPreload | null = null;
  /** Failed sub-path preloads; added to the decoder's corrupt-segment count. */
  private subIgErrors = 0;
  /** The graphics processor's queue of preloaded units not yet decoded (gc->igp->queue). */
  private subIgQueue: IgUnit[] = [];
  private subIgPid = -1;
  private gcStatus: number = GcStatus.NONE;
  private drawsSincePaint = 0;
  private vm: HdmvVm | null = null;
  private titleType: TitleType = 'undef';
  private hdmvSuspended = true;
  private hdmvNumInvalidPl = 0;

  private playlist: Mpls | null = null;
  /** A playlist was requested or is playing, and has not been closed. */
  private playing = false;
  /** end_of_playlist: the last play item ended. */
  private ended = false;
  /** Bumped whenever a pending playPlaylist() result must be ignored. */
  private generation = 0;

  private titleUoMask: UoMask = EMPTY_UO_MASK;
  private st0UoMask: UoMask = EMPTY_UO_MASK;
  private gcUoMask: UoMask = EMPTY_UO_MASK;
  private uoMaskValue: UoMask = EMPTY_UO_MASK;

  private itemStill: { readonly item: number; readonly until: number | null } | null = null;
  private igStill = false;
  private held = false;
  private restorePlaylist = NO_PLAYLIST;
  private restoreItem = 0;
  /** A restored PSR8 that the next playlistStarted() must keep. */
  private keepTime: number | null = null;
  private currentItem = 0;
  /** NAV_CLIP start_pkt / end_pkt / title_pkt of the current playlist's play items. */
  private geometry: readonly ItemPackets[] = [];
  /** What the playlist being opened was asked to start at, for the seeks that follow its open. */
  private startAt: PlayAt | null = null;

  constructor(private deps: NavigatorDeps) {
    deps.regs.onPsrEvent((e) => this.onPsrEvent(e));
    this.gc = new GraphicsController({ regs: deps.regs, onOverlay: (op) => this.onOverlay(op), nowScr: deps.nowScr });
  }

  /**
   * The same disc in another version (a quality level): its STN tables, clip info and stream sizes differ, its play items
   * and marks don't. Nothing of the program's state changes; the open playlist and its packet geometry are the new
   * version's from now on.
   */
  replaceDisc(disc: DiscModel): void {
    const open = this.playlist;
    const id = open ? [...this.deps.disc.playlists].find(([, pl]) => pl === open)?.[0] : undefined;
    this.deps = { ...this.deps, disc };
    const pl = id === undefined ? undefined : disc.playlists.get(id);
    if (!pl) return;
    this.playlist = pl;
    this.geometry = itemPackets(pl.playItems, disc.clips);
  }

  /** The IG plane to composite over the video, or null before any menu was decoded. */
  get igPlane(): OverlayPlane | null {
    return this.plane;
  }

  /** Corrupt IG segments dropped so far. */
  get igErrors(): number {
    return this.igDecoder.errors + this.subIgErrors;
  }

  /** Draw operations applied since the last call: what the last repaint of the plane drew. */
  takeDrawCount(): number {
    const n = this.drawsSincePaint;
    this.drawsSincePaint = 0;
    return n;
  }

  /**
   * An IG graphics unit of the main path arrived. Dropped unless a playlist is open (units of a torn-down
   * session can still be in flight); decoded by tick() in arrival order once the clock reaches its DTS (PTS if none).
   */
  pushIg(unit: IgUnit): void {
    if (!this.playing) return;
    this.igQueue.push(unit);
  }

  /**
   * The presentation position moved (a seek). As _seek_internal, which only sends GC_CTRL_PG_RESET, this keeps the
   * graphics controller and the decoder's epoch: only queued units from the old read position and a half-received
   * display set are dropped.
   */
  seekGraphics(): void {
    this.igQueue = [];
    this.igDecoder.discardPartial();
  }

  /** The user operations the disc forbids now: the title's, the playlist's and the menu page's masks combined. */
  get uoMask(): UoMask {
    return this.uoMaskValue;
  }

  /** Whether the HDMV VM has a program to run (`hdmv_vm_running`). */
  get vmRunning(): boolean {
    return this.vm?.running() ?? false;
  }

  /** Starts the disc as `bd_play` does: runs the First Play title and then the VM until it waits for something. */
  start(): void {
    this.dropVm();
    this.titleType = 'undef';
    this.playTitleInternal(TITLE_FIRST_PLAY);
    this.runVm();
  }

  /**
   * Runs index title `title` as `bd_play_title` does (0 is the Top Menu, 0xFFFF First Play). False when no program is
   * running yet (before `start`), the disc's UO mask forbids title search, or the title cannot start.
   */
  playTitle(title: number): boolean {
    if (title === TITLE_TOP_MENU) return this.menuCall();
    // _try_play_title
    if (this.titleType === 'undef' && title !== TITLE_FIRST_PLAY) return false;
    if (this.uoMaskValue.has('titleSearch')) return false;
    const ok = this.playTitleInternal(title);
    this.runVm();
    return ok;
  }

  /**
   * A title (0: the top menu) on a navigator that never ran First Play: the player rebuilds the navigator this way after a
   * raw playlist pick stopped the program, so that an index title picked afterwards runs on a fresh navigator. As `bd_play`
   * followed by `bd_play_title`, without First Play's program. False when the title cannot start.
   */
  startTitle(title: number): boolean {
    this.dropVm();
    this.titleType = 'hdmv';
    const ok = this.playTitleInternal(title);
    if (!ok) {
      this.titleType = 'undef';
      return false;
    }
    this.runVm();
    return true;
  }

  /**
   * Not in libbluray: resume an HDMV title at a saved place. Sets the title up as startTitle() does, but instead of
   * running its movie object from the start, finds the object's first PLAY_PL, PLAY_PL_PI or PLAY_PL_PM that plays
   * `playlist` (an immediate operand, or a register that holds it now), leaves the VM as if it had just executed that
   * command and opens the playlist at `at`; at its end the program continues after that command. A missing playlist
   * resumes the program at once, as a PLAY_PL of a missing playlist does. Returns false, changing nothing, when the title
   * is not an HDMV title or its object never plays `playlist`.
   */
  resumeTitle(title: number, playlist: number, at: PlayAt): boolean {
    const { movieObjects } = this.deps.disc;
    const object = indexObjectOf(this.deps.disc, title);
    if (!movieObjects || object?.kind !== 'hdmv') return false;
    const mobj = movieObjects.objects[object.movieObjectId];
    const pc = mobj ? this.findPlayPl(mobj, playlist) : -1;
    if (pc < 0) return false;

    this.dropVm();
    this.titleType = 'hdmv';
    this.deps.regs.psrWrite(PSR.TITLE_NUMBER, title); // 5.2.3.3, as _play_title
    this.deps.emit({ type: 'title', title });
    const vm = this.createVm();
    vm.resumeInto(object.movieObjectId, pc);
    this.hdmvSuspended = true;
    this.updateHdmvUoMask();
    this.openPlaylist(playlist, at, (ok) => {
      if (!ok && this.vm) {
        this.vm.resume();
        this.hdmvSuspended = !this.vm.running();
        this.runVm();
        return;
      }
      this.initMenu();
    });
    return true;
  }

  /** The pc of the first PLAY_PL* in `mobj` whose playlist operand is `playlist` now, or -1. */
  private findPlayPl(mobj: MovieObject, playlist: number): number {
    const regs = this.deps.regs;
    return mobj.cmds.findIndex(({ insn, dst }) => {
      if (insn.grp !== InsnGroup.BRANCH || insn.subGrp !== BranchSub.PLAY) return false;
      if (insn.branchOpt !== PlayOpt.PLAY_PL && insn.branchOpt !== PlayOpt.PLAY_PL_PI && insn.branchOpt !== PlayOpt.PLAY_PL_PM) return false;
      if (insn.opCnt < 1) return false;
      let value: number;
      if (insn.immOp1) value = dst >>> 0;
      else if (dst & PSR_REG_FLAG) value = (dst & ~0x8000007f) === 0 ? regs.psrRead(dst & 0x7f) : 0; // _read_reg
      else value = (dst & ~0xfff) === 0 ? regs.gprRead(dst) : 0;
      return value === playlist;
    });
  }

  /** Calls the Top Menu as `bd_menu_call` does (`_try_menu_call`). False before any title runs or while the UO mask forbids menu call. */
  menuCall(): boolean {
    this.updateTimePsr();
    if (this.titleType === 'undef') return false;
    if (this.uoMaskValue.has('menuCall')) return false;
    if (this.titleType === 'hdmv') this.vm?.suspendPlaylist(); // failure only means no location to store
    const ok = this.playTitleInternal(TITLE_TOP_MENU);
    this.runVm();
    return ok;
  }

  /**
   * `bd_user_input` for a key press (a `BdVk` value). ROOT_MENU is a menu call. At libbluray's default UO restriction level
   * (RELAXED) no key is checked against the UO mask here; enforcement for the UI is the player's. Returns as libbluray
   * does: negative when it was ignored (no HDMV title running, or no menu to act on), 0 on success, positive when the
   * selection or an activation changed.
   */
  userInput(key: number): number {
    if (key === BdVk.ROOT_MENU) return this.menuCall() ? 0 : -1;
    this.updateTimePsr(); // _set_scr(bd, -1)
    return this.titleType === 'hdmv' ? this.runGc('VK_KEY', key) : -1;
  }

  /**
   * `bd_mouse_select`: moves the selection to the button at (x, y) in IG plane pixels. Negative with no HDMV title, 0 when
   * the point is outside every button, 1 when it is inside one.
   */
  mouseSelect(x: number, y: number): number {
    this.updateTimePsr();
    return this.titleType === 'hdmv' ? this.runGc('MOUSE_MOVE', ((x << 16) | (y & 0xffff)) >>> 0) : -1;
  }

  /** The number of the button of the shown menu page at (x, y) in IG plane pixels, or null; it changes nothing. */
  hitTest(x: number, y: number): number | null {
    return this.gc.hitTest(x, y);
  }

  /**
   * The VM part of _read_ext, plus the play-item still timer of bd_read_skip_still. IG units whose PTS the playlist
   * clock (`clockUs`, playlist microseconds) has reached are decoded first, as _read_ext decodes a block before it runs
   * the VM. The player's reader runs ahead of playback where libbluray's is paced, so units are queued by PTS and handed
   * to the graphics controller only when the clock gets to them.
   */
  tick(clockUs: number): void {
    this.decodeDueIg(clockUs);
    if (this.itemStill && this.itemStill.until !== null && this.deps.nowScr() >= this.itemStill.until) this.skipStill();
    this.runVm();
  }

  /**
   * _update_playlist_psrs and the clip-open part of _open_m2ts, once the player has opened the playlist. Then, as
   * _open_playlist and the bd_seek_* calls that follow it do: _find_next_playmark (the chapter PSR) after the first clip,
   * and again after each seek to the requested item, mark or restored time.
   */
  playlistStarted(playlistId: string, item: number): void {
    const at = this.startAt;
    this.startAt = null;
    this.playlist = this.deps.disc.playlists.get(playlistId) ?? null;
    this.geometry = this.playlist ? itemPackets(this.playlist.playItems, this.deps.disc.clips) : [];
    this.playing = true;
    this.ended = false;
    this.st0UoMask = EMPTY_UO_MASK;
    this.gcUoMask = EMPTY_UO_MASK;
    // _open_playlist opens the first clip, then bd_seek_playitem / bd_seek_mark moves on
    updatePlaylistPsrs(this.psrs, playlistId, 0);
    const restoredTime = this.keepTime;
    this.keepTime = null;
    this.openClip(0);
    this.startSubPathPreload(); // _preload_subpaths follows the first _open_m2ts
    updateChapterPsrAtPkt(this.psrs, 0);
    if (at) this.emitSeek(at);
    if (item !== 0) this.openClip(item);
    if (at) this.seekChapterUpdates(at);
    if (restoredTime !== null) this.deps.regs.psrWrite(PSR.TIME, restoredTime); // after the last clip open can overwrite it
  }

  /** The reader moved to play item `item` of the open playlist (`_open_m2ts`): releases a still and updates the clip registers. */
  playItemChanged(item: number): void {
    this.itemStill = null;
    this.syncHold();
    this.openClip(item);
  }

  /**
   * _playmark_reached: the position passed one or more play marks (ENTRY or LINK) and is now at packet `clipPkt` of play
   * item `item`. Updates the chapter PSR (_update_chapter_psr) even when the chapter is unchanged.
   */
  markReached(item: number, clipPkt: number): void {
    updateChapterPsrAtPkt(this.psrs, titlePkt(this.psrs, item, clipPkt));
  }

  /**
   * A user seek (bd_seek, bd_seek_time, bd_seek_chapter) landed at `clipTime45` in play item `item`: _seek_internal's
   * _find_next_playmark updates the chapter PSR for the packet the EP map gives for that time (nav_clip_time_search).
   */
  seeked(item: number, clipTime45: number): void {
    const pkt = clipTimeSearch(this.psrs, item, clipTime45);
    if (pkt !== undefined) updateChapterPsrAtPkt(this.psrs, titlePkt(this.psrs, item, pkt));
  }

  /** The playlist ended: as `playItemEnded` for its last item. */
  playlistEnded(): void {
    if (this.playlist) this.playItemEnded(this.playlist.playItems.length - 1);
    else if (this.playing && !this.ended) this.finishPlaylist();
  }

  /**
   * A play item ran to its end. May be called at every item end: only a still (_bd_read_locked) or the end of the
   * playlist does anything, a seamless boundary is left to the player.
   */
  playItemEnded(item: number): void {
    if (!this.playing || this.ended || this.itemStill) return;
    const pi = this.playlist?.playItems[item];
    if (pi?.stillMode === STILL_INFINITE) {
      this.itemStill = { item, until: null };
      this.syncHold();
      return;
    }
    if (pi?.stillMode === STILL_TIME) {
      this.itemStill = { item, until: this.deps.nowScr() + pi.stillTime * SCR_HZ };
      this.syncHold();
      return;
    }
    if (this.isLastItem(item)) this.finishPlaylist();
  }

  /** Whether `op` is forbidden now; always false before a title runs. */
  isMasked(op: UoOp): boolean {
    return this.isUoMasked(op);
  }

  /** The disc closed or a raw playlist was picked: drops the VM and the program state, and closes the open playlist without telling the port to stop it. */
  stop(): void {
    this.generation++;
    this.dropVm();
    this.titleType = 'undef';
    this.titleUoMask = EMPTY_UO_MASK;
    this.closePlaylist(false);
  }

  // ---- titles ----

  /** disc_info.first_play_supported / top_menu_supported: a BD-J object is handed to the application. */
  private isSupported(object: IndexObject): boolean {
    return object.kind === 'bdj' || (object.kind === 'hdmv' && object.movieObjectId !== INDEX_ID_NONE);
  }

  /** _play_title */
  private playTitleInternal(title: number): boolean {
    const { index, movieObjects } = this.deps.disc;
    if (!movieObjects) return false;

    if (title === TITLE_FIRST_PLAY) {
      this.deps.regs.psrWrite(PSR.TITLE_NUMBER, TITLE_FIRST_PLAY); // 5.2.3.3
      if (!this.isSupported(index.firstPlay)) {
        this.titleType = 'hdmv'; // no first play title (5.2.3.3)
        this.deps.emit({ type: 'title', title });
        return true;
      }
      return this.playObject(index.firstPlay, title);
    }

    if (this.titleType === 'undef') return false; // bd_play() not called

    if (title === TITLE_TOP_MENU && !this.isSupported(index.topMenu)) {
      this.titleType = 'hdmv'; // no top menu (5.2.3.3)
      return false;
    }

    if (title <= index.titles.length) {
      const object = indexObjectOf(this.deps.disc, title);
      if (!object) return false;
      this.deps.regs.psrWrite(PSR.TITLE_NUMBER, title); // 5.2.3.3
      return this.playObject(object, title);
    }
    return false; // title not found
  }

  private playObject(object: IndexObject, title: number): boolean {
    if (object.kind === 'bdj') return this.playBdj(title);
    if (object.kind === 'hdmv') {
      this.deps.emit({ type: 'title', title });
      return this.playHdmv(object.movieObjectId);
    }
    this.fail('Unsupported title object type');
    return false;
  }

  /** _play_bdj: BD-J is left to the application. */
  private playBdj(title: number): boolean {
    this.titleType = 'bdj';
    this.hdmvSuspended = true;
    this.deps.emit({ type: 'bdjTitle', title });
    return true;
  }

  /** _play_hdmv */
  private playHdmv(id: number): boolean {
    this.titleType = 'hdmv';
    const vm = this.createVm();
    const ok = vm.selectObject(id) === 0;
    this.hdmvSuspended = !vm.running();
    if (!ok) {
      this.titleType = 'undef';
      this.fail(`Cannot start movie object ${id}`);
    }
    return ok;
  }

  /** The VM, created on first use (hdmv_vm_init in _play_hdmv). */
  private createVm(): HdmvVm {
    if (!this.vm) {
      const { index, movieObjects } = this.deps.disc;
      this.vm = new HdmvVm(movieObjects!, this.deps.regs, {
        numTitles: index.titles.length,
        firstPlay: this.isSupported(index.firstPlay),
        topMenu: this.isSupported(index.topMenu),
        seed: this.deps.seed,
      });
    }
    return this.vm;
  }

  private fail(message: string): void {
    this.deps.emit({ type: 'error', message });
  }

  private dropVm(): void {
    this.vm = null;
    this.hdmvSuspended = true;
    this.hdmvNumInvalidPl = 0;
    this.restorePlaylist = NO_PLAYLIST;
  }

  // ---- VM ----

  /** The HDMV part of _read_ext. */
  private runVm(): void {
    let loops = 0;
    while (this.titleType === 'hdmv' && this.vm && !this.hdmvSuspended) {
      if (this.runHdmv() < 0) {
        this.titleType = 'undef';
        return;
      }
      if (loops++ > MAX_VM_LOOPS) {
        // libbluray only queues an error and keeps looping; here the VM is dropped, the title stops and an `error` event reports it
        this.fail('HDMV program does not settle (possible live lock)');
        this.dropVm();
        this.titleType = 'undef';
        return;
      }
    }
    if (this.gcStatus & GcStatus.ANIMATE) this.runGc('NOP'); // _read_ext: only while animating (effects, buttons, user timeout)
  }

  /** _run_hdmv */
  private runHdmv(): number {
    const vm = this.vm!;
    let ev = vm.run();
    if (!ev) {
      this.fail('HDMV VM error');
      this.hdmvSuspended = !vm.running();
      return -1;
    }
    do {
      this.processHdmvVmEvent(ev);
    } while ((ev = vm.nextEvent()) !== null);
    this.hdmvSuspended = !vm.running();
    this.updateHdmvUoMask();
    return 0;
  }

  /** _process_hdmv_vm_event */
  private processHdmvVmEvent(ev: HdmvEvent): void {
    switch (ev.type) {
      case HdmvEventType.TITLE:
        this.closePlaylist(true);
        this.playTitleInternal(ev.param);
        break;

      case HdmvEventType.PLAY_PL:
      case HdmvEventType.PLAY_PL_PI:
      case HdmvEventType.PLAY_PL_PM: {
        const at = ev.type === HdmvEventType.PLAY_PL_PM ? { mark: ev.param2 } : ev.type === HdmvEventType.PLAY_PL_PI ? { item: ev.param2 } : {};
        this.openPlaylist(ev.param, at, (ok) => {
          if (!ok) {
            // Missing playlist: some discs probe for one, so resume the program (ignored after 10 in a row)
            this.hdmvNumInvalidPl++;
            if (this.hdmvNumInvalidPl < MAX_INVALID_PL && this.vm) {
              this.vm.resume();
              this.hdmvSuspended = !this.vm.running();
              this.runVm();
              return;
            }
          } else {
            this.hdmvNumInvalidPl = 0;
          }
          this.initMenu();
        });
        break;
      }

      case HdmvEventType.PLAY_PI:
        this.emitSeek({ item: ev.param });
        this.deps.port.seekPlayItem(ev.param);
        this.seekChapterUpdates({ item: ev.param });
        break;

      case HdmvEventType.PLAY_PM:
        this.emitSeek({ mark: ev.param });
        this.deps.port.seekMark(ev.param);
        this.seekChapterUpdates({ mark: ev.param });
        break;

      case HdmvEventType.PLAY_STOP:
        this.closePlaylist(true);
        this.hdmvSuspended = !this.vm?.running();
        break;

      case HdmvEventType.STILL:
        this.igStill = ev.param !== 0; // BD_EVENT_STILL
        this.syncHold();
        break;

      case HdmvEventType.ENABLE_BUTTON: this.runGc('ENABLE_BUTTON', ev.param); break;
      case HdmvEventType.DISABLE_BUTTON: this.runGc('DISABLE_BUTTON', ev.param); break;
      case HdmvEventType.SET_BUTTON_PAGE: this.runGc('SET_BUTTON_PAGE', ev.param); break;
      case HdmvEventType.POPUP_OFF: this.runGc('POPUP'); break;
      case HdmvEventType.IG_END: this.runGc('IG_END'); break;
      default: break; // END, NONE
    }
  }

  private onOverlay(op: OverlayOp): void {
    if (!this.plane) this.plane = new OverlayPlane(DEFAULT_PLANE_WIDTH, DEFAULT_PLANE_HEIGHT);
    if (op.cmd === 'draw') this.drawsSincePaint++;
    this.plane.apply(op);
  }

  /** The plane follows the composition's video descriptor; a new one starts blank (and dirty, so the old picture goes). */
  private ensurePlane(ds: IgDisplaySet): void {
    const width = ds.composition?.videoWidth || DEFAULT_PLANE_WIDTH;
    const height = ds.composition?.videoHeight || DEFAULT_PLANE_HEIGHT;
    if (this.plane && this.plane.width === width && this.plane.height === height) return;
    this.plane = new OverlayPlane(width, height);
    this.plane.apply({ cmd: 'clear', pts: -1, x: 0, y: 0, w: 0, h: 0 });
  }

  /**
   * The decode half of _read_ext for the IG stream: gc_decode_ts, and INIT_MENU for every complete display set.
   * libbluray decodes into gc->igs in place, so while a display set is still arriving (ICS seen, END not yet)
   * gc_run answers -1 to everything but reset; here only complete sets are handed over, so input in that window
   * acts on the previous set, a difference from libbluray).
   */
  private decodeDueIg(clockUs: number): void {
    if (!this.igReady || !this.playing) return;
    while (this.igQueue.length > 0 && (this.igQueue[0]!.dtsUs ?? this.igQueue[0]!.ptsUs) <= clockUs) {
      this.decodeIgUnit(this.igQueue.shift()!);
    }
  }

  /** gc_decode_ts for one graphics unit. `init`: INIT_MENU when it completes a display set (_read_ext does for the main path). Returns true if a display set completed. */
  private decodeIgUnit(unit: IgUnit, init = true): boolean {
    const to90 = (us: number): number => Math.round((us * 90) / 1000);
    const ds = this.igDecoder.push(unit.data, to90(unit.ptsUs), unit.dtsUs === undefined ? null : to90(unit.dtsUs));
    if (!ds) return false;
    if (!ds.composition) return true;
    if (this.igNeedsEpoch) {
      if (!ds.epochStart && ds.composition.compositionState !== COMPOSITION_ACQUISITION_POINT) return true;
      this.igNeedsEpoch = false;
    }
    this.ensurePlane(ds);
    if (this.gc.decodeDisplaySet(ds) && init) this.runGc('INIT_MENU'); // initialize menus (gc_decode_ts itself never does)
    return true;
  }

  /** _run_gc */
  private runGc(msg: GcCtrl, param = 0): number {
    const gc = this.gc;
    const vm = this.vm;
    if (!vm) {
      if (this.gcStatus & GcStatus.MENU_OPEN) this.deps.emit({ type: 'menu', active: false });
      if (this.gcStatus & GcStatus.POPUP) this.deps.emit({ type: 'popup', available: false });
      this.gcStatus = GcStatus.NONE;
      return -1;
    }

    const { result, cmds } = gc.run(GC_CTRL[msg], param);
    if (cmds.navCmds && cmds.navCmds.length > 0) {
      vm.setObject(cmds.navCmds);
      this.hdmvSuspended = !vm.running();
    }
    if (cmds.status !== this.gcStatus) {
      const changed = cmds.status ^ this.gcStatus;
      this.gcStatus = cmds.status;
      if (changed & GcStatus.MENU_OPEN) this.deps.emit({ type: 'menu', active: !!(this.gcStatus & GcStatus.MENU_OPEN) });
      if (changed & GcStatus.POPUP) this.deps.emit({ type: 'popup', available: !!(this.gcStatus & GcStatus.POPUP) });
    }
    if (cmds.soundId >= 0 && cmds.soundId < 0xff) this.deps.emit({ type: 'sound', id: cmds.soundId });
    this.gcUoMask = cmds.pageUoMask;
    this.updateUoMask();
    return result;
  }

  /**
   * gc_run(GC_CTRL_RESET) as _close_playlist calls it: no _run_gc epilogue, so no menu event and the page UO mask stays
   * until the next _run_gc. _gc_reset also frees the graphics processors.
   */
  private resetGc(): void {
    this.igDecoder.reset();
    this.igQueue = [];
    this.subIgQueue = [];
    this.subIgPid = -1;
    this.igNeedsEpoch = true;
    this.gc.run('reset');
  }

  /** _find_ig_stream: the IG entry PSR0 names in the current play item's STN. */
  private findIgEntry(): StreamEntry | undefined {
    const stn = this.playlist?.playItems[this.currentItem]?.stn;
    const stream = this.deps.regs.psrRead(PSR.IG_STREAM_ID);
    return stn && stream > 0 && stream <= stn.ig.length ? stn.ig[stream - 1] : undefined;
  }

  /**
   * _init_ig_stream, then INIT_MENU, as libbluray runs them after a playlist opens or is restored. libbluray preloads a
   * sub-path clip synchronously; here a preload still loading defers the INIT_MENU until it settles, so no INIT runs on an
   * empty controller in between.
   */
  private initMenu(): void {
    if (this.initIgStream() !== IG_INIT_PENDING) this.runGc('INIT_MENU');
  }

  /**
   * _init_ig_stream. A preloaded sub-path buffer is decoded whenever there is one, with the PID PSR0 names now, even if
   * that entry is a main-path stream. Otherwise a main-path IG stream is decoded from the clip as the pipeline delivers it.
   */
  private initIgStream(): number {
    this.igReady = false;
    const entry = this.findIgEntry();
    if (!entry) return 0;
    const preload = this.subIg;
    if (preload && !preload.failed) {
      if (preload.units) {
        this.decodePreloadedIg(preload.units, entry.pid);
        return 1;
      }
      preload.initPending = true;
      return IG_INIT_PENDING;
    }
    if (entry.streamType !== 2) {
      this.igReady = true;
      return 1;
    }
    return 0;
  }

  /** _find_ig_stream, then _preload_ig_subpath at playlist open (from _preload_subpaths): only stream_type 2 is a sub-path IG. */
  private startSubPathPreload(): void {
    this.dropSubIg();
    const entry = this.findIgEntry();
    const load = this.deps.preloadSubPathIg;
    if (!entry || entry.streamType !== 2 || !load) return;
    const clip = this.playlist?.subPaths[entry.subPathId]?.items[entry.subClipId]; // invalid subclip id: no preload
    if (!clip) return;
    const preload: SubIgPreload = { clipId: clip.clipId, abort: new AbortController(), units: null, failed: false, initPending: false };
    this.subIg = preload;
    const generation = this.generation;
    const current = (): boolean => generation === this.generation && this.subIg === preload;
    let request: Promise<IgUnit[]>;
    try {
      request = load(clip.clipId, preload.abort.signal);
    } catch (err) {
      request = Promise.reject(err);
    }
    request.then(
      (units) => {
        if (!current()) return;
        preload.units = units;
        if (!preload.initPending) return;
        preload.initPending = false;
        this.decodePreloadedIg(units, this.findIgEntry()?.pid ?? entry.pid);
        this.runGc('INIT_MENU'); // the INIT deferred by initMenu()
      },
      () => {
        if (!current()) return; // aborted or superseded
        this.subIgErrors++; // a failed preload means no menu, as _close_preload leaves no st_ig clip
        preload.failed = true;
        if (!preload.initPending) return;
        preload.initPending = false;
        this.runGc('INIT_MENU'); // the deferred INIT, as libbluray runs it on an empty controller after a failed preload
      },
    );
  }

  /**
   * gc_decode_ts(pid, buffer, ..., -1): the units of `pid` join the graphics processor's queue and are decoded from its
   * head with no timing gate, but graphics_processor_decode_pes returns at the first complete display set. The rest stays
   * queued (until the playlist closes). A different PID than last time flushes the queue (graphics_processor_decode_ts).
   * Decode only: INIT_MENU is the caller's.
   */
  private decodePreloadedIg(units: readonly IgUnit[], pid: number): void {
    if (pid !== this.subIgPid) this.subIgQueue = [];
    this.subIgPid = pid;
    for (const unit of units) if (unit.pid === pid) this.subIgQueue.push(unit);
    while (this.subIgQueue.length > 0) {
      if (this.decodeIgUnit(this.subIgQueue.shift()!, false)) return;
    }
  }

  private dropSubIg(): void {
    this.subIg?.abort.abort();
    this.subIg = null;
  }

  // ---- playlists ----

  /** _open_playlist; `done` is skipped when the playlist was superseded meanwhile. */
  private openPlaylist(num: number, at: PlayAt, done: (ok: boolean) => void): void {
    this.closePlaylist(false);
    this.igReady = false;
    const generation = ++this.generation;
    const id = String(num).padStart(5, '0');
    let request: Promise<boolean>;
    if (num > 99999) {
      request = Promise.resolve(false);
    } else {
      this.playlist = this.deps.disc.playlists.get(id) ?? null;
      this.playing = true;
      this.keepTime = at.clipTime45 ?? null;
      this.startAt = at;
      request = this.deps.port.playPlaylist(id, at);
    }
    request.then(
      (ok) => this.settleOpen(generation, ok, done),
      (err: unknown) => {
        if (generation === this.generation) this.fail(err instanceof Error ? err.message : String(err));
        this.settleOpen(generation, false, done);
      },
    );
  }

  private settleOpen(generation: number, ok: boolean, done: (ok: boolean) => void): void {
    if (generation !== this.generation) return;
    if (!ok) {
      this.playing = false;
      this.playlist = null;
    }
    done(ok);
  }

  /** _close_playlist; the port is only told to stop a playlist that has not ended. */
  private closePlaylist(stopPort: boolean): void {
    this.dropSubIg();
    this.resetGc();
    this.igReady = false;
    this.keepTime = null;
    this.startAt = null;
    this.generation++; // a pending playPlaylist() result no longer applies
    if (stopPort && this.playing && !this.ended) this.deps.port.stopPlaylist();
    this.playing = false;
    this.ended = false;
    this.playlist = null;
    this.itemStill = null;
    this.igStill = false;
    this.syncHold();
    this.st0UoMask = EMPTY_UO_MASK;
    this.gcUoMask = EMPTY_UO_MASK;
    this.updateUoMask();
  }

  /** End of title: resume the HDMV program that started the playlist. */
  private finishPlaylist(): void {
    this.ended = true;
    if (this.titleType === 'hdmv' && this.vm) {
      this.vm.resume();
      this.hdmvSuspended = !this.vm.running();
      this.runVm();
    }
  }

  /** bd_read_skip_still for a time still, then the usual end-of-item handling. */
  private skipStill(): void {
    const still = this.itemStill;
    this.itemStill = null;
    this.syncHold();
    if (still) this.afterItem(still.item);
  }

  private isLastItem(item: number): boolean {
    return !this.playlist || item >= this.playlist.playItems.length - 1;
  }

  /** After a still: bd_read_skip_still takes the next clip, or the end of title follows. */
  private afterItem(item: number): void {
    if (this.isLastItem(item)) this.finishPlaylist();
    else this.deps.port.seekPlayItem(item + 1);
  }

  private syncHold(): void {
    const want = this.itemStill !== null || this.igStill;
    if (want === this.held) return;
    this.held = want;
    this.deps.port.hold(want);
  }

  /** hdmv_vm RESUME restores PSR6 and PSR7: reopen the stored playlist at the stored play item. */
  private onPsrEvent(e: PsrEvent): void {
    if (e.type !== 'restore') return;
    switch (e.psr) {
      case PSR.TITLE_NUMBER:
        this.deps.emit({ type: 'title', title: e.newValue });
        break;
      case PSR.PLAYLIST:
        this.restorePlaylist = e.newValue;
        break;
      case PSR.PLAYITEM:
        this.restoreItem = e.newValue;
        break;
      case PSR.TIME: {
        const playlist = this.restorePlaylist;
        this.restorePlaylist = NO_PLAYLIST;
        if (playlist <= 99999) {
          this.openPlaylist(playlist, { item: this.restoreItem, clipTime45: e.newValue }, (ok) => {
            if (!ok) {
              this.fail(`Cannot restore playlist ${playlist}`);
              return;
            }
            this.initMenu();
          });
        }
        break;
      }
      default: break;
    }
  }

  // ---- UO masks ----

  private get psrs(): PlaybackPsrContext {
    return { regs: this.deps.regs, disc: this.deps.disc, playlist: this.playlist, geometry: this.geometry, titleType: this.titleType };
  }

  /** _update_time_psr from the presentation position. */
  private updateTimePsr(): void {
    updateTimePsr(this.psrs, this.currentItem, this.deps.port.currentClipTime45());
  }

  private openClip(item: number): void {
    const pl = this.playlist;
    const pi = pl?.playItems[item];
    this.currentItem = item;
    if (!pl || !pi) {
      this.updateUoMask();
      return;
    }
    this.st0UoMask = combineUoMasks(parseUoMaskTable(pl.uoMask), parseUoMaskTable(pi.uoMask));
    this.updateUoMask();
    updateClipPsrs(this.psrs, pl, item);
  }

  /** _update_uo_mask */
  private updateUoMask(): void {
    const next = combineUoMasks(this.gcUoMask, combineUoMasks(this.titleUoMask, this.st0UoMask));
    const changed = !sameMask(this.uoMaskValue, next);
    this.uoMaskValue = next;
    if (changed) this.deps.emit({ type: 'uoMask', mask: next });
  }

  /** _update_hdmv_uo_mask */
  private updateHdmvUoMask(): void {
    const mask = this.vm?.uoMask() ?? 0;
    const ops: UoOp[] = [];
    if (mask & HDMV_TITLE_SEARCH_MASK) ops.push('titleSearch');
    if (mask & HDMV_MENU_CALL_MASK) ops.push('menuCall');
    this.titleUoMask = new Set(ops);
    this.updateUoMask();
  }

  /** _is_uo_masked */
  private isUoMasked(op: UoOp): boolean {
    return this.titleType !== 'undef' && this.uoMaskValue.has(op);
  }

  // ---- chapter PSR ----

  /** The accepted bd_seek_mark / bd_seek_playitem request (before the clip is reopened). */
  private emitSeek(at: PlayAt): void {
    const pl = this.playlist;
    if (!pl) return;
    if (at.mark !== undefined) {
      if (pl.marks[at.mark]) this.deps.emit({ type: 'seek', what: 'mark', value: at.mark });
    } else if (at.item !== undefined && pl.playItems[at.item]) {
      this.deps.emit({ type: 'seek', what: 'item', value: at.item });
    }
  }

  /**
   * The _seek_internal tail (_find_next_playmark) of the bd_seek_playitem, bd_seek_mark and _clip_seek_time calls that
   * bd_seek_* / restore make; a seek that libbluray rejects (index out of range, time past the item) changes nothing.
   */
  private seekChapterUpdates(at: PlayAt): void {
    const pl = this.playlist;
    if (!pl) return;
    if (at.mark !== undefined) {
      const mark = pl.marks[at.mark];
      if (mark) updateChapterPsrAtPkt(this.psrs, markTitlePkt(this.psrs, mark));
      return;
    }
    const pi = at.item !== undefined ? pl.playItems[at.item] : undefined;
    if (at.item !== undefined && pi) updateChapterPsrAtPkt(this.psrs, this.geometry[at.item]?.titlePkt ?? 0); // out_pkt = clip->title_pkt
    if (at.clipTime45 !== undefined && at.item !== undefined && pi && at.clipTime45 < pi.outTime) {
      this.deps.emit({ type: 'seek', what: 'time', value: at.clipTime45 });
      const pkt = clipTimeSearch(this.psrs, at.item, at.clipTime45);
      if (pkt !== undefined) updateChapterPsrAtPkt(this.psrs, titlePkt(this.psrs, at.item, pkt));
    }
  }
}
