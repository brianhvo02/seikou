// SPDX-License-Identifier: LGPL-3.0-or-later
// Guess a season's episode list from playlist lengths: three 24-minute episodes and a play-all.
import { guessEpisodes, type DiscEvidence } from '@seikou/titles';

export default async function example(): Promise<void> {
  const pl = (id: string, minutes: number, clips: string[]): DiscEvidence['playlists'][number] => ({ id, durationS: minutes * 60, chapters: 6, clips });
  const playlists = [pl('00001', 24, ['00001']), pl('00002', 24, ['00002']), pl('00003', 24, ['00003']), pl('00004', 72, ['00001', '00002', '00003'])];

  const episodes = guessEpisodes({ episodes: 3, runtimeMin: 24 }, [{ discId: 'disc-a', playlists }], 1);
  console.log(episodes?.map((e) => e.number + ':' + e.playlistId));
  if (episodes?.map((e) => e.playlistId).join() !== '00001,00002,00003') throw new Error('the episodes were not found');

  // Unsure is null: the season claims four episodes, the disc shows three.
  if (guessEpisodes({ episodes: 4, runtimeMin: 24 }, [{ discId: 'disc-a', playlists }], 1) !== null) throw new Error('a wrong count was guessed');
}
