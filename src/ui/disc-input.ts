import { walkEntries, type EntryLike } from '@seikou/engine/controller/entry-walk';

/** A picked or dropped folder as `[path, file]` pairs, the paths relative to the folder's parent. */
export type DiscEntries = Array<[string, File]>;

/** Shared boundary: the directory-handle walker and the dropped-entry walker (discFromDataTransfer) descend equally deep. */
const MAX_DEPTH = 6;

/** Lists the files of a folder input (or any file list), using `webkitRelativePath` as the path and the bare name when it is empty. */
export function collectFromFileList(files: Iterable<File>): DiscEntries {
  return [...files].map((f) => [f.webkitRelativePath || f.name, f]);
}

/**
 * Walks a directory handle and reads every file, with paths starting at `prefix`. Folders more than six levels below the
 * starting `depth` are skipped silently. Rejects if the browser refuses a read (for example when permission was revoked).
 */
export async function collectFromDirectoryHandle(handle: FileSystemDirectoryHandle, prefix = handle.name, depth = 0): Promise<DiscEntries> {
  if (depth > MAX_DEPTH) return [];
  const out: DiscEntries = [];
  for await (const [name, entry] of handle.entries()) {
    const path = `${prefix}/${name}`;
    if (entry.kind === 'file') out.push([path, await (entry as FileSystemFileHandle).getFile()]);
    else out.push(...(await collectFromDirectoryHandle(entry as FileSystemDirectoryHandle, path, depth + 1)));
  }
  return out;
}

/** What a drop gives: a live directory handle (Chromium, so the folder can be remembered) or the walked entries (other browsers). */
export type DroppedDisc =
  | { readonly kind: 'handle'; readonly handle: FileSystemDirectoryHandle }
  | { readonly kind: 'entries'; readonly entries: DiscEntries };

/**
 * Turns a drop into a disc: a directory handle when the browser offers one, else the entries of the dropped folder. Returns
 * null when no folder was dropped (plain files). Must be called synchronously from the drop handler: items become unusable
 * after the event returns.
 */
export async function discFromDataTransfer(dt: DataTransfer): Promise<DroppedDisc | null> {
  const items = Array.from(dt.items).filter((item) => item.kind === 'file');
  const handles = items.filter((item) => typeof item.getAsFileSystemHandle === 'function').map((item) => item.getAsFileSystemHandle?.());
  const entries = handles.length > 0 ? [] : items.map((item) => item.webkitGetAsEntry?.() as EntryLike | null | undefined).filter((e): e is EntryLike => !!e);
  for (const promise of handles) {
    const handle = await promise;
    if (handle && handle.kind === 'directory') return { kind: 'handle', handle: handle as FileSystemDirectoryHandle };
  }
  if (!entries.some((e) => e.isDirectory)) return null; // plain files dropped: not a disc folder
  return { kind: 'entries', entries: await walkEntries(entries, MAX_DEPTH) };
}
