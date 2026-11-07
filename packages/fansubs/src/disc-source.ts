import type { Readable } from 'node:stream';

/** A stream file of a disc, as audio alignment reads it: the bytes of a range. */
export interface FansubClipSource {
  /** Bytes [from, to) of the file as a stream; to the end when `to` is left out. */
  read(from: number, to?: number): Readable;
}

/** One disc's original files, as the fansub audio alignment reads them. Paths are disc-relative and upper-case. */
export interface FansubDiscSource {
  /** A whole file (a playlist or clip info), or null when it is missing. */
  readFile(path: string): Promise<Uint8Array | null>;
  clip(path: string): Promise<FansubClipSource | null>;
}
