/*
 * The BdjHost of the BD-J worker. The natives it answers locally follow libbluray src/libbluray/bluray.c
 * (bdpriv_reg_read, bdpriv_get_uo_mask, bd_tell_time, bd_get_disc_info, bd_get_playlist_info) and
 * bdj/native/org_videolan_Libbluray.c (getAacsDataN; updateGraphicN in graphics-plane.ts); the others are calls to the
 * engine worker.
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Clpi } from '@seikou/bdmv/clpi-parser';
import type { DiscModel } from '@seikou/engine/disc/open-disc';
import type { ScreenRect } from './background';
import { playlistInfo, titleInfos } from './disc-info';
import { updateGraphic, type GraphicsPlaneWriter } from './graphics-plane';
import type { BdjHost, PlaylistInfo, TitleInfo } from './host';
import type { SharedRegisterView } from './shared-registers';
import type { StatusBlockReader } from './status-block';
import type { BdjCallName, BdjWireValue } from './worker-protocol';

/** What the BD-J worker's host reads and calls. */
export interface WorkerBdjHostOptions {
  /** The register file the engine owns, read synchronously by Java's readRegN. */
  readonly regs: SharedRegisterView;
  /** The time and UO mask the engine publishes, read synchronously by tellTimeN and getUOMaskN. */
  readonly status: StatusBlockReader;
  /** Where updateGraphicN draws; without one, graphics are dropped. */
  readonly plane?: GraphicsPlaneWriter;
  /** Where displayImage's background stills go (the engine worker); without it, they are dropped. */
  readonly background?: (image: Uint8Array | null, rect: ScreenRect) => void;
  /** Sends a call to the engine worker and resolves with its reply (a Java long as a decimal string). */
  readonly call: (name: BdjCallName, args: readonly BdjWireValue[]) => Promise<number | string>;
  /** Read only once Java asks for disc information (the worker boots the JDK while it loads these). */
  readonly disc: DiscModel;
  /** The disc's parsed clips by clip id, for getPlaylistInfoN's clip and stream lists. */
  readonly clips: ReadonlyMap<string, Clpi>;
  /** Receives Java's log lines, `file:line: message` (`JVM` when there is no file). */
  readonly log: (line: string, error: boolean) => void;
}

const toInt = (v: number | string): number => Number(v) | 0;
const toLong = (v: number | string): bigint => BigInt(v);

/**
 * The BdjHost Java's natives call in the BD-J worker. Reads (registers, time, UO mask, title and playlist info), the
 * graphics plane and background stills are handled here without waiting; anything that changes playback or the
 * registers is a `call` to the engine worker, which applies it and replies.
 */
export class WorkerBdjHost implements BdjHost {
  private titles: readonly (TitleInfo | null)[] | null = null;

  constructor(private readonly opts: WorkerBdjHostOptions) {}

  private int(name: BdjCallName, args: readonly BdjWireValue[]): Promise<number> {
    return this.opts.call(name, args).then(toInt);
  }

  selectTitle(title: number): Promise<number> {
    return this.int('selectTitle', [title]);
  }

  selectPlaylist(playlist: number, playitem: number, playmark: number, time: bigint): Promise<number> {
    return this.int('selectPlaylist', [playlist, playitem, playmark, time.toString()]);
  }

  seek(playitem: number, playmark: number, time: bigint): Promise<bigint> {
    return this.opts.call('seek', [playitem, playmark, time.toString()]).then(toLong);
  }

  selectAngle(angle: number): Promise<number> {
    return this.int('selectAngle', [angle]);
  }

  selectRate(rate: number, reason: number): Promise<number> {
    return this.int('selectRate', [rate, reason]);
  }

  /** bd_tell_time: the title time in 90 kHz ticks, twice the 45 kHz out_time the engine publishes, as bd_tell_time doubles it. */
  tellTime(): bigint {
    return this.opts.status.time45() * 2n;
  }

  /** bdpriv_reg_read, as the signed int Java receives. */
  readReg(isPsr: number, num: number): number {
    return (isPsr ? this.opts.regs.psrRead(num) : this.opts.regs.gprRead(num)) | 0;
  }

  /** A round trip: the engine applies the write through its RegisterFile before the reply. */
  writeReg(isPsr: number, num: number, value: number, psrValueMask: number): Promise<number> {
    return this.int('writeReg', [isPsr, num, value, psrValueMask]);
  }

  getUOMask(): bigint {
    return this.opts.status.uoMask();
  }

  setUOMask(menuCallMask: boolean, titleSearchMask: boolean): Promise<void> {
    return this.opts.call('setUOMask', [menuCallMask, titleSearchMask]).then(() => undefined);
  }

  setKeyInterest(mask: number): Promise<void> {
    return this.opts.call('setKeyInterest', [mask]).then(() => undefined);
  }

  soundEffect(id: number): Promise<number> {
    return this.int('soundEffect', [id]);
  }

  getTitleInfos(): readonly (TitleInfo | null)[] {
    return (this.titles ??= titleInfos(this.opts.disc));
  }

  getPlaylistInfo(playlist: number): PlaylistInfo | null {
    return playlistInfo(this.opts.disc, this.opts.clips, playlist);
  }

  /** Decrypted discs have no AACS data. */
  getAacsData(_type: number): Uint8Array | null {
    return null;
  }

  setVirtualPackage(vpPath: string | null, psrBackup: boolean): Promise<number> {
    return this.int('setVirtualPackage', [vpPath, psrBackup]);
  }

  /** Java_org_videolan_Libbluray_updateGraphicN, into the shared graphics plane (graphics-plane.ts). */
  updateGraphic(width: number, height: number, argb: Int32Array | null, x0: number, y0: number, x1: number, y1: number): void {
    if (this.opts.plane) updateGraphic(this.opts.plane, width, height, argb, x0, y0, x1, y1);
  }

  /** A background still for the engine (natives/havi.ts); no reply, as displayImage returns at once. */
  displayImage(image: Uint8Array | null, rect: ScreenRect): void {
    this.opts.background?.(image, rect);
  }

  log(file: string | null, line: number, msg: string, error: boolean): void {
    this.opts.log(`${file ?? 'JVM'}:${line}: ${msg}`, error);
  }
}
