import { describe, expect, it } from 'vitest';
import type { AudioWindow } from './disc-audio';
import { speechMask } from './speech';

function noiseWindow(seconds: number, bursts: readonly [number, number][]): AudioWindow {
  const pcm = new Int16Array(seconds * 16000);
  let seed = 1;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(rnd() * 20); // quiet floor
  for (const [from, to] of bursts) for (let i = from * 16; i < to * 16; i++) pcm[i] = Math.round(rnd() * 12000);
  return { startMs: 5000, pcm };
}

describe('speechMask', () => {
  it('marks three 1 s bursts within 20 ms and nothing else', () => {
    const bursts: [number, number][] = [[1000, 2000], [4000, 5000], [7000, 8000]];
    const mask = speechMask(noiseWindow(10, bursts));
    expect(mask.length).toBe(1000);
    for (let f = 0; f < mask.length; f++) {
      const ms = f * 10;
      const inside = bursts.some(([a, b]) => ms >= a + 20 && ms + 10 <= b - 20);
      const outside = bursts.every(([a, b]) => ms + 10 <= a - 20 || ms >= b + 20);
      if (inside) expect(mask[f], `frame ${f}`).toBe(1);
      if (outside) expect(mask[f], `frame ${f}`).toBe(0);
    }
  });

  it('is all zero on silence', () => {
    const mask = speechMask({ startMs: 0, pcm: new Int16Array(16000 * 3) });
    expect(mask.every((v) => v === 0)).toBe(true);
  });

  it('closes gaps under 200 ms and drops runs under 150 ms', () => {
    const w = noiseWindow(6, [[1000, 1500], [1600, 2100], [2400, 2900], [4000, 4100]]);
    const mask = speechMask(w);
    for (const f of [150, 155, 159]) expect(mask[f], `frame ${f}`).toBe(1); // 100 ms gap closed
    for (const f of [215, 225]) expect(mask[f], `frame ${f}`).toBe(0); // 300 ms gap kept
    expect(mask[405]).toBe(0); // 100 ms burst dropped
  });
});
