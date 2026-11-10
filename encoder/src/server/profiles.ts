// SPDX-License-Identifier: LGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceAtomically } from '@seikou/titles';

// Named encode settings, kept in `<data>/profiles.json`. A job copies the settings of the profile it was queued with, so
// editing or deleting a profile later never changes a job that exists.

/** The settings of an encode that a profile holds. */
export interface EncodeSettings {
  /** SVT-AV1 constant rate factor, an integer 0 to 63; lower is better quality and bigger files. */
  readonly crf: number;
  /** SVT-AV1 preset, an integer -1 to 13; lower is slower and better. */
  readonly preset: number;
  /** Film-grain synthesis level, an integer 0 to 50. */
  readonly filmGrain: number;
  /** More SVT-AV1 arguments, one array item per argument; none that the encoder sets from another field. */
  readonly extraSvtArgs: readonly string[];
  /** Opus bitrate in kb/s per stream (an integer 6 to 512), or null for the encoder's own default by channel count. */
  readonly opusBitrate: number | null;
  /** Whether the disc's PGS subtitle tracks go into the MKV. */
  readonly pgs: boolean;
  /** Whether each episode is also packaged for the web player. */
  readonly web: boolean;
  /** The episode file name without its extension; must contain `{n}`, which becomes the episode number. */
  readonly namePattern: string;
  /**
   * Where the episodes go: `folder`, an output folder on this machine, or `nas`, the paired NAS's Encodes library (each
   * episode uploaded once encoded, then deleted here). Settings saved before there was a choice read as `folder`.
   */
  readonly destination: EncodeDestination;
}

/** Where a job's episodes go. */
export type EncodeDestination = 'folder' | 'nas';

/** A profile: a name and the settings it stands for. */
export interface Profile {
  /** The profile's id: `default` for the built-in one, else a short URL-safe word. */
  readonly id: string;
  /** What the person calls it; unique among profiles in any letter case. */
  readonly name: string;
  /** True for the profile that is part of the app: it is not stored, and it cannot be changed or deleted. */
  readonly builtIn: boolean;
  /** The settings. */
  readonly settings: EncodeSettings;
}

/** The id of the built-in profile. */
export const DEFAULT_PROFILE_ID = 'default';

/** The settings of the built-in profile. */
export const DEFAULT_SETTINGS: EncodeSettings = {
  crf: 25,
  preset: 4,
  filmGrain: 4,
  extraSvtArgs: [],
  opusBitrate: null,
  pgs: true,
  web: false,
  namePattern: 'episode-{n}',
  destination: 'folder',
};

/** What a profile call is refused for: an HTTP status, a code the page tests, and the field at fault when there is one. */
export class ProfileError extends Error {
  override name = 'ProfileError';
  constructor(
    /** The HTTP status to answer with. */
    readonly status: number,
    /** A short kebab-case word: `bad-setting`, `built-in`, `not-found`, `profiles-unreadable`. */
    readonly code: string,
    message: string,
    /** The field the problem is in (`name` or one of the settings), when it is in one. */
    readonly field?: string,
  ) {
    super(message);
  }
}

/**
 * SVT-AV1 options the encoder sets from a field or fixes itself, by every spelling it takes. Giving one in the extra
 * arguments would either be ignored or fight the pipeline (the video goes in on stdin and out on stdout).
 */
const CONTROLLED_SVT_ARGS: ReadonlySet<string> = new Set([
  '--crf',
  '--preset',
  '--film-grain',
  '-i',
  '--input',
  '-b',
  '--output',
  '-c',
  '--config',
  '--progress',
  '--keyint',
  '--color-primaries',
  '--transfer-characteristics',
  '--matrix-coefficients',
  '--color-range',
  '--rc',
]);

const bad = (field: string, message: string): ProfileError => new ProfileError(400, 'bad-setting', message, field);

function intInRange(value: unknown, field: string, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw bad(field, `${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/**
 * Checks `value` as the settings of a profile and returns them in their canonical form.
 * @throws ProfileError 400 `bad-setting` naming the first field that is wrong.
 */
export function parseSettings(value: unknown): EncodeSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad('settings', 'The settings must be an object.');
  const s = value as Record<string, unknown>;
  const crf = intInRange(s.crf, 'crf', 'CRF', 0, 63);
  const preset = intInRange(s.preset, 'preset', 'Preset', -1, 13);
  const filmGrain = intInRange(s.filmGrain, 'filmGrain', 'Film grain', 0, 50);
  const opusBitrate = s.opusBitrate === null ? null : intInRange(s.opusBitrate, 'opusBitrate', 'The Opus bitrate', 6, 512);
  if (typeof s.pgs !== 'boolean') throw bad('pgs', 'PGS subtitles must be on or off.');
  if (typeof s.web !== 'boolean') throw bad('web', 'The web package must be on or off.');
  if (typeof s.namePattern !== 'string') throw bad('namePattern', 'The output name pattern must be text.');
  const namePattern = s.namePattern.trim();
  if (namePattern === '') throw bad('namePattern', 'The output name pattern cannot be empty.');
  if (!namePattern.includes('{n}')) throw bad('namePattern', 'The output name pattern must contain {n}, the episode number.');
  if (/[\\/]/.test(namePattern) || namePattern.includes('..') || namePattern.includes('\0')) {
    throw bad('namePattern', 'The output name pattern must be a file name: no slashes and no "..".');
  }
  if (namePattern.startsWith('.') || /[:*?"<>|]/.test(namePattern) || /[. ]$/.test(namePattern)) {
    throw bad('namePattern', 'The output name pattern cannot start with a dot, end with a dot or space, or contain : * ? " < > |.');
  }
  const args = s.extraSvtArgs;
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && a !== '')) {
    throw bad('extraSvtArgs', 'The extra SVT-AV1 arguments must be a list of words.');
  }
  for (const a of args as string[]) {
    const option = a.startsWith('-') ? a.split('=')[0]! : a;
    if (CONTROLLED_SVT_ARGS.has(option)) {
      throw bad('extraSvtArgs', `${option} is set by the encoder (from the fields above or the pipeline), so it cannot be an extra argument.`);
    }
  }
  const destination = s.destination ?? 'folder';
  if (destination !== 'folder' && destination !== 'nas') throw bad('destination', 'The destination must be "folder" or "nas".');
  return { crf, preset, filmGrain, extraSvtArgs: [...(args as string[])], opusBitrate, pgs: s.pgs, web: s.web, namePattern, destination };
}

function parseName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw bad('name', 'The profile needs a name.');
  const name = value.trim();
  if (name.length > 80) throw bad('name', 'The profile name can be at most 80 characters.');
  return name;
}

/** The built-in profile. */
function builtInProfile(): Profile {
  return { id: DEFAULT_PROFILE_ID, name: 'Default', builtIn: true, settings: DEFAULT_SETTINGS };
}

type Stored = Omit<Profile, 'builtIn'>;

/**
 * The profiles of the app, over `<dataDir>/profiles.json`. The built-in `default` profile is always first and is not
 * in the file. A missing file means no stored profiles; a file that cannot be read or does not parse leaves only the
 * default (logged once) and refuses every write, so a damaged file is never overwritten.
 */
export class ProfileStore {
  private readonly file: string;
  private logged = false;
  private queue: Promise<unknown> = Promise.resolve();

  /** The store for the data directory `dataDir` (created on the first write); `log` hears about an unreadable file. */
  constructor(
    private readonly dataDir: string,
    private readonly log: (message: string) => void = (m) => console.error(m),
  ) {
    this.file = join(dataDir, 'profiles.json');
  }

  /** Reads the stored profiles; `null` when the file is there but unusable. */
  private async load(): Promise<Stored[] | null> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return this.unreadable(e);
    }
    try {
      const parsed = JSON.parse(text) as { profiles?: unknown };
      if (!Array.isArray(parsed.profiles)) throw new Error('no profiles list');
      const seen = new Set<string>();
      return parsed.profiles.map((p: { id?: unknown; name?: unknown; settings?: unknown }) => {
        if (typeof p.id !== 'string' || !/^[a-z0-9]{1,32}$/.test(p.id) || p.id === DEFAULT_PROFILE_ID || seen.has(p.id)) throw new Error('bad profile id');
        seen.add(p.id);
        return { id: p.id, name: parseName(p.name), settings: parseSettings(p.settings) };
      });
    } catch (e) {
      return this.unreadable(e);
    }
  }

  private unreadable(e: unknown): null {
    if (!this.logged) {
      this.logged = true;
      this.log(`profiles.json cannot be read (${e instanceof Error ? e.message : String(e)}); only the default profile is available until it is fixed.`);
    }
    return null;
  }

  private async save(stored: readonly Stored[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    replaceAtomically(this.file, `${JSON.stringify({ profiles: stored }, null, 2)}\n`);
  }

  /** Runs `fn` after the calls before it, so two writes never read the same file state. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The built-in profile first, then the stored ones in the order they were made. */
  async list(): Promise<Profile[]> {
    const stored = (await this.load()) ?? [];
    return [builtInProfile(), ...stored.map((p): Profile => ({ ...p, builtIn: false }))];
  }

  /** The profile with `id`, or null. */
  async get(id: string): Promise<Profile | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }

  private async writable(): Promise<Stored[]> {
    const stored = await this.load();
    if (stored === null) throw new ProfileError(500, 'profiles-unreadable', 'profiles.json in the data folder cannot be read, so profiles cannot be saved. Fix or remove that file.');
    return stored;
  }

  private static clash(stored: readonly Stored[], name: string, exceptId?: string): void {
    const key = name.toLowerCase();
    if (key === 'default' || stored.some((p) => p.id !== exceptId && p.name.toLowerCase() === key)) {
      throw bad('name', `A profile named "${name}" already exists.`);
    }
  }

  /** Makes a profile from `input` (`{ name, settings }`); resolves with it. @throws ProfileError */
  create(input: unknown): Promise<Profile> {
    return this.serial(async () => {
      const { name, settings } = ProfileStore.fields(input);
      const stored = await this.writable();
      ProfileStore.clash(stored, name);
      const id = randomBytes(5).toString('hex');
      await this.save([...stored, { id, name, settings }]);
      return { id, name, builtIn: false, settings };
    });
  }

  /** Replaces the name and settings of the profile `id` with `input`; the built-in one answers 400 `built-in`. @throws ProfileError */
  update(id: string, input: unknown): Promise<Profile> {
    return this.serial(async () => {
      if (id === DEFAULT_PROFILE_ID) throw new ProfileError(400, 'built-in', 'The default profile cannot be changed. Duplicate it to edit a copy.');
      const { name, settings } = ProfileStore.fields(input);
      const stored = await this.writable();
      if (!stored.some((p) => p.id === id)) throw new ProfileError(404, 'not-found', 'There is no such profile.');
      ProfileStore.clash(stored, name, id);
      await this.save(stored.map((p) => (p.id === id ? { id, name, settings } : p)));
      return { id, name, builtIn: false, settings };
    });
  }

  /** Removes the profile `id`; the built-in one answers 400 `built-in`. @throws ProfileError */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (id === DEFAULT_PROFILE_ID) throw new ProfileError(400, 'built-in', 'The default profile cannot be deleted.');
      const stored = await this.writable();
      if (!stored.some((p) => p.id === id)) throw new ProfileError(404, 'not-found', 'There is no such profile.');
      await this.save(stored.filter((p) => p.id !== id));
    });
  }

  private static fields(input: unknown): { name: string; settings: EncodeSettings } {
    if (typeof input !== 'object' || input === null) throw new ProfileError(400, 'bad-request', 'The body must be { "name": …, "settings": {…} }.');
    const body = input as { name?: unknown; settings?: unknown };
    return { name: parseName(body.name), settings: parseSettings(body.settings) };
  }
}

const stores = new WeakMap<object, ProfileStore>();

/** The profile store of an app (made once per app context, over its data directory). */
export function profilesOf(app: { readonly dataDir: string }): ProfileStore {
  let store = stores.get(app);
  if (!store) {
    store = new ProfileStore(app.dataDir);
    stores.set(app, store);
  }
  return store;
}
