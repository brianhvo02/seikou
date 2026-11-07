import type { PlayItem, StnTable, StreamEntry } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';

/** Audio coding types this build can decode (TrueHD through its AC-3 core, DTS-HD through its DTS core). */
export const PLAYABLE_AUDIO: ReadonlySet<number> = new Set([
  CodingType.LPCM,
  CodingType.AC3,
  CodingType.DTS,
  CodingType.TRUEHD,
  CodingType.EAC3,
  CodingType.DTSHD,
  CodingType.DTSHD_MASTER,
]);

export interface StreamChoice {
  readonly video: StreamEntry | null;
  readonly audio: StreamEntry | null;
  /** 1-based STN position of `audio` (the Blu-ray audio stream number), or null. */
  readonly audioIndex: number | null;
  /** Main-path audio streams present but not decodable (empty when `audio` is set). */
  readonly unsupportedAudio: readonly StreamEntry[];
}

export function chooseStreams(stn: StnTable, playableAudio: ReadonlySet<number> = PLAYABLE_AUDIO): StreamChoice {
  const video = stn.video.find((s) => !s.subPath) ?? null;
  const at = stn.audio.findIndex((s) => !s.subPath && playableAudio.has(s.codingType));
  const audio = at >= 0 ? stn.audio[at] : null;
  return { video, audio, audioIndex: at >= 0 ? at + 1 : null, unsupportedAudio: audio ? [] : stn.audio.filter((s) => !s.subPath) };
}

/** The main-path entry for audio stream number `stream` in this play item, if it has one. */
export function audioEntryFor(item: PlayItem, stream: number | null): StreamEntry | null {
  if (stream === null) return null;
  const entry = item.stn.audio[stream - 1];
  return entry && !entry.subPath ? entry : null;
}

/** The main-path entry for IG stream number `stream` in this play item, if it has one. */
export function igEntryFor(item: PlayItem, stream: number | null): StreamEntry | null {
  if (stream === null) return null;
  const entry = item.stn.ig[stream - 1];
  return entry && entry.streamType !== 2 ? entry : null; // as _find_ig_stream: only type 2 is a sub-path IG
}
