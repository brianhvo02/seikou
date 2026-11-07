import { describe, expect, it } from 'vitest';
import { DropMeter } from './drop-meter';

describe('DropMeter', () => {
  it('is null with under 1 s of samples', () => {
    const m = new DropMeter();
    expect(m.rate()).toBeNull();
    m.push(0, 0, 0);
    m.push(900, 108, 0);
    expect(m.rate()).toBeNull();
  });

  it('is 0 when nothing is dropped', () => {
    const m = new DropMeter();
    for (let s = 0; s <= 3; s++) m.push(s * 1000, s * 120, 0);
    expect(m.rate()).toBe(0);
  });

  it('is dropped over presented plus dropped', () => {
    const m = new DropMeter();
    for (let s = 0; s <= 3; s++) m.push(s * 1000, s * 100, s * 20);
    expect(m.rate()).toBeCloseTo(20 / 120, 10);
  });

  it('forgets samples older than the window', () => {
    const m = new DropMeter();
    for (let s = 0; s <= 5; s++) m.push(s * 1000, s * 100, s * 100); // 50 % dropped
    expect(m.rate()).toBeCloseTo(0.5, 10);
    for (let s = 6; s <= 12; s++) m.push(s * 1000, 500 + (s - 5) * 120, 500);
    expect(m.rate()).toBe(0);
  });

  it('resets the window when a counter goes down', () => {
    const m = new DropMeter();
    for (let s = 0; s <= 3; s++) m.push(s * 1000, s * 100, s * 20);
    m.push(4000, 10, 0);
    expect(m.rate()).toBeNull();
    m.push(5000, 130, 0);
    expect(m.rate()).toBe(0);
  });

  it('reset clears the samples', () => {
    const m = new DropMeter();
    m.push(0, 0, 0);
    m.push(2000, 200, 50);
    m.reset();
    expect(m.rate()).toBeNull();
  });
});
