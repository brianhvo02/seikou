import { expect, test, type ElementHandle } from '@playwright/test';
import { setFolder } from './support';

// setFolder works around Playwright 1.64's setInputFiles(folder), which attaches its listener for the input's `input`
// event only after sending the files and so can miss it (support.ts). The first test replays that miss with a stand-in
// for the element; the second checks the helper against a real folder input.

/** An element whose `input` event fires once the files are set, and whose setInputFiles never settles. */
function missedEventInput(): { input: ElementHandle; listening: () => boolean } {
  const listeners: Array<() => void> = [];
  const handle = {
    evaluateHandle: async (fn: (el: { addEventListener: (type: string, cb: () => void) => void }) => unknown) => {
      const value = fn({ addEventListener: (type, cb) => type === 'input' && listeners.push(cb) });
      return { evaluate: async (read: (v: unknown) => unknown) => read(value), dispose: async () => undefined };
    },
    // a stand-in belongs to no frame, so setFolder has no page whose viewport it would resize
    ownerFrame: async () => null,
    setInputFiles: () => {
      // Firefox fires the event before Playwright's own listener is in place: only listeners already attached see it
      for (const cb of listeners) cb();
      return new Promise<void>(() => undefined);
    },
  };
  return { input: handle as unknown as ElementHandle, listening: () => listeners.length > 0 };
}

test('returns once the input event fires even when setInputFiles never returns', async () => {
  const { input, listening } = missedEventInput();
  await expect(Promise.race([setFolder(input, 'fixtures/synthetic/disc1').then(() => 'returned'), new Promise((r) => setTimeout(r, 2000, 'hung'))])).resolves.toBe('returned');
  expect(listening()).toBe(true);
});

test('sets a real folder on a folder input', async ({ page }) => {
  await page.setContent('<input type="file" webkitdirectory multiple>');
  await setFolder(page.locator('input'), 'fixtures/synthetic/disc1');
  expect(await page.locator('input').evaluate((el: HTMLInputElement) => [...el.files!].some((f) => f.name === 'index.bdmv'))).toBe(true);
});
