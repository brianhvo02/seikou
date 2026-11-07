// SPDX-License-Identifier: LGPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { episodeOfFile } from '@seikou/fansubs/episode-files';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import { fixtureAniList } from '../../src/subs/fixture-anilist';

const dir = fileURLToPath(new URL('../fixtures/fansubs/', import.meta.url));
const HASH_A = 'a'.repeat(40);

describe('recorded fansub answers', () => {
  it('has Anime Tosho releases for GroupA and GroupB only', async () => {
    const { tosho, seadex } = fixtureFansubSources(dir);
    const a = await tosho.byHash(HASH_A);
    expect(a?.files).toHaveLength(2);
    expect(a?.files.map((f) => episodeOfFile(f.name))).toEqual([1, 2]);
    expect(await tosho.byHash('b'.repeat(40))).not.toBeNull();
    const entry = await seadex.entry(900101);
    expect(entry?.releases).toHaveLength(3);
    expect(entry?.notes).toBe('GroupA for video and full subs; GroupB has the better signs.');
    expect(entry?.releases.some((r) => r.infoHash === null)).toBe(true);
    for (const r of entry?.releases ?? []) if (r.infoHash !== null) expect(await tosho.byHash(r.infoHash)).not.toBeNull();
  });

  it('serves the tracks and the font pack as downloads', async () => {
    const { tosho } = fixtureFansubSources(dir);
    const file = (await tosho.byHash(HASH_A))!.files[0]!;
    expect(file.tracks.map((t) => t.name)).toEqual(['Full', 'Signs']);
    expect((await tosho.download(file.tracks[0]!.url)).length).toBeGreaterThan(0);
    expect((await tosho.download(tosho.fontPackUrl(file.id))).length).toBeGreaterThan(0);
  });
});

describe('fixtureAniList', () => {
  it('finds Lantern Harbor by a case-insensitive part of its name', async () => {
    const { source } = fixtureAniList(dir);
    expect((await source.search('lantern')).map((e) => e.id)).toEqual(['anilist:900101']);
    expect(await source.search('nothing here')).toEqual([]);
    expect((await source.entry('anilist:900101'))?.episodes).toBe(2);
    expect(await source.entry('anilist:1')).toBeNull();
  });

  it('names the episodes', async () => {
    const titles = await fixtureAniList(dir).episodes.titles(900101);
    expect([...titles]).toEqual([
      [1, 'Arrival'],
      [2, 'The Lighthouse'],
    ]);
    expect((await fixtureAniList(dir).episodes.titles(5)).size).toBe(0);
  });
});
