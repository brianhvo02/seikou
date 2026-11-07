import { describe, expect, it } from 'vitest';
import { endSegment, icsSegment, odsSegment, type IcsSpec } from '../../../../tests/helpers/ig-builders';
import { IgSegmentDecoder } from './ig-decoder';

/** Hex bytes; on each line, text after two or more spaces is a comment. */
const hex = (s: string): Uint8Array => {
  const digits = s.split('\n').map((line) => line.trim().split(/ {2,}/)[0]!.replace(/\s+/g, '')).join('');
  return Uint8Array.from(digits.match(/../g)!.map((b) => parseInt(b, 16)));
};

// Assembled by hand from the field order in ig_decode.c / pg_decode.c, not by the builders.
const ICS_HEX = `
  18 0062
  0780 0438 10            video descriptor: 1920x1080, frame_rate code 1
  0001 80                 composition number 1, state 2 (epoch start)
  C0                      sequence descriptor: first + last
  000056                  interactive composition data length (86)
  40                      stream_model 0, ui_model 1 (pop-up)
  01 00000002             7 zero bits + composition_timeout_pts 0x100000002
  00 0001 5F90            7 zero bits + selection_timeout_pts 90000
  00000A                  user_timeout_duration 10
  01                      one page
  00 00 8000000000000000  page id 0, version 0, UO mask: menu_call
  00 00 00 00             in/out effects: no windows, no effects
  00                      animation_frame_rate_code
  0001 FFFF 02            default selected 1, default activated none, palette 2
  01                      one BOG
  0001 01                 default valid button 1, one button
  0001 0005 80            button id 1, numeric value 5, auto action
  0064 00C8               x 100, y 200
  FFFF FFFF FFFF FFFF     no neighbours
  000A 000B 00            normal 10..11, no repeat
  03 000C 000D 00         selected sound 3, objects 12..13, no repeat
  FF 000E 000F            activated sound none, objects 14..15
  0001                    one nav command
  41C20000 00000007 00000000
`;

const ODS_HEX = `
  15 0018
  0007 02 C0              object id 7, version 2, first + last
  000011                  object data length: 4 (size) + 13 (RLE)
  0004 0002               4x2
  01 008202 0001 0000     row 1: 1, 2 x2, 0 x1, end of line
  008409 0000             row 2: 9 x4, end of line
`;

describe('hand-assembled vectors', () => {
  it('decodes an interactive composition', () => {
    const d = new IgSegmentDecoder();
    expect(d.push(hex(ICS_HEX), 77, null)).toBeNull();
    const set = d.push(endSegment(), 0, null)!;
    expect(d.errors).toBe(0);
    expect(set).toMatchObject({ pts: 77, epochStart: true });
    const c = set.composition!;
    expect(c).toMatchObject({
      videoWidth: 1920, videoHeight: 1080, frameRate: 1, compositionNumber: 1, compositionState: 2, streamModel: 0, uiModel: 1,
      compositionTimeoutPts: 0x100000002, selectionTimeoutPts: 90000, userTimeoutDuration: 10,
    });
    expect(c.pages).toHaveLength(1);
    const p = c.pages[0]!;
    expect(p).toMatchObject({ id: 0, version: 0, defaultSelectedButton: 1, defaultActivatedButton: 0xffff, paletteId: 2, animationFrameRateCode: 0 });
    expect([...p.uoMask]).toEqual(['menuCall']);
    expect(p.bogs).toHaveLength(1);
    expect(p.bogs[0]!.defaultValidButton).toBe(1);
    const b = p.bogs[0]!.buttons[0]!;
    expect(b).toMatchObject({
      id: 1, numericSelectValue: 5, autoActionFlag: true, x: 100, y: 200, upper: 0xffff, lower: 0xffff, left: 0xffff, right: 0xffff,
      normalStart: 10, normalEnd: 11, normalRepeat: false, selectedSound: 3, selectedStart: 12, selectedEnd: 13, selectedRepeat: false,
      activatedSound: 0xff, activatedStart: 14, activatedEnd: 15,
    });
    expect(b.navCmds).toEqual([{
      insn: { opCnt: 2, grp: 0, subGrp: 1, immOp1: true, immOp2: true, branchOpt: 2, cmpOpt: 0, setOpt: 0 },
      dst: 7, src: 0,
    }]);
  });

  it('decodes an object', () => {
    const d = new IgSegmentDecoder();
    d.push(icsSegment({ compositionState: 'epochStart', uiModel: 'alwaysOn', pages: [] })[0]!, 0, null);
    d.push(hex(ODS_HEX), 0, null);
    const set = d.push(endSegment(), 0, null)!;
    expect(d.errors).toBe(0);
    expect(set.objects.get(7)).toEqual({
      id: 7, version: 2, width: 4, height: 2,
      img: [{ len: 1, color: 1 }, { len: 2, color: 2 }, { len: 1, color: 0 }, { len: 0, color: 0 }, { len: 4, color: 9 }, { len: 0, color: 0 }],
    });
  });

  it('builders produce the same bytes as the hand-assembled vectors, deterministically', () => {
    const spec: IcsSpec = {
      compositionNumber: 1, compositionState: 'epochStart', uiModel: 'popup', userTimeout: 10,
      compositionTimeout: 0x100000002, selectionTimeout: 90000,
      pages: [{
        id: 0, defaultSelected: 1, paletteId: 2, uoMask: hex('8000000000000000'),
        bogs: [{
          defaultValid: 1,
          buttons: [{
            id: 1, x: 100, y: 200, normal: [10, 11], selected: [12, 13], activated: [14, 15], selectedSound: 3, numericValue: 5, autoAction: true,
            cmds: [hex('41C200000000000700000000')],
          }],
        }],
      }],
    };
    const real = (): Uint8Array[] => icsSegment(spec);
    expect(real()).toEqual(real());
    expect(real()).toEqual([hex(ICS_HEX)]);
    expect(odsSegment(7, 2, 4, 2, [[1, 2, 2, 0], [9, 9, 9, 9]])).toEqual([hex(ODS_HEX)]);
    expect(odsSegment(7, 2, 4, 2, [[1, 2, 2, 0], [9, 9, 9, 9]])).toEqual(odsSegment(7, 2, 4, 2, [[1, 2, 2, 0], [9, 9, 9, 9]]));
  });
});

describe('large and failing objects', () => {
  it('decodes an object whose RLE exceeds 64 KB', () => {
    const rows = Array.from({ length: 400 }, (_, y) => Array.from({ length: 400 }, (_, x) => 1 + ((x + y) % 2)));
    const frags = odsSegment(1, 0, 400, 400, rows);
    expect(frags.length).toBeGreaterThan(2);
    const d = new IgSegmentDecoder();
    d.push(icsSegment({ compositionState: 'epochStart', uiModel: 'alwaysOn', pages: [] })[0]!, 0, null);
    for (const f of frags) d.push(f, 0, null);
    const set = d.push(endSegment(), 0, null)!;
    expect(d.errors).toBe(0);
    expect(set.objects.get(1)!.img.reduce((n, e) => n + e.len, 0)).toBe(160000);
  });

  it('keeps an existing object with an empty image when its update fails, and never adds a new one', () => {
    const d = new IgSegmentDecoder();
    const ics = icsSegment({ compositionState: 'epochStart', uiModel: 'alwaysOn', pages: [] })[0]!;
    d.push(ics, 0, null);
    d.push(odsSegment(4, 1, 2, 1, [[1, 1]])[0]!, 0, null);
    d.push(endSegment(), 0, null);
    const acq = icsSegment({ compositionState: 'acquisition', uiModel: 'alwaysOn', pages: [] })[0]!;
    d.push(acq, 0, null);
    d.push(odsSegment(4, 3, 4, 4, [[1, 1, 1, 1]])[0]!, 0, null); // too few pixels
    d.push(odsSegment(5, 3, 4, 4, [[1, 1, 1, 1]])[0]!, 0, null);
    const set = d.push(endSegment(), 0, null)!;
    expect(d.errors).toBe(2);
    expect(set.objects.get(4)).toEqual({ id: 4, version: 3, width: 4, height: 4, img: [] });
    expect(set.objects.has(5)).toBe(false);
  });
});
