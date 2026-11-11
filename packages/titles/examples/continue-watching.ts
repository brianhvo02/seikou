// SPDX-License-Identifier: LGPL-3.0-or-later
// Build the Continue watching row: an episode to resume, and the one that follows a finished episode.
import { buildCatalogue, continueWatching, type DiscEvidence, type Entry } from '@seikou/titles';

type Place = Parameters<typeof continueWatching>[0][number];

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
  const discsOf = (discKey: string): string[] => (discKey === 'd.disc-a' ? ['disc-a'] : []);

  // Episode 1 is finished and episode 2 was left half-way, so episode 2 is the card to resume.
  const places = [place('00001', 24, true, 2_000), place('00002', 10, false, 3_000)];
  const row = continueWatching(places, catalogue, discsOf);
  console.log(row.map((c) => c.kind + ' ' + c.titleName + ' episode ' + c.episode));
  if (row.length !== 1 || row[0]!.kind !== 'resume' || row[0]!.episode !== 2) throw new Error('episode 2 should be resumed');

  // With only episode 1 finished, the row offers the next episode from the start.
  const upNext = continueWatching([place('00001', 24, true, 2_000)], catalogue, discsOf);
  console.log(upNext.map((c) => c.kind + ' episode ' + c.episode + ' playlist ' + c.playlistId));
  if (upNext[0]?.kind !== 'up-next' || upNext[0].playlistId !== '00002' || upNext[0].timeUs !== 0) throw new Error('episode 2 should be up next');
}
