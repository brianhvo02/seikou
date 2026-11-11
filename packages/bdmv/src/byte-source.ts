/**
 * Read access to the files of one disc, by path relative to the disc root (such as `BDMV/index.bdmv`). It is the only
 * way the engine touches disc bytes: the engine's `FileSource` serves a picked folder and its `RemoteSource` serves a
 * NAS or disc-server disc. `exists`, `size` and `list` answer synchronously from what the source loaded when it opened.
 */
export interface ByteSource {
  /** True when the disc has a file at `path`. */
  exists(path: string): boolean;
  /** The size of the file at `path` in bytes. */
  size(path: string): number;
  /** File names directly inside `dir`, sorted. */
  list(dir: string): string[];
  /**
   * `length` bytes of the file at `path` from byte `offset`. Aborting `signal` stops the read early and rejects with the
   * signal's reason.
   */
  read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /**
   * A one-off read that starts no read-ahead and leaves where read-ahead goes as it was (a check of a few bytes of a
   * file nothing streams yet). Sources that never read ahead leave it out, and callers use `read`.
   */
  peek?(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * Why a disc failed to open or read: `not-bdmv` (no BDMV folder, or index.bdmv missing or damaged),
 * `multiple-discs` (the picked folder holds more than one), `case-collision` (file names that differ only in case),
 * `missing-file` (a playlist or clip it needs is absent), `source-changed` (the files changed on disk or on the server),
 * `encrypted` (AACS), `unreadable-stream` (a stream that cannot be read or is too large to preload), `read-failed`
 * (a read the source could not complete).
 */
export type DiscErrorCode =
  | 'not-bdmv'
  | 'multiple-discs'
  | 'case-collision'
  | 'missing-file'
  | 'source-changed'
  | 'encrypted'
  | 'unreadable-stream'
  | 'read-failed';

/**
 * A disc failure the player shows the user: `code` says which, `message` is the text shown, `paths` the files concerned.
 * @example ../examples/disc-error.ts#construct
 */
export class DiscError extends Error {
  constructor(
    readonly code: DiscErrorCode,
    message: string,
    readonly paths: readonly string[] = [],
  ) {
    super(message);
    this.name = 'DiscError';
  }
}

/**
 * The whole file at `path`, read in one `read` call.
 * @internal
 */
export function readWhole(source: ByteSource, path: string): Promise<Uint8Array> {
  return source.read(path, 0, source.size(path));
}
