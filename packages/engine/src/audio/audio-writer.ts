import type { PcmChunk } from '../decode/lpcm';
import { applyMix, mixMatrix, outputLayout, sameLayout, type ChannelLayout, type OutputChannels } from './channel-map';
import type { RingWriter } from './ring';

/**
 * Places decoded PCM into the ring at the frame position implied by its PTS, mixed to the ring's channels
 * (`outputLayout` of its count; `channel-map.ts` has the rules). It runs on the engine worker; the audio thread plays
 * what it writes. Chunks that cannot fit yet wait in a queue and are written by `drain`.
 */
export class AudioWriter {
  private baseUs = 0;
  private baseFrame = 0;
  /** Frame just after the last chunk written; chunks landing within one frame of it are butted against it. */
  private nextFrame: number | null = null;
  private readonly queue: PcmChunk[] = [];
  /** Media time up to which no audio will come: silence is written there once the queue is empty (fillSilenceTo). */
  private silenceUntilUs = -Infinity;
  private readonly layout: ChannelLayout;
  /** The last source layout and its matrix into `layout`. */
  private mix: { source: ChannelLayout; matrix: Float64Array } | null = null;

  constructor(private readonly ring: RingWriter) {
    this.layout = outputLayout(ring.channels as OutputChannels);
  }

  /** The speakers of the ring this writer fills. */
  get outputLayout(): ChannelLayout {
    return this.layout;
  }

  /** Call after a discard: media time `baseUs` maps to the current read head. */
  start(baseUs: number): void {
    this.baseUs = baseUs;
    this.baseFrame = this.ring.readFrames();
    this.queue.length = 0;
    this.nextFrame = null;
    this.silenceUntilUs = -Infinity;
  }

  /** Chunks accepted but not yet written because the ring has no room. */
  get queuedChunks(): number {
    return this.queue.length;
  }

  /** The absolute ring frame where media time `us` (microseconds) belongs, from the base set by `start`. */
  frameAt(us: number): number {
    return this.baseFrame + Math.round(((us - this.baseUs) * this.ring.sampleRate) / 1e6);
  }

  /** Queues a chunk and writes what fits. Throws when the chunk's sample rate is not the ring's. */
  enqueue(chunk: PcmChunk): void {
    if (chunk.sampleRate !== this.ring.sampleRate) {
      throw new Error(`chunk sample rate ${chunk.sampleRate} does not match output ${this.ring.sampleRate}`);
    }
    this.queue.push(this.toOutput(chunk));
    this.drain();
  }

  private toOutput(chunk: PcmChunk): PcmChunk {
    if (sameLayout(chunk.channels, this.layout)) return chunk;
    if (!this.mix || !sameLayout(this.mix.source, chunk.channels)) this.mix = { source: chunk.channels, matrix: mixMatrix(chunk.channels, this.layout) };
    const samples = applyMix(chunk.samples, chunk.frames, chunk.channels.length, this.mix.matrix, this.layout.length);
    return { ...chunk, channels: this.layout, samples };
  }

  /**
   * No audio will come before media time `us` (a play item without the selected stream, or a stream whose packets are
   * missing): the ring is filled with silence up to there, so the output and the clock on it run on as through any
   * audio. Written as the ring has room, after any queued chunks; it never counts as queued (reading never waits on it).
   */
  fillSilenceTo(us: number): void {
    if (us > this.silenceUntilUs) this.silenceUntilUs = us;
    this.drain();
  }

  /** Writes queued chunks in order until one does not fit; once the queue is empty it pads any requested silence. Call again as the ring frees. */
  drain(): void {
    while (this.queue.length > 0) {
      const chunk = this.queue[0];
      let at = this.frameAt(chunk.ptsUs);
      if (this.nextFrame !== null && Math.abs(at - this.nextFrame) <= 1) at = this.nextFrame; // rounding, not a real gap
      if (!this.ring.writeAt(at, chunk.samples.subarray(0, chunk.frames * this.layout.length))) return;
      this.nextFrame = at + chunk.frames;
      this.queue.shift();
    }
    if (this.silenceUntilUs > -Infinity) this.ring.padTo(this.frameAt(this.silenceUntilUs));
  }
}
