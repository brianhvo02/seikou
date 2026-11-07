import { describe, expect, it } from 'vitest';
import { PSR, RegisterFile, SETTING_PSRS, type PsrEvent, type RegisterWrite } from './registers';

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

  it('emits restore events for PSR4-12 except 9, without trace-logging writes', () => {
    const r = new RegisterFile();
    r.psrWrite(PSR.TITLE_NUMBER, 2);
    r.saveState();
    r.psrWrite(PSR.TITLE_NUMBER, 7);
    const events: PsrEvent[] = [];
    const writes: RegisterWrite[] = [];
    r.onPsrEvent((e) => events.push(e));
    r.onWrite = (w) => writes.push(w);
    r.restoreState();
    expect(events.map((e) => e.psr)).toEqual([4, 5, 6, 7, 8, 10, 11, 12]);
    expect(events.every((e) => e.type === 'restore')).toBe(true);
    expect(events[0]).toMatchObject({ oldValue: 7, newValue: 2 });
    expect(writes).toEqual([]);
    expect(r.psrRead(36)).toBe(0xffff); // backups return to their defaults
  });

  it('psrWriteBits merges masked bits', () => {
    const r = new RegisterFile();
    r.psrWrite(PSR.CHAPTER, 0xabcd);
    r.psrWriteBits(PSR.CHAPTER, 0x12, 0xff);
    expect(r.psrRead(PSR.CHAPTER)).toBe(0xab12);
    r.psrWriteBits(PSR.CHAPTER, 0xffffffff, 0xffffffff);
    expect(r.psrRead(PSR.CHAPTER)).toBe(0xffffffff);
  });
  it('psrInitUhd and psrInit3D switch the player profile as psr_init_UHD and psr_init_3D do', () => {
    const uhd = new RegisterFile();
    expect(uhd.psrInitUhd(true)).toBe(0);
    expect([25, 26, 27, 28].map((i) => uhd.psrRead(i))).toEqual([0xffffffff, 0xffffffff, 0xffffffff, 0]);
    expect(uhd.psrRead(PSR.PROFILE_VERSION)).toBe(0x0310);
    // without force, refused once the profile version is 3.0 or more
    expect(uhd.psrInit3D(1, false)).toBe(-1);
    expect(uhd.psrInitUhd(false)).toBe(-1);

    const s3d = new RegisterFile();
    expect(s3d.psrInit3D(1, false)).toBe(0);
    expect(s3d.psrRead(PSR.OUTPUT_PREFER)).toBe(1);
    expect(s3d.psrRead(23)).toBe(0x0f);
    expect(s3d.psrRead(24)).toBe(0xffffffff);
    expect(s3d.psrRead(PSR.PROFILE_VERSION)).toBe((0x13 << 16) | 0x0240);
    expect(s3d.psrRead(PSR['3D_STATUS'])).toBe(1);
    // the 3D flag refuses a second switch without force
    expect(s3d.psrInitUhd(false)).toBe(-1);
    expect(s3d.psrInitUhd(true)).toBe(0);
  });

  it('snapshots and loads every register, skipping the listed PSRs', () => {
    const a = new RegisterFile();
    a.psrWrite(PSR.PRIMARY_AUDIO_ID, 2);
    a.psrWrite(PSR.TITLE_NUMBER, 3);
    a.psrSettingWrite(PSR.AUDIO_LANG, 0x6a706e);
    a.gprWrite(0, 5);
    a.gprWrite(7, 9);
    a.gprWrite(4095, 0xffffffff);
    const s = a.snapshot();
    expect(s.psrs).toHaveLength(128);
    expect(s.psrs[PSR.TITLE_NUMBER]).toBe(3);
    expect(s.gprs).toEqual({ 0: 5, 7: 9, 4095: 0xffffffff });

    const shared = new SharedArrayBuffer((128 + 4096) * 4);
    const b = new RegisterFile({ shared });
    const initialLang = b.psrRead(PSR.AUDIO_LANG);
    const events: PsrEvent[] = [];
    b.onPsrEvent((e) => events.push(e));
    b.load(s, SETTING_PSRS);
    for (let i = 0; i < 128; i++) {
      expect(b.psrRead(i)).toBe(i === PSR.AUDIO_LANG ? initialLang : s.psrs[i]);
    }
    expect([b.gprRead(0), b.gprRead(7), b.gprRead(4095), b.gprRead(1)]).toEqual([5, 9, 0xffffffff, 0]);
    expect(events).toContainEqual({ type: 'change', psr: PSR.TITLE_NUMBER, oldValue: 0xffff, newValue: 3 });
    expect(events.some((e) => e.psr === PSR.AUDIO_LANG)).toBe(false);
    const mirror = new Int32Array(shared);
    expect(mirror[PSR.TITLE_NUMBER]).toBe(3);
    expect(mirror[128 + 7]).toBe(9);

    b.load({ psrs: s.psrs, gprs: { 0: 5 } }, SETTING_PSRS);
    expect(b.gprRead(7)).toBe(0);
    expect(b.gprRead(4095)).toBe(0);
    expect(mirror[128 + 7]).toBe(0);
  });

  it('lists the player-setting PSRs that psrWrite refuses', () => {
    const r = new RegisterFile();
    for (let i = 0; i < 128; i++) expect(SETTING_PSRS.has(i)).toBe(r.psrWrite(i, r.psrRead(i)) === -2);
  });
});
