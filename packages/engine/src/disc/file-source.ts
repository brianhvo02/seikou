import { DiscError, type ByteSource } from '@seikou/bdmv/byte-source';

/** ByteSource over picked files. Blob.slice() reads only the requested range from disk. */
export class FileSource implements ByteSource {
  constructor(private readonly files: ReadonlyMap<string, Blob>) {}

  /** Whether a file with that path exists (case-insensitive). */
  exists(path: string): boolean {
    return this.files.has(path.toUpperCase());
  }

  /** The file's size in bytes; throws `DiscError` `missing-file` when it is not there. */
  size(path: string): number {
    return this.get(path).size;
  }

  /** The normalised (upper-case) paths of every file. */
  paths(): string[] {
    return [...this.files.keys()];
  }

  /** The names directly inside `dir` (files only, no deeper paths), sorted, upper case. */
  list(dir: string): string[] {
    const prefix = `${dir.toUpperCase().replace(/\/$/, '')}/`;
    const names: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest !== '' && !rest.includes('/')) names.push(rest);
    }
    return names.sort();
  }

  /**
   * The bytes at `offset`, at most `length` (fewer at the end of the file, none past it). Throws `RangeError` for a
   * negative or fractional offset and `DiscError` `missing-file`, `source-changed` (the browser says the file changed on
   * disk) or `read-failed`; an abort rejects with the signal's reason.
   */
  async read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`invalid read offset ${offset} in ${path}`); // Blob.slice would count from the end
    const blob = this.get(path);
    const end = Math.min(offset + length, blob.size);
    if (offset >= end) return new Uint8Array(0);
    signal?.throwIfAborted();
    try {
      // arrayBuffer() cannot be cancelled; a stream can, and measured as fast in Chrome (200 MB in ~90 ms either way).
      const slice = blob.slice(offset, end);
      return signal ? await readStream(slice, end - offset, signal) : new Uint8Array(await slice.arrayBuffer());
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (err instanceof DOMException && err.name === 'NotReadableError') {
        throw new DiscError('source-changed', 'The disc folder changed on disk. Please reopen it.', [path]);
      }
      throw new DiscError('read-failed', `Failed to read ${path}: ${String(err)}`, [path]);
    }
  }

  private get(path: string): Blob {
    const blob = this.files.get(path.toUpperCase());
    if (!blob) throw new DiscError('missing-file', `Missing file ${path}`, [path]);
    return blob;
  }
}

async function readStream(blob: Blob, size: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = blob.stream().getReader();
  const abort = (): void => void reader.cancel().catch(() => undefined); // stops further disk reads
  signal.addEventListener('abort', abort, { once: true });
  try {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, size - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
    if (filled === size) void reader.cancel().catch(() => undefined); // release the stream if it has more
    signal.throwIfAborted(); // a cancelled reader just reports done
    return filled === size ? out : out.subarray(0, filled);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
