// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EpisodeInfoStore, isChecked, type EpisodeInfo } from '../../src/plan/episode-info';
import { evenSpec } from '../../src/server/episode-info-routes';
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

  it("moves an older record's names only once the info's other writers are done, keeping what they saved", async () => {
    rmSync(join(fixture.dataDir, 'chapters', fixture.discKey, '00000.json'), { force: true });
    const metadata = (chapters: string[]) => ({ title: '', video: { name: '', language: 'jpn' }, audio: [], chapters });
    await new RecordStore(fixture.dataDir).write({
      disc: { key: fixture.discKey, label: 'Starfall Wanderer' },
      playlist: '00000',
      episodeSpec: '1-3,4-5',
      anilist: null,
      releases: [],
      fonts: [],
      episodes: [
        { index: 1, title: 'One', tracks: [], metadata: metadata(['Avant', 'Opening', '']) },
        { index: 2, title: 'Two', tracks: [], metadata: metadata(['', 'Preview']) },
      ],
      savedAt: '2026-11-01T00:00:00.000Z',
    });
    const recordFile = join(fixture.dataDir, 'subtitles', fixture.discKey, '00000.json');
    const chaptersOfRecord = (): string[][] => (JSON.parse(readFileSync(recordFile, 'utf8')) as SubtitleRecord).episodes.map((e) => e.metadata.chapters);
    const store = new EpisodeInfoStore(fixture.dataDir);
    let release!: () => void;
    const held = store.locked(fixture.discKey, '00000', async () => {
      await new Promise<void>((r) => (release = r));
      await store.save(fixture.discKey, '00000', { chapterNames: { '1': 'Cold open' }, titles: {} });
    });
    const reading = fixture.send(path());
    await new Promise((r) => setTimeout(r, 150));
    // the migration waits for the lock: the record still holds its names
    expect(chaptersOfRecord()).toEqual([['Avant', 'Opening', ''], ['', 'Preview']]);
    release();
    await held;
    const { info } = jsonOf<{ info: EpisodeInfo | null }>(await reading);
    expect(info?.chapterNames).toEqual({ '1': 'Cold open', '2': 'Opening', '5': 'Preview' });
    expect(chaptersOfRecord()).toEqual([[], []]);
  });

  it('a body over 64 KiB answers 413', async () => {
    const reply = await put({ chapterNames: { '1': 'x'.repeat(70 * 1024) }, titles: {} });
    expect(reply.status).toBe(413);
    expect(jsonOf<{ error: string }>(reply).error).toBe('too-large');
  });

  describe('check and the NAS prefill on a disc of this computer', () => {
    const base = (): string => `/api/discs/${encodeURIComponent(fixture.discKey)}/playlists/00000`;
    const check = (episodeSpec: string) => fixture.send(`${base()}/check`, { method: 'POST', body: JSON.stringify({ episodeSpec }) });
    const title = (n: number) => ({ title: { source: 'anilist', anilistId: 990001 }, episode: n, name: null });

    it('prefill answers nothing for a disc the NAS does not hold', async () => {
      const reply = await fixture.send(`${base()}/nas-prefill`);
      expect(reply.status).toBe(200);
      expect(jsonOf(reply)).toEqual({ episodes: [], title: null, episodeSpec: null });
    });

    it('check refuses with needs-title while an episode has no title, and writes nothing', async () => {
      rmSync(join(fixture.dataDir, 'chapters', fixture.discKey, '00000.json'), { force: true });
      expect(jsonOf<{ error: string }>(await check('1-3,4-5')).error).toBe('needs-title');
      await put({ chapterNames: {}, titles: { '1': title(1) } });
      const reply = await check('1-3,4-5');
      expect([reply.status, jsonOf<{ error: string }>(reply).error]).toEqual([409, 'needs-title']);
      expect(jsonOf<{ info: EpisodeInfo | null }>(await fixture.send(path())).info?.checked).toBeUndefined();
    });

    it('check marks the playlist checked and leaves the NAS alone for a disc it does not hold; regrouping clears it', async () => {
      await put({ chapterNames: {}, titles: { '1': title(1), '4': title(2) } });
      const reply = await check('1-3,4-5');
      expect(reply.status).toBe(200);
      const { info, nasChoice } = jsonOf<{ info: EpisodeInfo; nasChoice: string }>(reply);
      expect(nasChoice).toBe('unchanged');
      expect(isChecked(info, '1-3,4-', 5)).toBe(true);
      expect(isChecked(info, '1-2,3-5', 5)).toBe(false);
      // a chapter name changes nothing; a title does
      const named = jsonOf<{ info: EpisodeInfo }>(await put({ chapterNames: { '1': 'Avant' }, titles: info.titles })).info;
      expect(isChecked(named, '1-3,4-5', 5)).toBe(true);
      const retitled = jsonOf<{ info: EpisodeInfo }>(await put({ chapterNames: {}, titles: { '1': title(1), '4': title(3) } })).info;
      expect(isChecked(retitled, '1-3,4-5', 5)).toBe(false);
    });

    it('a PUT without a mark keeps the saved one, which holds through a name and goes with a title (read from the file)', async () => {
      await put({ chapterNames: {}, titles: { '1': title(1), '4': title(2) } });
      expect((await check('1-3,4-5')).status).toBe(200);
      const file = join(fixture.dataDir, 'chapters', fixture.discKey, '00000.json');
      const mark = (JSON.parse(readFileSync(file, 'utf8')) as EpisodeInfo).checked;
      expect(mark).toBeDefined();
      await put({ chapterNames: { '1': 'Avant' }, titles: { '1': { ...title(1), name: 'Starfall' }, '4': title(2) } });
      const saved = JSON.parse(readFileSync(file, 'utf8')) as EpisodeInfo;
      expect(saved.checked).toEqual(mark);
      expect(isChecked(saved, '1-3,4-5', 5)).toBe(true);
    });

    it('a save and a check fired together both survive', async () => {
      await put({ chapterNames: {}, titles: { '1': title(1), '4': title(2) } });
      const [saved, checked] = await Promise.all([put({ chapterNames: { '2': 'Opening' }, titles: { '1': title(1), '4': title(2) } }), check('1-3,4-5')]);
      expect([saved.status, checked.status]).toEqual([200, 200]);
      const info = JSON.parse(readFileSync(join(fixture.dataDir, 'chapters', fixture.discKey, '00000.json'), 'utf8')) as EpisodeInfo;
      expect(info.chapterNames).toEqual({ '2': 'Opening' });
      expect(isChecked(info, '1-3,4-5', 5)).toBe(true);
    });

    it('check answers 400 for a body that is not an episode list', async () => {
      expect((await check('x')).status).toBe(400);
      expect((await fixture.send(`${base()}/check`, { method: 'POST', body: '{}' })).status).toBe(400);
    });
  });

  it('evenSpec cuts a playlist into equal groups of consecutive chapters, or answers null', () => {
    expect(evenSpec(4, 8)).toBe('1-2,3-4,5-6,7-8');
    expect(evenSpec(4, 7)).toBeNull();
    expect(evenSpec(1, 4)).toBe('1-4');
    expect(evenSpec(0, 4)).toBeNull();
    expect(evenSpec(5, 3)).toBeNull();
  });
});
