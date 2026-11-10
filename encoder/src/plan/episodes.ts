// SPDX-License-Identifier: LGPL-3.0-or-later
import { audioTrackIndex, pidHex, PmtError, type PmtInfo } from '../disc/pmt';
import { audioRate } from '../disc/stream-codes';
import type { Playlist, PlaylistItem } from '../disc/playlist';
import type { AudioProbe, ClipProbe, VideoProbe } from '../disc/probe';
import type { SelectedAudio } from './audio-streams';
import { frameAt, framesToNs, sampleAt, videoMs } from './timing';

// The planner turns chapter ranges into per-clip cuts. An episode is a run of chapters; because a
// playlist can span several clips, an episode is a list of segments, one per clip it touches, each
// a frame range of the video and a sample range of each chosen audio stream. Frame and sample
// ranges are half-open, and both are counted from the clip's first video frame (see `sampleAt`),
// so the video and audio of one segment cover the same stretch of time.

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

/**
 * The chapter ranges of `text` with open ends closed at `chapterCount`, as JSON; null for a list that does not parse.
 * Two lists with the same value cut a playlist into the same episodes, however they are written.
 */
export function resolvedSpec(text: string, chapterCount: number): string | null {
  let specs: EpisodeSpec[];
  try {
    specs = parseEpisodeSpec(text, chapterCount);
  } catch {
    return null;
  }
  return JSON.stringify(specs.map((s) => [s.from, s.to ?? chapterCount]));
}

/** Whether episode lists `a` and `b` cut a playlist of `chapterCount` chapters into the same episodes; text that does not parse equals only itself. */
export function sameEpisodeList(a: string, b: string, chapterCount: number): boolean {
  if (a === b) return true;
  const ra = resolvedSpec(a, chapterCount);
  return ra !== null && ra === resolvedSpec(b, chapterCount);
}

/** One chosen audio stream within one segment. */
export interface SegmentAudio {
  /** The stream's PID. */
  pid: number;
  /**
   * The stream's 1-based position among the clip's audio streams in its PMT: BestSource's `AudioSource(track=-n)`
   * takes it as `n`. It can differ from clip to clip for the same PID.
   */
  bsTrack: number;
  /** Half-open sample range in the clip at this stream's rate, counted from the clip's first video frame (BestSource's alignment). */
  samples: [number, number];
}

/** The part of one episode that lies in one clip. */
export interface Segment {
  item: PlaylistItem;
  /** Half-open frame range in the clip. */
  videoFrames: [number, number];
  /** PTS of the clip's first video frame (frame 0 of `videoFrames`), in 90 kHz ticks: frame i is presented at this plus i frame durations. */
  videoFirstPts90: number;
  /** One entry per chosen audio stream, in the order the streams were given to `planEpisodes`. */
  audioTracks: SegmentAudio[];
}

/** A chapter inside an episode's own timeline (it starts at 0 with the episode). */
export interface EpisodeChapter {
  /** `Chapter 1`, `Chapter 2`, ... numbered within the episode. */
  title: string;
  /** Start in nanoseconds from the episode's first frame, on the Matroska millisecond grid of the video blocks. */
  startNs: bigint;
  /** The playlist's chapter number (1-based) this chapter is. */
  playlistChapter: number;
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
  /**
   * Each chosen audio stream's attributes in the episode's first clip, in the order the streams were given to
   * `planEpisodes`, except `sampleRate`, which is the rate the stream was given with (the STN's, which the samples
   * are counted at and the decode is checked against) and can differ from the CLPI's.
   */
  audio: AudioProbe[];
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

/** BestSource's track number of `pid` in a clip, from the clip's PMT; a `PmtError` names the clip. */
function bsTrackOf(pmts: Map<string, PmtInfo>, clipId: string, pid: number): number {
  const pmt = pmts.get(clipId);
  if (!pmt) throw new PmtError(`Clip ${clipId}: no PMT was read`);
  try {
    return audioTrackIndex(pmt, pid);
  } catch (e) {
    if (e instanceof PmtError) throw new PmtError(`Clip ${clipId}: ${e.message}`);
    throw e;
  }
}

/**
 * Throws when `item`'s STN entry for `stream` gives it another sample rate than the episode's: the clips could not be
 * joined into one stream at that rate. An item whose STN does not list the PID is taken at the episode's rate.
 */
function checkItemRate(item: PlaylistItem, stream: Pick<SelectedAudio, 'pid' | 'sampleRate'>): void {
  const at = item.audioPids.indexOf(stream.pid);
  if (at < 0) return;
  const code = item.audioRateCodes[at];
  const rate = code === undefined ? undefined : audioRate(code);
  if (rate !== stream.sampleRate) {
    throw new Error(`Clip ${item.clipId}: audio PID ${pidHex(stream.pid)} has sample rate ${rate ?? 'unknown'} Hz in its STN entry, not the episode's ${stream.sampleRate} Hz`);
  }
}

function planEpisode(
  index: number,
  playlist: Playlist,
  probes: Map<string, ClipProbe>,
  streams: readonly Pick<SelectedAudio, 'pid' | 'sampleRate'>[],
  pmts: Map<string, PmtInfo>,
  startPlaylist45: number,
  endPlaylist45: number,
  firstChapter: number,
  lastChapter: number,
): EpisodePlan {
  const segments: Segment[] = [];
  let video: VideoProbe | undefined;
  let audio: AudioProbe[] | undefined;
  let itemStart45 = 0;
  for (const item of playlist.items) {
    const itemEnd45 = itemStart45 + (item.outTime45 - item.inTime45);
    if (overlapsItem(startPlaylist45, endPlaylist45, itemStart45, itemEnd45)) {
      const probe = probeOf(probes, item.clipId);
      // Samples are counted at the rate each stream was given with (the STN's, which the decode is checked against), not the CLPI's.
      const itemAudio = streams.map((st) => ({ ...audioOf(probe, st.pid), sampleRate: st.sampleRate }));
      for (const st of streams) checkItemRate(item, st);
      if (!video || !audio) {
        video = probe.video;
        audio = itemAudio;
      } else if (probe.video.fpsNum !== video.fpsNum || probe.video.fpsDen !== video.fpsDen) {
        throw new Error(`Clip ${item.clipId} differs in frame rate from the episode's first clip`);
      }
      const lo = Math.max(item.inTime45, startPlaylist45 - itemStart45 + item.inTime45);
      const hi = Math.min(item.outTime45, endPlaylist45 - itemStart45 + item.inTime45);
      const frameEnd = frameAt(item.outTime45, probe.video);
      const clampFrame = (t: number): number => Math.min(Math.max(frameAt(t, probe.video), 0), frameEnd);
      const audioTracks = itemAudio.map((a): SegmentAudio => {
        // BestSource pads or trims the audio so sample 0 is the first video frame, so samples count from
        // the video's first PTS, not the audio's.
        const audioOrigin = { firstPts90: probe.video.firstPts90, sampleRate: a.sampleRate };
        const sampleEnd = sampleAt(item.outTime45, audioOrigin);
        const clampSample = (t: number): number => Math.min(Math.max(sampleAt(t, audioOrigin), 0), sampleEnd);
        return { pid: a.pid, bsTrack: bsTrackOf(pmts, item.clipId, a.pid), samples: [clampSample(lo), clampSample(hi)] };
      });
      segments.push({ item, videoFrames: [clampFrame(lo), clampFrame(hi)], videoFirstPts90: probe.video.firstPts90, audioTracks });
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
    chapters.push({ title: `Chapter ${chapters.length + 1}`, startNs: BigInt(videoMs(framesBefore, video)) * 1_000_000n, playlistChapter: c.index });
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
 * skipped. `probes` holds a probe for every clip the specs' episodes play (`episodeItems`), keyed by clip id; `audio`
 * lists the audio streams to cut, by PID, in track order (an empty list cuts no audio), each with
 * the sample rate its samples are counted at: `SelectedAudio.sampleRate`, the STN entry's rate, the
 * same one the decode is checked against, which a clip's CLPI can contradict; `pmts` holds those
 * clips' PMTs (`readPlaylistPmts`), which gives each stream's BestSource track number per clip.
 * Throws when a probe or an audio PID is missing, when clips inside one episode differ in frame
 * rate or a play item's STN entry gives a stream another sample rate (they could not be joined
 * into one stream), and
 * `PmtError` naming the clip and PID when a clip's PMT is missing or lacks a chosen stream.
 */
export function planEpisodes(
  playlist: Playlist,
  probes: Map<string, ClipProbe>,
  specs: EpisodeSpec[],
  audio: readonly Pick<SelectedAudio, 'pid' | 'sampleRate'>[],
  pmts: Map<string, PmtInfo>,
): EpisodePlan[] {
  return specs.map((spec, i) => {
    const { start45, end45, last } = episodeSpan(playlist, spec);
    return planEpisode(i + 1, playlist, probes, audio, pmts, start45, end45, spec.from, last);
  });
}

/** The playlist time an episode spans (45 kHz ticks, `end45` exclusive) and its last chapter. */
function episodeSpan(playlist: Pick<Playlist, 'chapters' | 'duration45'>, spec: EpisodeSpec): { start45: number; end45: number; last: number } {
  const chapterCount = playlist.chapters.length;
  const last = spec.to ?? chapterCount;
  const start45 = playlist.chapters[spec.from - 1].start45;
  const end45 = last < chapterCount ? playlist.chapters[last].start45 : playlist.duration45;
  return { start45, end45, last };
}

/**
 * The play items `spec`'s episode plays, in order: those `planEpisodes` makes its segments of. It needs no probes, so
 * it tells which clips an episode reads before any of them is there.
 */
export function episodeItems(playlist: Pick<Playlist, 'chapters' | 'duration45' | 'items'>, spec: EpisodeSpec): PlaylistItem[] {
  const { start45, end45 } = episodeSpan(playlist, spec);
  const out: PlaylistItem[] = [];
  let itemStart45 = 0;
  for (const item of playlist.items) {
    const itemEnd45 = itemStart45 + (item.outTime45 - item.inTime45);
    if (overlapsItem(start45, end45, itemStart45, itemEnd45)) out.push(item);
    itemStart45 = itemEnd45;
  }
  return out;
}

/** Whether the playlist stretch `[start45, end45)` touches the item played over `[itemStart45, itemEnd45)`. */
function overlapsItem(start45: number, end45: number, itemStart45: number, itemEnd45: number): boolean {
  return start45 < itemEnd45 && end45 > itemStart45;
}

/** A stretch of playlist time, in milliseconds from the playlist's start; `endMs` is exclusive. */
export interface TimeRange {
  startMs: number;
  endMs: number;
}

/**
 * Plans one episode per playlist-time range, cut on the same frames and samples as `planEpisodes` cuts a chapter
 * episode (the range's ends are rounded to the nearest 45 kHz tick, then to frames and samples as chapters are), with
 * no chapters. It is for a stretch of a disc that is no chapter range, such as a short test sample. A range that is
 * empty, backwards, negative or ends after the playlist throws a `RangeError`; the other arguments and errors are
 * those of `planEpisodes`.
 */
export function planRanges(
  playlist: Playlist,
  probes: Map<string, ClipProbe>,
  ranges: readonly TimeRange[],
  audio: readonly Pick<SelectedAudio, 'pid' | 'sampleRate'>[],
  pmts: Map<string, PmtInfo>,
): EpisodePlan[] {
  return ranges.map((range, i) => {
    const start = Math.round(range.startMs * 45);
    const end = Math.round(range.endMs * 45);
    if (!(start >= 0 && end > start && end <= playlist.duration45)) {
      throw new RangeError(`Range ${range.startMs}-${range.endMs} ms is empty or outside the playlist's ${Math.floor(playlist.duration45 / 45)} ms`);
    }
    // No chapter index lies between 1 and 0, so the plan holds no chapters.
    return planEpisode(i + 1, playlist, probes, audio, pmts, start, end, 1, 0);
  });
}
