/** Walks `webkitGetAsEntry` trees (the drop API Safari, Firefox and Chrome all share). */

export interface EntryLike { readonly isFile: boolean; readonly isDirectory: boolean; readonly name: string }
export interface FileEntryLike extends EntryLike { file(ok: (file: File) => void, fail?: (err: unknown) => void): void }
export interface DirEntryLike extends EntryLike { createReader(): { readEntries(ok: (entries: EntryLike[]) => void, fail?: (err: unknown) => void): void } }

const fileOf = (e: FileEntryLike): Promise<File> => new Promise((ok, fail) => e.file(ok, fail));

async function childrenOf(dir: DirEntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader();
  const out: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) return out;
    out.push(...batch);
  }
}

/**
 * The files under the entries, with paths joining entry names by `/` from each entry's own name.
 * A directory is read when it is at most `maxDepth` levels below a dropped entry (a dropped folder is level 0).
 */
export async function walkEntries(entries: readonly EntryLike[], maxDepth: number): Promise<Array<[string, File]>> {
  const out: Array<[string, File]> = [];
  const visit = async (entry: EntryLike, path: string, depth: number): Promise<void> => {
    if (entry.isFile) out.push([path, await fileOf(entry as FileEntryLike)]);
    else if (entry.isDirectory && depth <= maxDepth) {
      for (const child of await childrenOf(entry as DirEntryLike)) await visit(child, `${path}/${child.name}`, depth + 1);
    }
  };
  for (const e of entries) await visit(e, e.name, 0);
  return out;
}
