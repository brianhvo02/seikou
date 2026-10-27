import { x264Backend, type EncoderBackend } from './encoder';

/**
 * For tests: libx264 (`x264Backend`) behind a `setpts` filter that moves every frame's PTS before the encoder, as some
 * ffmpeg builds do: ffmpeg 7.1's QSV filters round each PTS down to their frame-rate grid. The encoder then
 * forces its keyframes on the moved PTS and writes the moved PTS and DTS out, as that build does.
 */
export function distortingBackend(expr: string): EncoderBackend {
  return {
    id: 'x264',
    binary: 'ffmpeg',
    args(input) {
      const args = x264Backend.args(input);
      const vf = args.indexOf('-vf') + 1;
      args[vf] = `${args[vf]},setpts=${expr}`;
      return args;
    },
  };
}

/** Every frame `ticks` (90 kHz) earlier, in whatever time base the filter chain has (bwdif halves it). */
export const shiftedBy = (ticks: number): string => `PTS-${ticks}/(90000*TB)`;

/** Every frame down to the grid of `fps` (an expression, such as `30000/1001`) counted from 0: ffmpeg's QSV rounding. */
export const flooredTo = (fps: string): string => `floor(PTS*TB*${fps})/(${fps})/TB`;
