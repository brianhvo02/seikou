import { describe, expect, it } from 'vitest';
import { parseAss } from '@seikou/ass/parse';
import { sampleTimes } from './times';

const script = (...events: string[]) => parseAss(`[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`);
const ev = (from: string, to: string, text: string) => `Dialogue: 0,${from},${to},Default,,0,0,0,,${text}`;

describe('sampleTimes', () => {
  it("takes every event's start, middle and last shown millisecond", () => {
    expect(sampleTimes(script(ev('0:00:01.00', '0:00:03.00', 'x')), null)).toEqual([1000, 2000, 2999]);
  });

  it('adds every frame (41 ms) of an animated event', () => {
    const t = sampleTimes(script(ev('0:00:01.00', '0:00:01.20', '{\\move(0,0,10,10)}x')), null);
    expect(t).toEqual([1000, 1041, 1082, 1100, 1123, 1164, 1199]);
  });

  it('keeps only the ten busiest animated events for frame-by-frame sampling', () => {
    const many = Array.from({ length: 12 }, (_, i) => ev(`0:00:${String(10 + i * 2).padStart(2, '0')}.00`, `0:00:${String(10 + i * 2).padStart(2, '0')}.10`, `${'{\\t(\\fs10)}'.repeat(i + 1)}x`));
    const t = sampleTimes(script(...many), null);
    // the two least busy (i = 0, 1) get start, middle and end only
    expect(t.filter((x) => x >= 10_000 && x < 10_100)).toEqual([10_000, 10_050, 10_099]);
    expect(t.filter((x) => x >= 32_000 && x < 32_100)).toEqual([32_000, 32_041, 32_050, 32_082, 32_099]);
  });

  it('uses the given times instead when there are some', () => {
    expect(sampleTimes(script(ev('0:00:01.00', '0:00:03.00', 'x')), [500, 100, 500])).toEqual([100, 500]);
  });
});
