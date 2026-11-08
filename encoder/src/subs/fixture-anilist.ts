// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { SourceUnavailable, type Entry, type MetadataSource } from '@seikou/titles/sources';
import type { CoverSource } from '../server/http';

/** The content type of a recorded cover by its extension. */
const COVER_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** What `anilist.json` holds: recorded entries and, per AniList id, the episode titles by episode number. */
interface RecordedAniList {
  readonly entries: readonly Entry[];
  readonly episodes: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Recorded AniList answers read from `<dir>/anilist.json`, for the offline mode and the tests.
 *
 * `source.search` returns the entries (in file order) with a name that contains the query, ignoring case, over the
 * English, romaji and native names and the synonyms; `opts.kind` narrows by kind and the other options are ignored.
 * `source.entry` finds an entry by its full id (`anilist:900101`) or answers null. `episodes.titles` gives the
 * titles by episode number (from 1) of an AniList id, empty when none are recorded. `covers.get` reads a poster
 * from `<dir>/covers/<the URL's file name>` (PNG, JPEG or WebP) without any request, and rejects with
 * `SourceUnavailable` when no such file is recorded.
 *
 * Throws when `anilist.json` is missing or is not valid JSON.
 */
export function fixtureAniList(dir: string): {
  source: MetadataSource;
  episodes: { titles(alId: number): Promise<ReadonlyMap<number, string>> };
  covers: CoverSource;
} {
  const recorded = JSON.parse(readFileSync(join(dir, 'anilist.json'), 'utf8')) as RecordedAniList;
  return {
    source: {
      search: async (query, opts) => {
        const q = query.trim().toLowerCase();
        if (q === '') return [];
        return recorded.entries.filter((e) => {
          if (opts?.kind !== undefined && e.kind !== opts.kind) return false;
          const { english, romaji, native, synonyms } = e.names;
          return [english, romaji, native, ...synonyms].some((n) => n !== null && n.toLowerCase().includes(q));
        });
      },
      entry: async (id) => recorded.entries.find((e) => e.id === id) ?? null,
    },
    episodes: {
      titles: async (alId) =>
        new Map(Object.entries(recorded.episodes[String(alId)] ?? {}).map(([n, title]) => [Number(n), title])),
    },
    covers: {
      get: async (url) => {
        const name = new URL(url).pathname.split('/').pop() ?? '';
        const contentType = COVER_TYPES[extname(name).toLowerCase()];
        if (!/^[\w.-]+$/.test(name) || name.startsWith('.') || contentType === undefined) throw new SourceUnavailable(`no recorded cover for ${url}`);
        try {
          return { contentType, bytes: new Uint8Array(await readFile(join(dir, 'covers', name))) };
        } catch {
          throw new SourceUnavailable(`no recorded cover for ${url}`);
        }
      },
    },
  };
}
