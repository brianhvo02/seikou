// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPlaylist } from '../../src/disc/playlist';
import type { PlaylistItem } from '../../src/disc/playlist';
import { probeClip } from '../../src/disc/probe';
import { parseEpisodeSpec, planEpisodes } from '../../src/plan/episodes';
import type { EpisodePlan, Segment } from '../../src/plan/episodes';
import { buildAudioScript, buildVideoScript } from '../../src/pipeline/vpy';
import { haveTools, toolPaths } from '../helpers/tools';

type SegSpec = [string, number, number] | [string, [number, number], [number, number]];

function planWithSegments(specs: SegSpec[]): EpisodePlan {
  const segments: Segment[] = specs.map(([m2tsPath, a, b]) => ({
    item: { m2tsPath } as PlaylistItem,
    videoFrames: typeof a === 'number' ? [a, b as number] : a,
    audioSamples: typeof a === 'number' ? [0, 0] : (b as [number, number]),
    audioOffsetNs: 0n,
  }));
  return { index: 1, segments } as unknown as EpisodePlan;
}

describe('vpy script generation', () => {
  it('emits the video script for a two-segment episode', () => {
    const s = buildVideoScript(planWithSegments([['/d/00001.m2ts', 0, 96], ['/d/00002.m2ts', 0, 48]]), { cacheDir: '/c' });
    expect(s).toBe([
      'import vapoursynth as vs', 'core = vs.core', 'parts = []',
      "c = core.bs.VideoSource(r'/d/00001.m2ts', cachepath=r'/c')", 'parts.append(c[0:96])',
      "c = core.bs.VideoSource(r'/d/00002.m2ts', cachepath=r'/c')", 'parts.append(c[0:48])',
      'clip = parts[0]', 'for p in parts[1:]:', '    clip = clip + p',
      'clip = core.resize.Point(clip, format=vs.YUV420P10)', 'clip.set_output(0)', ''].join('\n'));
  });

  it('emits the audio script with sample slices', () => {
    expect(buildAudioScript(planWithSegments([['/d/00001.m2ts', [0, 96], [0, 192000]]]), { cacheDir: '/c' }))
      .toContain("c = core.bs.AudioSource(r'/d/00001.m2ts', track=-1, cachepath=r'/c')\nparts.append(c[0:192000])");
  });

  it('rejects paths a raw string cannot hold', () => {
    const plan = planWithSegments([["/d/it's.m2ts", 0, 1]]);
    expect(() => buildVideoScript(plan, { cacheDir: '/c' })).toThrow(Error);
    expect(() => buildAudioScript(planWithSegments([['/d/a.m2ts', [0, 1], [0, 1]]]), { cacheDir: "/c\\'" })).toThrow(Error);
  });
});

describe.skipIf(!haveTools)('with vspipe', () => {
  async function vspipeInfo(build: (plan: EpisodePlan, opts: { cacheDir: string }) => string): Promise<string> {
    const playlist = await loadPlaylist(path.resolve('fixtures/disc1'), '00000');
    const probes = new Map([
      ['00001', await probeClip(playlist.items[0])],
      ['00002', await probeClip(playlist.items[1])],
    ]);
    const [plan] = planEpisodes(playlist, probes, parseEpisodeSpec('1-2,3-4', 4), 4352);
    const cacheDir = path.resolve('.cache/bestsource');
    fs.mkdirSync(cacheDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpy-test-'));
    try {
      const file = path.join(dir, 'script.vpy');
      fs.writeFileSync(file, build(plan, { cacheDir }));
      return execFileSync(toolPaths()!.vspipe, ['--info', file, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reports 96 frames of YUV420P10 for disc1 episode 1', async () => {
    const info = await vspipeInfo(buildVideoScript);
    expect(info).toMatch(/Frames: 96\b/);
    expect(info).toMatch(/Format Name: YUV420P10/);
  }, 120000);

  // The fixture's LPCM audio (stream type 0x80, no HDMV registration descriptor) is misdetected as mp3 by
  // libavformat, so BestSource cannot index it here ("Indexing of ... track #0 failed").
  it.skip('reports 192000 samples for disc1 episode 1', async () => {
    expect(await vspipeInfo(buildAudioScript)).toMatch(/Samples: 192000\b/);
  }, 120000);
});
