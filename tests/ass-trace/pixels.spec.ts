import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syntheticFixtures } from './fixtures';
import { parseTrace } from './format';
import type { AssTracePage } from './page/types';
import { comparePixels, pixelDelta } from './pixels';
import { decodePng, encodePng } from './png';

for (const fx of syntheticFixtures()) {
  test(`pixels match libass: ${fx.name}`, async ({ page }) => {
    await page.goto('/tests/ass-trace/page/index.html');
    await page.waitForFunction(() => 'assTrace' in window);
    const out = await page.evaluate(
      ([s, f, t, st]) => (window as unknown as { assTrace: AssTracePage }).assTrace.run(s, f, t, true, st),
      [fx.script, fx.fonts, fx.times, fx.storage] as const,
    );
    const golden = parseTrace(readFileSync(fx.golden, 'utf8'));
    const missing = new Set(out.missingFamilies.map((f) => f.toLowerCase()));
    const failures: string[] = [];
    fx.times.forEach((t, i) => {
      const shown = golden.filter((e) => e.t === t);
      // a missing family is drawn in different fallback faces by libass and by us: nothing to compare
      if (shown.some((e) => e.runs.some((r) => missing.has(r.font.split('|')[0]!.toLowerCase())))) return;
      const expected = decodePng(readFileSync(fx.golden.replace(/\.jsonl$/, `/${t}.png`)));
      const actual = Uint8Array.from(Buffer.from(out.frames[i]!, 'base64'));
      const r = comparePixels(expected.rgba, actual, 1920, 1080, shown.map((e) => e.box));
      // ASS_PIXEL_LOG=1 prints every frame's count, to see how close a fixture is beyond pass or fail
      if (process.env.ASS_PIXEL_LOG) {
        const d = pixelDelta(expected.rgba, actual);
        console.log(`${fx.name} ${t} ms: ${r.differing} px differ (budget ${r.budget}); ${d.over2} px off by more than 2, at most ${d.max}`);
      }
      if (!r.pass) {
        const dir = `test-results/ass-pixels/${fx.name}`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/${t}-actual.png`, encodePng(1920, 1080, actual));
        writeFileSync(`${dir}/${t}-diff.png`, encodePng(1920, 1080, r.diff));
        failures.push(`${t} ms: ${r.differing} px differ (budget ${r.budget})`);
      }
    });
    const ms = out.renderMs.map((r) => r.ms);
    console.log(`${fx.name}: render ms max ${Math.max(...ms).toFixed(1)}, median ${ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)]!.toFixed(1)}`);
    expect(failures).toEqual([]);
  });
}
