import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareBdjTraces } from './compare';
import { parseBdjTrace, traceThrough } from './format';
import type { BdjHost, RecordingHost, TraceEntry } from '../../src/bdj/host';
import { RegisterFile } from '@seikou/engine/hdmv/registers';
import { applyHarnessSettings, replayBdj } from './replay';
import { replayPlayerBdj, traceEntryOf } from './replay-player';

/** libbluray's control calls on disc-bdj through TitleXlet's second playlist selection. */
const fullGolden = (): TraceEntry[] => parseBdjTrace(readFileSync(new URL('./golden/disc-bdj.jsonl', import.meta.url), 'utf8'));
/** The part the RecordingHost replay reaches: through the first selection (it plays nothing, so no playlist ends). */
const bootGolden = (): TraceEntry[] => traceThrough(fullGolden(), 'selectPlaylistN');

describe('BD-J trace parity', () => {
  it('disc-bdj makes the control calls libbluray makes, through the playlist selected when the first one ends', async () => {
    const golden = fullGolden();
    expect(golden.filter((e) => e.call === 'selectPlaylistN')).toHaveLength(2);
    const { trace, firstPlaylistMs, untilMs, virtualMs } = await replayPlayerBdj('fixtures/synthetic/disc-bdj', { until: 'selectPlaylistN', occurrence: 2 });
    console.log(`disc-bdj player replay: first playlist ${firstPlaylistMs.toFixed(0)} ms, until selectPlaylistN#2 ${untilMs.toFixed(0)} ms (virtual ${virtualMs.toFixed(0)} ms)`);
    compareBdjTraces(golden, trace);
  }, 120_000);

  it('disc-bdj-mixed hands First Play to HDMV title 1 and its JumpTitle to BD-J title 2, with the calls libbluray makes', async () => {
    const golden = parseBdjTrace(readFileSync(new URL('./golden/disc-bdj-mixed.jsonl', import.meta.url), 'utf8'));
    // First Play's TitleContext.start of HDMV title 1 (BDJLoader → selectHdmvTitle), then title 2's playlist 00001
    expect(golden.filter((e) => e.call === 'selectTitleN').map((e) => e.args)).toEqual([[1]]);
    expect(golden.filter((e) => e.call === 'selectPlaylistN').map((e) => e.args[0])).toEqual([1]);
    const { trace, events } = await replayPlayerBdj('fixtures/synthetic/disc-bdj-mixed', { until: 'selectPlaylistN' });
    compareBdjTraces(golden, trace);
    // BD-J, then the HDMV title on the navigator (playlist 00000 from its PlayPL), then BD-J again for title 2
    expect(events.flatMap((e) => (e.type === 'bdjActive' ? [e.active] : []))).toEqual([true, false, true]);
    expect(events.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : []))[0]).toBe('00000');
  }, 120_000);

  it("formats the engine's replies as trace.patch prints the natives", () => {
    expect(traceEntryOf('selectRate', [0.3333333432674408, 1], 1)).toEqual({ call: 'selectRateN', args: [0.333333, 1], ret: 1 });
    expect(traceEntryOf('writeReg', [0, 500, 0x88000000, -1], 0)).toEqual({ call: 'writeRegN', args: [0, 500, -2013265920, -1], ret: 0 });
    expect(traceEntryOf('seek', [0, -1, '90000'], '90000')).toEqual({ call: 'seekN', args: [0, -1, '90000'], ret: '90000' });
    expect(traceEntryOf('setUOMask', [true, false], 0)).toEqual({ call: 'setUOMaskN', args: [true, false], ret: null });
    expect(traceEntryOf('selectPlaylist', [833, -1, -1, '-1'], 1)).toEqual({ call: 'selectPlaylistN', args: [833, -1, -1, '-1'], ret: 1 });
  });

  it('disc-bdj makes the control calls libbluray makes through the first selection, on the recording host', async () => {
    const golden = bootGolden();
    const { trace, bootMs, untilMs } = await replayBdj('fixtures/synthetic/disc-bdj', { until: 'selectPlaylistN' });
    console.log(`disc-bdj replay: boot ${bootMs.toFixed(0)} ms, until selectPlaylistN ${untilMs.toFixed(0)} ms`);
    compareBdjTraces(golden, trace);
  }, 120_000);

  it('makes the same calls when the control calls answer through promises, as the BD-J worker host does', async () => {
    const golden = bootGolden();
    const ASYNC = new Set(['selectTitle', 'selectPlaylist', 'seek', 'selectAngle', 'selectRate', 'writeReg', 'soundEffect', 'setVirtualPackage', 'setUOMask', 'setKeyInterest']);
    let parked = 0;
    const later = (host: RecordingHost): BdjHost =>
      new Proxy(host, {
        get: (target, key) => {
          const v: unknown = Reflect.get(target, key);
          if (typeof v !== 'function') return v;
          const f = (v as (...a: unknown[]) => unknown).bind(target);
          if (!ASYNC.has(String(key))) return f;
          // the engine applies the call later, as across the worker boundary
          return (...args: unknown[]) => {
            parked++;
            return new Promise((resolve) => setTimeout(() => resolve(f(...args)), 1));
          };
        },
      });
    const { trace } = await replayBdj('fixtures/synthetic/disc-bdj', { until: 'selectPlaylistN', wrapHost: later });
    expect(parked).toBeGreaterThan(0);
    compareBdjTraces(golden, trace);
  }, 120_000);

  it("sets the harness's player settings: country us, audio, PG and menu language eng", () => {
    const regs = new RegisterFile();
    applyHarnessSettings(regs);
    expect([16, 17, 18, 19].map((i) => regs.psrRead(i))).toEqual([0x656e67, 0x656e67, 0x656e67, 0x7573]);
  });

  it('reports a timed-out run explicitly', async () => {
    await expect(replayBdj('fixtures/synthetic/disc-bdj', { until: 'selectPlaylistN', timeoutMs: 1 })).rejects.toThrow(/timed out after 1 ms|ended 'aborted' before selectPlaylistN \(timed out: true/);
  }, 120_000);

  it('reports a run that ends before the until call explicitly', async () => {
    await expect(replayBdj('fixtures/synthetic/disc-bdj', { until: 'noSuchCallN' })).rejects.toThrow(/run ended '(idle|deadlock)' before noSuchCallN \(timed out: false, exit status none, \d+ calls traced\)/);
  }, 120_000);
});
