// Builds server/data/discdb-index.json (committed) from TheDiscDb/data (MIT): ContentHash -> title, kind,
// TMDB id and the episodes each playlist holds. Run with `npm run discdb:index` and commit the output.
//
// It keeps a sparse, shallow, blobless clone in .cache/thediscdb with only the per-disc and per-title JSON
// (`disc*.json`, `metadata.json`), and refreshes it on later runs. `--repo <dir>` reads an existing checkout
// instead and runs no git command in it but `rev-parse`. The repo is untrusted data: nothing from it is run,
// hooks and fsmonitor are off for every git call, and symlinks are not followed.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discDbKind, indexDisc, mergeIndex } from '@seikou/titles/discdb';
import type { DiscDbHit, DiscDbIndex } from '@seikou/titles/discdb';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_URL = 'https://github.com/TheDiscDb/data';
const CLONE = join(ROOT, '.cache/thediscdb');
const OUT = join(ROOT, 'server/data/discdb-index.json');
const SPARSE = ['/LICENSE', '/data/**/disc[0-9]*.json', '/data/**/metadata.json'];

const git = (cwd: string | null, ...args: string[]): string =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...(cwd ? ['-C', cwd] : []), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();

function cloneOrUpdate(): void {
  if (!existsSync(join(CLONE, '.git'))) {
    mkdirSync(dirname(CLONE), { recursive: true });
    git(null, 'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', REPO_URL, CLONE);
    git(CLONE, 'sparse-checkout', 'set', '--no-cone', ...SPARSE);
    git(CLONE, 'checkout');
  } else {
    git(CLONE, 'sparse-checkout', 'set', '--no-cone', ...SPARSE);
    git(CLONE, 'fetch', '--depth', '1', 'origin', 'HEAD');
    git(CLONE, 'checkout', '--detach', 'FETCH_HEAD');
  }
}

/** A regular file's JSON (no symlinks), or null. */
const readJson = (file: string): unknown => {
  try {
    if (!lstatSync(file).isFile()) return null;
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};
/** Entries of a directory that are real directories or files (no symlinks), sorted by name. */
const list = (dir: string, want: 'dir' | 'file'): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => (want === 'dir' ? e.isDirectory() : e.isFile()))
    .map((e) => e.name)
    .sort();

function main(): void {
  const at = process.argv.indexOf('--repo');
  const repo = at >= 0 ? process.argv[at + 1] : undefined;
  if (at >= 0 && !repo) throw new Error('--repo needs a directory');
  if (!repo) cloneOrUpdate();
  const dir = repo ?? CLONE;
  const commit = git(dir, 'rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected commit ${commit}`);

  const records: { hash: string; hit: DiscDbHit }[] = [];
  let discs = 0;
  let otherType = 0;
  // data/{movie,series}/<Title (Year)>/metadata.json and <Title (Year)>/<release>/discNN.json; data/sets holds
  // box-set listings without disc records.
  for (const kind of ['movie', 'series']) {
    const kindDir = join(dir, 'data', kind);
    if (!existsSync(kindDir) || lstatSync(kindDir).isSymbolicLink()) continue;
    for (const title of list(kindDir, 'dir')) {
      const metadata = readJson(join(kindDir, title, 'metadata.json'));
      for (const release of list(join(kindDir, title), 'dir')) {
        for (const file of list(join(kindDir, title, release), 'file')) {
          if (!/^disc\d+\.json$/.test(file)) continue;
          discs++;
          if (discDbKind(metadata) === null) otherType++;
          const record = indexDisc(readJson(join(kindDir, title, release, file)), metadata);
          if (record) records.push(record);
        }
      }
    }
  }
  const { discs: index, conflicts } = mergeIndex(records);
  const hashes = Object.keys(index).sort();
  const source: DiscDbIndex['source'] = { repo: REPO_URL, commit, license: 'MIT' };
  // One disc per line, so a rebuild diffs readably.
  const body = hashes.map((h) => `${JSON.stringify(h)}:${JSON.stringify(index[h])}`).join(',\n');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `{"source":${JSON.stringify(source)},"discs":{\n${body}\n}}\n`);
  console.log(
    `${discs} disc records, ${otherType} left out for a Type other than Series or Movie, ${records.length} indexed, ` +
      `${hashes.length} hashes, ${conflicts} conflicting hashes left out; ${commit}`,
  );
}

main();
