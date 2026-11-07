import { describe, expect, it } from 'vitest';
import { MasterClock, type AudioClockSource } from './master-clock';

class FakeAudio implements AudioClockSource {
  frames = 0;
  latency = 0;
  readonly sampleRate = 48_000;
  readFrames(): number {
    return this.frames;
  }
  latencyUs(): number {
    return this.latency;
  }
}

describe('MasterClock', () => {
  it('wall mode holds while paused and advances while running', () => {
    let now = 1000;
    const clock = new MasterClock(() => now);
    clock.useWall(5_000_000, false);
    now += 500;
    expect(clock.nowUs()).toBe(5_000_000);
    clock.setRunning(true);
    now += 250;
    expect(clock.nowUs()).toBe(5_250_000);
    clock.setRunning(false);
    now += 1000;
    expect(clock.nowUs()).toBe(5_250_000);
    clock.setRunning(true);
    now += 100;
    expect(clock.nowUs()).toBe(5_350_000);
  });

  it('audio mode follows frames played minus output latency, clamped at the base', () => {
    const audio = new FakeAudio();
    audio.frames = 4800;
    const clock = new MasterClock(() => 0);
    clock.useAudio(audio, 2_000_000);
    expect(clock.mode).toBe('audio');
    audio.latency = 20_000;
    expect(clock.nowUs()).toBe(2_000_000);
    audio.frames += 4800; // 100 ms played
    expect(clock.nowUs()).toBe(2_080_000);
  });

  it('audio mode holds while no frames play, however the output latency moves (paused: Chrome varies it)', () => {
    const audio = new FakeAudio();
    const clock = new MasterClock(() => 0);
    clock.useAudio(audio, 0);
    audio.latency = 40_000;
    audio.frames = 48_000;
    expect(clock.nowUs()).toBe(960_000);
    for (const latency of [32_000, 48_000, 40_000, 24_000]) {
      audio.latency = latency;
      expect(clock.nowUs()).toBe(960_000);
    }
    // once frames play again, the latency it reads then applies
    audio.frames += 4800;
    expect(clock.nowUs()).toBe(1_076_000);
  });

  it('switches from audio to wall without a jump', () => {
    let now = 0;
    const audio = new FakeAudio();
    const clock = new MasterClock(() => now);
    clock.useAudio(audio, 0);
    audio.frames = 48_000;
    const t = clock.nowUs();
    clock.useWall(t, true);
    now += 10;
    expect(clock.mode).toBe('wall');
    expect(clock.nowUs()).toBe(1_010_000);
  });

  it('ignores setRunning in audio mode, so pausing cannot corrupt the audio-based time', () => {
    let now = 0;
    const audio = new FakeAudio();
    const clock = new MasterClock(() => now);
    clock.useAudio(audio, 0);
    audio.frames = 48_000; // 1 s played
    now = 5_000;
    clock.setRunning(false); // would fold a wall-clock reading into the base if it weren't ignored
    clock.setRunning(true);
    audio.frames = 96_000; // 2 s played
    now = 9_000;
    expect(clock.nowUs()).toBe(2_000_000);
  });
});
