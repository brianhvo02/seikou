// SPDX-License-Identifier: LGPL-3.0-or-later
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPlaylist } from '../../src/disc/playlist';
import { readPlaylistPmts } from '../../src/disc/pmt';
import { probeClip } from '../../src/disc/probe';
import { parseEpisodeSpec, planEpisodes } from '../../src/plan/episodes';
import { audioChain, videoChain } from '../../src/pipeline/chain';
import { buildVideoScript } from '../../src/pipeline/vpy';
import { collect } from '../helpers/streams';
import { wavBytes } from '../helpers/wav';
import { haveTools, toolPaths } from '../helpers/tools';
import { fx } from '../paths';

const fake = { vspipe: fx('tests/fake-bin/vspipe'), svt: fx('tests/fake-bin/SvtAv1EncApp'), opusenc: fx('tests/fake-bin/opusenc') };

afterEach(() => {
  delete process.env.FAKE_VSPIPE_EXIT;
  delete process.env.FAKE_ENC_EXIT;
  delete process.env.FAKE_SLEEP;
  delete process.env.FAKE_STDERR_LINES;
});

describe('chains with fake binaries', () => {
  it('pipes vspipe output through the encoder', async () => {
    const c = videoChain(fake, fx('tests/fixtures/hello.vpy'), []);
    expect(Buffer.concat(await collect(c.stream)).toString()).toBe(fs.readFileSync(fx('tests/fixtures/hello.vpy'), 'utf8'));
    await c.done;
  });

  it('rejects with the failing tool, code and stderr', async () => {
    process.env.FAKE_ENC_EXIT = '3';
    const c = videoChain(fake, fx('tests/fixtures/hello.vpy'), []);
    c.stream.resume();
    await expect(c.done).rejects.toMatchObject({ tool: 'SvtAv1EncApp', code: 3, stderrTail: expect.stringContaining('fake stderr line') });
  });

  it('keeps the final stderr lines of a failing encoder', async () => {
    process.env.FAKE_ENC_EXIT = '3';
    process.env.FAKE_STDERR_LINES = '200';
    for (let n = 0; n < 5; n++) {
      const c = videoChain(fake, fx('tests/fixtures/hello.vpy'), []);
      c.stream.resume();
      const err = await c.done.then(() => null, (e: unknown) => e as { stderrTail: string });
      expect(err?.stderrTail).toContain('stderr line 199\nfake stderr line');
    }
  });

  it('rejects done without unhandled rejection when the stream is awaited first', async () => {
    process.env.FAKE_ENC_EXIT = '3';
    const c = videoChain(fake, fx('tests/fixtures/hello.vpy'), []);
    await collect(c.stream);
    await new Promise((r) => setTimeout(r, 50));
    await expect(c.done).rejects.toMatchObject({ tool: 'SvtAv1EncApp' });
  });

  it('rejects when vspipe fails even if the encoder exited 0', async () => {
    process.env.FAKE_VSPIPE_EXIT = '2';
    const c = videoChain(fake, fx('tests/fixtures/hello.vpy'), []);
    c.stream.resume();
    await expect(c.done).rejects.toMatchObject({ tool: 'vspipe', code: 2 });
  });

  it('abort kills both processes', async () => {
    process.env.FAKE_SLEEP = '5';
    const c = audioChain(fake, wavFile(2, 48000), [], { pid: 0x1100, channels: 2, sampleRate: 48000 });
    c.stream.resume();
    const start = Date.now();
    c.abort(new Error('user cancel'));
    await expect(c.done).rejects.toThrow('user cancel');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("passes the WAV into the encoder when it matches the disc's stream", async () => {
    const file = wavFile(6, 48000, 10);
    const c = audioChain(fake, file, [], { pid: 0x1101, channels: 6, sampleRate: 48000 });
    expect(Buffer.concat(await collect(c.stream)).equals(fs.readFileSync(file))).toBe(true);
    await c.done;
  });

  it('channel guard fails on a mismatched stream', async () => {
    process.env.FAKE_SLEEP = '5';
    const c = audioChain(fake, wavFile(2, 48000, 10), [], { pid: 0x1101, channels: 6, sampleRate: 48000 });
    c.stream.resume();
    const start = Date.now();
    await expect(c.done).rejects.toThrow('PID 0x1101: BestSource gave 2 channels at 48000 Hz; the disc says 6 channels at 48000 Hz');
    // The encoder, still waiting, is stopped rather than left to finish.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

/** A WAV file in a fresh temporary folder: the fake vspipe writes its "script" to stdout. */
function wavFile(channels: number, sampleRate: number, frames = 0): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-wav-')), 'audio.wav');
  fs.writeFileSync(file, wavBytes(channels, sampleRate, frames));
  return file;
}

describe.skipIf(!haveTools)('real tools', () => {
  it('produces an IVF stream for disc1 episode 1', async () => {
    const playlist = await loadPlaylist(fx('fixtures/disc1'), '00000');
    const probes = new Map([
      ['00001', await probeClip(playlist.items[0])],
      ['00002', await probeClip(playlist.items[1])],
    ]);
    const [plan] = planEpisodes(playlist, probes, parseEpisodeSpec('1-2,3-4', 4), [{ pid: 4352 }], await readPlaylistPmts(playlist));
    const cacheDir = path.resolve('.cache/bestsource');
    fs.mkdirSync(cacheDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-test-'));
    try {
      const script = path.join(dir, 'video.vpy');
      fs.writeFileSync(script, buildVideoScript(plan, { cacheDir }));
      const c = videoChain(toolPaths()!, script, ['--preset', '8', '--crf', '40', '--progress', '0']);
      const bytes = Buffer.concat(await collect(c.stream));
      await c.done;
      expect(bytes.subarray(0, 4).toString()).toBe('DKIF');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});
