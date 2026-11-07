export interface StreamConfig {
  readonly codingType: number;
  /** First access unit of the stream; video uses its SPS to build the codec string. */
  readonly firstUnit?: Uint8Array;
}

/** Common shape of every decoder (WebCodecs now; WASM fallbacks in later milestones). */
export interface Decoder<In, Out> {
  configure(config: StreamConfig): Promise<void>;
  decode(unit: In): void;
  flush(): Promise<void>;
  /** Drops queued work; the next decoded unit must be a key unit. Configuration is kept. */
  reset(): void;
  close(): void;
  onOutput: (out: Out) => void;
  onError: (err: DecoderError) => void;
  readonly queueSize: number;
}

export class UnsupportedCodecError extends Error {
  constructor(
    readonly codingType: number,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedCodecError';
  }
}

export class DecoderError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'DecoderError';
  }
}
