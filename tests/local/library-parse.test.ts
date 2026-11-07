import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseName } from '@seikou/titles/parse-name';

/** The developer's real library listing, one disc path per line (gitignored; never commit it). */
const LISTING = fileURLToPath(new URL('../../fixtures/local/library-paths.txt', import.meta.url));

describe.skipIf(!existsSync(LISTING))('local library listing', () => {
  it('parses every path segment without throwing, and reports how much it found', () => {
    const lines = readFileSync(LISTING, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    let candidate = 0, season = 0, volume = 0, disc = 0, bonus = 0, music = 0;
    expect(() => {
      for (const line of lines) {
        const parsed = line.split('/').filter((s) => s !== '').map((segment) => parseName(segment));
        if (parsed.some((p) => p.candidates.length > 0)) candidate++;
        if (parsed.some((p) => p.season !== null)) season++;
        if (parsed.some((p) => p.volume !== null)) volume++;
        if (parsed.some((p) => p.disc !== null)) disc++;
        if (parsed.some((p) => p.bonus)) bonus++;
        if (parsed.some((p) => p.music)) music++;
      }
    }).not.toThrow();
    const pct = (n: number): string => `${n} (${((100 * n) / Math.max(lines.length, 1)).toFixed(1)}%)`;
    process.stdout.write(
      `library-paths.txt: ${lines.length} lines; candidate ${pct(candidate)}, season ${pct(season)}, volume ${pct(volume)}, ` +
        `disc ${pct(disc)}, bonus ${pct(bonus)}, music ${pct(music)}\n`,
    );
  });
});
