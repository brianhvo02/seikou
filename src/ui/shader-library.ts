import { STORES, withStore } from './db';
import type { ShaderSetDef } from './shader-sets';

/** A shader file the user imported, kept whole in IndexedDB. */
export interface StoredShaderFile {
  /** The file's base name, its key. */
  readonly name: string;
  /** The GLSL text. */
  readonly source: string;
  /** When it was imported, in ms since the epoch. */
  readonly addedAt: number;
}

/** What the app keeps between visits about video shaders: imported files, sets from imported `input.conf` files and the selected set. Every method rejects when IndexedDB fails. */
export interface ShaderLibrary {
  files(): Promise<StoredShaderFile[]>;
  putFiles(files: readonly StoredShaderFile[]): Promise<void>;
  removeFile(name: string): Promise<void>;
  importedSets(): Promise<ShaderSetDef[]>;
  /** Replaces sets of the same name. */
  putImportedSets(sets: readonly ShaderSetDef[]): Promise<void>;
  removeImportedSet(name: string): Promise<void>;
  /** The selected set's name, or null for Off. */
  selected(): Promise<string | null>;
  setSelected(name: string | null): Promise<void>;
}

const SELECTED_KEY = 'shader-selected';

/** The `ShaderLibrary` stored in the `bluray-web` IndexedDB database (`factory` is injectable for tests). */
export function idbShaderLibrary(factory: IDBFactory = indexedDB): ShaderLibrary {
  const getAll = async <T>(store: string): Promise<T[]> =>
    (await withStore<T[]>(factory, store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) ?? [];
  const put = async (store: string, rows: readonly unknown[]): Promise<void> => {
    if (rows.length === 0) return;
    await withStore(factory, store, 'readwrite', (s) => {
      for (const row of rows) s.put(row);
    });
  };
  const del = async (store: string, key: string): Promise<void> => {
    await withStore(factory, store, 'readwrite', (s) => {
      s.delete(key);
    });
  };
  return {
    files: () => getAll<StoredShaderFile>(STORES.shaderFiles),
    putFiles: (files) => put(STORES.shaderFiles, files),
    removeFile: (name) => del(STORES.shaderFiles, name),
    importedSets: () => getAll<ShaderSetDef>(STORES.shaderSets),
    putImportedSets: (sets) => put(STORES.shaderSets, sets),
    removeImportedSet: (name) => del(STORES.shaderSets, name),
    async selected() {
      const row = await withStore<{ key: string; value: string | null } | undefined>(factory, STORES.settings, 'readonly', (s) => s.get(SELECTED_KEY));
      return row?.value ?? null;
    },
    async setSelected(name) {
      await withStore(factory, STORES.settings, 'readwrite', (s) => {
        s.put({ key: SELECTED_KEY, value: name });
      });
    },
  };
}
