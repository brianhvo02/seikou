// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../protocol';
import { ELEMENT_END_SLACK_US, ELEMENT_QUERY_TIMEOUT_MS, ELEMENT_RESUME_LEAD_US, ElementCodecQueries, ElementSession } from './element-session';

function session(current = true): { element: ElementSession; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  let generation = 0;
  const element = new ElementSession('avc', {
    emit: (e) => events.push(e),
    nextGeneration: () => ++generation,
    isCurrent: () => current,
    shown: () => {},
  });
  return { element, events };
}

describe('ElementSession', () => {
  it('begins under a new generation that is also its first', () => {
    const { element, events } = session();
    element.begin(2_000_000, true);
    expect(events).toEqual([{ type: 'videoReset', startUs: 2_000_000, paused: true, generation: 1 }]);
    expect(element.generation).toBe(1);
    expect(element.firstGeneration).toBe(1);
    element.reset(5_000_000, false);
    expect(element.generation).toBe(2);
    expect(element.firstGeneration).toBe(1);
  });

  it('ignores reports from before the latest reset', () => {
    const { element } = session();
    element.begin(0, false);
    element.reset(0, false);
    expect(element.buffered(1, 9_000_000, 0, 0)).toBe('stale');
    expect(element.bufferedEndUs).toBe(-Infinity);
    expect(element.stall(1)).toBe(false);
    expect(element.stalled).toBe(false);
    expect(element.buffered(2, 9_000_000, 0, 0)).toBe('ok');
    expect(element.bufferedEndUs).toBe(9_000_000);
  });

  it('is ready with video past the clock, and after a stall only with the resume lead reported since', () => {
    const { element } = session();
    element.begin(0, false);
    expect(element.elementReady(1_000_000, false)).toBe(false);
    element.buffered(1, 1_100_000, 0, 1_000_000);
    expect(element.elementReady(1_000_000, false)).toBe(true);
    element.stall(1);
    expect(element.elementReady(1_000_000, false)).toBe(false);
    element.buffered(1, 1_100_000, 0, 1_000_000);
    expect(element.elementReady(1_000_000, false)).toBe(false);
    element.buffered(1, 1_000_000 + ELEMENT_RESUME_LEAD_US, 0, 1_000_000);
    expect(element.elementReady(1_000_000, false)).toBe(true);
  });

  it('a reset forgets a stall', () => {
    const { element } = session();
    element.begin(0, false);
    element.stall(1);
    element.reset(0, false);
    expect(element.stalled).toBe(false);
    expect(element.freshBuffered).toBe(false);
    expect(element.bufferedEndUs).toBe(-Infinity);
  });

  it('at the end of reading waits for the last segment, within the slack', () => {
    const { element } = session();
    element.begin(0, false);
    // no segment yet: the end is -Infinity, which any report reaches
    element.buffered(1, 0, 0, 1_000_000);
    expect(element.elementReady(1_000_000, true)).toBe(true);
    expect(element.elementReady(1_000_000 + ELEMENT_END_SLACK_US, true)).toBe(true);
  });

  it('blocks reading at the lead held or sent ahead of the clock', () => {
    const { element } = session();
    element.begin(0, false);
    expect(element.readerBlocked(0, 4_000_000)).toBe(false);
    element.buffered(1, 4_000_000, 0, 0);
    expect(element.readerBlocked(0, 4_000_000)).toBe(true);
    expect(element.readerBlocked(1, 4_000_000)).toBe(false);
  });
});

describe('ElementCodecQueries', () => {
  function queries(): { q: ElementCodecQueries; events: EngineEvent[]; fire: () => void; delays: number[] } {
    const events: EngineEvent[] = [];
    const timers: (() => void)[] = [];
    const delays: number[] = [];
    const q = new ElementCodecQueries(
      (e) => events.push(e),
      (ms, fn) => {
        delays.push(ms);
        timers.push(fn);
        return () => {
          const i = timers.indexOf(fn);
          if (i >= 0) timers.splice(i, 1);
        };
      },
    );
    return { q, events, delays, fire: () => timers.splice(0).forEach((fn) => fn()) };
  }

  const avc = { codec: 'avc1.640028', hdr: null };
  const hevc = { codec: 'hvc1.2.4.L153.B0', hdr: null };
  const hdr = { codec: 'hvc1.2.4.L153.B0', hdr: { transfer: 'pq', mastering: true }, width: 3840, height: 2160, frameRate: 24 } as const;

  it('asks once per open question and keeps the answer', async () => {
    const { q, events, fire } = queries();
    const a = q.askElement(avc);
    const b = q.askElement(avc);
    expect(a).toBe(b);
    expect(events).toEqual([{ type: 'videoElementQuery', codec: 'avc1.640028', hdr: null }]);
    q.answer(avc, true);
    await expect(a).resolves.toBe(true);
    expect(q.cached(avc)).toBe(true);
    fire(); // the timer was cancelled
    expect(q.cached(avc)).toBe(true);
  });

  it('answers false at the timeout, and keeps a later answer for the next session', async () => {
    const { q, fire, delays } = queries();
    const a = q.askElement(hevc);
    expect(delays).toEqual([ELEMENT_QUERY_TIMEOUT_MS]);
    fire();
    await expect(a).resolves.toBe(false);
    expect(q.cached(hevc)).toBeUndefined();
    q.answer(hevc, true);
    expect(q.cached(hevc)).toBe(true);
  });

  it('asks the open questions again', () => {
    const { q, events } = queries();
    void q.askElement(avc);
    void q.askElement(hdr);
    q.answer(avc, false);
    events.length = 0;
    q.askAgain();
    expect(events).toEqual([{ type: 'videoElementQuery', ...hdr }]);
  });

  it('keys questions and answers by the codec with its HDR facts and size: an SDR answer settles no HDR question', async () => {
    const { q, events } = queries();
    const sdr = q.askElement(hevc);
    const withHdr = q.askElement(hdr);
    expect(sdr).not.toBe(withHdr);
    expect(events).toEqual([
      { type: 'videoElementQuery', codec: 'hvc1.2.4.L153.B0', hdr: null },
      { type: 'videoElementQuery', ...hdr },
    ]);
    q.answer(hevc, true);
    await expect(sdr).resolves.toBe(true);
    expect(q.cached(hdr)).toBeUndefined();
    q.answer({ ...hdr, hdr: { mastering: true, transfer: 'pq' } }, false);
    await expect(withHdr).resolves.toBe(false);
    expect(q.cached(hevc)).toBe(true);
    expect(q.cached(hdr)).toBe(false);
    expect(q.cached({ ...hdr, width: 1920, height: 1080 })).toBeUndefined();
  });
});
