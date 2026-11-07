// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Playlist, PlaylistItem } from '../disc/playlist';
import type { AudioProbe, ClipProbe, VideoProbe } from '../disc/probe';
import { frameAt, framesToNs, sampleAt } from './timing';

/** 1-based inclusive chapter indices; `to: null` runs to the last chapter. */
export interface EpisodeSpec {
  from: number;
  to: number | null;
}

export class EpisodeSpecError extends Error {}

export function parseEpisodeSpec(text: string, chapterCount: number): EpisodeSpec[] {
  if (text.trim() === '') throw new EpisodeSpecError('Episode spec is empty');
  const tokens = text.split(',').map((t) => t.trim());
  const specs: EpisodeSpec[] = [];
  let previousEnd = 0;
  tokens.forEach((token, i) => {
    const m = /^(\d+)(?:(-)(\d*))?$/.exec(token);
    if (!m) throw new EpisodeSpecError(`Invalid episode token "${token}"`);
    const from = Number(m[1]);
    let to: number | null;
    if (m[2] === undefined) to = from;
    else if (m[3] === '') {
      if (i !== tokens.length - 1) throw new EpisodeSpecError(`Open-ended token "${token}" is only allowed last`);
      to = null;
    } else to = Number(m[3]);
    const last = to ?? chapterCount;
    if (from < 1 || last < 1) throw new EpisodeSpecError(`Chapter index in "${token}" must be at least 1`);
    if (from > chapterCount || last > chapterCount) {
      throw new EpisodeSpecError(`Token "${token}" exceeds the ${chapterCount} chapters`);
    }
    if (last < from) throw new EpisodeSpecError(`Token "${token}" is not ascending`);
    if (from <= previousEnd) throw new EpisodeSpecError(`Token "${token}" overlaps or precedes the previous range`);
    previousEnd = last;
    specs.push({ from, to });
  });
  return specs;
}

export interface Segment {
  item: PlaylistItem;
  /** Half-open frame range in the clip. */
  videoFrames: [number, number];
  /** Half-open sample range in the clip. */
  audioSamples: [number, number];
  audioOffsetNs: bigint;
}

export interface EpisodeChapter {
  title: string;
  startNs: bigint;
}

export interface EpisodePlan {
  index: number;
  segments: Segment[];
  chapters: EpisodeChapter[];
  frameCount: number;
  durationNs: bigint;
  video: VideoProbe;
  audio: AudioProbe;
}

function probeOf(probes: Map<string, ClipProbe>, clipId: string): ClipProbe {
  const probe = probes.get(clipId);
  if (!probe) throw new Error(`No probe for clip ${clipId}`);
  return probe;
}

function audioOf(probe: ClipProbe, audioPid: number): AudioProbe {
  const audio = probe.audio.find((a) => a.pid === audioPid);
  if (!audio) throw new Error(`Clip ${probe.clipId} has no audio PID ${audioPid}`);
  return audio;
}

function planEpisode(
  index: number,
  playlist: Playlist,
  probes: Map<string, ClipProbe>,
  audioPid: number,
  startPlaylist45: number,
  endPlaylist45: number,
  firstChapter: number,
  lastChapter: number,
): EpisodePlan {
  const segments: Segment[] = [];
  let video: VideoProbe | undefined;
  let audio: AudioProbe | undefined;
  let itemStart45 = 0;
  for (const item of playlist.items) {
    const itemEnd45 = itemStart45 + (item.outTime45 - item.inTime45);
    if (startPlaylist45 < itemEnd45 && endPlaylist45 > itemStart45) {
      const probe = probeOf(probes, item.clipId);
      const itemAudio = audioOf(probe, audioPid);
      if (!video || !audio) {
        video = probe.video;
        audio = itemAudio;
      } else if (
        probe.video.fpsNum !== video.fpsNum ||
        probe.video.fpsDen !== video.fpsDen ||
        itemAudio.sampleRate !== audio.sampleRate
      ) {
        throw new Error(`Clip ${item.clipId} differs in frame rate or sample rate from the episode's first clip`);
      }
      const lo = Math.max(item.inTime45, startPlaylist45 - itemStart45 + item.inTime45);
      const hi = Math.min(item.outTime45, endPlaylist45 - itemStart45 + item.inTime45);
      const frameEnd = frameAt(item.outTime45, probe.video);
      const sampleEnd = sampleAt(item.outTime45, itemAudio);
      const clampFrame = (t: number): number => Math.min(Math.max(frameAt(t, probe.video), 0), frameEnd);
      const clampSample = (t: number): number => Math.min(Math.max(sampleAt(t, itemAudio), 0), sampleEnd);
      const lead90 = segments.length === 0 ? Math.max(0, itemAudio.firstPts90 - lo * 2) : 0;
      segments.push({
        item,
        videoFrames: [clampFrame(lo), clampFrame(hi)],
        audioSamples: [clampSample(lo), clampSample(hi)],
        audioOffsetNs: (BigInt(lead90) * 1_000_000_000n) / 90000n,
      });
    }
    itemStart45 = itemEnd45;
  }
  if (!video || !audio) throw new Error(`Episode ${index} covers no playlist items`);

  const frameCount = segments.reduce((sum, s) => sum + (s.videoFrames[1] - s.videoFrames[0]), 0);
  const chapters: EpisodeChapter[] = [];
  for (const c of playlist.chapters) {
    if (c.index < firstChapter || c.index > lastChapter) continue;
    let framesBefore = 0;
    for (const s of segments) {
      if (s.item.index === c.itemIndex) {
        const within = frameAt(c.time45, probeOf(probes, s.item.clipId).video) - s.videoFrames[0];
        framesBefore += Math.max(0, within);
        break;
      }
      framesBefore += s.videoFrames[1] - s.videoFrames[0];
    }
    chapters.push({ title: `Chapter ${chapters.length + 1}`, startNs: framesToNs(framesBefore, video) });
  }
  return { index, segments, chapters, frameCount, durationNs: framesToNs(frameCount, video), video, audio };
}

/**
 * An episode runs from its first chapter to the start of the chapter after its last
 * (or the end of the playlist). Chapters between ranges that no spec covers are skipped.
 */
export function planEpisodes(
  playlist: Playlist,
  probes: Map<string, ClipProbe>,
  specs: EpisodeSpec[],
  audioPid: number,
): EpisodePlan[] {
  const chapterCount = playlist.chapters.length;
  return specs.map((spec, i) => {
    const last = spec.to ?? chapterCount;
    const start = playlist.chapters[spec.from - 1].start45;
    const end = last < chapterCount ? playlist.chapters[last].start45 : playlist.duration45;
    return planEpisode(i + 1, playlist, probes, audioPid, start, end, spec.from, last);
  });
}
