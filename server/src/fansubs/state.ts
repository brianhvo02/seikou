import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { FansubTitleState } from '@seikou/nas/nas-api';
import { isCode, lockFile, replaceAtomically } from '@seikou/titles/atomic-json';

const THIRTY_DAYS_MS = 30 * 86_400_000;

interface StateFile {
  titles: Record<string, FansubTitleState>;
  /** Tracks the owner deleted, per title, as `"<toshoFileId>:<track>"`. */
  deleted: Record<string, string[]>;
  languages: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `eng` first, then the others, lower-cased and without repeats. */
function normalizeLanguages(codes: readonly unknown[]): string[] {
  const rest = codes.filter((c): c is string => typeof c === 'string').map((c) => c.trim().toLowerCase()).filter((c) => c !== '');
  return [...new Set(['eng', ...rest])];
}

/** An entry with every field a run writes; one missing any counts as never run. */
function complete(t: unknown): t is FansubTitleState {
  return isObject(t) && typeof t.titleId === 'string' && (t.lastRunAt === null || typeof t.lastRunAt === 'number')
    && typeof t.running === 'boolean' && typeof t.nothingFound === 'boolean' && isObject(t.seasons) && isObject(t.episodes);
}

const trackKey = (toshoFileId: number, track: number): string => `${toshoFileId}:${track}`;

/** The fansub run's memory: per-title results, tracks the owner deleted and the languages wanted. `<dataDir>/fansubs/state.json`. */
export class FansubState {
  private readonly file: string;
  private warned = false;

  constructor(dataDir: string) {
    const dir = join(dataDir, 'fansubs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'state.json');
  }

  title(id: string): FansubTitleState | null {
    const t = this.read().titles[id];
    return complete(t) ? t : null;
  }

  /** At start: a run that was going when the process stopped is no longer running. */
  clearRunning(): void {
    this.change((s) => {
      for (const [id, t] of Object.entries(s.titles)) if (complete(t) && t.running) s.titles[id] = { ...t, running: false };
    });
  }

  put(state: FansubTitleState): void {
    this.change((s) => {
      s.titles[state.titleId] = state;
    });
  }

  isDeleted(toshoFileId: number, track: number): boolean {
    const key = trackKey(toshoFileId, track);
    return Object.values(this.read().deleted).some((keys) => keys.includes(key));
  }

  /** Records a deleted track against the title its subtitle was attached to, so `undelete(titleId)` can bring it back. */
  markDeleted(titleId: string, toshoFileId: number, track: number): void {
    this.change((s) => {
      const keys = (s.deleted[titleId] ??= []);
      const key = trackKey(toshoFileId, track);
      if (!keys.includes(key)) keys.push(key);
    });
  }

  undelete(titleId: string): void {
    this.change((s) => {
      delete s.deleted[titleId];
    });
  }

  /** ISO 639-2 codes of the languages to fetch, `['eng']` until the owner sets them. */
  languages(): readonly string[] {
    return this.read().languages;
  }

  setLanguages(codes: readonly string[]): void {
    this.change((s) => {
      s.languages = normalizeLanguages(codes);
    });
  }

  /**
   * The titles to run: never run, nothing found and the last run over 30 days ago, or an episode left for later because
   * a service was down.
   */
  due(titleIds: readonly string[], now: number): string[] {
    const { titles } = this.read();
    return titleIds.filter((id) => {
      const t = titles[id];
      return !complete(t) || t.lastRunAt === null || (t.nothingFound && now - t.lastRunAt > THIRTY_DAYS_MS)
        || Object.values(t.episodes).some((m) => m.reason === 'service-unavailable');
    });
  }

  private read(): StateFile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (isCode(err, 'ENOENT')) return { titles: {}, deleted: {}, languages: ['eng'] };
      if (!(err instanceof SyntaxError)) throw err;
      return this.setAside();
    }
    if (!isObject(parsed)) return this.setAside();
    const { titles = {}, deleted = {}, languages } = parsed;
    const valid = isObject(titles) && Object.values(titles).every(isObject)
      && isObject(deleted) && Object.values(deleted).every((keys) => Array.isArray(keys) && keys.every((k) => typeof k === 'string'))
      && (languages === undefined || (Array.isArray(languages) && languages.every((c) => typeof c === 'string')));
    if (!valid) return this.setAside();
    return {
      titles: titles as Record<string, FansubTitleState>,
      deleted: deleted as Record<string, string[]>,
      languages: normalizeLanguages(Array.isArray(languages) ? languages : []),
    };
  }

  /** A damaged file is kept as `state.json.bad-<time>` (deleted tracks would otherwise come back unnoticed), and the state starts empty. */
  private setAside(): StateFile {
    const bad = `${this.file}.bad-${Date.now()}-${randomBytes(3).toString('hex')}`;
    try {
      renameSync(this.file, bad);
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
    }
    if (!this.warned) {
      this.warned = true;
      console.warn(`fansub state: ${this.file} is damaged; moved to ${bad}, starting empty`);
    }
    return { titles: {}, deleted: {}, languages: ['eng'] };
  }

  private change(edit: (s: StateFile) => void): void {
    const unlock = lockFile(this.file);
    try {
      const s = this.read();
      edit(s);
      replaceAtomically(this.file, JSON.stringify(s));
    } finally {
      unlock();
    }
  }
}
