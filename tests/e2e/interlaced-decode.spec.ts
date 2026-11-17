// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { setFolder, skipWithoutH264 } from './support';
import { telemetry } from './telemetry';

// disc-interlaced's playlists are 1080i H.264 (scripts/make-interlaced-disc.ts). Whether a browser's WebCodecs decodes
// interlaced H.264 at all decides how the player deinterlaces it: this records, per project, that every frame decodes.
// 00003 is soft pulldown: its coded frames are 24p, so 3 s present about 72 of them (the others carry 29.97 frames).
const PLAYLISTS = [
  { id: '00000', what: 'interlaced, top field first', minFrames: 80 },
  { id: '00001', what: 'interlaced, bottom field first', minFrames: 80 },
  { id: '00002', what: 'hard 3:2 telecine', minFrames: 80 },
  { id: '00003', what: 'soft 3:2 pulldown', minFrames: 60 },
];

for (const { id, what, minFrames } of PLAYLISTS) {
  test(`each interlaced playlist decodes every frame in this browser: ${id} (${what})`, async ({ page }, testInfo) => {
    await page.goto('/?telemetry=1&videopath=canvas');
    await skipWithoutH264(page);
    await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/disc-interlaced');
    await page.getByTestId(`playlist-${id}`).click();
    await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
    // Three seconds of playlist time, not of wall time: a cold start would otherwise cost frames.
    await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(3_000_000);
    const t = await telemetry(page);
    console.log(`${testInfo.project.name} ${id}: decoderErrors=${t?.decoderErrors} framesPresented=${t?.framesPresented}`);
    expect(t?.decoderErrors).toBe(0);
    expect(t?.framesPresented ?? 0).toBeGreaterThanOrEqual(minFrames);
  });
}
