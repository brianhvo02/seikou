// SPDX-License-Identifier: LGPL-3.0-or-later
// Turn one TheDiscDb disc record and its title's metadata into an index entry.
import { indexDisc } from '@seikou/titles';

export default async function example(): Promise<void> {
  const disc = {
    ContentHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    Format: 'Blu-ray',
    Titles: [
      { SourceFile: '00001.mpls', Item: { Type: 'Episode', Season: '1', Episode: '1', Title: 'Arrival' } },
      { SourceFile: '00002.mpls', Item: { Type: 'Episode', Season: '1', Episode: '2', Title: 'Lanterns' } },
      { SourceFile: '00010.mpls', Item: { Type: 'Extra', Title: 'Trailer' } },
    ],
  };
  const metadata = { Title: 'Starfall Wanderer', Year: 2021, Type: 'Series', ExternalIds: { Tmdb: 990101 } };

  const indexed = indexDisc(disc, metadata);
  console.log(indexed?.hash, indexed?.hit.title, indexed?.hit.season, indexed?.hit.episodes.length);
  if (indexed?.hash !== 'A1B2C3D4E5F60718293A4B5C6D7E8F90' || indexed.hit.season !== 1 || indexed.hit.episodes.length !== 2) throw new Error('the disc was not indexed');

  if (indexDisc({ ...disc, Format: 'DVD' }, metadata) !== null) throw new Error('a DVD was indexed');
}
