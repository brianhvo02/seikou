// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EpisodeInfo } from '../../src/plan/episode-info';
import { DEFAULT_SETTINGS } from '../../src/server/profiles';
import { RecordStore, type SubtitleRecord } from '../../src/subs/record';
import { fx } from '../paths';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

interface GetAnswer {
  record: SubtitleRecord | null;
  missing: { id: string | null; release: string; files: string[] }[];
  error?: { code: string; message: string };
}

describe('record routes', () => {
  let fixture: RouteFixture;
  let discKey: string;
  beforeAll(async () => {
    fixture = await startRouteFixture();
    discKey = jsonOf<{ discKey: string }>(await fixture.call('')).discKey;
  });
  afterAll(() => fixture.stop());

  const record = (over: Partial<SubtitleRecord> = {}): SubtitleRecord => ({
    disc: { key: discKey, label: 'Lantern Harbor' },
    playlist: '00000',
    episodeSpec: '1-3,4-5',
    anilist: null,
    releases: [{ source: 'tosho', id: 'tosho-7001', group: 'GroupA', label: 'GroupA release' }],
    fonts: ['fonts/a.ttf'],
    episodes: [
      {
        index: 1,
        title: 'One',
        tracks: [{ release: 'tosho-7001', file: 'tracks/one.ass', kind: 'full', language: 'eng', name: 'English', shiftMs: 0, nudgeMs: 0, split: null, included: true }],
        metadata: { title: 'One', video: { name: 'v', language: 'jpn' }, audio: [], chapters: [] },
      },
    ],
    savedAt: '',
    ...over,
  });
  const put = (body: unknown): ReturnType<RouteFixture['send']> =>
    fixture.call('/record', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const recordFile = (): string => join(fixture.dataDir, 'subtitles', discKey, '00000.json');

  it('no record yet answers null', async () => {
    const reply = await fixture.call('/record');
    expect(reply.status).toBe(200);
    expect(jsonOf<GetAnswer>(reply)).toEqual({ record: null, missing: [] });
  });

  it('put then get round-trips and sets savedAt', async () => {
    const before = Date.now();
    const reply = await put(record({ savedAt: 'ignored' }));
    expect(reply.status).toBe(200);
    const stored = jsonOf<SubtitleRecord>(reply);
    expect(Date.parse(stored.savedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.episodes[0]!.title).toBe('One');
    const got = jsonOf<GetAnswer>(await fixture.call('/record'));
    expect(got.record).toEqual(stored);
  });

  it('put for another playlist answers 409', async () => {
    const reply = await put(record({ playlist: '00001' }));
    expect(reply.status).toBe(409);
    expect(jsonOf<{ error: string }>(reply).error).toBe('session-mismatch');
    expect((await put(record({ episodeSpec: '1' }))).status).toBe(409);
  });

  it('put with a bad language answers 400 naming the field', async () => {
    const bad = record();
    bad.episodes[0]!.tracks[0]!.language = 'EN';
    const reply = await put(bad);
    expect(reply.status).toBe(400);
    const body = jsonOf<{ error: string; message: string; path: string }>(reply);
    expect(body.error).toBe('bad-record');
    expect(body.path).toBe('episodes[0].tracks[0].language');
    expect((await put('not json')).status).toBe(400);
  });

  it('a body over 2 MB answers 413', async () => {
    const reply = await put(record({ episodeSpec: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    expect(reply.status).toBe(413);
    expect(reply.headers.connection).toBe('close');
  });

  it('reports missing cache files by release', async () => {
    for (const f of ['fonts/a.ttf', 'tracks/one.ass']) {
      mkdirSync(dirname(join(fixture.dataDir, f)), { recursive: true });
      writeFileSync(join(fixture.dataDir, f), 'x');
    }
    expect((await put(record())).status).toBe(200);
    expect(jsonOf<GetAnswer>(await fixture.call('/record')).missing).toEqual([]);
    rmSync(join(fixture.dataDir, 'tracks/one.ass'));
    const got = jsonOf<GetAnswer>(await fixture.call('/record'));
    expect(got.missing).toEqual([{ id: 'tosho-7001', release: 'GroupA release', files: ['tracks/one.ass'] }]);
  });

  it('round-trips a two-release record', async () => {
    const two = record();
    two.releases.push({ source: 'local', id: 'local-0123456789abcdef', group: '', label: 'own files' });
    const t = two.episodes[0]!.tracks[0]!;
    two.episodes.push({ ...two.episodes[0]!, index: 2, tracks: [{ ...t, release: 'local-0123456789abcdef', file: 'tracks/two.ass' }] });
    const stored = jsonOf<SubtitleRecord>(await put(two));
    expect(stored.releases.map((r) => r.id)).toEqual(['tosho-7001', 'local-0123456789abcdef']);
    expect(stored.episodes.map((e) => e.tracks[0]!.release)).toEqual(['tosho-7001', 'local-0123456789abcdef']);
    expect(jsonOf<GetAnswer>(await fixture.call('/record')).record).toEqual(stored);
  });

  it('an unreadable record file answers null with an error, and saving overwrites it', async () => {
    writeFileSync(recordFile(), '{ broken');
    const got = jsonOf<GetAnswer>(await fixture.call('/record'));
    expect(got.record).toBeNull();
    expect(got.missing).toEqual([]);
    expect(got.error?.code).toBe('record-unreadable');
    expect((await put(record())).status).toBe(200);
    expect(jsonOf<GetAnswer>(await fixture.call('/record')).record).not.toBeNull();
  });

  it('an equivalent episode list reads, saves and shares a session', async () => {
    const written = await put(record({ episodeSpec: '1-3,4-5' }));
    expect(written.status).toBe(200);
    const open = await fixture.server.sessions.create({ discDir: fx('fixtures/disc-speech'), playlistId: '00000', episodeSpec: '1-3, 4-' });
    expect(open.id).toBe(fixture.sessionId);
    const other = await fixture.server.sessions.create({ discDir: fx('fixtures/disc-speech'), playlistId: '00000', episodeSpec: '1-3,4-' });
    expect(other.id).toBe(fixture.sessionId);
    // the record as written is kept, and it loads for the open-ended spelling
    const via = (sub: string, init?: Parameters<RouteFixture['send']>[1]) => fixture.send(`/api/sessions/${other.id}${sub}`, init);
    const got = jsonOf<GetAnswer>(await via('/record'));
    expect(got.record?.episodeSpec).toBe('1-3,4-5');
    const saved = await fixture.call('/record', { method: 'PUT', body: JSON.stringify(record({ episodeSpec: '1-3,4-' })) });
    expect(saved.status).toBe(200);
  });

  it('saving a record with chapter names stores none', async () => {
    const named = record();
    named.episodes[0]!.metadata.chapters = ['Avant', 'Opening', 'Part A'];
    const stored = jsonOf<SubtitleRecord>(await put(named));
    expect(stored.episodes[0]!.metadata.chapters).toEqual([]);
    const onDisk = JSON.parse(readFileSync(recordFile(), 'utf8')) as SubtitleRecord;
    expect(onDisk.episodes[0]!.metadata.chapters).toEqual([]);
  });

  it('loading an old record with chapter names moves them into the episode info once', async () => {
    const infoFile = join(fixture.dataDir, 'chapters', discKey, '00000.json');
    rmSync(infoFile, { force: true });
    const old = record({ savedAt: '2026-11-01T00:00:00.000Z' });
    old.episodes.push({ ...old.episodes[0]!, index: 2, tracks: [], metadata: { ...old.episodes[0]!.metadata, chapters: ['Opening', 'Chapter 2'] } });
    old.episodes[0]!.metadata.chapters = ['Chapter 1', '', 'Ending'];
    // as an older encoder wrote it, with the names in the record
    await new RecordStore(fixture.dataDir).write(old);
    const infoPath = `/api/discs/${encodeURIComponent(discKey)}/playlists/00000/info`;

    const answered = jsonOf<GetAnswer>(await fixture.call('/record'));
    const first = jsonOf<{ info: EpisodeInfo | null }>(await fixture.send(infoPath)).info;
    expect(first?.chapterNames).toEqual({ '3': 'Ending', '4': 'Opening' });
    // the record is saved again without its names, keeping when it was saved, and answered that way
    expect(answered.record?.episodes.map((e) => e.metadata.chapters)).toEqual([[], []]);
    const onDisk = JSON.parse(readFileSync(recordFile(), 'utf8')) as SubtitleRecord;
    expect(onDisk.episodes.map((e) => e.metadata.chapters)).toEqual([[], []]);
    expect(onDisk.savedAt).toBe('2026-11-01T00:00:00.000Z');

    // a name removed since stays removed when the record and the info are loaded again, and nothing is saved again
    const changed = await fixture.send(infoPath, { method: 'PUT', body: JSON.stringify({ chapterNames: { '3': 'Ending' }, titles: {} }) });
    const savedAt = jsonOf<{ info: EpisodeInfo }>(changed).info.savedAt;
    expect((await fixture.call('/record')).status).toBe(200);
    const second = jsonOf<{ info: EpisodeInfo }>(await fixture.send(infoPath)).info;
    expect(second).toEqual({ chapterNames: { '3': 'Ending' }, titles: {}, savedAt });
  });
});

describe('record routes and queued encodes', () => {
  let fixture: RouteFixture;
  let discKey: string;
  beforeAll(async () => {
    fixture = await startRouteFixture();
    discKey = fixture.discKey;
  });
  afterAll(() => fixture.stop());

  /** A stored encode job of the speech disc's playlist 00000. */
  const job = (id: string, state: string, episodeSpec: string, noSubtitles = false): Record<string, unknown> => ({
    id,
    kind: 'encode',
    disc: { key: discKey, label: 'disc-speech', dir: fx('fixtures/disc-speech') },
    playlist: '00000',
    episodeSpec,
    settings: DEFAULT_SETTINGS,
    outDir: join(fixture.dataDir, 'output', id),
    noSubtitles,
    state,
    paused: false,
    createdAt: '2026-11-08T10:00:00.000Z',
    episodes: [],
    recordSavedAt: null,
    cli: '',
  });

  it('a save that replaces choices a queued or interrupted encode uses says how many there are', async () => {
    const record: SubtitleRecord = {
      disc: { key: discKey, label: 'Lantern Harbor' },
      playlist: '00000',
      episodeSpec: '1-3,4-5',
      anilist: null,
      releases: [],
      fonts: [],
      episodes: [1, 2].map((index) => ({ index, title: `Part ${index}`, tracks: [], metadata: { title: `Part ${index}`, video: { name: '', language: 'jpn' }, audio: [], chapters: [] } })),
      savedAt: '',
    };
    expect((await fixture.call('/record', { method: 'PUT', body: JSON.stringify(record) })).status).toBe(200);
    writeFileSync(
      join(fixture.dataDir, 'jobs.json'),
      JSON.stringify({
        jobs: [
          job('0000000000000001', 'queued', '1-3,4-'),
          job('0000000000000002', 'interrupted', '1-3,4-5'),
          // These do not count: finished, without subtitles, or another episode list.
          job('0000000000000003', 'done', '1-3,4-5'),
          job('0000000000000004', 'queued', '1-3,4-5', true),
          job('0000000000000005', 'queued', '1-5'),
        ],
      }),
    );
    const other = await fixture.server.sessions.create({ discDir: fx('fixtures/disc-speech'), playlistId: '00000', episodeSpec: '1-2,3-5' });
    const got = jsonOf<{ otherEpisodeSpec?: string; queuedJobs?: number }>(await fixture.send(`/api/sessions/${other.id}/record`));
    expect(got).toMatchObject({ otherEpisodeSpec: '1-3,4-5', queuedJobs: 2 });
    const refused = await fixture.send(`/api/sessions/${other.id}/record`, { method: 'PUT', body: JSON.stringify({ ...record, episodeSpec: '1-2,3-5' }) });
    expect(refused.status).toBe(409);
    expect(jsonOf(refused)).toMatchObject({ error: 'other-episode-spec', episodeSpec: '1-3,4-5', queuedJobs: 2 });
    // The session whose list the record is for has nothing to replace, so it says nothing.
    expect(jsonOf<{ queuedJobs?: number }>(await fixture.call('/record')).queuedJobs).toBeUndefined();
  });
});
