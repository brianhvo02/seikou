// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { bestsourceCacheDir, main, printEncodeEvent, stoppingLine } from '../src/cli';
import { discKeyOfFolder } from '../src/disc/disc-key';
import { listPlaylists } from '../src/disc/playlist';
import { NasClient } from '../src/nas/client';
import { mirrorDirOf } from '../src/nas/mirror';
import { NasLibrary } from '../src/nas/nas-library';
import { EpisodeInfoStore } from '../src/plan/episode-info';
import { jobCli } from '../src/server/jobs';
import { takeJobsLock } from '../src/server/jobs-lock';
import { DEFAULT_SETTINGS } from '../src/server/profiles';
import { haveTools } from './helpers/tools';
import { startNasTestServer, type NasTestServer } from './nas/nas-test-server';
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

  it('with no library folders says so on one line', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'et-app-noroots-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>app</title>');
    const child = spawn(process.execPath, ['--import', 'tsx', fx('src/cli.ts'), 'app', '--no-open', '--port', '0'], {
      env: { ...process.env, SEIKOU_ENCODE_WEB_DIR: webDir, SEIKOU_ENCODE_DATA: webDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let out = '';
      await new Promise<void>((resolveOut, reject) => {
        child.once('exit', (code) => reject(new Error(`exited ${String(code)}: ${out}`)));
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (/App: http/.test(out)) resolveOut();
        });
      });
      expect(out.split('\n').filter((l) => /No library folders are set/.test(l))).toHaveLength(1);
      child.removeAllListeners('exit');
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);

  it('a second app on the same data folder refuses to start, naming the first one', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'et-app-twice-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>app</title>');
    const env = { ...process.env, SEIKOU_ENCODE_WEB_DIR: webDir, SEIKOU_ENCODE_DATA: webDir };
    const args = ['--import', 'tsx', fx('src/cli.ts'), 'app', '--no-open', '--port', '0'];
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let out = '';
      await new Promise<void>((resolveOut, reject) => {
        child.once('exit', (code) => reject(new Error(`exited ${String(code)}: ${out}`)));
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (/App: http/.test(out)) resolveOut();
        });
      });
      child.removeAllListeners('exit');
      const second = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
      expect(second.status).toBe(1);
      const lines = second.stderr.trim().split('\n');
      expect(lines).toEqual([`Another seikou-encode app (pid ${String(child.pid)}) is using the data folder ${webDir}.`]);
      // The first one still runs, and stops cleanly, taking its lock with it.
      const code = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
      child.kill('SIGINT');
      expect(await code).toBe(0);
      expect(existsSync(join(webDir, 'jobs.lock'))).toBe(false);
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

describe('stoppingLine', () => {
  it('says what the first Ctrl-C waits for, and nothing when no job runs', () => {
    expect(stoppingLine('the tool chain')).toBe('Stopping: waiting for the tool chain to finish; press Ctrl-C again to quit now.');
    expect(stoppingLine('packaging episode 3')).toBe('Stopping: waiting for packaging episode 3 to finish; press Ctrl-C again to quit now.');
    expect(stoppingLine(null)).toBeNull();
  });
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

it('the encode event printer stays quiet for progress and packaging events', () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const kind of ['progress', 'packaged', 'package-failed'] as const) printEncodeEvent({ kind, episode: 1, message: 'x', framesDone: 1, frames: 2 });
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    printEncodeEvent({ kind: 'log', episode: 1, message: 'note' });
    printEncodeEvent({ kind: 'episode-start', episode: 1, message: 'Encoding episode 1' });
    expect(err).toHaveBeenCalledWith('note');
    expect(out).toHaveBeenCalledWith('Encoding episode 1');
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});


describe('the NAS on the command line', () => {
  /** The made-up show the CLI's uploads are filed under. */
  const SHOW = 990003;
  let nas: NasTestServer;
  let dataDir: string;
  /** The key of the encoder's disc1 on the stand-in. */
  let disc1Key: string;
  let out: string[];
  let err: string[];

  /** Runs the command line in this process with the data folder of the test; resolves with the exit code. */
  const cli = (...argv: string[]): Promise<number> => main(argv);

  beforeAll(async () => {
    // the encoder's disc1 in place of the library's (which has no PAT, and shares its key as its clips have the same sizes)
    nas = await startNasTestServer({
      prepare: (dir) => {
        rmSync(join(dir, 'disc1'), { recursive: true });
        rmSync(join(dir, 'disc1.iso'));
        cpSync(fx('fixtures/disc1'), join(dir, 'disc1'), { recursive: true });
      },
    });
    const probe = mkdtempSync(join(tmpdir(), 'et-cli-nas-probe-'));
    vi.stubEnv('SEIKOU_ENCODE_DATA', probe);
    const silent = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['nas', 'pair', '--code', await nas.ownerCode(), '--base', nas.base])).toBe(0);
    } finally {
      silent.mockRestore();
      vi.unstubAllEnvs();
    }
    const library = new NasLibrary({ dataDir: probe, nas: { client: await NasClient.load(probe) } });
    await library.scan();
    disc1Key = library.discs().find((d) => d.label === 'disc1')!.key;
  });
  afterAll(async () => {
    await nas.close();
  });
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'et-cli-nas-'));
    vi.stubEnv('SEIKOU_ENCODE_DATA', dataDir);
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const pair = async (): Promise<void> => {
    expect(await cli('nas', 'pair', '--code', await nas.ownerCode('Encoder Owner'), '--base', nas.base)).toBe(0);
  };

  it('nas pair writes nas.json and says with whom; nas status says the same; nas unpair forgets it', async () => {
    expect(await cli('nas', 'status')).toBe(0);
    expect(out).toEqual(['Not paired']);
    await pair();
    expect(existsSync(join(dataDir, 'nas.json'))).toBe(true);
    expect(out.at(-1)).toBe('Paired with 127.0.0.1 as Encoder Owner');
    expect(await cli('nas', 'status')).toBe(0);
    expect(out.at(-1)).toBe('Paired with 127.0.0.1 as Encoder Owner');
    expect(await cli('nas', 'unpair')).toBe(0);
    expect(existsSync(join(dataDir, 'nas.json'))).toBe(false);
    expect(await cli('nas', 'status')).toBe(0);
    expect(out.at(-1)).toBe('Not paired');
  });

  it('nas pair with a link pairs too; a guest code exits 2 and saves nothing', async () => {
    expect(await cli('nas', 'pair', '--link', `https://seikou.example/?pair=${await nas.ownerCode('Link Owner')}&nas=${encodeURIComponent(nas.base)}`)).toBe(0);
    expect(out.at(-1)).toBe('Paired with 127.0.0.1 as Link Owner');
    const other = mkdtempSync(join(tmpdir(), 'et-cli-nas-guest-'));
    vi.stubEnv('SEIKOU_ENCODE_DATA', other);
    expect(await cli('nas', 'pair', '--code', await nas.guestCode(), '--base', nas.base)).toBe(2);
    expect(err.join('\n')).toContain('not an owner');
    expect(existsSync(join(other, 'nas.json'))).toBe(false);
    expect(await cli('nas', 'pair', '--base', nas.base)).toBe(2);
  });

  it('plan nas:<key> prints the playlists of the NAS disc, and its chapters with --playlist', async () => {
    await pair();
    out.length = 0;
    expect(await cli('plan', `nas:${disc1Key}`)).toBe(0);
    const here = await listPlaylists(fx('fixtures/disc1'));
    expect(out.map((l) => l.split('  ')[0])).toEqual(here.map((p) => p.id));
    out.length = 0;
    expect(await cli('plan', `nas:${disc1Key}`, '--playlist', '00000')).toBe(0);
    expect(out).toContain(' 1  00:00.000  00001');
    expect(out).toContain(' 4  00:06.000  00002');
  });

  it('a NAS disc or the NAS destination needs a pairing, and an unknown key or --web with --nas exits 2', async () => {
    expect(await cli('plan', `nas:${disc1Key}`)).toBe(2);
    expect(err.join('\n')).toContain('seikou-encode nas pair');
    expect(await cli('encode', fx('fixtures/disc1'), '--playlist', '00000', '--episodes', '1-2,3-4', '--nas')).toBe(2);
    await pair();
    err.length = 0;
    const unknown = `f.${'0'.repeat(64)}`;
    expect(await cli('plan', `nas:${unknown}`)).toBe(2);
    expect(err).toEqual([`The NAS has no disc with key ${unknown}.`]);
    expect(await cli('encode', `nas:${disc1Key}`, '--playlist', '00000', '--episodes', '1-2,3-4', '--nas', '--web', '/tmp/x')).toBe(2);
    expect(await cli('encode', `nas:${disc1Key}`, '--playlist', '00000', '--episodes', '1-2,3-4')).toBe(2);
  });

  it('takes the command a queued NAS job prints', async () => {
    await pair();
    const cliLine = jobCli({ discDir: '/unused', nasKey: disc1Key, playlistId: '00000', episodeSpec: '1-2,3-4', outDir: '/unused', noSubtitles: true, settings: { ...DEFAULT_SETTINGS, destination: 'nas', opusBitrate: 128 } });
    // the words as a POSIX shell splits the line
    const words = execFileSync('sh', ['-c', `printf '%s\\0' ${cliLine}`]).toString().split('\0').slice(0, -1);
    expect(words.slice(0, 3)).toEqual(['seikou-encode', 'encode', `nas:${disc1Key}`]);
    // it gets as far as the AniList check, which this disc's playlist has no choices for
    expect(await cli(...words.slice(1))).toBe(2);
    expect(err).toEqual(['Episodes 1, 2 need an AniList entry and number before they can go to the NAS. Set them on the Episodes page.']);
  });

  it('encode nas:<key> … --nas without AniList choices exits 2 naming the episodes, even with a tool missing', async () => {
    await pair();
    vi.stubEnv('ENCODING_TOOLS_SVT', '/nonexistent/SvtAv1EncApp');
    await new EpisodeInfoStore(dataDir).save(disc1Key, '00000', { chapterNames: {}, anilist: { '1': { anilistId: SHOW, episode: 1, title: null } } });
    expect(await cli('encode', `nas:${disc1Key}`, '--playlist', '00000', '--episodes', '1-2,3-4', '--nas', '--no-subtitles')).toBe(2);
    expect(err).toEqual(['Episode 2 needs an AniList entry and number before they can go to the NAS. Set them on the Episodes page.']);
    await new EpisodeInfoStore(dataDir).save(disc1Key, '00000', { chapterNames: {}, anilist: {} });
    err.length = 0;
    expect(await cli('encode', `nas:${disc1Key}`, '--playlist', '00000', '--episodes', '1-2,3-4', '--nas', '--no-subtitles')).toBe(2);
    expect(err[0]).toContain('Episodes 1, 2 need an AniList entry');
    // with the choices made, the missing tool is what stops it, and the clips it fetched are let go of
    await new EpisodeInfoStore(dataDir).save(disc1Key, '00000', {
      chapterNames: {},
      anilist: { '1': { anilistId: SHOW, episode: 1, title: null }, '3': { anilistId: SHOW, episode: 2, title: null } },
    });
    expect(await cli('encode', `nas:${disc1Key}`, '--playlist', '00000', '--episodes', '1-2,3-4', '--nas', '--no-subtitles')).toBe(3);
  });

  it('encode of a NAS disc refuses while another process runs the queue of the data folder', async () => {
    await pair();
    const held = takeJobsLock(dataDir);
    if (!('lock' in held)) throw new Error('the lock is taken');
    try {
      err.length = 0;
      expect(await cli('encode', `nas:${disc1Key}`, '--playlist', '00000', '--episodes', '1-2,3-4', '--out', join(dataDir, 'out'), '--no-subtitles')).toBe(1);
      expect(err).toEqual([`Another seikou-encode app (pid ${process.pid}) is using the data folder ${dataDir}; queue this encode there, or stop it first.`]);
      // nothing of the disc was mirrored
      expect(existsSync(mirrorDirOf(dataDir, disc1Key))).toBe(false);
    } finally {
      held.lock.release();
    }
  });

  it('a NAS that does not answer exits 1 with one line', async () => {
    await pair();
    await nas.pause();
    try {
      err.length = 0;
      expect(await cli('plan', `nas:${disc1Key}`)).toBe(1);
      expect(err).toEqual(["The NAS can't be reached."]);
    } finally {
      await nas.resume();
    }
  });

  it.skipIf(!haveTools)('encode nas:<key> … --nas fetches, encodes and uploads each episode, and leaves nothing behind', async () => {
    await pair();
    await new EpisodeInfoStore(dataDir).save(disc1Key, '00000', {
      chapterNames: {},
      anilist: { '1': { anilistId: SHOW, episode: 1, title: null }, '3': { anilistId: SHOW, episode: 2, title: null } },
    });
    try {
      const code = await cli('encode', `nas:${disc1Key}`, '--playlist', '00000', '--episodes', '1-2,3-4', '--nas', '--no-subtitles', '--crf', '50', '--preset', '12');
      expect([code, code === 0 ? '' : err.join('\n')]).toEqual([0, '']);
      expect(out.filter((l) => l.includes(': on the NAS as ')).map((l) => l.split(';')[0])).toEqual([`Episode 1: on the NAS as ${SHOW}-1`, `Episode 2: on the NAS as ${SHOW}-2`]);
      expect(readdirSync(join(nas.encodesDir!, String(SHOW))).sort()).toEqual(['1.mkv', '2.mkv']);
      // the MKVs left this computer with their folder, and the clips are back to their heads
      expect(readdirSync(join(dataDir, 'nas-out'))).toEqual([]);
      const state = JSON.parse(readFileSync(join(mirrorDirOf(dataDir, disc1Key), 'fetch.json'), 'utf8')) as { files: Record<string, number>; ranges: Record<string, [number, number][]> };
      for (const [path, ranges] of Object.entries(state.ranges)) expect([path, ranges.reduce((n, [a, b]) => n + b - a, 0)]).toEqual([path, Math.min(state.files[path]!, 4 * 1024 * 1024)]);
    } finally {
      rmSync(join(nas.encodesDir!, String(SHOW)), { recursive: true, force: true });
    }
  }, 300_000);
});
