import { describe, expect, it, vi } from 'vitest';
import { TMDB_ATTRIBUTION, codeListed, codePollEnd, countdown, countdownTickMs, deleteTitleQuestion, encodingLine, encodingStatus, gateSwitchOn, lastSeen, matchingStatus, newCode, ownTitleKind, ownTitles, withGate, type AdminApi } from './admin-model';
import type { TitleSummary } from '../../engine/disc/nas-api';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function fakeApi(over: Partial<AdminApi> = {}): AdminApi {
  return {
    createCode: vi.fn(async (_target, invite: boolean) => ({
      code: 'K7QM-4XP2-R9TD',
      link: 'https://bluray.pages.dev/?pair=K7QM4XP2R9TD',
      expiresAt: NOW + (invite ? 3 * DAY : 10 * MINUTE),
      rendezvous: true,
      personId: 'p1',
      personName: 'Mika',
      invite,
    })),
    ...over,
  };
}

describe('lastSeen', () => {
  it('says just now under a minute', () => {
    expect(lastSeen(NOW - 59_000, NOW)).toBe('just now');
    expect(lastSeen(NOW + 2_000, NOW)).toBe('just now');
  });

  it('counts minutes, hours and days, singular for one', () => {
    expect(lastSeen(NOW - MINUTE, NOW)).toBe('1 minute ago');
    expect(lastSeen(NOW - 59 * MINUTE, NOW)).toBe('59 minutes ago');
    expect(lastSeen(NOW - HOUR, NOW)).toBe('1 hour ago');
    expect(lastSeen(NOW - 23 * HOUR - 59 * MINUTE, NOW)).toBe('23 hours ago');
    expect(lastSeen(NOW - DAY, NOW)).toBe('1 day ago');
    expect(lastSeen(NOW - 40 * DAY, NOW)).toBe('40 days ago');
  });
});

describe('countdown', () => {
  it('shows minutes and seconds left, rounded up', () => {
    expect(countdown(NOW + 10 * MINUTE, NOW)).toBe('Expires in 10:00');
    expect(countdown(NOW + 10 * MINUTE, NOW + 1)).toBe('Expires in 10:00');
    expect(countdown(NOW + 10 * MINUTE, NOW + 1_000)).toBe('Expires in 9:59');
    expect(countdown(NOW + 65_000, NOW)).toBe('Expires in 1:05');
  });

  it('counts an invite down in days and hours, rounded up to the hour', () => {
    expect(countdown(NOW + 3 * DAY, NOW)).toBe('Expires in 3 days');
    expect(countdown(NOW + 3 * DAY, NOW + 1_000)).toBe('Expires in 3 days');
    expect(countdown(NOW + 3 * DAY, NOW + HOUR)).toBe('Expires in 2 days 23 hours');
    expect(countdown(NOW + DAY + HOUR, NOW)).toBe('Expires in 1 day 1 hour');
    expect(countdown(NOW + 5 * HOUR, NOW)).toBe('Expires in 5 hours');
    expect(countdown(NOW + HOUR, NOW)).toBe('Expires in 60:00');
  });

  it('says Expired once the time is up', () => {
    expect(countdown(NOW, NOW)).toBe('Expired');
    expect(countdown(NOW, NOW + 5_000)).toBe('Expired');
  });
});

describe('while a code is shown', () => {
  it('polls until the code expires, or 10 minutes after minting for an invite', () => {
    expect(codePollEnd(NOW + 10 * MINUTE, NOW)).toBe(NOW + 10 * MINUTE);
    expect(codePollEnd(NOW + 3 * DAY, NOW)).toBe(NOW + 10 * MINUTE);
    expect(codePollEnd(NOW + 5 * MINUTE, NOW)).toBe(NOW + 5 * MINUTE);
  });

  it('knows the code is gone once the NAS no longer lists it', () => {
    const codes = [{ id: 'c1', personId: 'p1', personName: 'Mika', invite: true, expiresAt: NOW + DAY }];
    expect(codeListed(codes, { personId: 'p1', expiresAt: NOW + DAY })).toBe(true);
    expect(codeListed(codes, { personId: 'p1', expiresAt: NOW + 2 * DAY })).toBe(false);
    expect(codeListed([], { personId: 'p1', expiresAt: NOW + DAY })).toBe(false);
  });

  it('redraws the countdown once a minute while over an hour is left', () => {
    expect(countdownTickMs(NOW + 3 * DAY, NOW)).toBe(MINUTE);
    expect(countdownTickMs(NOW + HOUR + 1, NOW)).toBe(MINUTE);
    expect(countdownTickMs(NOW + HOUR, NOW)).toBe(1_000);
  });
});

describe('newCode', () => {
  it('mints a code for the person picked', async () => {
    const api = fakeApi();
    await newCode(api, 'p1', '', false, false);
    expect(api.createCode).toHaveBeenCalledExactlyOnceWith({ personId: 'p1' }, false);
  });

  it('mints an invite for a new person, an owner when the box is ticked', async () => {
    const api = fakeApi();
    expect(await newCode(api, 'new', ' Mika ', true, true)).toMatchObject({ personName: 'Mika', invite: true });
    expect(api.createCode).toHaveBeenCalledExactlyOnceWith({ newPerson: { name: 'Mika', owner: true } }, true);
  });

  it("refuses a new person without a name, and doesn't ask the NAS", async () => {
    const api = fakeApi();
    await expect(newCode(api, 'new', ' ', false, false)).rejects.toThrow('Give the new person a name.');
    expect(api.createCode).not.toHaveBeenCalled();
  });
});

describe('matchingStatus', () => {
  const status = { running: false, groupsDone: 0, groupsTotal: 0, filed: 12, unsorted: 3, music: 1, lastRunAt: null, tmdb: true, gate: 'owners' } as const;
  it('says how far a run is, or when the last one ended, with the counts', () => {
    expect(matchingStatus({ ...status, running: true, groupsDone: 40, groupsTotal: 120 }, NOW)).toEqual({ progress: 'Matching… 40 of 120 folders', counts: '12 discs filed · 3 unsorted · 1 music', tmdb: null });
    expect(matchingStatus(status, NOW).progress).toBe('Not matched yet');
    expect(matchingStatus({ ...status, lastRunAt: NOW - 3 * MINUTE, filed: 1, unsorted: 0, music: 0 }, NOW)).toEqual({ progress: 'Last matched 3 minutes ago', counts: '1 disc filed · 0 unsorted · 0 music', tmdb: null });
  });
  it('says what matching does without a TMDB key', () => {
    expect(matchingStatus({ ...status, tmdb: false }, NOW).tmdb).toBe('No TMDB key: discs that aren’t anime go to Unsorted.');
  });
});

describe('TMDB_ATTRIBUTION', () => {
  it('is TMDB’s notice, verbatim', () => {
    expect(TMDB_ATTRIBUTION).toBe('This product uses the TMDB API but is not endorsed or certified by TMDB');
  });
});

describe('the gate switch', () => {
  const status = { running: false, groupsDone: 0, groupsTotal: 0, filed: 0, unsorted: 0, music: 0, lastRunAt: null, tmdb: true, gate: 'owners' } as const;
  it("shows the NAS's gate: on for everyone, off for owners or before the status loads", () => {
    expect(gateSwitchOn({ ...status, gate: 'everyone' }, false)).toBe(true);
    expect(gateSwitchOn(status, false)).toBe(false);
    expect(gateSwitchOn(null, false)).toBe(false);
  });
  it('shows on while turning it on waits for confirmation', () => {
    expect(gateSwitchOn(status, true)).toBe(true);
  });
  it('follows a successful PUT', () => {
    expect(gateSwitchOn(withGate(status, 'everyone'), false)).toBe(true);
    expect(gateSwitchOn(withGate({ ...status, gate: 'everyone' }, 'owners'), false)).toBe(false);
    expect(withGate(null, 'everyone')).toBeNull();
  });
});

describe('own titles in NAS settings', () => {
  const title = (id: string, kind: TitleSummary['kind'], display: string, own: boolean, seasons = 0): TitleSummary => ({
    id, kind, names: { english: own ? null : display, romaji: null, native: null, synonyms: [], display: own ? display : null },
    poster: null, year: null, seasons, discs: 0, addedAt: 0, own,
  });
  it('lists only own titles, A–Z', () => {
    const list = [title('own:b', 'music', 'live 2024', true), title('anilist:1', 'series', 'Aardvark', false), title('own:a', 'series', 'Harbor Tales', true, 2)];
    expect(ownTitles(list).map((t) => t.id)).toEqual(['own:a', 'own:b']);
  });
  it('names the kind, with a series’ seasons', () => {
    expect(ownTitleKind(title('own:a', 'series', 'Harbor Tales', true, 2))).toBe('Series · 2 seasons');
    expect(ownTitleKind(title('own:a', 'series', 'Harbor Tales', true, 1))).toBe('Series · 1 season');
    expect(ownTitleKind(title('own:b', 'movie', 'Night Film', true))).toBe('Movie');
    expect(ownTitleKind(title('own:c', 'music', 'Live 2024', true))).toBe('Music');
  });
  it('asks before deleting', () => {
    expect(deleteTitleQuestion('Live 2024')).toBe('Delete Live 2024? Its discs go back to Unsorted.');
  });
});

describe('encodingLine', () => {
  it('names who watches what, at which level, and the GPU share', () => {
    expect(encodingLine({ personName: 'Mika', deviceName: 'Phone', discName: 'Starfall Wanderer Vol 1', level: 'phone-720', label: 'Phone', gpuPercent: 16 })).toBe(
      'Mika · Phone — Starfall Wanderer Vol 1, Phone (16% of the GPU)',
    );
  });
});

describe('encodingStatus', () => {
  it('says loading, a failed first load, nothing, or nothing to say over the rows', () => {
    expect(encodingStatus({ list: null, failed: false })).toBe('Loading…');
    expect(encodingStatus({ list: null, failed: true })).toBe("Couldn't load what's encoding.");
    expect(encodingStatus({ list: [], failed: false })).toBe('Nothing is being re-encoded.');
    const row = { personName: 'Mika', deviceName: 'Phone', discName: 'Starfall Wanderer Vol 1', level: 'phone-720' as const, label: 'Phone', gpuPercent: 16 };
    expect(encodingStatus({ list: [row], failed: false })).toBeNull();
    // a later failed refresh keeps the last list
    expect(encodingStatus({ list: [row], failed: true })).toBeNull();
  });
});
