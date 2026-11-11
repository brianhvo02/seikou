import { readFileSync } from 'node:fs';
import { opendir, rename, stat, writeFile } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import type { DiscEntry, FolderEntry } from '@seikou/nas/nas-api';
import { discId } from './disc-id';
import { isoDiscTree, readIsoTree } from './iso';
import { readFolderEvidence, readIsoEvidence } from './titles/evidence';
import type { DiscEvidence } from './titles/evidence';

const MAX_DEPTH = 6;
/** A disc whose files changed within this long is still downloading and is left out of the library. */
export const SETTLE_MS = 3_600_000;
const SKIPPED = new Set(['bk', 'lost+found']);

/** Test hooks and the scan's pace. */
export interface LibraryOptions {
  /** Injected for tests. */
  opendir?: (path: string) => Promise<Dir>;
  /** Pause between directory reads, which keeps a scan gentle on disks that ignore ionice. Default 10. */
  scanPauseMs?: number;
  /** Injected for tests: the current time in ms. Default `Date.now`. */
  now?: () => number;
}

interface Node {
  folders: Map<string, FolderEntry>;
  discs: DiscEntry[];
}

interface LibraryRoot {
  name: string;
  dir: string;
  group?: string;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'ja');
const inRoot = (d: DiscEntry, root: string): boolean => d.path === root || d.path.startsWith(`${root}/`);

/** The next `at` (default 04:00) strictly after `now`, in server local time. */
export function nextNightly(now: Date, at: { hour: number; minute: number } = { hour: 4, minute: 0 }): Date {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.hour, at.minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * The disc library: scans the configured roots (folders with BDMV, and `.iso` files read through the UDF reader), keeps the
 * discs and their evidence in a cache file, and answers listings from the last completed scan while the next one runs.
 * A disc still changing (see `SETTLE_MS`) is left out, and a root that is missing or empty keeps its earlier discs.
 */
export class Library {
  private tree = buildTree([]);
  private byId = new Map<string, DiscEntry>();
  /** Evidence of the installed discs, by id. */
  private evidenceById = new Map<string, DiscEvidence>();
  private evidenceList: { readonly from: ReadonlyMap<string, DiscEvidence>; readonly list: readonly DiscEvidence[] } | null = null;
  /** During a scan: the evidence it started with, and what it has gathered so far. */
  private previousEvidence = new Map<string, DiscEvidence>();
  private nextEvidence = new Map<string, DiscEvidence>();
  private readonly scannedListeners: (() => void)[] = [];
  private running: Promise<void> | null = null;
  private readonly open: (path: string) => Promise<Dir>;
  private readonly pauseMs: number;
  private readonly now: () => number;
  private reads = 0;
  /** Roots the last completed scan found unreadable or empty (kept with their earlier discs); `missingNext` during a scan. */
  private missing = new Set<string>();
  private missingNext = new Set<string>();
  /** Ids of `.iso` files whose UDF tree has no BDMV/INDEX.BDMV (or that aren't UDF), so a rescan doesn't read them again. */
  private readonly notDiscs = new Set<string>();

  constructor(
    private readonly roots: readonly { name: string; dir: string; group?: string }[],
    private readonly cacheFile: string,
    options: LibraryOptions = {},
  ) {
    this.open = options.opendir ?? opendir;
    this.pauseMs = options.scanPauseMs ?? 10;
    this.now = options.now ?? Date.now;
    try {
      const cached: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached)) {
        const discs: DiscEntry[] = [];
        const evidence = new Map<string, DiscEvidence>();
        for (const e of cached) {
          if (!this.valid(e)) continue;
          // Each cached disc carries its evidence; an older cache has none, and the next scan reads it.
          const { evidence: ev, ...disc } = e as DiscEntry & { evidence?: unknown };
          discs.push(disc);
          if (validEvidence(ev, disc)) evidence.set(disc.id, ev);
        }
        this.install(discs, evidence);
      }
    } catch {
      // No usable cache: the first scan fills it.
    }
  }

  /** Whether a scan is running now. */
  get scanning(): boolean {
    return this.running !== null;
  }

  /** The folders and discs directly under `path` (empty for the top level; else a root's or group's name, then subfolders); null when there is no such folder. */
  list(path: string): { folders: FolderEntry[]; discs: DiscEntry[] } | null {
    const key = path.replace(/\/+$/, '');
    // A group's folders are listed under the group's name, and merge those of its roots, plus a real top-level folder
    // of the same name in an ungrouped root.
    const slash = key.indexOf('/');
    const head = slash < 0 ? key : key.slice(0, slash);
    if (key !== '' && this.roots.some((r) => r.group === head)) {
      const rest = slash < 0 ? '' : key.slice(slash);
      const members = this.groupBases(head).flatMap((base) => {
        const node = this.tree.get(`${base}${rest}`);
        return node ? [{ base, node }] : [];
      });
      if (members.length === 0) return null;
      return {
        folders: mergeFolders(members.flatMap((m) => [...m.node.folders.values()].map((f) => ({ ...f, path: `${head}${f.path.slice(m.base.length)}` })))),
        discs: members.flatMap((m) => m.node.discs).sort(byName),
      };
    }
    // The top level shows the children of every ungrouped root, merged, and one folder per group.
    const nodes = key === '' ? this.roots.filter((r) => r.group === undefined).map((r) => this.tree.get(r.name)) : [this.tree.get(key)];
    if (key !== '' && !nodes[0]) return null;
    const present = nodes.filter((n): n is Node => n !== undefined);
    let folders = present.flatMap((n) => [...n.folders.values()]);
    if (key === '') {
      for (const group of new Set(this.roots.flatMap((r) => (r.group === undefined ? [] : [r.group])))) {
        const inGroup = this.groupBases(group).map((base) => this.tree.get(base)).filter((n): n is Node => n !== undefined);
        const discs = inGroup.reduce((sum, n) => sum + n.discs.length + [...n.folders.values()].reduce((s, f) => s + f.discs, 0), 0);
        // A real folder with the group's name is part of the group folder, not a second one.
        folders = folders.filter((f) => f.name !== group);
        if (discs > 0) folders.push({ name: group, path: group, discs });
      }
    }
    return { folders: folders.sort(byName), discs: present.flatMap((n) => n.discs).sort(byName) };
  }

  /** Tree keys whose children make up a group's folder: its roots, and a same-named top-level folder of an ungrouped root. */
  private groupBases(group: string): string[] {
    return this.roots.map((r) => (r.group === group ? r.name : r.group === undefined ? `${r.name}/${group}` : null)).filter((b): b is string => b !== null);
  }

  /** The evidence of every listed disc whose evidence has been read: the same list until a scan installs new evidence. */
  evidence(): readonly DiscEvidence[] {
    if (this.evidenceList?.from !== this.evidenceById) this.evidenceList = { from: this.evidenceById, list: [...this.evidenceById.values()] };
    return this.evidenceList.list;
  }

  /** Calls `listener` after every completed scan. */
  onScanned(listener: () => void): void {
    this.scannedListeners.push(listener);
  }

  /** The listed disc with this id, or null. */
  disc(id: string): DiscEntry | null {
    return this.byId.get(id) ?? null;
  }

  /** Where a disc's folder (or ISO file) is on this machine, or null if its root is no longer configured. */
  locate(disc: DiscEntry): string | null {
    const root = this.roots.find((r) => disc.path.startsWith(`${r.name}/`));
    return root ? join(root.dir, disc.path.slice(root.name.length + 1)) : null;
  }

  /** Each configured root with how many discs it holds now and whether the last completed scan found it missing or empty. */
  drives(): { name: string; discs: number; missing: boolean }[] {
    return this.roots.map((r) => ({
      name: r.name,
      discs: [...this.byId.values()].filter((d) => inRoot(d, r.name)).length,
      missing: this.missing.has(r.name),
    }));
  }

  /**
   * Drops the discs kept for a root the last scan found missing (a drive gone for good), saves the library and tells the
   * scan listeners. If the drive comes back, the next scan lists its discs again. Refused while a scan runs, since it
   * would put back what it kept.
   */
  async forget(name: string): Promise<'forgotten' | 'present' | 'unknown' | 'scanning'> {
    if (!this.roots.some((r) => r.name === name)) return 'unknown';
    if (this.running) return 'scanning';
    if (!this.missing.has(name)) return 'present';
    const discs = [...this.byId.values()].filter((d) => !inRoot(d, name));
    this.install(discs, this.evidenceById);
    this.tellScanned();
    await this.save(discs, this.evidenceById);
    return 'forgotten';
  }

  /** Rescans every root; list() keeps answering from the previous tree meanwhile. A scan already running is joined. */
  scan(): Promise<void> {
    this.running ??= this.doScan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private valid(e: unknown): e is DiscEntry {
    if (typeof e !== 'object' || e === null) return false;
    const d = e as Record<string, unknown>;
    return (
      typeof d.id === 'string' &&
      typeof d.name === 'string' &&
      typeof d.path === 'string' &&
      (d.kind === 'folder' || d.kind === 'iso') &&
      typeof d.sizeBytes === 'number' &&
      this.roots.some((r) => d.path === r.name || (d.path as string).startsWith(`${r.name}/`))
    );
  }

  private install(discs: DiscEntry[], evidence: ReadonlyMap<string, DiscEvidence>): void {
    this.tree = buildTree(discs);
    this.byId = new Map(discs.map((d) => [d.id, d]));
    this.evidenceById = new Map(discs.flatMap((d) => (evidence.has(d.id) ? [[d.id, evidence.get(d.id)!] as const] : [])));
  }

  /** Writes library.json: the discs with their evidence. */
  private async save(discs: readonly DiscEntry[], evidence: ReadonlyMap<string, DiscEvidence>): Promise<void> {
    try {
      const tmp = `${this.cacheFile}.tmp`;
      await writeFile(tmp, JSON.stringify(discs.map((d) => ({ ...d, evidence: evidence.get(d.id) }))));
      await rename(tmp, this.cacheFile);
    } catch (err) {
      console.error('could not write the library cache', err);
    }
  }

  private tellScanned(): void {
    for (const listener of this.scannedListeners) {
      try {
        listener();
      } catch (err) {
        console.error('a scan listener failed', err);
      }
    }
  }

  private async doScan(): Promise<void> {
    const found: DiscEntry[] = [];
    const previous = this.byId;
    const progressive = previous.size === 0;
    this.reads = 0;
    this.previousEvidence = this.evidenceById;
    this.nextEvidence = new Map();
    this.missingNext = new Set();
    for (const root of this.roots) {
      await this.scanRoot(root, found, previous);
      if (progressive) this.install([...found], this.nextEvidence);
    }
    this.install(found, this.nextEvidence);
    this.missing = this.missingNext;
    await this.save(found, this.nextEvidence);
    this.tellScanned();
  }

  /** Carries a disc's evidence over from the previous scan, if it had any; true if it did. */
  private carryEvidence(id: string): boolean {
    const ev = this.previousEvidence.get(id);
    if (ev) this.nextEvidence.set(id, ev);
    return ev !== undefined;
  }

  /** Reads a disc's evidence, at the scan's pace; a failed read leaves it out, to be read again by the next scan. */
  private async readEvidence(disc: DiscEntry, read: () => Promise<DiscEvidence>): Promise<void> {
    await this.pace();
    try {
      this.nextEvidence.set(disc.id, await read());
    } catch (err) {
      console.error(`could not read the evidence of ${disc.path}`, err);
    }
  }

  private async scanRoot(root: LibraryRoot, out: DiscEntry[], previous: Map<string, DiscEntry>): Promise<void> {
    let queue: { rel: string; abs: string; depth: number }[] = [{ rel: root.name, abs: root.dir, depth: 0 }];
    while (queue.length > 0) {
      const next: typeof queue = [];
      for (const dir of queue) {
        const entries = await this.readDir(dir.abs);
        if (!entries || (dir.depth === 0 && entries.length === 0)) {
          // An unreadable or empty root (a drive that isn't mounted) keeps what it had rather than losing its discs.
          if (dir.depth === 0) {
            this.missingNext.add(root.name);
            for (const d of previous.values()) {
              if (d.path !== root.name && !d.path.startsWith(`${root.name}/`)) continue;
              out.push(d);
              this.carryEvidence(d.id);
            }
          }
          continue;
        }
        const bdmv = entries.find((e) => e.isDir && e.name.toLowerCase() === 'bdmv');
        if (bdmv) {
          const disc = await this.folderDisc(dir.rel, join(dir.abs, bdmv.name), previous);
          if (disc) {
            out.push(disc);
            continue;
          }
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || SKIPPED.has(e.name.toLowerCase()) || e === bdmv) continue;
          const rel = `${dir.rel}/${e.name}`;
          if (e.isDir) {
            if (dir.depth < MAX_DEPTH) next.push({ rel, abs: join(dir.abs, e.name), depth: dir.depth + 1 });
          } else if (e.isFile && e.name.toLowerCase().endsWith('.iso')) {
            const disc = await this.isoDisc(rel, join(dir.abs, e.name), e.name, previous);
            if (disc) out.push(disc);
          }
        }
      }
      queue = next;
    }
  }

  /** Waits `scanPauseMs` before every read of a scan but the first. */
  private async pace(): Promise<void> {
    if (this.reads++ > 0 && this.pauseMs > 0) await new Promise((r) => setTimeout(r, this.pauseMs));
  }

  private async readDir(abs: string): Promise<{ name: string; isDir: boolean; isFile: boolean }[] | null> {
    await this.pace();
    let dir: Dir;
    try {
      dir = await this.open(abs);
    } catch {
      return null;
    }
    const entries: { name: string; isDir: boolean; isFile: boolean }[] = [];
    try {
      for await (const e of dir) entries.push({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() });
    } catch {
      return null;
    }
    return entries;
  }

  /**
   * An ISO disc if the image's UDF tree has BDMV/INDEX.BDMV. Its id is made from the path, image size and mtime; an
   * image whose id is already known either way (a disc in `previous`, or not a disc) isn't read again.
   */
  private async isoDisc(rel: string, abs: string, name: string, previous: Map<string, DiscEntry>): Promise<DiscEntry | null> {
    let st;
    try {
      st = await stat(abs);
    } catch {
      return null; // Vanished mid-scan.
    }
    const id = discId(rel, st.size, st.mtimeMs);
    const disc: DiscEntry = { id, name, path: rel, kind: 'iso', sizeBytes: st.size };
    if (previous.get(id)?.kind === 'iso') {
      if (!this.carryEvidence(id) && (await this.isSettled(abs, this.now()))) {
        await this.readEvidence(disc, async () => readIsoEvidence(disc, abs, await readIsoTree(abs)));
      }
      return disc;
    }
    if (!(await this.isSettled(abs, this.now()))) return this.keepPrevious(rel, previous);
    if (this.notDiscs.has(id)) return null;
    try {
      // A disc's tree is parsed once, for both the probe and the evidence.
      const tree = await isoDiscTree(abs);
      if (tree) {
        await this.readEvidence(disc, () => readIsoEvidence(disc, abs, tree));
        return disc;
      }
      this.notDiscs.add(id);
    } catch (err) {
      // A read error: left out of this scan, and tried again on the next.
      console.error(`could not read ${abs}`, err);
    }
    return null;
  }

  /**
   * Whether nothing of a disc changed in the last `SETTLE_MS`. `abs` is an ISO file or a BDMV directory; for the
   * directory the newest mtime of index.bdmv and the files of PLAYLIST, CLIPINF and STREAM counts.
   */
  async isSettled(abs: string, nowMs: number): Promise<boolean> {
    let newest = 0;
    try {
      const st = await stat(abs);
      newest = st.mtimeMs;
      if (st.isDirectory()) {
        const entries = (await this.readDir(abs)) ?? [];
        const files: string[] = [];
        for (const e of entries) {
          const lower = e.name.toLowerCase();
          if (e.isFile && lower === 'index.bdmv') files.push(join(abs, e.name));
          else if (e.isDir && (lower === 'playlist' || lower === 'clipinf' || lower === 'stream')) {
            for (const f of (await this.readDir(join(abs, e.name))) ?? []) if (f.isFile) files.push(join(abs, e.name, f.name));
          }
        }
        newest = 0;
        for (const f of files) {
          try {
            newest = Math.max(newest, (await stat(f)).mtimeMs);
          } catch {
            // Vanished mid-scan.
          }
        }
      }
    } catch {
      return false;
    }
    return nowMs - newest >= SETTLE_MS;
  }

  private previousPaths: { source: Map<string, DiscEntry>; byPath: Map<string, DiscEntry> } | null = null;

  /** The previous scan's discs by path, built once per scan. */
  private previousByPath(previous: Map<string, DiscEntry>): Map<string, DiscEntry> {
    if (this.previousPaths?.source !== previous) this.previousPaths = { source: previous, byPath: new Map([...previous.values()].map((d) => [d.path, d])) };
    return this.previousPaths.byPath;
  }

  /** An unsettled disc keeps its entry from the previous scan, if it had one. */
  private keepPrevious(rel: string, previous: Map<string, DiscEntry>): DiscEntry | null {
    const kept = this.previousByPath(previous).get(rel) ?? null;
    if (kept) this.carryEvidence(kept.id);
    return kept;
  }

  /** A folder disc if `bdmvDir` holds index.bdmv; its size is that of the clips in STREAM, carried over from `previous` when the id is unchanged. */
  private async folderDisc(rel: string, bdmvDir: string, previous: Map<string, DiscEntry>): Promise<DiscEntry | null> {
    const entries = await this.readDir(bdmvDir);
    const index = entries?.find((e) => e.isFile && e.name.toLowerCase() === 'index.bdmv');
    if (!entries || !index) return null;
    let st;
    try {
      st = await stat(join(bdmvDir, index.name));
    } catch {
      return null;
    }
    const id = discId(rel, st.size, st.mtimeMs);
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const known = previous.get(id);
    // Same path, index size and mtime: the disc is unchanged, so skip reading STREAM again.
    const discDir = join(bdmvDir, '..');
    if (known && known.kind === 'folder') {
      const disc: DiscEntry = { id, name, path: rel, kind: 'folder', sizeBytes: known.sizeBytes };
      if (!this.carryEvidence(id) && (await this.isSettled(bdmvDir, this.now()))) await this.readEvidence(disc, () => readFolderEvidence(disc, discDir, (dir) => this.readDir(dir)));
      return disc;
    }
    if (!(await this.isSettled(bdmvDir, this.now()))) return this.keepPrevious(rel, previous);
    let sizeBytes = 0;
    const stream = entries.find((e) => e.isDir && e.name.toLowerCase() === 'stream');
    const streamDir = stream ? join(bdmvDir, stream.name) : null;
    for (const clip of streamDir ? ((await this.readDir(streamDir)) ?? []) : []) {
      if (!clip.isFile || !streamDir) continue;
      try {
        sizeBytes += (await stat(join(streamDir, clip.name))).size;
      } catch {
        // Vanished mid-scan.
      }
    }
    const disc: DiscEntry = { id, name, path: rel, kind: 'folder', sizeBytes };
    await this.readEvidence(disc, () => readFolderEvidence(disc, discDir, (dir) => this.readDir(dir)));
    return disc;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Whether a cached `evidence` field has the shape of a disc's evidence (for that disc), down to its elements. */
function validEvidence(ev: unknown, disc: DiscEntry): ev is DiscEvidence {
  if (!isRecord(ev)) return false;
  return (
    ev.discId === disc.id &&
    ev.path === disc.path &&
    (ev.fingerprint === null || typeof ev.fingerprint === 'string') &&
    Array.isArray(ev.discTitles) &&
    ev.discTitles.every((t) => isRecord(t) && typeof t.lang === 'string' && typeof t.name === 'string') &&
    isStrings(ev.segments) &&
    isStrings(ev.catalogueNumbers) &&
    Array.isArray(ev.playlists) &&
    ev.playlists.every(
      (p) => isRecord(p) && typeof p.id === 'string' && Number.isFinite(p.durationS) && Number.isInteger(p.chapters) && isStrings(p.clips),
    )
  );
}

function mergeFolders(folders: FolderEntry[]): FolderEntry[] {
  const merged = new Map<string, FolderEntry>();
  for (const f of folders) {
    const prev = merged.get(f.path);
    merged.set(f.path, prev ? { ...prev, discs: prev.discs + f.discs } : f);
  }
  return [...merged.values()].sort(byName);
}

function buildTree(discs: readonly DiscEntry[]): Map<string, Node> {
  const tree = new Map<string, Node>([['', { folders: new Map(), discs: [] }]]);
  const node = (path: string): Node => {
    let n = tree.get(path);
    if (!n) tree.set(path, (n = { folders: new Map(), discs: [] }));
    return n;
  };
  for (const disc of discs) {
    const parts = disc.path.split('/');
    let parent = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parent === '' ? parts[i]! : `${parent}/${parts[i]}`;
      const holder = node(parent);
      const prev = holder.folders.get(path);
      holder.folders.set(path, { name: parts[i]!, path, discs: (prev?.discs ?? 0) + 1 });
      node(path);
      parent = path;
    }
    node(parent).discs.push(disc);
  }
  return tree;
}
