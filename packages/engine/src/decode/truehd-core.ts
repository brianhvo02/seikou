import { CodingType } from '@seikou/bdmv/stream-types';
import type { AudioUnit } from './audio-decoder';
import { UnsupportedCodecError } from './decoder';

/** PES stream_id_extension of the AC-3 substream inside a Blu-ray TrueHD PID (MLP is 0x72); as in libavformat mpegts.c. */
export const AC3_CORE_EXTENSION = 0x76;
const NO_CORE_LIMIT_US = 2_000_000;

/** Passes only the AC-3 core units of a TrueHD stream. */
export class TrueHdCoreFilter {
  private firstUs: number | null = null;
  private seenCore = false;

  accept(unit: AudioUnit): boolean {
    const core = unit.streamIdExtension === undefined ? unit.data[0] === 0x0b && unit.data[1] === 0x77 : unit.streamIdExtension === AC3_CORE_EXTENSION;
    if (core) {
      this.seenCore = true;
      return true;
    }
    if (!this.seenCore) {
      this.firstUs ??= unit.ptsUs;
      if (unit.ptsUs - this.firstUs >= NO_CORE_LIMIT_US) {
        throw new UnsupportedCodecError(CodingType.TRUEHD, "This TrueHD track has no Dolby Digital core, so it can't be played.");
      }
    }
    return false;
  }

  reset(): void {
    this.firstUs = null;
  }
}
