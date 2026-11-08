// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, ProfileStore, type Profile } from '../../src/server/profiles';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

let fx: RouteFixture;
beforeEach(async () => {
  fx = await startRouteFixture();
});
afterEach(() => fx.stop());

const put = (id: string, body: unknown) => fx.send(`/api/profiles/${id}`, { method: 'PUT', body: JSON.stringify(body) });
const post = (body: unknown) => fx.send('/api/profiles', { method: 'POST', body: JSON.stringify(body) });
const mine = { name: 'Small files', settings: { ...DEFAULT_SETTINGS, crf: 32, extraSvtArgs: ['--lookahead', '40'], opusBitrate: 96 } };

describe('profiles', () => {
  it("the default profile exists and can't be deleted", async () => {
    const { profiles } = jsonOf<{ profiles: Profile[] }>(await fx.send('/api/profiles'));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: 'default', name: 'Default', builtIn: true, settings: DEFAULT_SETTINGS });
    const del = await fx.send('/api/profiles/default', { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect(jsonOf<{ error: string }>(del).error).toBe('built-in');
    const edit = await put('default', mine);
    expect(edit.status).toBe(400);
    expect(jsonOf<{ error: string }>(edit).error).toBe('built-in');
  });

  it('a profile round-trips', async () => {
    const made = await post(mine);
    expect(made.status).toBe(201);
    const profile = jsonOf<Profile>(made);
    expect(profile.id).toMatch(/^[a-z0-9]+$/);
    expect(profile).toMatchObject({ ...mine, builtIn: false });
    const listed = jsonOf<{ profiles: Profile[] }>(await fx.send('/api/profiles')).profiles;
    expect(listed.map((p) => p.id)).toEqual(['default', profile.id]);
    expect(listed[1]!.settings).toEqual(mine.settings);
    const changed = await put(profile.id, { name: 'Smaller files', settings: { ...mine.settings, crf: 35 } });
    expect(jsonOf<Profile>(changed)).toMatchObject({ name: 'Smaller files', settings: { crf: 35 } });
    expect((await fx.send(`/api/profiles/${profile.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fx.send(`/api/profiles/${profile.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(jsonOf<{ profiles: Profile[] }>(await fx.send('/api/profiles')).profiles).toHaveLength(1);
  });

  it('a bad crf answers 400 naming the field', async () => {
    for (const crf of [64, -1, 25.5, '25', null]) {
      const res = await post({ ...mine, settings: { ...mine.settings, crf } });
      expect(res.status).toBe(400);
      expect(jsonOf(res)).toMatchObject({ error: 'bad-setting', field: 'crf' });
    }
    for (const [field, value] of [['preset', 14], ['filmGrain', 51], ['opusBitrate', 5], ['opusBitrate', 513], ['opusBitrate', 96.5]] as const) {
      const res = await post({ ...mine, settings: { ...mine.settings, [field]: value } });
      expect(jsonOf(res)).toMatchObject({ error: 'bad-setting', field });
    }
  });

  it('a name pattern without {n} is refused', async () => {
    for (const namePattern of ['episode', '  ', '../{n}', 'a/{n}', 'a\\{n}', 'x..{n}']) {
      const res = await post({ ...mine, settings: { ...mine.settings, namePattern } });
      expect(res.status).toBe(400);
      expect(jsonOf(res)).toMatchObject({ error: 'bad-setting', field: 'namePattern' });
    }
    expect((await post({ ...mine, settings: { ...mine.settings, namePattern: ' Show S01E{n} ' } })).status).toBe(201);
  });

  it('refuses name patterns that make bad file names', async () => {
    for (const namePattern of ['.{n}', '{n}.', 'a:{n}', 'a*{n}', 'a?{n}', 'a"{n}', 'a<{n}', 'a>{n}', 'a|{n}']) {
      const res = await post({ ...mine, settings: { ...mine.settings, namePattern } });
      expect(res.status).toBe(400);
      expect(jsonOf(res)).toMatchObject({ error: 'bad-setting', field: 'namePattern' });
    }
  });

  it('a bad percent-escape in the id is refused, not a crash', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const res = await fx.send('/api/profiles/%E0%A4%A', { method, body: method === 'PUT' ? JSON.stringify(mine) : undefined });
      // the server's path check answers before the route is reached
      expect(res.status).toBe(400);
    }
  });

  it('a non-numeric Opus bitrate sent as text is refused naming the field', async () => {
    const res = await post({ ...mine, settings: { ...mine.settings, opusBitrate: 'abc' } });
    expect(jsonOf(res)).toMatchObject({ field: 'opusBitrate' });
  });

  it('refuses extra SVT arguments the encoder controls and names the argument', async () => {
    for (const args of [['--crf', '20'], ['--preset=3'], ['-i', 'x'], ['--film-grain', '5'], ['-b', 'x'], ['--output', 'x']]) {
      const res = await post({ ...mine, settings: { ...mine.settings, extraSvtArgs: args } });
      const body = jsonOf<{ field: string; message: string }>(res);
      expect(res.status).toBe(400);
      expect(body.field).toBe('extraSvtArgs');
      expect(body.message).toContain(args[0]!.split('=')[0]!);
    }
  });

  it('names must be non-empty and unique in any letter case', async () => {
    expect(jsonOf(await post({ ...mine, name: ' ' }))).toMatchObject({ field: 'name' });
    await post(mine);
    expect(jsonOf(await post({ ...mine, name: 'SMALL FILES' }))).toMatchObject({ field: 'name' });
    expect(jsonOf(await post({ ...mine, name: 'default' }))).toMatchObject({ field: 'name' });
  });
});

describe('a damaged profiles.json', () => {
  it('leaves only the default, logs once and refuses writes without touching the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profiles-bad-'));
    try {
      writeFileSync(join(dir, 'profiles.json'), '{ not json');
      const log = vi.fn();
      const store = new ProfileStore(dir, log);
      expect((await store.list()).map((p) => p.id)).toEqual(['default']);
      await store.list();
      expect(log).toHaveBeenCalledTimes(1);
      await expect(store.create(mine)).rejects.toMatchObject({ status: 500, code: 'profiles-unreadable' });
      expect(readFileSync(join(dir, 'profiles.json'), 'utf8')).toBe('{ not json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing file is just the default, and the first write creates it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profiles-new-'));
    try {
      const store = new ProfileStore(join(dir, 'data'));
      expect(await store.list()).toHaveLength(1);
      await store.create(mine);
      expect(await new ProfileStore(join(dir, 'data')).list()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
