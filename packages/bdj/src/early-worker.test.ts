import { describe, expect, it } from 'vitest';
import { EarlyBdjWorker } from './early-worker';
import type { WorkerLike } from './session';
import type { FromBdj, ToBdj } from './worker-protocol';

function fakeWorker(): { readonly worker: WorkerLike; readonly sent: ToBdj[]; emit(m: FromBdj): void; fail(message: string): void; terminated: boolean } {
  const sent: ToBdj[] = [];
  const f = {
    worker: { postMessage: (m: ToBdj) => void sent.push(m), onmessage: null, onerror: null, terminate: () => void (f.terminated = true) } as WorkerLike,
    sent,
    emit: (m: FromBdj) => f.worker.onmessage?.({ data: m } as MessageEvent<FromBdj>),
    fail: (message: string) => f.worker.onerror?.({ message } as ErrorEvent),
    terminated: false,
  };
  return f;
}

const BOOT: Extract<ToBdj, { type: 'boot' }> = {
  type: 'boot',
  registers: new SharedArrayBuffer(8),
  status: new SharedArrayBuffer(8),
  plane: new SharedArrayBuffer(8),
  disc: { kind: 'files', entries: [] },
  readAheadBytes: 0,
  discId: null,
  classLibrary: { rt: new Uint8Array(0), libbluray: new Uint8Array(0), libblurayAwt: new Uint8Array(0) },
};

describe('EarlyBdjWorker', () => {
  it('sends one boot, and holds what the worker says until the session asks for the boot', () => {
    const f = fakeWorker();
    const early = new EarlyBdjWorker(f.worker);
    expect(early.boot(BOOT)).toBe(true);
    f.emit({ type: 'log', line: 'booting', error: false });
    f.emit({ type: 'booted', bootMs: 5 });
    f.fail('late error');
    const heard: string[] = [];
    early.onmessage = (e) => void heard.push(e.data.type);
    early.onerror = (e) => void heard.push(`error:${e.message}`);
    expect(heard).toEqual([]);
    early.postMessage(BOOT); // the session's own boot: dropped, and the held messages follow in order
    expect(f.sent).toEqual([BOOT]);
    expect(heard).toEqual(['log', 'booted', 'error:late error']);
    early.postMessage({ type: 'start', title: 1 });
    f.emit({ type: 'log', line: 'live', error: false });
    expect(f.sent).toEqual([BOOT, { type: 'start', title: 1 }]);
    expect(heard).toEqual(['log', 'booted', 'error:late error', 'log']);
  });

  it("passes the session's boot when none went out early, and refuses a later early one", () => {
    const f = fakeWorker();
    const early = new EarlyBdjWorker(f.worker);
    const heard: string[] = [];
    early.onmessage = (e) => void heard.push(e.data.type);
    early.postMessage(BOOT);
    expect(early.boot(BOOT)).toBe(false);
    f.emit({ type: 'booted', bootMs: 1 });
    expect(f.sent).toEqual([BOOT]);
    expect(heard).toEqual(['booted']);
  });

  it('terminates the worker and drops what it held', () => {
    const f = fakeWorker();
    const early = new EarlyBdjWorker(f.worker);
    early.boot(BOOT);
    f.emit({ type: 'booted', bootMs: 1 });
    early.terminate();
    expect(f.terminated).toBe(true);
    const heard: string[] = [];
    early.onmessage = (e) => void heard.push(e.data.type);
    early.postMessage(BOOT);
    expect(heard).toEqual([]);
  });
});
