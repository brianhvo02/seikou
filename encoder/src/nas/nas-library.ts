// SPDX-License-Identifier: LGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discKeyOf } from '@seikou/nas/disc-key';
import type { DiscEntry, DiscManifest, LibraryListing } from '@seikou/nas/nas-api';
import type { AppContext } from '../server/http';
import type { NasClient } from './client';

// The NAS's discs, as the Library lists them: the NAS's folder listing walked from the top, each disc's manifest
// fetched once for its key and playlists, and the result kept in `<data>/nas-library.json`, so a disc whose id and size
// have not changed is not asked for again, and a NAS that cannot be reached still shows its last listing.

/** One disc on the NAS. */
export interface NasDisc {
  /** The NAS's id of the disc, as its disc routes take it. */
  readonly discId: string;
  /** The disc key (`f.<content fingerprint>`), as the encoder's disc routes and records take it. */
  readonly key: string;
  /** The disc's name on the NAS. */
  readonly label: string;
  /** The disc's path in the NAS's library, root-relative. */
  readonly relPath: string;
  /** How many playlists its manifest lists. */
  readonly playlistCount: number;
  /** The disc's size as the NAS's listing gives it; with `discId`, what the cached manifest facts are keyed by. */
  readonly sizeBytes: number;
}

/** `nas-library.json`: the NAS (by API base) the listing came from, and the listing. */
interface SavedListing {
  readonly base: string;
  readonly discs: NasDisc[];
}

/** How many manifests a scan asks for at once. */
const MANIFESTS_AT_ONCE = 4;
/** How long one listing or manifest request may take. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The most folders a scan walks, so a NAS answering with a loop cannot keep it going. */
const MAX_FOLDERS = 10_000;

function validDisc(v: unknown): v is NasDisc {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.discId === 'string' &&
    typeof d.key === 'string' &&
    typeof d.label === 'string' &&
    typeof d.relPath === 'string' &&
    typeof d.playlistCount === 'number' &&
    typeof d.sizeBytes === 'number'
  );
}

async function readSaved(path: string): Promise<SavedListing | null> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as Partial<SavedListing> | null;
    if (typeof v?.base !== 'string' || !Array.isArray(v.discs)) return null;
    return { base: v.base, discs: v.discs.filter(validDisc) };
  } catch {
    return null;
  }
}

/** Every disc of the NAS's library, each once, walking `GET library?path=` from the top. */
async function listAll(client: NasClient): Promise<DiscEntry[]> {
  const discs = new Map<string, DiscEntry>();
  const seen = new Set<string>();
  const queue = [''];
  while (queue.length > 0 && seen.size < MAX_FOLDERS) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const listing = await client.json<LibraryListing>(`library?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    for (const d of listing.discs ?? []) if (!discs.has(d.id)) discs.set(d.id, d);
    for (const f of listing.folders ?? []) if (!seen.has(f.path)) queue.push(f.path);
  }
  return [...discs.values()];
}

/** The NAS's discs for one app: the last listing, and at most one scan at a time. */
export class NasLibrary {
  private listing: SavedListing | null = null;
  private loaded = false;
  private running: Promise<void> | null = null;
  /** The client the running scan lists for. */
  private runningFor: NasClient | null = null;
  private lastReachable: boolean | null = null;

  /** `app` needs only its data folder and NAS holder, so the command line can list the NAS without a backend. */
  constructor(private readonly app: Pick<AppContext, 'dataDir' | 'nas'>) {}

  private get file(): string {
    return join(this.app.dataDir, 'nas-library.json');
  }

  /** Whether a scan is running. */
  get scanning(): boolean {
    return this.running !== null;
  }

  /** Whether the last scan reached the NAS; null before the first scan. */
  get reachable(): boolean | null {
    return this.lastReachable;
  }

  /** Reads `nas-library.json` once, so a NAS that cannot be reached at start still shows its last listing. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.listing ??= await readSaved(this.file);
  }

  /**
   * Walks `GET library?path=` from the top, fetching each disc's manifest once (cached in `<data>/nas-library.json` by
   * disc id and sizeBytes), at most 4 manifests at a time. A disc whose manifest cannot be fetched is left out until a
   * later scan gets it; a NAS that cannot be listed keeps the last listing (`reachable` false). Never rejects.
   */
  scan(): Promise<void> {
    const client = this.app.nas.client;
    // a scan running for an earlier pairing drops what it finds, so a new pairing gets a run of its own
    if (this.running === null || this.runningFor !== client) {
      const run: Promise<void> = this.run(client).finally(() => {
        if (this.running === run) this.running = null;
      });
      this.running = run;
      this.runningFor = client;
    }
    return this.running;
  }

  private async run(client: NasClient | null): Promise<void> {
    await this.load();
    if (client === null) return;
    let entries: DiscEntry[];
    try {
      entries = await listAll(client);
    } catch {
      if (this.app.nas.client === client) this.lastReachable = false;
      return;
    }
    const cached = new Map((this.listing?.base === client.base ? this.listing.discs : []).map((d) => [d.discId, d]));
    const discs: (NasDisc | null)[] = new Array<NasDisc | null>(entries.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length) {
        const i = next++;
        const entry = entries[i]!;
        const known = cached.get(entry.id);
        if (known !== undefined && known.sizeBytes === entry.sizeBytes) {
          discs[i] = { ...known, label: entry.name, relPath: entry.path };
          continue;
        }
        try {
          const manifest = await client.json<DiscManifest>(`discs/${encodeURIComponent(entry.id)}/manifest`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!Array.isArray(manifest.files)) continue;
          discs[i] = {
            discId: entry.id,
            key: discKeyOf(entry.id, manifest.files),
            label: entry.name,
            relPath: entry.path,
            playlistCount: manifest.files.filter((f) => /^BDMV\/PLAYLIST\/[^/]+\.MPLS$/i.test(f.path)).length,
            sizeBytes: entry.sizeBytes,
          };
        } catch {
          // listed nowhere until a later scan fetches its manifest
        }
      }
    };
    await Promise.all(Array.from({ length: MANIFESTS_AT_ONCE }, worker));
    // A pairing replaced meanwhile belongs to another NAS: this listing is not its.
    if (this.app.nas.client !== client) return;
    const listing: SavedListing = {
      base: client.base,
      discs: discs.filter((d): d is NasDisc => d !== null).sort((a, b) => a.relPath.localeCompare(b.relPath) || a.discId.localeCompare(b.discId)),
    };
    this.listing = listing;
    this.lastReachable = true;
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(listing, null, 2)}\n`);
      await rename(tmp, this.file);
    } catch {
      // kept in memory; the next scan writes it again
    }
  }

  /** The discs of the last listing of the NAS the app is paired with now; none while not paired. */
  discs(): readonly NasDisc[] {
    const client = this.app.nas.client;
    if (client === null || this.listing === null || this.listing.base !== client.base) return [];
    return this.listing.discs;
  }

  /** The first disc of the listing with `key`, or null. */
  byKey(key: string): NasDisc | null {
    return this.discs().find((d) => d.key === key) ?? null;
  }

  /** Drops the listing held in memory (the pairing changed; `nas-library.json` is removed or replaced with it). */
  forget(): void {
    this.listing = null;
    this.loaded = false;
    this.lastReachable = null;
  }
}

const libraries = new WeakMap<AppContext, NasLibrary>();

/** The one `NasLibrary` of `app`, made on first use. */
export function nasLibraryOf(app: AppContext): NasLibrary {
  let library = libraries.get(app);
  if (!library) {
    library = new NasLibrary(app);
    libraries.set(app, library);
  }
  return library;
}
