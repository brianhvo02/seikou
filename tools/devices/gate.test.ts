import { describe, expect, it } from 'vitest';
import { buildPlan, loadPlan, openRemote, parseGateArgs, stats, type RemoteOps } from './gate';

const KEYS = ['wait playlist 149', 'wait still 1500   # menu', 'key right', 'wait still 1000', 'key ok', 'wait playlist 40'].join('\n');
const golden = (steps: Array<[string, string?]>, end = 'eeee'): string =>
  [
    '{"call":"setUOMaskN","args":[true,true],"ret":null}',
    ...steps.map(([step, hash], n) => JSON.stringify({ script: 'step', n, step, ...(hash ? { hash } : {}) })),
    JSON.stringify({ script: 'end', hash: end }),
  ].join('\n');

describe('buildPlan', () => {
  it('pairs the script with the settled hashes and stays before the last key, returning to the plane before it', () => {
    const plan = buildPlan(KEYS, golden([['wait playlist 149'], ['wait still 1500', 'aaaa'], ['key right'], ['wait still 1000', 'bbbb'], ['key ok'], ['wait playlist 40']]));
    expect(plan.steps.map((s) => s.hash)).toEqual([null, 'aaaa', null, 'bbbb', null, null]);
    expect(plan.stayBefore).toBe(4);
    expect(plan.stayHash).toBe('bbbb');
    expect(plan.endHash).toBe('eeee');
  });

  it('refuses a golden made from another script', () => {
    expect(() => buildPlan(KEYS, golden([['wait playlist 149'], ['wait still 1500', 'aaaa'], ['key left']]))).toThrow(/golden step 2/);
    expect(() => buildPlan('key ok', golden([['key ok'], ['wait playlist 40']]))).toThrow(/2 steps/);
  });

  it('loads the committed plans of both local discs', () => {
    const a = loadPlan('BDJ_DISC_A');
    expect(a.stayHash).toBe('4bc306b4');
    expect(a.steps[a.stayBefore]!.step.text).toBe('key ok');
    const r = loadPlan('BDJ_DISC_B');
    expect(r.steps.filter((s) => s.hash).map((s) => s.hash)).toEqual(['4055a182', 'b860e96b', '4521ddc5']);
    expect(r.stayHash).toBe('b860e96b');
  });
});

describe('parseGateArgs', () => {
  it('defaults to both discs, a 10-minute stay and port 4183', () => {
    const o = parseGateArgs(['--target', 'chrome']);
    expect(o.discs).toEqual(['BDJ_DISC_A', 'BDJ_DISC_B']);
    expect(o.stayMs).toBe(600_000);
    expect(o.port).toBe(4183);
    expect(o.server).toBeNull();
  });

  it('takes a shorter stay, flags and an external server', () => {
    const o = parseGateArgs(['--target', 'ios:00008', '--disc', 'BDJ_DISC_B', '--stay-ms', '0', '--touch', '--server', 'https://192.168.1.2:8443/', '--token', 't']);
    expect(o).toMatchObject({ discs: ['BDJ_DISC_B'], stayMs: 0, touch: true, server: 'https://192.168.1.2:8443', token: 't' });
  });

  it('rejects unknown discs and options, and a server without its token', () => {
    expect(() => parseGateArgs(['--target', 'chrome', '--disc', 'NOPE'])).toThrow(/no gate plan/);
    expect(() => parseGateArgs(['--target', 'chrome', '--bogus', '1'])).toThrow(/unknown option/);
    expect(() => parseGateArgs(['--target', 'chrome', '--server', 'http://x'])).toThrow(/go together/);
    expect(() => parseGateArgs([])).toThrow(/usage/);
  });
});

describe('stats', () => {
  it('gives median, min and max', () => {
    expect(stats([])).toBeNull();
    expect(stats([5, 1, 3])).toEqual({ n: 3, median: 3, max: 5, min: 1 });
    expect(stats([4, 1, 3, 2])).toEqual({ n: 4, median: 2.5, max: 4, min: 1 });
  });
});

/**
 * A model of the player for openRemote: the control bar idles out (hidden: its buttons take no taps, which fall through
 * to the picture below), a tap the disc ignores opens the remote with the controls, and the Remote toggle opens it
 * only while the bar is shown.
 */
function fakePlayer(o: { ignoresTap: boolean; barShown: boolean; toggleWorks?: boolean }): RemoteOps & { calls: string[] } {
  const s = { bar: o.barShown, remote: false, ignored: 0 };
  const calls: string[] = [];
  return {
    calls,
    remoteOpen: async () => s.remote,
    tapsIgnored: async () => s.ignored,
    tapMenu: async () => {
      calls.push('tapMenu');
      if (o.ignoresTap) {
        s.ignored++;
        s.remote = true;
        s.bar = true;
        return 'video-canvas';
      }
      s.bar = true; // the tap woke the controls (the buffering spinner took it)...
      return 'spinner';
    },
    waitRemote: async () => {
      if (!o.ignoresTap) s.bar = false; // ...and they idled out during the wait
      return s.remote;
    },
    barShown: async () => s.bar,
    showControls: async () => {
      calls.push('showControls');
      s.bar = true;
      return 'a tap in the letterbox';
    },
    tapRemoteToggle: async () => {
      calls.push('tapRemoteToggle');
      if (s.bar && o.toggleWorks !== false) s.remote = !s.remote;
    },
  };
}

describe('openRemote (the gate on a touch target)', () => {
  it('records a tap the disc ignored, which opened the remote by itself', async () => {
    const p = fakePlayer({ ignoresTap: true, barShown: false });
    const first = await openRemote(p);
    expect(first).toEqual({ tapsIgnoredBefore: 0, tapsIgnoredAfter: 1, ignored: true, tapTarget: 'video-canvas', remoteOpened: true, how: 'tap on the menu, ignored by the disc' });
    expect(p.calls).toEqual(['tapMenu']);
  });

  it('shows the controls that idled out before tapping the Remote toggle, and records the first tap as not ignored', async () => {
    const p = fakePlayer({ ignoresTap: false, barShown: false });
    const first = await openRemote(p);
    expect(first).toMatchObject({ tapsIgnoredBefore: 0, tapsIgnoredAfter: 0, ignored: false, tapTarget: 'spinner', remoteOpened: true });
    expect(first!.how).toMatch(/Remote button.*a tap in the letterbox/);
    expect(p.calls).toEqual(['tapMenu', 'showControls', 'tapRemoteToggle']);
  });

  it('does nothing when the remote is already open', async () => {
    const p = fakePlayer({ ignoresTap: true, barShown: true });
    await openRemote(p);
    expect(await openRemote(p)).toBeNull();
    expect(p.calls).toEqual(['tapMenu']);
  });

  it('fails, saying what the first tap did, when the toggle never opens the remote', async () => {
    const p = fakePlayer({ ignoresTap: false, barShown: false, toggleWorks: false });
    await expect(openRemote(p)).rejects.toThrow(/the remote did not open.*spinner.*not counted as ignored/);
  });
});
