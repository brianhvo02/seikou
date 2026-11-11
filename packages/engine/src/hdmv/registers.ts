/*
 * Ported from libbluray src/libbluray/register.c
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/** Player status and setting registers (PSRs): 128 of them, numbered 0 to 127 (libbluray `BD_PSR_COUNT`). */
export const PSR_COUNT = 128;
/** General purpose registers (GPRs) a movie object's commands use freely: 4096 of them (libbluray's `bd_gpr` array). */
export const GPR_COUNT = 4096;

/**
 * The PSR numbers the player reads or writes by name, with libbluray's `register.h` names (`PSR_IG_STREAM_ID` and so on).
 * Values are unsigned 32-bit.
 */
export const PSR = {
  /** Number of the interactive graphics (IG) stream selected in the current play item's STN table; 0 is none. */
  IG_STREAM_ID: 0,
  /** Number of the primary audio stream selected (1-based; 0xFF is none, the initial value). */
  PRIMARY_AUDIO_ID: 1,
  /** The PG stream number in bits 0 to 11 (1-based, 0xFFF none) and the subtitle display flag in bit 31. */
  PG_STREAM: 2,
  /** Angle number, 1 to N. */
  ANGLE_NUMBER: 3,
  /** The current title: 1 to N, 0 for the Top Menu, 0xFFFF for First Play. */
  TITLE_NUMBER: 4,
  /** The current chapter, 1 to N; 0xFFFF when there is none. */
  CHAPTER: 5,
  /** The playlist's file number (`00001.mpls` is 1). */
  PLAYLIST: 6,
  /** The current play item, 0-based. */
  PLAYITEM: 7,
  /** The presentation time in the current clip, 45 kHz ticks (the same units as a play item's IN time). */
  TIME: 8,
  /** The navigation timer, in seconds, set by the SET_NV_TIMER command; 0 when none runs. */
  NAV_TIMER: 9,
  /** The IG menu's selected button id. */
  SELECTED_BUTTON_ID: 10,
  /** The IG menu's current page id. */
  MENU_PAGE_ID: 11,
  /** The text subtitle user style number. */
  STYLE: 12,
  /** The player's parental control level; a setting the program cannot write. */
  PARENTAL: 13,
  /** Secondary video and audio stream selections and their display flags. */
  SECONDARY_AUDIO_VIDEO: 14,
  /** The player's audio capabilities, a bit set of `BLURAY_ACAP_*` flags; a setting. */
  AUDIO_CAP: 15,
  /** The preferred audio language, three ISO 639-2 letters packed big-endian; a setting. */
  AUDIO_LANG: 16,
  /** The preferred subtitle (PG and text) language, packed like `AUDIO_LANG`; a setting. */
  PG_AND_SUB_LANG: 17,
  /** The preferred menu language, packed like `AUDIO_LANG`; a setting. */
  MENU_LANG: 18,
  /** The country code, two letters packed big-endian; a setting. */
  COUNTRY: 19,
  /** The player's region code (initially 2, region B); a setting. */
  REGION: 20,
  /** Whether the user prefers 2D (0) or 3D (1) output; a setting. */
  OUTPUT_PREFER: 21,
  /** The 3D output status; bit 0 is set for 3D. */
  '3D_STATUS': 22,
  /** The player profile and version: profile in the high bits, version in the low 16 (0x0200 is 2.0, 0x0300 and up Ultra HD). */
  PROFILE_VERSION: 31,
} as const;

/**
 * The player-setting PSRs that `psrWrite` refuses, as libbluray's `bd_psr_write` does: 13, 15 to 21, 23 to 31 and 48
 * to 61. Only `psrSettingWrite` (the host's settings path) changes them.
 */
export const SETTING_PSRS: ReadonlySet<number> = new Set([
  13, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61,
]);

/** Every register's value: all PSRs, and the GPRs that are not zero. */
export interface RegisterSnapshot {
  /** All 128 PSR values, index = PSR number. */
  readonly psrs: readonly number[];
  /** The GPRs holding a non-zero value, by GPR number; the rest are zero. */
  readonly gprs: Readonly<Record<number, number>>;
}

/**
 * What happened to a PSR, as libbluray's `BD_PSR_*` events: `write` (written, value unchanged), `change` (written, value
 * changed), `save` (`saveState` copied the playback registers to the backups) and `restore` (`restoreState` copied a
 * backup back).
 */
export type PsrEventType = 'save' | 'write' | 'change' | 'restore';
/** A PSR event, as listeners of `RegisterFile.onPsrEvent` get it (libbluray `BD_PSR_EVENT`). */
export interface PsrEvent {
  /** What happened. */
  readonly type: PsrEventType;
  /** The register number; -1 for `save`, which concerns several. */
  readonly psr: number;
  /** The value before; 0 for `save`. */
  readonly oldValue: number;
  /** The value after; 0 for `save`. */
  readonly newValue: number;
}
/** One successful register write, as the trace hook `onWrite` sees it. */
export interface RegisterWrite {
  /** Which register file was written. */
  readonly kind: 'gpr' | 'psr';
  /** The register number. */
  readonly index: number;
  /** The value now held (unsigned 32-bit). */
  readonly value: number;
}

const PSR_DISPLAY_CAP = 23;
const PSR_3D_CAP = 24;
const PSR_UHD_CAP = 25;
const PSR_UHD_DISPLAY_CAP = 26;
const PSR_UHD_HDR_PREFER = 27;
const PSR_UHD_SDR_CONV_PREFER = 28;
const OUTPUT_PREFER_3D = 1;
const DCAP_1080P_720P_3D = 0x01;
const DCAP_720P_50HZ_3D = 0x02;
const DCAP_NO_3D_CLASSES_REQUIRED = 0x04;
const DCAP_INTERLACED_3D = 0x08;
const PROFILE_5_V2_4 = (0x13 << 16) | 0x0240;
const PROFILE_6_V3_1 = (0x00 << 16) | 0x0310;
const PROFILE_3D_FLAG = 0x100000;
const PROFILE_VERSION_MASK = 0xffff;

/** The initial register values of libbluray's `bd_psr_init` table in `register.c`, which cites 5.8.2 for them. */
const PSR_INIT: readonly number[] = (() => {
  const t = new Array<number>(PSR_COUNT).fill(0);
  t[0] = 1; t[1] = 0xff; t[2] = 0x0fff0fff; t[3] = 1; t[4] = 0xffff; t[5] = 0xffff;
  t[10] = 0xffff; t[12] = 0xff; t[13] = 0xff; t[14] = 0xffff;
  // BLURAY_ACAP_{LPCM_48_96,LPCM_192,DDPLUS,DDPLUS_DEP,DTSHD_CORE,DTSHD_EXT,DD,MLP}_SURROUND
  t[15] = 0x0002 | 0x0008 | 0x0020 | 0x0080 | 0x0200 | 0x0800 | 0x2000 | 0x8000;
  t[16] = 0xffffff; t[17] = 0xffffff; t[18] = 0xffffff; t[19] = 0xffff;
  t[20] = 2; // BLURAY_REGION_B
  t[21] = 0; // BLURAY_OUTPUT_PREFER_2D
  t[29] = 0x01 | 0x02; // BLURAY_VCAP_SECONDARY_HD | BLURAY_VCAP_25Hz_50Hz
  t[30] = 0x1ffff;
  t[31] = (0x03 << 16) | 0x0200; // BLURAY_PLAYER_PROFILE_2_v2_0
  t[36] = 0xffff; t[37] = 0xffff; t[42] = 0xffff; t[44] = 0xff;
  for (let i = 48; i <= 61; i++) t[i] = 0xffffffff;
  return t;
})();

/**
 * The 128 PSRs and 4096 GPRs of the HDMV player (libbluray `BD_REGISTERS`, `register.c`), with its write rules and
 * change events. One instance is shared by the HDMV VM, the navigator, the graphics controller and the stream
 * selection, on the engine worker. With a `shared` buffer it also mirrors every value into it (PSRs first, then GPRs)
 * so the BD-J worker can read them with `Atomics`.
 */
export class RegisterFile {
  private readonly psr = Uint32Array.from(PSR_INIT);
  private readonly gpr = new Uint32Array(GPR_COUNT);
  private readonly listeners: ((e: PsrEvent) => void)[] = [];
  /** Trace hook (the vm-trace comparison sets it): called for every successful `bd_gpr_write` and `bd_psr_setting_write`, not for save and restore copies. */
  onWrite: ((w: RegisterWrite) => void) | null = null;
  private readonly mirror: Int32Array | null;

  /** `shared`, when given, receives a copy of every register: 128 PSR slots, then the GPR slots, as Int32. */
  constructor(options: { readonly shared?: SharedArrayBuffer } = {}) {
    this.mirror = options.shared ? new Int32Array(options.shared) : null;
    if (this.mirror) for (let i = 0; i < PSR_COUNT; i++) Atomics.store(this.mirror, i, this.psr[i]!);
  }

  /** The shared buffer the registers are mirrored to, if any. */
  get shared(): SharedArrayBuffer | null {
    return (this.mirror?.buffer as SharedArrayBuffer | undefined) ?? null;
  }

  private mirrorPsr(i: number): void {
    if (this.mirror) Atomics.store(this.mirror, i, this.psr[i]!);
  }

  /** Registers `listener` for PSR events (`bd_psr_register_cb`; a listener already registered is not added twice) and returns the function that removes it (`bd_psr_unregister_cb`). */
  onPsrEvent(listener: (e: PsrEvent) => void): () => void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(e: PsrEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  /** `bd_gpr_write`: sets GPR `i` and returns 0, or -1 for a number out of range. */
  gprWrite(i: number, v: number): number {
    if (!(i >= 0 && i < GPR_COUNT)) return -1;
    this.gpr[i] = v;
    if (this.mirror) Atomics.store(this.mirror, PSR_COUNT + i, this.gpr[i]!);
    this.onWrite?.({ kind: 'gpr', index: i, value: this.gpr[i]! });
    return 0;
  }

  /** The value of GPR `i`; 0 for a number out of range. */
  gprRead(i: number): number {
    return i >= 0 && i < GPR_COUNT ? this.gpr[i]! : 0;
  }

  /** The value of PSR `i` (`bd_psr_read`); 0xFFFFFFFF for a number out of range. */
  psrRead(i: number): number {
    return i >= 0 && i < PSR_COUNT ? this.psr[i]! : 0xffffffff;
  }

  /** `bd_psr_setting_write`: sets any PSR, including the settings (the host's path; the program's is `psrWrite`) and emits `write` or `change`. Returns 0, or -1 out of range. */
  psrSettingWrite(i: number, v: number): number {
    if (!(i >= 0 && i < PSR_COUNT)) return -1;
    const old = this.psr[i]!;
    this.psr[i] = v;
    this.mirrorPsr(i);
    const next = this.psr[i]!;
    this.emit({ type: old === next ? 'write' : 'change', psr: i, oldValue: old, newValue: next });
    this.onWrite?.({ kind: 'psr', index: i, value: next });
    return 0;
  }

  /** `bd_psr_write`, the program's write: refuses the player-setting registers (returns -2), else as `psrSettingWrite`. */
  psrWrite(i: number, v: number): number {
    if (SETTING_PSRS.has(i)) return -2;
    return this.psrSettingWrite(i, v);
  }

  /** `bd_psr_write_bits`: replaces only the bits of PSR `i` that are set in `mask` with those of `v`. */
  psrWriteBits(i: number, v: number, mask: number): number {
    if (mask >>> 0 === 0xffffffff) return this.psrWrite(i, v);
    const cur = this.psrRead(i);
    return this.psrWrite(i, ((cur & ~mask) | (v & mask)) >>> 0);
  }

  /** psr_init_3D: the Profile 5 (3D) player settings; without `force`, refused once the profile is 6 or 3D. */
  psrInit3D(initialMode: number, force: boolean): number {
    if (!force && !this.profileUpgradable()) return -1;
    this.psrSettingWrite(PSR.OUTPUT_PREFER, OUTPUT_PREFER_3D);
    this.psrSettingWrite(PSR_DISPLAY_CAP, DCAP_1080P_720P_3D | DCAP_720P_50HZ_3D | DCAP_NO_3D_CLASSES_REQUIRED | DCAP_INTERLACED_3D);
    this.psrSettingWrite(PSR_3D_CAP, 0xffffffff);
    this.psrSettingWrite(PSR.PROFILE_VERSION, PROFILE_5_V2_4);
    this.psrWrite(PSR['3D_STATUS'], initialMode ? 1 : 0);
    return 0;
  }

  /** psr_init_UHD: the Profile 6 (UHD) player settings; without `force`, refused once the profile is 6 or 3D. */
  psrInitUhd(force: boolean): number {
    if (!force && !this.profileUpgradable()) return -1;
    this.psrSettingWrite(PSR_UHD_CAP, 0xffffffff);
    this.psrSettingWrite(PSR_UHD_DISPLAY_CAP, 0xffffffff);
    this.psrSettingWrite(PSR_UHD_HDR_PREFER, 0xffffffff);
    this.psrSettingWrite(PSR_UHD_SDR_CONV_PREFER, 0);
    this.psrSettingWrite(PSR.PROFILE_VERSION, PROFILE_6_V3_1);
    return 0;
  }

  private profileUpgradable(): boolean {
    const profile = this.psrRead(PSR.PROFILE_VERSION);
    return (profile & PROFILE_VERSION_MASK) < 0x0300 && !(profile & PROFILE_3D_FLAG);
  }

  /** Not in libbluray: every PSR, and the non-zero GPRs, for resuming a disc later. */
  snapshot(): { psrs: number[]; gprs: Record<number, number> } {
    const gprs: Record<number, number> = {};
    for (let i = 0; i < GPR_COUNT; i++) if (this.gpr[i] !== 0) gprs[i] = this.gpr[i]!;
    return { psrs: Array.from(this.psr), gprs };
  }

  /**
   * Not in libbluray: writes a snapshot back. Every PSR not in `skip` goes through psrSettingWrite and every GPR that
   * the snapshot sets, or that must become zero, through gprWrite, so listeners, the trace hook and the shared mirror
   * see the usual writes.
   */
  load(s: RegisterSnapshot, skip: ReadonlySet<number>): void {
    for (let i = 0; i < PSR_COUNT; i++) {
      const v = s.psrs[i];
      if (v !== undefined && !skip.has(i)) this.psrSettingWrite(i, v >>> 0);
    }
    for (let i = 0; i < GPR_COUNT; i++) {
      const v = s.gprs[i];
      if (v !== undefined) this.gprWrite(i, v >>> 0);
      else if (this.gpr[i] !== 0) this.gprWrite(i, 0);
    }
  }

  /** `bd_psr_save_state`: backs up the playback state (PSR4 to 8 into PSR36 to 40, PSR10 to 12 into PSR42 to 44) when a menu is called, and emits `save`. */
  saveState(): void {
    this.psr.copyWithin(36, 4, 9);
    this.psr.copyWithin(42, 10, 13);
    for (let i = 36; i <= 44; i++) this.mirrorPsr(i);
    this.emit({ type: 'save', psr: -1, oldValue: 0, newValue: 0 });
  }

  /** `bd_psr_reset_backup_registers`: puts the backup registers (36 to 40 and 42 to 44) back to their initial values. */
  resetBackupRegisters(): void {
    for (const i of [36, 37, 38, 39, 40, 42, 43, 44]) { this.psr[i] = PSR_INIT[i]!; this.mirrorPsr(i); }
  }

  /** `bd_psr_restore_state`: copies the backups into PSR4 to 8 and 10 to 12, resets the backups and emits `restore` for each of those but PSR9. */
  restoreState(): void {
    const oldPsr = this.psr.slice(0, 13);
    this.psr.copyWithin(4, 36, 41);
    this.psr.copyWithin(10, 42, 45);
    for (let i = 4; i < 13; i++) this.mirrorPsr(i);
    const newPsr = this.psr.slice(0, 13);
    this.resetBackupRegisters();
    for (let i = 4; i < 13; i++) {
      if (i !== PSR.NAV_TIMER) this.emit({ type: 'restore', psr: i, oldValue: oldPsr[i]!, newValue: newPsr[i]! });
    }
  }
}
