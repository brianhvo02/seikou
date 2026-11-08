// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceAtomically } from '@seikou/titles';

/** What the app keeps between runs. */
export interface AppSettings {
  /** The library folders: absolute paths of the folders the disc library is scanned under. */
  readonly roots: readonly string[];
}

/** The app's settings file, `<data>/settings.json`. */
export interface AppSettingsFile {
  /** The saved settings; a missing, unreadable or malformed file reads as no roots. */
  read(): Promise<AppSettings>;
  /** Saves `settings`, replacing the file atomically. */
  write(settings: AppSettings): Promise<void>;
}

/** The settings file in the data directory `dataDir` (created on the first write). */
export function appSettings(dataDir: string): AppSettingsFile {
  const file = join(dataDir, 'settings.json');
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
        const roots = typeof parsed === 'object' && parsed !== null ? (parsed as { roots?: unknown }).roots : undefined;
        return { roots: Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string') : [] };
      } catch {
        return { roots: [] };
      }
    },
    async write(settings) {
      await mkdir(dataDir, { recursive: true });
      replaceAtomically(file, `${JSON.stringify({ roots: [...settings.roots] }, null, 2)}\n`);
    },
  };
}
