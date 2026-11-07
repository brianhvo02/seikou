import { describe, expect, it } from 'vitest';
import type { FansubAlignment, FansubTitleState, StoredSubtitle } from '@seikou/nas/nas-api';
import { episodeMark, runButtonLabel, seasonLine, trackChip } from './fansub-model';

const at = (y: number, m: number, d: number, h: number, min = 0): number => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 23, 12);

const state = (over: Partial<FansubTitleState> = {}): FansubTitleState => ({
  titleId: 't', lastRunAt: NOW - 1000, running: false, nothingFound: false,
  seasons: { s1: { bestGroup: 'GroupA', usedGroups: [{ group: 'GroupA', rank: 'best' }] } }, episodes: {}, ...over,
});

const sub = (alignment: FansubAlignment, extra: Partial<StoredSubtitle> = {}): StoredSubtitle => ({
  id: 'a', name: 'Full', language: 'en', offsetMs: 0, fileName: 'a.ass', fileSize: 1, fonts: [],
  attachment: { kind: 'chapter', discKey: 'd.1', playlistId: '00001', chapter: 0 }, uploadedAt: 1,
  source: { kind: 'fansub', group: 'GroupA', tracker: 't', rank: 'best', toshoFileId: 1, track: 2, trackName: 'Full', alignment, linedUpOn: { discKey: 'd.1', playlistId: '00001' } },
  ...extra,
});

describe('seasonLine', () => {
  it('names the best group alone', () => {
    expect(seasonLine(state(), 's1', NOW)).toBe('Fansubs: GroupA (SeaDex best) · checked today');
  });
  it('adds the other groups whose tracks were used, with their rank', () => {
    const s = state({ seasons: { s1: { bestGroup: 'GroupA', usedGroups: [{ group: 'GroupA', rank: 'best' }, { group: 'GroupB', rank: 'web' }, { group: 'GroupC', rank: 'other' }] } }, lastRunAt: at(2026, 10, 23, 3) });
    expect(seasonLine(s, 's1', NOW)).toBe('Fansubs: GroupA (SeaDex best) · subtitles from GroupB WEB, GroupC · checked last night');
  });
  it('has no best group line when only others were used', () => {
    const s = state({ seasons: { s1: { bestGroup: null, usedGroups: [{ group: 'GroupB', rank: 'web' }] } } });
    expect(seasonLine(s, 's1', NOW)).toBe('Fansubs: subtitles from GroupB WEB · checked today');
  });
  it('says last night for the evening before and a date before that', () => {
    expect(seasonLine(state({ lastRunAt: at(2026, 10, 22, 18) }), 's1', NOW)).toContain('checked last night');
    expect(seasonLine(state({ lastRunAt: at(2026, 10, 22, 17, 59) }), 's1', NOW)).toContain('checked 22 Oct');
    expect(seasonLine(state({ lastRunAt: at(2026, 10, 5, 9) }), 's1', NOW)).toContain('checked 5 Oct');
  });
  it('says so while a run is going, and is null with nothing to say', () => {
    expect(seasonLine(state({ running: true }), 's1', NOW)).toBe('Fansubs: looking now');
    expect(seasonLine(state(), 's2', NOW)).toBeNull();
    expect(seasonLine(state({ running: true }), 's2', NOW)).toBe('Fansubs: looking now');
  });
  it('leaves out the check time when the title never ran', () => {
    expect(seasonLine(state({ lastRunAt: null }), 's1', NOW)).toBe('Fansubs: GroupA (SeaDex best)');
  });
});

describe('episodeMark', () => {
  it('offsets, with a real minus sign and one decimal', () => {
    expect(episodeMark([sub({ kind: 'offset', offsetMs: 1234, confidence: 1 })], undefined, false)).toEqual({ text: 'lined up · +1.2 s', tone: 'ok' });
    expect(episodeMark([sub({ kind: 'offset', offsetMs: -400, confidence: 1 })], undefined, false)?.text).toBe('lined up · −0.4 s');
  });
  it('under 50 ms is plain lined up', () => {
    expect(episodeMark([sub({ kind: 'offset', offsetMs: 30, confidence: 1 })], undefined, false)).toEqual({ text: 'lined up', tone: 'ok' });
    expect(episodeMark([sub({ kind: 'offset', offsetMs: -49, confidence: 1 })], undefined, false)?.text).toBe('lined up');
  });
  it('a split names its first boundary after 0', () => {
    const split: FansubAlignment = { kind: 'split', parts: [{ fromMs: 0, offsetMs: 0 }, { fromMs: 700_000, offsetMs: 2000 }], confidence: 1 };
    expect(episodeMark([sub(split)], undefined, false)).toEqual({ text: 'split at 11:40 · check', tone: 'warn' });
  });
  it('none is red', () => {
    expect(episodeMark([sub({ kind: 'none', reason: 'no-speech' })], undefined, false)).toEqual({ text: "couldn't line up · set by hand", tone: 'bad' });
  });
  it('original timing has no mark, but a mixed episode marks on its other tracks', () => {
    expect(episodeMark([sub({ kind: 'original' })], undefined, false)).toBeNull();
    expect(episodeMark([sub({ kind: 'original' }), sub({ kind: 'offset', offsetMs: 1234, confidence: 1 })], undefined, false)?.text).toBe('lined up · +1.2 s');
  });
  it('original timing with missing fonts still says no fonts', () => {
    expect(episodeMark([sub({ kind: 'original' }, { fontsMissing: true })], undefined, false)).toEqual({ text: 'no fonts', tone: 'warn' });
  });
  it('the worst track decides', () => {
    const ok = sub({ kind: 'offset', offsetMs: 0, confidence: 1 });
    const fonts = sub({ kind: 'offset', offsetMs: 0, confidence: 1 }, { fontsMissing: true });
    const split = sub({ kind: 'split', parts: [{ fromMs: 0, offsetMs: 0 }, { fromMs: 60_000, offsetMs: 500 }], confidence: 1 });
    const none = sub({ kind: 'none', reason: 'low-confidence' });
    expect(episodeMark([ok, fonts], undefined, false)?.text).toBe('no fonts');
    expect(episodeMark([ok, fonts, split], undefined, false)?.text).toBe('split at 1:00 · check');
    expect(episodeMark([split, none, ok], undefined, false)?.text).toBe("couldn't line up · set by hand");
  });
  it('missing fonts warn', () => {
    expect(episodeMark([sub({ kind: 'offset', offsetMs: 0, confidence: 1 }, { fontsMissing: true })], undefined, false)).toEqual({ text: 'no fonts', tone: 'warn' });
  });
  it('not found is red, and nothing at all is null', () => {
    expect(episodeMark([], { status: 'not-found', reason: 'no-release' }, false)).toEqual({ text: 'not found', tone: 'bad' });
    expect(episodeMark([], undefined, false)).toBeNull();
  });
  it('stale wins', () => {
    expect(episodeMark([sub({ kind: 'none', reason: 'no-speech' })], undefined, true)).toEqual({ text: 'lined up on another disc', tone: 'warn' });
  });
  it('ignores owner uploads', () => {
    const upload: StoredSubtitle = { ...sub({ kind: 'original' }), source: undefined };
    expect(episodeMark([upload], undefined, false)).toBeNull();
  });
});

describe('trackChip and runButtonLabel', () => {
  it('shows the track name', () => {
    expect(trackChip(sub({ kind: 'original' }))).toBe('Full');
  });
  it('falls back to the stored name for an owner upload', () => {
    expect(trackChip({ ...sub({ kind: 'original' }), source: undefined, name: 'Mine' })).toBe('Mine');
  });
  it('asks again once it has run', () => {
    expect(runButtonLabel(state({ lastRunAt: null }))).toBe('Find fansubs');
    expect(runButtonLabel(state())).toBe('Find fansubs again');
  });
});
