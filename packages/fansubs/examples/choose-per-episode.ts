// SPDX-License-Identifier: LGPL-3.0-or-later
// Pick, for each episode, the first release whose file has ASS subtitles in a wanted language.
import { choosePerEpisode, type Candidate, type ToshoFile, type ToshoRelease } from '@seikou/fansubs';

export default async function example(): Promise<void> {
  const file = (id: number, name: string, format: string, language: string): ToshoFile => ({
    id, name, size: 500_000_000, tracks: [{ track: 0, language, name: 'Full', format, url: 'https://animetosho.net/t/' + id + '.xz', isDefault: true, forced: false }],
  });
  const candidate = (group: string, files: ToshoFile[]): Candidate => {
    const release: ToshoRelease = { id: 1, title: group, infoHash: 'a'.repeat(40), status: 'complete', isSeadex: true, date: 0, files };
    return { release, rank: 'best', seadex: { tracker: 'Nyaa', infoHash: release.infoHash, isBest: true, dualAudio: false, group, tags: [], files: [] } };
  };
  const candidates = [
    candidate('Group A', [file(1, '[Group A] Starfall Wanderer - 01.mkv', 'SRT', 'eng'), file(2, '[Group A] Starfall Wanderer - 02.mkv', 'ASS', 'eng')]),
    candidate('Group B', [file(3, '[Group B] Starfall Wanderer - 01.mkv', 'ASS', 'eng'), file(4, '[Group B] Starfall Wanderer - 02.mkv', 'ASS', 'eng')]),
  ];

  const chosen = choosePerEpisode(candidates, [1, 2], { count: 12, before: 0 }, ['eng']);
  for (const [episode, c] of chosen) console.log('episode', episode, '->', c.candidate.release.title, c.file.name, c.tracks.length, 'track');
  if (chosen.get(1)?.candidate.release.title !== 'Group B' || chosen.get(2)?.candidate.release.title !== 'Group A') throw new Error('the picks are wrong');
}
