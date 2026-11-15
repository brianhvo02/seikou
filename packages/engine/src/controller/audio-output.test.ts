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
});
