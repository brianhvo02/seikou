/*
 * Ported from libbluray src/libbluray/bluray.c (bdpriv_play_playlist_at, _play_playlist_at, _open_playlist,
 * _close_playlist, bdpriv_seek, _seek_internal, bd_seek_playitem, bd_seek_mark, _seek_time, bdpriv_select_rate,
 * bd_set_rate, bdpriv_play_title_internal, _play_title, bdpriv_reg_write, bdpriv_sound_effect, bd_get_sound_effect,
 * bdpriv_set_bdj_uo_mask, _update_uo_mask, bd_select_angle, _bd_set_virtual_package, _playmark_reached, bd_read_ext's
 * END_OF_PLAYLIST)
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Mpls } from '@seikou/bdmv/mpls-parser';
import type { SoundData } from '@seikou/bdmv/sound-parser';
import type { DiscModel } from '@seikou/engine/disc/open-disc';
import { PSR } from '@seikou/engine/hdmv/registers';
import { EMPTY_UO_MASK, combineUoMasks, parseUoMaskTable, uoMaskBits, type UoMask, type UoOp } from '@seikou/engine/hdmv/uo-mask';
import type { PlayAt } from '@seikou/engine/nav/navigator';
import { itemPackets, type ItemPackets } from '@seikou/engine/nav/packets';
import {
  clipTimeSearch, markTitlePkt, titlePkt, updateChapterPsrAtPkt, updateClipPsrs, updatePlaylistPsrs, updateTimePsr,
  type PlaybackPsrContext, type TitleType,
} from '@seikou/engine/nav/playback-psrs';
import { Timeline } from '@seikou/engine/nav/timeline';
import type { BdjPlaybackListener } from '@seikou/engine/bdj-types';
import { ticks45ToUs } from '@seikou/engine/util/time';
import { TITLE_FIRST_PLAY, firstPlayInfo, titleOf } from './disc-info';
import { bindBdjPsrEvents } from './events';
import type { BdjWireValue, BdjCallName } from './worker-protocol';
import type { PlayerBdjHostDeps, PlayerBdjHostLike } from '@seikou/engine/bdj-types';
export type { PlayerBdjHostDeps } from '@seikou/engine/bdj-types';

type SeekStep = { readonly kind: 'item'; readonly item: number } | { readonly kind: 'mark'; readonly mark: number } | { readonly kind: 'time'; readonly t45: number };

/** Where a seek lands: _seek_internal's clip, clip time and title packet. */
interface SeekPosition {
  readonly item: number;
  readonly clipTime45: number;
  readonly titlePkt: number;
}

const TITLE_TOP_MENU = 0;
const MAX_PLAYLIST = 99999;
const MAX_ANGLE = 8;
const MAX_SOUND_ID = 0xff;
const BDJ_PLAYBACK_START = 1;
const BDJ_PLAYBACK_STOP = 2;

const num = (v: BdjWireValue | undefined): number => Number(v ?? 0);
const long = (v: BdjWireValue | undefined): bigint => BigInt(String(v ?? 0));

/**
 * The engine side of Java's playback calls (BdjCallName), carried out by the real player through its BdjPlaybackPort,
 * with the playback PSRs and UO mask kept as libbluray keeps them. Runs in the engine worker; the BD-J worker's
 * calls reach it through BdjSession.
 */
export class PlayerBdjHost implements PlayerBdjHostLike {
  private titleType: TitleType = 'bdj';
  /** bd->title: the open playlist, kept after its end until it is closed. */
  private playlist: Mpls | null = null;
  private timeline: Timeline | null = null;
  private geometry: readonly ItemPackets[] = [];
  private currentItem = 0;
  private angle = 0;
  /** Bumped by every open and close, so a superseded open neither seeks nor closes. */
  private openSeq = 0;
  /** The seeks of the playlist being opened, applied inside playlistStarted (select + seek are atomic in libbluray). */
  private pendingSteps: readonly SeekStep[] = [];
  private waitStart = false;
  private still = false;
  private lastTime45 = -1;
  private titleUo: UoMask = EMPTY_UO_MASK;
  private st0Uo: UoMask = EMPTY_UO_MASK;
  private uoMaskValue: UoMask = EMPTY_UO_MASK;
  private uoBits = 0n;
  private sounds: SoundData | null = null;
  private readonly unbindPsrs: (() => void) | null;

  constructor(private deps: PlayerBdjHostDeps) {
    this.unbindPsrs = deps.psrEvents ? bindBdjPsrEvents(deps.regs, deps.psrEvents) : null;
    deps.port.setListener(this.listener);
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

  /** Stops sending PSR events and playback news to Java (BD-J stopped). */
  dispose(): void {
    this.unbindPsrs?.();
    this.deps.port.setListener(null);
  }

  /** The operations masked now: the title's BD-J mask combined with the open play item's (bd->uo_mask). */
  get uoMask(): UoMask {
    return this.uoMaskValue;
  }

  /** _is_uo_masked: whether `op` is masked now; nothing is after a title failed to start (title type undefined). */
  isUoMasked(op: UoOp): boolean {
    return this.titleType !== 'undef' && this.uoMaskValue.has(op);
  }

  /** Carries out one call from the BD-J worker and gives the native's return value (a Java long as a decimal string). */
  async handle(name: BdjCallName, args: readonly BdjWireValue[]): Promise<number | string> {
    switch (name) {
      case 'selectTitle': return this.playTitle(num(args[0]) >>> 0);
      case 'selectPlaylist': return await this.selectPlaylist(num(args[0]), num(args[1]), num(args[2]), long(args[3]));
      case 'seek': return this.seek(num(args[0]), num(args[1]), long(args[2])).toString();
      case 'selectAngle': return this.selectAngle(num(args[0]));
      case 'selectRate': return this.selectRate(num(args[0]), num(args[1]));
      case 'writeReg': return this.writeReg(num(args[0]), num(args[1]), num(args[2]), num(args[3]));
      case 'soundEffect': return this.soundEffect(num(args[0]));
      case 'setVirtualPackage': return this.setVirtualPackage(args[1] === true);
      case 'setUOMask': return this.setUoMask(args[0] === true, args[1] === true);
      case 'setKeyInterest': return 0; // bdpriv_set_bdj_kit only tells the application (BD_EVENT_KEY_INTEREST_TABLE); keys go to Java unfiltered, as bd_user_input sends them
    }
  }

  /** bd_set_rate (_set_rate) at UO restriction RELAXED: no UO check; BDJ_EVENT_RATE under a BD-J title. */
  setRate(rate: number): number {
    if (!this.playlist) return -1;
    if (this.titleType === 'bdj') this.deps.events.rate(rate);
    return 0;
  }

  // ---- titles ----

  /** bdpriv_play_title_internal → _play_title */
  private playTitle(title: number): number {
    const { disc, regs } = this.deps;
    const index = disc.index;
    if (title === TITLE_FIRST_PLAY) {
      regs.psrWrite(PSR.TITLE_NUMBER, TITLE_FIRST_PLAY); // 5.2.3.3
      const fp = firstPlayInfo(disc);
      if (!fp) {
        this.titleType = 'hdmv'; // no first play title (5.2.3.3)
        return 1;
      }
      return fp.objectType === 'bdj' ? this.playBdj(title) : this.playHdmv(title);
    }
    if (this.titleType === 'undef') return 0;
    const top = index.topMenu;
    if (title === TITLE_TOP_MENU && !(top.kind === 'bdj' || (top.kind === 'hdmv' && top.movieObjectId !== 0xffff))) {
      this.titleType = 'hdmv'; // no top menu (5.2.3.3)
      return 0;
    }
    if (title > index.titles.length) return 0;
    regs.psrWrite(PSR.TITLE_NUMBER, title); // 5.2.3.3
    const t = titleOf(title, title === TITLE_TOP_MENU ? top : index.titles[title - 1]!.object);
    return t.objectType === 'bdj' ? this.playBdj(title) : this.playHdmv(title);
  }

  /** _play_bdj */
  private playBdj(title: number): number {
    this.titleType = 'bdj';
    this.deps.startTitle(title);
    return 1;
  }

  /** _play_hdmv: the player stops BD-J and runs the movie object. */
  private playHdmv(title: number): number {
    this.titleType = 'hdmv';
    if (this.deps.playHdmvTitle(title)) return 1;
    this.titleType = 'undef';
    return 0;
  }

  // ---- playlists ----

  /** bdpriv_play_playlist_at → _play_playlist_at, _open_playlist, bdpriv_seek */
  private async selectPlaylist(playlist: number, playitem: number, playmark: number, time: bigint): Promise<number> {
    if (playlist < 0) {
      this.closePlaylist();
      return 1;
    }
    if (playlist > MAX_PLAYLIST) return 0;
    this.closePlaylist();
    const seq = this.openSeq;
    const id = String(playlist).padStart(5, '0');
    const mpls = this.deps.disc.playlists.get(id);
    const steps = mpls ? seekSteps(new Timeline(mpls.playItems, mpls.marks), mpls, playitem, playmark, time) : [];
    const last = steps.at(-1);
    this.pendingSteps = steps;
    const opened = this.deps.port.playPlaylist(id, last && mpls ? playAtOf(mpls, last) : {});
    this.pendingSteps = [];
    this.waitStart = true; // playback is triggered by bdpriv_select_rate()
    const ok = await opened;
    if (seq !== this.openSeq) return 1; // a later selection or close superseded this one
    if (!ok) {
      this.closePlaylist();
      return 0;
    }
    // a START (or still) that came while the playlist loaded found nothing to play; it applies now
    this.deps.port.setRate(!this.waitStart && !this.still ? 1 : 0);
    return 1;
  }

  /** _close_playlist */
  private closePlaylist(): void {
    this.openSeq++;
    this.deps.port.stopPlaylist();
    this.playlist = null;
    this.timeline = null;
    this.geometry = [];
    this.st0Uo = EMPTY_UO_MASK;
    this.updateUoMask();
  }

  private get psrs(): PlaybackPsrContext {
    return { regs: this.deps.regs, disc: this.deps.disc, playlist: this.playlist, geometry: this.geometry, titleType: this.titleType };
  }

  private readonly listener: BdjPlaybackListener = {
    playlistStarted: (playlistId) => this.playlistOpened(playlistId),
    playItemChanged: (item) => {
      if (this.playlist && item !== this.currentItem) this.openClip(item);
    },
    marksReached: (marks, item, clipPkt) => {
      if (!this.playlist) return;
      for (const mark of marks) this.deps.events.markReached(mark);
      updateChapterPsrAtPkt(this.psrs, titlePkt(this.psrs, item, clipPkt));
    },
    position: (item, clipTime45) => {
      // bd_set_scr: the application reports the presentation time
      if (!this.playlist || item !== this.currentItem || clipTime45 === this.lastTime45) return;
      this.lastTime45 = clipTime45;
      updateTimePsr(this.psrs, item, clipTime45);
    },
    seeked: (item, clipTime45) => {
      if (!this.playlist) return;
      const pkt = clipTimeSearch(this.psrs, item, clipTime45);
      this.seekInternal({ item, clipTime45, titlePkt: pkt === undefined ? 0 : titlePkt(this.psrs, item, pkt) });
    },
    playlistEnded: () => {
      if (this.playlist && this.titleType === 'bdj') this.deps.events.endOfPlaylist(this.deps.regs.psrRead(PSR.PLAYLIST));
    },
  };

  /** The rest of _open_playlist once the player has the playlist: PSRs, the first clip, the first play mark, then the seeks. */
  private playlistOpened(playlistId: string): void {
    const pl = this.deps.disc.playlists.get(playlistId) ?? null;
    if (!pl) return;
    this.playlist = pl;
    this.timeline = new Timeline(pl.playItems, pl.marks);
    this.geometry = itemPackets(pl.playItems, this.deps.disc.clips);
    this.angle = 0;
    updatePlaylistPsrs(this.psrs, playlistId, 0, this.angle);
    this.openClip(0);
    updateChapterPsrAtPkt(this.psrs, 0); // _find_next_playmark at s_pos 0
    for (const step of this.pendingSteps) this.seekInternal(this.positionOf(step));
  }

  /** _open_m2ts: the clip's UO mask and PSRs. */
  private openClip(item: number): void {
    const pl = this.playlist!;
    const pi = pl.playItems[item];
    this.currentItem = item;
    this.lastTime45 = -1;
    if (!pi) return;
    this.st0Uo = combineUoMasks(parseUoMaskTable(pl.uoMask), parseUoMaskTable(pi.uoMask));
    this.updateUoMask();
    updateClipPsrs(this.psrs, pl, item);
  }

  // ---- seeking ----

  /** bdpriv_seek: each valid request is one _seek_internal, in this order; always 1. */
  private seek(playitem: number, playmark: number, time: bigint): bigint {
    const pl = this.playlist;
    if (!pl || !this.timeline) return 1n;
    for (const step of seekSteps(this.timeline, pl, playitem, playmark, time)) {
      this.seekInternal(this.positionOf(step));
      const port = this.deps.port;
      if (step.kind === 'item') port.seekPlayItem(step.item);
      else if (step.kind === 'mark') port.seekMark(step.mark);
      else port.seekTime45(step.t45);
    }
    return 1n;
  }

  /** bd_seek_playitem's, bd_seek_mark's (nav_mark_search) or _seek_time's (nav_time_search) target. */
  private positionOf(step: SeekStep): SeekPosition {
    const pl = this.playlist!;
    if (step.kind === 'item') {
      return { item: step.item, clipTime45: pl.playItems[step.item]!.inTime, titlePkt: this.geometry[step.item]?.titlePkt ?? 0 };
    }
    if (step.kind === 'mark') {
      const mark = pl.marks[step.mark]!;
      const item = mark.playItemRef >= pl.playItems.length ? 0 : mark.playItemRef;
      return { item, clipTime45: mark.time, titlePkt: markTitlePkt(this.psrs, mark) };
    }
    const at = this.timeline!.locate(ticks45ToUs(step.t45));
    const pkt = clipTimeSearch(this.psrs, at.item.index, at.clipTime45);
    return { item: at.item.index, clipTime45: at.clipTime45, titlePkt: pkt === undefined ? 0 : titlePkt(this.psrs, at.item.index, pkt) };
  }

  /**
   * _seek_internal: _seek_stream opens the target clip, PSR8 follows the new position, BDJ_EVENT_SEEK carries the
   * media time, and _find_next_playmark updates the chapter PSR. The position is the requested one, not the EP-map
   * packet's time.
   */
  private seekInternal(at: SeekPosition): void {
    const pl = this.playlist!;
    const pi = pl.playItems[at.item];
    if (!pi) return;
    if (at.item !== this.currentItem) this.openClip(at.item);
    updateTimePsr(this.psrs, at.item, at.clipTime45);
    this.lastTime45 = at.clipTime45;
    let mediaTime = at.clipTime45;
    if (mediaTime >= pi.inTime) mediaTime = mediaTime - pi.inTime + (this.timeline?.items[at.item]?.start ?? 0);
    this.deps.events.seeked(mediaTime);
    updateChapterPsrAtPkt(this.psrs, at.titlePkt);
  }

  // ---- the other calls ----

  /**
   * bd_select_angle(angle - 1) at RELAXED (no UO check): nav_set_angle, PSR3, then _open_m2ts reopens the clip (its UO
   * mask and PSRs). The player itself does not switch angle streams.
   */
  private selectAngle(angle: number): number {
    if (!this.playlist) return 0;
    const a = (angle - 1) >>> 0;
    if (a > MAX_ANGLE || a === this.angle) return 1;
    this.angle = a;
    this.deps.regs.psrWrite(PSR.ANGLE_NUMBER, a + 1);
    this.openClip(this.currentItem);
    return 1;
  }

  /**
   * bdpriv_select_rate: BD_EVENT_STILL for the application, which pauses or plays; bdj_wait_start holds a newly
   * selected playlist until a START. No BDJ_EVENT_RATE: that comes from the application's own bd_set_rate (setRate).
   * The player is told every time, so a pause or end it reached by itself does not hide Java's START.
   */
  private selectRate(rate: number, reason: number): number {
    if (reason === BDJ_PLAYBACK_STOP) return 1;
    if (reason === BDJ_PLAYBACK_START) this.waitStart = false;
    this.still = rate < 0.5;
    if (this.playlist) this.deps.port.setRate(!this.waitStart && !this.still ? 1 : 0);
    return 1;
  }

  /** bdpriv_reg_write: bd_psr_write_bits for PSRs, bd_gpr_write for GPRs. */
  private writeReg(isPsr: number, reg: number, value: number, psrValueMask: number): number {
    const regs = this.deps.regs;
    return isPsr ? regs.psrWriteBits(reg, value >>> 0, psrValueMask >>> 0) : regs.gprWrite(reg, value >>> 0);
  }

  /** bdpriv_sound_effect: the id is checked against sound.bdmv only once bd_get_sound_effect has loaded it. */
  private soundEffect(id: number): number {
    if (this.sounds && id >= this.sounds.clips.length) return -1;
    if (id < 0 || id > MAX_SOUND_ID) return -1;
    this.playSound(id);
    return 0;
  }

  /**
   * The application's BD_EVENT_SOUND_EFFECT: bd_get_sound_effect loads the sounds on first use (sound_get; the disc model
   * parsed them at open). Without a usable sound.bdmv nothing is loaded and ids stay unchecked, as in libbluray.
   */
  private playSound(id: number): void {
    this.sounds ??= this.deps.disc.sounds;
    if (this.sounds && id < this.sounds.clips.length) this.deps.port.playSound(id);
  }

  /** _bd_set_virtual_package: refused while a playlist is open or outside a BD-J title. No virtual package is mounted. */
  private setVirtualPackage(psrBackup: boolean): number {
    if (this.playlist || this.titleType !== 'bdj') return -1;
    if (psrBackup) this.deps.regs.resetBackupRegisters();
    return 0;
  }

  /** bdpriv_set_bdj_uo_mask: the title's own mask of Menu Call and Title Search. */
  private setUoMask(menuCall: boolean, titleSearch: boolean): number {
    const ops: UoOp[] = [];
    if (titleSearch) ops.push('titleSearch');
    if (menuCall) ops.push('menuCall');
    this.titleUo = new Set(ops);
    this.updateUoMask();
    return 0;
  }

  /** _update_uo_mask (gc_uo_mask is empty under a BD-J title). */
  private updateUoMask(): void {
    this.uoMaskValue = combineUoMasks(this.titleUo, this.st0Uo);
    const bits = uoMaskBits(this.uoMaskValue);
    if (bits === this.uoBits) return;
    this.uoBits = bits;
    this.deps.uoMaskChanged(bits);
  }
}

/** bdpriv_seek's requests that libbluray carries out: play item > 0, a mark in range, a 90 kHz time within the title. */
function seekSteps(timeline: Timeline, pl: Mpls, playitem: number, playmark: number, time: bigint): SeekStep[] {
  const steps: SeekStep[] = [];
  if (playitem > 0 && playitem < pl.playItems.length) steps.push({ kind: 'item', item: playitem });
  if (playmark >= 0 && playmark < pl.marks.length) steps.push({ kind: 'mark', mark: playmark });
  if (time >= 0n && time >> 33n === 0n) {
    const t45 = Number(time / 2n);
    if (t45 < timeline.duration45) steps.push({ kind: 'time', t45 });
  }
  return steps;
}

/** Where the player starts a playlist whose last seek is `step`. */
function playAtOf(pl: Mpls, step: SeekStep): PlayAt {
  if (step.kind === 'item') return { item: step.item };
  if (step.kind === 'mark') return { mark: step.mark };
  const timeline = new Timeline(pl.playItems, pl.marks);
  const at = timeline.locate(ticks45ToUs(step.t45));
  return { item: at.item.index, clipTime45: at.clipTime45 };
}

