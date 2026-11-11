/** What a decoder is configured from. */
export interface StreamConfig {
  /** The Blu-ray coding type (`CodingType`), or the engine's own number for an encode's codec (CODING_AV1). */
  readonly codingType: number;
  /** First access unit of the stream; video uses its SPS to build the codec string. */
  readonly firstUnit?: Uint8Array;
  /** The first unit's key-frame flag from the container (Matroska), for codecs whose units carry none the decoder reads. */
  readonly key?: boolean;
  /** The track's CodecPrivate (Matroska): AV1's av1C record, which the codec string comes from. */
  readonly codecPrivate?: Uint8Array;
}

/** Common shape of a decoder that delivers its output through callbacks (the WebCodecs video decoder). */
export interface Decoder<In, Out> {
  /** Chooses and opens a decoder for the stream; rejects with UnsupportedCodecError when none can decode it. */
  configure(config: StreamConfig): Promise<void>;
  /** Queues one unit; output arrives later through onOutput. */
  decode(unit: In): void;
  /** Resolves when everything queued has been output. */
  flush(): Promise<void>;
  /** Drops queued work; the next decoded unit must be a key unit. Configuration is kept. */
  reset(): void;
  close(): void;
  /** Receives each decoded output; the receiver owns it (a VideoFrame must be closed). */
  onOutput: (out: Out) => void;
  /** Receives a decode failure; `fatal` says whether decoding has stopped for good. */
  onError: (err: DecoderError) => void;
  /** Units queued in the decoder and not yet decoded. */
  readonly queueSize: number;
}

/** The stream's codec cannot be decoded here (no decoder, or the browser rejects its configuration); the message is for the viewer. */
export class UnsupportedCodecError extends Error {
  constructor(
    readonly codingType: number,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedCodecError';
  }
}

/** A decode failure reported through Decoder.onError: `fatal` is false while the decoder recovers at the next key unit, true once it gave up. */
export class DecoderError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'DecoderError';
  }
}
