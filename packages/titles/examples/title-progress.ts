// SPDX-License-Identifier: LGPL-3.0-or-later
// Mark each episode of a title with how far the person is, for the progress bars.
import { buildCatalogue, titleProgress, type DiscEvidence, type Entry } from '@seikou/titles';

type Place = Parameters<typeof titleProgress>[0][number];

// A made-up series of three 24-minute episodes on one disc.
function library(): ReturnType<typeof buildCatalogue> {
  const show: Entry = {
    source: 'anilist', id: 'anilist:990001', kind: 'series', format: 'TV', names: { english: 'Starfall Wanderer', romaji: null, native: null, synonyms: [] },
    animation: true, year: 2021, episodes: 3, runtimeMin: 24, seasons: [], relations: [], poster: null, banner: null,
  };
  const pl = (id: string, minutes: number, clips: string[]): DiscEvidence['playlists'][number] => ({ id, durationS: minutes * 60, chapters: 6, clips });
  const evidence: DiscEvidence = {
    discId: 'disc-a', path: 'Starfall Wanderer/Disc 1', fingerprint: null, discTitles: [], segments: ['Starfall Wanderer', 'Disc 1'], catalogueNumbers: [],
    playlists: [pl('00001', 24, ['00001']), pl('00002', 24, ['00002']), pl('00003', 24, ['00003']), pl('00004', 72, ['00001', '00002', '00003'])],
  };
  return buildCatalogue({
    matches: [{ discId: 'disc-a', status: 'filed', entryId: show.id, season: 1, disc: 1, bonus: false, via: ['folder'] }],
    entries: new Map([[show.id, show]]), evidence: [evidence], owner: { choices: new Map(), ownTitles: [], displayNames: new Map(), gate: null },
    discdb: { lookup: () => null }, addedAt: new Map(), downloadRoots: new Set(), music: new Map(), folderCovers: new Map(),
  });
}

const place = (playlistId: string, minutesIn: number, finished: boolean, updatedAt: number): Place => ({
  discKey: 'd.disc-a', discId: 'disc-a', playlistId, timeUs: minutesIn * 60_000_000, durationUs: 24 * 60_000_000, finished, mode: 'none', title: null,
  psrs: [], gprs: null, updatedAt, deviceName: 'Living room',
  settings: { audioLanguage: null, pgLanguage: null, textFiles: [], psr1: 1, psr2: 0, psr3: 0, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false },
});

export default async function example(): Promise<void> {
  const catalogue = library();
  const detail = catalogue.detail(catalogue.titles[0]!.id)!;
  const progress = titleProgress([place('00001', 24, true, 2_000), place('00002', 6, false, 3_000)], detail, (key) => (key === 'd.disc-a' ? ['disc-a'] : []));
  console.log(progress);
  const disc = progress['disc-a'];
  if (disc?.['00001']?.finished !== true || disc['00002']?.timeUs !== 6 * 60_000_000 || disc['00003'] !== undefined) throw new Error('the progress is wrong');
}
