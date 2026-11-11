/** The output (AudioContext) rate: every decoder's PCM is delivered at, or resampled to, this rate. */
export const OUTPUT_SAMPLE_RATE = 48_000;

/**
 * Indices of the ring's Int32 control slots, shared by the engine worker, the main thread and the AudioWorklet. Each is
 * read and written with `Atomics`.
 */
export const Control = {
  /** The engine sets 1 to let the worklet play the ring and 0 to make it output silence. */
  Playing: 0,
  /** The engine sets 1 to drop everything buffered; the worklet moves the read head to the write head and clears it. */
  DiscardRequest: 1,
  /** The main thread's estimate of the output latency (context output plus base latency), in microseconds. */
  LatencyUs: 2,
  /** The worklet adds 1 every render quantum, so the engine can tell whether it is running. */
  Heartbeat: 3,
  /** The worklet's count of quanta that found fewer frames than it needed while playing and not draining. */
  Underruns: 4,
  /** The ring's length in frames, fixed when it is created. */
  Capacity: 5,
  /** The ring's sample rate in hertz, fixed when it is created. */
  SampleRate: 6,
  /** 1 once the engine has written all of the stream's audio: running dry then is its end, not an underrun. */
  Draining: 7,
} as const;

const CONTROL_SLOTS = 8;
const COUNTER_WRITTEN = 0;
const COUNTER_READ = 1;
const COUNTERS_BYTES = 16;
const HEADER_BYTES = COUNTERS_BYTES + CONTROL_SLOTS * 4;

/** Typed views onto one ring's `SharedArrayBuffer`; every thread builds its own with `ringViews`. */
export interface RingViews {
  /** [written frames, read frames], monotonically increasing. The difference is what is buffered. */
  readonly counters: BigInt64Array;
  /** The control slots, indexed by `Control`. */
  readonly control: Int32Array;
  /** Interleaved stereo frames, `capacity` long. */
  readonly data: Float32Array;
  /** The ring's length in frames; frame `n` lives at `n % capacity`. */
  readonly capacity: number;
  /** Frames per second. */
  readonly sampleRate: number;
}

/**
 * Allocates a ring of `seconds` of stereo float audio at `sampleRate`: a 16-byte counter pair, the control slots and the
 * frames. The buffer is shared between threads, so the page needs cross-origin isolation.
 */
export function createRing(sampleRate: number, seconds: number): SharedArrayBuffer {
  const capacity = Math.ceil(sampleRate * seconds);
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacity * 2 * Float32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(sab, COUNTERS_BYTES, CONTROL_SLOTS);
  control[Control.Capacity] = capacity;
  control[Control.SampleRate] = sampleRate;
  return sab;
}

/** Reads capacity and sample rate from the buffer's control slots and wraps it in views, with no copy. */
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

/**
 * Engine-side (worker) access to the ring: the only writer of frames, and the owner of the Playing, Draining and
 * DiscardRequest slots. The audio thread reads; the main thread only sets LatencyUs.
 */
export class RingWriter {
  constructor(
    readonly views: RingViews,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  /** The ring's rate in hertz. */
  get sampleRate(): number {
    return this.views.sampleRate;
  }

  /** Whether the Playing slot is set. */
  get playing(): boolean {
    return Atomics.load(this.views.control, Control.Playing) === 1;
  }

  /** Frames the worklet has consumed since the ring was created (the audio clock reads this). */
  readFrames(): number {
    return Number(Atomics.load(this.views.counters, COUNTER_READ));
  }

  /** Frames written so far, counted from the ring's creation. */
  writtenFrames(): number {
    return Number(Atomics.load(this.views.counters, COUNTER_WRITTEN));
  }

  /** Frames written but not yet played. */
  buffered(): number {
    return Math.max(0, this.writtenFrames() - this.readFrames());
  }

  /** The output latency the main thread last published, in microseconds; never negative. */
  latencyUs(): number {
    return Math.max(0, Atomics.load(this.views.control, Control.LatencyUs));
  }

  /** How many render quanta the worklet has run; unchanged between two reads means it is not running. */
  heartbeat(): number {
    return Atomics.load(this.views.control, Control.Heartbeat);
  }

  /** How many render quanta ran short of frames (see `Control.Underruns`). */
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
