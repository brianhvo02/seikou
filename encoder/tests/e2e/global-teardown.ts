// SPDX-License-Identifier: LGPL-3.0-or-later
import { rmSync } from 'node:fs';

/** The temporary folders playwright.encoder.config.ts made for the run: both data directories, the app's library and its output folder. */
const FOLDERS = ['SEIKOU_ENCODE_E2E_DATA', 'SEIKOU_ENCODE_E2E_APP_DATA', 'SEIKOU_ENCODE_E2E_LIBRARY', 'SEIKOU_ENCODE_E2E_OUT'];

/** Removes the run's temporary folders, so no encoded file is left in the temporary directory. */
export default function globalTeardown(): void {
  for (const name of FOLDERS) {
    const dir = process.env[name];
    if (dir !== undefined && dir.includes('seikou-encode-e2e-')) rmSync(dir, { recursive: true, force: true });
  }
}
