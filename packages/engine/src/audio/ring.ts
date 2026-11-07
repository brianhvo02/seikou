/** The output (AudioContext) rate: every decoder's PCM is delivered at, or resampled to, this rate. */
export const OUTPUT_SAMPLE_RATE = 48_000;

/** Control slot indices (Int32). */
export const Control = {
  Playing: 0,
  DiscardRequest: 1,
  LatencyUs: 2,
  Heartbeat: 3,
  Underruns: 4,
  Capacity: 5,
  SampleRate: 6,
  /** 1 once the engine has written all of the stream's audio: running dry then is its end, not an underrun. */
  Draining: 7,
} as const;

const CONTROL_SLOTS = 8;
const COUNTER_WRITTEN = 0;
const COUNTER_READ = 1;
const COUNTERS_BYTES = 16;
const HEADER_BYTES = COUNTERS_BYTES + CONTROL_SLOTS * 4;

export interface RingViews {
  /** [written frames, read frames], monotonically increasing. */
  readonly counters: BigInt64Array;
  readonly control: Int32Array;
  /** Interleaved stereo frames, `capacity` long. */
  readonly data: Float32Array;
  readonly capacity: number;
  readonly sampleRate: number;
}

export function createRing(sampleRate: number, seconds: number): SharedArrayBuffer {
  const capacity = Math.ceil(sampleRate * seconds);
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacity * 2 * Float32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(sab, COUNTERS_BYTES, CONTROL_SLOTS);
  control[Control.Capacity] = capacity;
  control[Control.SampleRate] = sampleRate;
  return sab;
}

export function ringViews(sab: SharedArrayBuffer): RingViews {
  const counters = new BigInt64Array(sab, 0, 2);
  const control = new Int32Array(sab, COUNTERS_BYTES, CONTROL_SLOTS);
  const capacity = control[Control.Capacity];
  return { counters, control, data: new Float32Array(sab, HEADER_BYTES, capacity * 2), capacity, sampleRate: control[Control.SampleRate] };
}

/** One AudioWorklet render quantum. Runs on the audio thread: no buffers are allocated (only the BigInt counter writes). */
export function renderQuantum(views: RingViews, left: Float32Array, right: Float32Array): void {
  const { counters, control, data, capacity } = views;
  Atomics.add(control, Control.Heartbeat, 1);
  if (Atomics.load(control, Control.DiscardRequest) === 1) {
    Atomics.store(counters, COUNTER_READ, Atomics.load(counters, COUNTER_WRITTEN));
    Atomics.store(control, Control.DiscardRequest, 0);
  }
  const frames = left.length;
  if (Atomics.load(control, Control.Playing) !== 1) {
    left.fill(0);
    right.fill(0);
    return;
  }
  const read = Number(Atomics.load(counters, COUNTER_READ));
  const written = Number(Atomics.load(counters, COUNTER_WRITTEN));
  const available = Math.max(0, Math.min(frames, written - read));
  for (let i = 0; i < available; i++) {
    const p = ((read + i) % capacity) * 2;
    left[i] = data[p];
    right[i] = data[p + 1];
  }
  left.fill(0, available);
  right.fill(0, available);
  if (available < frames && Atomics.load(control, Control.Draining) !== 1) Atomics.add(control, Control.Underruns, 1);
  Atomics.store(counters, COUNTER_READ, BigInt(read + frames));
}

/** Engine-side access to the ring. */
export class RingWriter {
  constructor(
    readonly views: RingViews,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  get sampleRate(): number {
    return this.views.sampleRate;
  }

  get playing(): boolean {
    return Atomics.load(this.views.control, Control.Playing) === 1;
  }

  readFrames(): number {
    return Number(Atomics.load(this.views.counters, COUNTER_READ));
  }

  writtenFrames(): number {
    return Number(Atomics.load(this.views.counters, COUNTER_WRITTEN));
  }

  buffered(): number {
    return Math.max(0, this.writtenFrames() - this.readFrames());
  }

  latencyUs(): number {
    return Math.max(0, Atomics.load(this.views.control, Control.LatencyUs));
  }

  heartbeat(): number {
    return Atomics.load(this.views.control, Control.Heartbeat);
  }

  underruns(): number {
    return Atomics.load(this.views.control, Control.Underruns);
  }

  /** Starting playback (a new stream, or after a seek) ends any draining. */
  setPlaying(on: boolean): void {
    if (on) Atomics.store(this.views.control, Control.Draining, 0);
    Atomics.store(this.views.control, Control.Playing, on ? 1 : 0);
  }

  /** All of the stream's audio is written; the silence that follows is the end of the stream, not an underrun. */
  setDraining(on: boolean): void {
    Atomics.store(this.views.control, Control.Draining, on ? 1 : 0);
  }

  /**
   * Writes stereo frames at absolute frame index `at`. Frames before the read head or already written are
   * trimmed; a gap after the written end is filled with silence. Returns false (writing nothing) if the
   * frames would not fit in the ring yet.
   */
  writeAt(at: number, stereo: Float32Array): boolean {
    const { data, capacity } = this.views;
    const read = this.readFrames();
    const written = Math.max(this.writtenFrames(), read);
    let frames = stereo.length / 2;
    let src = 0;
    let start = at;
    if (start < written) {
      const skip = written - start;
      if (skip >= frames) return true;
      src = skip;
      start = written;
      frames -= skip;
    }
    const end = start + frames;
    if (end - read > capacity) return false;
    for (let f = written; f < start; f++) {
      const p = (f % capacity) * 2;
      data[p] = 0;
      data[p + 1] = 0;
    }
    for (let i = 0; i < frames; i++) {
      const p = ((start + i) % capacity) * 2;
      data[p] = stereo[(src + i) * 2];
      data[p + 1] = stereo[(src + i) * 2 + 1];
    }
    Atomics.store(this.views.counters, COUNTER_WRITTEN, BigInt(end));
    return true;
  }

  /**
   * Writes silence from the written end up to absolute frame `to`, as far as the ring has room (never past the read
   * head plus capacity). Returns the frame written up to.
   */
  padTo(to: number): number {
    const { data, capacity } = this.views;
    const read = this.readFrames();
    const written = Math.max(this.writtenFrames(), read);
    const end = Math.min(to, read + capacity);
    if (end <= written) return written;
    for (let f = written; f < end; f++) {
      const p = (f % capacity) * 2;
      data[p] = 0;
      data[p + 1] = 0;
    }
    Atomics.store(this.views.counters, COUNTER_WRITTEN, BigInt(end));
    return end;
  }

  /** Drops everything buffered. The worklet does it at a quantum boundary; if it is not running, we do it. */
  async requestDiscard(): Promise<void> {
    const { control, counters } = this.views;
    Atomics.store(control, Control.DiscardRequest, 1);
    const startMs = this.nowMs();
    const beat = this.heartbeat();
    while (Atomics.load(control, Control.DiscardRequest) === 1) {
      if (this.nowMs() - startMs > 100 && this.heartbeat() === beat) {
        Atomics.store(counters, COUNTER_READ, Atomics.load(counters, COUNTER_WRITTEN));
        Atomics.store(control, Control.DiscardRequest, 0);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
}
