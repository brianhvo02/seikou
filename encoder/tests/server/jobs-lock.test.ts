// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startJobRunner } from '../../src/server/jobs';
import { takeJobsLock } from '../../src/server/jobs-lock';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

/** The pid of a process that has already exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  if (pid === undefined) throw new Error('no child pid');
  return pid;
}

describe('the jobs lock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jobs-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second taker on the same data folder is refused with the holder\'s pid', () => {
    const first = takeJobsLock(dir);
    if (!('lock' in first)) throw new Error('the first take failed');
    expect(readFileSync(join(dir, 'jobs.lock'), 'utf8').trim()).toBe(String(process.pid));
    expect(takeJobsLock(dir)).toEqual({ heldBy: process.pid });
    first.lock.release();
    expect(existsSync(join(dir, 'jobs.lock'))).toBe(false);
    const again = takeJobsLock(dir);
    expect('lock' in again).toBe(true);
    if ('lock' in again) again.lock.release();
  });

  it('a lock whose process is gone is taken over', () => {
    writeFileSync(join(dir, 'jobs.lock'), `${deadPid()}\n`);
    const taken = takeJobsLock(dir);
    expect('lock' in taken).toBe(true);
    expect(readFileSync(join(dir, 'jobs.lock'), 'utf8').trim()).toBe(String(process.pid));
    if ('lock' in taken) taken.lock.release();
  });

  it('a lock file that names no pid is taken over', () => {
    writeFileSync(join(dir, 'jobs.lock'), 'not a pid');
    const taken = takeJobsLock(dir);
    expect('lock' in taken).toBe(true);
    if ('lock' in taken) taken.lock.release();
  });

  it('release leaves a lock another process took meanwhile', () => {
    const taken = takeJobsLock(dir);
    if (!('lock' in taken)) throw new Error('the take failed');
    writeFileSync(join(dir, 'jobs.lock'), '1\n');
    taken.lock.release();
    expect(readFileSync(join(dir, 'jobs.lock'), 'utf8')).toBe('1\n');
  });
});

describe('the job runner and the lock', () => {
  let fx: RouteFixture;
  beforeEach(async () => {
    fx = await startRouteFixture({}, null);
  });
  afterEach(async () => {
    await fx.stop();
  });

  it('a second runner on the same data folder does not run the queue, and its routes say so', async () => {
    const first = startJobRunner(fx.app, { log: () => {} });
    await first.ready;
    expect(first.queueElsewhere).toBeNull();
    const logged: string[] = [];
    const second = startJobRunner(fx.app, { log: (m) => logged.push(m) });
    await second.ready;
    expect(second.queueElsewhere).toBe(process.pid);
    expect(second.list()).toEqual([]);
    expect(logged.join('\n')).toMatch(new RegExp(`pid ${process.pid}`));
    await expect(second.add({ discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-5', outDir: '/tmp/x' })).rejects.toMatchObject({
      status: 409,
      code: 'queue-elsewhere',
    });
    // The routes reach the second runner, the app's runner now.
    for (const path of ['/api/jobs', '/api/jobs/events', '/api/jobs/0123456789abcdef/log']) {
      const res = await fx.send(path);
      expect([path, res.status]).toEqual([path, 409]);
      expect(jsonOf<{ error: string; message: string }>(res)).toMatchObject({ error: 'queue-elsewhere', message: expect.stringMatching(/another seikou-encode/i) });
    }
    const posted = await fx.send('/api/jobs', { method: 'POST', body: JSON.stringify({ discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-5', outDir: '/tmp/x' }) });
    expect(posted.status).toBe(409);
    // The second runner's shutdown leaves the first one's lock.
    await second.shutdown();
    expect(readFileSync(join(fx.dataDir, 'jobs.lock'), 'utf8').trim()).toBe(String(process.pid));
    await first.shutdown();
  });

  it('shutdown releases the lock', async () => {
    const runner = startJobRunner(fx.app, { log: () => {} });
    await runner.ready;
    expect(existsSync(join(fx.dataDir, 'jobs.lock'))).toBe(true);
    await runner.shutdown();
    expect(existsSync(join(fx.dataDir, 'jobs.lock'))).toBe(false);
    const next = startJobRunner(fx.app, { log: () => {} });
    await next.ready;
    expect(next.queueElsewhere).toBeNull();
    await next.shutdown();
  });
});
