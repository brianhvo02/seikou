// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/** The helper's port: fixed, so the run's address is known, and used by no other Playwright config. */
const PORT = 4195;
/** The app's port, fixed for the same reason. */
const APP_PORT = 4197;

// One data directory for the whole run. The config is loaded again in every worker; the workers inherit this
// process's environment, so they all see the directory made here and the test can read the saved record from it.
process.env.SEIKOU_ENCODE_E2E_DATA ??= mkdtempSync(join(tmpdir(), 'seikou-encode-e2e-'));

// The app's library folder holds copies of two fixture discs (the library does not follow a link out of its folder),
// and its encodes go to a folder of their own, outside the library and the data directories. The global teardown
// removes all of these; it runs in this process, so it sees the variables set here.
if (process.env.SEIKOU_ENCODE_E2E_LIBRARY === undefined) {
  const library = mkdtempSync(join(tmpdir(), 'seikou-encode-e2e-library-'));
  for (const name of ['disc-speech', 'disc1']) cpSync(join('encoder', 'fixtures', name), join(library, name), { recursive: true });
  process.env.SEIKOU_ENCODE_E2E_LIBRARY = library;
}
process.env.SEIKOU_ENCODE_E2E_APP_DATA ??= mkdtempSync(join(tmpdir(), 'seikou-encode-e2e-app-data-'));
process.env.SEIKOU_ENCODE_E2E_OUT ??= mkdtempSync(join(tmpdir(), 'seikou-encode-e2e-out-'));

/**
 * The subtitle helper end to end: `seikou-encode serve` over the speech disc, with recorded SeaDex, Anime Tosho and
 * AniList answers, driven in installed Chrome. The helper's address carries a token that is new on every run, so it
 * is read from the server's output (`process.env.HELPER_URL`) and a running server is never reused.
 *
 * The app end to end is the second project: `seikou-encode app` over a library of the speech disc and disc1, whose
 * address with its token is `process.env.APP_URL`.
 */
export default defineConfig({
  testDir: 'encoder/tests/e2e',
  testMatch: /.*\.spec\.ts/,
  globalTeardown: './encoder/tests/e2e/global-teardown.ts',
  timeout: 180_000,
  use: {
    channel: 'chrome',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [
    { name: 'helper', testMatch: /helper\.spec\.ts/ },
    { name: 'app', testMatch: /app\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `npm run encoder:web:build && npm run seikou-encode -- serve encoder/fixtures/disc-speech --playlist 00000 --episodes "1-3,4-5" --port ${PORT} --no-open`,
      env: {
        SEIKOU_ENCODE_FIXTURE: 'encoder/tests/fixtures/fansubs',
        SEIKOU_ENCODE_DATA: process.env.SEIKOU_ENCODE_E2E_DATA,
      },
      wait: { stdout: /Helper: (?<helper_url>http:\/\/\S+)/ },
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run seikou-encode -- app --root "${process.env.SEIKOU_ENCODE_E2E_LIBRARY}" --port ${APP_PORT} --no-open`,
      env: {
        SEIKOU_ENCODE_FIXTURE: 'encoder/tests/fixtures/fansubs',
        SEIKOU_ENCODE_DATA: process.env.SEIKOU_ENCODE_E2E_APP_DATA,
      },
      wait: { stdout: /App: (?<app_url>http:\/\/\S+)/ },
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
