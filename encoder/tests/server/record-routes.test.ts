// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SubtitleRecord } from '../../src/subs/record';
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
    discKey = jsonOf<{ discKey: string }>(await fixture.send('/api/session')).discKey;
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
    fixture.send('/api/record', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const recordFile = (): string => join(fixture.dataDir, 'subtitles', discKey, '00000.json');

  it('no record yet answers null', async () => {
    const reply = await fixture.send('/api/record');
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
    const got = jsonOf<GetAnswer>(await fixture.send('/api/record'));
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
    expect(jsonOf<GetAnswer>(await fixture.send('/api/record')).missing).toEqual([]);
    rmSync(join(fixture.dataDir, 'tracks/one.ass'));
    const got = jsonOf<GetAnswer>(await fixture.send('/api/record'));
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
    expect(jsonOf<GetAnswer>(await fixture.send('/api/record')).record).toEqual(stored);
  });

  it('an unreadable record file answers null with an error, and saving overwrites it', async () => {
    writeFileSync(recordFile(), '{ broken');
    const got = jsonOf<GetAnswer>(await fixture.send('/api/record'));
    expect(got.record).toBeNull();
    expect(got.missing).toEqual([]);
    expect(got.error?.code).toBe('record-unreadable');
    expect((await put(record())).status).toBe(200);
    expect(jsonOf<GetAnswer>(await fixture.send('/api/record')).record).not.toBeNull();
  });
});
