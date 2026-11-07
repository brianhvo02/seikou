import { describe, expect, it } from 'vitest';
import { Control, RingWriter, createRing, renderQuantum, ringViews } from './ring';

function stereo(frames: number, value: number): Float32Array {
  return new Float32Array(frames * 2).fill(value);
}

function quantum(views: ReturnType<typeof ringViews>, frames = 128): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  renderQuantum(views, left, right);
  return { left, right };
}

describe('audio ring', () => {
  it('stores capacity and sample rate in the buffer', () => {
    const views = ringViews(createRing(48_000, 0.5));
    expect(views.capacity).toBe(24_000);
    expect(views.sampleRate).toBe(48_000);
  });

  it('outputs silence and does not advance while paused', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.writeAt(0, stereo(256, 0.5));
    const { left } = quantum(views);
    expect(left.every((v) => v === 0)).toBe(true);
    expect(writer.readFrames()).toBe(0);
    expect(views.control[Control.Heartbeat]).toBe(1);
  });

  it('plays written frames in order while playing', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    const data = new Float32Array(256);
    for (let i = 0; i < 128; i++) {
      data[i * 2] = i;
      data[i * 2 + 1] = -i;
    }
    writer.writeAt(0, data);
    writer.setPlaying(true);
    const { left, right } = quantum(views);
    expect(left[5]).toBe(5);
    expect(right[5]).toBe(-5);
    expect(writer.readFrames()).toBe(128);
    expect(writer.buffered()).toBe(0);
  });

  it('keeps advancing on underrun and counts it', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.writeAt(0, stereo(64, 0.25));
    writer.setPlaying(true);
    const { left } = quantum(views);
    expect(left[63]).toBe(0.25);
    expect(left[64]).toBe(0);
    expect(writer.readFrames()).toBe(128);
    expect(writer.underruns()).toBe(1);
  });

  it('does not count the silence after the end of a stream as underruns, until playback restarts', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.writeAt(0, stereo(64, 0.25));
    writer.setPlaying(true);
    writer.setDraining(true); // everything the stream has is written
    quantum(views);
    quantum(views);
    expect(writer.readFrames()).toBe(256); // the clock keeps running through the silence
    expect(writer.underruns()).toBe(0);
    writer.setPlaying(false);
    writer.setPlaying(true); // a seek or the next playlist: running dry counts again
    quantum(views);
    expect(writer.underruns()).toBe(1);
  });

  it('writeAt fills gaps with silence, trims overlap and late samples, and refuses when full', () => {
    const views = ringViews(createRing(1000, 1)); // capacity 1000 frames
    const writer = new RingWriter(views);
    expect(writer.writeAt(10, stereo(10, 1))).toBe(true); // gap 0..9 becomes silence
    expect(writer.writtenFrames()).toBe(20);
    expect(writer.writeAt(15, stereo(10, 2))).toBe(true); // overlap 15..19 trimmed
    expect(writer.writtenFrames()).toBe(25);
    expect(writer.writeAt(0, stereo(5, 3))).toBe(true); // entirely late: dropped
    expect(writer.writtenFrames()).toBe(25);
    expect(views.data[0]).toBe(0);
    expect(views.data[10 * 2]).toBe(1);
    expect(views.data[20 * 2]).toBe(2);
    expect(writer.writeAt(25, stereo(976, 4))).toBe(false); // would exceed capacity
    expect(writer.writtenFrames()).toBe(25);
  });

  it('continues writing at the read head after an underrun skipped past the written end', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.setPlaying(true);
    quantum(views); // read = 128, written = 0
    expect(writer.writeAt(100, stereo(100, 1))).toBe(true); // frames 100..127 are late
    expect(writer.writtenFrames()).toBe(200);
    const { left } = quantum(views);
    expect(left[0]).toBe(1);
  });

  it('discards buffered audio via the worklet', async () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.writeAt(0, stereo(1000, 1));
    const done = writer.requestDiscard();
    quantum(views);
    await done;
    expect(writer.readFrames()).toBe(1000);
    expect(writer.buffered()).toBe(0);
  });

  it('discards by itself when the worklet is not running', async () => {
    const views = ringViews(createRing(48_000, 1));
    let now = 0;
    const writer = new RingWriter(views, () => (now += 60));
    writer.writeAt(0, stereo(500, 1));
    await writer.requestDiscard();
    expect(writer.readFrames()).toBe(500);
    expect(views.control[Control.DiscardRequest]).toBe(0);
  });

  it('plays frames written across the wrap-around point intact', () => {
    const views = ringViews(createRing(1000, 0.256)); // capacity 256 frames
    const writer = new RingWriter(views);
    const quantum = (): Float32Array => {
      const left = new Float32Array(128);
      renderQuantum(views, left, new Float32Array(128));
      return left;
    };
    writer.setPlaying(true);
    writer.writeAt(0, stereo(200, 0));
    quantum(); // read head at 128
    const data = new Float32Array(150 * 2);
    for (let i = 0; i < 150; i++) data[i * 2] = i + 1;
    expect(writer.writeAt(200, data)).toBe(true); // frames 200..349 → slots 200..255 then wrap to 0..93
    const first = quantum(); // frames 128..255
    expect(first[71]).toBe(0);
    expect(first[72]).toBe(1);
    expect(first[127]).toBe(56);
    const second = quantum(); // frames 256..383, read from wrapped slots 0..
    expect(second[0]).toBe(57);
    expect(second[93]).toBe(150);
    expect(second[94]).toBe(0); // past the written end: silence
  });
});
