// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { episodePgsTracks } from '../../src/disc/pgs';
import { loadPlaylist, type Playlist } from '../../src/disc/playlist';
import { readPlaylistPmts } from '../../src/disc/pmt';
import { probeClip, type ClipProbe } from '../../src/disc/probe';
import { parseEpisodeSpec, planEpisodes, type EpisodePlan } from '../../src/plan/episodes';
import type { MkvSubtitleTrack } from '../../src/mux/mkv-writer';
import { fx } from '../paths';

// disc-subs: one 12 s clip whose video starts at PTS 900000 (24000/1001 fps), chapters at 0, 4 and 8 s. PG 0x1200
// (eng) shows display sets at PTS 990000 (epoch start), 1170000, 1260000 (epoch start), 1440000, 1620000 (epoch
// start), 1800000; PG 0x1201 (jpn) at 1080000 (epoch start), 1350000, 1530000 (epoch start), 1710000. Each display
// set is five PES (PCS, WDS, PDS, ODS, END) at one PTS, or three (PCS, WDS, END) for a normal-state one.

async function plan(discDir: string, spec: string): Promise<{ playlist: Playlist; plans: EpisodePlan[] }> {
  const playlist = await loadPlaylist(discDir, '00000');
  const probes = new Map<string, ClipProbe>();
  for (const item of playlist.items) probes.set(item.clipId, await probeClip(item));
  const pmts = await readPlaylistPmts(playlist);
  const audio = playlist.items[0]!.audioPids.map((pid) => ({ pid }));
  return { playlist, plans: planEpisodes(playlist, probes, parseEpisodeSpec(spec, playlist.chapters.length), audio, pmts) };
}

/** Exact milliseconds from the episode's first frame (PTS `firstFramePts90`) to `pts90`, rounded. */
const msFrom = (firstFramePts90: number, pts90: number): number => Math.round((pts90 - firstFramePts90) / 90);

/** PTS of the display sets a track carries, from its blocks' times (five or three blocks share one time). */
const times = (track: MkvSubtitleTrack): number[] => [...new Set(track.blocks.map((b) => b.timeMs))];

describe('episodePgsTracks', () => {
  it('finds both PG streams with their STN languages', async () => {
    const { playlist, plans } = await plan(fx('fixtures/disc-subs'), '1-');
    const tracks = await episodePgsTracks(plans[0]!, playlist);
    expect(tracks.map((t) => ({ codecId: t.codecId, name: t.name, language: t.language, isDefault: t.isDefault, codecPrivate: t.codecPrivate }))).toEqual([
      { codecId: 'S_HDMV/PGS', name: 'English (disc)', language: 'eng', isDefault: false, codecPrivate: undefined },
      { codecId: 'S_HDMV/PGS', name: 'Japanese (disc)', language: 'jpn', isDefault: false, codecPrivate: undefined },
    ]);
  });

  it('block times are relative to the episode\'s first frame', async () => {
    const { playlist, plans } = await plan(fx('fixtures/disc-subs'), '1-');
    const [eng, jpn] = await episodePgsTracks(plans[0]!, playlist);
    // The episode starts at the clip's first frame, PTS 900000.
    expect(times(eng!)).toEqual([990000, 1170000, 1260000, 1440000, 1620000, 1800000].map((p) => msFrom(900000, p)));
    expect(times(jpn!)).toEqual([1080000, 1350000, 1530000, 1710000].map((p) => msFrom(900000, p)));
    // Every PES is one block, its payload unchanged: the first display set's PCS opens with segment type 0x16.
    expect(eng!.blocks.filter((b) => b.timeMs === 1000).map((b) => b.data[0])).toEqual([0x16, 0x17, 0x14, 0x15, 0x80]);
    expect(eng!.blocks.every((b, i, all) => i === 0 || all[i - 1]!.timeMs <= b.timeMs)).toBe(true);
  });

  it('starts at the first epoch start or acquisition point', async () => {
    // Episode 2 is chapter 2 alone: its first frame is the one nearest 14 s (frame 96, PTS 1260360), and it ends
    // before frame 192 (PTS 1620720), the frame nearest chapter 3.
    const { playlist, plans } = await plan(fx('fixtures/disc-subs'), '1,2,3');
    const [eng, jpn] = await episodePgsTracks(plans[1]!, playlist);
    const first = 1260360;
    // eng: the epoch start at 1260000 lies within half a frame of the first frame, so it belongs to this episode
    // and is clamped to 0; the display set at 1620000 belongs to frame 192, the next episode's first.
    expect(times(eng!)).toEqual([0, msFrom(first, 1440000)]);
    // jpn: the normal-state display set at 1350000 needs the epoch that began before the episode, so it is dropped.
    expect(times(jpn!)).toEqual([msFrom(first, 1530000)]);
    expect(jpn!.blocks[0]!.data[0]).toBe(0x16);
  });

  it('a disc without PG gives no tracks', async () => {
    const { playlist, plans } = await plan(fx('fixtures/disc1'), '1-');
    expect(await episodePgsTracks(plans[0]!, playlist)).toEqual([]);
  });
});
