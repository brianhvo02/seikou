import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseAss } from '@seikou/ass/parse';
import { decodeText } from '@seikou/engine/subs/srt';
import { compareTraces, formatDiffs } from './compare';
import { readTimes } from './fixtures';
import { parseTrace, type TraceEvent } from './format';
import type { AssSessionPage } from './page/types';
import { comparePixels } from './pixels';
import { decodePng, encodePng } from './png';
import { traceScript } from './run';
import { localFixtures, sampleTimes } from './times';

// ASS_LOCAL=1: the developer's real scripts in fixtures/local/ass/<name>/ (a script, its fonts, an optional
// times.txt) against libass run live in Docker (npm run ass-trace:build first); goldens are cached by content.
// An optional exceptions.json ({"events": {"<event index>": "reason"}}) lists differences recorded in
// docs/known-issues.md: they stay in the report but don't fail the gate (a pixel failure is excused when
// any event in the frame is).
const fixtures = process.env.ASS_LOCAL ? localFixtures() : [];
test.skip(!process.env.ASS_LOCAL, 'set ASS_LOCAL=1 (and put files in fixtures/local/ass/<name>/)');
test.skip(process.env.ASS_LOCAL !== undefined && fixtures.length === 0, 'no fixtures in fixtures/local/ass');
test.setTimeout(60 * 60_000);

const CHUNK = 20;
const BUDGET_MS = 8;
const url = (path: string): string => '/' + path.split('/').map(encodeURIComponent).join('/');

/** libass's layout trace and frames for the fixture, from the cache when nothing changed. */
function goldens(fx: (typeof fixtures)[number], times: readonly number[]): { dir: string; trace: TraceEvent[] } {
  const dir = join('tools/ass-trace/out/local', fx.name);
  const fontsDir = join(dir, 'fonts');
  const hash = createHash('sha256');
  hash.update(readFileSync(fx.script));
  for (const f of fx.fonts) hash.update(basename(f)).update(readFileSync(f));
  hash.update(times.join(','));
  const key = hash.digest('hex');
  const keyFile = join(dir, 'key');
  if (!existsSync(keyFile) || readFileSync(keyFile, 'utf8') !== key) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(fontsDir, { recursive: true });
    for (const f of fx.fonts) copyFileSync(f, join(fontsDir, basename(f)));
    copyFileSync('fixtures/ass/fonts/DejaVuSans.ttf', join(fontsDir, 'DejaVuSans.ttf')); // the default font, as in our engine
    writeFileSync(join(dir, 'times.txt'), times.join('\n') + '\n');
    traceScript(fx.script, fontsDir, join(dir, 'times.txt'), join(dir, 'frames'));
    writeFileSync(keyFile, key);
  }
  return { dir, trace: parseTrace(readFileSync(join(dir, 'frames', 'trace.jsonl'), 'utf8')) };
}

for (const fx of fixtures) {
  test(`real script matches libass: ${fx.name}`, async ({ page }) => {
    const decoded = decodeText(new Uint8Array(readFileSync(fx.script)));
    if ('needsEncoding' in decoded) throw new Error(`${fx.script} is not UTF-8`);
    const track = parseAss(decoded.text);
    const times = sampleTimes(track, fx.timesFile ? readTimes(fx.timesFile) : null);
    const golden = goldens(fx, times);
    const exceptionsFile = join(fx.dir, 'exceptions.json');
    const excused = new Map<number, string>(
      existsSync(exceptionsFile) ? Object.entries((JSON.parse(readFileSync(exceptionsFile, 'utf8')) as { events: Record<string, string> }).events).map(([k, v]) => [Number(k), v]) : [],
    );
    const boxes: Record<number, [number, number, number, number][]> = {};
    for (const e of golden.trace) (boxes[e.t] ??= []).push([...e.box]);

    await page.goto('/tests/ass-trace/page/index.html');
    await page.waitForFunction(() => 'assSession' in window);
    const { missingFamilies } = await page.evaluate(([s, f]) => (window as unknown as { assSession: AssSessionPage }).assSession.open(s, f, null), [url(fx.script), [...fx.fonts, 'fixtures/ass/fonts/DejaVuSans.ttf'].map(url)] as const);
    const missing = new Set(missingFamilies.map((f) => f.toLowerCase()));
    // frames with a run in a missing family are drawn in different fallbacks by design
    const skip = [...new Set(golden.trace.filter((e) => e.runs.some((r) => missing.has(r.font.split('|')[0]!.toLowerCase()))).map((e) => e.t))];

    const out = `test-results/ass-local/${fx.name}`;
    mkdirSync(out, { recursive: true });
    let trace = '';
    const failures: { t: number; text: string }[] = [];
    const animatedMs: number[] = [];
    const animatedFrames: { t: number; ms: number }[] = [];
    for (let i = 0; i < times.length; i += CHUNK) {
      const chunk = times.slice(i, i + CHUNK);
      const step = await page.evaluate(
        ([t, base, b, sk]) => (window as unknown as { assSession: AssSessionPage }).assSession.step(t, base, b, sk),
        [chunk, url(join(golden.dir, 'frames')), boxes, skip] as const,
      );
      trace += step.trace;
      for (const r of step.results) {
        if (r.pass) continue;
        failures.push({ t: r.t, text: `${r.t} ms: ${r.differing} px differ (budget ${r.budget})` });
        if (failures.length <= 20) {
          // ours, and pixelmatch's diff against libass's frame (in the golden directory)
          const actual = Uint8Array.from(Buffer.from(r.actual!, 'base64'));
          const expected = decodePng(readFileSync(join(golden.dir, 'frames', `${r.t}.png`))).rgba;
          writeFileSync(`${out}/${r.t}-actual.png`, encodePng(1920, 1080, actual));
          writeFileSync(`${out}/${r.t}-diff.png`, encodePng(1920, 1080, comparePixels(expected, actual, 1920, 1080, boxes[r.t] ?? []).diff));
        }
      }
      // draw times of animated frames that follow the previous sampled frame closely (a sign playing)
      step.renderMs.forEach((m, k) => {
        const prev = k > 0 ? chunk[k - 1]! : times[i - 1];
        if (m.animated && prev !== undefined && m.t - prev <= 41) {
          animatedMs.push(m.ms);
          animatedFrames.push(m);
        }
      });
    }
    writeFileSync(join(golden.dir, 'ours.jsonl'), trace);
    const allDiffs = compareTraces(golden.trace, parseTrace(trace), { tolerance: 0.5, missingFamilies: missing });
    const diffs = allDiffs.filter((d) => !excused.has(d.event));
    const eventsAt = (t: number): string => golden.trace.filter((e) => e.t === t).map((e) => e.event).join(',');
    const isExcused = (t: number): boolean => golden.trace.some((e) => e.t === t && excused.has(e.event));
    const unexcused = failures.filter((f) => !isExcused(f.t));
    const slowest = [...animatedFrames].sort((a, b) => b.ms - a.ms).slice(0, 15).map((f) => `${f.t} ms (events ${eventsAt(f.t)}): ${f.ms.toFixed(1)} ms`);
    animatedMs.sort((a, b) => a - b);
    const p95 = animatedMs.length ? animatedMs[Math.floor(0.95 * (animatedMs.length - 1))]! : 0;
    const report = [
      `# ${fx.name}`,
      `times: ${times.length}, missing families: ${[...missingFamilies].join(', ') || 'none'} (${skip.length} frames not compared)`,
      `layout differences: ${diffs.length} (${allDiffs.length - diffs.length} more in recorded exceptions)`,
      formatDiffs(diffs, 100),
      `pixel failures: ${unexcused.length} (${failures.length - unexcused.length} more in recorded exceptions)`,
      ...unexcused.slice(0, 100).map((f) => `${f.text} (events ${eventsAt(f.t)})`),
      'recorded exceptions:',
      ...[...excused].map(([e, why]) => `event ${e}: ${why} (${allDiffs.filter((d) => d.event === e).length} layout differences, ${failures.filter((f) => golden.trace.some((g) => g.t === f.t && g.event === e)).length} frames failing)`),
      'slowest animated draws:',
      ...slowest,
      `animated draws: ${animatedMs.length}, p95 ${p95.toFixed(1)} ms (budget ${BUDGET_MS} ms)`,
    ].join('\n');
    writeFileSync(`${out}/report.md`, report + '\n');
    console.log(report.split('\n').slice(0, 3).concat(report.split('\n').slice(-1)).join('\n'));
    expect(diffs, formatDiffs(diffs, 30)).toEqual([]);
    expect(unexcused.map((f) => f.text)).toEqual([]);
    expect(p95).toBeLessThan(BUDGET_MS);
  });
}
