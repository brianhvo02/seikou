export interface AudioClockSource {
  readFrames(): number;
  readonly sampleRate: number;
  latencyUs(): number;
}

export type ClockMode = 'audio' | 'wall';

/** Playlist-time clock driven by audio frames played, or by wall time when there is no audio. */
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

  constructor(private readonly nowMs: () => number) {}

  get mode(): ClockMode {
    return this.clockMode;
  }

  useAudio(source: AudioClockSource, baseUs: number): void {
    this.clockMode = 'audio';
    this.audio = source;
    this.baseUs = baseUs;
    this.baseFrame = source.readFrames();
    this.wallStartMs = null;
    this.lastFrames = -1;
  }

  useWall(baseUs: number, running: boolean): void {
    this.clockMode = 'wall';
    this.audio = null;
    this.baseUs = baseUs;
    this.wallStartMs = running ? this.nowMs() : null;
  }

  setRunning(running: boolean): void {
    if (this.clockMode !== 'wall') return;
    if (running && this.wallStartMs === null) {
      this.wallStartMs = this.nowMs();
    } else if (!running && this.wallStartMs !== null) {
      this.baseUs = this.nowUs();
      this.wallStartMs = null;
    }
  }

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
