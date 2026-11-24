// Times BD-J start-up (the `bdj` telemetry, cold and warm) in headless Chrome, or WebKit with ENGINE=webkit, against a
// running preview: npx tsx tests/bdj/bench-browser.ts <origin> <disc dir> <runs> [query…] (`-` for no query), e.g.
// `- jit=1` to compare the interpreter with the JIT. BENCH_LOG=1 prints the page's console for an open over 15 s.
import { chromium, webkit } from '@playwright/test';
const [origin, disc, runsArg, ...queryArgs] = process.argv.slice(2);
// each run opens the disc once per query, in turn, so a load that drifts weighs on every query alike
const queries = queryArgs.length > 0 ? queryArgs.map((q) => (q === '-' ? '' : q)) : [''];
const runs = Number(runsArg ?? 3);
const browser = process.env.ENGINE === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chrome', headless: true });
type S = { bootMs?: number; firstPlaylistMs?: number; firstFrameMs?: number };
const out = new Map<string, { cold: S; warm: S }[]>(queries.map((q) => [q, []]));
for (let i = 0; i < runs; i++) for (const query of queries) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  // the page's console, printed when an open takes over 15 s (BENCH_LOG=1), to see what a slow start-up waited on
  let lines: string[] = [];
  page.on('console', (m) => lines.push(`${(performance.now() / 1000).toFixed(1)} ${m.text().slice(0, 300)}`));
  const open = async (): Promise<S> => {
    lines = [];
    await page.goto(`${origin}/?telemetry=1${query ? '&' + query : ''}`);
    await page.getByTestId('folder-input').setInputFiles(disc!);
    const deadline = Date.now() + 90_000;
    for (;;) {
      const s = await page.evaluate(() => (window as unknown as { __blurayTelemetry?: { bdj?: S | null } }).__blurayTelemetry?.bdj ?? null);
      if (s?.firstFrameMs != null) {
        if (process.env.BENCH_LOG && s.firstFrameMs > 15_000) console.log(`slow open (${s.firstFrameMs} ms), console:\n${lines.join('\n')}`);
        return { bootMs: s.bootMs, firstPlaylistMs: s.firstPlaylistMs, firstFrameMs: s.firstFrameMs };
      }
      if (Date.now() > deadline) throw new Error('timeout');
      await page.waitForTimeout(50);
    }
  };
  const cold = await open();
  const warm = await open();
  out.get(query)!.push({ cold, warm });
  console.log(JSON.stringify({ run: i, query, cold, warm }));
  await ctx.close();
}
const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
for (const [query, rows] of out) {
  for (const k of ['cold', 'warm'] as const) {
    for (const f of ['bootMs', 'firstPlaylistMs', 'firstFrameMs'] as const) {
      console.log(`[${query || 'default'}]`, k, f, 'median', med(rows.map((o) => o[k][f] ?? NaN)).toFixed(0), 'all', rows.map((o) => (o[k][f] ?? NaN).toFixed(0)).join(' '));
    }
  }
}
await browser.close();
