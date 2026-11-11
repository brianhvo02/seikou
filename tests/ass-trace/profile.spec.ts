import { test } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { readTimes, syntheticFixtures, type AssFixture } from './fixtures';

function localDir(dir: string): AssFixture {
  const name = dir.split('/').pop()!;
  const fonts = ['fixtures/ass/fonts/DejaVuSans.ttf', ...readdirSync('fixtures/local/ass/ASS_SET_A/attachments').map((f) => `fixtures/local/ass/ASS_SET_A/attachments/${f}`)];
  return { name, script: `/${dir}/${name}.ass`, fonts: fonts.map((f) => '/' + f.split('/').map(encodeURIComponent).join('/')), times: readTimes(`${dir}/times.txt`), storage: null, golden: '' };
}
import type { AssSessionPage } from './page/types';

// ASS_PROFILE=<fixture> prints the functions with the most self time while drawing the fixture's frames
const name = process.env.ASS_PROFILE;
test.skip(!name, 'set ASS_PROFILE=<fixture>');
test('profile', async ({ page }) => {
  // a synthetic fixture by name, or a folder holding <name>.ass, times.txt and font files
  const fx = syntheticFixtures().find((f) => f.name === name) ?? localDir(name!);
  await page.goto('/tests/ass-trace/page/index.html');
  await page.waitForFunction(() => 'assTrace' in window);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  // the session draws without returning frames
  await page.evaluate(([s, f, st]) => (window as unknown as { assSession: AssSessionPage }).assSession.open(s, f, st), [fx.script, fx.fonts, fx.storage] as const);
  const out = await page.evaluate((t) => (window as unknown as { assSession: AssSessionPage }).assSession.step(t, null, {}, []), fx.times);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map<string, number>();
  const dt = profile.timeDeltas ?? [];
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  (profile.samples ?? []).forEach((id, i) => {
    const n = byId.get(id)!;
    const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  console.log('render ms:', JSON.stringify(out.renderMs.map((r) => Math.round(r.ms * 10) / 10)));
  console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n'));
});
