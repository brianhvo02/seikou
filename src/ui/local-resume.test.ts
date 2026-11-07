import { describe, expect, it, vi } from 'vitest';
import type { DiscPlaces, PlaybackPlace } from '@seikou/nas/nas-api';
import { askOrOpen, localKeyOf, recentResumeLabel } from './local-resume';

const place = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: 'f.0123456789ABCDEF0123456789ABCDEF', discId: 'x', playlistId: '00000', timeUs: 125_000_000, durationUs: 1_400_000_000,
  finished: false, mode: 'none', title: null, psrs: [], gprs: null,
  settings: { pgLanguage: null, textFiles: [], audioLanguage: null, psr1: 1, psr2: 0, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false },
  updatedAt: 1, deviceName: 'this device', ...over,
});
const placesOf = (p: PlaybackPlace): DiscPlaces => ({ defaults: p.settings, places: { [p.playlistId]: p } });
const entries = (m2ts: boolean): [string, { size: number }][] => [
  ['BDMV/index.bdmv', { size: 10 }],
  ...(m2ts ? ([['BDMV/STREAM/00000.m2ts', { size: 6_000_000 }]] as [string, { size: number }][]) : []),
];

describe('localKeyOf', () => {
  it('is the content fingerprint, and null without one (nothing is remembered)', () => {
    expect(localKeyOf(entries(true))).toMatch(/^f\.[0-9A-F]{32}$/);
    expect(localKeyOf(entries(false))).toBeNull();
    expect(localKeyOf([])).toBeNull();
  });
});

describe('askOrOpen', () => {
  const run = (read: () => Promise<DiscPlaces>, key: string | null, isCurrent = () => true) => {
    const ask = vi.fn();
    const open = vi.fn();
    const readPlaces = vi.fn(read);
    return askOrOpen({ discKey: key, playlists: null, readPlaces, isCurrent, ask, open }).then(() => ({ ask, open, readPlaces }));
  };

  it('asks about an unfinished place', async () => {
    const r = await run(async () => placesOf(place()), 'f.0123456789ABCDEF0123456789ABCDEF');
    expect(r.ask).toHaveBeenCalledOnce();
    expect(r.open).not.toHaveBeenCalled();
  });

  it('opens at once, reading nothing, for a disc without a fingerprint', async () => {
    const r = await run(async () => placesOf(place()), null);
    expect(r.open).toHaveBeenCalledOnce();
    expect(r.ask).not.toHaveBeenCalled();
    expect(r.readPlaces).not.toHaveBeenCalled();
  });

  it('opens at once for a finished or short place', async () => {
    expect((await run(async () => placesOf(place({ finished: true })), 'f.A')).open).toHaveBeenCalledOnce();
    expect((await run(async () => placesOf(place({ timeUs: 2_000_000 })), 'f.A')).open).toHaveBeenCalledOnce();
  });

  it('a call superseded while its read was slow neither asks nor opens', async () => {
    let current = true;
    let release!: (p: DiscPlaces) => void;
    const slow = new Promise<DiscPlaces>((r) => (release = r));
    const done = run(() => slow, 'f.A', () => current);
    current = false; // a later pick took over
    release(placesOf(place()));
    const r = await done;
    expect(r.ask).not.toHaveBeenCalled();
    expect(r.open).not.toHaveBeenCalled();
  });
});

describe('recentResumeLabel', () => {
  it('reads "Resume at m:ss" for an unfinished place, and nothing otherwise', async () => {
    expect(await recentResumeLabel('f.A', async () => placesOf(place()), 0)).toBe('Resume at 2:05');
    expect(await recentResumeLabel('f.A', async () => placesOf(place({ finished: true })), 0)).toBeNull();
    expect(await recentResumeLabel(null, async () => placesOf(place()), 0)).toBeNull();
    expect(await recentResumeLabel('d.0123456789abcdef', async () => placesOf(place()), 0)).toBeNull();
  });
});
