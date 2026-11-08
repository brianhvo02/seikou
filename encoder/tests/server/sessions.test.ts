// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SubtitleRecord } from '../../src/subs/record';
import { fx } from '../paths';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

interface EpisodesBody {
  episodes: { index: number }[];
}

interface RecordBody {
  record: SubtitleRecord | null;
}

describe('helper sessions', () => {
  let fixture: RouteFixture;
  let other: string;
  beforeAll(async () => {
    fixture = await startRouteFixture({}, null, '1-3,4-5', true);
    const reply = await fixture.send('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ discKey: fixture.discKey, playlistId: '00000', episodeSpec: '1-5' }),
    });
    expect(reply.status).toBe(200);
    other = jsonOf<{ id: string }>(reply).id;
  });
  afterAll(() => fixture.stop());

  const record = (episodeSpec: string): SubtitleRecord => ({
    disc: { key: fixture.discKey, label: 'Lantern Harbor' },
    playlist: '00000',
    episodeSpec,
    anilist: null,
    releases: [],
    fonts: [],
    episodes: [{ index: 1, title: 'One', tracks: [], metadata: { title: 'One', video: { name: 'v', language: 'jpn' }, audio: [], chapters: [] } }],
    savedAt: '',
  });

  it('two sessions keep their own episodes and records', async () => {
    expect(other).toMatch(/^[0-9a-f]{16}$/);
    expect(other).not.toBe(fixture.sessionId);
    const mine = jsonOf<EpisodesBody>(await fixture.call('/episodes'));
    const theirs = jsonOf<EpisodesBody>(await fixture.send(`/api/sessions/${other}/episodes`));
    expect(mine.episodes.map((e) => e.index)).toEqual([1, 2]);
    expect(theirs.episodes.map((e) => e.index)).toEqual([1]);

    const info = jsonOf<{ episodeSpec: string }>(await fixture.send(`/api/sessions/${other}`));
    expect(info.episodeSpec).toBe('1-5');

    const saved = await fixture.call('/record', { method: 'PUT', body: JSON.stringify(record('1-3,4-5')) });
    expect(saved.status).toBe(200);
    expect(jsonOf<RecordBody>(await fixture.call('/record')).record?.episodeSpec).toBe('1-3,4-5');
    // the other session's episode list differs: the record is not its own, and it cannot save the first one's
    expect(jsonOf<RecordBody>(await fixture.send(`/api/sessions/${other}/record`)).record).toBeNull();
    const refused = await fixture.send(`/api/sessions/${other}/record`, { method: 'PUT', body: JSON.stringify(record('1-3,4-5')) });
    expect(refused.status).toBe(409);
  });

  it("a session does not replace another episode list's record unless asked to", async () => {
    const inOther = (init?: Parameters<RouteFixture['send']>[1]) => fixture.send(`/api/sessions/${other}/record`, init);
    expect((await fixture.call('/record', { method: 'PUT', body: JSON.stringify(record('1-3,4-5')) })).status).toBe(200);

    const refused = await inOther({ method: 'PUT', body: JSON.stringify(record('1-5')) });
    expect(refused.status).toBe(409);
    expect(jsonOf<{ error: string; episodeSpec: string }>(refused)).toMatchObject({ error: 'other-episode-spec', episodeSpec: '1-3,4-5' });
    // the first session's record is intact
    expect(jsonOf<RecordBody>(await fixture.call('/record')).record?.episodeSpec).toBe('1-3,4-5');
    expect(jsonOf<{ otherEpisodeSpec?: string }>(await inOther()).otherEpisodeSpec).toBe('1-3,4-5');

    const replaced = await fixture.send(`/api/sessions/${other}/record?replace=1`, { method: 'PUT', body: JSON.stringify(record('1-5')) });
    expect(replaced.status).toBe(200);
    expect(jsonOf<RecordBody>(await inOther()).record?.episodeSpec).toBe('1-5');
    const first = jsonOf<RecordBody & { otherEpisodeSpec?: string }>(await fixture.call('/record'));
    expect(first.record).toBeNull();
    expect(first.otherEpisodeSpec).toBe('1-5');
  });

  it('the same triple returns the same session', async () => {
    const again = await fixture.send('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ discKey: fixture.discKey, playlistId: '00000', episodeSpec: '1-5' }),
    });
    expect(jsonOf<{ id: string }>(again).id).toBe(other);
    const first = await fixture.server.sessions.create({ discDir: fx('fixtures/disc-speech'), playlistId: '00000', episodeSpec: '1-3,4-5' });
    expect(first.id).toBe(fixture.sessionId);
  });

  it('refuses a bad episode list, an unknown playlist and an unknown disc', async () => {
    const post = (body: unknown) => fixture.send('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
    const badSpec = await post({ discKey: fixture.discKey, playlistId: '00000', episodeSpec: '3-1' });
    expect(badSpec.status).toBe(400);
    expect(jsonOf<{ error: string }>(badSpec).error).toBe('bad-episode-spec');
    expect((await post({ discKey: fixture.discKey, playlistId: '00009', episodeSpec: '1-' })).status).toBe(404);
    expect((await post({ discKey: fixture.discKey, playlistId: '../00000', episodeSpec: '1-' })).status).toBe(400);
    expect((await post({ discKey: `f.${'0'.repeat(32)}`, playlistId: '00000', episodeSpec: '1-' })).status).toBe(404);
    expect((await post({ discKey: fixture.discKey })).status).toBe(400);
  });

  it('an unknown session answers 404 no-session', async () => {
    for (const path of ['/api/sessions/0123456789abcdef', '/api/sessions/0123456789abcdef/episodes', '/api/sessions/nope/record']) {
      const reply = await fixture.send(path);
      expect(reply.status, path).toBe(404);
      expect(jsonOf<{ error: string }>(reply).error).toBe('no-session');
    }
  });

  it('a page path returns index.html', async () => {
    for (const path of ['/helper/0123456789abcdef', '/queue', '/disc/f.0123abcd', '/disc/f.0123abcd/00000']) {
      const page = await fixture.send(path, { headers: { authorization: '' } });
      expect(page.status, path).toBe(200);
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.body.toString()).toContain('<title>helper</title>');
    }
    // a missing asset is still a 404, and the page fallback does not reach the API
    expect((await fixture.send('/assets/missing.js')).status).toBe(404);
    expect((await fixture.send('/api/nothing')).status).toBe(404);
  });
});
