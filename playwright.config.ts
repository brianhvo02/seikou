import { defineConfig, devices } from '@playwright/test';
import { NAS_PORT, RENDEZVOUS_URL } from './tests/e2e/nas-server';

/** The preview server's port: E2E_PORT moves it off 4173 when another checkout's preview is using that. */
const PORT = Number(process.env.E2E_PORT ?? 4173);

/**
 * A desktop's screen: realistic, and not a phone to the player's auto quality rule (short side under 600).
 */
const DESKTOP_SCREEN = { width: 1920, height: 1080 };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // The service worker's install and precache would run during the A/V sync tests; offline.spec.ts allows it.
  // CI keeps a trace of each failure (uploaded with test-results/): a stall that only CI shows can be read step by step.
  use: { baseURL: `http://localhost:${PORT}`, serviceWorkers: 'block', trace: process.env.CI ? 'retain-on-failure' : 'off' },
  projects: [
    {
      name: 'chromium',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: { channel: 'chrome', screen: DESKTOP_SCREEN, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
    },
    {
      name: 'firefox',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: {
        ...devices['Desktop Firefox'],
        screen: DESKTOP_SCREEN,
        launchOptions: {
          firefoxUserPrefs: {
            'media.autoplay.default': 0,
            // The NAS drops mDNS (.local) candidates, and Firefox never checks the loopback address the NAS E2E's
            // WebRTC route advertises, so Firefox gives its host addresses in the clear for the NAS to check
            'media.peerconnection.ice.obfuscate_host_addresses': false,
          },
        },
      },
    },
    {
      name: 'webkit',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: { ...devices['Desktop Safari'], screen: DESKTOP_SCREEN },
    },
    {
      name: 'mobile-chromium',
      // the mobile specs, and the BD-J menu, saved-data, no-picture and error specs, which run on every project
      testMatch: /\/(mobile-.*|bdj-menu|bdj-store|unsupported-video|errors|theme)\.spec\.ts/,
      use: { ...devices['Pixel 7'], channel: 'chrome', hasTouch: true, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
    },
  ],
  webServer: [
    {
      command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      // nas.spec.ts pairs through the rendezvous stand-in that tests/e2e/nas-server.ts starts.
      env: { VITE_RENDEZVOUS_URL: RENDEZVOUS_URL },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // The built NAS server over a copy of fixtures/synthetic, and the rendezvous Worker (nas.spec.ts).
      command: 'npm run server:build && npx tsx tests/e2e/nas-server.ts',
      url: `http://localhost:${NAS_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
