// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CodingType } from '@seikou/bdmv/stream-types';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import type { WorkerLike } from '../bdj-types';
import type { FieldInput } from '../deinterlace/field-input';
import { DecoderError, UnsupportedCodecError } from './decoder';
import type { VideoUnit } from './video-decoder';
import type { FromVideoWorker, ToVideoWorker } from './video-worker-protocol';
import { ASSET_FETCH_TIMEOUT_MS } from '../asset-fetch';
import { VideoWorkerCore, videoDecoderOpener, type VideoWorkerCoreDeps } from './video-worker-core';
import { VIDEO_WORKER_OPEN_MARGIN_MS, WasmVideoDecoder, frameFromPicture } from './wasm-video-decoder';
import { WasmPictureDecoder, WasmVideoCodec, loadVideoWasm, type DecodedPicture, type VideoWasm } from './wasm-video';

/** A worker that records what it was sent; tests answer through `reply`, synchronously unless `respond` defers. */
class FakeWorker implements WorkerLike<ToVideoWorker, FromVideoWorker> {
  readonly sent: ToVideoWorker[] = [];
  readonly transfers: (Transferable[] | undefined)[] = [];
  onmessage: ((event: MessageEvent<FromVideoWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  /** Answers each message as it is posted. */
  respond: ((message: ToVideoWorker, worker: FakeWorker) => void) | null = (m, w) => {
    if (m.type === 'open') w.reply({ type: 'opened' });
  };

  postMessage(message: ToVideoWorker, transfer?: Transferable[]): void {
    this.sent.push(message);
    this.transfers.push(transfer);
    this.respond?.(message, this);
  }

  reply(message: FromVideoWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromVideoWorker>);
  }

  terminate(): void {
    this.terminated = true;
  }

  of<T extends ToVideoWorker['type']>(type: T): Extract<ToVideoWorker, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ToVideoWorker, { type: T }> => m.type === type);
  }
}

function picture(ptsUs: number, over: Partial<DecodedPicture> = {}): DecodedPicture {
  const width = 4;
  const height = 2;
  return {
    width,
    height,
    displayWidth: width,
    displayHeight: height,
    data: new Uint8Array(width * height + 2 * 2 * 1).fill(ptsUs & 0xff),
    ptsUs,
    durationUs: 40_000,
    keyFrame: false,
    matrix: null,
    flags: { fieldOrder: 'tff', progressive: false, repeatFirstField: false },
    ...over,
  };
}

interface FakeFrame {
  readonly picture: DecodedPicture;
  readonly timestamp: number;
}

function setup(): { worker: FakeWorker; decoder: WasmVideoDecoder; frames: FakeFrame[]; created: () => number } {
  const worker = new FakeWorker();
  let count = 0;
  const decoder = new WasmVideoDecoder({
    createWorker: () => {
      count++;
      return worker;
    },
    wasmUrl: 'https://example.test/video.wasm',
    fetchTimeoutMs: 20_000,
    makeFrame: (p) => ({ picture: p, timestamp: p.ptsUs, close: () => undefined }) as unknown as VideoFrame,
  });
  const frames: FakeFrame[] = [];
  decoder.onOutput = (f) => frames.push(f as unknown as FakeFrame);
  return { worker, decoder, frames, created: () => count };
}

const unit = (ptsUs: number, discard = false): VideoUnit => ({ data: new Uint8Array([0, 0, 1, 0, ptsUs & 0xff]), ptsUs, discard });

/** A worker whose messages run VideoWorkerCore in this thread, posting back asynchronously as a real worker does. */
function inProcessWorker(openDecoder: VideoWorkerCoreDeps['openDecoder']): WorkerLike<ToVideoWorker, FromVideoWorker> {
  const worker: WorkerLike<ToVideoWorker, FromVideoWorker> = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => core.enqueue(message),
    terminate: () => undefined,
  };
  const core = new VideoWorkerCore({
    post: (message) => {
      void Promise.resolve().then(() => worker.onmessage?.({ data: message } as MessageEvent<FromVideoWorker>));
    },
    openDecoder,
    now: () => performance.now(),
  });
  return worker;
}

/** A timer the test fires by hand. */
class ManualTimers {
  readonly timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  readonly setTimer = (ms: number, fn: () => void): (() => void) => {
    const timer = { ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  live(): { ms: number; fn: () => void; cancelled: boolean }[] {
    return this.timers.filter((t) => !t.cancelled);
  }
  /** Fires the one live timer, which is then spent. */
  fire(): void {
    const [timer] = this.live();
    timer!.cancelled = true;
    timer!.fn();
  }
}

describe('WasmVideoDecoder', () => {
  it('configure opens the worker for the stream\'s codec and rejects with UnsupportedCodecError when it reports a fatal error', async () => {
    const { worker, decoder, created } = setup();
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    expect(created()).toBe(1);
    expect(worker.of('open')).toEqual([{ type: 'open', wasmUrl: 'https://example.test/video.wasm', codec: WasmVideoCodec.MPEG2, timeoutMs: 20_000 }]);

    const failing = setup();
    failing.worker.respond = (m, w) => {
      if (m.type === 'open') w.reply({ type: 'error', message: 'video.wasm did not load', fatal: true });
    };
    await expect(failing.decoder.configure({ codingType: CodingType.VC1 })).rejects.toBeInstanceOf(UnsupportedCodecError);
    expect(failing.worker.of('open')[0]!.codec).toBe(WasmVideoCodec.VC1);
    expect(failing.worker.terminated).toBe(true);

    const h264 = setup();
    await expect(h264.decoder.configure({ codingType: CodingType.AVC })).rejects.toBeInstanceOf(UnsupportedCodecError);
    expect(h264.created()).toBe(0);
  });

  it('an interlaced stream\'s pictures go to onFieldInput as I420 planes with their flags and no VideoFrame', async () => {
    const { worker, decoder, frames } = setup();
    const inputs: FieldInput[] = [];
    decoder.onFieldInput = (i) => inputs.push(i);
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO, interlaced: true });
    decoder.decode(unit(1000));
    const flags = { fieldOrder: 'bff', progressive: false, repeatFirstField: true } as const;
    const p = picture(1000, { width: 5, height: 3, displayWidth: 6, displayHeight: 3, data: new Uint8Array(5 * 3 + 2 * 3 * 2), matrix: null, flags, durationUs: 50_050 });
    worker.reply({ type: 'picture', picture: p });
    worker.reply({ type: 'decoded', id: worker.of('decode')[0]!.id, ms: 4 });
    expect(frames).toHaveLength(0);
    expect(inputs).toHaveLength(1);
    const input = inputs[0]!;
    expect(input.timestampUs).toBe(1000);
    expect(input.durationUs).toBe(50_050);
    expect(input.flags).toEqual(flags);
    expect([input.displayWidth, input.displayHeight]).toEqual([6, 3]);
    expect(input.planes.format).toBe('I420');
    expect([input.planes.width, input.planes.height]).toEqual([5, 3]);
    expect(input.planes.data).toBe(p.data);
    // Y at 5 × 3, then U and V at 3 × 2
    expect(input.planes.layout).toEqual([
      { offset: 0, stride: 5 },
      { offset: 15, stride: 3 },
      { offset: 21, stride: 3 },
    ]);
    // no matrix in the stream: 3 lines is standard definition
    expect(input.planes.matrix).toBe('smpte170m');
  });

  it('a progressive stream\'s pictures go to onOutput as VideoFrames at their times', async () => {
    const { worker, decoder, frames } = setup();
    const inputs: FieldInput[] = [];
    decoder.onFieldInput = (i) => inputs.push(i);
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO, interlaced: false });
    for (const t of [0, 40_000, 80_000]) decoder.decode(unit(t));
    // presentation order: the B picture after the reference that followed it
    for (const t of [0, 40_000, 80_000]) worker.reply({ type: 'picture', picture: picture(t, { flags: { fieldOrder: null, progressive: true, repeatFirstField: false } }) });
    expect(inputs).toHaveLength(0);
    expect(frames.map((f) => f.timestamp)).toEqual([0, 40_000, 80_000]);
  });

  it('discard units are decoded and never output', async () => {
    const { worker, decoder, frames } = setup();
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    decoder.decode(unit(0, true));
    decoder.decode(unit(40_000, true));
    decoder.decode(unit(80_000));
    expect(worker.of('decode').map((m) => [m.ptsUs, m.discard])).toEqual([
      [0, true],
      [40_000, true],
      [80_000, false],
    ]);
    // a worker that sent a discarded picture all the same: still dropped here
    worker.reply({ type: 'picture', picture: picture(40_000) });
    worker.reply({ type: 'picture', picture: picture(80_000) });
    expect(frames.map((f) => f.timestamp)).toEqual([80_000]);
  });

  it('the worker sends no picture of a discard unit', async () => {
    const posted: { message: FromVideoWorker; transfer: Transferable[] | undefined }[] = [];
    const out = [picture(0), picture(40_000), picture(80_000)];
    const fake = {
      push: vi.fn(),
      drain: vi.fn(() => out.splice(0)),
      flush: vi.fn(() => []),
      reset: vi.fn(),
      setSkipNonReference: vi.fn(),
      close: vi.fn(),
    };
    const core = new VideoWorkerCore({
      post: (message, transfer) => posted.push({ message, transfer }),
      openDecoder: async () => fake,
      now: () => 0,
    });
    await core.handle({ type: 'open', wasmUrl: 'x', codec: WasmVideoCodec.MPEG2, timeoutMs: null });
    await core.handle({ type: 'decode', id: 1, data: new Uint8Array(1), ptsUs: 0, discard: true });
    const sent = posted.filter((p) => p.message.type === 'picture');
    expect(sent.map((p) => (p.message as { picture: DecodedPicture }).picture.ptsUs)).toEqual([40_000, 80_000]);
    // each picture's buffer is transferred
    expect(sent[0]!.transfer).toEqual([(sent[0]!.message as { picture: DecodedPicture }).picture.data.buffer]);
    expect(posted.at(-1)!.message).toEqual({ type: 'decoded', id: 1, ms: 0 });
  });

  it('queueSize counts units not yet decoded and flush resolves after flushed', async () => {
    const { worker, decoder, frames } = setup();
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    for (const t of [0, 40_000, 80_000]) decoder.decode(unit(t));
    expect(decoder.queueSize).toBe(3);
    const [a, b, c] = worker.of('decode');
    worker.reply({ type: 'decoded', id: a!.id, ms: 2 });
    worker.reply({ type: 'decoded', id: b!.id, ms: 4 });
    expect(decoder.queueSize).toBe(1);
    expect(decoder.decodeMs).toBe(3);
    let flushed = false;
    const done = decoder.flush().then(() => {
      flushed = true;
    });
    const flush = worker.of('flush')[0]!;
    worker.reply({ type: 'decoded', id: c!.id, ms: 6 });
    worker.reply({ type: 'picture', picture: picture(80_000) });
    await Promise.resolve();
    expect(flushed).toBe(false);
    worker.reply({ type: 'flushed', id: flush.id });
    await done;
    expect(flushed).toBe(true);
    expect(decoder.queueSize).toBe(0);
    expect(decoder.decodeMs).toBe(4);
    expect(frames.map((f) => f.timestamp)).toEqual([80_000]);
  });

  it('decodeMs is the mean of the last 30 decodes', async () => {
    const { worker, decoder } = setup();
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    expect(decoder.decodeMs).toBeNull();
    for (let i = 0; i < 40; i++) {
      decoder.decode(unit(i * 40_000));
      worker.reply({ type: 'decoded', id: worker.of('decode')[i]!.id, ms: i < 10 ? 100 : 10 });
    }
    expect(decoder.decodeMs).toBe(10);
  });

  it('reset drops pictures in flight from before it', async () => {
    const { worker, decoder, frames } = setup();
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    decoder.decode(unit(0));
    decoder.decode(unit(40_000));
    decoder.reset();
    expect(worker.sent.at(-1)).toEqual({ type: 'reset' });
    decoder.decode(unit(5_000_000));
    // the worker answers the units sent before the reset after it was made here
    const [a, b, c] = worker.of('decode');
    worker.reply({ type: 'picture', picture: picture(0) });
    worker.reply({ type: 'decoded', id: a!.id, ms: 1 });
    worker.reply({ type: 'picture', picture: picture(40_000) });
    worker.reply({ type: 'decoded', id: b!.id, ms: 1 });
    worker.reply({ type: 'picture', picture: picture(5_000_000) });
    worker.reply({ type: 'decoded', id: c!.id, ms: 1 });
    expect(frames.map((f) => f.timestamp)).toEqual([5_000_000]);
    expect(decoder.queueSize).toBe(0);
  });

  it('a worker error event or a fatal error reports a fatal decoder error once', async () => {
    const { worker, decoder } = setup();
    const errors: DecoderError[] = [];
    decoder.onError = (e) => errors.push(e);
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    decoder.decode(unit(0));
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    worker.reply({ type: 'error', message: 'still broken', fatal: true });
    worker.onerror?.({ message: 'again' } as ErrorEvent);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(DecoderError);
    expect(errors[0]!.fatal).toBe(true);
    expect(worker.terminated).toBe(true);
    // a flush after the failure doesn't wait for a worker that is gone
    await decoder.flush();
    expect(decoder.queueSize).toBe(0);

    const second = setup();
    const errs: DecoderError[] = [];
    second.decoder.onError = (e) => errs.push(e);
    await second.decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    second.worker.reply({ type: 'error', message: 'a picture that is not 4:2:0', fatal: true });
    second.worker.reply({ type: 'error', message: 'again', fatal: true });
    expect(errs.map((e) => e.fatal)).toEqual([true]);
    expect(errs[0]!.message).toContain('4:2:0');
  });

  it('setSkipping sends skip and counts skipped pictures', async () => {
    const { worker, decoder, frames } = setup();
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    decoder.setSkipping(true);
    expect(worker.sent.at(-1)).toEqual({ type: 'skip', on: true });
    // decode order I P B B P; the B pictures are skipped, so presentation order has 0, 120 000, 240 000 only
    for (const t of [0, 120_000, 40_000, 80_000, 240_000]) decoder.decode(unit(t));
    worker.reply({ type: 'picture', picture: picture(0) });
    worker.reply({ type: 'picture', picture: picture(120_000) });
    expect(decoder.skipped).toBe(2);
    decoder.setSkipping(false);
    expect(worker.sent.at(-1)).toEqual({ type: 'skip', on: false });
    decoder.decode(unit(160_000));
    const done = decoder.flush();
    worker.reply({ type: 'picture', picture: picture(240_000) });
    worker.reply({ type: 'flushed', id: worker.of('flush')[0]!.id });
    await done;
    // 160 000 was sent with skipping off and never came out: lost, not skipped
    expect(decoder.skipped).toBe(2);
    expect(frames.map((f) => f.timestamp)).toEqual([0, 120_000, 240_000]);
  });

  it('a picture after units skipped while skipping was on carries afterSkip, the next one not', async () => {
    const { worker, decoder } = setup();
    const inputs: FieldInput[] = [];
    decoder.onFieldInput = (i) => inputs.push(i);
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO, interlaced: true });
    decoder.setSkipping(true);
    for (const t of [0, 120_000, 40_000, 80_000, 240_000, 160_000, 200_000]) decoder.decode(unit(t));
    worker.reply({ type: 'picture', picture: picture(0) });
    worker.reply({ type: 'picture', picture: picture(120_000) }); // 40 000 and 80 000 were skipped
    worker.reply({ type: 'picture', picture: picture(160_000) });
    expect(inputs.map((i) => [i.timestampUs, i.afterSkip === true])).toEqual([
      [0, false],
      [120_000, true],
      [160_000, false],
    ]);
  });

  it("an interlaced stream's picture of a progressive sequence goes to onOutput as a frame (a progressive play item)", async () => {
    const { worker, decoder, frames } = setup();
    const inputs: FieldInput[] = [];
    decoder.onFieldInput = (i) => inputs.push(i);
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO, interlaced: true });
    decoder.decode(unit(0));
    decoder.decode(unit(40_000));
    worker.reply({ type: 'picture', picture: picture(0) });
    // a picture of a progressive sequence states no field order
    worker.reply({ type: 'picture', picture: picture(40_000, { flags: { fieldOrder: null, progressive: true, repeatFirstField: false } }) });
    expect(inputs.map((i) => i.timestampUs)).toEqual([0]);
    expect(frames.map((f) => f.timestamp)).toEqual([40_000]);
  });

  it('configure rejects when the worker never answers open within the fetch limit and a margin, and stops the worker', async () => {
    const timers = new ManualTimers();
    const worker = new FakeWorker();
    worker.respond = null; // killed while it loads, without an error event
    const decoder = new WasmVideoDecoder({ createWorker: () => worker, wasmUrl: 'video.wasm', fetchTimeoutMs: 1000, setTimer: timers.setTimer, makeFrame: () => ({}) as VideoFrame });
    const opened = decoder.configure({ codingType: CodingType.VC1 });
    expect(timers.live().map((t) => t.ms)).toEqual([1000 + VIDEO_WORKER_OPEN_MARGIN_MS]);
    timers.fire();
    await expect(opened).rejects.toBeInstanceOf(UnsupportedCodecError);
    expect(worker.terminated).toBe(true);

    // answered in time: the bound is cancelled
    const quick = new FakeWorker();
    const timers2 = new ManualTimers();
    const ok = new WasmVideoDecoder({ createWorker: () => quick, wasmUrl: 'video.wasm', fetchTimeoutMs: 1000, setTimer: timers2.setTimer, makeFrame: () => ({}) as VideoFrame });
    await ok.configure({ codingType: CodingType.VC1 });
    expect(timers2.live()).toEqual([]);
  });

  it('a stalled module fetch times out and configure rejects', async () => {
    // a fetch that never answers, until its signal aborts it
    const stalled = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const decoder = new WasmVideoDecoder({
      createWorker: () => inProcessWorker(videoDecoderOpener(stalled)),
      wasmUrl: 'video.wasm',
      fetchTimeoutMs: 30,
      makeFrame: () => {
        throw new Error('no frames');
      },
    });
    await expect(decoder.configure({ codingType: CodingType.MPEG2_VIDEO })).rejects.toBeInstanceOf(UnsupportedCodecError);

    // without a limit of its own, the decoder asks for the engine's asset limit
    const plain = new FakeWorker();
    const byDefault = new WasmVideoDecoder({ createWorker: () => plain, wasmUrl: 'video.wasm', makeFrame: () => ({}) as VideoFrame });
    await byDefault.configure({ codingType: CodingType.MPEG2_VIDEO });
    expect(plain.of('open')[0]!.timeoutMs).toBe(ASSET_FETCH_TIMEOUT_MS);
  });

  it("configure rejects instead of throwing when the worker can't be created", async () => {
    const decoder = new WasmVideoDecoder({
      createWorker: () => {
        throw new Error('nested workers are not available');
      },
      wasmUrl: 'video.wasm',
      makeFrame: () => ({}) as VideoFrame,
    });
    let configured: Promise<void> | null = null;
    expect(() => {
      configured = decoder.configure({ codingType: CodingType.VC1 });
    }).not.toThrow();
    await expect(configured).rejects.toBeInstanceOf(UnsupportedCodecError);
    await expect(configured).rejects.toThrow(/nested workers/);
  });

  it('a worker that stops answering with units in flight reports a fatal error once and settles a pending flush', async () => {
    const timers = new ManualTimers();
    const worker = new FakeWorker();
    const decoder = new WasmVideoDecoder({ createWorker: () => worker, wasmUrl: 'video.wasm', makeFrame: () => ({}) as VideoFrame, setTimer: timers.setTimer, watchdogMs: 5_000 });
    const errors: DecoderError[] = [];
    decoder.onError = (e) => errors.push(e);
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    // nothing owed: no watchdog
    expect(timers.live()).toHaveLength(0);
    decoder.decode(unit(0));
    decoder.decode(unit(40_000));
    expect(timers.live()).toHaveLength(1);
    expect(timers.live()[0]!.ms).toBe(5_000);
    // an answer restarts it; once nothing is owed it stops
    worker.reply({ type: 'decoded', id: worker.of('decode')[0]!.id, ms: 1 });
    expect(timers.live()).toHaveLength(1);
    worker.reply({ type: 'decoded', id: worker.of('decode')[1]!.id, ms: 1 });
    expect(timers.live()).toHaveLength(0);

    decoder.decode(unit(80_000));
    let flushed = false;
    const done = decoder.flush().then(() => {
      flushed = true;
    });
    expect(timers.live()).toHaveLength(1);
    timers.fire();
    await done;
    expect(flushed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fatal).toBe(true);
    expect(errors[0]!.message).toMatch(/stopped answering/);
    expect(decoder.queueSize).toBe(0);
    expect(worker.terminated).toBe(true);
    expect(timers.live()).toHaveLength(0);
  });

  it("a rejected task in the worker's chain posts a fatal error", async () => {
    const posted: FromVideoWorker[] = [];
    const fake = { push: vi.fn(), drain: vi.fn(() => [picture(0)]), flush: vi.fn(() => []), reset: vi.fn(), setSkipNonReference: vi.fn(), close: vi.fn() };
    const core = new VideoWorkerCore({
      post: (message) => {
        // a picture that can't be posted (a DataCloneError): the task rejects outside the decoder's own calls
        if (message.type === 'picture') throw new Error('could not clone the picture');
        posted.push(message);
      },
      openDecoder: async () => fake,
      now: () => 0,
    });
    core.enqueue({ type: 'open', wasmUrl: 'x', codec: WasmVideoCodec.MPEG2, timeoutMs: null });
    core.enqueue({ type: 'decode', id: 1, data: new Uint8Array(1), ptsUs: 0, discard: false });
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'error')).toBe(true));
    expect(posted.filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: 'could not clone the picture', fatal: true }]);

    // a message that can't be read is fatal too
    const second: FromVideoWorker[] = [];
    const other = new VideoWorkerCore({ post: (m) => second.push(m), openDecoder: async () => fake, now: () => 0 });
    other.messageError();
    expect(second).toEqual([{ type: 'error', message: 'a message to the video decoder worker could not be read', fatal: true }]);
  });

  it('close tells the worker and terminates it', async () => {
    const { worker, decoder } = setup();
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO });
    decoder.close();
    expect(worker.sent.at(-1)).toEqual({ type: 'close' });
    expect(worker.terminated).toBe(true);
  });
});

describe('frameFromPicture', () => {
  it('makes an I420 VideoFrame at the picture\'s time and size with its colour matrix, else one by height', () => {
    const made: { data: Uint8Array; init: VideoFrameBufferInit }[] = [];
    vi.stubGlobal(
      'VideoFrame',
      class {
        constructor(data: Uint8Array, init: VideoFrameBufferInit) {
          made.push({ data, init });
        }
      },
    );
    try {
      const p = picture(1_000, { width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, matrix: null, durationUs: 33_367 });
      frameFromPicture(p);
      frameFromPicture(picture(2_000, { width: 720, height: 480, displayWidth: 853, displayHeight: 480, matrix: 'bt709', durationUs: 0 }));
      expect(made[0]!.data).toBe(p.data);
      expect(made[0]!.init).toMatchObject({ format: 'I420', codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080, timestamp: 1_000, duration: 33_367 });
      expect(made[0]!.init.colorSpace?.matrix).toBe('bt709');
      expect(made[1]!.init).toMatchObject({ codedWidth: 720, codedHeight: 480, displayWidth: 853, displayHeight: 480, timestamp: 2_000 });
      expect(made[1]!.init.duration).toBeUndefined();
      expect(made[1]!.init.colorSpace?.matrix).toBe('bt709');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the decoder worker with the real video.wasm', () => {
  let wasmPromise: Promise<VideoWasm> | null = null;
  const wasm = (): Promise<VideoWasm> => {
    wasmPromise ??= loadVideoWasm(readFileSync(fileURLToPath(new URL('../../wasm/video/video.wasm', import.meta.url))));
    return wasmPromise;
  };

  /** The video PES payloads of a playlist's one clip on a committed synthetic disc, timed in microseconds. */
  function clipUnits(disc: string, playlist: string): VideoUnit[] {
    const root = new URL(`../../../../fixtures/synthetic/${disc}/BDMV/`, import.meta.url);
    const mpls = parseMpls(new Uint8Array(readFileSync(fileURLToPath(new URL(`PLAYLIST/${playlist}.mpls`, root)))));
    const m2ts = new Uint8Array(readFileSync(fileURLToPath(new URL(`STREAM/${mpls.playItems[0]!.clipId}.m2ts`, root))));
    const units: VideoUnit[] = [];
    const asm = new PesAssembler((pes) => {
      if (pes.streamId === 0xe0) units.push({ data: pes.payload, ptsUs: pes.pts === undefined ? NaN : Math.round((pes.pts * 1000) / 90), discard: false });
    });
    for (let o = 0; o + 192 <= m2ts.length; o += 192) {
      const pkt = parseSourcePacket(m2ts, o);
      if (pkt) asm.push(pkt);
    }
    asm.flush();
    return units;
  }

  it("decodes disc-mpeg2-interlaced's playlist 00000 to interlaced field inputs in presentation order", async () => {
    const module = await wasm();
    const decoder = new WasmVideoDecoder({
      createWorker: () => inProcessWorker(async (_url, codec) => new WasmPictureDecoder(module, codec)),
      wasmUrl: 'video.wasm',
      makeFrame: () => {
        throw new Error('an interlaced stream makes no VideoFrame');
      },
    });
    const inputs: FieldInput[] = [];
    const errors: DecoderError[] = [];
    decoder.onFieldInput = (i) => inputs.push({ ...i, planes: { ...i.planes } });
    decoder.onError = (e) => errors.push(e);
    await decoder.configure({ codingType: CodingType.MPEG2_VIDEO, interlaced: true });
    const units = clipUnits('disc-mpeg2-interlaced', '00000');
    expect(units.length).toBe(120);
    for (const u of units) decoder.decode(u);
    await decoder.flush();
    decoder.close();
    expect(errors).toEqual([]);
    expect(inputs).toHaveLength(120);
    for (let i = 1; i < inputs.length; i++) expect(inputs[i]!.timestampUs, `picture ${i}`).toBeGreaterThan(inputs[i - 1]!.timestampUs);
    expect(inputs.every((i) => i.flags.progressive === false && i.flags.fieldOrder === 'tff')).toBe(true);
    const first = inputs[0]!;
    expect([first.planes.width, first.planes.height]).toEqual([1920, 1080]);
    expect(first.planes.data.length).toBe(1920 * 1080 * 1.5);
    expect(first.planes.layout).toEqual([
      { offset: 0, stride: 1920 },
      { offset: 1920 * 1080, stride: 960 },
      { offset: 1920 * 1080 * 1.25, stride: 960 },
    ]);
    expect(first.durationUs).toBeGreaterThan(0);
    expect(decoder.decodeMs).not.toBeNull();
  });
});
