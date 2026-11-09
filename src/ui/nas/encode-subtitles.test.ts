// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { DiscEntry, DiscManifest, EncodeDetail, StoredSubtitle } from '@seikou/nas/nas-api';
import { CodingType } from '@seikou/bdmv/stream-types';
import { buildMpls } from '../../../tests/helpers/bdmv-builders';
import { loadEncodeSubtitles } from './encode-subtitles';

const KEY = `f.${'C'.repeat(32)}`;
const S = 45_000;

const entry: EncodeDetail = {
  id: '990001-2', anilistId: 990001, episode: 2, episodeTitle: 'A Quiet Harbor', discKey: KEY, playlistId: '00000', episodeStartMs: 60_000,
  size: 1, mtimeMs: 1, durationMs: 60_000, chapters: [], tracks: [],
};

function sub(id: string, attachment: StoredSubtitle['attachment']): StoredSubtitle {
  return { id, name: id, language: 'en', offsetMs: 0, fileName: `${id}.ass`, fileSize: 1, fonts: [], attachment, uploadedAt: 1 };
}
const episodeSub = sub('ep', { kind: 'episode', discKey: KEY, playlistId: '00000', titleId: 't', seasonId: 's', episode: 2 });
const chapterSub = sub('ch', { kind: 'chapter', discKey: KEY, playlistId: '00000', chapter: 2 });
const otherSub = sub('other', { kind: 'episode', discKey: KEY, playlistId: '00001', titleId: 't', seasonId: 's', episode: 2 });

function manifest(): DiscManifest {
  const video = [{ pid: 0x1011, codingType: CodingType.AVC, format: 6, rate: 1 }];
  const bytes = buildMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: 120 * S, video }], marks: [0, 30, 60, 90].map((t) => ({ playItemRef: 0, time: t * S })) });
  return { discId: 'disc-1', name: 'x', files: [{ path: 'BDMV/PLAYLIST/00000.MPLS', size: bytes.length }], inline: { 'BDMV/PLAYLIST/00000.MPLS': btoa(String.fromCharCode(...bytes)) } };
}

function fakeNas(opts: { entry?: EncodeDetail | null; items?: StoredSubtitle[]; disc?: boolean; listFails?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    nas: {
      encode: async (id: string) => (calls.push(`encode ${id}`), opts.entry === undefined ? entry : opts.entry),
      subtitlesForDisc: async (key: string) => {
        calls.push(`subtitles ${key}`);
        if (opts.listFails) throw new Error('offline');
        return opts.items ?? [];
      },
      resolveDisc: async (key: string) => (calls.push(`resolve ${key}`), opts.disc === false ? null : ({ id: 'disc-1' } as DiscEntry)),
      manifest: async (id: string) => (calls.push(`manifest ${id}`), manifest()),
    },
  };
}

describe('loadEncodeSubtitles', () => {
  it("offers the source playlist's episode upload shifted, and its first chapter's from the disc's chapters", async () => {
    const t = fakeNas({ items: [episodeSub, chapterSub, otherSub] });
    const got = await loadEncodeSubtitles(t.nas, '990001-2', () => {});
    expect(got?.stored).toEqual([{ subtitle: episodeSub, startUs: -60_000_000 }, { subtitle: chapterSub, startUs: 0 }]);
    expect(t.calls).toEqual(['encode 990001-2', `subtitles ${KEY}`, `resolve ${KEY}`, 'manifest disc-1']);
  });

  it('reads no disc when no chapter upload is listed', async () => {
    const t = fakeNas({ items: [episodeSub] });
    expect((await loadEncodeSubtitles(t.nas, '990001-2', () => {}))?.stored).toHaveLength(1);
    expect(t.calls).toEqual(['encode 990001-2', `subtitles ${KEY}`]);
  });

  it('offers no chapter upload when the NAS no longer has the disc', async () => {
    const t = fakeNas({ items: [episodeSub, chapterSub], disc: false });
    expect((await loadEncodeSubtitles(t.nas, '990001-2', () => {}))?.stored.map((s) => s.subtitle.id)).toEqual(['ep']);
  });

  it('lists nothing for an encode without source tags, and nothing when the list fails', async () => {
    const untagged = fakeNas({ entry: { ...entry, discKey: null }, items: [episodeSub] });
    expect((await loadEncodeSubtitles(untagged.nas, '990001-2', () => {}))?.stored).toEqual([]);
    expect(untagged.calls).toEqual(['encode 990001-2']);
    expect((await loadEncodeSubtitles(fakeNas({ listFails: true }).nas, '990001-2', () => {}))?.stored).toEqual([]);
  });

  it('is null when the entry is gone', async () => {
    expect(await loadEncodeSubtitles(fakeNas({ entry: null }).nas, '990001-2', () => {})).toBeNull();
  });
});
