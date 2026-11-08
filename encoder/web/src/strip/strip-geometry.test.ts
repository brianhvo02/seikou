// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { FansubAlignment } from '../api-types';
import { shiftAt, stripLanes } from './strip-geometry';

const none: FansubAlignment = { kind: 'none', reason: 'no-speech' };

describe('stripLanes', () => {
  it('moves dialogue by the offset plus the nudge, and leaves speech where it is', () => {
    const lanes = stripLanes({
      speech: [{ fromMs: 10_000, toMs: 12_000 }],
      dialogue: [{ fromMs: 10_000, toMs: 12_000 }],
      alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.9 },
      nudgeMs: -42,
      viewFromMs: 0,
      viewToMs: 20_000,
      widthPx: 20_000,
    });
    expect(lanes.top).toEqual([{ x: 10_000, width: 2000 }]);
    expect(lanes.bottom).toEqual([{ x: 11_158, width: 2000 }]);
  });

  it("moves each span by its split part's offset", () => {
    const alignment: FansubAlignment = { kind: 'split', parts: [{ fromMs: 0, offsetMs: 1000 }, { fromMs: 60_000, offsetMs: 500 }], confidence: 0.8 };
    const lanes = stripLanes({
      speech: [],
      dialogue: [{ fromMs: 5_000, toMs: 6_000 }, { fromMs: 70_000, toMs: 71_000 }],
      alignment,
      nudgeMs: 0,
      viewFromMs: 0,
      viewToMs: 100_000,
      widthPx: 100_000,
    });
    expect(lanes.bottom).toEqual([{ x: 6_000, width: 1000 }, { x: 70_500, width: 1000 }]);
    expect(shiftAt(alignment, 59_999)).toBe(1000);
    expect(shiftAt(alignment, 60_000)).toBe(500);
  });

  it('drops spans outside the view and clips one crossing its edge', () => {
    const lanes = stripLanes({
      speech: [{ fromMs: 0, toMs: 1000 }, { fromMs: 9_000, toMs: 11_000 }, { fromMs: 19_000, toMs: 22_000 }, { fromMs: 30_000, toMs: 31_000 }],
      dialogue: [],
      alignment: none,
      nudgeMs: 0,
      viewFromMs: 10_000,
      viewToMs: 20_000,
      widthPx: 10_000,
    });
    expect(lanes.top).toEqual([{ x: 0, width: 1000 }, { x: 9_000, width: 1000 }]);
  });

  it('scales milliseconds to pixels linearly', () => {
    const lanes = stripLanes({
      speech: [{ fromMs: 10_000, toMs: 12_000 }],
      dialogue: [{ fromMs: 10_000, toMs: 12_000 }],
      alignment: { kind: 'original' },
      nudgeMs: 3000,
      viewFromMs: 0,
      viewToMs: 30_000,
      widthPx: 300,
    });
    expect(lanes.top).toEqual([{ x: 100, width: 20 }]);
    expect(lanes.bottom).toEqual([{ x: 130, width: 20 }]);
  });
});
