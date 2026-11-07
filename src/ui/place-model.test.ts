import { describe, expect, it } from 'vitest';
import type { PlaceSettings, PlaybackPlace } from '@seikou/nas/nas-api';
import type { AudioTrack } from '../engine/protocol';
import type { PlayerSnapshot } from '../player/player-controller';
import { buildPlace, isFinished, placeMinDurationUs, promptLines, qualifies, resumeStart, settingsForUpNext } from './place-model';

const S = 1e6;
const MIN = 300 * S;

const settings: PlaceSettings = { audioLanguage: 'jpn', pgLanguage: 'eng', textFiles: [], psr1: 2, psr2: (0x80000000 | 3) >>> 0, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 0.8, muted: false };
const place = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: 'k', discId: 'd', playlistId: '00001', timeUs: 754 * S, durationUs: 1440 * S, finished: false,
  mode: 'none', title: null, psrs: [], gprs: null, settings, updatedAt: 0, deviceName: 'Living room TV', ...over,
});
const track = (index: number, language: string, playable = true): AudioTrack => ({ index, codec: 'ac3', language, channels: 'stereo', playable });

describe('placeMinDurationUs', () => {
  it('defaults to 300 s and takes ?placemin in seconds', () => {
    expect(placeMinDurationUs('')).toBe(MIN);
    expect(placeMinDurationUs('?placemin=1')).toBe(1e6);
    expect(placeMinDurationUs('?placemin=abc')).toBe(MIN);
    expect(placeMinDurationUs('?placemin=-4')).toBe(MIN);
  });
});

describe('qualifies', () => {
  it('299 s does not, 300 s does', () => {
    expect(qualifies({ currentPlaylistId: '1', durationUs: 299 * S }, null, null, MIN)).toBe(false);
    expect(qualifies({ currentPlaylistId: '1', durationUs: 300 * S }, null, null, MIN)).toBe(true);
  });
  it('a chosen playlist or the main title qualifies at any length', () => {
    expect(qualifies({ currentPlaylistId: '1', durationUs: 8 * S }, '1', null, MIN)).toBe(true);
    expect(qualifies({ currentPlaylistId: '1', durationUs: 8 * S }, null, '1', MIN)).toBe(true);
  });
  it('a 30 s menu playlist after a chosen episode does not', () => {
    expect(qualifies({ currentPlaylistId: 'menu', durationUs: 30 * S }, 'ep', 'main', MIN)).toBe(false);
  });
  it('no playlist never qualifies', () => {
    expect(qualifies({ currentPlaylistId: null, durationUs: 9999 * S }, null, null, MIN)).toBe(false);
  });
  it('?placemin=1 lowers the bar', () => {
    expect(qualifies({ currentPlaylistId: '1', durationUs: 2 * S }, null, null, placeMinDurationUs('?placemin=1'))).toBe(true);
  });
});

describe('isFinished', () => {
  const base = { engineState: 'playing', durationUs: 1000 * S };
  it('ended is finished', () => {
    expect(isFinished({ ...base, engineState: 'ended', timeUs: 0, chapters: [] })).toBe(true);
  });
  it('past the start of a last chapter in the final 10%', () => {
    const chapters = [{ startUs: 0 }, { startUs: 500 * S }, { startUs: 900 * S }];
    expect(isFinished({ ...base, timeUs: 899 * S, chapters })).toBe(false);
    expect(isFinished({ ...base, timeUs: 900 * S, chapters })).toBe(true);
  });
  it('not at a last chapter that starts at 50%', () => {
    expect(isFinished({ ...base, timeUs: 990 * S, chapters: [{ startUs: 0 }, { startUs: 500 * S }] })).toBe(false);
  });
  it('with no chapters, at 95%', () => {
    expect(isFinished({ ...base, timeUs: 949 * S, chapters: [] })).toBe(false);
    expect(isFinished({ ...base, timeUs: 950 * S, chapters: [] })).toBe(true);
  });
  it('unknown duration is not finished', () => {
    expect(isFinished({ engineState: 'playing', timeUs: 5, durationUs: 0, chapters: [] })).toBe(false);
  });
});

describe('buildPlace', () => {
  const snapshot = {
    engineState: 'playing', currentPlaylistId: '00002', durationUs: 1440 * S, timeUs: 600 * S, chapters: [{ index: 1, startUs: 0 }],
    audioTracks: [track(1, 'eng'), track(2, 'jpn')], selectedAudio: 2, volume: 0.5, muted: true,
    subtitles: { pg: [{ index: 3, language: 'eng' }], text: { files: [{ name: 'ep03.en.ass', format: 'ass', cues: 9, startUs: 0, offsetMs: 400 }], missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1.5 },
  } as unknown as PlayerSnapshot;
  it('takes the registers from the place state and the rest from the snapshot', () => {
    const psrs = new Array<number>(128).fill(0);
    psrs[1] = 2; psrs[2] = 0x80000001; psrs[3] = 1;
    const p = buildPlace({ discKey: 'k', discId: 'd', snapshot, place: { mode: 'hdmv', title: 4, psrs, gprs: { 3: 7 } }, shaderSet: 'a4k', deviceName: 'Phone', nowMs: 99, textFileSizes: { 'ep03.en.ass': 1234 } });
    expect(p).toMatchObject({
      playlistId: '00002', timeUs: 600 * S, durationUs: 1440 * S, finished: false, mode: 'hdmv', title: 4, gprs: { 3: 7 }, updatedAt: 99, deviceName: 'Phone',
      settings: { audioLanguage: 'jpn', pgLanguage: null, textFiles: [{ name: 'ep03.en.ass', size: 1234, startUs: 0, offsetMs: 400 }], psr1: 2, psr2: 0x80000001, psr3: 1, textOn: true, textScale: 1.5, shaderSet: 'a4k', volume: 0.5, muted: true },
    });
  });
  it('marks a stored subtitle with its id and language, its size from the NAS', () => {
    const p = buildPlace({
      discKey: 'k', discId: 'd', snapshot, place: { mode: 'none', title: null, psrs: [], gprs: null }, shaderSet: null, deviceName: 'x', nowMs: 1,
      storedSubtitles: { 'ep03.en.ass': { id: 'sub-1', size: 2048, language: 'en' } },
    });
    expect(p.settings.textFiles).toEqual([{ name: 'ep03.en.ass', size: 2048, startUs: 0, offsetMs: 400, subtitleId: 'sub-1', language: 'en' }]);
  });
  it('records the PG language of a selected PG stream', () => {
    const sn = { ...snapshot, subtitles: { pg: [{ index: 3, language: 'eng' }], text: null, selected: { pg: 3 }, scale: 1 } } as unknown as PlayerSnapshot;
    const p = buildPlace({ discKey: 'k', discId: 'd', snapshot: sn, place: { mode: 'none', title: null, psrs: [], gprs: null }, shaderSet: null, deviceName: 'x', nowMs: 1 });
    expect(p.settings).toMatchObject({ pgLanguage: 'eng', textFiles: [], psr2: 0x80000003 });
  });
  it('falls back to the snapshot when there are no PSRs', () => {
    const p = buildPlace({ discKey: 'k', discId: 'd', snapshot, place: { mode: 'none', title: null, psrs: [], gprs: null }, shaderSet: null, deviceName: 'x', nowMs: 1 });
    expect(p.settings.psr1).toBe(2);
    expect(p.settings.psr3).toBe(1);
  });
});

describe('settingsForUpNext', () => {
  it('picks the same-language track on a disc numbered differently', () => {
    const next = settingsForUpNext(settings, [track(1, 'jpn'), track(2, 'eng')], []);
    expect(next.psr1).toBe(1);
    expect(next.audioLanguage).toBe('jpn');
    expect(next.volume).toBe(0.8);
  });
  it('skips an unplayable track of that language', () => {
    expect(settingsForUpNext(settings, [track(1, 'jpn', false), track(2, 'eng'), track(3, 'jpn')], []).psr1).toBe(3);
  });
  it('falls back to the first playable track when the language is absent', () => {
    expect(settingsForUpNext(settings, [track(1, 'eng', false), track(2, 'eng')], []).psr1).toBe(2);
  });
  it('maps PG by language and keeps the display flag', () => {
    const next = settingsForUpNext(settings, [track(1, 'jpn')], [{ index: 1, language: 'fra' }, { index: 2, language: 'eng' }]);
    expect(next.psr2).toBe(((0x80000000 | 2) >>> 0));
  });
  it("keeps a stored subtitle's id and language for the next episode's pick", () => {
    const textFiles = [{ name: 'ep1.ass', size: 9, startUs: 0, offsetMs: 900, subtitleId: 'sub-1', language: 'en' }];
    expect(settingsForUpNext({ ...settings, textFiles, textOn: true }, [], []).textFiles).toEqual(textFiles);
  });
  it('turns PG off when the language is missing on the new disc', () => {
    expect(settingsForUpNext(settings, [], [{ index: 1, language: 'fra' }]).psr2).toBe(0xfff);
  });
});

describe('resumeStart', () => {
  const lists = [{ id: '00001', durationUs: 1440 * S }];
  it('no-playlist when the playlist is gone', () => {
    expect(resumeStart(place({ playlistId: '00009' }), lists)).toEqual({ problem: 'no-playlist' });
  });
  it('past-end at or after the end', () => {
    expect(resumeStart(place({ timeUs: 1440 * S }), lists)).toEqual({ problem: 'past-end' });
    expect(resumeStart(place({ timeUs: 1441 * S }), lists)).toEqual({ problem: 'past-end' });
  });
  it('uses the disc list duration over the saved one', () => {
    expect(resumeStart(place({ timeUs: 700 * S }), [{ id: '00001', durationUs: 600 * S }])).toEqual({ problem: 'past-end' });
  });
  it('hdmv from the place, with registers', () => {
    const r = resumeStart(place({ mode: 'hdmv', title: 3, psrs: [1, 2], gprs: { 1: 5 } }), lists);
    expect(r).toEqual({ playlistId: '00001', timeUs: 754 * S, hdmv: { title: 3, psrs: [1, 2], gprs: { 1: 5 } }, playback: null });
  });
  it('bdj and none play directly with PSR 1-3 only', () => {
    for (const mode of ['bdj', 'none'] as const) {
      const r = resumeStart(place({ mode, title: null, psrs: new Array<number>(128).fill(9), gprs: null }), lists);
      expect(r).toEqual({ playlistId: '00001', timeUs: 754 * S, hdmv: null, playback: { psr1: 2, psr2: settings.psr2, psr3: 1 } });
    }
  });
  it('checks nothing when the list is unknown', () => {
    expect(resumeStart(place(), null)).toMatchObject({ playlistId: '00001' });
  });
});

describe('promptLines', () => {
  const now = Date.UTC(2026, 9, 21, 12, 0, 0);
  const at = (msAgo: number, over: Partial<PlaybackPlace> = {}) => promptLines(place({ updatedAt: now - msAgo, ...over }), now);
  it('has the exact copy', () => {
    expect(at(30_000)).toEqual({
      heading: 'Pick up where you left off?',
      line: 'Stopped at 12:34 of 24:00 on Living room TV, just now.',
      details: 'Audio: jpn · Subtitles: track 3',
      resumeLabel: 'Resume at 12:34',
    });
  });
  it('words the time since', () => {
    expect(at(5 * 60_000).line).toMatch(/, 5 min ago\.$/);
    expect(at(59 * 60_000).line).toMatch(/, 59 min ago\.$/);
    expect(at(3 * 3600_000).line).toMatch(/, 3 h ago\.$/);
    expect(at(24 * 3600_000).line).toMatch(/, yesterday\.$/);
    expect(at(4 * 86_400_000).line).toMatch(/, 2026-10-17\.$/);
  });
  it('formats an hour or more as h:mm:ss and lists text subtitles and a shader', () => {
    const p = at(0, { timeUs: 3725 * S, durationUs: 7200 * S, settings: { ...settings, textOn: true, textFiles: [{ name: 'ep03.en.ass', size: 1, startUs: 0, offsetMs: -400 }], shaderSet: 'Anime4K A', audioLanguage: null } });
    expect(p.resumeLabel).toBe('Resume at 1:02:05');
    expect(p.line).toContain('of 2:00:00');
    expect(p.details).toBe('Subtitles: ep03.en.ass -0.4 s · Shader: Anime4K A');
  });
});
