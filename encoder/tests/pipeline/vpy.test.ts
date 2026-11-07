// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPlaylist } from '../../src/disc/playlist';
import type { PlaylistItem } from '../../src/disc/playlist';
import { probeClip } from '../../src/disc/probe';
import { parseEpisodeSpec, planEpisodes } from '../../src/plan/episodes';
import type { EpisodePlan, Segment } from '../../src/plan/episodes';
import { buildAudioScript, buildSpeechAudioScript, buildVideoScript } from '../../src/pipeline/vpy';
import { haveTools, toolPaths } from '../helpers/tools';
import { fx } from '../paths';

type SegSpec = [string, number, number] | [string, [number, number], [number, number]];

function planWithSegments(specs: SegSpec[]): EpisodePlan {
  const segments: Segment[] = specs.map(([m2tsPath, a, b]) => ({
    item: { m2tsPath, clipId: clipIdOf(m2tsPath) } as PlaylistItem,
    videoFrames: typeof a === 'number' ? [a, b as number] : a,
    audioSamples: typeof a === 'number' ? [0, 0] : (b as [number, number]),
  }));
  return { index: 1, segments } as unknown as EpisodePlan;
}

const prefix = (p: string): string => `/c/${createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 12)}`;
const clipIdOf = (m2tsPath: string): string => path.basename(m2tsPath, '.m2ts');

describe('vpy script generation', () => {
  it('emits the video script for a two-segment episode', () => {
    const s = buildVideoScript(planWithSegments([['/d/00001.m2ts', 0, 96], ['/d/00002.m2ts', 0, 48]]), { cacheDir: '/c' });
    expect(s).toBe([
      'import vapoursynth as vs', 'core = vs.core', 'parts = []',
      `c = core.bs.VideoSource(r'/d/00001.m2ts', cachepath=r'${prefix('/d/00001.m2ts')}', cachemode=4)`,
      "if c.num_frames < 96: raise RuntimeError('00001: expected at least 96 frames, got %d' % c.num_frames)",
      'parts.append(c[0:96])',
      `c = core.bs.VideoSource(r'/d/00002.m2ts', cachepath=r'${prefix('/d/00002.m2ts')}', cachemode=4)`,
      "if c.num_frames < 48: raise RuntimeError('00002: expected at least 48 frames, got %d' % c.num_frames)",
      'parts.append(c[0:48])',
      'clip = parts[0]', 'for p in parts[1:]:', '    clip = clip + p',
      'clip = core.resize.Point(clip, format=vs.YUV420P10)', 'clip.set_output(0)', ''].join('\n'));
  });

  it('emits the audio script with explicit alignment, a silence pad and sample slices', () => {
    expect(buildAudioScript(planWithSegments([['/d/00001.m2ts', [0, 96], [96000, 192000]]]), { cacheDir: '/c' }))
      .toContain([
        `c = core.bs.AudioSource(r'/d/00001.m2ts', track=-1, adjustdelay=-1, cachepath=r'${prefix('/d/00001.m2ts')}', cachemode=4)`,
        'if c.num_samples < 192000: c = c + core.std.BlankAudio(clip=c, length=192000 - c.num_samples)',
        'parts.append(c[96000:192000])',
      ].join('\n'));
  });

  it('emits the same audio for alignment as for the encode, without a format conversion', () => {
    const plan = planWithSegments([['/d/00001.m2ts', [0, 96], [0, 96000]], ['/d/00002.m2ts', [0, 48], [10, 48010]]]);
    const s = buildSpeechAudioScript(plan, { cacheDir: '/c' });
    expect(s).toBe(buildAudioScript(plan, { cacheDir: '/c' }));
    expect(s).not.toMatch(/resample|AudioConvert|format=/i);
    expect(() => buildSpeechAudioScript(plan, { cacheDir: "/c'" })).toThrow(Error);
  });

  it('rejects paths a raw string cannot hold', () => {
    const plan = planWithSegments([["/d/it's.m2ts", 0, 1]]);
    expect(() => buildVideoScript(plan, { cacheDir: '/c' })).toThrow(Error);
    expect(() => buildAudioScript(planWithSegments([['/d/a.m2ts', [0, 1], [0, 1]]]), { cacheDir: "/c\\'" })).toThrow(Error);
  });
});

describe.skipIf(!haveTools)('with vspipe', () => {
  type Build = (plan: EpisodePlan, opts: { cacheDir: string }) => string;

  async function vspipeInfo(build: Build, tweak: (plan: EpisodePlan) => EpisodePlan = (x) => x): Promise<string> {
    const playlist = await loadPlaylist(fx('fixtures/disc1'), '00000');
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
      fs.writeFileSync(file, build(tweak(plan), { cacheDir }));
      return execFileSync(toolPaths()!.vspipe, ['--info', file, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const extend = (field: 'videoFrames' | 'audioSamples', extra: number) => (plan: EpisodePlan): EpisodePlan => ({
    ...plan,
    segments: plan.segments.map((seg) => ({ ...seg, [field]: [seg[field][0], seg[field][1] + extra] })),
  });

  it('reports 96 frames of YUV420P10 for disc1 episode 1', async () => {
    const info = await vspipeInfo(buildVideoScript);
    expect(info).toMatch(/Frames: 96\b/);
    expect(info).toMatch(/Format Name: YUV420P10/);
  }, 120000);

  it('reports 192000 samples for disc1 episode 1', async () => {
    expect(await vspipeInfo(buildAudioScript)).toMatch(/Samples: 192000\b/);
  }, 120000);

  it('fails naming the clip when the video clip is shorter than planned', async () => {
    let stderr = '';
    try {
      await vspipeInfo(buildVideoScript, extend('videoFrames', 10));
    } catch (e) {
      stderr = String((e as { stderr?: unknown }).stderr);
    }
    expect(stderr).toMatch(/00001: expected at least 106 frames, got 96/);
  }, 120000);

  it('pads the audio with silence when it is shorter than planned', async () => {
    expect(await vspipeInfo(buildAudioScript, extend('audioSamples', 1000))).toMatch(/Samples: 193000\b/);
  }, 120000);
});
