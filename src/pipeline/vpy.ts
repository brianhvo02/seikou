// SPDX-License-Identifier: LGPL-3.0-or-later
import type { EpisodePlan } from '../plan/episodes';

export interface VpyOptions {
  cacheDir: string;
}

/** Python raw strings cannot hold a single quote or end in a backslash-quote; refuse rather than escape. */
function rawPath(p: string): string {
  if (p.includes("'")) throw new Error(`Path cannot be embedded in a VapourSynth script (contains a single quote): ${p}`);
  return `r'${p}'`;
}

const HEADER = ['import vapoursynth as vs', 'core = vs.core', 'parts = []'];
const JOIN = ['clip = parts[0]', 'for p in parts[1:]:', '    clip = clip + p'];

export function buildVideoScript(plan: EpisodePlan, opts: VpyOptions): string {
  const cache = rawPath(opts.cacheDir);
  const lines = [...HEADER];
  for (const seg of plan.segments) {
    lines.push(`c = core.bs.VideoSource(${rawPath(seg.item.m2tsPath)}, cachepath=${cache})`);
    lines.push(`parts.append(c[${seg.videoFrames[0]}:${seg.videoFrames[1]}])`);
  }
  lines.push(...JOIN, 'clip = core.resize.Point(clip, format=vs.YUV420P10)', 'clip.set_output(0)', '');
  return lines.join('\n');
}

export function buildAudioScript(plan: EpisodePlan, opts: VpyOptions): string {
  const cache = rawPath(opts.cacheDir);
  const lines = [...HEADER];
  for (const seg of plan.segments) {
    lines.push(`c = core.bs.AudioSource(${rawPath(seg.item.m2tsPath)}, track=-1, cachepath=${cache})`);
    lines.push(`parts.append(c[${seg.audioSamples[0]}:${seg.audioSamples[1]}])`);
  }
  lines.push(...JOIN, 'clip.set_output(0)', '');
  return lines.join('\n');
}
