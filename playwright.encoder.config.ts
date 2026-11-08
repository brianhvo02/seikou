// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/** The helper's port: fixed, so the run's address is known, and used by no other Playwright config. */
const PORT = 4195;

// One data directory for the whole run. The config is loaded again in every worker; the workers inherit this
// process's environment, so they all see the directory made here and the test can read the saved record from it.
process.env.SEIKOU_ENCODE_E2E_DATA ??= mkdtempSync(join(tmpdir(), 'seikou-encode-e2e-'));

/**
 * The subtitle helper end to end: `seikou-encode serve` over the speech disc, with recorded SeaDex, Anime Tosho and
 * AniList answers, driven in installed Chrome. The helper's address carries a token that is new on every run, so it
 * is read from the server's output (`process.env.HELPER_URL`) and a running server is never reused.
 */
export default defineConfig({
  testDir: 'encoder/tests/e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  use: {
    channel: 'chrome',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
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
});
