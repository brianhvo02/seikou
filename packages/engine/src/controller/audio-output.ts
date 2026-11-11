import { Control, OUTPUT_SAMPLE_RATE, createRing, ringViews } from '../audio/ring';
import type { AudioOutputLike } from './player-controller';
import workletUrl from './pcm-worklet.ts?worker&url';

const RING_SECONDS = 2;

/**
 * A 48 kHz stereo `AudioContext` that plays the shared PCM ring (`../audio/ring`) through an AudioWorklet and a gain node.
 * It lives on the main thread; the engine worker writes the ring and the worklet thread reads it. It also publishes the
 * output latency into the ring's control block every 500 ms so the engine can read it.
 */
export class AudioOutput implements AudioOutputLike {
  private started: { context: AudioContext; ready: Promise<SharedArrayBuffer> } | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private muted = false;
  private effectClips: ReadonlyArray<{ readonly channels: 1 | 2; readonly samples: Int16Array }> = [];
  /** AudioBuffers of effectClips, built on first use (the context exists only after a user gesture). */
  private effectBuffers = new Map<number, AudioBuffer>();

  private sessionSet = false;

  constructor(
    private readonly createContext: (opts: AudioContextOptions) => AudioContext = (opts) => new AudioContext(opts),
    private readonly nav: { audioSession?: { type: string } } | undefined = (globalThis as unknown as { navigator?: { audioSession?: { type: string } } }).navigator,
  ) {}

  private stateListener: ((state: AudioContextState | 'interrupted') => void) | null = null;

  /** Sets the one listener of the audio context's state changes, replacing any earlier one. */
  onStateChange(cb: (state: AudioContextState | 'interrupted') => void): void {
    this.stateListener = cb;
  }

  /**
   * Creates the 48 kHz context on first call (it needs a user gesture) and resumes it. Resolves with the shared PCM ring
   * once the worklet module is loaded; a failure is not cached, so the next gesture tries again.
   */
  ensureStarted(): Promise<SharedArrayBuffer> {
    let attempt = this.started;
    if (!attempt) {
      this.setAudioSession();
      const context = this.createContext({ sampleRate: OUTPUT_SAMPLE_RATE, latencyHint: 'playback' });
      context.onstatechange = () => this.stateListener?.(context.state);
      const created = { context, ready: this.setUp(context) };
      attempt = created;
      this.started = created;
      // A failed start must not stay cached: close the context and let the next user gesture retry.
      created.ready.catch(() => {
        context.close().catch(() => undefined); // already closed: nothing to release
        if (this.started === created) this.started = null;
      });
    }
    void attempt.context.resume();
    return attempt.ready;
  }

  /** iOS Safari: without the 'playback' session type the ringer switch mutes the output. */
  private setAudioSession(): void {
    if (this.sessionSet) return;
    this.sessionSet = true;
    try {
      if (this.nav?.audioSession) this.nav.audioSession.type = 'playback';
    } catch {
      // WebKit may throw on unsupported types; playback still works with the default session
    }
  }

  /** Sets the gain, 0 to 1; a muted output stays silent until unmuted. */
  setVolume(volume: number): void {
    this.volume = volume;
    this.applyGain();
  }

  /** Silences the output without losing the volume setting. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  /** Keeps the menu sound clips (16-bit interleaved, 48 kHz); AudioBuffers are built when a clip first plays. */
  loadEffects(clips: ReadonlyArray<{ readonly channels: 1 | 2; readonly samples: Int16Array }>): void {
    this.effectClips = clips;
    this.effectBuffers = new Map();
  }

  /** Plays clip `id` once through the gain node; nothing happens before the context exists or for an unknown id. */
  playEffect(id: number): void {
    const context = this.started?.context;
    const gain = this.gain;
    const clip = this.effectClips[id];
    if (!context || !gain || !clip || clip.samples.length < clip.channels) return;
    let buffer = this.effectBuffers.get(id);
    if (!buffer) {
      const frames = Math.floor(clip.samples.length / clip.channels);
      buffer = context.createBuffer(clip.channels, frames, OUTPUT_SAMPLE_RATE);
      for (let ch = 0; ch < clip.channels; ch++) {
        const out = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) out[i] = clip.samples[i * clip.channels + ch]! / 32768;
      }
      this.effectBuffers.set(id, buffer);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain); // through the volume and mute
    source.start();
  }

  private async setUp(context: AudioContext): Promise<SharedArrayBuffer> {
    await context.audioWorklet.addModule(workletUrl);
    const ring = createRing(OUTPUT_SAMPLE_RATE, RING_SECONDS);
    const node = new AudioWorkletNode(context, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ring },
    });
    const gain = context.createGain();
    node.connect(gain).connect(context.destination);
    this.gain = gain;
    this.applyGain();
    const views = ringViews(ring);
    const publishLatency = (): void => {
      const seconds = (context.outputLatency || 0) + context.baseLatency;
      Atomics.store(views.control, Control.LatencyUs, Math.round(seconds * 1e6));
    };
    publishLatency();
    setInterval(publishLatency, 500);
    return ring;
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }
}
