/** The ASS fixtures the trace specs run: committed synthetic ones, and the developer's local ones. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export interface AssFixture {
  readonly name: string;
  /** URLs served by the Vite dev server. */
  readonly script: string;
  readonly fonts: readonly string[];
  readonly times: readonly number[];
  readonly storage: readonly [number, number] | null;
  /** Path of the golden trace (its frames are in <golden without .jsonl>/<ms>.png). */
  readonly golden: string;
  /**
   * From the fixture's optional `pixels.json` (`{"over2": n}`): at most this many pixels of a frame may differ by
   * more than 2 levels in a channel, a finer bar than pixelmatch's for a fixture whose difference is subtle.
   */
  readonly over2?: number;
}

export const readTimes = (path: string): number[] => readFileSync(path, 'utf8').split(/\s+/).filter(Boolean).map(Number);

export function readStorage(dir: string): readonly [number, number] | null {
  const p = `${dir}/storage.txt`;
  if (!existsSync(p)) return null;
  const [w, h] = readFileSync(p, 'utf8').trim().split('x').map(Number);
  return [w!, h!];
}

export function syntheticFixtures(): AssFixture[] {
  const fonts = readFileSync('fixtures/ass/fonts/index.txt', 'utf8').split('\n').filter(Boolean).map((f) => `/fixtures/ass/fonts/${f}`);
  return readdirSync('fixtures/ass', { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'fonts' && existsSync(`fixtures/ass/${d.name}/times.txt`))
    .map((d) => ({
      name: d.name,
      script: `/fixtures/ass/${d.name}/${d.name}.ass`,
      fonts,
      times: readTimes(`fixtures/ass/${d.name}/times.txt`),
      storage: readStorage(`fixtures/ass/${d.name}`),
      golden: `tests/ass-trace/golden/${d.name}.jsonl`,
      ...(existsSync(`fixtures/ass/${d.name}/pixels.json`)
        ? { over2: (JSON.parse(readFileSync(`fixtures/ass/${d.name}/pixels.json`, 'utf8')) as { over2: number }).over2 }
        : {}),
    }));
}
