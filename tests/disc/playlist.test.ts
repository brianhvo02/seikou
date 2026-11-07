// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import type { PlayListMark } from 'seikou/engine/bdmv/mpls-parser';
import { bdmvRoot, chaptersFromMarks, listPlaylists, loadPlaylist, type PlaylistItem } from '../../src/disc/playlist';

const disc = 'fixtures/disc1';

it('loads playlist 00000 with two items and four chapters', async () => {
  const p = await loadPlaylist(disc, '00000');
  expect(p.items.map((i) => [i.clipId, i.inTime45, i.outTime45, i.videoPid, i.audioPids])).toEqual([
    ['00001', 450000, 630000, 4113, [4352]],
    ['00002', 450000, 630000, 4113, [4352]],
  ]);
  expect(p.duration45).toBe(360000);
  expect(p.chapters.map((c) => [c.index, c.itemIndex, c.time45, c.start45])).toEqual([
    [1, 0, 450000, 0],
    [2, 0, 540000, 90000],
    [3, 1, 450000, 180000],
    [4, 1, 540000, 270000],
  ]);
  expect(p.items[0].m2tsPath).toMatch(/BDMV\/STREAM\/00001\.m2ts$/);
});

it('accepts the BDMV folder itself and lists playlists', async () => {
  expect(bdmvRoot('fixtures/disc1/BDMV')).toBe(bdmvRoot('fixtures/disc1'));
  const list = await listPlaylists(disc);
  expect(list.map((l) => [l.id, l.duration45, l.clipIds])).toEqual([
    ['00000', 360000, ['00001', '00002']],
    ['00001', 180000, ['00002']],
  ]);
});

it('ignores link marks and marks outside the item', () => {
  const items = [{ index: 0, inTime45: 1000, outTime45: 5000 }] as PlaylistItem[];
  const marks = [
    { type: 2, playItemRef: 0, time: 2000 },
    { type: 1, playItemRef: 0, time: 9000 },
    { type: 1, playItemRef: 0, time: 3000 },
    { type: 1, playItemRef: 0, time: 3000 },
  ];
  expect(chaptersFromMarks(marks as PlayListMark[], items).map((c) => [c.time45, c.start45])).toEqual([
    [1000, 0],
    [3000, 2000],
  ]);
});
