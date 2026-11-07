// SPDX-License-Identifier: LGPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import { loadPlaylist, type Playlist } from '../../src/disc/playlist';
import { probeClip, type ClipProbe } from '../../src/disc/probe';
import { EpisodeSpecError, parseEpisodeSpec, planEpisodes } from '../../src/plan/episodes';

let p: Playlist;
let probe00001: ClipProbe;
let probe00002: ClipProbe;
let probes: Map<string, ClipProbe>;

beforeAll(async () => {
  p = await loadPlaylist('fixtures/disc1', '00000');
  probe00001 = await probeClip(p.items[0]);
  probe00002 = await probeClip(p.items[1]);
  probes = new Map([
    ['00001', probe00001],
    ['00002', probe00002],
  ]);
});

function plansFor(spec: string, chapterTimes45: number[]) {
  const playlist = {
    id: '00000',
    discDir: 'fixtures/disc1',
    items: [
      { index: 0, clipId: '00001', inTime45: 450000, outTime45: 630000, videoPid: 4113, audioPids: [4352] },
    ],
    chapters: chapterTimes45.map((t, i) => ({ index: i + 1, itemIndex: 0, time45: t, start45: t - 450000 })),
    duration45: 180000,
  } as unknown as Playlist;
  return planEpisodes(playlist, new Map([['00001', probe00001]]), parseEpisodeSpec(spec, chapterTimes45.length), 4352);
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
    const plans = planEpisodes(p, probes, parseEpisodeSpec('1-2,3-4', 4), 4352);
    expect(plans.map((e) => e.segments.map((s) => [s.item.clipId, s.videoFrames, s.audioSamples])))
      .toEqual([[['00001', [0, 96], [0, 192000]]], [['00002', [0, 96], [0, 192000]]]]);
    expect(plans[0].chapters).toEqual([{ title: 'Chapter 1', startNs: 0n }, { title: 'Chapter 2', startNs: 2002000000n }]);
    expect(plans[0].frameCount).toBe(96);
    expect(plans[0].durationNs).toBe(4004000000n);
  });

  it('spans two clips when an episode crosses an item boundary', () => {
    // spec '1-3,4-': episode 1 = item 0 whole + item 1 frames [0,48); episode 2 = item 1 frames [48,96)
    const plans = planEpisodes(p, probes, parseEpisodeSpec('1-3,4-', 4), 4352);
    expect(plans[0].segments.map((s) => [s.item.clipId, s.videoFrames])).toEqual([['00001', [0, 96]], ['00002', [0, 48]]]);
    expect(plans[1].segments.map((s) => [s.item.clipId, s.videoFrames, s.audioSamples])).toEqual([['00002', [48, 96], [96000, 192000]]]);
    expect(plans[0].chapters.map((c) => c.startNs)).toEqual([0n, 2002000000n, 4004000000n]);
  });

  it('counts audio samples from the video start whether the audio starts late or early', () => {
    // BestSource (adjustdelay=-1) already aligns audio sample 0 to the first video frame.
    for (const firstPts90 of [901800, 898200]) {
      const shifted = { ...probe00001, audio: [{ ...probe00001.audio[0], firstPts90 }] };
      const [ep] = planEpisodes(p, new Map([['00001', shifted], ['00002', probe00002]]), parseEpisodeSpec('1-2', 4), 4352);
      expect(ep.segments[0].audioSamples).toEqual([0, 192000]);
      expect(Object.keys(ep.segments[0]).sort()).toEqual(['audioSamples', 'item', 'videoFrames']);
    }
  });

  it('skips chapters between ranges that no spec covers', () => {
    const plans = planEpisodes(p, probes, parseEpisodeSpec('1-2,4-', 4), 4352);
    expect(plans.map((e) => e.segments.map((s) => [s.item.index, s.videoFrames]))).toEqual([[[0, [0, 96]]], [[1, [48, 96]]]]);
    expect(plans[0].chapters.map((c) => c.startNs)).toEqual([0n, 2002000000n]);
    expect(plans[1].chapters.map((c) => c.startNs)).toEqual([0n]);
  });

  it('rounds a mark to the nearest frame and puts the chapter on the millisecond block grid', () => {
    // 1000 ticks at 45 kHz = 22.2 ms rounds to frame 1 (41.708 ms), whose block timestamp is 42 ms.
    expect(plansFor('1-', [450000, 451000])[0].chapters[1].startNs).toBe(42000000n);
  });

  it('throws naming the clip and PID when the audio PID is missing', () => {
    expect(() => planEpisodes(p, probes, parseEpisodeSpec('1-', 4), 9999)).toThrow(/00001.*9999/);
  });
});
