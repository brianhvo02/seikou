import { CodingType } from '@seikou/bdmv/stream-types';
import { FileSource } from '@seikou/engine/disc/file-source';
import { normalizeDiscPaths } from '@seikou/engine/disc/paths';
import { buildClpi, buildIndex, buildMpls, type MarkSpec, type StreamSpec } from './bdmv-builders';
import { avcAu } from './h264-units';
import { muxM2ts, type MuxUnit } from './ts-muxer';

export const VIDEO_PID = 0x1011;
export const AUDIO_PID = 0x1100;
export const IG_PID = 0x1400;
/** 24 fps in 90 kHz ticks. */
export const FRAME_TICKS_90K = 3750;
/** 5 ms of 48 kHz audio per LPCM PES (450 ticks at 90 kHz). */
export const AUDIO_FRAMES_PER_PES = 240;
const AUDIO_PES_TICKS_90K = 450;
export const CLIP_START_PTS = 900_000;

export interface SyntheticAudioUnit {
  pts: number;
  payload: Uint8Array;
  streamIdExtension?: number;
}

export interface SyntheticAudioStream {
  pid: number;
  codingType: number;
  format?: number;
  lang?: string;
  units: SyntheticAudioUnit[];
}

export interface SyntheticClipSpec {
  clipId: string;
  /** Video access units in decode order, one per frame at 24 fps. */
  videoAus: Uint8Array[];
  /** Indices of key units (IDR or recovery-point I); they become EP-map entries. */
  keyIndices: number[];
  /** 90 kHz PTS of the first displayed frame (even). */
  startPts: number;
  /** Per-unit 90 kHz PTS in decode order, for streams with B-frames. Default: startPts + i * frame duration. */
  pts?: number[];
  /** Per-unit 90 kHz DTS in decode order. Default: equal to the PTS. */
  dts?: number[];
  /** Video coding type in the CLPI and, by default, the STN (default AVC). */
  videoCodingType?: number;
  /** Video format and frame-rate codes of the CLPI and STN entries (default: the stream-attribute defaults, 1080p at 23.976). */
  videoFormat?: number;
  videoRate?: number;
  /** 90 kHz ticks per frame (default: 24 fps, FRAME_TICKS_90K). */
  frameTicks?: number;
  /** Secondary video streams (AVC, one access unit per frame like the primary): multiplexed on their own PIDs and listed in the CLPI and every play item's STN. */
  secondaryVideo?: Array<{ pid: number; videoAus: Uint8Array[] }>;
  /** Audio coding type: LPCM gets a real 440 Hz tone, other types get dummy payloads. Omit for no audio. */
  audio?: number;
  /** Index of one LPCM PES whose header gets a reserved sample-rate code (a corrupt unit). */
  corruptAudioPesIndex?: number;
  /** Multiplex audio this many 90 kHz ticks later than its PTS (video leads audio in the stream), as some discs do. */
  audioMuxLag90k?: number;
  /** Interactive graphics PES payloads (segments, see ig-builders) multiplexed on IG_PID; the playlists get an IG stream entry. */
  igUnits?: Array<{ pts: number; payload: Uint8Array }>;
  /** Several IG streams, each on its own PID, in STN order; replaces `igUnits`. */
  igStreams?: Array<{ pid: number; units: Array<{ pts: number; payload: Uint8Array }> }>;
  /** Replaces `audio` when set: each stream on its own PID, listed in this order in the CLPI and STN. */
  audioStreams?: SyntheticAudioStream[];
  /** PG streams (segments, see pg-builders), each on its own PID, listed in this order in the CLPI and the STN pg table. */
  pgStreams?: SyntheticPgStream[];
}

export interface SyntheticPgStream {
  pid: number;
  lang: string;
  units: Array<{ pts: number; payload: Uint8Array }>;
}

export interface SyntheticPlaylistSpec {
  id: string;
  clipIds: string[];
  /** Video coding type declared in the STN table (default AVC). */
  videoCodingType?: number;
  chapterEverySeconds?: number;
  /** Replaces the chapter marks: any ENTRY / LINK marks, times in 45 kHz clip time. */
  marks?: MarkSpec[];
  /** 8-byte UO mask table of the playlist. */
  uoMask?: number[];
  /** Still mode (1 time, 2 infinite) and time in seconds, by play item index. */
  stills?: Record<number, { mode: number; time?: number }>;
}

/** An IG stream carried in a sub-path clip (an m2ts of its own with only the IG PID); every playlist references it from its first sub-path. */
export interface SyntheticSubPathIg {
  clipId: string;
  pid?: number;
  units: Array<{ pts: number; payload: Uint8Array }>;
}

export interface SyntheticDiscSpec {
  clips: SyntheticClipSpec[];
  /** The IG streams of the play items become entries of stream_type 2 pointing at this sub-path clip (STN subpath 0, subclip 0). */
  subPathIg?: SyntheticSubPathIg;
  playlists: SyntheticPlaylistSpec[];
  /** Adds BDMV/MovieObject.bdmv (see buildMovieObjects) and, optionally, a replacement index. */
  movieObjects?: Uint8Array<ArrayBuffer>;
  index?: Parameters<typeof buildIndex>[0];
}

/** One LPCM PES payload: 48 kHz, 16-bit stereo, 440 Hz at −12 dBFS. */
export function lpcmPayload(frames: number, startFrame: number): Uint8Array {
  const out = new Uint8Array(4 + frames * 4);
  const size = frames * 4;
  out[0] = size >> 8;
  out[1] = size & 0xff;
  out[2] = 0x31; // stereo, 48 kHz
  out[3] = 0x40; // 16-bit
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * (startFrame + i)) / 48_000) * 8192) & 0xffff;
    const o = 4 + i * 4;
    out[o] = v >> 8;
    out[o + 1] = v & 0xff;
    out[o + 2] = v >> 8;
    out[o + 3] = v & 0xff;
  }
  return out;
}

/** LPCM tone PES every 5 ms on `pid`. */
export function lpcmStream(pid: number, seconds: number, opts: { startPts?: number; lang?: string } = {}): SyntheticAudioStream {
  const start = opts.startPts ?? CLIP_START_PTS;
  const count = Math.ceil((seconds * 90_000) / AUDIO_PES_TICKS_90K);
  const units = Array.from({ length: count }, (_, j) => ({ pts: start + j * AUDIO_PES_TICKS_90K, payload: lpcmPayload(AUDIO_FRAMES_PER_PES, j * AUDIO_FRAMES_PER_PES) }));
  return { pid, codingType: CodingType.LPCM, lang: opts.lang, units };
}

/** Placeholder payloads every 5 ms for codecs the unit tests decode with fakes. */
export function dummyAudioStream(pid: number, codingType: number, seconds: number, opts: { startPts?: number; lang?: string; format?: number } = {}): SyntheticAudioStream {
  const start = opts.startPts ?? CLIP_START_PTS;
  const count = Math.ceil((seconds * 90_000) / AUDIO_PES_TICKS_90K);
  const units = Array.from({ length: count }, (_, j) => ({ pts: start + j * AUDIO_PES_TICKS_90K, payload: new Uint8Array(64).fill(0x0b) }));
  return { pid, codingType, lang: opts.lang, format: opts.format, units };
}

/** A clip of fake AVC units (IDR every `keyEvery` frames), optionally with audio. */
export function syntheticClip(clipId: string, seconds: number, opts: { audio?: number; keyEvery?: number; startPts?: number; corruptAudioPesIndex?: number; audioMuxLag90k?: number; frameBytes?: number; audioStreams?: SyntheticAudioStream[]; igUnits?: SyntheticClipSpec['igUnits']; igStreams?: SyntheticClipSpec['igStreams']; pgStreams?: SyntheticPgStream[] } = {},
): SyntheticClipSpec {
  const keyEvery = opts.keyEvery ?? 24;
  const frames = seconds * 24;
  const videoAus: Uint8Array[] = [];
  const keyIndices: number[] = [];
  for (let i = 0; i < frames; i++) {
    const idr = i % keyEvery === 0;
    if (idr) keyIndices.push(i);
    videoAus.push(avcAu({ idr, fill: opts.frameBytes ?? 300 }));
  }
  return { clipId, videoAus, keyIndices, startPts: opts.startPts ?? CLIP_START_PTS, audio: opts.audio, corruptAudioPesIndex: opts.corruptAudioPesIndex, audioMuxLag90k: opts.audioMuxLag90k, audioStreams: opts.audioStreams, igUnits: opts.igUnits, igStreams: opts.igStreams, pgStreams: opts.pgStreams };
}

export function buildSyntheticDisc(spec: SyntheticDiscSpec): Map<string, Uint8Array<ArrayBuffer>> {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  files.set('BDMV/index.bdmv', buildIndex(spec.index ?? { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [{ kind: 'hdmv', movieObjectId: 2 }] }));
  if (spec.movieObjects) files.set('BDMV/MovieObject.bdmv', spec.movieObjects);
  const clips = new Map<string, { video: StreamSpec; secondaryVideo: StreamSpec[]; inTime: number; outTime: number; audio: StreamSpec[]; ig: StreamSpec[]; pg: StreamSpec[] }>();

  for (const clip of spec.clips) {
    const frameTicks = clip.frameTicks ?? FRAME_TICKS_90K;
    const endPts = (clip.pts ? Math.max(...clip.pts) : clip.startPts + (clip.videoAus.length - 1) * frameTicks) + frameTicks;
    const units: Array<MuxUnit & { videoIndex?: number }> = clip.videoAus.map((payload, i) => ({
      pid: VIDEO_PID,
      streamId: 0xe0,
      pts: clip.pts?.[i] ?? clip.startPts + i * frameTicks,
      dts: clip.dts?.[i],
      payload,
      videoIndex: i,
    }));
    for (const sv of clip.secondaryVideo ?? []) {
      sv.videoAus.forEach((payload, i) => units.push({ pid: sv.pid, streamId: 0xe1, pts: clip.startPts + i * frameTicks, payload }));
    }
    const audioStreams: SyntheticAudioStream[] = clip.audioStreams ?? (clip.audio !== undefined ? [legacyAudioStream(clip, endPts)] : []);
    for (const stream of audioStreams) {
      for (const u of stream.units) {
        units.push({ pid: stream.pid, streamId: u.streamIdExtension === undefined ? 0xbd : 0xfd, streamIdExtension: u.streamIdExtension, pts: u.pts, payload: u.payload });
      }
    }
    const igStreams = clip.igStreams ?? (clip.igUnits ? [{ pid: IG_PID, units: clip.igUnits }] : []);
    for (const stream of igStreams) for (const u of stream.units) units.push({ pid: stream.pid, streamId: 0xbd, pts: u.pts, payload: u.payload });
    const pgStreams = clip.pgStreams ?? [];
    for (const stream of pgStreams) for (const u of stream.units) units.push({ pid: stream.pid, streamId: 0xbd, pts: u.pts, payload: u.payload });
    const lag = clip.audioMuxLag90k ?? 0;
    const isAudio = (u: MuxUnit): boolean => u.pid !== VIDEO_PID;
    const muxKey = (u: MuxUnit): number => (u.dts ?? u.pts) + (isAudio(u) ? lag : 0);
    units.sort((a, b) => muxKey(a) - muxKey(b) || (isAudio(a) === isAudio(b) ? a.pid - b.pid : isAudio(a) ? -1 : 1));
    const { bytes, unitSpns } = muxM2ts(units);
    const keySet = new Set(clip.keyIndices);
    const entries = units.flatMap((u, i) =>
      u.videoIndex !== undefined && keySet.has(u.videoIndex) ? [{ pts: Math.floor(u.pts / 2), spn: unitSpns[i] }] : [],
    );
    const audioSpecs = audioStreams.map((s) => ({ pid: s.pid, codingType: s.codingType, format: s.format, lang: s.lang }));
    const videoCodingType = clip.videoCodingType ?? CodingType.AVC;
    const secondaryVideo = (clip.secondaryVideo ?? []).map(({ pid }) => ({ pid, codingType: CodingType.AVC, format: clip.videoFormat, rate: clip.videoRate }));
    const streams: Array<{ pid: number; codingType: number; format?: number; rate?: number }> = [
      { pid: VIDEO_PID, codingType: videoCodingType, format: clip.videoFormat, rate: clip.videoRate },
      ...secondaryVideo,
      ...audioSpecs.map(({ pid, codingType }) => ({ pid, codingType })),
      ...igStreams.map((g) => ({ pid: g.pid, codingType: CodingType.IG })),
      ...pgStreams.map((g) => ({ pid: g.pid, codingType: CodingType.PG })),
    ];
    files.set(`BDMV/STREAM/${clip.clipId}.m2ts`, bytes);
    files.set(
      `BDMV/CLIPINF/${clip.clipId}.clpi`,
      buildClpi({ numSourcePackets: bytes.length / 192, streams, presentationStart: clip.startPts / 2, presentationEnd: endPts / 2, epMaps: [{ pid: VIDEO_PID, entries }] }),
    );
    clips.set(clip.clipId, { video: { pid: VIDEO_PID, codingType: videoCodingType, format: clip.videoFormat, rate: clip.videoRate }, secondaryVideo, inTime: clip.startPts / 2, outTime: endPts / 2, audio: audioSpecs, ig: igStreams.map((g) => ({ pid: g.pid, codingType: CodingType.IG })), pg: pgStreams.map((g) => ({ pid: g.pid, codingType: CodingType.PG, lang: g.lang })) });
  }

  const subIg = spec.subPathIg;
  const subIgPid = subIg?.pid ?? IG_PID;
  if (subIg) {
    const { bytes } = muxM2ts(subIg.units.map((u) => ({ pid: subIgPid, streamId: 0xbd, pts: u.pts, payload: u.payload })));
    const start = Math.min(...subIg.units.map((u) => u.pts));
    files.set(`BDMV/STREAM/${subIg.clipId}.m2ts`, bytes);
    files.set(
      `BDMV/CLIPINF/${subIg.clipId}.clpi`,
      buildClpi({ numSourcePackets: bytes.length / 192, streams: [{ pid: subIgPid, codingType: CodingType.IG }], presentationStart: start / 2, presentationEnd: start / 2 + 45_000, epMaps: [] }),
    );
  }

  for (const playlist of spec.playlists) {
    const marks: MarkSpec[] = playlist.marks ? [...playlist.marks] : [];
    const playItems = playlist.clipIds.map((clipId, index) => {
      const clip = clips.get(clipId);
      if (!clip) throw new Error(`unknown clip ${clipId}`);
      const step = (playlist.chapterEverySeconds ?? 0) * 45_000;
      if (step > 0 && !playlist.marks) for (let t = clip.inTime; t < clip.outTime; t += step) marks.push({ playItemRef: index, time: t });
      return {
        clipId,
        inTime: clip.inTime,
        outTime: clip.outTime,
        connectionCondition: index === 0 ? 1 : 5,
        stillMode: playlist.stills?.[index]?.mode,
        stillTime: playlist.stills?.[index]?.time,
        video: [{ ...clip.video, codingType: playlist.videoCodingType ?? clip.video.codingType }],
        secondaryVideo: clip.secondaryVideo.map((stream) => ({ stream, secondaryAudioRefs: [], pipPgRefs: [] })),
        audio: clip.audio,
        pg: clip.pg,
        ig: subIg ? [{ pid: subIgPid, codingType: CodingType.IG, streamType: 2, subPathId: 0, subClipId: 0 }] : clip.ig,
      };
    });
    files.set(`BDMV/PLAYLIST/${playlist.id}.mpls`, buildMpls({ playItems, marks, uoMask: playlist.uoMask, subPaths: subIg ? [{ type: 3, items: [{ clipId: subIg.clipId, inTime: 0, outTime: 45_000 }] }] : undefined }));
  }
  return files;
}

function legacyAudioStream(clip: SyntheticClipSpec, endPts: number): SyntheticAudioStream {
  const codingType = clip.audio ?? CodingType.LPCM;
  const count = Math.ceil((endPts - clip.startPts) / AUDIO_PES_TICKS_90K);
  const units = Array.from({ length: count }, (_, j) => {
    const payload = codingType === CodingType.LPCM ? lpcmPayload(AUDIO_FRAMES_PER_PES, j * AUDIO_FRAMES_PER_PES) : new Uint8Array(64).fill(0x0b);
    if (j === clip.corruptAudioPesIndex && payload.length > 2) payload[2] = 0x30; // reserved sample-rate code
    return { pts: clip.startPts + j * AUDIO_PES_TICKS_90K, payload };
  });
  return { pid: AUDIO_PID, codingType, units };
}

export function discEntries(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, root = 'Disc'): Array<[string, File]> {
  return [...files].map(([path, bytes]) => [`${root}/${path}`, new File([bytes], path.split('/').pop() ?? path)]);
}

export function syntheticSource(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): FileSource {
  return new FileSource(normalizeDiscPaths(discEntries(files)));
}
