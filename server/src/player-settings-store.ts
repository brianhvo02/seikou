// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCode, replaceAtomically } from '@seikou/titles/atomic-json';
import { PERSON_RE } from './bdj-store';
import { isDiscPreferences, parseDiscPreferences, type PlayerSettings as WirePlayerSettings, type PlayerSettingsBody } from '@seikou/nas/nas-api';

export type { PlayerSettingsBody };

/** One person's player settings, the same on each of their devices (the wire type of `GET me/player-settings`). */
export type PlayerSettings = WirePlayerSettings;

/** What a person has before they change anything: the countdown off and no disc preferences saved. */
export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = { nextEpisodeCountdown: false, discPreferences: null };

/** The largest body a `PUT` of the settings is accepted in. */
export const PLAYER_SETTINGS_LIMIT_BYTES = 4096;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether `v` is a `PUT` body: `nextEpisodeCountdown`, valid and complete `discPreferences`, or both; no other field.
 * A field left out keeps its stored value (an app from before disc preferences sends the countdown alone).
 */
export function isPlayerSettingsBody(v: unknown): v is PlayerSettingsBody {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0 || keys.some((k) => k !== 'nextEpisodeCountdown' && k !== 'discPreferences')) return false;
  if ('nextEpisodeCountdown' in v && typeof v.nextEpisodeCountdown !== 'boolean') return false;
  return !('discPreferences' in v) || isDiscPreferences(v.discPreferences);
}

/**
 * Each person's player settings in `users/<personId>/player-settings.json`, replaced atomically. A missing or broken
 * file reads as the defaults, a field that is missing or of the wrong type as its default (a disc preference as Auto),
 * and a field this server doesn't know is ignored.
 */
export class PlayerSettingsStore {
  constructor(private readonly dataDir: string) {}

  private file(personId: string): string {
    if (!PERSON_RE.test(personId)) throw new Error('bad person id');
    return join(this.dataDir, 'users', personId, 'player-settings.json');
  }

  /** The person's settings, the defaults for any not stored. */
  get(personId: string): PlayerSettings {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file(personId), 'utf8'));
    } catch (err) {
      if (isCode(err, 'ENOENT') || err instanceof SyntaxError) return DEFAULT_PLAYER_SETTINGS;
      throw err;
    }
    if (!isObject(parsed)) return DEFAULT_PLAYER_SETTINGS;
    return {
      nextEpisodeCountdown: typeof parsed.nextEpisodeCountdown === 'boolean' ? parsed.nextEpisodeCountdown : DEFAULT_PLAYER_SETTINGS.nextEpisodeCountdown,
      discPreferences: parseDiscPreferences(parsed.discPreferences),
    };
  }

  /** Stores the settings the body carries; one it leaves out keeps its stored value. */
  put(personId: string, body: PlayerSettingsBody): void {
    const file = this.file(personId);
    const stored = this.get(personId);
    const nextEpisodeCountdown = body.nextEpisodeCountdown ?? stored.nextEpisodeCountdown;
    const discPreferences = body.discPreferences ?? stored.discPreferences;
    mkdirSync(join(this.dataDir, 'users', personId), { recursive: true });
    replaceAtomically(file, JSON.stringify({ nextEpisodeCountdown, ...(discPreferences ? { discPreferences } : {}) }));
  }
}
