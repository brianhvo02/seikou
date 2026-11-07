import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '../../src/bdj/host';
import type { Mpls, PlayItem, SubPath } from '@seikou/bdmv/mpls-parser';
import type { RunRecord } from './classify';
import { markReal, menuPlaylists, parseVideoManifest, planVideo, playlistClips, VIDEO_CAP_BYTES } from './video';

// Made-up runs and playlists.
const sel = (pl: number, ret = 1): TraceEntry => ({ call: 'selectPlaylistN', args: [pl, -1, -1, '-1'], ret });
const reg: TraceEntry = { call: 'writeRegN', args: [0, 1, 0, -1], ret: 0 };
function run(calls: TraceEntry[], menuAt: number | null): RunRecord {
  return {
    side: 'ours',
    end: menuAt === null ? 'timeout' : 'done',
    endDetail: null,
    steps: menuAt === null ? [] : [{ n: 0, step: 'wait menu 1500', hash: 'aaaaaaaa', calls: menuAt }],
    calls,
    endHash: null,
    flushes: 0,
    missingClasses: [],
    rejectedPlaylists: [],
    wallMs: 0,
  };
}

describe('menuPlaylists', () => {
  it('takes the playlists selected before the menu step held and the first one after, over both runs', () => {
    const ours = run([sel(1), reg, sel(5), sel(5), sel(9)], 4);
    const lib = run([sel(1), sel(6), sel(9)], 2);
    expect(menuPlaylists([ours, lib])).toEqual([1, 5, 9, 6]);
  });

  it('stops at the first successful selection after the menu, skipping refused or stop selections', () => {
    expect(menuPlaylists([run([sel(3), sel(-1), sel(4, 0), reg, sel(7), sel(8)], 3), null])).toEqual([3, 7]);
  });

  it('takes only the first playlist selected when the menu never came', () => {
    expect(menuPlaylists([run([sel(2), sel(2), sel(4), sel(6)], null)])).toEqual([2]);
    expect(menuPlaylists([run([], null), null])).toEqual([]);
  });
});

describe('playlistClips', () => {
  it('lists the main path (angles too), then the sub-paths, each clip once', () => {
    const item = (clipId: string, angleClipIds: string[] = []): PlayItem => ({ clipId, angleClipIds } as unknown as PlayItem);
    const sub = (...clips: string[]): SubPath => ({ type: 3, isRepeat: false, items: clips.map((clipId) => ({ clipId })) } as unknown as SubPath);
    const mpls = { playItems: [item('00010'), item('00011', ['00011', '00012']), item('00010')], subPaths: [sub('00020'), sub('00021', '00010')] } as unknown as Mpls;
    expect(playlistClips(mpls)).toEqual(['00010', '00011', '00012', '00020', '00021']);
    // a clip id that is not five digits is dropped: it could name another path
    const odd = { playItems: [item('../01'), item('00001'), item('1234')], subPaths: [sub('0000a')] } as unknown as Mpls;
    expect(playlistClips(odd)).toEqual(['00001']);
  });
});

describe('planVideo', () => {
  const clip = (c: string, size: number, mtime = 1): { clip: string; size: number; mtime: number } => ({ clip: c, size, mtime });

  it('skips a disc over the 2 GB cap and reads nothing of it', () => {
    const plan = planVideo([clip('00001', VIDEO_CAP_BYTES), clip('00002', 1)], new Map());
    expect(plan.copy).toEqual([]);
    expect(plan.skip).toMatch(/over the 2 GB cap/);
    expect(planVideo([clip('00001', VIDEO_CAP_BYTES)], new Map()).skip).toBeNull();
  });

  it('copies only clips not already real and unchanged', () => {
    const real = parseVideoManifest('00001\t100\t5\n00002\t200\t5\n');
    const plan = planVideo([clip('00001', 100, 5), clip('00002', 200, 6), clip('00003', 300)], real);
    expect(plan.copy.map((c) => c.clip)).toEqual(['00002', '00003']);
    expect(plan.total).toBe(600);
  });
});

describe('video manifest', () => {
  it('marks clips real, replacing older entries, and reads them back', () => {
    let text = markReal('', [{ clip: '00002', size: 20, mtime: 1 }]);
    text = markReal(text, [{ clip: '00001', size: 10, mtime: 1 }, { clip: '00002', size: 21, mtime: 2 }]);
    expect(text).toBe('00001\t10\t1\n00002\t21\t2\n');
    expect([...parseVideoManifest(text).values()]).toEqual([{ clip: '00001', size: 10, mtime: 1 }, { clip: '00002', size: 21, mtime: 2 }]);
    expect(parseVideoManifest('garbage\n\n../x\t1\t1\n').size).toBe(0);
  });
});
