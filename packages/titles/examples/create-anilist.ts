// SPDX-License-Identifier: LGPL-3.0-or-later
// Search AniList and read an entry by id, answered from a recorded response for a made-up show.
import { createAniList, Pacer } from '@seikou/titles';

const MEDIA = {
  id: 990001,
  title: { romaji: 'Hoshi no Tabibito', english: 'Starfall Wanderer', native: '星降りの旅人' },
  synonyms: ['Starfall'],
  format: 'TV',
  episodes: 12,
  duration: 24,
  startDate: { year: 2021, month: 4, day: 7 },
  coverImage: { large: 'https://img.example/990001-large.jpg', extraLarge: 'https://img.example/990001-xl.jpg' },
  bannerImage: null,
  relations: { edges: [{ relationType: 'SEQUEL', node: { id: 990002, format: 'TV', startDate: { year: 2023, month: 1, day: 8 } } }] },
};

export default async function example(): Promise<void> {
  // A stand-in for fetch that answers the way graphql.anilist.co does.
  const recorded: typeof fetch = async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body)) as { variables: { id?: number } };
    const data = variables.id === undefined ? { Page: { media: [MEDIA] } } : { Media: variables.id === 990001 ? MEDIA : null };
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  };
  const anilist = createAniList(recorded, new Pacer(30, 60_000));

  const found = await anilist.search('starfall wanderer', { kind: 'series', year: 2021 });
  console.log(found.map((e) => e.id + ' ' + e.names.english + ' ' + e.startDate));

  const entry = await anilist.entry('anilist:990001');
  console.log(entry?.relations, await anilist.entry('anilist:1'));
  if (found[0]?.id !== 'anilist:990001' || entry?.names.native !== '星降りの旅人' || entry.relations[0]?.id !== 'anilist:990002') throw new Error('the entry was misread');
  if ((await anilist.entry('anilist:1')) !== null) throw new Error('an unknown id was not null');
}
