import { expect, test } from '@playwright/test';
import { setFolder } from './support';

test('explains when the folder is not a Blu-ray disc', async ({ page }) => {
  await page.goto('/');
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/not-a-disc');
  await expect(page.getByTestId('error')).toContainText('No BDMV folder');
});

test('shows a video decoder that fails to configure inside the playlist picker', async ({ page }) => {
  // ?nodecoder=1: the browser supports no video decoder configuration (@seikou/engine/worker-main), so H.264 fails to
  // configure. The canvas is forced: under Auto a stream WebCodecs can't configure goes to the video element instead.
  await page.goto('/?nodecoder=1&videopath=canvas');
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/disc1');
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('picker-error')).toContainText('This browser cannot decode H.264');
  await expect(page.getByTestId('picker-error')).toBeVisible();
});

test('names the missing files when the STREAM folder is absent', async ({ page }) => {
  await page.goto('/');
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/partial-disc');
  await expect(page.getByTestId('missing-files')).toContainText('BDMV/STREAM/00001.M2TS');
  await expect(page.getByTestId('playlist-00000')).toBeDisabled();
});
