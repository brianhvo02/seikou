// SPDX-License-Identifier: LGPL-3.0-or-later
// File a disc under a title from its folder name, looked up on a stand-in AniList that knows one made-up show.
import { matchDiscs, type DiscEvidence, type Entry, type MetadataSource } from '@seikou/titles';

const SHOW: Entry = {
  source: 'anilist', id: 'anilist:990001', kind: 'series', format: 'TV',
  names: { english: 'Starfall Wanderer', romaji: 'Hoshifuri no Tabibito', native: null, synonyms: [] },
  animation: true, year: 2021, episodes: 12, runtimeMin: 24, seasons: [], relations: [], poster: null, banner: null,
};

export default async function example(): Promise<void> {
  const anilist: MetadataSource = {
    search: async (query) => (query.toLowerCase().includes('starfall wanderer') ? [SHOW] : []),
    entry: async (id) => (id === SHOW.id ? SHOW : null),
  };
  const disc = (path: string): DiscEvidence => ({ discId: 'id:' + path, path, fingerprint: null, discTitles: [], segments: path.split('/'), catalogueNumbers: [], playlists: [] });

  const { matches, entries, aborted } = await matchDiscs(
    [disc('Starfall Wanderer (2021)/Starfall Wanderer Vol.1'), disc('Unknown Folder/Disc')],
    { anilist, tmdb: null, discdb: { lookup: () => null }, cache: new Map() },
  );
  for (const m of matches) console.log(m.discId, m.status, m.status === 'filed' ? m.entryId + ' season ' + m.season : '');

  const filed = matches.find((m) => m.discId === 'id:Starfall Wanderer (2021)/Starfall Wanderer Vol.1');
  const unknown = matches.find((m) => m.discId === 'id:Unknown Folder/Disc');
  if (filed?.status !== 'filed' || filed.entryId !== 'anilist:990001' || filed.season !== 1) throw new Error('the disc was not filed');
  if (unknown?.status !== 'unsorted' || !entries.has('anilist:990001') || aborted) throw new Error('the unknown disc should be left for the owner');
}
