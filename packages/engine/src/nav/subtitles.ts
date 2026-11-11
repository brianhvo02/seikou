/*
 * Ported from libbluray src/libbluray/bluray.c (_find_pg_stream, _init_pg_stream, _select_pg_textst_stream,
 * the PSR2 branch of _process_psr_change_event and the PG part of _update_clip_psrs)
 * Copyright (C) 2009-2010  Obliter0n
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2010-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { PlayItem } from '@seikou/bdmv/mpls-parser';
import { OverlayPlane, PgRenderer, PgSegmentDecoder, type OverlayOp, type PgDisplaySet } from '@seikou/pg';
import { PSR, type PsrEvent, type RegisterFile } from '../hdmv/registers';
import type { UoOp } from '../hdmv/uo-mask';
import { langToUint32, updateStreamPsrByLang } from './stream-psrs';

/** A PG PES payload (one segment) in playlist time: its bytes, presentation time and, when the PES had one, decode time (microseconds). */
export interface PgUnit { readonly data: Uint8Array; readonly ptsUs: number; readonly dtsUs?: number }

/** What `PgStreamControl` needs from its host. */
export interface PgStreamControlDeps {
  /** The register file: PSR2 holds the PG stream number and display flag. */
  readonly regs: RegisterFile;
  /** The UO mask in force (the navigator's), or none. */
  isMasked(op: UoOp): boolean;
  /** PSR2 now asks for another PID (or none), or turned the display on: the player restarts the pipeline at the current time. */
  pidChanged(pid: number | null): void;
}

const MAX_QUEUED_SETS = 64;
const DISPLAY_FLAG = 0x80000000;

/**
 * PG stream selection and presentation (the engine worker's side of subtitles on a disc). libbluray decodes PG as it reads (stc -1, no DTS gating) and the
 * overlay consumer presents each flush at its PTS; here completed display sets are decoded on arrival,
 * queued, and rendered into the buffered plane when the clock reaches their PCS PTS.
 */
export class PgStreamControl {
  private planeValue = new OverlayPlane(1920, 1080, { buffered: true });
  private readonly decoder = new PgSegmentDecoder();
  private readonly renderer: PgRenderer;
  private readonly unsubscribe: () => void;
  private item: PlayItem | null = null;
  private pidValue: number | null = null;
  private sets: PgDisplaySet[] = [];
  private shownValue: { readonly objectsShown: number; readonly forced: number } | null = null;
  /** A PSR2 change not yet acted on (handled at the next tick, select or play item start). */
  private psrChanged = false;
  /** Playlist times of play item changes still ahead of presentation, ascending: PG resets as the clock gets to each. */
  private resetsAtUs: number[] = [];

  constructor(private readonly deps: PgStreamControlDeps) {
    this.renderer = new PgRenderer({ displayFlag: () => (deps.regs.psrRead(PSR.PG_STREAM) >>> 31) === 1, onOverlay: (op) => this.applyOverlay(op) });
    this.unsubscribe = deps.regs.onPsrEvent((e) => this.onPsrEvent(e));
  }

  /** Buffered; replaced by one of the composition's size when the PG overlay opens at another size. */
  get plane(): OverlayPlane {
    return this.planeValue;
  }

  /**
   * _init_pg_stream after the reader opens a play item; with `ownPsrs`, first the PG part of _update_clip_psrs.
   * `startUs` is where reading starts in playlist time: display sets of the previous item still queued before it are
   * shown first, and the reset of the plane waits until presentation reaches it (also with nothing queued while a
   * subtitle is on screen: its clear set may lie past OUT or in the next clip). After a seek the overlay is closed and
   * nothing is queued, so the reset is immediate.
   */
  playItemStarted(item: PlayItem, ownPsrs: boolean, startUs?: number): void {
    this.item = item;
    if (ownPsrs) this.updateClipPsrs(item);
    this.psrChanged = false;
    if (startUs !== undefined && (this.sets.length > 0 || this.renderer.open)) {
      this.decoder.reset();
      this.resetsAtUs = [...this.resetsAtUs.filter((t) => t < startUs), startUs];
      this.pidValue = this.findPgStream();
    } else {
      this.initPgStream();
    }
  }

  /** The PID to demux now, or null. */
  get pid(): number | null {
    return this.pidValue;
  }

  /** Decodes one PG segment; a completed display set joins the queue (the oldest is dropped past 64). Ignored while no PG stream is selected. */
  push(unit: PgUnit): void {
    if (this.pidValue === null) return;
    const ds = this.decoder.push(unit.data, unit.ptsUs, unit.dtsUs ?? null);
    if (!ds) return;
    this.sets.push(ds);
    if (this.sets.length > MAX_QUEUED_SETS) this.sets.shift();
  }

  /** Completed display sets waiting for their PTS. */
  get queued(): number {
    return this.sets.length;
  }

  /** Acts on a PSR2 change, then renders the display sets whose PTS ≤ clock, in order. */
  tick(clockUs: number): void {
    this.applyPsrChange();
    while (this.sets.length > 0 && this.sets[0]!.pts <= clockUs) {
      while (this.resetsAtUs.length > 0 && this.sets[0]!.pts >= this.resetsAtUs[0]!) this.itemReset();
      const ds = this.sets.shift()!;
      const drawn = this.renderer.render(ds); // GC_CTRL_PG_UPDATE
      this.shownValue = { objectsShown: drawn, forced: this.renderer.lastForced };
    }
    while (this.resetsAtUs.length > 0 && clockUs >= this.resetsAtUs[0]!) this.itemReset();
  }

  /** A seek: drop queued display sets and reset PG (GC_CTRL_PG_RESET in _seek_internal); the plane clears. */
  seek(): void {
    this.resetPg();
  }

  /** _select_pg_textst_stream with the UO mask checked: 'off' clears the display flag, {pg: n} sets stream n and the flag. */
  select(choice: { readonly pg: number } | 'off'): boolean {
    const initial = this.deps.regs.psrRead(PSR.PG_STREAM);
    const streamId = choice === 'off' ? initial & 0xfff : choice.pg;
    const enable = choice !== 'off';
    if (choice !== 'off' && !(choice.pg >= 1 && choice.pg <= (this.item?.stn.pg.length ?? 0))) return false;

    // Unlike libbluray, which applies the unmasked half, a user's pick is refused whole when any part of it is masked
    let value = 0;
    let mask = 0;
    if (enable !== ((initial & DISPLAY_FLAG) !== 0)) {
      if (this.deps.isMasked('pgEnableDisable')) return false;
      value |= enable ? DISPLAY_FLAG : 0;
      mask |= DISPLAY_FLAG;
    }
    if (streamId !== (initial & 0xfff)) {
      if (this.deps.isMasked('pgChange')) return false;
      value |= streamId & 0xfff;
      mask |= 0xfff;
    }
    if (mask) this.deps.regs.psrWriteBits(PSR.PG_STREAM, value >>> 0, mask >>> 0);
    this.applyPsrChange();
    return true;
  }

  /** PG tracks of the current play item (index = PSR2 stream number); sub-path streams are left out. */
  tracks(): Array<{ readonly index: number; readonly language: string }> {
    const pg = this.item?.stn.pg ?? [];
    return pg.flatMap((s, i) => (s.streamType === 2 ? [] : [{ index: i + 1, language: s.lang }]));
  }

  /** PSR2 stream (1-based, 0 none) and display flag. */
  get selection(): { readonly stream: number; readonly display: boolean } {
    const v = this.deps.regs.psrRead(PSR.PG_STREAM);
    const stream = v & 0xfff;
    return { stream: stream === 0xfff ? 0 : stream, display: (v & DISPLAY_FLAG) !== 0 };
  }

  /** Corrupt PG segments dropped so far. */
  get errors(): number {
    return this.decoder.errors;
  }

  /** The last render: objects drawn and how many were forced; null before any (and after a reset). */
  get shown(): { readonly objectsShown: number; readonly forced: number } | null {
    return this.shownValue;
  }

  /** Closes the plane and forgets the stream (disc closed). */
  stop(): void {
    this.unsubscribe();
    this.resetPg();
    this.item = null;
    this.pidValue = null;
    this.psrChanged = false;
  }

  private onPsrEvent(e: PsrEvent): void {
    if (e.type === 'change' && e.psr === PSR.PG_STREAM && this.item) this.psrChanged = true;
  }

  /**
   * The PSR2 branch of _process_psr_change_event: _init_pg_stream, then a pipeline restart when it shows more. With the
   * same PID only the plane is reset (libbluray resets the decoder too): queued display sets are decoded snapshots and the
   * display flag is read when each is rendered, so they stay, and a forced caption already read ahead still shows.
   */
  private applyPsrChange(): void {
    if (!this.psrChanged) return;
    this.psrChanged = false;
    const oldPid = this.pidValue;
    const pid = this.findPgStream();
    if (pid === oldPid) this.resetRenderer();
    else this.initPgStream();
    // the reset dropped the subtitle on screen; re-reading from now brings back the current one
    if (pid !== oldPid || (pid !== null && this.selection.display)) this.deps.pidChanged(pid);
  }

  /** _init_pg_stream */
  private initPgStream(): void {
    this.pidValue = null;
    this.resetPg();
    this.pidValue = this.findPgStream();
  }

  /** _find_pg_stream, main path only (a stream_type 2 entry is a sub-path stream: no PID). */
  private findPgStream(): number | null {
    const stn = this.item?.stn;
    if (!stn) return null;
    const stream = this.deps.regs.psrRead(PSR.PG_STREAM) & 0xfff;
    if (stream > 0 && stream <= stn.pg.length) {
      const entry = stn.pg[stream - 1]!;
      if (entry.streamType === 2) return null;
      return entry.pid || null;
    }
    return null;
  }

  /** GC_CTRL_PG_RESET: _reset_pg frees the decoder and display set and closes the overlay. */
  private resetPg(): void {
    this.sets = [];
    this.decoder.reset();
    this.resetRenderer();
    this.resetsAtUs = [];
  }

  private resetRenderer(): void {
    this.renderer.reset();
    this.shownValue = null;
  }

  /** The deferred _init_pg_stream reset of the next play item change, now that presentation has reached it. */
  private itemReset(): void {
    this.resetsAtUs.shift();
    this.resetRenderer();
  }

  /** The audio and PG parts of _update_clip_psrs, for discs without a navigator. */
  private updateClipPsrs(item: PlayItem): void {
    const regs = this.deps.regs;
    const stn = item.stn;
    let audioLang = 0;
    if (stn.audio.length > 0) {
      const v = regs.psrRead(PSR.PRIMARY_AUDIO_ID);
      if (v === 0 || v > stn.audio.length) {
        audioLang = updateStreamPsrByLang(regs, PSR.AUDIO_LANG, PSR.PRIMARY_AUDIO_ID, 0, stn.audio, 0);
      } else {
        audioLang = langToUint32(stn.audio[v - 1]!.lang);
      }
    }
    if (stn.pg.length > 0) {
      const v = regs.psrRead(PSR.PG_STREAM) & 0xfff;
      if (v === 0 || v > stn.pg.length) {
        updateStreamPsrByLang(regs, PSR.PG_AND_SUB_LANG, PSR.PG_STREAM, DISPLAY_FLAG, stn.pg, audioLang);
      }
    }
  }

  private applyOverlay(op: OverlayOp): void {
    if (op.cmd === 'init' && op.w > 0 && op.h > 0 && (op.w !== this.planeValue.width || op.h !== this.planeValue.height)) {
      this.planeValue = new OverlayPlane(op.w, op.h, { buffered: true });
    }
    this.planeValue.apply(op);
  }
}
