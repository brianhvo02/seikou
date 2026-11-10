// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readBody } from '../../../server/src/http';
import { listPlaylists, loadPlaylist } from '../disc/playlist';
import { appSettings } from '../subs/app-settings';
import { nasLibraryOf } from '../nas/nas-library';
import { RecordError, RecordStore } from '../subs/record';
import { knownDisc } from './disc-routes';
import { httpError, json, type RouteTable } from './http';
import { libraryOf, type LibraryDisc } from './library';

// The library half of the app's API: the discs under the user's roots, their playlists and chapters, and the roots
// setting.

/** The `root` of a disc on the NAS (local roots are absolute paths, so it never names one). */
export const NAS_ROOT = 'NAS';

/** A library disc as the page sees it: the scan's entry without the folder's path, plus what the page lists it with. */
export interface LibraryDiscAnswer extends Omit<LibraryDisc, 'dir'> {
  /**
   * Where the disc is: a library folder on this machine, or the NAS (then `root` is `NAS` and `relPath` the NAS's
   * path). A key on both is listed once, as the local copy.
   */
  readonly source: 'local' | 'nas';
  /**
   * Other folders that hold a disc with the same key (copies of it, which share a key on purpose); empty for most
   * discs. The disc is listed once, at the folder the disc routes read. Copies on the NAS have root `NAS`.
   */
  readonly otherPaths: readonly { readonly relPath: string; readonly root: string }[];
  /** How many playlists the disc has; 0 when its PLAYLIST folder cannot be read. */
  readonly playlistCount: number;
  /** The playlists (five digits, sorted) that have a saved subtitle record. */
  readonly recordPlaylists: readonly string[];
}

/** The answer of `GET /api/library`. */
export interface LibraryAnswer {
  /** The folders the library is scanned under: the saved ones and those this run was given. */
  readonly roots: readonly string[];
  /** The roots saved in the settings, the ones the page edits. */
  readonly savedRoots: readonly string[];
  /** The roots only this run's command line gave: scanned, never saved, not removable from the page. */
  readonly runRoots: readonly string[];
  /** The roots that could not be read in the last scan (missing, unmounted, no permission); their discs found before stay listed. */
  readonly unreadableRoots: readonly string[];
  /** Whether a scan is running; `discs` is then the last complete scan. */
  readonly scanning: boolean;
  /** The discs, sorted by path under their root: the local ones, then the NAS's. */
  readonly discs: readonly LibraryDiscAnswer[];
  /** The NAS: whether the encoder is paired, whether its listing is being read, and whether the last read reached it (null before the first). */
  readonly nas: { readonly paired: boolean; readonly scanning: boolean; readonly reachable: boolean | null };
}

/** One playlist in `GET /api/discs/<key>/playlists`. */
export interface PlaylistSummary {
  /** Five-digit playlist name. */
  readonly id: string;
  /** Length in milliseconds. */
  readonly durationMs: number;
  /** How many play items the playlist has. */
  readonly clips: number;
  /** How many chapters the playlist has. */
  readonly chapters: number;
  /** At least 20 minutes and at least 4 chapters, or the longest playlist of the disc. */
  readonly likelyMain: boolean;
}

/** One chapter in `GET /api/discs/<key>/playlists/<id>`. */
export interface ChapterAnswer {
  /** 1-based. */
  readonly index: number;
  /** Milliseconds from the start of the playlist. */
  readonly startMs: number;
  /** Milliseconds until the next chapter, or the playlist's end for the last. */
  readonly lengthMs: number;
}

/** The answer of `GET /api/discs/<key>/playlists/<id>`. */
export interface PlaylistAnswer {
  /** Five-digit playlist name. */
  readonly id: string;
  /** Length in milliseconds. */
  readonly durationMs: number;
  /** The chapters in order. */
  readonly chapters: readonly ChapterAnswer[];
  /**
   * The episode list and AniList show of the playlist's saved subtitle record, or null when none is saved. The show
   * leaves out the record's episode offset, which is the release's numbering, not AniList's.
   */
  readonly record: { readonly episodeSpec: string; readonly anilist: { readonly id: number; readonly title: string } | null } | null;
}

/** How long `GET /api/library` waits for the first scan before it answers with an empty list and `scanning`. */
const FIRST_SCAN_WAIT_MS = 1500;

/** Largest body `PUT /api/settings/roots` reads. */
const MAX_ROOTS_BODY = 64 * 1024;

/** The most roots the app keeps. */
const MAX_ROOTS = 50;

const ticksToMs = (ticks45: number): number => Math.round(ticks45 / 45);

/** The playlists of the disc under `dataDir`'s `subtitles/<key>/` that have a saved record, sorted. */
async function recordPlaylists(dataDir: string, key: string): Promise<string[]> {
  try {
    // `path` also checks that the key is a disc key, so no segment can leave `subtitles/`
    const dir = dirname(new RecordStore(dataDir).path(key, '00000'));
    return (await readdir(dir))
      .map((n) => /^(\d{5})\.json$/.exec(n)?.[1])
      .filter((n): n is string => n !== undefined)
      .sort();
  } catch {
    return [];
  }
}

async function playlistCount(dir: string): Promise<number> {
  try {
    return (await readdir(join(dir, 'BDMV', 'PLAYLIST'))).filter((n) => n.endsWith('.mpls')).length;
  } catch {
    return 0;
  }
}

/**
 * The library routes:
 *
 *   GET /api/library                          `LibraryAnswer`; the first request starts the first scan and waits for it
 *                                             for a moment, then answers with what there is and `scanning: true`
 *   POST /api/library/rescan                  starts a scan (or joins the running one); 202 `{ scanning: true }`
 *   PUT /api/settings/roots                   body `{ roots: string[] }`, absolute paths of folders; saves them, starts a
 *                                             scan and answers `{ roots }`; 400 `bad-request` for a malformed body,
 *                                             400 `bad-root` for a path that is not a folder, 413 `too-large`
 *   GET /api/discs/<key>/playlists            `{ playlists: PlaylistSummary[] }`, longest first
 *   GET /api/discs/<key>/playlists/<id>       `PlaylistAnswer`; 400 `bad-request` for an id that is not five digits,
 *                                             404 `not-found` for a missing playlist
 *
 * A disc key the backend does not serve answers 404 `disc-changed`.
 */
export const libraryRoutes: RouteTable = [
  [
    'GET',
    /^\/api\/library$/,
    async (_req, res, _match, app) => {
      const library = libraryOf(app);
      if (!library.scanned) await Promise.race([library.scan(), new Promise<void>((r) => setTimeout(r, FIRST_SCAN_WAIT_MS).unref())]);
      const roots = await library.roots();
      const savedRoots = (await appSettings(app.dataDir).read()).roots;
      const runRoots = roots.filter((r) => !savedRoots.includes(r));
      // one entry per key, at the first folder (the one the disc routes read); the rest are named as other places
      const byKey = new Map<string, LibraryDisc[]>();
      for (const d of library.discs) byKey.set(d.key, [...(byKey.get(d.key) ?? []), d]);
      const local = await Promise.all(
        [...byKey.values()].map(async ([{ dir, ...disc }, ...others]): Promise<LibraryDiscAnswer> => ({
          ...disc,
          source: 'local',
          otherPaths: others.map((o) => ({ relPath: o.relPath, root: o.root })),
          playlistCount: await playlistCount(dir),
          recordPlaylists: await recordPlaylists(app.dataDir, disc.key),
        })),
      );
      // the NAS's discs: a key also here adds the NAS's paths to the local entry; copies on the NAS are listed once
      const nas = nasLibraryOf(app);
      const paired = app.nas.client !== null;
      const nasOthers = new Map<string, { relPath: string; root: string }[]>();
      const nasFirst: LibraryDiscAnswer[] = [];
      for (const d of paired ? nas.discs() : []) {
        const others = nasOthers.get(d.key);
        if (others !== undefined) {
          others.push({ relPath: d.relPath, root: NAS_ROOT });
          continue;
        }
        nasOthers.set(d.key, []);
        if (!byKey.has(d.key)) {
          nasFirst.push({
            key: d.key,
            label: d.label,
            relPath: d.relPath,
            root: NAS_ROOT,
            source: 'nas',
            otherPaths: [],
            playlistCount: d.playlistCount,
            recordPlaylists: await recordPlaylists(app.dataDir, d.key),
          });
        } else nasOthers.get(d.key)!.push({ relPath: d.relPath, root: NAS_ROOT });
      }
      const discs = [...local, ...nasFirst].map((d) => {
        const more = nasOthers.get(d.key) ?? [];
        return more.length === 0 ? d : { ...d, otherPaths: [...d.otherPaths, ...more] };
      });
      const answer: LibraryAnswer = {
        roots,
        savedRoots,
        runRoots,
        unreadableRoots: library.unreadableRoots,
        scanning: library.scanning,
        discs,
        nas: { paired, scanning: nas.scanning, reachable: paired ? nas.reachable : null },
      };
      json(res, 200, answer);
    },
  ],
  [
    'POST',
    /^\/api\/library\/rescan$/,
    async (_req, res, _match, app) => {
      void libraryOf(app).scan();
      json(res, 202, { scanning: true });
    },
  ],
  [
    'PUT',
    /^\/api\/settings\/roots$/,
    async (req, res, _match, app) => {
      const bytes = await readBody(req, MAX_ROOTS_BODY);
      if (bytes === null) {
        res.setHeader('Connection', 'close');
        return httpError(res, 413, 'too-large', 'That request is too large.');
      }
      let roots: unknown;
      try {
        roots = (JSON.parse(bytes.toString('utf8')) as { roots?: unknown } | null)?.roots;
      } catch {
        roots = undefined;
      }
      if (!Array.isArray(roots) || roots.length > MAX_ROOTS || !roots.every((r) => typeof r === 'string' && r !== '' && r.length < 4096)) {
        return httpError(res, 400, 'bad-request', 'The body must be { "roots": [absolute folder paths] }.');
      }
      const chosen: string[] = [];
      for (const given of roots as string[]) {
        if (!isAbsolute(given)) return httpError(res, 400, 'bad-root', `${given} is not an absolute path.`);
        try {
          const real = await realpath(resolve(given));
          if (!(await stat(real)).isDirectory()) throw new Error('not a folder');
          if (!chosen.includes(real)) chosen.push(real);
        } catch {
          return httpError(res, 400, 'bad-root', `${given} is not a folder this app can read.`);
        }
      }
      await appSettings(app.dataDir).write({ roots: chosen });
      const library = libraryOf(app);
      void library.scan();
      json(res, 200, { roots: await library.roots() });
    },
  ],
  [
    'GET',
    /^\/api\/discs\/([^/]+)\/playlists$/,
    async (_req, res, match, app) => {
      const disc = await knownDisc(app, res, match[1]!);
      if (!disc) return;
      const listed = (await listPlaylists(disc.root)).sort((a, b) => b.duration45 - a.duration45 || a.id.localeCompare(b.id));
      const playlists: PlaylistSummary[] = [];
      for (const [i, p] of listed.entries()) {
        let chapters = 0;
        try {
          chapters = (await loadPlaylist(disc.root, p.id)).chapters.length;
        } catch {
          // a playlist that does not load has no chapters to count
        }
        const durationMs = ticksToMs(p.duration45);
        playlists.push({
          id: p.id,
          durationMs,
          clips: p.clipIds.length,
          chapters,
          likelyMain: i === 0 || (durationMs >= 20 * 60_000 && chapters >= 4),
        });
      }
      json(res, 200, { playlists });
    },
  ],
  [
    'GET',
    /^\/api\/discs\/([^/]+)\/playlists\/([^/]+)$/,
    async (_req, res, match, app) => {
      const disc = await knownDisc(app, res, match[1]!);
      if (!disc) return;
      const id = decodeURIComponent(match[2]!);
      if (!/^\d{5}$/.test(id)) return httpError(res, 400, 'bad-request', 'A playlist id is five digits.');
      let playlist;
      try {
        playlist = await loadPlaylist(disc.root, id);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return httpError(res, 404, 'not-found', `The disc has no playlist ${id}.`);
        throw e;
      }
      const durationMs = ticksToMs(playlist.duration45);
      const starts = playlist.chapters.map((c) => Math.min(ticksToMs(c.start45), durationMs));
      const chapters = playlist.chapters.map((c, i): ChapterAnswer => ({ index: c.index, startMs: starts[i]!, lengthMs: (starts[i + 1] ?? durationMs) - starts[i]! }));
      let record: PlaylistAnswer['record'] = null;
      try {
        const saved = await new RecordStore(app.dataDir).read(disc.key, id);
        if (saved !== null) {
          record = { episodeSpec: saved.episodeSpec, anilist: saved.anilist === null ? null : { id: saved.anilist.id, title: saved.anilist.title } };
        }
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
      }
      const answer: PlaylistAnswer = { id, durationMs, chapters, record };
      json(res, 200, answer);
    },
  ],
];
