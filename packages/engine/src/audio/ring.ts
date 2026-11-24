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
  /**
   * The main thread's estimate of the output latency (context output plus base latency), in microseconds, or
   * LATENCY_UNKNOWN while the output has not said it yet.
   */
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
  /** The ring's channels per frame (2, 6 or 8), fixed when it is created; the order is `outputLayout`'s. */
  Channels: 8,
} as const;

/**
 * What the main thread publishes as the latency while the output has not said it yet; the audio clock holds meanwhile.
 * @internal
 */
export const LATENCY_UNKNOWN = -1;

const CONTROL_SLOTS = 9;
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
  /** Interleaved frames of `channels` samples, `capacity` long. */
  readonly data: Float32Array;
  /** Samples per frame. */
  readonly channels: number;
  /** The ring's length in frames; frame `n` lives at `n % capacity`. */
  readonly capacity: number;
  /** Frames per second. */
  readonly sampleRate: number;
}

/**
 * Allocates a ring of `seconds` of float audio at `sampleRate` with `channels` channels (2, 6 or 8): a 16-byte counter
 * pair, the control slots and the frames. The buffer is shared between threads, so the page needs cross-origin
 * isolation.
 */
export function createRing(sampleRate: number, seconds: number, channels = 2): SharedArrayBuffer {
  const capacity = Math.ceil(sampleRate * seconds);
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacity * channels * Float32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(sab, COUNTERS_BYTES, CONTROL_SLOTS);
  control[Control.Capacity] = capacity;
  control[Control.SampleRate] = sampleRate;
  control[Control.Channels] = channels;
  return sab;
}

/** Reads capacity, sample rate and channels from the buffer's control slots and wraps it in views, with no copy. */
export function ringViews(sab: SharedArrayBuffer): RingViews {
  const counters = new BigInt64Array(sab, 0, 2);
  const control = new Int32Array(sab, COUNTERS_BYTES, CONTROL_SLOTS);
  const capacity = control[Control.Capacity];
  const channels = control[Control.Channels] || 2;
  return { counters, control, data: new Float32Array(sab, HEADER_BYTES, capacity * channels), capacity, sampleRate: control[Control.SampleRate], channels };
}

/** One AudioWorklet render quantum into one output array per channel (left, right, …); see renderChannels. */
export function renderQuantum(views: RingViews, ...outputs: Float32Array[]): void {
  renderChannels(views, outputs);
}

/**
 * One AudioWorklet render quantum. Runs on the audio thread: no buffers are allocated (only the BigInt counter writes).
 * Ring channel `c` goes to `outputs[c]`; outputs beyond the ring's channels get silence, ring channels beyond the
 * outputs are not heard.
 */
export function renderChannels(views: RingViews, outputs: readonly Float32Array[]): void {
  const { counters, control, data, capacity, channels } = views;
  Atomics.add(control, Control.Heartbeat, 1);
  if (Atomics.load(control, Control.DiscardRequest) === 1) {
    Atomics.store(counters, COUNTER_READ, Atomics.load(counters, COUNTER_WRITTEN));
    Atomics.store(control, Control.DiscardRequest, 0);
  }
  const frames = outputs[0]?.length ?? 0;
  if (Atomics.load(control, Control.Playing) !== 1) {
    for (const o of outputs) o.fill(0);
    return;
  }
  const read = Number(Atomics.load(counters, COUNTER_READ));
  const written = Number(Atomics.load(counters, COUNTER_WRITTEN));
  const available = Math.max(0, Math.min(frames, written - read));
  for (let c = 0; c < outputs.length; c++) {
    const out = outputs[c];
    if (c >= channels) {
      out.fill(0);
      continue;
    }
    for (let i = 0; i < available; i++) out[i] = data[((read + i) % capacity) * channels + c];
    out.fill(0, available);
  }
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

  /** Samples per frame (2, 6 or 8). */
  get channels(): number {
    return this.views.channels;
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

  /**
   * The output latency the main thread last published, in microseconds; Infinity while it is not known yet
   * ({@link LATENCY_UNKNOWN}), which holds the audio clock at its start.
   */
  latencyUs(): number {
    const us = Atomics.load(this.views.control, Control.LatencyUs);
    return us === LATENCY_UNKNOWN ? Infinity : Math.max(0, us);
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
   * Writes interleaved frames of the ring's channel count at absolute frame index `at`. Frames before the read head or
   * already written are trimmed; a gap after the written end is filled with silence. Returns false (writing nothing)
   * if the frames would not fit in the ring yet.
   */
  writeAt(at: number, samples: Float32Array): boolean {
    const { data, capacity, channels } = this.views;
    const read = this.readFrames();
    const written = Math.max(this.writtenFrames(), read);
    let frames = samples.length / channels;
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
    for (let f = written; f < start; f++) data.fill(0, (f % capacity) * channels, (f % capacity) * channels + channels);
    for (let i = 0; i < frames; i++) {
      const p = ((start + i) % capacity) * channels;
      const q = (src + i) * channels;
      for (let c = 0; c < channels; c++) data[p + c] = samples[q + c];
    }
    Atomics.store(this.views.counters, COUNTER_WRITTEN, BigInt(end));
    return true;
  }

  /**
   * Writes silence from the written end up to absolute frame `to`, as far as the ring has room (never past the read
   * head plus capacity). Returns the frame written up to.
   */
  padTo(to: number): number {
    const { data, capacity, channels } = this.views;
    const read = this.readFrames();
    const written = Math.max(this.writtenFrames(), read);
    const end = Math.min(to, read + capacity);
    if (end <= written) return written;
    for (let f = written; f < end; f++) data.fill(0, (f % capacity) * channels, (f % capacity) * channels + channels);
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
