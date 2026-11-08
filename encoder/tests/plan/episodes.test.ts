// SPDX-License-Identifier: LGPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import { loadPlaylist, type Playlist } from '../../src/disc/playlist';
import { PmtError, readPlaylistPmts, type PmtInfo } from '../../src/disc/pmt';
import { probeClip, type ClipProbe } from '../../src/disc/probe';
import { EpisodeSpecError, firstFramePlaylistUs, parseEpisodeSpec, planEpisodes, type Segment } from '../../src/plan/episodes';
import { fx } from '../paths';

let p: Playlist;
let probe00001: ClipProbe;
let probe00002: ClipProbe;
let probes: Map<string, ClipProbe>;
let pmts: Map<string, PmtInfo>;
const lpcm = [{ pid: 4352 }];
/** The first audio track's sample range, as the M1 tests knew it. */
const samplesOf = (s: Segment): [number, number] => s.audioTracks[0]!.samples;

beforeAll(async () => {
  p = await loadPlaylist(fx('fixtures/disc1'), '00000');
  probe00001 = await probeClip(p.items[0]);
  probe00002 = await probeClip(p.items[1]);
  probes = new Map([
    ['00001', probe00001],
    ['00002', probe00002],
  ]);
  pmts = await readPlaylistPmts(p);
});

function plansFor(spec: string, chapterTimes45: number[]) {
  const playlist = {
    id: '00000',
    discDir: fx('fixtures/disc1'),
    items: [
      { index: 0, clipId: '00001', inTime45: 450000, outTime45: 630000, videoPid: 4113, audioPids: [4352] },
    ],
    chapters: chapterTimes45.map((t, i) => ({ index: i + 1, itemIndex: 0, time45: t, start45: t - 450000 })),
    duration45: 180000,
  } as unknown as Playlist;
  return planEpisodes(playlist, new Map([['00001', probe00001]]), parseEpisodeSpec(spec, chapterTimes45.length), lpcm, pmts);
}

describe('parseEpisodeSpec', () => {
  it('parses episode specs and rejects bad ones', () => {
    expect(parseEpisodeSpec('1-2,3-4', 4)).toEqual([{ from: 1, to: 2 }, { from: 3, to: 4 }]);
    expect(parseEpisodeSpec('1-3,4-', 4)).toEqual([{ from: 1, to: 3 }, { from: 4, to: null }]);
    expect(parseEpisodeSpec('2', 4)).toEqual([{ from: 2, to: 2 }]);
    for (const bad of ['3-2', '1-2,2-3', '1-5', '', '0-1', 'a-b']) {
      expect(() => parseEpisodeSpec(bad, 4)).toThrow(EpisodeSpecError);
    }
  });

  it('names the offending token and restricts open ends to the last token', () => {
    expect(() => parseEpisodeSpec('1-,3-4', 4)).toThrow(/1-/);
    expect(() => parseEpisodeSpec('1-2,x', 4)).toThrow(/x/);
  });
});

describe('planEpisodes', () => {
  it('plans two episodes of one clip each on disc1', () => {
    const plans = planEpisodes(p, probes, parseEpisodeSpec('1-2,3-4', 4), lpcm, pmts);
    expect(plans.map((e) => e.segments.map((s) => [s.item.clipId, s.videoFrames, samplesOf(s)])))
      .toEqual([[['00001', [0, 96], [0, 192000]]], [['00002', [0, 96], [0, 192000]]]]);
    expect(plans[0].chapters).toEqual([{ title: 'Chapter 1', startNs: 0n }, { title: 'Chapter 2', startNs: 2002000000n }]);
    expect(plans[0].frameCount).toBe(96);
    expect(plans[0].durationNs).toBe(4004000000n);
  });

  it('spans two clips when an episode crosses an item boundary', () => {
    // spec '1-3,4-': episode 1 = item 0 whole + item 1 frames [0,48); episode 2 = item 1 frames [48,96)
    const plans = planEpisodes(p, probes, parseEpisodeSpec('1-3,4-', 4), lpcm, pmts);
    expect(plans[0].segments.map((s) => [s.item.clipId, s.videoFrames])).toEqual([['00001', [0, 96]], ['00002', [0, 48]]]);
    expect(plans[1].segments.map((s) => [s.item.clipId, s.videoFrames, samplesOf(s)])).toEqual([['00002', [48, 96], [96000, 192000]]]);
    expect(plans[0].chapters.map((c) => c.startNs)).toEqual([0n, 2002000000n, 4004000000n]);
  });

  it('counts audio samples from the video start whether the audio starts late or early', () => {
    // BestSource (adjustdelay=-1) already aligns audio sample 0 to the first video frame.
    for (const firstPts90 of [901800, 898200]) {
      const shifted = { ...probe00001, audio: [{ ...probe00001.audio[0], firstPts90 }] };
      const [ep] = planEpisodes(p, new Map([['00001', shifted], ['00002', probe00002]]), parseEpisodeSpec('1-2', 4), lpcm, pmts);
      expect(samplesOf(ep.segments[0])).toEqual([0, 192000]);
      expect(Object.keys(ep.segments[0]).sort()).toEqual(['audioTracks', 'item', 'videoFirstPts90', 'videoFrames']);
      expect(ep.segments[0].videoFirstPts90).toBe(probe00001.video.firstPts90);
    }
  });

  it('skips chapters between ranges that no spec covers', () => {
    const plans = planEpisodes(p, probes, parseEpisodeSpec('1-2,4-', 4), lpcm, pmts);
    expect(plans.map((e) => e.segments.map((s) => [s.item.index, s.videoFrames]))).toEqual([[[0, [0, 96]]], [[1, [48, 96]]]]);
    expect(plans[0].chapters.map((c) => c.startNs)).toEqual([0n, 2002000000n]);
    expect(plans[1].chapters.map((c) => c.startNs)).toEqual([0n]);
  });

  it('rounds a mark to the nearest frame and puts the chapter on the millisecond block grid', () => {
    // 1000 ticks at 45 kHz = 22.2 ms rounds to frame 1 (41.708 ms), whose block timestamp is 42 ms.
    expect(plansFor('1-', [450000, 451000])[0].chapters[1].startNs).toBe(42000000n);
  });

  it("gives an episode's first frame in playlist time, not its chapter mark", () => {
    // Episode 2's mark is 1000 ticks (22.2 ms) into the playlist; it starts at frame 1, 1001/24000 s in.
    const plans = plansFor('1,2', [450000, 451000]);
    const playlist = { items: [plans[0].segments[0].item] } as unknown as Playlist;
    expect(plans[1].segments[0].videoFrames[0]).toBe(1);
    expect(firstFramePlaylistUs(playlist, plans[1])).toBe(41708);
    expect(firstFramePlaylistUs(playlist, plans[0])).toBe(0);
  });

  it('counts the items before the first frame in playlist time', () => {
    const plans = planEpisodes(p, probes, parseEpisodeSpec('1-2,3-4', 4), lpcm, pmts);
    expect(firstFramePlaylistUs(p, plans[1])).toBe(Math.round(((p.items[0].outTime45 - p.items[0].inTime45) * 1e6) / 45000));
  });

  it('throws naming the clip and PID when the audio PID is missing', () => {
    expect(() => planEpisodes(p, probes, parseEpisodeSpec('1-', 4), [{ pid: 9999 }], pmts)).toThrow(/00001.*9999/);
  });
  describe('audio tracks', () => {
    const video = { pid: 0x1011, streamType: 0x1b };
    const ac3 = (pid: number) => ({ pid, streamType: 0x81 });
    const twoStreams = (probe: ClipProbe): ClipProbe => ({
      ...probe,
      audio: [probe.audio[0]!, { ...probe.audio[0]!, pid: 0x1101, sampleRate: 96000, codingType: 0x81 }],
    });
    const twoProbes = () => new Map([['00001', twoStreams(probe00001)], ['00002', twoStreams(probe00002)]]);

    it('maps PIDs by PMT position per clip', () => {
      const pmtPair = new Map<string, PmtInfo>([
        ['00001', { pmtPid: 0x100, hdmv: true, streams: [video, { pid: 0x1100, streamType: 0x80 }, ac3(0x1101)] }],
        ['00002', { pmtPid: 0x100, hdmv: true, streams: [video, ac3(0x1101), { pid: 0x1200, streamType: 0x90 }, { pid: 0x1100, streamType: 0x80 }] }],
      ]);
      // Episode 1 of '1-3,4-' covers all of clip 1 and the first half of clip 2.
      const [ep] = planEpisodes(p, twoProbes(), parseEpisodeSpec('1-3,4-', 4), [{ pid: 0x1101 }, { pid: 0x1100 }], pmtPair);
      expect(ep!.segments.map((s) => s.audioTracks)).toEqual([
        [
          { pid: 0x1101, bsTrack: 2, samples: [0, 384000] },
          { pid: 0x1100, bsTrack: 1, samples: [0, 192000] },
        ],
        [
          { pid: 0x1101, bsTrack: 1, samples: [0, 192000] },
          { pid: 0x1100, bsTrack: 2, samples: [0, 96000] },
        ],
      ]);
      expect(ep!.audio.map((a) => [a.pid, a.sampleRate])).toEqual([[0x1101, 96000], [0x1100, 48000]]);
    });

    it('fails when the PMT lacks a planned PID', () => {
      const pmtPair = new Map<string, PmtInfo>([
        ['00001', { pmtPid: 0x100, hdmv: true, streams: [video, { pid: 0x1100, streamType: 0x80 }, ac3(0x1101)] }],
        ['00002', { pmtPid: 0x100, hdmv: true, streams: [video, { pid: 0x1100, streamType: 0x80 }] }],
      ]);
      const plan = () => planEpisodes(p, twoProbes(), parseEpisodeSpec('1-', 4), [{ pid: 0x1100 }, { pid: 0x1101 }], pmtPair);
      expect(plan).toThrow(PmtError);
      expect(plan).toThrow(/00002.*0x1101.*0x1011, 0x1100/);
    });

    it('fails when a clip has no PMT', () => {
      expect(() => planEpisodes(p, probes, parseEpisodeSpec('1-', 4), lpcm, new Map([['00001', pmts.get('00001')!]]))).toThrow(/00002/);
    });

    it('plans no audio tracks when none are selected', () => {
      const [ep] = planEpisodes(p, probes, parseEpisodeSpec('1-', 4), [], pmts);
      expect(ep!.segments.map((s) => s.audioTracks)).toEqual([[], []]);
      expect(ep!.audio).toEqual([]);
    });
  });
});
