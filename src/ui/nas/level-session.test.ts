import { describe, expect, it, vi } from 'vitest';
import { buildMpls } from '../../../tests/helpers/bdmv-builders';
import type { DiscManifest, LevelAt } from '@seikou/nas/nas-api';
import type { RemoteDiscSpec } from '../../engine/disc/disc-spec';
import type { PlayerController } from '../../player/player-controller';
import { LevelSession, launchManifest } from './level-session';
import { NasBusyError } from './nas-client';
import type { NasClient } from './nas-client';

const BUSY_COPY = 'The NAS is encoding for someone else right now.';
const ORIGINAL_AT: LevelAt = { level: 'original', audio: 1 };
const H264: LevelAt = { level: 'h264-1080', audio: 1 };
const PHONE: LevelAt = { level: 'phone-720', audio: 1 };

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const mpls = buildMpls({
  playItems: [{
    clipId: '00001', inTime: 0, outTime: 450000,
    video: [{ pid: 0x1011, codingType: 0x1b }],
    audio: [{ pid: 0x1100, codingType: 0x81, format: 6, lang: 'jpn' }, { pid: 0x1101, codingType: 0x81, format: 3, lang: 'eng' }],
  }],
});
const original: DiscManifest = { discId: 'd1', name: 'Disc', files: [], inline: { 'BDMV/PLAYLIST/00001.MPLS': b64(mpls) } };
const levels = [{ level: 'original' as const, label: 'Original', budgetMbps: 30, available: true }];

function setup(opts: { busy?: boolean; failSwitch?: string } = {}) {
  const manifest = vi.fn(async (_id: string, at?: LevelAt): Promise<DiscManifest> => {
    if (opts.busy) throw new NasBusyError(BUSY_COPY);
    return { discId: 'd1', name: `at ${at?.level}`, files: [], inline: {} };
  });
  const releaseViewing = vi.fn(async () => undefined);
  const nas = { manifest, releaseViewing } as unknown as NasClient;
  const listeners = new Set<() => void>();
  let levelSwitch: 'idle' | 'switching' | { error: string } = 'idle';
  const setLevel = vi.fn((_spec: RemoteDiscSpec, _audio?: number) => {
    levelSwitch = 'switching';
    queueMicrotask(() => {
      levelSwitch = opts.failSwitch ? { error: opts.failSwitch } : 'idle';
      for (const l of [...listeners]) l();
    });
  });
  const controller = {
    setLevel,
    getSnapshot: () => ({ levelSwitch }),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as PlayerController;
  const session = new LevelSession(nas);
  const deps = { controller, base: 'https://nas/', token: 't' };
  /** Hears the controller before the session does (as PlayerScreen's effect, subscribed first). */
  const listenFirst = (l: () => void): void => {
    listeners.add(l);
  };
  return { session, deps, manifest, releaseViewing, setLevel, listenFirst };
}
const begin = (s: LevelSession, at: LevelAt): void => s.begin({ discId: 'd1', levels, at, original });

describe('LevelSession', () => {
  it('switches by fetching the level\'s manifest then setLevel', async () => {
    const t = setup();
    begin(t.session, ORIGINAL_AT);
    await t.session.switchTo(H264, t.deps);
    expect(t.manifest).toHaveBeenCalledWith('d1', H264);
    const spec = t.setLevel.mock.calls[0]![0];
    expect(spec).toMatchObject({ kind: 'remote', base: 'https://nas/', token: 't', query: 'level=h264-1080&audio=1', original });
    expect(spec.manifest.name).toBe('at h264-1080');
    expect('fetchPort' in spec).toBe(false);
    expect(t.session.get()).toMatchObject({ at: H264, notice: null });
    expect(t.releaseViewing).not.toHaveBeenCalled();
  });

  it('a busy NAS keeps the current level and says why', async () => {
    const t = setup({ busy: true });
    begin(t.session, H264);
    const seen = vi.fn();
    t.session.subscribe(seen);
    await t.session.switchTo(PHONE, t.deps);
    expect(t.setLevel).not.toHaveBeenCalled();
    expect(t.session.get()).toMatchObject({ at: H264, notice: BUSY_COPY });
    expect(seen).toHaveBeenCalled();
  });

  it('releases the old lease after a switch and on close, once each', async () => {
    const t = setup();
    begin(t.session, H264);
    await t.session.switchTo(PHONE, t.deps);
    expect(t.releaseViewing.mock.calls).toEqual([['d1', H264]]);
    t.session.end();
    t.session.end();
    expect(t.releaseViewing.mock.calls).toEqual([['d1', H264], ['d1', PHONE]]);
    expect(t.session.get()).toBeNull();
  });

  it('never releases Original', async () => {
    const t = setup();
    begin(t.session, ORIGINAL_AT);
    await t.session.switchTo(H264, t.deps);
    expect(t.releaseViewing).not.toHaveBeenCalled();
    await t.session.switchTo(ORIGINAL_AT, t.deps);
    expect(t.releaseViewing.mock.calls).toEqual([['d1', H264]]);
    t.session.end();
    expect(t.releaseViewing).toHaveBeenCalledTimes(1);
  });

  it('an audio switch at a level is a switch to the same level with that audio', async () => {
    const t = setup();
    begin(t.session, H264);
    await t.session.switchTo({ level: 'h264-1080', audio: 2 }, t.deps);
    expect(t.manifest).toHaveBeenCalledWith('d1', { level: 'h264-1080', audio: 2 });
    expect(t.setLevel.mock.calls[0]![0].query).toBe('level=h264-1080&audio=2');
    expect(t.session.get()?.at).toEqual({ level: 'h264-1080', audio: 2 });
    expect(t.releaseViewing.mock.calls).toEqual([['d1', H264]]);
  });

  it('a failed switch keeps the level, shows the error and releases the new lease', async () => {
    const t = setup({ failSwitch: 'It would not open.' });
    begin(t.session, H264);
    await t.session.switchTo(PHONE, t.deps);
    expect(t.session.get()).toMatchObject({ at: H264, notice: 'It would not open.' });
    expect(t.releaseViewing.mock.calls).toEqual([['d1', PHONE]]);
  });

  it('reads the original audio streams of a playlist, numbered from 1', () => {
    const t = setup();
    begin(t.session, H264);
    const tracks = t.session.originalAudio('00001');
    expect(tracks.map((x) => [x.number, x.language])).toEqual([[1, 'jpn'], [2, 'eng']]);
    expect(tracks[0]!.label).toContain('Japanese');
    expect(t.session.originalAudio('99999')).toEqual([]);
  });

  it('a failed switch that the player ended first still releases the new lease', async () => {
    const t = setup({ failSwitch: 'It would not open.' });
    begin(t.session, H264);
    // PlayerScreen ends the session when the engine reports the failure (the disc closed)
    t.listenFirst(() => t.session.end());
    await t.session.switchTo(PHONE, t.deps);
    expect(t.session.get()).toBeNull();
    expect(t.releaseViewing.mock.calls).toEqual([['d1', H264], ['d1', PHONE]]);
  });

  it('a switch to Original carries the audio stream the level played, in Original numbering', async () => {
    const t = setup();
    begin(t.session, { level: 'h264-1080', audio: 2 });
    await t.session.switchTo({ level: 'original', audio: 2 }, t.deps);
    expect(t.setLevel.mock.calls[0]![1]).toBe(2);
    await t.session.switchTo({ level: 'phone-720', audio: 2 }, t.deps);
    expect(t.setLevel.mock.calls[1]![1]).toBeUndefined(); // a level's query names its audio
  });
});

describe('launchManifest', () => {
  const nasWith = () => {
    const manifest = vi.fn(async (_id: string, at?: LevelAt): Promise<DiscManifest> => ({ discId: 'd1', name: `at ${at?.level}`, files: [], inline: {} }));
    const releaseViewing = vi.fn(async () => undefined);
    return { manifest, releaseViewing };
  };
  it('Original is the manifest in hand, with no request', async () => {
    const nas = nasWith();
    expect(await launchManifest(nas, 'd1', ORIGINAL_AT, original, () => true)).toBe(original);
    expect(nas.manifest).not.toHaveBeenCalled();
  });
  it("a level's manifest, for a launch still current", async () => {
    const nas = nasWith();
    expect((await launchManifest(nas, 'd1', H264, original, () => true))?.name).toBe('at h264-1080');
    expect(nas.releaseViewing).not.toHaveBeenCalled();
  });
  it('a launch superseded while the level was asked for gives the lease back', async () => {
    const nas = nasWith();
    expect(await launchManifest(nas, 'd1', H264, original, () => false)).toBeNull();
    expect(nas.releaseViewing.mock.calls).toEqual([['d1', H264]]);
  });
});
