import { describe, expect, it } from 'vitest';
import type { PcmChunk } from '../decode/lpcm';
import { AudioWriter } from './audio-writer';
import { RingWriter, createRing, renderQuantum, ringViews } from './ring';

function chunk(ptsUs: number, frames: number, value: number, sampleRate = 48_000): PcmChunk {
  return { ptsUs, sampleRate, frames, stereo: new Float32Array(frames * 2).fill(value) };
}

function setup(seconds = 1): { writer: AudioWriter; ring: RingWriter; views: ReturnType<typeof ringViews> } {
  const views = ringViews(createRing(48_000, seconds));
  const ring = new RingWriter(views);
  return { writer: new AudioWriter(ring), ring, views };
}

describe('AudioWriter', () => {
  it('places chunks by PTS relative to the start time', () => {
    const { writer, ring, views } = setup();
    writer.start(10_000_000);
    writer.enqueue(chunk(10_000_000, 240, 1));
    writer.enqueue(chunk(10_010_000, 240, 2)); // 5 ms gap → 240 frames of silence
    expect(ring.writtenFrames()).toBe(720);
    expect(views.data[239 * 2]).toBe(1);
    expect(views.data[240 * 2]).toBe(0);
    expect(views.data[480 * 2]).toBe(2);
  });

  it('drops samples before the start time (seek trimming)', () => {
    const { writer, ring, views } = setup();
    writer.start(1_000_000);
    writer.enqueue(chunk(995_000, 480, 7)); // first 240 frames precede the start
    expect(ring.writtenFrames()).toBe(240);
    expect(views.data[0]).toBe(7);
  });

  it('queues chunks while the ring is full and drains when the reader advances', () => {
    const { writer, ring, views } = setup(0.01); // 480 frames
    writer.start(0);
    writer.enqueue(chunk(0, 480, 1));
    writer.enqueue(chunk(10_000, 240, 2));
    expect(writer.queuedChunks).toBe(1);
    ring.setPlaying(true);
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    writer.drain();
    expect(writer.queuedChunks).toBe(0);
    expect(ring.writtenFrames()).toBe(720);
  });

  it('fills silence where no audio will come, as the ring has room, after queued chunks and without trimming later audio', () => {
    const { writer, ring, views } = setup(0.01); // 480 frames
    writer.start(0);
    writer.enqueue(chunk(0, 480, 1));
    writer.enqueue(chunk(10_000, 240, 2)); // waits for room
    writer.fillSilenceTo(1_000_000);
    expect(writer.queuedChunks).toBe(1); // the queued chunk keeps its place: silence never goes ahead of it
    expect(ring.writtenFrames()).toBe(480);
    ring.setPlaying(true);
    for (let q = 0; q < 4; q++) renderQuantum(views, new Float32Array(128), new Float32Array(128));
    writer.drain();
    expect(writer.queuedChunks).toBe(0);
    expect(ring.writtenFrames()).toBe(512 + 480); // the chunk, then silence up to the ring's capacity
    expect(views.data[(700 % 480) * 2]).toBe(2);
    expect(views.data[(800 % 480) * 2]).toBe(0);
    writer.start(0);
    expect(ring.writtenFrames()).toBe(992); // start() forgets the silence target
    writer.drain();
    expect(ring.writtenFrames()).toBe(992);
  });

  it('maps media time to frames from the read head at start()', () => {
    const { writer, ring, views } = setup();
    ring.setPlaying(true);
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    writer.start(2_000_000);
    expect(writer.frameAt(2_000_000)).toBe(128);
    expect(writer.frameAt(2_001_000)).toBe(176);
  });

  it('rejects chunks at the wrong sample rate', () => {
    const { writer } = setup();
    writer.start(0);
    expect(() => writer.enqueue(chunk(0, 10, 1, 96_000))).toThrow(/sample rate/);
  });

  it('butts chunks together when their timestamps round within one frame of each other', () => {
    for (const nextPtsUs of [5_021, 4_979]) {
      const { writer, ring, views } = setup();
      writer.start(0);
      writer.enqueue(chunk(0, 240, 1)); // frames 0..239
      writer.enqueue(chunk(nextPtsUs, 240, 2)); // rounds to frame 241 or 239 — one frame off contiguous
      expect(ring.writtenFrames()).toBe(480);
      expect(views.data[240 * 2]).toBe(2); // no silent gap sample, no trimmed first sample
      expect(views.data[479 * 2]).toBe(2);
    }
  });
});
