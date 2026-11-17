// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { setFolder, skipWithoutH264 } from './support';
import { telemetry } from './telemetry';

// disc3's playlist has Japanese LPCM first and English AC-3 second: with no preference the disc starts on its first
// track; with English audio pinned it starts on the English one.
const DISC = 'fixtures/synthetic/disc3';

async function openDisc3(page: Page): Promise<void> {
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
}

test("a pinned audio language picks the disc's starting track, and is kept on this device", async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await page.getByTestId('disc-preferences-button').click();
  const audio = page.getByTestId('pref-audio');
  await expect(audio).toHaveValue('auto');
  await expect(audio.locator('option').first()).toHaveText("Auto (disc's choice)");
  await audio.selectOption('eng');
  await page.getByTestId('pref-done').click();
  await expect(page.getByTestId('disc-preferences')).toBeHidden();
  await openDisc3(page);
  await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe('Dolby Digital (AC-3)');

  await page.goto('/?telemetry=1'); // a new page: the preference comes back from this device's copy
  await page.getByTestId('disc-preferences-button').click();
  await expect(page.getByTestId('pref-audio')).toHaveValue('eng');
});

test('with Auto the disc starts on its own first track', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await openDisc3(page);
  await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe('LPCM');
});

test("Settings in the player opens Disc preferences, which the player's keys leave alone", async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await openDisc3(page);
  await page.getByTestId('player').hover();
  await page.getByTestId('player-settings-menu').click();
  await page.getByTestId('disc-preferences-item').click();
  await expect(page.getByTestId('disc-preferences')).toBeVisible();
  await expect(page.getByText('Applies from the next disc you open.')).toBeVisible();
  await page.getByTestId('pref-audio').focus();
  await page.keyboard.press('Space'); // not play/pause while the dialog is open
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('disc-preferences')).toBeHidden();
});
