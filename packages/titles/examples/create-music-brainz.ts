// SPDX-License-Identifier: LGPL-3.0-or-later
// Look a release up by catalogue number on MusicBrainz, answered from recorded responses for a made-up release.
import { createMusicBrainz, Pacer } from '@seikou/titles';

export default async function example(): Promise<void> {
  const recorded: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const artist = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Glass Orchard', 'sort-name': 'Glass Orchard' };
    const release = {
      id: '00000000-0000-4000-8000-000000000001', title: 'Paper Lanterns', date: '2021-06-02', country: 'JP',
      media: [{ format: 'Blu-ray' }], 'label-info': [{ 'catalog-number': 'ZZZZ-0001' }], 'artist-credit': [{ artist }],
      'release-group': { 'primary-type': 'Album', 'secondary-types': [] }, 'cover-art-archive': { front: true },
    };
    return json(url.pathname === '/ws/2/release' ? { releases: [release] } : release);
  };
  const musicbrainz = createMusicBrainz(recorded, new Pacer(1, 1_100), 'admin@example.test');

  const release = await musicbrainz.byCatalogue('zzzz 0001'); // case, spaces and punctuation are ignored
  console.log(release?.title, release?.artists[0]?.name, release?.date, release?.cover?.small);
  if (release?.title !== 'Paper Lanterns' || release.artists[0]?.name !== 'Glass Orchard' || release.primaryType !== 'Album') throw new Error('the release was misread');
  if ((await musicbrainz.byCatalogue('  ')) !== null) throw new Error('an empty catalogue number matched');
}
