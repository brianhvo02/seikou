// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Playlist, PlaylistItem } from '../disc/playlist';
import type { AudioProbe, ClipProbe, VideoProbe } from '../disc/probe';
import { frameAt, framesToNs, sampleAt, videoMs } from './timing';

// The planner turns chapter ranges into per-clip cuts. An episode is a run of chapters; because a
// playlist can span several clips, an episode is a list of segments, one per clip it touches, each
// a frame range of the video and a sample range of the audio. Frame and sample ranges are
// half-open, and both are counted from the clip's first video frame (see `sampleAt`), so the
// video and audio of one segment cover the same stretch of time.

/** 1-based inclusive chapter indices; `to: null` runs to the last chapter. */
export interface EpisodeSpec {
  from: number;
  to: number | null;
}

/** Thrown by `parseEpisodeSpec` for text that is not a valid, ascending, non-overlapping list of chapter ranges. */
export class EpisodeSpecError extends Error {}

/**
 * Parses a comma-separated episode list such as `1-3,4-6,7-`: each token is one chapter (`4`), a
 * range (`1-3`) or, last only, an open range (`7-`) that runs to the final chapter. Ranges must
 * ascend and not overlap; gaps between them are allowed (those chapters belong to no episode).
 * Throws `EpisodeSpecError` otherwise, naming the offending token.
 */
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

/** The part of one episode that lies in one clip. */
export interface Segment {
  item: PlaylistItem;
  /** Half-open frame range in the clip. */
  videoFrames: [number, number];
  /** Half-open sample range in the clip, counted from the clip's first video frame (BestSource's alignment). */
  audioSamples: [number, number];
}

/** A chapter inside an episode's own timeline (it starts at 0 with the episode). */
export interface EpisodeChapter {
  /** `Chapter 1`, `Chapter 2`, ... numbered within the episode. */
  title: string;
  /** Start in nanoseconds from the episode's first frame, on the Matroska millisecond grid of the video blocks. */
  startNs: bigint;
}

/** Everything the encoder needs to cut and mux one episode. */
export interface EpisodePlan {
  /** 1-based position in the spec list. */
  index: number;
  /** In playback order. Every clip of the episode has the same frame rate and sample rate. */
  segments: Segment[];
  chapters: EpisodeChapter[];
  /** Total video frames over all segments. */
  frameCount: number;
  /** `frameCount` frames at the video's rate; the length the MKV's segment duration is given. */
  durationNs: bigint;
  /** Video attributes of the episode's first clip. */
  video: VideoProbe;
  /** The chosen audio stream's attributes in the episode's first clip. */
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
      // BestSource pads or trims the audio so sample 0 is the first video frame, so samples count from
      // the video's first PTS, not the audio's.
      const audioOrigin = { firstPts90: probe.video.firstPts90, sampleRate: itemAudio.sampleRate };
      const sampleEnd = sampleAt(item.outTime45, audioOrigin);
      const clampFrame = (t: number): number => Math.min(Math.max(frameAt(t, probe.video), 0), frameEnd);
      const clampSample = (t: number): number => Math.min(Math.max(sampleAt(t, audioOrigin), 0), sampleEnd);
      segments.push({
        item,
        videoFrames: [clampFrame(lo), clampFrame(hi)],
        audioSamples: [clampSample(lo), clampSample(hi)],
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
    // On the millisecond grid of the video blocks, so a chapter never lands between two frames' timestamps.
    chapters.push({ title: `Chapter ${chapters.length + 1}`, startNs: BigInt(videoMs(framesBefore, video)) * 1_000_000n });
  }
  return { index, segments, chapters, frameCount, durationNs: framesToNs(frameCount, video), video, audio };
}

/**
 * Playlist time, in microseconds rounded to the nearest, of `plan`'s first frame: where the encoded episode's zero
 * falls in the playlist. It differs from the episode's first chapter mark when the mark lies between two frames,
 * since the planner rounds the mark to the nearest frame. `playlist` is the playlist `plan` was made from.
 */
export function firstFramePlaylistUs(playlist: Pick<Playlist, 'items'>, plan: EpisodePlan): number {
  const first = plan.segments[0];
  if (!first) throw new Error(`Episode ${plan.index} has no segments`);
  let itemStart45 = 0;
  for (const item of playlist.items) {
    if (item === first.item) break;
    itemStart45 += item.outTime45 - item.inTime45;
  }
  const { firstPts90, fpsNum, fpsDen } = plan.video;
  // The frame's clip time is firstPts90 + frame * fpsDen / fpsNum seconds; the item's played range starts at inTime45.
  const clipOffsetUs = (((itemStart45 - first.item.inTime45) * 2 + firstPts90) * 1000) / 90;
  return Math.round(clipOffsetUs + (first.videoFrames[0] * fpsDen * 1_000_000) / fpsNum);
}

/**
 * Plans one episode per spec. An episode runs from its first chapter to the start of the chapter
 * after its last (or the end of the playlist). Chapters between ranges that no spec covers are
 * skipped. `probes` holds a probe for every clip the playlist plays, keyed by clip id, and
 * `audioPid` selects the audio stream in each clip. Throws when a probe or the audio PID is
 * missing, or when clips inside one episode differ in frame rate or sample rate (they could not
 * be joined into one stream).
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
