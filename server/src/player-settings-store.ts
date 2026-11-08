// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCode, replaceAtomically } from '@seikou/titles/atomic-json';
import { PERSON_RE } from './bdj-store';

/** One person's player settings, the same on each of their devices. */
export interface PlayerSettings {
  /** Whether the next episode starts by itself after a countdown when one ends. */
  readonly nextEpisodeCountdown: boolean;
}

/** What a person has before they change anything. */
export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = { nextEpisodeCountdown: false };

/** The largest body a `PUT` of the settings is accepted in. */
export const PLAYER_SETTINGS_LIMIT_BYTES = 4096;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether `v` is exactly a `PlayerSettings`: every field present and of its type, and no other field. */
export function isPlayerSettings(v: unknown): v is PlayerSettings {
  return isObject(v) && Object.keys(v).length === 1 && typeof v.nextEpisodeCountdown === 'boolean';
}

/**
 * Each person's player settings in `users/<personId>/player-settings.json`, replaced atomically. A missing or broken
 * file reads as the defaults, a field that is missing or of the wrong type as its default, and a field this server
 * doesn't know is ignored.
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
    };
  }

  /** Replaces the person's settings. */
  put(personId: string, settings: PlayerSettings): void {
    const file = this.file(personId);
    mkdirSync(join(this.dataDir, 'users', personId), { recursive: true });
    replaceAtomically(file, JSON.stringify({ nextEpisodeCountdown: settings.nextEpisodeCountdown }));
  }
}
