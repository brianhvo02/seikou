// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { setFolder, skipWithoutH264 } from './support';

// disc3's playlist has Japanese LPCM first and English AC-3 second: with no preference the disc starts on its first
// track; with English audio pinned it starts on the English one.
const DISC = 'fixtures/synthetic/disc3';

/** The audio track the Audio menu shows as playing. */
async function selectedAudio(page: Page): Promise<string | null> {
  await page.getByTestId('player').hover();
  await page.getByTestId('audio-menu').click();
  const checked = page.locator('[data-testid^=audio-track-][aria-checked=true]');
  const id = await checked.first().getAttribute('data-testid');
  await page.keyboard.press('Escape');
  return id;
}

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
  await expect.poll(() => selectedAudio(page), { timeout: 10_000 }).toBe('audio-track-2');

  await page.goto('/?telemetry=1'); // a new page: the preference comes back from this device's copy
  await page.getByTestId('disc-preferences-button').click();
  await expect(page.getByTestId('pref-audio')).toHaveValue('eng');
});

test('with Auto the disc starts on its own first track', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await openDisc3(page);
  await expect.poll(() => selectedAudio(page), { timeout: 10_000 }).toBe('audio-track-1');
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
  await page.locator('#disc-prefs-title').click(); // focus on the dialog, not a dropdown (Space would open one)
  await page.keyboard.press('Space'); // not play/pause while the dialog is open
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('disc-preferences')).toBeHidden();
});
