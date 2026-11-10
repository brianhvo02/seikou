// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkNasDestination, NasDestinationError, uploadNameOf } from '../../src/nas/destination';
import { EpisodeInfoStore } from '../../src/plan/episode-info';

const KEY = `f.${'AB'.repeat(16)}`;
let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'destination-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const check = (): Promise<unknown> => checkNasDestination({ dataDir, client: null, discKey: KEY, playlistId: '00000', episodeSpec: '1-3,4-6', chapters: 6 });
const tv = (episode: number) => ({ title: { source: 'tmdb-tv', tmdbId: 990101, season: 1 } as const, episode, name: null });

it('names an upload by the encode id', () => {
  expect(uploadNameOf(tv(2))).toBe('tv990101s1-2.mkv');
  expect(uploadNameOf({ title: { source: 'anilist', anilistId: 990001 }, episode: 2, name: null })).toBe('990001-2.mkv');
});

it('refuses an episode with no title as nas-needs-title', async () => {
  await new EpisodeInfoStore(dataDir).save(KEY, '00000', { chapterNames: {}, titles: { '1': tv(1) } });
  const e = (await check().catch((x: unknown) => x)) as NasDestinationError;
  expect([e.code, e.episodes]).toEqual(['nas-needs-title', [2]]);
});

it('refuses two episodes with the same encode id as nas-duplicate-episodes', async () => {
  await new EpisodeInfoStore(dataDir).save(KEY, '00000', { chapterNames: {}, titles: { '1': tv(1), '4': tv(1) } });
  const e = (await check().catch((x: unknown) => x)) as NasDestinationError;
  expect([e.code, e.episodes]).toEqual(['nas-duplicate-episodes', [1, 2]]);
});

it('does not take an AniList episode and a TMDB episode of the same number for duplicates', async () => {
  await new EpisodeInfoStore(dataDir).save(KEY, '00000', { chapterNames: {}, titles: { '1': tv(1), '4': { title: { source: 'anilist', anilistId: 990101 }, episode: 1, name: null } } });
  const e = (await check().catch((x: unknown) => x)) as NasDestinationError;
  expect(e.code).toBe('nas-not-paired');
});
