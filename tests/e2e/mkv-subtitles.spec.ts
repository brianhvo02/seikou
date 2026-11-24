import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CHROME_ONLY, setFolder, skipWithoutH264 } from './support';

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, CHROME_ONLY);

// fixtures/encodes/990001/1.mkv holds ASS tracks with an attached font and Cues. It is copied under test-results/ with
// a release-style, made-up name, as an owner would have it on a share.
const DISC = 'fixtures/synthetic/disc1';
const RELEASE_NAME = '[Lantern Subs] Starfall Wanderer - 01 [1080p].mkv';

interface MkvTelemetry {
  textCue: boolean;
  textFile: number | null;
  ass: { events: number } | null;
}

const telemetry = (page: Page): Promise<MkvTelemetry | null> =>
  page.evaluate(() => (window as unknown as { __blurayTelemetry?: MkvTelemetry | null }).__blurayTelemetry ?? null);

test('a viewer picks an MKV on the player and its subtitle loads', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath('release');
  mkdirSync(dir, { recursive: true });
  const mkv = join(dir, RELEASE_NAME);
  copyFileSync('fixtures/encodes/990001/1.mkv', mkv);

  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });

  await page.getByTestId('player').hover();
  await page.getByTestId('subtitle-menu').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('subtitle-load').click();
  await (await chooser).setFiles(mkv);

  await expect.poll(async () => (await telemetry(page))?.textFile ?? null, { timeout: 30_000 }).toBe(0);
  await expect.poll(async () => (await telemetry(page))?.ass?.events ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  await page.getByTestId('player').hover();
  const menu = page.getByTestId('subtitle-menu');
  if ((await page.getByTestId('mkv-track').count()) === 0) await menu.click();
  await expect(page.getByTestId('mkv-track').first()).toBeVisible();
  await expect(page.locator('[data-testid="mkv-track"][aria-current="true"]')).toHaveCount(1);
});
