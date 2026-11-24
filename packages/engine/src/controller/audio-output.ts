import { outputChannelsFor, type AudioChannelsChoice, type OutputChannels } from '../audio/channel-map';
import { Control, LATENCY_UNKNOWN, OUTPUT_SAMPLE_RATE, createRing, ringViews } from '../audio/ring';
import type { AudioOutputLike } from './player-controller';
import workletUrl from './pcm-worklet.ts?worker&url';

const RING_SECONDS = 2;
/** How often the output latency is published to the engine. */
const LATENCY_PUBLISH_MS = 50;
/** How often it is published while the output has not said it yet. */
const LATENCY_UNKNOWN_POLL_MS = 5;
/** How long (seconds of rendered output) an output may say 0 before 0 is taken as its latency. */
const LATENCY_WAIT_S = 0.2;

/**
 * A 48 kHz `AudioContext` that plays the shared PCM ring (`../audio/ring`) through an AudioWorklet and a gain node, in
 * stereo or, where the device offers six or eight channels and the choice allows, 5.1 or 7.1 as discrete channels.
 * It lives on the main thread; the engine worker writes the ring and the worklet thread reads it. It also publishes the
 * output latency into the ring's control block every 50 ms so the engine can read it, and that it is not known yet while
 * the output has not said it: the context is made on the gesture that starts playback, and an audio clock started on
 * the 0 Chrome reads until then runs about 56 ms early, then steps back during playback.
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
  private channelsChoice: AudioChannelsChoice = 'auto';
  private channelCount: OutputChannels | null = null;

  constructor(
    private readonly createContext: (opts: AudioContextOptions) => AudioContext = (opts) => new AudioContext(opts),
    private readonly nav: { audioSession?: { type: string } } | undefined = (globalThis as unknown as { navigator?: { audioSession?: { type: string } } }).navigator,
  ) {}

  private stateListener: ((state: AudioContextState | 'interrupted') => void) | null = null;

  /**
   * How many channels the output may use. It takes effect when the context is made (the first ensureStarted); the
   * ring's channel count is fixed for the context's life, so a change after that applies after a reload.
   */
  setChannels(choice: AudioChannelsChoice): void {
    this.channelsChoice = choice;
  }

  /** The channels the output plays (2, 6 or 8), or null before the context is set up. */
  get outputChannels(): OutputChannels | null {
    return this.channelCount;
  }

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
      // Always two channels, so a mono clip reaches both front speakers on a discrete 5.1 or 7.1 output too.
      buffer = context.createBuffer(2, frames, OUTPUT_SAMPLE_RATE);
      for (let ch = 0; ch < 2; ch++) {
        const out = buffer.getChannelData(ch);
        const from = Math.min(ch, clip.channels - 1);
        for (let i = 0; i < frames; i++) out[i] = clip.samples[i * clip.channels + from]! / 32768;
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
    const channels = this.chooseChannels(context);
    const ring = createRing(OUTPUT_SAMPLE_RATE, RING_SECONDS, channels);
    const node = new AudioWorkletNode(context, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: { ring },
    });
    const gain = context.createGain();
    if (channels > 2) {
      // Discrete all the way: the browser neither folds nor spreads the channels the engine already placed.
      for (const n of [gain, context.destination] as AudioNode[]) {
        n.channelCount = channels;
        n.channelCountMode = 'explicit';
        n.channelInterpretation = 'discrete';
      }
    }
    this.channelCount = channels;
    node.connect(gain).connect(context.destination);
    this.gain = gain;
    this.applyGain();
    const views = ringViews(ring);
    const publishLatency = (): boolean => {
      const output = context.outputLatency;
      // Chrome reads 0 until the output has rendered a few callbacks (about 40 ms), then its real latency (about 56 ms
      // on macOS): until then the latency is unknown, and the audio clock holds rather than run that much early. An
      // output that still says 0 after LATENCY_WAIT_S of rendering, or has no outputLatency (older Safari), has none.
      const unknown = output === 0 && context.currentTime < LATENCY_WAIT_S;
      const us = unknown ? LATENCY_UNKNOWN : Math.round(((output || 0) + context.baseLatency) * 1e6);
      Atomics.store(views.control, Control.LatencyUs, us);
      return !unknown;
    };
    // both publishers stop when the context closes: a closed output has no latency to publish, and its ring is let go
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const stop = (): void => {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    };
    const closed = (): boolean => {
      if (context.state !== 'closed') return false;
      stop();
      return true;
    };
    if (!publishLatency()) {
      const soon = setInterval(() => {
        if (closed() || publishLatency()) clearInterval(soon);
      }, LATENCY_UNKNOWN_POLL_MS);
      timers.push(soon);
    }
    timers.push(
      setInterval(() => {
        if (!closed()) publishLatency();
      }, LATENCY_PUBLISH_MS),
    );
    context.addEventListener('statechange', () => void closed());
    return ring;
  }

  /** The ring's channel count from the device's maximum and the choice (a failed setting of the destination keeps stereo). */
  private chooseChannels(context: AudioContext): OutputChannels {
    if (this.channelsChoice === 'stereo') return 2;
    const max = context.destination?.maxChannelCount ?? 2;
    const wanted = this.channelsChoice === 'auto' ? max : Math.min(this.channelsChoice, max);
    const channels = outputChannelsFor(wanted);
    if (channels === 2) return 2;
    try {
      context.destination.channelCount = channels;
      return channels;
    } catch {
      return 2; // the destination refused the count after all
    }
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }
}
