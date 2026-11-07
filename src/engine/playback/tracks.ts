import type { StnTable } from '@seikou/bdmv/mpls-parser';
import { codingName } from '@seikou/bdmv/stream-types';
import type { AudioTrack, ChannelsLabel } from '../protocol';
import { PLAYABLE_AUDIO } from './stream-selection';

/** STN audio_format (libbluray mpls_data.h): 1 mono, 3 stereo, 6 multichannel, 12 stereo + multichannel. */
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

export function audioTracks(stn: StnTable, playable: ReadonlySet<number> = PLAYABLE_AUDIO): AudioTrack[] {
  return stn.audio.map((s, i) => ({
    index: i + 1,
    codec: codingName(s.codingType),
    language: s.lang,
    channels: channelsLabel(s.format),
    playable: !s.subPath && playable.has(s.codingType),
  }));
}
