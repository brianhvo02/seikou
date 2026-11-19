import { describe, expect, it } from 'vitest';
import { BDJ_REQUIREMENTS, bdjMissing, bdjUnsupportedMessage } from './requirements';

const full = { SharedArrayBuffer, crossOriginIsolated: true, Atomics, Worker: class {}, WebAssembly, OffscreenCanvas: class {} };

describe('bdjMissing', () => {
  it('is empty where everything BD-J needs is there', () => {
    expect(bdjMissing(full)).toEqual([]);
  });

  it('names each missing requirement, in order', () => {
    expect(bdjMissing({})).toEqual(Object.values(BDJ_REQUIREMENTS));
    expect(bdjMissing({ ...full, Worker: undefined })).toEqual(['workers started from workers']);
    expect(bdjMissing({ ...full, crossOriginIsolated: false })).toEqual(['cross-origin isolation (SharedArrayBuffer)']);
    expect(bdjMissing({ ...full, Atomics: {} })).toEqual(['Atomics.wait in workers']);
  });

  it('in a worker, calls Atomics.wait: one that throws is missing', () => {
    // Node's main thread allows Atomics.wait, as a worker does
    expect(bdjMissing(full, { inWorker: true })).toEqual([]);
    const throwing = {
      wait: () => {
        throw new TypeError('Atomics.wait cannot be called in this context');
      },
    };
    expect(bdjMissing({ ...full, Atomics: throwing }, { inWorker: true })).toEqual(['Atomics.wait in workers']);
    expect(bdjMissing({ ...full, Atomics: throwing })).toEqual([]); // the page cannot call it: present is enough
  });

  it('names what is missing in the notice', () => {
    expect(bdjUnsupportedMessage(['workers started from workers'])).toBe(
      "This disc uses BD-J (Java) menus, which this browser can't run: it lacks workers started from workers. Choose a playlist to play.",
    );
  });
});
