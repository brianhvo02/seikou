import { renderChannels, ringViews, type RingViews } from '../audio/ring';

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
 * played; `../audio/ring` holds the ring layout. Its output has the ring's channel count (the page sets
 * `outputChannelCount` from it); fewer output channels than the ring's lose the rest. It never allocates in `process`.
 */
class PcmPlayer extends AudioWorkletProcessor {
  private readonly views: RingViews;

  constructor(options: PcmPlayerOptions) {
    super();
    this.views = ringViews(options.processorOptions.ring);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true; // no output connected yet
    renderChannels(this.views, channels);
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
