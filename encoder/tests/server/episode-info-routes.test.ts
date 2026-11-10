// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EpisodeInfo } from '../../src/plan/episode-info';
import { RecordStore, type SubtitleRecord } from '../../src/subs/record';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

describe('episode info routes', () => {
  let fixture: RouteFixture;
  beforeAll(async () => {
    fixture = await startRouteFixture();
  });
  afterAll(() => fixture.stop());

  const path = (key = fixture.discKey, playlist = '00000'): string => `/api/discs/${encodeURIComponent(key)}/playlists/${playlist}/info`;
  const put = (body: unknown, key?: string, playlist?: string) =>
    fixture.send(path(key, playlist), { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('answers null before anything is saved', async () => {
    const reply = await fixture.send(path());
    expect(reply.status).toBe(200);
    expect(jsonOf<{ info: EpisodeInfo | null }>(reply)).toEqual({ info: null });
  });

  it('put then get round-trips', async () => {
    const body = { chapterNames: { '1': 'Avant', '2': 'Opening' }, titles: { '1': { title: { source: 'anilist', anilistId: 990001 }, episode: 1, name: 'Starfall' } } };
    const reply = await put(body);
    expect(reply.status).toBe(200);
    const { info } = jsonOf<{ info: EpisodeInfo }>(reply);
    expect(info).toMatchObject(body);
    expect(typeof info.savedAt).toBe('string');
    expect(jsonOf<{ info: EpisodeInfo | null }>(await fixture.send(path()))).toEqual({ info });
  });

  it('a bad name answers 400 bad-info', async () => {
    const reply = await put({ chapterNames: { '1': '' }, titles: {} });
    expect(reply.status).toBe(400);
    const body = jsonOf<{ error: string; message: string }>(reply);
    expect(body.error).toBe('bad-info');
    expect(body.message).toMatch(/chapterNames\.1/);
    expect(jsonOf<{ error: string }>(await put('not json')).error).toBe('bad-info');
  });

  it('an unknown disc key answers 404 disc-changed', async () => {
    const key = `f.${'0'.repeat(32)}`;
    const reply = await fixture.send(path(key));
    expect(reply.status).toBe(404);
    expect(jsonOf<{ error: string }>(reply).error).toBe('disc-changed');
    expect((await put({ chapterNames: {}, titles: {} }, key)).status).toBe(404);
  });

  it('a playlist id that is not five digits answers 400 bad-request', async () => {
    const reply = await fixture.send(path(undefined, '0000'));
    expect(reply.status).toBe(400);
    expect(jsonOf<{ error: string }>(reply).error).toBe('bad-request');
  });

  it('reading the info first moves an older record\'s chapter names into it, once', async () => {
    rmSync(join(fixture.dataDir, 'chapters', fixture.discKey, '00000.json'), { force: true });
    const metadata = (chapters: string[]) => ({ title: '', video: { name: '', language: 'jpn' }, audio: [], chapters });
    const old: SubtitleRecord = {
      disc: { key: fixture.discKey, label: 'Starfall Wanderer' },
      playlist: '00000',
      episodeSpec: '1-3,4-5',
      anilist: null,
      releases: [],
      fonts: [],
      episodes: [
        { index: 1, title: 'One', tracks: [], metadata: metadata(['Avant', 'Opening', 'Chapter 3']) },
        { index: 2, title: 'Two', tracks: [], metadata: metadata(['', 'Preview']) },
      ],
      savedAt: '2026-11-01T00:00:00.000Z',
    };
    // as an older encoder wrote it, before the page asked for the record
    await new RecordStore(fixture.dataDir).write(old);
    const { info } = jsonOf<{ info: EpisodeInfo | null }>(await fixture.send(path()));
    expect(info?.chapterNames).toEqual({ '1': 'Avant', '2': 'Opening', '5': 'Preview' });
    const recordFile = join(fixture.dataDir, 'subtitles', fixture.discKey, '00000.json');
    expect((JSON.parse(readFileSync(recordFile, 'utf8')) as SubtitleRecord).episodes.map((e) => e.metadata.chapters)).toEqual([[], []]);
    // the next read finds nothing more to move
    expect(jsonOf<{ info: EpisodeInfo | null }>(await fixture.send(path())).info).toEqual(info);
  });

  it('a body over 64 KiB answers 413', async () => {
    const reply = await put({ chapterNames: { '1': 'x'.repeat(70 * 1024) }, titles: {} });
    expect(reply.status).toBe(413);
    expect(jsonOf<{ error: string }>(reply).error).toBe('too-large');
  });
});
