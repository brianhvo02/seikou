import { walkEntries, type EntryLike } from '@seikou/engine/controller/entry-walk';

export type DiscEntries = Array<[string, File]>;

/** Shared boundary: the directory-handle walker and the dropped-entry walker (discFromDataTransfer) descend equally deep. */
const MAX_DEPTH = 6;

export function collectFromFileList(files: Iterable<File>): DiscEntries {
  return [...files].map((f) => [f.webkitRelativePath || f.name, f]);
}

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

export type DroppedDisc =
  | { readonly kind: 'handle'; readonly handle: FileSystemDirectoryHandle }
  | { readonly kind: 'entries'; readonly entries: DiscEntries };

/** Must be called synchronously from the drop handler: items become unusable after the event returns. */
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
