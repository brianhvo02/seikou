// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test } from '@playwright/test';
import type { DeviceCheckPage } from './page/types';

/** Not a libass comparison: the device-font fallback (device-fonts.ts), in a worker as the engine runs it. */
test.describe('device fonts', () => {
  test('a family nothing supplied is drawn with the installed font, and not reported missing', async ({ page }) => {
    await page.goto('/tests/ass-trace/page/device.html');
    await page.waitForFunction(() => 'deviceCheck' in window);
    const installed = await page.evaluate(() => (window as unknown as { deviceCheck: DeviceCheckPage }).deviceCheck.localOnPage('Arial'));
    test.skip(!installed, 'Arial is not installed on this device (or the browser refuses local() for it)');
    const r = await page.evaluate(() => (window as unknown as { deviceCheck: DeviceCheckPage }).deviceCheck.inWorker('Arial'));
    expect(r.fallback).toBe(false);
    expect(r.missingFamilies).toEqual([]);
    expect(r.ascender - r.descender).toBeGreaterThan(0);
    expect(Math.abs(r.advance - r.defaultAdvance)).toBeGreaterThan(5); // Arial is narrower than DejaVu Sans
  });

  test('a family the device lacks falls back to the default font and is reported missing', async ({ page }) => {
    await page.goto('/tests/ass-trace/page/device.html');
    await page.waitForFunction(() => 'deviceCheck' in window);
    const r = await page.evaluate(() => (window as unknown as { deviceCheck: DeviceCheckPage }).deviceCheck.inWorker('Starfall Wanderer Sans'));
    expect(r.fallback).toBe(true);
    expect(r.missingFamilies).toEqual(['Starfall Wanderer Sans']);
    expect(r.advance).toBeCloseTo(r.defaultAdvance, 3);
  });
});
