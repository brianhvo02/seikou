// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PresentationClock } from './presentation-clock';
import { VideoPresenter, type PresentableFrame } from './video-presenter';

const FIELD_US = 1_000_000 / (60_000 / 1001); // 16 683 us: 59.94 pictures a second
const TICK_MS = 1000 / 60;

function picture(timestamp: number): PresentableFrame {
  return { timestamp, close() {} };
}

/**
 * Plays `seconds` of 59.94 pictures a second through a presenter at 60 Hz ticks, against an audio clock that moves
 * only every `stepMs` (as the AudioWorklet's played-frame count does), picking by the presentation clock. Returns the
 * presenter and the pictures it dropped after the first second (the clock's first step, a whole step at once, may pass
 * two pictures at the start).
 */
function play(stepMs: number, seconds: number): { presenter: VideoPresenter<PresentableFrame>; droppedAfterStart: number } {
  const presenter = new VideoPresenter<PresentableFrame>();
  const clock = new PresentationClock();
  let next = 0;
  let droppedAtOneSecond = 0;
  for (let tick = 0; tick * TICK_MS < seconds * 1000; tick++) {
    const nowMs = 1000 + tick * TICK_MS + 0.3;
    const clockUs = Math.floor((tick * TICK_MS) / stepMs) * stepMs * 1000;
    while (presenter.size < 8) presenter.push(picture(next++ * FIELD_US));
    presenter.select(clock.at(clockUs, true, nowMs));
    if (tick === 60) droppedAtOneSecond = presenter.dropped;
  }
  return { presenter, droppedAfterStart: presenter.dropped - droppedAtOneSecond };
}

describe('PresentationClock', () => {
  it("presents every field-rate picture once against a clock that moves in 21.3 ms steps (Chrome's audio callbacks)", () => {
    const { presenter, droppedAfterStart } = play(1024 / 48, 10);
    expect(droppedAfterStart).toBe(0);
    expect(presenter.dropped).toBe(0);
    expect(presenter.presented).toBeGreaterThanOrEqual(590);
  });

  it("presents every field-rate picture once against the iPhone's 25.6 ms steps and Chrome's 42.7 ms ones", () => {
    expect(play(1228.8 / 48, 10).droppedAfterStart).toBe(0);
    expect(play(2048 / 48, 10).droppedAfterStart).toBe(0);
  });

  it('holds the shown picture while the clock holds: paused, and a still past one step', () => {
    const clock = new PresentationClock();
    // running in 20 ms steps, then the clock holds while playing (a still at a play item's end)
    let t = 0;
    for (let ms = 0; ms <= 400; ms += 10) t = clock.at(Math.floor(ms / 20) * 20_000, true, ms);
    expect(t).toBeGreaterThanOrEqual(400_000);
    const held = 400_000;
    const during: number[] = [];
    for (let ms = 410; ms <= 1000; ms += 10) during.push(clock.at(held, true, ms));
    // never more than the cap ahead of the held clock, and back on it once the hold is known
    for (const d of during) expect(d).toBeLessThanOrEqual(held + 50_000);
    expect(during.at(-1)).toBe(held);
    // paused: the clock as it is
    expect(clock.at(held, false, 1010)).toBe(held);
    expect(clock.at(held, false, 1500)).toBe(held);
  });

  it('follows a seek back and a seek forward at once', () => {
    const clock = new PresentationClock();
    for (let ms = 0; ms <= 300; ms += 10) clock.at(10_000_000 + Math.floor(ms / 20) * 20_000, true, ms);
    // a seek back to 2 s, playing on from there
    expect(clock.at(2_000_000, true, 310)).toBe(2_000_000);
    expect(clock.at(2_000_000, true, 320)).toBeLessThanOrEqual(2_000_000 + 50_000);
    let t = 0;
    for (let ms = 330; ms <= 600; ms += 10) t = clock.at(2_000_000 + Math.floor((ms - 310) / 20) * 20_000, true, ms);
    expect(t).toBeGreaterThanOrEqual(2_000_000 + 280_000);
    expect(t).toBeLessThanOrEqual(2_000_000 + 300_000);
    // a seek forward to 30 s
    expect(clock.at(30_000_000, true, 610)).toBeGreaterThanOrEqual(30_000_000);
    expect(clock.at(30_000_000, true, 620)).toBeLessThanOrEqual(30_000_000 + 50_000);
  });

  it('passes a smooth clock (the wall clock with no audio) through unchanged', () => {
    const clock = new PresentationClock();
    for (let ms = 0; ms <= 500; ms += 16.7) expect(clock.at(ms * 1000, true, ms)).toBeCloseTo(ms * 1000, 3);
  });

  it('is never behind the clock it is given', () => {
    const clock = new PresentationClock();
    for (let ms = 0; ms <= 1000; ms += 7) {
      const c = Math.floor(ms / 21.3) * 21_300;
      expect(clock.at(c, true, ms)).toBeGreaterThanOrEqual(c);
    }
  });
});
