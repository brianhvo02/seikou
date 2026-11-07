// SPDX-License-Identifier: LGPL-3.0-or-later
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The directory where the encoder keeps what it learns and downloads: saved subtitle records, fetched
 * tracks and fonts, and the BestSource index cache.
 *
 * `SEIKOU_ENCODE_DATA` wins when set and non-empty (tests use it). Otherwise macOS uses
 * `~/Library/Application Support/seikou-encode`, and every other platform `$XDG_DATA_HOME/seikou-encode`
 * (default `~/.local/share/seikou-encode`). The directory is not created here.
 */
export function appDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.SEIKOU_ENCODE_DATA) return env.SEIKOU_ENCODE_DATA;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'seikou-encode');
  const base = env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(base, 'seikou-encode');
}
