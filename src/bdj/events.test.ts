import { describe, expect, it } from 'vitest';
import { RegisterFile, PSR } from '@seikou/engine/hdmv/registers';
import { BdjEvent } from './runtime';
import { bdjPlaybackEvents, bindBdjPsrEvents } from './events';

function setup(): { regs: RegisterFile; got: [number, number][]; unbind: () => void } {
  const regs = new RegisterFile();
  const got: [number, number][] = [];
  const unbind = bindBdjPsrEvents(regs, (e, p) => got.push([e, p]));
  return { regs, got, unbind };
}

describe('_process_psr_write_event (bluray.c:3365)', () => {
  it.each([
    ['PSR_ANGLE_NUMBER', PSR.ANGLE_NUMBER, BdjEvent.ANGLE],
    ['PSR_PLAYLIST', PSR.PLAYLIST, BdjEvent.PLAYLIST],
    ['PSR_PLAYITEM', PSR.PLAYITEM, BdjEvent.PLAYITEM],
    ['PSR_TIME', PSR.TIME, BdjEvent.PTS],
    ['PSR 102', 102, BdjEvent.PSR102],
  ])('%s write raises its event, also when unchanged', (_n, psr, ev) => {
    const { regs, got } = setup();
    regs.psrSettingWrite(psr, 7);
    regs.psrSettingWrite(psr, 7);
    expect(got).toEqual([[ev, 7], [ev, 7]]);
  });

  it('PSR 103 and PSR_TITLE_NUMBER raise no BD-J event', () => {
    const { regs, got } = setup();
    regs.psrSettingWrite(103, 5);
    regs.psrSettingWrite(PSR.TITLE_NUMBER, 2);
    expect(got).toEqual([]);
  });
});

describe('_process_psr_change_event (bluray.c:3401)', () => {
  it.each([
    ['PSR_CHAPTER', PSR.CHAPTER, BdjEvent.CHAPTER],
    ['PSR_PRIMARY_AUDIO_ID', PSR.PRIMARY_AUDIO_ID, BdjEvent.AUDIO_STREAM],
    ['PSR_PG_STREAM', PSR.PG_STREAM, BdjEvent.SUBTITLE],
    ['PSR_SECONDARY_AUDIO_VIDEO (14)', 14, BdjEvent.SECONDARY_STREAM],
  ])('%s change raises its event, an unchanged write does not', (_n, psr, ev) => {
    const { regs, got } = setup();
    regs.psrSettingWrite(psr, 3);
    expect(got).toEqual([[ev, 3]]);
    regs.psrSettingWrite(psr, 3);
    expect(got).toEqual([[ev, 3]]);
  });

  it('a changed write-event register raises it once (the write part of the change)', () => {
    const { regs, got } = setup();
    regs.psrSettingWrite(PSR.PLAYLIST, 9);
    expect(got).toEqual([[BdjEvent.PLAYLIST, 9]]);
  });

  it('_process_psr_event ignores save and restore', () => {
    const { regs, got } = setup();
    regs.psrSettingWrite(PSR.PLAYLIST, 1);
    got.length = 0;
    regs.saveState();
    regs.psrSettingWrite(PSR.PLAYLIST, 2);
    got.length = 0;
    regs.restoreState();
    expect(got).toEqual([]);
  });

  it('unbinding stops events', () => {
    const { regs, got, unbind } = setup();
    unbind();
    regs.psrSettingWrite(PSR.PLAYLIST, 1);
    expect(got).toEqual([]);
  });
});

describe('BD-J event sites in bluray.c', () => {
  it('bd_read_ext (:3903), _playmark_reached (:1672), _seek_internal (:1713), bd_set_rate (:4019), UO sites', () => {
    const got: [number, number][] = [];
    const ev = bdjPlaybackEvents((e, p) => got.push([e, p]));
    ev.endOfPlaylist(800);
    ev.markReached(3);
    ev.seeked(45000);
    ev.rate(0);
    ev.rate(90000);
    ev.uoMasked(12);
    expect(got).toEqual([
      [BdjEvent.END_OF_PLAYLIST, 800],
      [BdjEvent.MARK, 3],
      [BdjEvent.SEEK, 45000],
      [BdjEvent.RATE, 0],
      [BdjEvent.RATE, 90000],
      [BdjEvent.UO_MASKED, 12],
    ]);
  });
});
