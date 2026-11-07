// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { EpisodePlan } from '../plan/episodes';

// The encoder never decodes video or audio itself. It writes a small VapourSynth script (.vpy,
// Python) per stream and runs `vspipe` on it; the script opens each clip with the BestSource
// plugin, cuts the planned range and joins the cuts. BestSource decodes frame-accurately by
// indexing the file first (see its README, https://github.com/vapoursynth/bestsource).

/** Options shared by the video and audio script builders. */
export interface VpyOptions {
  /** Directory for BestSource's index files; created by BestSource, not by the encoder. Must not contain a single quote. */
  cacheDir: string;
}

/** Python raw strings cannot hold a single quote or end in a backslash-quote; refuse rather than escape. */
function rawPath(p: string): string {
  if (p.includes("'")) throw new Error(`Path cannot be embedded in a VapourSynth script (contains a single quote): ${p}`);
  return `r'${p}'`;
}

/** Text for a single-quoted Python string literal. */
function pyText(s: string): string {
  return s.replace(/[\\']/g, (ch) => `\\${ch}`);
}

/** BestSource treats cachepath as a filename prefix (index = `<prefix>.<track>.bsindex`), so each clip gets its own. */
function cachePrefix(cacheDir: string, m2tsPath: string): string {
  const hash = createHash('sha1').update(path.resolve(m2tsPath)).digest('hex').slice(0, 12);
  return rawPath(`${cacheDir}/${hash}`);
}

const HEADER = ['import vapoursynth as vs', 'core = vs.core', 'parts = []'];
const JOIN = ['clip = parts[0]', 'for p in parts[1:]:', '    clip = clip + p'];

/**
 * The VapourSynth script that outputs an episode's video: for each segment, BestSource's
 * `VideoSource` on the clip, a frame slice, all joined, then converted to 10-bit 4:2:0
 * (`vs.YUV420P10`) for SVT-AV1. `cachemode=4` has BestSource keep its index under `cachepath`
 * and reuse it on later runs, and `cachepath` is a file prefix, so each clip gets its own prefix.
 * The script raises at run time when a clip has fewer frames than planned, because VapourSynth
 * clamps slices silently and a short clip would shorten the episode. Throws when a path cannot
 * be embedded in a Python raw string.
 */
export function buildVideoScript(plan: EpisodePlan, opts: VpyOptions): string {
  rawPath(opts.cacheDir);
  const lines = [...HEADER];
  for (const seg of plan.segments) {
    const [start, end] = seg.videoFrames;
    lines.push(`c = core.bs.VideoSource(${rawPath(seg.item.m2tsPath)}, cachepath=${cachePrefix(opts.cacheDir, seg.item.m2tsPath)}, cachemode=4)`);
    // VapourSynth slices clamp silently; a clip shorter than planned would shorten the episode and shift chapters.
    lines.push(`if c.num_frames < ${end}: raise RuntimeError('${pyText(seg.item.clipId)}: expected at least ${end} frames, got %d' % c.num_frames)`);
    lines.push(`parts.append(c[${start}:${end}])`);
  }
  lines.push(...JOIN, 'clip = core.resize.Point(clip, format=vs.YUV420P10)', 'clip.set_output(0)', '');
  return lines.join('\n');
}

/**
 * The VapourSynth script that outputs an episode's audio: for each segment, BestSource's
 * `AudioSource` on the clip, a sample slice, all joined. The output stays in the source's sample
 * format and rate. Throws when a path cannot be embedded in a Python raw string.
 */
export function buildAudioScript(plan: EpisodePlan, opts: VpyOptions): string {
  rawPath(opts.cacheDir);
  const lines = [...HEADER];
  for (const seg of plan.segments) {
    const [start, end] = seg.audioSamples;
    // adjustdelay=-1 makes BestSource pad or trim the audio so sample 0 coincides with the file's first
    // video frame; the planner counts samples from the video's first PTS to match, so the MKV needs no
    // audio offset. track=-1 picks the first audio stream; choosing a stream by PID would need a
    // PID-to-track mapping that BestSource does not provide.
    lines.push(`c = core.bs.AudioSource(${rawPath(seg.item.m2tsPath)}, track=-1, adjustdelay=-1, cachepath=${cachePrefix(opts.cacheDir, seg.item.m2tsPath)}, cachemode=4)`);
    // Audio that started before the video was trimmed at the front, so it can end a little short of the
    // video; pad with silence rather than let the slice clamp and drift.
    lines.push(`if c.num_samples < ${end}: c = c + core.std.BlankAudio(clip=c, length=${end} - c.num_samples)`);
    lines.push(`parts.append(c[${start}:${end}])`);
  }
  lines.push(...JOIN, 'clip.set_output(0)', '');
  return lines.join('\n');
}
