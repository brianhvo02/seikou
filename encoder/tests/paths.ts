// SPDX-License-Identifier: LGPL-3.0-or-later
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The encoder's own directory. Tests run from the repository root, so fixture and script paths resolve from here. */
export const encoderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** An absolute path for a path written relative to the encoder directory, such as `fixtures/disc1`. */
export function fx(relative: string): string {
  return resolve(encoderDir, relative);
}
