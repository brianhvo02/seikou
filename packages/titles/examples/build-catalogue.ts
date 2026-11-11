// SPDX-License-Identifier: LGPL-3.0-or-later
// Build the library from a match and its metadata: no network, no disk, the same answer every time.
import { buildCatalogue, type DiscEvidence, type DiscMatch, type Entry } from '@seikou/titles';

export default async function example(): Promise<void> {
  const show: Entry = {
    source: 'anilist', id: 'anilist:990001', kind: 'series', format: 'TV', names: { english: 'Starfall Wanderer', romaji: null, native: null, synonyms: [] },
    animation: true, year: 2021, episodes: 3, runtimeMin: 24, seasons: [], relations: [], poster: null, banner: null,
  };
  const pl = (id: string, minutes: number, clips: string[]): DiscEvidence['playlists'][number] => ({ id, durationS: minutes * 60, chapters: 6, clips });
  const evidence: DiscEvidence = {
    discId: 'disc-a', path: 'Starfall Wanderer/Disc 1', fingerprint: null, discTitles: [], segments: ['Starfall Wanderer', 'Disc 1'], catalogueNumbers: [],
    playlists: [pl('00001', 24, ['00001']), pl('00002', 24, ['00002']), pl('00003', 24, ['00003']), pl('00004', 72, ['00001', '00002', '00003'])],
  };
  const matches: DiscMatch[] = [
    { discId: 'disc-a', status: 'filed', entryId: show.id, season: 1, disc: 1, bonus: false, via: ['folder'] },
    { discId: 'disc-b', status: 'unsorted', reason: 'no-title', suggestions: [] },
  ];

  const catalogue = buildCatalogue({
    matches,
    entries: new Map([[show.id, show]]),
    evidence: [evidence, { ...evidence, discId: 'disc-b', path: 'Mystery/Disc', segments: ['Mystery', 'Disc'], playlists: [] }],
    owner: { choices: new Map(), ownTitles: [], displayNames: new Map(), gate: null },
    discdb: { lookup: () => null },
    addedAt: new Map(),
    downloadRoots: new Set(),
    music: new Map(),
    folderCovers: new Map(),
  });

  const title = catalogue.titles[0]!;
  const detail = catalogue.detail(title.id);
  console.log(title.names.english, detail?.seasons.map((s) => s.episodes?.length + ' episodes'), 'unsorted:', catalogue.unsorted.length);
  if (catalogue.titles.length !== 1 || detail?.seasons[0]?.episodes?.length !== 3 || catalogue.unsorted.length !== 1) throw new Error('the library is wrong');
  if (catalogue.detail('nobody') !== null) throw new Error('an unknown title has a detail');
}
