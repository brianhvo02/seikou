// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ByteSource } from '@seikou/bdmv/byte-source';
import type { PlayItem } from '@seikou/bdmv/mpls-parser';
import { openMatroska, type MatroskaFile, type MkvTrack, type RangeReader } from '@seikou/matroska';
import { OPUS_NAME } from '../decode/opus-decoder';
import { Timeline, type Chapter } from '../nav/timeline';
import type { AudioTrack, ChannelsLabel } from '../protocol';
import { usToTicks45 } from '../util/time';

// An encoded episode plays through the player's disc session: one play item spanning the file, with no streams in its
// STN (the Matroska tracks are read by EncodePipeline), so the clock, presenter, seeking, chapters and the end work as
// for a playlist.

/** The bytes of `path` in `source` as a Matroska RangeReader. */
export function sourceRangeReader(source: ByteSource, path: string): RangeReader {
  return {
    name: path,
    size: source.size(path),
    read: (offset, length, signal) => source.read(path, offset, length, signal),
  };
}

/** Opens the Matroska file at `path` in `source` for playback. */
export function openEncodeFile(source: ByteSource, path: string, signal?: AbortSignal): Promise<MatroskaFile> {
  return openMatroska(sourceRangeReader(source, path), signal);
}

/** The episode's AV1 video track: the first `V_AV1` track, or null when it has none. */
export function encodeVideoTrack(file: MatroskaFile): MkvTrack | null {
  return file.tracks.find((t) => t.type === 1 && t.codecId === 'V_AV1') ?? null;
}

/** The single play item an encode plays as: clip `EPISODE`, from 0 to its duration, with an empty STN. */
export function encodePlayItem(durationUs: number): PlayItem {
  return {
    clipId: 'EPISODE',
    codecId: 'MKV ',
    connectionCondition: 1,
    stcId: 0,
    inTime: 0,
    outTime: Math.max(1, usToTicks45(durationUs)),
    uoMask: new Uint8Array(8),
    stillMode: 0,
    stillTime: 0,
    isMultiAngle: false,
    angleCount: 1,
    angleClipIds: [],
    stn: { video: [], audio: [], pg: [], ig: [], pipPg: [], secondaryAudio: [], secondaryVideo: [] },
  };
}

/** The timeline of an encode: its one play item, with no marks. */
export function encodeTimeline(item: PlayItem): Timeline {
  return new Timeline([item]);
}

/** The file's chapters as the engine reports them, each with its name when it has one. */
export function encodeChapters(file: MatroskaFile): Chapter[] {
  return file.chapters.map((c, index) => ({ index, startUs: Math.round(c.startMs * 1000), ...(c.name !== null ? { name: c.name } : {}) }));
}

/** The episode's audio tracks in file order: as the engine lists them (index = position + 1) and their TrackEntries. */
export function encodeAudioTracks(file: MatroskaFile, opusPlayable: boolean): { readonly tracks: AudioTrack[]; readonly entries: MkvTrack[] } {
  const entries = file.tracks.filter((t) => t.type === 2);
  const tracks = entries.map((t, i): AudioTrack => {
    const channels = t.audio?.channels ?? 0;
    const label: ChannelsLabel = channels === 1 ? 'mono' : channels === 2 ? 'stereo' : channels > 2 ? 'multichannel' : '';
    return {
      index: i + 1,
      codec: t.codecId === 'A_OPUS' ? OPUS_NAME : t.codecId,
      language: t.language === 'und' ? '' : t.language,
      channels: label,
      playable: opusPlayable && t.codecId === 'A_OPUS',
      ...(t.name ? { name: t.name } : {}),
    };
  });
  return { tracks, entries };
}

/** The audio stream played at open: the first playable track flagged default, else the first playable one, else null. */
export function defaultAudioStream(tracks: readonly AudioTrack[], entries: readonly MkvTrack[]): number | null {
  const playable = tracks.filter((t) => t.playable);
  return (playable.find((t) => entries[t.index - 1]?.isDefault) ?? playable[0])?.index ?? null;
}
