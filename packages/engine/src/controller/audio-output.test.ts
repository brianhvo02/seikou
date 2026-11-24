import { afterEach, describe, expect, it, vi } from 'vitest';
import { Control, ringViews } from '../audio/ring';
import { AudioOutput } from './audio-output';

vi.mock('./pcm-worklet.ts?worker&url', () => ({ default: 'worklet.js' }));

function fakeContext(log: string[]): AudioContext {
  const node = { connect: () => ({ connect: () => undefined }) };
  return {
    audioWorklet: { addModule: () => Promise.resolve() },
    createGain: () => ({ gain: { value: 1 }, connect: () => ({ connect: () => undefined }) }),
    resume: () => {
      log.push('resume');
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    state: 'running',
    addEventListener: () => undefined,
    destination: {},
    outputLatency: 0,
    baseLatency: 0,
    node,
  } as unknown as AudioContext;
}

describe('AudioOutput audio session', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(nav: { audioSession?: { type: string } } | undefined) {
    vi.useFakeTimers();
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        connect(): { connect: () => undefined } {
          return { connect: () => undefined };
        }
      },
    );
    const log: string[] = [];
    const out = new AudioOutput(() => {
      log.push(`create:${nav?.audioSession?.type ?? 'none'}`);
      return fakeContext(log);
    }, nav);
    return { out, log };
  }

  it('sets the session type to playback before creating the context, once', async () => {
    const nav = { audioSession: { type: 'auto' } };
    const { out, log } = setup(nav);
    await out.ensureStarted();
    await out.ensureStarted();
    expect(nav.audioSession.type).toBe('playback');
    expect(log.filter((l) => l.startsWith('create'))).toEqual(['create:playback']);
    vi.useRealTimers();
  });

  it('does not throw without audioSession or when the setter throws', async () => {
    await expect(setup({}).out.ensureStarted()).resolves.toBeDefined();
    const throwing = {
      audioSession: {
        get type() {
          return 'auto';
        },
        set type(_v: string) {
          throw new TypeError('unsupported');
        },
      },
    };
    await expect(setup(throwing).out.ensureStarted()).resolves.toBeDefined();
    vi.useRealTimers();
  });
});

describe('AudioOutput latency', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('publishes the latency as unknown while the output reads 0, then what it reads, soon after', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        connect(): { connect: () => undefined } {
          return { connect: () => undefined };
        }
      },
    );
    const context = fakeContext([]) as unknown as { outputLatency: number; baseLatency: number; currentTime: number };
    context.currentTime = 0;
    context.baseLatency = 0.0213;
    const ring = await new AudioOutput(() => context as unknown as AudioContext, undefined).ensureStarted();
    const latency = (): number => ringViews(ring).control[Control.LatencyUs]!;
    expect(latency()).toBe(-1); // Chrome before the output has rendered: not known
    context.currentTime = 0.043;
    context.outputLatency = 0.056;
    vi.advanceTimersByTime(5);
    expect(latency()).toBe(77_300);
    // an output that keeps saying 0 has no latency, once it has rendered for a while
    context.outputLatency = 0;
    context.currentTime = 0.3;
    vi.advanceTimersByTime(50);
    expect(latency()).toBe(21_300);
  });

  it('stops publishing once the context closes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        connect(): { connect: () => undefined } {
          return { connect: () => undefined };
        }
      },
    );
    const listeners: Array<() => void> = [];
    const context = fakeContext([]) as unknown as { outputLatency: number; currentTime: number; state: string; addEventListener: (t: string, fn: () => void) => void };
    context.currentTime = 0;
    context.addEventListener = (_t, fn) => listeners.push(fn);
    const ring = await new AudioOutput(() => context as unknown as AudioContext, undefined).ensureStarted();
    const latency = (): number => ringViews(ring).control[Control.LatencyUs]!;
    expect(vi.getTimerCount()).toBe(2); // the unknown-latency poll and the steady publisher
    context.state = 'closed';
    for (const fn of listeners) fn();
    expect(vi.getTimerCount()).toBe(0);
    context.currentTime = 0.5;
    context.outputLatency = 0.05;
    vi.advanceTimersByTime(200);
    expect(latency()).toBe(-1); // nothing published after the close
  });
});

describe('AudioOutput channels', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Starts an output on a device with `max` channels; returns the ring's channels, the worklet's, the destination's and the gain's settings. */
  async function start(max: number, choice?: 'auto' | 'stereo' | 2 | 6 | 8) {
    vi.useFakeTimers();
    let workletChannels: number[] = [];
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        constructor(_c: unknown, _n: string, o: { outputChannelCount: number[] }) {
          workletChannels = o.outputChannelCount;
        }
        connect(): { connect: () => undefined } {
          return { connect: () => undefined };
        }
      },
    );
    const destination = { maxChannelCount: max, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
    const gain = { gain: { value: 1 }, channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers', connect: () => ({ connect: () => undefined }) };
    const context = { ...(fakeContext([]) as unknown as Record<string, unknown>), destination, createGain: () => gain };
    const out = new AudioOutput(() => context as unknown as AudioContext, undefined);
    if (choice) out.setChannels(choice);
    const ring = await out.ensureStarted();
    return { ring: ringViews(ring).channels, worklet: workletChannels, destination, gain, out };
  }

  it('keeps a stereo device stereo, with the browser defaults untouched', async () => {
    const r = await start(2);
    expect([r.ring, r.worklet, r.out.outputChannels]).toEqual([2, [2], 2]);
    expect(r.destination).toMatchObject({ channelCount: 2, channelInterpretation: 'speakers' });
    expect(r.gain).toMatchObject({ channelCountMode: 'max' });
  });

  it('plays 5.1 on a six-channel device and 7.1 on an eight-channel one, discretely', async () => {
    const six = await start(6);
    expect([six.ring, six.worklet]).toEqual([6, [6]]);
    expect(six.destination).toMatchObject({ channelCount: 6, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    expect(six.gain).toMatchObject({ channelCount: 6, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    const many = await start(16);
    expect([many.ring, many.worklet, many.destination.channelCount]).toEqual([8, [8], 8]);
  });

  it('stays stereo when the setting says so, and caps a test count by the device', async () => {
    expect((await start(8, 'stereo')).ring).toBe(2);
    expect((await start(8, 6)).ring).toBe(6);
    expect((await start(2, 8)).ring).toBe(2);
  });
});
