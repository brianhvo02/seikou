// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The person's disc preferences on this device: a copy per person in browser storage (so a disc opened offline, from
 * a local folder, or before the NAS answers still gets them), kept in step with the person's copy on the NAS
 * (`me/player-settings`), and sent to the engine (`setDiscPreferences`) whenever they change.
 *
 * Which copy wins: an edit is saved here at once, marked pending, and put to the NAS; the mark clears when the NAS
 * accepts it. A pending copy wins over the NAS's answer and is put again; otherwise the NAS's copy wins. A NAS that
 * never saved any gets this device's copy. A NAS from before disc preferences (its answer has no `discPreferences`)
 * is never sent them: they stay on this device.
 */
import { AUTO_DISC_PREFERENCES, parseDiscPreferences, type DiscPreferences, type PlayerSettings, type PlayerSettingsBody } from '@seikou/nas/nas-api';
import type { PlayerSettings as EngineSettings } from '@seikou/engine';
import { resolveDiscPreferences } from './disc-preferences';

/** The storage key prefix (the `bluray-web:` prefix is kept on purpose; see CLAUDE.md). */
const KEY_PREFIX = 'bluray-web:disc-preferences:';
/** The scope with no pairing; a newly paired person starts from it. */
export const LOCAL_SCOPE = 'local';

/** What the store needs from the page. */
export interface DiscPreferencesDeps {
  /** Browser storage, or null where there is none; every access is guarded. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Whose copy: `local` with no pairing, else the pairing's key (a pairing belongs to one person). */
  scope(): string | Promise<string>;
  /** The person's settings on the NAS, or null with no pairing (asked at each load). */
  nas(): { get(): Promise<PlayerSettings>; put(body: PlayerSettingsBody): Promise<PlayerSettings> } | null;
  /** Tells the engine (`PlayerController.setDiscPreferences`). */
  send(settings: EngineSettings): void;
  /** The browser's locale, for Auto. */
  locale(): string | undefined;
  /** The countdown setting a `PUT` carries until the NAS has answered with its own. */
  countdown(): boolean;
}

/** Where the person's preferences stand against the NAS. */
export type NasState = 'synced' | 'pending' | 'device-only' | 'unpaired';

interface DeviceRecord {
  readonly prefs: DiscPreferences;
  readonly pending: boolean;
}

/** The person's disc preferences: this device's copy, the NAS's, and the engine told. */
export class DiscPreferencesStore {
  private prefs: DiscPreferences = AUTO_DISC_PREFERENCES;
  private pending = false;
  /** The NAS knows disc preferences (null until it has answered). */
  private nasKnows: boolean | null = null;
  /** The countdown the NAS last answered with. */
  private countdownSeen: boolean | null = null;
  private scopeNow = LOCAL_SCOPE;
  private nasNow: ReturnType<DiscPreferencesDeps['nas']> = null;
  /** Bumped on every load and rescope, so an answer for another scope is dropped. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: DiscPreferencesDeps) {}

  /** The preferences as they stand. */
  current(): DiscPreferences {
    return this.prefs;
  }

  /** Where they stand against the NAS. */
  state(): NasState {
    if (!this.nasNow) return 'unpaired';
    if (this.nasKnows === false) return 'device-only';
    return this.pending || this.nasKnows === null ? 'pending' : 'synced';
  }

  /** Calls `fn` whenever the preferences or their state change; answers the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Takes this device's copy for the current scope at once (and tells the engine), then the NAS's. */
  async load(): Promise<void> {
    const gen = ++this.generation;
    const scope = this.deps.scope();
    this.scopeNow = typeof scope === 'string' ? scope : await scope;
    if (gen !== this.generation) return;
    this.nasNow = this.deps.nas();
    this.nasKnows = null;
    this.countdownSeen = null;
    const record = this.read(this.scopeNow) ?? this.read(LOCAL_SCOPE) ?? { prefs: AUTO_DISC_PREFERENCES, pending: false };
    this.adopt(record.prefs, record.pending);
    const nas = this.nasNow;
    if (!nas) return;
    let answer: PlayerSettings;
    try {
      answer = await nas.get();
    } catch {
      return; // offline: this device's copy stands, and a pending one is put at the next load
    }
    if (gen !== this.generation) return;
    this.countdownSeen = typeof answer.nextEpisodeCountdown === 'boolean' ? answer.nextEpisodeCountdown : null;
    if (!('discPreferences' in answer)) {
      this.nasKnows = false;
      this.changed();
      return;
    }
    this.nasKnows = true;
    const fromNas = parseDiscPreferences(answer.discPreferences);
    if (this.pending || fromNas === null) await this.push(gen);
    else {
      this.adopt(fromNas, false);
      this.write();
    }
  }

  /** The pairing or the person changed: load the new scope's copy. */
  rescope(): Promise<void> {
    return this.load();
  }

  /** The viewer changed a preference: saved here at once, the engine told, then put to the NAS. */
  async set(prefs: DiscPreferences): Promise<void> {
    const gen = this.generation;
    this.adopt(prefs, this.nasNow !== null && this.nasKnows !== false);
    this.write();
    if (this.pending) await this.push(gen);
  }

  /** Puts this device's copy to the NAS; the pending mark clears when it is accepted. */
  private async push(gen: number): Promise<void> {
    const nas = this.nasNow;
    if (!nas || this.nasKnows === false) return;
    this.pending = true;
    this.write();
    this.changed();
    const prefs = this.prefs;
    try {
      await nas.put({ nextEpisodeCountdown: this.countdownSeen ?? this.deps.countdown(), discPreferences: prefs });
    } catch {
      return; // stays pending
    }
    if (gen !== this.generation || this.prefs !== prefs) return;
    this.nasKnows = true;
    this.pending = false;
    this.write();
    this.changed();
  }

  private adopt(prefs: DiscPreferences, pending: boolean): void {
    this.prefs = prefs;
    this.pending = pending;
    this.deps.send(resolveDiscPreferences(prefs, this.deps.locale()));
    this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  private read(scope: string): DeviceRecord | null {
    try {
      const raw = this.deps.storage?.getItem(KEY_PREFIX + scope);
      if (!raw) return null;
      const v = JSON.parse(raw) as { prefs?: unknown; pending?: unknown };
      const prefs = parseDiscPreferences(v.prefs);
      return prefs ? { prefs, pending: v.pending === true } : null;
    } catch {
      return null;
    }
  }

  private write(): void {
    try {
      this.deps.storage?.setItem(KEY_PREFIX + this.scopeNow, JSON.stringify({ prefs: this.prefs, pending: this.pending }));
    } catch {
      // storage refused: the preferences still hold for this page's life
    }
  }
}
