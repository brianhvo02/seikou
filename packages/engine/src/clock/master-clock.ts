/** What the master clock reads from the audio output: how much it has played and how late it sounds. */
export interface AudioClockSource {
  /** Frames the output has played since it was created (the AudioWorklet's published count); only ever grows. */
  readFrames(): number;
  /** The output's sample rate in Hz, which converts frames to time. */
  readonly sampleRate: number;
  /** Output latency in microseconds: the time between a frame being counted as played and being heard. */
  latencyUs(): number;
}

/** Which source the clock follows: the audio output's played frames, or the wall clock when no audio is playable. */
export type ClockMode = 'audio' | 'wall';

/**
 * Playlist-time clock, in microseconds, driven by the audio frames played (minus the output latency), or by wall time
 * when there is no audio. Video frames are presented against it. It lives in the engine worker and does no scheduling
 * of its own; callers read nowUs() when they need the time.
 */
export class MasterClock {
  private clockMode: ClockMode = 'wall';
  private audio: AudioClockSource | null = null;
  private baseUs = 0;
  private baseFrame = 0;
  private wallStartMs: number | null = null;
  /** Audio mode: the frame count and time last read. While no frames play (paused) the time holds, whatever the
   *  output latency does meanwhile (Chrome moves outputLatency in steps of a few ms, paused or not). On resume, the
   *  first frames played apply any latency change made during the pause in one step, a few ms forward or back. */
  private lastFrames = -1;
  private lastUs = 0;

  /** `nowMs` is the wall clock in milliseconds (performance.now in the worker); it is injected so tests can drive it. */
  constructor(private readonly nowMs: () => number) {}

  /** The source the clock follows now. */
  get mode(): ClockMode {
    return this.clockMode;
  }

  /** Follows `source` from now on: the clock reads `baseUs` when the output has played no more frames than it has now. */
  useAudio(source: AudioClockSource, baseUs: number): void {
    this.clockMode = 'audio';
    this.audio = source;
    this.baseUs = baseUs;
    this.baseFrame = source.readFrames();
    this.wallStartMs = null;
    this.lastFrames = -1;
  }

  /** Follows the wall clock from `baseUs`; it advances only while `running` (see setRunning). */
  useWall(baseUs: number, running: boolean): void {
    this.clockMode = 'wall';
    this.audio = null;
    this.baseUs = baseUs;
    this.wallStartMs = running ? this.nowMs() : null;
  }

  /** Starts or stops the wall clock, keeping the time reached. Does nothing in audio mode, where the output's frames pace the time. */
  setRunning(running: boolean): void {
    if (this.clockMode !== 'wall') return;
    if (running && this.wallStartMs === null) {
      this.wallStartMs = this.nowMs();
    } else if (!running && this.wallStartMs !== null) {
      this.baseUs = this.nowUs();
      this.wallStartMs = null;
    }
  }

  /** The playlist time now, in microseconds. In audio mode it never goes below `baseUs` and holds while no frames play. */
  nowUs(): number {
    if (this.clockMode === 'audio' && this.audio) {
      const frames = this.audio.readFrames();
      if (frames === this.lastFrames) return this.lastUs;
      const playedUs = ((frames - this.baseFrame) * 1e6) / this.audio.sampleRate;
      this.lastFrames = frames;
      this.lastUs = this.baseUs + Math.max(0, playedUs - this.audio.latencyUs());
      return this.lastUs;
    }
    return this.wallStartMs === null ? this.baseUs : this.baseUs + (this.nowMs() - this.wallStartMs) * 1000;
  }
}
