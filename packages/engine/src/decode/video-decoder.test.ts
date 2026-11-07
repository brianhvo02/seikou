import { describe, expect, it } from 'vitest';
import { INTERLACED_SPS, PROGRESSIVE_SPS, TEST_PPS, avcAu } from '../../../../tests/helpers/h264-units';
import { CodingType } from '@seikou/bdmv/stream-types';
import { DecoderError, UnsupportedCodecError } from './decoder';
import { WebCodecsVideoDecoder, type VideoCodecApi, type VideoDecoderLike } from './video-decoder';

interface FakeFrame {
  timestamp: number;
  closed: boolean;
  close(): void;
}

class FakeDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  config: VideoDecoderConfig | null = null;
  readonly chunks: EncodedVideoChunkInit[] = [];
  readonly frames: FakeFrame[] = [];
  /** When set, frames wait in `queued` until deliver(), like output tasks a real decoder runs later. */
  asyncOutput = false;
  readonly queued: FakeFrame[] = [];

  constructor(private readonly init: VideoDecoderInit) {}

  configure(config: VideoDecoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }

  decode(chunk: EncodedVideoChunk): void {
    const init = chunk as unknown as EncodedVideoChunkInit;
    this.chunks.push(init);
    const frame: FakeFrame = { timestamp: init.timestamp, closed: false, close() { this.closed = true; } };
    this.frames.push(frame);
    if (this.asyncOutput) this.queued.push(frame);
    else this.init.output(frame as unknown as VideoFrame);
  }

  /** Runs the queued output callbacks. reset() deliberately leaves them queued: late delivery is allowed. */
  deliver(): void {
    for (const frame of this.queued.splice(0)) this.init.output(frame as unknown as VideoFrame);
  }

  async flush(): Promise<void> {}

  reset(): void {
    this.state = 'unconfigured';
  }

  close(): void {
    this.state = 'closed';
  }

  fail(message: string): void {
    this.state = 'closed';
    this.init.error(new DOMException(message, 'EncodingError'));
  }
}

function setup(supported: boolean | ((codec: string, config: VideoDecoderConfig) => boolean) = true): { api: VideoCodecApi; created: FakeDecoder[]; checked: VideoDecoderConfig[] } {
  const created: FakeDecoder[] = [];
  const checked: VideoDecoderConfig[] = [];
  const api: VideoCodecApi = {
    create: (init) => {
      const d = new FakeDecoder(init);
      created.push(d);
      return d;
    },
    isConfigSupported: async (config) => {
      checked.push(config);
      return { supported: typeof supported === 'function' ? supported(config.codec, config) : supported, config };
    },
    makeChunk: (init) => init as unknown as EncodedVideoChunk,
  };
  return { api, created, checked };
}

async function configured(): Promise<{ dec: WebCodecsVideoDecoder; created: FakeDecoder[]; out: VideoFrame[]; errors: DecoderError[] }> {
  const { api, created } = setup();
  const dec = new WebCodecsVideoDecoder(api);
  const out: VideoFrame[] = [];
  const errors: DecoderError[] = [];
  dec.onOutput = (f) => out.push(f);
  dec.onError = (e) => errors.push(e);
  await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
  return { dec, created, out, errors };
}

const HEVC_SPS = [0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x5d];
const HEVC_IDR = new Uint8Array([0, 0, 0, 1, ...HEVC_SPS, 0, 0, 0, 1, 0x26, 0x01, 0xaf]);
const HEVC_MESSAGE = "This device can't decode HEVC (4K) video.";

describe('WebCodecsVideoDecoder', () => {
  it('opens HEVC with the hev1 string when only that one is supported', async () => {
    const { api, created, checked } = setup((codec) => codec.startsWith('hev1.'));
    const dec = new WebCodecsVideoDecoder(api);
    await dec.configure({ codingType: CodingType.HEVC, firstUnit: HEVC_IDR });
    expect(checked.map((c) => c.codec)).toEqual(['hvc1.1.6.L93.90', 'hev1.1.6.L93.90']);
    expect(created[0].config?.codec).toBe('hev1.1.6.L93.90');
  });

  it('prefers hvc1 when both HEVC strings are supported', async () => {
    const { api, created } = setup();
    await new WebCodecsVideoDecoder(api).configure({ codingType: CodingType.HEVC, firstUnit: HEVC_IDR });
    expect(created[0].config?.codec).toBe('hvc1.1.6.L93.90');
  });

  it('reports the HEVC message when no HEVC string is supported', async () => {
    const { api } = setup(false);
    const err = await new WebCodecsVideoDecoder(api).configure({ codingType: CodingType.HEVC, firstUnit: HEVC_IDR }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedCodecError);
    expect((err as Error).message).toBe(HEVC_MESSAGE);
  });

  it('carries the HEVC message on the fatal error after repeated HEVC decode failures', async () => {
    const { api, created } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    const errors: DecoderError[] = [];
    dec.onError = (e) => errors.push(e);
    await dec.configure({ codingType: CodingType.HEVC, firstUnit: HEVC_IDR });
    for (let i = 0; i < 4; i++) created[created.length - 1].fail(`boom ${i}`);
    expect(errors.map((e) => e.fatal)).toEqual([false, false, false, true]);
    expect(errors[3].message).toBe(HEVC_MESSAGE);
  });

  it('reports a generic fatal error, not the HEVC message, once HEVC frames have been decoded', async () => {
    const { api, created } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    const errors: DecoderError[] = [];
    const out: VideoFrame[] = [];
    dec.onError = (e) => errors.push(e);
    dec.onOutput = (f) => out.push(f);
    await dec.configure({ codingType: CodingType.HEVC, firstUnit: HEVC_IDR });
    dec.decode({ data: HEVC_IDR, ptsUs: 0, discard: false });
    expect(out).toHaveLength(1);
    for (let i = 0; i < 4; i++) created[created.length - 1].fail(`boom ${i}`);
    expect(errors.map((e) => e.fatal)).toEqual([false, false, false, true]);
    expect(errors[3].message).toBe('Video decoding failed: boom 3');
  });

  it('treats a rejected support check as unsupported and tries the next codec string', async () => {
    const { api, created } = setup();
    const checked: string[] = [];
    const rejecting: VideoCodecApi = {
      ...api,
      isConfigSupported: async (c) => {
        checked.push(c.codec);
        if (c.codec.startsWith('hvc1.')) throw new TypeError('unsupported codec string');
        return { supported: true, config: c };
      },
    };
    await new WebCodecsVideoDecoder(rejecting).configure({ codingType: CodingType.HEVC, firstUnit: HEVC_IDR });
    expect(checked).toEqual(['hvc1.1.6.L93.90', 'hev1.1.6.L93.90']);
    expect(created[0].config?.codec).toBe('hev1.1.6.L93.90');
  });

  it('configures AVC with a codec string from the SPS', async () => {
    const { api, created, checked } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
    expect(checked).toEqual([{ codec: 'avc1.640028' }]);
    expect(created[0].config?.codec).toBe('avc1.640028');
    expect(dec.codec).toBe('avc1.640028');
  });

  it('asks for software decoding for interlaced AVC, which Chrome hardware decoders reject', async () => {
    const { api, created, checked } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true, spsNal: INTERLACED_SPS }) });
    expect(checked).toEqual([{ codec: 'avc1.640029', hardwareAcceleration: 'prefer-software' }]);
    expect(created[0].config?.hardwareAcceleration).toBe('prefer-software');
  });

  it('leaves the acceleration preference alone for progressive AVC', async () => {
    const { api, checked } = setup();
    await new WebCodecsVideoDecoder(api).configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true, spsNal: PROGRESSIVE_SPS }) });
    expect(checked).toEqual([{ codec: 'avc1.640029' }]);
  });

  describe('a PPS id redefined with other content (Chrome hardware decoders fail on it now and then)', () => {
    const OTHER_PPS_0 = new Uint8Array([0x68, 0xee, 0x35, 0x25]);
    const PPS_1 = new Uint8Array([0x68, 0x5e, 0x3c, 0xb0]);

    const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    async function hardware(supported: Parameters<typeof setup>[0] = true): Promise<{ dec: WebCodecsVideoDecoder; created: FakeDecoder[]; checked: VideoDecoderConfig[] }> {
      const { api, created, checked } = setup(supported);
      const dec = new WebCodecsVideoDecoder(api);
      await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true, spsNal: PROGRESSIVE_SPS }) });
      dec.decode({ data: avcAu({ idr: true, spsNal: PROGRESSIVE_SPS }), ptsUs: 0, discard: false });
      return { dec, created, checked };
    }

    it('reopens the decoder in software and resumes at the next key unit', async () => {
      const { dec, created, checked } = await hardware();
      dec.decode({ data: avcAu({ ppsNal: OTHER_PPS_0 }), ptsUs: 41_708, discard: false });
      await settled();
      expect(checked.at(-1)).toEqual({ codec: 'avc1.640029', hardwareAcceleration: 'prefer-software' });
      expect(created).toHaveLength(2);
      expect(created[1].config?.hardwareAcceleration).toBe('prefer-software');
      dec.decode({ data: avcAu(), ptsUs: 83_416, discard: false });
      expect(created[1].chunks).toHaveLength(0);
      dec.decode({ data: avcAu({ idr: true, spsNal: PROGRESSIVE_SPS }), ptsUs: 125_125, discard: false });
      expect(created[1].chunks.map((c) => c.type)).toEqual(['key']);
    });

    it('keeps the hardware decoder for a repeated PPS or a new id', async () => {
      const { dec, created, checked } = await hardware();
      dec.decode({ data: avcAu({ ppsNal: new Uint8Array(TEST_PPS) }), ptsUs: 41_708, discard: false });
      dec.decode({ data: avcAu({ ppsNal: PPS_1 }), ptsUs: 83_416, discard: false });
      await settled();
      expect(checked).toHaveLength(1);
      expect(created).toHaveLength(1);
      expect(created[0].chunks).toHaveLength(3);
    });

    it('keeps the hardware decoder when the browser has no software decoder', async () => {
      const { dec, created } = await hardware((_codec, config) => config.hardwareAcceleration !== 'prefer-software');
      dec.decode({ data: avcAu({ ppsNal: OTHER_PPS_0 }), ptsUs: 41_708, discard: false });
      await settled();
      expect(created).toHaveLength(1);
      expect(created[0].chunks).toHaveLength(2);
    });
  });

  it('rejects unsupported codecs', async () => {
    const { api } = setup();
    await expect(new WebCodecsVideoDecoder(api).configure({ codingType: CodingType.VC1, firstUnit: avcAu({ idr: true }) })).rejects.toBeInstanceOf(UnsupportedCodecError);
    const unsupported = setup(false);
    await expect(new WebCodecsVideoDecoder(unsupported.api).configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) })).rejects.toBeInstanceOf(UnsupportedCodecError);
  });

  it('skips delta units until a key unit, then marks only the first as key', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu(), ptsUs: 0, discard: false });
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 41_708, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 83_416, discard: false });
    expect(created[0].chunks.map((c) => [c.type, c.timestamp])).toEqual([
      ['key', 41_708],
      ['delta', 83_416],
    ]);
    expect(out.map((f) => f.timestamp)).toEqual([41_708, 83_416]);
  });

  it('skips leading pictures after an open-GOP (recovery-point) start', async () => {
    const { dec, created } = await configured();
    // Decode order: I (pts 2000), two leading B (pts 1000, 1500), P (pts 4000), then a B with pts above the I-frame.
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 2000, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 1000, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 1500, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 4000, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 3000, discard: false });
    expect(created[0].chunks.map((c) => [c.type, c.timestamp])).toEqual([
      ['key', 2000],
      ['delta', 4000],
      ['delta', 3000],
    ]);
    expect(dec.openGop).toEqual({ starts: 1, leadingSkipped: 2 });
  });

  it('does not skip anything after an IDR start', async () => {
    const { dec, created } = await configured();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 2000, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 1000, discard: false });
    expect(created[0].chunks.map((c) => c.timestamp)).toEqual([2000, 1000]);
    expect(dec.openGop).toEqual({ starts: 0, leadingSkipped: 0 });
  });

  it('closes frames of discarded units instead of outputting them', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: true });
    dec.decode({ data: avcAu(), ptsUs: 41_708, discard: false });
    expect(out.map((f) => f.timestamp)).toEqual([41_708]);
    expect(created[0].frames[0].closed).toBe(true);
  });

  it('after an error following a recovery-point start, waits for an IDR', async () => {
    const { dec, created, errors } = await configured();
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 0, discard: false });
    created[0].fail('bad keyframe');
    expect(errors.map((e) => e.fatal)).toEqual([false]);
    expect(created).toHaveLength(2);
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 41_708, discard: false });
    expect(created[1].chunks).toHaveLength(0);
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 83_416, discard: false });
    expect(created[1].chunks.map((c) => c.type)).toEqual(['key']);
  });

  it('gives up with a fatal error after repeated failures without output', async () => {
    const { dec, created, errors } = await configured();
    for (let i = 0; i < 4; i++) created[created.length - 1].fail(`boom ${i}`);
    expect(errors.map((e) => e.fatal)).toEqual([false, false, false, true]);
    const chunkCount = (): number => created.reduce((n, d) => n + d.chunks.length, 0);
    const before = chunkCount();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false }); // no-op once fatal
    expect(chunkCount()).toBe(before);
  });

  it('reset requires a key unit again and forgets discards', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: true });
    dec.reset();
    expect(created[0].state).toBe('configured');
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false });
    expect(out.map((f) => f.timestamp)).toEqual([0]);
    expect(created[0].frames[0].closed).toBe(true);
    expect(created[0].frames[1].closed).toBe(false);
    dec.reset();
    dec.decode({ data: avcAu(), ptsUs: 41_708, discard: false });
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 83_416, discard: false });
    expect(out.map((f) => f.timestamp)).toEqual([0, 83_416]);
  });

  it('clears the post-error IDR requirement on reset', async () => {
    const { dec, created } = await configured();
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 0, discard: false });
    created[0].fail('bad keyframe');
    dec.reset();
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 41_708, discard: false });
    expect(created[created.length - 1].chunks.map((c) => c.type)).toEqual(['key']);
  });

  it('requires a key unit immediately after flush starts', async () => {
    const { dec, created } = await configured();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false });
    void dec.flush();
    dec.decode({ data: avcAu(), ptsUs: 41_708, discard: false });
    expect(created[0].chunks.map((c) => c.type)).toEqual(['key']);
  });

  it('resets recovery state on configure', async () => {
    const { dec, created, errors } = await configured();
    for (let i = 0; i < 4; i++) created[created.length - 1].fail(`boom ${i}`);
    expect(errors[errors.length - 1]?.fatal).toBe(true);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
    created[created.length - 1].fail('after reconfigure');
    expect(errors[errors.length - 1]?.fatal).toBe(false);
  });

  it('routes a synchronous decode throw into recovery', async () => {
    const { dec, created, errors } = await configured();
    const fake = created[0];
    const realDecode = fake.decode.bind(fake);
    fake.decode = () => {
      fake.decode = realDecode;
      throw new DOMException('bad', 'DataError');
    };
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false });
    expect(errors.map((e) => e.fatal)).toEqual([false]);
    expect(created).toHaveLength(2);
  });

  it('routes a throwing decoder configure into recovery', async () => {
    const { api, created } = setup();
    let throwNext = true;
    const flaky: VideoCodecApi = {
      ...api,
      create: (init) => {
        const d = api.create(init) as FakeDecoder;
        if (throwNext) {
          throwNext = false;
          d.configure = () => {
            throw new DOMException('no', 'NotSupportedError');
          };
        }
        return d;
      },
    };
    const dec = new WebCodecsVideoDecoder(flaky);
    const errors: DecoderError[] = [];
    dec.onError = (e) => errors.push(e);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
    expect(errors.map((e) => e.fatal)).toEqual([false]);
    expect(created).toHaveLength(2);
  });

  it('does not open a decoder if closed while configure() was still checking support', async () => {
    const { api, created } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow: VideoCodecApi = { ...api, isConfigSupported: async (c) => { await gate; return api.isConfigSupported(c); } };
    const dec = new WebCodecsVideoDecoder(slow);
    const pending = dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
    dec.close();
    release();
    await pending;
    expect(created).toHaveLength(0);
  });

  it('routes a synchronous throw from reset() into recovery', async () => {
    const { dec, created, errors } = await configured();
    created[0].reset = () => {
      throw new DOMException('reset failed', 'InvalidStateError');
    };
    dec.reset();
    expect(errors.map((e) => e.fatal)).toEqual([false]);
    expect(created).toHaveLength(2);
  });

  it('closes a late-delivered discarded frame and outputs late-delivered kept ones', async () => {
    const { dec, created, out } = await configured();
    created[0].asyncOutput = true;
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: true });
    dec.decode({ data: avcAu(), ptsUs: 41_708, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 83_416, discard: false });
    expect(out).toHaveLength(0);
    created[0].deliver();
    expect(out.map((f) => f.timestamp)).toEqual([41_708, 83_416]);
    expect(created[0].frames[0].closed).toBe(true);
  });

  it('closes frames from before reset() that arrive after it', async () => {
    const { dec, created, out } = await configured();
    created[0].asyncOutput = true;
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 5_000_000, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 5_041_708, discard: false });
    dec.reset(); // a backward seek
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 1_000_000, discard: false });
    created[0].deliver();
    expect(out.map((f) => f.timestamp)).toEqual([1_000_000]);
    expect(created[0].frames.slice(0, 2).every((f) => f.closed)).toBe(true);
  });

  it('closes late frames from a decoder replaced after an error', async () => {
    const { dec, created, out } = await configured();
    created[0].asyncOutput = true;
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false });
    created[0].fail('boom');
    created[0].deliver();
    expect(out).toHaveLength(0);
    expect(created[0].frames[0].closed).toBe(true);
  });

  it('forgets timestamps the decoder never outputs once they fall far behind', async () => {
    const { dec, created, out } = await configured();
    const fake = created[0];
    fake.asyncOutput = true;
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false });
    for (let i = 1; i < 300; i++) dec.decode({ data: avcAu(), ptsUs: i * 41_708, discard: false });
    fake.queued.splice(0, 100); // a decoder that silently dropped its first 100 pictures
    fake.deliver();
    expect(out).toHaveLength(200);
    // ts 0 was pruned, so a stray output for it is refused instead of being taken as a live frame.
    const stray = { timestamp: 0, closed: false, close() { this.closed = true; } };
    fake.queued.push(stray);
    fake.deliver();
    expect(out).toHaveLength(200);
    expect(stray.closed).toBe(true);
  });

  it('closes frames when no output handler is set', async () => {
    const { api, created } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false });
    expect(created[0].frames[0].closed).toBe(true);
  });
});
