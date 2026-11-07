import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FansubTitleState } from '@seikou/nas/nas-api';
import { FansubState } from './state';

const DAY = 86_400_000;
const NOW = 100 * DAY;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fansub-state-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = (titleId: string, over: Partial<FansubTitleState> = {}): FansubTitleState => ({ titleId, lastRunAt: NOW - DAY, running: false, nothingFound: false, seasons: {}, episodes: {}, ...over });

describe('FansubState', () => {
  it('has no state for an unknown title and keeps what it is given across instances', () => {
    const s = new FansubState(dir);
    expect(s.title('a')).toBeNull();
    const put = state('a', { seasons: { s1: { bestGroup: 'GroupA', usedGroups: [{ group: 'GroupA', rank: 'best' }] } }, episodes: { 's1#1': { status: 'attached' } } });
    s.put(put);
    expect(new FansubState(dir).title('a')).toEqual(put);
  });

  it('says which titles are due: never run, nothing found 30 days ago, or a service was down for an episode', () => {
    const s = new FansubState(dir);
    s.put(state('ran-yesterday'));
    s.put(state('empty-31', { nothingFound: true, lastRunAt: NOW - 31 * DAY }));
    s.put(state('empty-29', { nothingFound: true, lastRunAt: NOW - 29 * DAY }));
    s.put(state('found-long-ago', { lastRunAt: NOW - 90 * DAY }));
    s.put(state('never', { lastRunAt: null }));
    s.put(state('tosho-down', { episodes: { 's1#1': { status: 'attached' }, 's1#2': { status: 'not-found', reason: 'service-unavailable' } } }));
    expect(s.due(['unknown', 'ran-yesterday', 'empty-31', 'empty-29', 'found-long-ago', 'never', 'tosho-down'], NOW))
      .toEqual(['unknown', 'empty-31', 'never', 'tosho-down']);
  });

  it('remembers deleted tracks per title, and undelete clears one title only', () => {
    const s = new FansubState(dir);
    expect(s.isDeleted(7, 2)).toBe(false);
    s.markDeleted('a', 7, 2);
    s.markDeleted('a', 7, 2);
    s.markDeleted('b', 9, 1);
    expect(s.isDeleted(7, 2)).toBe(true);
    expect(s.isDeleted(7, 1)).toBe(false);
    expect(new FansubState(dir).isDeleted(7, 2)).toBe(true);
    s.undelete('a');
    expect(s.isDeleted(7, 2)).toBe(false);
    expect(s.isDeleted(9, 1)).toBe(true);
  });

  it('treats an entry missing its fields as never run', () => {
    mkdirSync(join(dir, 'fansubs'), { recursive: true });
    writeFileSync(join(dir, 'fansubs', 'state.json'), JSON.stringify({ titles: { a: { titleId: 'a' }, b: { ...state('b'), lastRunAt: 'x' } }, deleted: {}, languages: ['eng'] }));
    const s = new FansubState(dir);
    expect(s.title('a')).toBeNull();
    expect(s.title('b')).toBeNull();
    expect(s.due(['a', 'b'], NOW)).toEqual(['a', 'b']);
  });

  it('clears a running flag a stopped process left behind', () => {
    const s = new FansubState(dir);
    s.put(state('a', { running: true }));
    s.put(state('b'));
    s.clearRunning();
    expect(new FansubState(dir).title('a')).toEqual(state('a'));
    expect(s.title('b')).toEqual(state('b'));
  });

  it('defaults the languages to eng and keeps a change', () => {
    const s = new FansubState(dir);
    expect(s.languages()).toEqual(['eng']);
    s.setLanguages(['eng', 'jpn']);
    expect(new FansubState(dir).languages()).toEqual(['eng', 'jpn']);
  });

  it('always keeps eng first, lower-cased and without repeats', () => {
    const s = new FansubState(dir);
    s.setLanguages(['jpn']);
    expect(s.languages()).toEqual(['eng', 'jpn']);
    s.setLanguages(['JPN', 'fre', 'eng', 'jpn']);
    expect(new FansubState(dir).languages()).toEqual(['eng', 'jpn', 'fre']);
  });

  it.each(['{nope', '[1,2]', 'null', '42', '"text"', '{"deleted":{"a":5}}', '{"deleted":"x"}', '{"titles":[1]}', '{"titles":{"a":5}}', '{"languages":"eng"}'])('moves a damaged state.json (%s) aside, logs once and starts empty', (text) => {
    mkdirSync(join(dir, 'fansubs'), { recursive: true });
    writeFileSync(join(dir, 'fansubs', 'state.json'), text);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = new FansubState(dir);
      expect(s.languages()).toEqual(['eng']);
      expect(s.isDeleted(1, 1)).toBe(false);
      s.markDeleted('a', 1, 1);
      expect(s.isDeleted(1, 1)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      const aside = readdirSync(join(dir, 'fansubs')).filter((f) => f.startsWith('state.json.bad-'));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(dir, 'fansubs', aside[0]!), 'utf8')).toBe(text);
    } finally {
      warn.mockRestore();
    }
  });
});
