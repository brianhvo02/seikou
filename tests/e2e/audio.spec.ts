import { expect, test, type Page } from '@playwright/test';
import { collectWindows, expectInSync, telemetry } from './telemetry';
import { CHROME_ONLY, setFolder, skipWithoutH264 } from './support';

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, CHROME_ONLY);

const DISC = 'fixtures/synthetic/disc3';
const TRACKS = [
  { index: 1, codec: 'LPCM', decoding: 'LPCM, stereo' },
  { index: 2, codec: 'Dolby Digital (AC-3)', decoding: 'Dolby Digital (AC-3), stereo' },
  // decoded whole on a computer: the MLP part's own stereo presentation, not the AC-3 core
  { index: 3, codec: 'Dolby TrueHD', decoding: 'Dolby TrueHD, lossless, stereo' },
  { index: 4, codec: 'DTS', decoding: 'DTS, stereo' },
];

async function seekTo(page: Page, fraction: number): Promise<void> {
  await page.getByTestId('player').hover();
  const bar = await page.getByTestId('seek').boundingBox();
  if (!bar) throw new Error('seek bar not found');
  await page.mouse.click(bar.x + bar.width * fraction, bar.y + bar.height / 2);
}

/** The clock follows audio and moves: right after a seek it is in audio mode before the output has started. */
async function audioClockAdvancing(page: Page): Promise<boolean> {
  const a = await telemetry(page);
  await page.waitForTimeout(600); // telemetry refreshes every 500 ms
  const b = await telemetry(page);
  return a?.clockMode === 'audio' && b?.clockMode === 'audio' && b.clockUs - a.clockUs > 300_000;
}

test('plays every audio track of the disc in sync', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });

  for (const track of TRACKS) {
    await page.getByTestId('player').hover();
    if (track.index !== 1) {
      await page.getByTestId('audio-menu').click();
      await page.getByTestId(`audio-track-${track.index}`).click();
    }
    await seekTo(page, 1 / 12);
    await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
    await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe(track.codec);
    await expect.poll(async () => (await telemetry(page))?.audioDecoding, { timeout: 10_000 }).toBe(track.decoding);
    // The output may start slowly when another browser opens a stream at the same moment (parallel CI workers);
    // the player then runs on the wall clock and moves back onto audio by itself with a seek. Measure after that,
    // allowing the 1 s the spec gives sync to settle after a seek.
    await expect.poll(() => audioClockAdvancing(page), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(1000);
    const start = (await telemetry(page))?.clockUs ?? 0;
    const underrunsBefore = (await telemetry(page))?.audioUnderruns ?? 0;
    const windows = await collectWindows(page, start + 3_000_000);
    expect(windows.length).toBeGreaterThan(3);
    expectInSync(windows.slice(1));
    expect(windows.map((w) => w.clockMode)).toEqual(windows.map(() => 'audio')); // never fell back to the wall clock mid-track
    const t = await telemetry(page);
    expect(t?.clockMode).toBe('audio');
    expect(t?.audioDecodeErrors).toBe(0);
    expect(t?.audioUnderruns).toBe(underrunsBefore);
  }
});

test('A cycles the audio track and shows which one is playing', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await page.keyboard.press('a');
  await expect(page.getByRole('status').filter({ hasText: 'Audio: 2. English · Dolby Digital (AC-3) (multichannel)' })).toBeVisible();
  await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe('Dolby Digital (AC-3)');
});

test('the audio menu works from the keyboard without seeking or changing volume', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await page.getByTestId('player').hover();
  await page.getByTestId('audio-menu').click();
  await expect(page.getByTestId('audio-track-1')).toBeFocused(); // the selected track
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('audio-track-2')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('audio-track-4')).toBeFocused();
  await page.keyboard.press('ArrowDown'); // wraps
  await expect(page.getByTestId('audio-track-1')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('audio-menu')).toBeFocused(); // back on the button
  await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe('DTS');
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('1');
  expect(Number(await page.getByTestId('seek').inputValue())).toBeLessThan(6_000_000); // no 10 s jumps from the arrows

  await page.getByTestId('player').hover();
  await page.getByTestId('audio-menu').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('audio-track-1')).toBeHidden();
  await expect(page.getByTestId('audio-menu')).toBeFocused();
});

test('TrueHD plays lossless on a computer, marked in the Audio menu, and through its core on a phone', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await page.getByTestId('player').hover();
  await page.getByTestId('audio-menu').click();
  await page.getByTestId('audio-track-3').click();
  await expect.poll(async () => (await telemetry(page))?.audioDecoding, { timeout: 10_000 }).toBe('Dolby TrueHD, lossless, stereo');
  expect((await telemetry(page))?.audioOutputChannels).toBe(2);
  await page.getByTestId('player').hover();
  await page.getByTestId('audio-menu').click();
  await expect(page.getByTestId('audio-track-3').getByTestId('audio-decoding')).toHaveText('lossless');

  await page.goto('/?telemetry=1&memory=constrained');
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await page.getByTestId('player').hover();
  await page.getByTestId('audio-menu').click();
  await page.getByTestId('audio-track-3').click();
  await expect.poll(async () => (await telemetry(page))?.audioDecoding, { timeout: 10_000 }).toBe('Dolby TrueHD, Dolby Digital core, stereo');
});
