/** The only way engine modules touch disc bytes. Later phases add ISO (UDF) and AACS implementations. */
export interface ByteSource {
  exists(path: string): boolean;
  size(path: string): number;
  /** File names directly inside `dir`, sorted. */
  list(dir: string): string[];
  /** Aborting `signal` stops the read early and rejects with the signal's reason. */
  read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export type DiscErrorCode =
  | 'not-bdmv'
  | 'multiple-discs'
  | 'case-collision'
  | 'missing-file'
  | 'source-changed'
  | 'encrypted'
  | 'unreadable-stream'
  | 'read-failed';

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

export function readWhole(source: ByteSource, path: string): Promise<Uint8Array> {
  return source.read(path, 0, source.size(path));
}
