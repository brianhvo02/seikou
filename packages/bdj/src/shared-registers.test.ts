import { describe, expect, it } from 'vitest';
import { RegisterFile } from '@seikou/engine/hdmv/registers';
import { createRegisterBuffer, REGISTER_WORDS, SharedRegisterView } from './shared-registers';

describe('shared registers', () => {
  it('has the documented size and initial values', () => {
    const buf = createRegisterBuffer();
    expect(buf.byteLength).toBe(REGISTER_WORDS * 4);
    expect(REGISTER_WORDS).toBe(4224);
    const view = new SharedRegisterView(buf);
    const plain = new RegisterFile();
    for (let i = 0; i < 128; i++) expect(view.psrRead(i)).toBe(plain.psrRead(i));
  });

  it('mirrors writes', () => {
    const buf = createRegisterBuffer();
    const rf = new RegisterFile({ shared: buf });
    const view = new SharedRegisterView(buf);
    rf.gprWrite(100, 42);
    rf.psrSettingWrite(20, 3);
    rf.psrWriteBits(102, 0x12, 0xff);
    expect(view.gprRead(100)).toBe(42);
    expect(view.psrRead(20)).toBe(3);
    expect(view.psrRead(102)).toBe(0x12);
  });

  it('mirrors save, restore, reset and init', () => {
    const buf = createRegisterBuffer();
    const rf = new RegisterFile({ shared: buf });
    const view = new SharedRegisterView(buf);
    rf.psrWrite(4, 7);
    rf.psrWrite(10, 9);
    rf.saveState();
    expect(view.psrRead(36)).toBe(7);
    expect(view.psrRead(42)).toBe(9);
    rf.psrWrite(4, 1);
    rf.restoreState();
    expect(view.psrRead(4)).toBe(7);
    expect(view.psrRead(10)).toBe(9);
    expect(view.psrRead(36)).toBe(rf.psrRead(36));
    rf.psrInitUhd(true);
    expect(view.psrRead(31)).toBe(rf.psrRead(31));
    expect(view.psrRead(25)).toBe(0xffffffff);
    rf.psrInit3D(1, true);
    expect(view.psrRead(24)).toBe(0xffffffff);
    rf.resetBackupRegisters();
    for (let i = 0; i < 128; i++) expect(view.psrRead(i)).toBe(rf.psrRead(i));
  });

  it('reads unsigned and out of range like RegisterFile', () => {
    const buf = createRegisterBuffer();
    const rf = new RegisterFile({ shared: buf });
    const view = new SharedRegisterView(buf);
    rf.gprWrite(5, 0xfffffff0);
    expect(view.gprRead(5)).toBe(0xfffffff0);
    expect(view.psrRead(128)).toBe(rf.psrRead(128));
    expect(view.psrRead(-1)).toBe(0xffffffff);
    expect(view.gprRead(4096)).toBe(0);
    expect(view.gprRead(-1)).toBe(0);
  });
});
