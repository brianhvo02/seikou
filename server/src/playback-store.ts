import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseDiscKey } from '@seikou/nas/disc-key';
import type { DiscPlaces, PlaceSettings, PlaybackPlace } from '@seikou/nas/nas-api';
import { isCode, lockFile, replaceAtomically } from './atomic-json';
import { PERSON_RE } from './bdj-store';

export const MAX_PLACES = 500;
/** The largest body a place is accepted in. */
export const PLACE_LIMIT_BYTES = 256 * 1024;

/** How far ahead of the server's clock a device's `updatedAt` is believed (a fast clock must not pin a place as newest). */
const MAX_AHEAD_MS = 5 * 60_000;
const PLAYLIST_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isPlaylistId = (id: string): boolean => PLAYLIST_RE.test(id);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

const optionalString = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && v.length >= 1 && v.length <= max);

const index = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A viewer's Anime Tosho pick in a place: its release, file and track, and the track's name (at most 256 chars). */
const optionalFansub = (v: unknown): boolean => v === undefined
  || (isObject(v) && index(v.releaseId) && index(v.fileId) && index(v.track) && typeof v.trackName === 'string' && v.trackName.length <= 256);

/**
 * A text file of a place; a stored subtitle's also carries its id (1–64 chars) and language (a BCP 47 tag, 1–35), and a
 * viewer's Anime Tosho pick its language and `fansub`.
 */
const isTextFile = (f: unknown): boolean => isObject(f) && typeof f.name === 'string' && f.name.length <= 512 && num(f.size) && (f.startUs === null || num(f.startUs)) && num(f.offsetMs)
  && optionalString(f.subtitleId, 64) && optionalString(f.language, 35) && optionalFansub(f.fansub);

function isSettings(v: unknown): v is PlaceSettings {
  return isObject(v) && strOrNull(v.audioLanguage) && strOrNull(v.pgLanguage) && Array.isArray(v.textFiles) && v.textFiles.length <= 64 && v.textFiles.every(isTextFile) && num(v.psr1) && num(v.psr2) && num(v.psr3) && typeof v.textOn === 'boolean'
    && num(v.textScale) && strOrNull(v.shaderSet) && num(v.volume) && typeof v.muted === 'boolean';
}

/** Whether `v` has the shape of a `PlaybackPlace`; the keys are checked by the caller against the path. */
export function isPlaybackPlace(v: unknown): v is PlaybackPlace {
  if (!isObject(v)) return false;
  if (typeof v.discKey !== 'string' || typeof v.discId !== 'string' || typeof v.playlistId !== 'string') return false;
  if (!num(v.timeUs) || !num(v.durationUs) || typeof v.finished !== 'boolean' || !num(v.updatedAt) || typeof v.deviceName !== 'string') return false;
  if (v.mode !== 'hdmv' && v.mode !== 'bdj' && v.mode !== 'none') return false;
  if (v.title !== null && !num(v.title)) return false;
  if (!Array.isArray(v.psrs) || !v.psrs.every(num)) return false;
  if (v.gprs !== null && !(isObject(v.gprs) && Object.values(v.gprs).every(num))) return false;
  return isSettings(v.settings);
}

/** Each person's places, one file per disc under `users/<personId>/playback/<discKey>.json`. */
export class PlaybackStore {
  private readonly maxPlaces: number;
  private readonly now: () => number;

  constructor(private readonly dataDir: string, opts: { maxPlaces?: number; now?: () => number } = {}) {
    this.maxPlaces = opts.maxPlaces ?? MAX_PLACES;
    this.now = opts.now ?? Date.now;
  }

  private dir(personId: string): string {
    if (!PERSON_RE.test(personId)) throw new Error('bad person id');
    return join(this.dataDir, 'users', personId, 'playback');
  }

  private file(personId: string, discKey: string): string {
    if (parseDiscKey(discKey) === null) throw new Error('bad disc key');
    return join(this.dir(personId), `${discKey}.json`);
  }

  private read(file: string): DiscPlaces | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObject(parsed) || !isObject(parsed.places)) return null;
      return parsed as unknown as DiscPlaces;
    } catch (err) {
      if (isCode(err, 'ENOENT') || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private write(file: string, value: DiscPlaces): void {
    if (Object.keys(value.places).length === 0) rmSync(file, { force: true });
    else replaceAtomically(file, JSON.stringify(value));
  }

  /** Runs `fn` on a disc's file under its lock, writing what it returns (null leaves the file alone). */
  private edit<T>(personId: string, discKey: string, fn: (cur: DiscPlaces | null) => { next: DiscPlaces | null; result: T }): T {
    const file = this.file(personId, discKey);
    mkdirSync(this.dir(personId), { recursive: true });
    const unlock = lockFile(file);
    try {
      const { next, result } = fn(this.read(file));
      if (next) this.write(file, next);
      return result;
    } finally {
      unlock();
    }
  }

  get(personId: string, discKey: string): DiscPlaces | null {
    return this.read(this.file(personId, discKey));
  }

  put(personId: string, sent: PlaybackPlace): 'stored' | 'stale' {
    const place = { ...sent, updatedAt: Math.min(sent.updatedAt, this.now() + MAX_AHEAD_MS) };
    const result = this.edit(personId, place.discKey, (cur) => {
      if ((cur?.places[place.playlistId]?.updatedAt ?? -Infinity) > place.updatedAt) return { next: null, result: 'stale' as const };
      return { next: { defaults: place.settings, places: { ...cur?.places, [place.playlistId]: place } }, result: 'stored' as const };
    });
    if (result === 'stored') this.prune(personId);
    return result;
  }

  delete(personId: string, discKey: string, playlistId?: string): void {
    this.edit(personId, discKey, (cur) => {
      if (!cur) return { next: null, result: undefined };
      if (playlistId === undefined) return { next: { defaults: null, places: {} }, result: undefined };
      const { [playlistId]: _gone, ...rest } = cur.places;
      return { next: { defaults: cur.defaults, places: rest }, result: undefined };
    });
  }

  all(personId: string): PlaybackPlace[] {
    let names: string[];
    try {
      names = readdirSync(this.dir(personId));
    } catch (err) {
      if (isCode(err, 'ENOENT')) return [];
      throw err;
    }
    const out: PlaybackPlace[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || parseDiscKey(name.slice(0, -5)) === null) continue;
      const disc = this.read(join(this.dir(personId), name));
      if (disc) out.push(...Object.values(disc.places));
    }
    return out;
  }

  /** Over the cap, the oldest finished places go first, then the oldest. */
  private prune(personId: string): void {
    const places = this.all(personId);
    const excess = places.length - this.maxPlaces;
    if (excess <= 0) return;
    places.sort((a, b) => Number(b.finished) - Number(a.finished) || a.updatedAt - b.updatedAt);
    for (const p of places.slice(0, excess)) this.delete(personId, p.discKey, p.playlistId);
  }
}
