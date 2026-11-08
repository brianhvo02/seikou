// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bestsourceCacheDir } from '../src/cli';
import { discKeyOfFolder } from '../src/disc/disc-key';
import { RecordStore } from '../src/subs/record';
import { writeEpisodeMkv } from './package/episode-mkv';
import { fx } from './paths';

it('plan prints the chapter table of disc1', () => {
  const text = execFileSync('npx', ['tsx', fx('src/cli.ts'), 'plan', fx('fixtures/disc1'), '--playlist', '00000']).toString();
  expect(text).toContain('1  00:00.000  00001');
  expect(text).toContain('4  00:06.000  00002');
}, 60_000);

const noSvt = { ...process.env, ENCODING_TOOLS_SVT: '/nonexistent/SvtAv1EncApp' };
const encodeArgs = (episodes: string): string[] => ['tsx', fx('src/cli.ts'), 'encode', fx('fixtures/disc1'), '--playlist', '00000', '--episodes', episodes, '--out', '/tmp/et-cli-never-created'];

it('exits 2 for a bad spec even when a tool is missing', () => {
  expect(() => execFileSync('npx', encodeArgs('3-2'), { stdio: 'pipe', env: noSvt })).toThrowError(expect.objectContaining({ status: 2 }));
}, 60_000);

it('exits 3 for a valid spec when a tool is missing', () => {
  expect(() => execFileSync('npx', encodeArgs('1-2'), { stdio: 'pipe', env: noSvt })).toThrowError(expect.objectContaining({ status: 3 }));
}, 60_000);

it('rejects a bad episode spec with exit code 2', () => {
  expect(() => execFileSync('npx', ['tsx', fx('src/cli.ts'), 'encode', fx('fixtures/disc1'), '--playlist', '00000', '--episodes', '3-2', '--out', '/tmp/x'], { stdio: 'pipe' })).toThrowError(expect.objectContaining({ status: 2 }));
}, 60_000);

describe('encode with a saved record', () => {
  it('encode with a mismatched record exits 2, even with a tool missing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'et-rec-'));
    const { key, label } = await discKeyOfFolder(fx('fixtures/disc1'));
    await new RecordStore(dataDir).write({
      disc: { key, label },
      playlist: '00000',
      episodeSpec: '1-3,4-5',
      anilist: null,
      releases: [],
      fonts: [],
      episodes: [],
      savedAt: '2026-11-07T10:00:00Z',
    });
    const env = { ...noSvt, SEIKOU_ENCODE_DATA: dataDir };
    let err: { status?: number; stderr?: Buffer } = {};
    try {
      execFileSync('npx', encodeArgs('1-2'), { stdio: 'pipe', env });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(2);
    expect(String(err.stderr)).toContain('--no-subtitles');
    // --no-subtitles skips the record, so the missing tool is what stops the encode.
    expect(() => execFileSync('npx', [...encodeArgs('1-2'), '--no-subtitles'], { stdio: 'pipe', env })).toThrowError(expect.objectContaining({ status: 3 }));
  }, 60_000);

  it('encode with a record that lacks an episode exits 2 naming it, even with a tool missing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'et-rec-'));
    const { key, label } = await discKeyOfFolder(fx('fixtures/disc1'));
    await new RecordStore(dataDir).write({
      disc: { key, label },
      playlist: '00000',
      episodeSpec: '1-2,3-4',
      anilist: null,
      releases: [],
      fonts: [],
      episodes: [{ index: 1, title: 'Starfall Wanderer 1', tracks: [], metadata: { title: 'Starfall Wanderer 1', video: { name: '', language: 'und' }, audio: [{ pid: 0x1100, name: '', language: 'eng', included: true }], chapters: [] } }],
      savedAt: '2026-11-07T10:00:00Z',
    });
    let err: { status?: number; stderr?: Buffer } = {};
    try {
      execFileSync('npx', encodeArgs('1-2,3-4'), { stdio: 'pipe', env: { ...noSvt, SEIKOU_ENCODE_DATA: dataDir } });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(2);
    expect(String(err.stderr)).toContain('no entry for episode 2');
  }, 60_000);

  it('encode with an episode that has no audio ticked exits 2 naming it, even with a tool missing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'et-rec-'));
    const { key, label } = await discKeyOfFolder(fx('fixtures/disc1'));
    const episode = (index: number, included: boolean) => ({
      index,
      title: `Starfall Wanderer ${index}`,
      tracks: [],
      metadata: { title: `Starfall Wanderer ${index}`, video: { name: '', language: 'und' }, audio: [{ pid: 0x1100, name: '', language: 'eng', included }], chapters: [] },
    });
    await new RecordStore(dataDir).write({
      disc: { key, label },
      playlist: '00000',
      episodeSpec: '1-2,3-4',
      anilist: null,
      releases: [],
      fonts: [],
      episodes: [episode(1, true), episode(2, false)],
      savedAt: '2026-11-07T10:00:00Z',
    });
    let err: { status?: number; stderr?: Buffer } = {};
    try {
      execFileSync('npx', encodeArgs('1-2,3-4'), { stdio: 'pipe', env: { ...noSvt, SEIKOU_ENCODE_DATA: dataDir } });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(2);
    expect(String(err.stderr)).toContain('Episode 2 has no audio stream ticked in the saved choices; tick one in the helper or pass --no-subtitles');
  }, 60_000);
});

describe('serve', () => {
  const emptyWeb = mkdtempSync(join(tmpdir(), 'et-web-'));
  const serveArgs = (episodes: string): string[] => ['tsx', fx('src/cli.ts'), 'serve', fx('fixtures/disc1'), '--playlist', '00000', '--episodes', episodes, '--no-open'];
  const env = { ...process.env, SEIKOU_ENCODE_WEB_DIR: emptyWeb, SEIKOU_ENCODE_DATA: emptyWeb };

  it('rejects a bad episode spec with exit 2', () => {
    expect(() => execFileSync('npx', serveArgs('3-2'), { stdio: 'pipe', env })).toThrowError(expect.objectContaining({ status: 2 }));
  }, 60_000);

  it('without a built page exits 3 naming the build command', () => {
    let err: { status?: number; stderr?: Buffer } = {};
    try {
      execFileSync('npx', serveArgs('1-2'), { stdio: 'pipe', env });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(3);
    expect(String(err.stderr)).toContain('npm run encoder:web:build');
  }, 60_000);

  it('starts, answers with the page and the token, and stops on SIGINT with exit 0', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'et-web-ok-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>helper</title>');
    const child = spawn(process.execPath, ['--import', 'tsx', ...serveArgs('1-2').slice(1), '--port', '0'], {
      env: { ...process.env, SEIKOU_ENCODE_WEB_DIR: webDir, SEIKOU_ENCODE_DATA: webDir, SEIKOU_ENCODE_FIXTURE: fx('tests/fixtures/fansubs') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let out = '';
      const url = await new Promise<string>((resolveUrl, reject) => {
        child.once('exit', (code) => reject(new Error(`exited ${String(code)}: ${out}`)));
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          const m = /Helper: (http:\/\/127\.0\.0\.1:\d+\/helper\/[0-9a-f]{16}\?t=[0-9a-f]{64})/.exec(out);
          if (m) resolveUrl(m[1]!);
        });
      });
      child.removeAllListeners('exit');
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>helper</title>');
      const sessionPlaylists = `/api/sessions/${new URL(url).pathname.split('/')[2]}/playlists`;
      expect((await fetch(new URL(sessionPlaylists, url))).status).toBe(401);
      expect((await fetch(new URL(`${sessionPlaylists}${new URL(url).search}`, url))).status).toBe(200);
      const code = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
      child.kill('SIGINT');
      expect(await code).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('app', () => {
  it('starts without a disc argument, lists the library of its roots, and stops on SIGINT', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'et-app-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>app</title>');
    const child = spawn(process.execPath, ['--import', 'tsx', fx('src/cli.ts'), 'app', '--root', fx('fixtures'), '--no-open', '--port', '0'], {
      env: { ...process.env, SEIKOU_ENCODE_WEB_DIR: webDir, SEIKOU_ENCODE_DATA: webDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let out = '';
      const url = await new Promise<string>((resolveUrl, reject) => {
        child.once('exit', (code) => reject(new Error(`exited ${String(code)}: ${out}`)));
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          const m = /App: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64})/.exec(out);
          if (m) resolveUrl(m[1]!);
        });
      });
      child.removeAllListeners('exit');
      expect((await fetch(url)).status).toBe(200);
      const api = new URL(`/api/library${new URL(url).search}`, url);
      let body: { discs: { label: string }[] } = { discs: [] };
      for (let i = 0; i < 100 && body.discs.length === 0; i++) {
        body = (await (await fetch(api)).json()) as typeof body;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(body.discs.map((d) => d.label)).toContain('disc1');
      const code = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
      child.kill('SIGINT');
      expect(await code).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);

  it('without a built page exits 3', () => {
    const empty = mkdtempSync(join(tmpdir(), 'et-app-empty-'));
    let err: { status?: number } = {};
    try {
      execFileSync('npx', ['tsx', fx('src/cli.ts'), 'app', '--no-open'], { stdio: 'pipe', env: { ...process.env, SEIKOU_ENCODE_WEB_DIR: empty, SEIKOU_ENCODE_DATA: empty } });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(3);
  }, 60_000);
});

describe('bestsourceCacheDir', () => {
  it('defaults to the data directory and honours --cache', () => {
    expect(bestsourceCacheDir(undefined, { SEIKOU_ENCODE_DATA: '/data/x' })).toBe('/data/x/bestsource');
    expect(bestsourceCacheDir('rel', {})).toBe(resolve('rel'));
  });
});

describe('package', () => {
  it('packages an episode MKV into the --out directory and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'et-pkg-'));
    const mkv = join(dir, 'ep-01.mkv');
    await writeEpisodeMkv(mkv);
    const text = execFileSync('npx', ['tsx', fx('src/cli.ts'), 'package', mkv, '--out', join(dir, 'web')]).toString();
    expect(text).toContain(join(dir, 'web'));
    expect(readdirSync(join(dir, 'web')).sort()).toEqual(['chapters.vtt', 'episode.json', 'fonts', 'pgs', 'subs', 'video.webm']);
  }, 60_000);

  it('exits 1 on a file that is not Matroska and leaves no directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'et-pkg-'));
    const bad = join(dir, 'bad.mkv');
    writeFileSync(bad, 'not a Matroska file');
    expect(() => execFileSync('npx', ['tsx', fx('src/cli.ts'), 'package', bad, '--out', join(dir, 'web')], { stdio: 'pipe' })).toThrowError(
      expect.objectContaining({ status: 1 }),
    );
    expect(existsSync(join(dir, 'web'))).toBe(false);
  }, 60_000);

  it('exits 1 for an --out directory holding something else, and leaves it; packaging again over a package works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'et-pkg-'));
    const mkv = join(dir, 'ep-01.mkv');
    await writeEpisodeMkv(mkv);
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'notes.txt'), 'keep me');
    let stderr = '';
    try {
      execFileSync('npx', ['tsx', fx('src/cli.ts'), 'package', mkv, '--out', other], { stdio: 'pipe' });
      expect.unreachable('package should refuse');
    } catch (err) {
      expect(err).toMatchObject({ status: 1 });
      stderr = String((err as { stderr: Buffer }).stderr);
    }
    expect(stderr).toContain(other);
    expect(readFileSync(join(other, 'notes.txt'), 'utf8')).toBe('keep me');
    const web = join(dir, 'web');
    execFileSync('npx', ['tsx', fx('src/cli.ts'), 'package', mkv, '--out', web]);
    execFileSync('npx', ['tsx', fx('src/cli.ts'), 'package', mkv, '--out', web]);
    expect(readdirSync(web).sort()).toEqual(['chapters.vtt', 'episode.json', 'fonts', 'pgs', 'subs', 'video.webm']);
  }, 120_000);

  it('exits 2 without --out', () => {
    expect(() => execFileSync('npx', ['tsx', fx('src/cli.ts'), 'package', '/tmp/x.mkv'], { stdio: 'pipe' })).toThrowError(expect.objectContaining({ status: 2 }));
  }, 60_000);
});
