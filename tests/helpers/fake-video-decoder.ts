import type { VideoCodecApi, VideoDecoderLike } from '@seikou/engine/decode/video-decoder';

/** A VideoDecoder that outputs a 320×180 frame for every chunk at once, without decoding anything. */
export class FakeVideoDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  constructor(private readonly init: VideoDecoderInit) {}
  configure(): void {
    this.state = 'configured';
  }
  decode(chunk: EncodedVideoChunk): void {
    const { timestamp } = chunk as unknown as EncodedVideoChunkInit;
    this.init.output({ timestamp, displayWidth: 320, displayHeight: 180, close: () => undefined } as unknown as VideoFrame);
  }
  async flush(): Promise<void> {}
  reset(): void {
    this.state = 'unconfigured';
  }
  close(): void {
    this.state = 'closed';
  }
}

export const fakeVideoCodecApi: VideoCodecApi = {
  create: (init) => new FakeVideoDecoder(init),
  isConfigSupported: async (config) => ({ supported: true, config }),
  makeChunk: (init) => init as unknown as EncodedVideoChunk,
};
