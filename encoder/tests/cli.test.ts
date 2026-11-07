// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bestsourceCacheDir } from '../src/cli';
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
          const m = /Helper: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64})/.exec(out);
          if (m) resolveUrl(m[1]!);
        });
      });
      child.removeAllListeners('exit');
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>helper</title>');
      expect((await fetch(new URL('/api/playlists', url))).status).toBe(401);
      expect((await fetch(new URL(`/api/playlists${new URL(url).search}`, url))).status).toBe(200);
      const code = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
      child.kill('SIGINT');
      expect(await code).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('bestsourceCacheDir', () => {
  it('defaults to the data directory and honours --cache', () => {
    expect(bestsourceCacheDir(undefined, { SEIKOU_ENCODE_DATA: '/data/x' })).toBe('/data/x/bestsource');
    expect(bestsourceCacheDir('rel', {})).toBe(resolve('rel'));
  });
});
