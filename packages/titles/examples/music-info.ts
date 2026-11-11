// SPDX-License-Identifier: LGPL-3.0-or-later
// Decide a release's artist, kind and title from its folder name, with and without a lookup.
import { musicInfo, type MusicRelease } from '@seikou/titles';

export default async function example(): Promise<void> {
  const fromName = musicInfo({
    releaseFolder: '[2021.06.02] Glass Orchard - Paper Lanterns (Single)',
    parentFolder: 'Music',
    evidence: [],
    lookup: null,
    ownerArtist: null,
    rejectMatch: false,
  });
  console.log(fromName.artist.name, fromName.kind, fromName.date, fromName.matched);
  if (fromName.artist.name !== 'Glass Orchard' || fromName.kind !== 'single' || fromName.matched) throw new Error('the folder name was misread');

  const lookup: MusicRelease = {
    source: 'musicbrainz', id: '00000000-0000-4000-8000-000000000001', title: 'Paper Lanterns Live', date: '2021-06-02',
    artists: [{ id: '00000000-0000-4000-8000-0000000000a1', name: 'Glass Orchard', sortName: null, aliases: [] }],
    primaryType: 'Album', secondaryTypes: ['Live'], live: true, cover: null,
  };
  const looked = musicInfo({ releaseFolder: 'ZZZZ-0001', parentFolder: null, evidence: [], lookup, ownerArtist: null, rejectMatch: false });
  const rejected = musicInfo({ releaseFolder: 'ZZZZ-0001', parentFolder: null, evidence: [], lookup, ownerArtist: null, rejectMatch: true });
  console.log(looked.kind, looked.title, '| rejected:', rejected.title, rejected.matched);
  if (looked.kind !== 'concert' || !looked.matched || rejected.matched || rejected.title !== 'ZZZZ-0001') throw new Error('the lookup was not used or not dropped');
}
