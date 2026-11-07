import { describe, expect, it } from 'vitest';
import { EMPTY_UO_MASK, combineUoMasks, parseUoMaskTable } from './uo-mask';

describe('UO masks', () => {
  it('parses the 64-bit table in uo_mask.h order', () => {
    const t = new Uint8Array(8);
    t[0] = 0x80;          // first bit: menu_call
    t[0] |= 0x08;         // fifth bit: skip_to_next_point
    expect([...parseUoMaskTable(t)].sort()).toEqual(['menuCall', 'skipToNextPoint']);
  });

  it("decodes TSURUNE's menu playlist mask 3cb805ff40000000", () => {
    const t = Uint8Array.of(0x3c, 0xb8, 0x05, 0xff, 0x40, 0, 0, 0);
    expect([...parseUoMaskTable(t)].sort()).toEqual([
      'angleChange', 'backwardPlay', 'chapterSearch', 'forwardPlay', 'pauseOn', 'pgChange', 'pgEnableDisable', 'pipPgChange',
      'popupOff', 'popupOn', 'primaryAudioChange', 'secondaryAudioChange', 'secondaryAudioEnableDisable', 'secondaryVideoChange',
      'secondaryVideoEnableDisable', 'skipBackToPreviousPoint', 'skipToNextPoint', 'stillOff', 'timeSearch',
    ].sort());
  });

  it('combines masks as a union', () => {
    const a = parseUoMaskTable(Uint8Array.of(0x80, 0, 0, 0, 0, 0, 0, 0));
    expect([...combineUoMasks(a, EMPTY_UO_MASK)]).toEqual(['menuCall']);
    const b = parseUoMaskTable(Uint8Array.of(0x40, 0, 0, 0, 0, 0, 0, 0));
    expect([...combineUoMasks(a, b)].sort()).toEqual(['menuCall', 'titleSearch']);
  });

  it('honours the offset', () => {
    const t = Uint8Array.of(0xff, 0x80, 0, 0, 0, 0, 0, 0, 0);
    expect([...parseUoMaskTable(t, 1)]).toEqual(['menuCall']);
  });
});
