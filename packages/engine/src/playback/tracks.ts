import type { StnTable } from '@seikou/bdmv/mpls-parser';
import { codingName } from '@seikou/bdmv/stream-types';
import type { AudioTrack, ChannelsLabel } from '../protocol';
import { PLAYABLE_AUDIO } from './stream-selection';

/** A short channel layout label from an STN `audio_format` value (libbluray `mpls_data.h`): 1 mono, 3 stereo, 6 multichannel, 12 stereo and multichannel; empty for any other. */
export function channelsLabel(format: number): ChannelsLabel {
  switch (format) {
    case 1:
      return 'mono';
    case 3:
      return 'stereo';
    case 6:
    case 12:
      return 'multichannel';
    default:
      return '';
  }
}

/**
 * The audio tracks of an STN table for the UI, numbered from 1 in table order (the number is the PSR1 stream number).
 * A track is `playable` when it is on the main path and its coding type is in `playable`.
 */
export function audioTracks(stn: StnTable, playable: ReadonlySet<number> = PLAYABLE_AUDIO): AudioTrack[] {
  return stn.audio.map((s, i) => ({
    index: i + 1,
    codec: codingName(s.codingType),
    language: s.lang,
    channels: channelsLabel(s.format),
    playable: !s.subPath && playable.has(s.codingType),
  }));
}
