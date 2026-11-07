import { afterEach, describe, expect, it, vi } from 'vitest';
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
