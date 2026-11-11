import { renderQuantum, ringViews, type RingViews } from '../audio/ring';

interface PcmPlayerOptions {
  processorOptions: { ring: SharedArrayBuffer };
}

// AudioWorkletGlobalScope globals (not in lib.dom).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processorCtor: new (options: PcmPlayerOptions) => AudioWorkletProcessor): void;

/**
 * The `pcm-player` processor, which runs on the audio rendering thread (AudioWorkletGlobalScope), not on the main thread
 * or the engine worker. Each 128-frame quantum it takes PCM from the shared ring and publishes how many frames have
 * played; `../audio/ring` holds the ring layout. It never allocates in `process` except to size the mono scratch buffer.
 */
class PcmPlayer extends AudioWorkletProcessor {
  private readonly views: RingViews;
  private scratch = new Float32Array(128);

  constructor(options: PcmPlayerOptions) {
    super();
    this.views = ringViews(options.processorOptions.ring);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0];
    if (!left) return true; // no output connected yet
    if (!right && this.scratch.length !== left.length) this.scratch = new Float32Array(left.length);
    renderQuantum(this.views, left, right ?? this.scratch); // mono destination: right is discarded
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
