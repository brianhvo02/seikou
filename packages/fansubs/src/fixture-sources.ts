// SPDX-License-Identifier: LGPL-3.0-or-later
// Internal to @seikou/fansubs: not part of its public API; importable through the package's subpath for Seikou's own use.
/** Recorded SeaDex and Anime Tosho answers from a folder, for the E2E stand-in and service tests. Original code. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeaDex, SeaDexEntry } from './seadex';
import { TooLargeArchive } from './archive';
import { NotFoundOnTosho, PACK_DOWNLOAD_BYTES } from './tosho';
import type { Tosho, ToshoRelease } from './tosho';

/**
 * Recorded SeaDex and Anime Tosho answers read from a folder, standing in for the network in tests.
 * `<dir>/seadex.json` (alId to entry; `notes` and `comparison` may be missing and read as empty, as the live client's do),
 * `<dir>/tosho.json` (`{ releases }`) and downloads from `<dir>/files/<last path segment>`;
 * a file's font pack is `<dir>/files/pack-<file id>.7z`. Throws when `seadex.json` or `tosho.json` is missing or invalid.
 */
export function fixtureFansubSources(dir: string): { seadex: SeaDex; tosho: Tosho } {
  const recorded = JSON.parse(readFileSync(join(dir, 'seadex.json'), 'utf8')) as Record<string, Partial<SeaDexEntry>>;
  const seadexEntries: Record<string, SeaDexEntry> = {};
  for (const [id, e] of Object.entries(recorded)) seadexEntries[id] = { notes: '', comparison: '', ...e } as SeaDexEntry;
  const releases = (JSON.parse(readFileSync(join(dir, 'tosho.json'), 'utf8')) as { releases: ToshoRelease[] }).releases;
  return {
    seadex: { entry: async (alId) => seadexEntries[String(alId)] ?? null },
    tosho: {
      byHash: async (hash) => releases.find((r) => r.infoHash.toLowerCase() === hash.toLowerCase()) ?? null,
      byId: async (id) => releases.find((r) => r.id === id) ?? null,
      search: async (query) => {
        const q = query.toLowerCase();
        return releases
          .filter((r) => r.title.toLowerCase().includes(q))
          .slice(0, 30)
          .map((r) => ({ ...r, files: [] }));
      },
      download: async (url, _opts, maxBytes = PACK_DOWNLOAD_BYTES) => {
        const path = new URL(url, 'https://x.invalid').pathname;
        const pack = /^\/download\/file\/(\d+)\/attachments$/.exec(path);
        const name = pack ? `pack-${pack[1]}.7z` : decodeURIComponent(path.split('/').pop() ?? '');
        if (name === '' || name.includes('/') || name.startsWith('.')) throw new NotFoundOnTosho(url);
        let data: Buffer;
        try {
          data = readFileSync(join(dir, 'files', name));
        } catch {
          throw new NotFoundOnTosho(url);
        }
        if (data.length > maxBytes) throw new TooLargeArchive(`download over ${maxBytes} bytes`);
        return data;
      },
      fontPackUrl: (fileId) => `https://animetosho.net/download/file/${fileId}/attachments`,
    },
  };
}
