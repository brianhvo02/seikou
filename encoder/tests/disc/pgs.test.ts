// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { episodePgsTracks, groupDisplaySets, type PgPes } from '../../src/disc/pgs';
import { loadPlaylist, type Playlist, type PlaylistItem } from '../../src/disc/playlist';
import { readPlaylistPmts } from '../../src/disc/pmt';
import { probeClip, type ClipProbe } from '../../src/disc/probe';
import { parseEpisodeSpec, planEpisodes, type EpisodePlan } from '../../src/plan/episodes';
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
  const audio = playlist.items[0]!.audioPids.map((pid) => ({ pid, sampleRate: 48000 }));
  return { playlist, plans: planEpisodes(playlist, probes, parseEpisodeSpec(spec, playlist.chapters.length), audio, pmts) };
}

/**
 * A two-item episode made from disc-subs: chapter 1 as play item 0, then chapter 2 as a second play item of the same
 * clip, joined with `connectionCondition` and carrying the PG streams `pg` (PID and language, in STN order).
 */
async function twoItemEpisode(connectionCondition: number, pg: [number, string][]): Promise<{ playlist: Playlist; episode: EpisodePlan }> {
  const { playlist, plans } = await plan(fx('fixtures/disc-subs'), '1,2,3');
  const [a, b] = [plans[0]!.segments[0]!, plans[1]!.segments[0]!];
  const second: PlaylistItem = { ...b.item, index: 1, connectionCondition, pgPids: pg.map((s) => s[0]), pgLanguages: pg.map((s) => s[1]) };
  return {
    playlist: { ...playlist, items: [a.item, second] },
    episode: { ...plans[0]!, segments: [a, { ...b, item: second }], frameCount: 192 },
  };
}

/**
 * The eng track over the two-item episode: the display set at 1260000 is item 1's, clamped to its first frame
 * (frame 96, 4004 ms).
 */
const engAcrossItems = [1000, 3000, 4004, 6000];

/** Exact milliseconds from the episode's first frame (PTS `firstFramePts90`) to `pts90`, rounded. */
const msFrom = (firstFramePts90: number, pts90: number): number => Math.round((pts90 - firstFramePts90) / 90);

/** A PES holding one segment of `type` with `body` as its data. */
const seg = (type: number, body: number[] = [], pts?: number): PgPes => ({
  ...(pts !== undefined ? { pts } : {}),
  payload: new Uint8Array([type, body.length >> 8, body.length & 0xff, ...body]),
});
/** A PCS body: video descriptor (1920x1080, rate), composition_number 7, then `state` in the top bits. */
const pcs = (state: number, pts?: number): PgPes => seg(0x16, [0x07, 0x80, 0x04, 0x38, 0x10, 0x00, 0x07, state, 0x00, 0x00, 0x00], pts);

describe('groupDisplaySets', () => {
  it('joins a display set whose segments carry different PTS into one set at the PCS PTS', () => {
    const pes = [
      seg(0x15, [9], 500), // the tail of a set the read began inside: no PCS before it
      seg(0x80, [], 510),
      pcs(0x80, 2000),
      seg(0x17, [1], 1100),
      seg(0x14, [2], 1100),
      seg(0x15, [3], 1000),
      seg(0x80, [], 1990),
      pcs(0x00, 3000),
      seg(0x17, [4], 2900),
      seg(0x80, [], 2990),
      pcs(0x40, 4000), // no END before the read ends
      seg(0x17, [5], 3900),
    ];
    const sets = groupDisplaySets(pes);
    expect(sets.map((s) => ({ pts90: s.pts90, startsEpoch: s.startsEpoch }))).toEqual([
      { pts90: 2000, startsEpoch: true },
      { pts90: 3000, startsEpoch: false },
    ]);
    const joined = (from: number, to: number): number[] => pes.slice(from, to).flatMap((p) => [...p.payload]);
    expect([...sets[0]!.data]).toEqual(joined(2, 7));
    expect([...sets[1]!.data]).toEqual(joined(7, 10));
  });

  it('takes an acquisition point as a start, a PES of several segments whole, and drops a set cut short by the next PCS', () => {
    const many: PgPes = { pts: 5000, payload: new Uint8Array([...seg(0x17, [1]).payload, ...seg(0x80).payload]) };
    const sets = groupDisplaySets([pcs(0x80, 4000), seg(0x17, [1], 3900), pcs(0x40, 5000), many]);
    expect(sets.map((s) => [s.pts90, s.startsEpoch, s.data.length])).toEqual([[5000, true, pcs(0x40).payload.length + many.payload.length]]);
  });
});

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
    // The episode starts at the clip's first frame, PTS 900000; one block per display set.
    expect(eng!.blocks.map((b) => b.timeMs)).toEqual([990000, 1170000, 1260000, 1440000, 1620000, 1800000].map((p) => msFrom(900000, p)));
    expect(jpn!.blocks.map((b) => b.timeMs)).toEqual([1080000, 1350000, 1530000, 1710000].map((p) => msFrom(900000, p)));
    // A block holds the whole display set: PCS, WDS, PDS, ODS, END.
    let at = 0;
    const types: number[] = [];
    const data = eng!.blocks[0]!.data;
    while (at < data.length) {
      types.push(data[at]!);
      at += 3 + ((data[at + 1]! << 8) | data[at + 2]!);
    }
    expect(types).toEqual([0x16, 0x17, 0x14, 0x15, 0x80]);
  });

  it('starts at the first epoch start or acquisition point', async () => {
    // Episode 2 is chapter 2 alone: its first frame is the one nearest 14 s (frame 96, PTS 1260360), and it ends
    // before frame 192 (PTS 1620720), the frame nearest chapter 3.
    const { playlist, plans } = await plan(fx('fixtures/disc-subs'), '1,2,3');
    const [eng, jpn] = await episodePgsTracks(plans[1]!, playlist);
    const first = 1260360;
    // eng: the epoch start at 1260000 lies within half a frame of the first frame, so it belongs to this episode
    // and is clamped to 0; the display set at 1620000 belongs to frame 192, the next episode's first.
    expect(eng!.blocks.map((b) => b.timeMs)).toEqual([0, msFrom(first, 1440000)]);
    // jpn: the normal-state display set at 1350000 needs the epoch that began before the episode, so it is dropped.
    expect(jpn!.blocks.map((b) => b.timeMs)).toEqual([msFrom(first, 1530000)]);
    expect(jpn!.blocks[0]!.data[0]).toBe(0x16);
  });

  it('a seamless join carries the epoch into the next play item', async () => {
    // The jpn epoch starts at 1080000 in item 0; item 1's first jpn display set (1350000) is Normal and is kept.
    const { playlist, episode } = await twoItemEpisode(5, [[0x1200, 'eng'], [0x1201, 'jpn']]);
    const [eng, jpn] = await episodePgsTracks(episode, playlist);
    expect(jpn!.blocks.map((b) => b.timeMs)).toEqual([1080000, 1350000, 1530000].map((p) => msFrom(900000, p)));
    expect(eng!.blocks.map((b) => b.timeMs)).toEqual(engAcrossItems);
  });

  it('a non-seamless join waits for a new epoch start', async () => {
    const { playlist, episode } = await twoItemEpisode(1, [[0x1200, 'eng'], [0x1201, 'jpn']]);
    const [, jpn] = await episodePgsTracks(episode, playlist);
    expect(jpn!.blocks.map((b) => b.timeMs)).toEqual([1080000, 1530000].map((p) => msFrom(900000, p)));
  });

  it('a later play item\'s streams are matched by language, and a missing language is logged', async () => {
    // Item 1 lists jpn first: each track still gets its language's stream there.
    const swapped = await twoItemEpisode(5, [[0x1201, 'jpn'], [0x1200, 'eng']]);
    const [eng, jpn] = await episodePgsTracks(swapped.episode, swapped.playlist, () => {});
    expect(eng!.blocks.map((b) => b.timeMs)).toEqual(engAcrossItems);
    expect(jpn!.blocks.map((b) => b.timeMs)).toEqual([1080000, 1350000, 1530000].map((p) => msFrom(900000, p)));

    // Item 1 has no eng stream: the eng track shows nothing there, and one line says so.
    const log: string[] = [];
    const missing = await twoItemEpisode(5, [[0x1200, 'fra'], [0x1201, 'jpn']]);
    const [eng2, jpn2] = await episodePgsTracks(missing.episode, missing.playlist, (m) => log.push(m));
    expect(eng2!.blocks.map((b) => b.timeMs)).toEqual([990000, 1170000].map((p) => msFrom(900000, p)));
    expect(jpn2!.blocks).toHaveLength(3);
    expect(log).toEqual(['Play item 1 (clip 00001) has no PG stream in eng; PG track 1 shows nothing there']);
  });

  it('a disc without PG gives no tracks', async () => {
    const { playlist, plans } = await plan(fx('fixtures/disc1'), '1-');
    expect(await episodePgsTracks(plans[0]!, playlist)).toEqual([]);
  });
});
