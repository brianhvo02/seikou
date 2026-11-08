// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FetchCache } from '@seikou/fansubs/fetch-cache';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import { NotFoundOnTosho } from '@seikou/fansubs/tosho';
import type { Tosho } from '@seikou/fansubs/tosho';
import { ReleaseCache, UploadRejected } from '../../src/subs/release-cache';

const fixtures = fileURLToPath(new URL('../fixtures/fansubs/', import.meta.url));
let dir: string;
let downloads: number;
let cache: ReleaseCache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'release-cache-'));
  downloads = 0;
  const base = fixtureFansubSources(fixtures).tosho;
  const tosho: Tosho = {
    ...base,
    download: (...args) => {
      downloads++;
      return base.download(...args);
    },
  };
  cache = new ReleaseCache(join(dir, 'data'), { tosho, fetchCache: new FetchCache(join(dir, 'fetch'), 1 << 30) });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ASS =
  '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi\n';

describe('ReleaseCache', () => {
  it("fetches GroupA's tracks and fonts", async () => {
    const r = await cache.fetchTosho(7001);
    expect(r.key).toBe('tosho-7001');
    expect(r.group).toBe('GroupA');
    expect(r.files).toHaveLength(2);
    const tracks = r.files.flatMap((f) => f.tracks);
    expect(tracks.map((t) => t.kind)).toEqual(['full', 'signs', 'full']);
    expect(r.fonts.map((f) => f.name)).toEqual(['DejaVuSansMono.ttf']);
    for (const t of tracks) expect(existsSync(join(dir, 'data', t.path))).toBe(true);
    expect((await cache.read(r.fonts[0]!.path)).length).toBeGreaterThan(0);
    expect(await cache.get('tosho-7001')).toEqual(r);
  });

  it('a second fetch makes no download', async () => {
    const first = await cache.fetchTosho(7001);
    const n = downloads;
    expect(n).toBeGreaterThan(0);
    expect(await cache.fetchTosho(7001)).toEqual(first);
    expect(downloads).toBe(n);
  });

  it('fetches again when a stored track or font file is gone', async () => {
    const first = await cache.fetchTosho(7001);
    const track = first.files[0]!.tracks[0]!.path;
    await rm(join(dir, 'data', track));
    expect(await cache.fetchTosho(7001)).toEqual(first);
    expect(existsSync(join(dir, 'data', track))).toBe(true);
    const font = first.fonts[0]!.path;
    await rm(join(dir, 'data', font));
    expect(await cache.fetchTosho(7001)).toEqual(first);
    expect(existsSync(join(dir, 'data', font))).toBe(true);
  });

  it('addLocal converts SRT and keeps fonts', async () => {
    const pooled = (await cache.fetchTosho(7001)).fonts[0]!.path;
    const font = await cache.read(pooled);
    const r = await cache.addLocal([
      { name: 'ep1.srt', bytes: enc('1\n00:00:01,000 --> 00:00:02,000\nHello\n') },
      { name: 'My Font.ttf', bytes: font },
    ]);
    expect(r.source).toBe('local');
    expect(r.key).toMatch(/^local-[0-9a-f]{16}$/);
    expect(r.files).toHaveLength(1);
    const t = r.files[0]!.tracks[0]!;
    expect(t.name).toBe('ep1.srt');
    expect(t.dialogueLines).toBe(1);
    expect(new TextDecoder().decode(await cache.read(t.path))).toContain('[V4+ Styles]');
    expect(r.fonts[0]!.name).toBe('My Font.ttf');
    expect(r.fonts[0]!.path).toBe(pooled);
  });

  it('addLocal rejects a 6 MB .ass with its name', async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    await expect(cache.addLocal([{ name: 'big.ass', bytes: big }])).rejects.toMatchObject({
      name: 'UploadRejected',
      fileName: 'big.ass',
    });
    await expect(cache.addLocal([{ name: 'x.txt', bytes: enc(ASS) }])).rejects.toBeInstanceOf(UploadRejected);
  });

  it('keeps the same key for the same upload', async () => {
    const a = await cache.addLocal([{ name: 'a.ass', bytes: enc(ASS) }]);
    const b = await cache.addLocal([{ name: 'a.ass', bytes: enc(ASS) }]);
    expect(b.key).toBe(a.key);
  });

  it('a Tosho 404 rejects with NotFoundOnTosho', async () => {
    await expect(cache.fetchTosho(1)).rejects.toBeInstanceOf(NotFoundOnTosho);
  });

  it('refuses paths outside the data directory', async () => {
    await expect(cache.read('../x')).rejects.toThrow();
    await expect(cache.read('/etc/passwd')).rejects.toThrow();
  });
});
