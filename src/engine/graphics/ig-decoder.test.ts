import { describe, expect, it } from 'vitest';
import { asm } from '../../../tests/helpers/hdmv-builders';
import { endSegment, icsSegment, odsSegment, pdsSegment, type IcsSpec } from '../../../tests/helpers/ig-builders';
import { parseMobjCmd } from '@seikou/bdmv/mobj-parser';
import { IgSegmentDecoder, type IgDisplaySet } from './ig-decoder';

function feed(d: IgSegmentDecoder, segs: Uint8Array[], pts = 1000): IgDisplaySet | null {
  let last: IgDisplaySet | null = null;
  for (const s of segs) last = d.push(s, pts, null) ?? last;
  return last;
}

const spec = (state: IcsSpec['compositionState'] = 'epochStart'): IcsSpec => ({
  compositionNumber: 7,
  compositionState: state,
  uiModel: 'popup',
  userTimeout: 0x012345,
  compositionTimeout: 2 ** 32 + 5,
  selectionTimeout: 90000,
  pages: [
    {
      id: 0, defaultSelected: 1, defaultActivated: 2, paletteId: 3, uoMask: Uint8Array.of(0x80, 0, 0, 0, 0, 0, 0, 0),
      inEffects: { windows: [[0, 10, 20, 30, 40]], effects: [{ duration: 0x010203, paletteId: 3, objects: [{ objectId: 4, windowId: 0, x: 11, y: 12 }] }] },
      bogs: [
        {
          defaultValid: 1,
          buttons: [
            { id: 1, x: 100, y: 200, neighbours: [0xffff, 2, 0xffff, 2], normal: [10, 11], selected: [12, 13], activated: [14, 15], selectedSound: 4, numericValue: 1, autoAction: true, cmds: [asm.nop(), asm.goto(9)] },
            { id: 2, x: 300, y: 200, neighbours: [1, 0xffff, 1, 0xffff], normal: [20, 20], selected: [21, 21], activated: [22, 22], cmds: [] },
          ],
        },
      ],
    },
    {
      id: 1, defaultSelected: 3, paletteId: 0,
      bogs: [
        { defaultValid: 3, buttons: [{ id: 3, x: 0, y: 0, normal: [0xffff, 0xffff], selected: [0xffff, 0xffff], activated: [0xffff, 0xffff], cmds: [asm.nop()] }] },
        { defaultValid: 0xffff, buttons: [] },
      ],
    },
  ],
});

describe('IgSegmentDecoder', () => {
  it('round-trips a two-page composition', () => {
    const d = new IgSegmentDecoder();
    const set = feed(d, [...icsSegment(spec()), endSegment()], 4242)!;
    expect(set).toMatchObject({ pts: 4242, epochStart: true, complete: true });
    const c = set.composition!;
    expect(c).toMatchObject({
      videoWidth: 1920, videoHeight: 1080, compositionNumber: 7, compositionState: 2, streamModel: 0, uiModel: 1,
      compositionTimeoutPts: 2 ** 32 + 5, selectionTimeoutPts: 90000, userTimeoutDuration: 0x012345,
    });
    expect(c.pages).toHaveLength(2);
    const p0 = c.pages[0]!;
    expect(p0).toMatchObject({ id: 0, defaultSelectedButton: 1, defaultActivatedButton: 2, paletteId: 3, animationFrameRateCode: 0 });
    expect([...p0.uoMask]).toEqual(['menuCall']);
    expect(p0.inEffects.windows).toEqual([{ id: 0, x: 10, y: 20, width: 30, height: 40 }]);
    expect(p0.inEffects.effects[0]).toMatchObject({ duration: 0x010203, paletteId: 3 });
    expect(p0.inEffects.effects[0]!.compositionObjects[0]).toMatchObject({ objectId: 4, windowId: 0, x: 11, y: 12, cropFlag: false });
    expect(p0.outEffects).toEqual({ windows: [], effects: [] });
    expect(p0.bogs).toHaveLength(1);
    const [b1, b2] = p0.bogs[0]!.buttons;
    expect(b1).toMatchObject({
      id: 1, numericSelectValue: 1, autoActionFlag: true, x: 100, y: 200, upper: 0xffff, lower: 2, left: 0xffff, right: 2,
      normalStart: 10, normalEnd: 11, selectedSound: 4, selectedStart: 12, selectedEnd: 13, activatedSound: 0xff, activatedStart: 14, activatedEnd: 15,
    });
    expect(b1!.navCmds).toEqual([parseMobjCmd(asm.nop()), parseMobjCmd(asm.goto(9))]);
    expect(b2).toMatchObject({ id: 2, numericSelectValue: 0xffff, autoActionFlag: false, navCmds: [] });
    expect(c.pages[1]!.bogs.map((b) => b.defaultValidButton)).toEqual([3, 0xffff]);
    expect(c.pages[1]!.bogs[0]!.buttons[0]!.navCmds).toHaveLength(1);
  });

  it('decodes a fragmented composition', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: i, x: i, y: 0, normal: [0, 0] as [number, number], selected: [0, 0] as [number, number], activated: [0, 0] as [number, number],
      cmds: [asm.nop(), asm.nop()],
    }));
    const s: IcsSpec = { compositionState: 'epochStart', uiModel: 'alwaysOn', pages: [{ id: 0, defaultSelected: 0, paletteId: 0, bogs: [{ defaultValid: 0, buttons: many }] }] };
    const frags = icsSegment(s, 2000);
    expect(frags.length).toBeGreaterThan(2);
    const set = feed(new IgSegmentDecoder(), [...frags, endSegment()])!;
    expect(set.composition!.pages[0]!.bogs[0]!.buttons).toHaveLength(200);
  });

  it('joins an object larger than one segment and a palette sets entries', () => {
    const rows = Array.from({ length: 90 }, (_, y) => Array.from({ length: 100 }, (_, x) => 1 + ((x + y) % 3)));
    const d = new IgSegmentDecoder();
    const set = feed(d, [
      ...icsSegment(spec()), pdsSegment(3, 1, [[1, 16, 128, 128, 255], [2, 235, 128, 128, 255]]),
      ...odsSegment(4, 2, 100, 90, rows, 1500), endSegment(),
    ])!;
    expect(d.errors).toBe(0);
    expect(set.palettes.get(3)!.entries[2]).toEqual({ y: 235, cr: 128, cb: 128, t: 255 });
    const obj = set.objects.get(4)!;
    expect(obj).toMatchObject({ version: 2, width: 100, height: 90 });
    expect(obj.img.reduce((n, e) => n + e.len, 0)).toBe(9000);
  });

  it('completes a display set only at END', () => {
    const d = new IgSegmentDecoder();
    for (const s of [...icsSegment(spec()), pdsSegment(3, 1, [[1, 1, 1, 1, 1]]), ...odsSegment(4, 0, 1, 1, [[1]])]) {
      expect(d.push(s, 0, null)).toBeNull();
    }
    expect(d.push(endSegment(), 0, null)).not.toBeNull();
    expect(d.push(endSegment(), 0, null)).toBeNull(); // orphan END
  });

  it('drops palettes and objects at an epoch start but keeps them for later states', () => {
    const d = new IgSegmentDecoder();
    const base = [pdsSegment(3, 1, [[1, 1, 1, 1, 1]]), ...odsSegment(4, 0, 1, 1, [[1]])];
    feed(d, [...icsSegment(spec('epochStart')), ...base, endSegment()]);
    const acq = feed(d, [...icsSegment(spec('acquisition')), endSegment()])!;
    expect(acq.epochStart).toBe(false);
    expect([...acq.palettes.keys()]).toEqual([3]);
    expect([...acq.objects.keys()]).toEqual([4]);
    const fresh = feed(d, [...icsSegment(spec('epochStart')), endSegment()])!;
    expect(fresh.epochStart).toBe(true);
    expect(fresh.palettes.size).toBe(0);
    expect(fresh.objects.size).toBe(0);
  });

  it('merges palette updates in a normal-state composition and replaces them otherwise', () => {
    const d = new IgSegmentDecoder();
    feed(d, [...icsSegment(spec('epochStart')), pdsSegment(3, 1, [[1, 9, 9, 9, 9]]), endSegment()]);
    const normal = feed(d, [...icsSegment(spec('normal')), pdsSegment(3, 2, [[2, 8, 8, 8, 8]]), endSegment()])!;
    expect(normal.palettes.get(3)!.entries[1]).toEqual({ y: 9, cr: 9, cb: 9, t: 9 });
    expect(normal.palettes.get(3)!.version).toBe(2);
    const acq = feed(d, [...icsSegment(spec('acquisition')), pdsSegment(3, 3, [[2, 7, 7, 7, 7]]), endSegment()])!;
    expect(acq.palettes.get(3)!.entries[1]).toEqual({ y: 0, cr: 0, cb: 0, t: 0 });
  });

  it('ignores objects and palettes that arrive outside a composition', () => {
    const d = new IgSegmentDecoder();
    expect(feed(d, [pdsSegment(3, 1, [[1, 1, 1, 1, 1]]), ...odsSegment(4, 0, 1, 1, [[1]]), endSegment()])).toBeNull();
    expect(d.errors).toBe(0);
  });

  it('counts a truncated ICS as an error and returns null', () => {
    const d = new IgSegmentDecoder();
    const [full] = icsSegment(spec());
    const cut = full!.subarray(0, full!.length - 20);
    expect(d.push(cut, 0, null)).toBeNull();
    expect(d.errors).toBe(1);
    expect(d.push(endSegment(), 0, null)).toBeNull(); // nothing is decoding
    expect(d.errors).toBe(1);
  });

  it('counts a corrupt object and drops it', () => {
    const d = new IgSegmentDecoder();
    const [ods] = odsSegment(4, 0, 4, 4, [[1, 1, 1, 1]]); // 4 rows promised, 1 given
    const set = feed(d, [...icsSegment(spec()), ods!, endSegment()])!;
    expect(d.errors).toBe(1);
    expect(set.objects.size).toBe(0);
    expect(set.composition).not.toBeNull();
  });

  it('reset forgets everything', () => {
    const d = new IgSegmentDecoder();
    feed(d, [...icsSegment(spec()), pdsSegment(3, 1, [[1, 1, 1, 1, 1]]), endSegment()]);
    d.reset();
    expect(d.push(endSegment(), 0, null)).toBeNull();
    const set = feed(d, [...icsSegment(spec('acquisition')), endSegment()])!;
    expect(set.palettes.size).toBe(0);
  });
});
