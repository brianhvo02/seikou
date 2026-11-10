import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ASS_OVER_BUDGET_SHARE, collectWindows, expectInSync } from './telemetry';
import { renamedFont } from './font-rename';
import { CHROME_ONLY, setFolder, skipWithoutH264 } from './support';

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, CHROME_ONLY);

// fixtures/synthetic/disc1: playlist 00000 is two 4 s play items (an "episode" each here) with chapters every 2 s.
const DISC = 'fixtures/synthetic/disc1';
const FX = 'tests/e2e/fixtures';
const FONTS = 'fixtures/ass/fonts';

interface AssTelemetry {
  clockUs: number;
  textCue: boolean;
  textFile: number | null;
  ass: { events: number; animated: number; renderMs: number; overBudget: number; renders: number } | null;
}

const telemetry = (page: Page): Promise<AssTelemetry | null> =>
  page.evaluate(() => (window as unknown as { __blurayTelemetry?: AssTelemetry | null }).__blurayTelemetry ?? null);

async function sampleBetween(page: Page, fromUs: number, toUs: number): Promise<AssTelemetry> {
  let found: AssTelemetry | null = null;
  await expect
    .poll(async () => {
      const t = await telemetry(page);
      if (t && t.clockUs >= fromUs && t.clockUs < toUs) found = t;
      if (t && t.clockUs >= toUs && !found) throw new Error(`no telemetry sample between ${fromUs} and ${toUs} us (now ${t.clockUs})`);
      return found !== null;
    }, { timeout: 15_000, intervals: [50] })
    .toBe(true);
  return found!;
}

async function play(page: Page): Promise<void> {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
}

async function openMenu(page: Page): Promise<void> {
  await page.getByTestId('player').hover();
  await page.getByTestId('subtitle-menu').click();
}

async function pick(page: Page, testId: string, paths: string[]): Promise<void> {
  await openMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId(testId).click();
  await (await chooser).setFiles(paths);
}

async function pause(page: Page): Promise<void> {
  await page.getByTestId('player').hover();
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
}

async function seekTo(page: Page, us: number): Promise<void> {
  await page.getByTestId('seek').evaluate((el, value) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, us);
}

/** Paused telemetry at a time (through 0 first, so the sample is a fresh one). */
async function at(page: Page, us: number): Promise<AssTelemetry> {
  for (const target of [0, us]) {
    await seekTo(page, target);
    await expect.poll(async () => (await telemetry(page))?.clockUs ?? -1, { timeout: 5_000, intervals: [50] }).toBe(target);
  }
  return (await telemetry(page))!;
}

test('shows an ASS file loaded with its fonts from the menu, the sign animating', async ({ page }) => {
  await play(page);
  await pick(page, 'subtitle-load', [`${FX}/sign.ass`, `${FONTS}/DejaVuSans.ttf`, `${FONTS}/DejaVuSerif.ttf`]);
  const t = await sampleBetween(page, 1_200_000, 2_800_000);
  expect(t.textCue).toBe(true);
  expect(t.ass).toMatchObject({ events: 2, animated: 1 });
  await openMenu(page);
  await expect(page.getByTestId('subtitle-text')).toHaveText('sign.ass');
  await expect(page.getByTestId('subtitle-missing-fonts')).toHaveCount(0);
});

test('loads an ASS file and its fonts dropped on the player', async ({ page }) => {
  await play(page);
  const files = [`${FX}/sign.ass`, `${FONTS}/DejaVuSans.ttf`, `${FONTS}/DejaVuSerif.ttf`].map((p) => ({ name: p.split('/').pop()!, data: readFileSync(p).toString('base64') }));
  await page.getByTestId('player').evaluate((el, list) => {
    const data = new DataTransfer();
    for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name));
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);
  const t = await sampleBetween(page, 1_200_000, 2_800_000);
  expect(t.textCue).toBe(true);
  expect(t.ass?.events).toBe(2);
});

test('names a missing family, and Add fonts… clears it', async ({ page }, testInfo) => {
  // a made-up family no device has installed (an installed one is now drawn from the device and not missing)
  const font = renamedFont(`${FONTS}/DejaVuSerif.ttf`, testInfo.outputPath('StarfallPen.ttf'), [['DejaVu Serif', 'Starfall Pen'], ['DejaVuSerif', 'StarfallPen']]);
  await play(page);
  await pick(page, 'subtitle-load', [`${FX}/missing-font.ass`]);
  await expect(page.getByRole('status').filter({ hasText: 'Some fonts are missing and were replaced: Starfall Pen' })).toBeVisible();
  await openMenu(page);
  await expect(page.getByTestId('subtitle-missing-fonts')).toHaveText('Missing fonts: Starfall Pen');
  await page.keyboard.press('Escape');
  await pick(page, 'subtitle-add-fonts', [font]);
  await openMenu(page);
  await expect(page.getByTestId('subtitle-missing-fonts')).toHaveCount(0);
});

test('] moves the ASS file by 100 ms a press', async ({ page }) => {
  await play(page);
  await pick(page, 'subtitle-load', [`${FX}/sign.ass`, `${FONTS}/DejaVuSans.ttf`, `${FONTS}/DejaVuSerif.ttf`]);
  await page.keyboard.press('Escape');
  await pause(page);
  expect((await at(page, 3_200_000)).textCue).toBe(false);
  for (let i = 0; i < 3; i++) await page.keyboard.press(']');
  await expect(page.getByRole('status').filter({ hasText: 'Subtitles +0.3 s' })).toBeVisible();
  expect((await at(page, 3_200_000)).textCue).toBe(true);
});

test('places two episode files on the two play items, and a file can be moved to a chapter', async ({ page }) => {
  await play(page);
  await pick(page, 'subtitle-load', [`${FX}/ep2.ass`, `${FX}/ep1.ass`, `${FONTS}/DejaVuSans.ttf`]);
  await openMenu(page);
  await expect(page.getByTestId('subtitle-file-0')).toContainText('ep1.ass');
  await expect(page.getByTestId('subtitle-start-0')).toHaveValue('0');
  await expect(page.getByTestId('subtitle-start-1')).toHaveValue('4000000');
  await page.keyboard.press('Escape');
  await pause(page);
  expect(await at(page, 1_000_000)).toMatchObject({ textCue: true, textFile: 0 });
  expect(await at(page, 4_200_000)).toMatchObject({ textCue: false, textFile: 1 });
  expect(await at(page, 5_000_000)).toMatchObject({ textCue: true, textFile: 1 });
  await openMenu(page);
  await page.getByTestId('subtitle-start-1').selectOption({ label: 'Chapter 2 · 0:00:02' });
  await page.keyboard.press('Escape');
  expect(await at(page, 3_000_000)).toMatchObject({ textCue: true, textFile: 1 });
});

test('keeps A/V sync with an animated ASS sign on screen', async ({ page }) => {
  await play(page);
  await pick(page, 'subtitle-load', [`${FX}/sign.ass`, `${FONTS}/DejaVuSans.ttf`, `${FONTS}/DejaVuSerif.ttf`]);
  await page.keyboard.press('Escape');
  const windows = await collectWindows(page, 7_000_000);
  expectInSync(windows.filter((w) => w.clockUs > 1_000_000));
  // the spec's budget: 95% of the sign's draws under 8 ms (its first draws build masks and caches); ASS_BUDGET_SCALE widens the share
  const ass = (await telemetry(page))!.ass!;
  console.log(`ass draws: ${ass.renders}, over 8 ms: ${ass.overBudget}`);
  expect(ass.renders).toBeGreaterThan(20);
  expect(ass.overBudget / ass.renders).toBeLessThanOrEqual(ASS_OVER_BUDGET_SHARE);
});
