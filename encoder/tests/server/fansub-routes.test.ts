// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimited } from '@seikou/titles/pacer';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

interface Row {
  group: string;
  toshoId: number | null;
  unavailable: string | null;
}
interface ReleaseAnswer {
  key: string;
  source: string;
  fonts: { name: string }[];
  match: { rows: { episode: number; fileId: string | null }[]; unmatched: unknown[] };
}

const BATCH = '0123456789abcdef';
let fixture: RouteFixture;
beforeAll(async () => {
  fixture = await startRouteFixture();
});
afterAll(() => fixture.stop());

describe('fansub routes', () => {
  it('seadex route marks unfetchable releases', async () => {
    const reply = await fixture.send('/api/fansubs/seadex?anilist=900101');
    expect(reply.status).toBe(200);
    const answer = jsonOf<{ notes: string; comparison: string; url: string; releases: Row[] }>(reply);
    expect(answer.notes).toBe('GroupA for video and full subs; GroupB has the better signs.');
    expect(answer.url).toBe('https://releases.moe/900101/');
    expect(answer.releases.map((r) => r.group)).toEqual(['GroupA', 'GroupB', 'GroupC']);
    expect(answer.releases[0]).toMatchObject({ toshoId: 7001, unavailable: null });
    expect(answer.releases[1]).toMatchObject({ toshoId: 7002, unavailable: null });
    expect(answer.releases[2]).toMatchObject({ toshoId: null, unavailable: 'private-tracker' });
  });

  it('rejects a bad anilist id', async () => {
    expect((await fixture.send('/api/fansubs/seadex?anilist=abc')).status).toBe(400);
  });

  it('searches Anime Tosho', async () => {
    const reply = await fixture.send('/api/fansubs/search?q=GroupA');
    expect(jsonOf<unknown>(reply)).toEqual([{ toshoId: 7001, title: '[GroupA] Lantern Harbor (BD 1080p)', date: 1700000000 }]);
    expect((await fixture.send('/api/fansubs/search?q=')).status).toBe(400);
  });

  it('fetch returns the release with matches', async () => {
    const reply = await fixture.send('/api/fansubs/fetch', { method: 'POST', body: JSON.stringify({ toshoId: 7001 }) });
    expect(reply.status).toBe(200);
    const release = jsonOf<ReleaseAnswer>(reply);
    expect(release).toMatchObject({ key: 'tosho-7001', source: 'tosho' });
    expect(release.match.rows).toMatchObject([
      { episode: 1, fileId: '7101' },
      { episode: 2, fileId: '7102' },
    ]);
    const again = await fixture.send('/api/releases/tosho-7001');
    expect(jsonOf<ReleaseAnswer>(again).match.rows[0]!.fileId).toBe('7101');
    // an offset of 1 maps episode 1 to the file numbered 2
    const shifted = jsonOf<ReleaseAnswer>(await fixture.send('/api/releases/tosho-7001?offset=-1'));
    expect(shifted.match.rows).toMatchObject([{ episode: 1, fileId: null }, { episode: 2, fileId: '7101' }]);
    expect((await fixture.send('/api/releases/tosho-7001?offset=x')).status).toBe(400);
    expect((await fixture.send('/api/releases/tosho-999')).status).toBe(404);
  });

  it('serves a font of a release and answers 404 for another', async () => {
    const release = jsonOf<ReleaseAnswer>(await fixture.send('/api/releases/tosho-7001'));
    expect(release.fonts.length).toBeGreaterThan(0);
    const font = await fixture.send(`/api/releases/tosho-7001/fonts/${encodeURIComponent(release.fonts[0]!.name)}`);
    expect(font.status).toBe(200);
    expect(font.body.length).toBeGreaterThan(0);
    expect((await fixture.send('/api/releases/tosho-7001/fonts/nope.ttf')).status).toBe(404);
  });

  it('an unknown Anime Tosho release answers 404 not-on-tosho', async () => {
    const reply = await fixture.send('/api/fansubs/fetch', { method: 'POST', body: JSON.stringify({ toshoId: 31337 }) });
    expect(reply.status).toBe(404);
    expect(jsonOf<{ error: string }>(reply).error).toBe('not-on-tosho');
    expect((await fixture.send('/api/fansubs/fetch', { method: 'POST', body: '{}' })).status).toBe(400);
  });

  it('upload then commit adds a local release', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
    const put = await fixture.send(`/api/uploads/${BATCH}/${encodeURIComponent('Lantern - 01.srt')}`, { method: 'PUT', body: srt });
    expect(put.status).toBe(200);
    const commit = await fixture.send(`/api/uploads/${BATCH}/commit`, { method: 'POST' });
    expect(commit.status).toBe(200);
    expect(jsonOf<ReleaseAnswer>(commit)).toMatchObject({
      source: 'local',
      match: { rows: [{ episode: 1, fileId: 'f0' }, { episode: 2, fileId: null }] },
    });
    // the batch is gone: committing again finds no subtitle file
    expect((await fixture.send(`/api/uploads/${BATCH}/commit`, { method: 'POST' })).status).toBe(422);
  });

  it('refuses a bad batch or file name', async () => {
    expect((await fixture.send('/api/uploads/xyz/a.srt', { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fixture.send(`/api/uploads/${BATCH}/%2E%2E`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fixture.send(`/api/uploads/${BATCH}/a%5Cb.srt`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fixture.send(`/api/uploads/${BATCH}/a%00b.srt`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fixture.send('/api/uploads/xyz/commit', { method: 'POST' })).status).toBe(400);
  });

  it('an oversized upload answers 413', async () => {
    const reply = await fixture.send(`/api/uploads/${BATCH}/big.ttf`, {
      method: 'PUT',
      body: 'x',
      keepOpen: true,
      headers: { 'content-length': String(60 * 1024 * 1024) },
    });
    expect(reply.status).toBe(413);
    expect(reply.headers['connection']).toBe('close');
  });

  it('a rate-limited source answers 503', async () => {
    const limited = await startRouteFixture({
      seadex: {
        entry: async () => {
          throw new RateLimited(null);
        },
      },
    });
    try {
      const reply = await limited.send('/api/fansubs/seadex?anilist=900101');
      expect(reply.status).toBe(503);
      expect(jsonOf<unknown>(reply)).toEqual({ error: 'source-unavailable', source: 'seadex' });
    } finally {
      await limited.stop();
    }
  });

  it('matches against the episode plan, so an episode list the playlist cannot hold answers as GET /api/episodes does', async () => {
    const bad = await startRouteFixture({}, null, '1-3,4-9');
    try {
      const reply = await bad.send('/api/fansubs/fetch', { method: 'POST', body: JSON.stringify({ toshoId: 7001 }) });
      expect(reply.status).toBe(422);
      expect(jsonOf<{ error: string }>(reply).error).toBe('bad-episode-spec');
      expect((await bad.send('/api/releases/tosho-7001')).status).toBe(422);
    } finally {
      await bad.stop();
    }
  });
});
