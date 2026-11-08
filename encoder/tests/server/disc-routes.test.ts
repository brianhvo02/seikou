// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { episodePlans } from '../../src/server/disc-routes';
import type { HelperContext } from '../../src/server/http';
import { fx } from '../paths';

let dir: string | null = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

it('plans on the first STN audio stream alone, whatever codes the other streams carry', async () => {
  dir = mkdtempSync(join(tmpdir(), 'disc-routes-'));
  const disc = join(dir, 'disc3');
  cpSync(fx('fixtures/disc3'), disc, { recursive: true });
  // disc3's second STN audio entry (AC-3, eng) has its rate code set to 3, which no table knows.
  const mplsPath = join(disc, 'BDMV/PLAYLIST/00000.mpls');
  const mpls = readFileSync(mplsPath);
  const attributes = Buffer.from([0x05, 0x81, 0x61, 0x65, 0x6e, 0x67]);
  const at = mpls.indexOf(attributes);
  expect(at).toBeGreaterThan(0);
  mpls[at + 2] = 0x63;
  writeFileSync(mplsPath, mpls);

  const ctx = {
    discDir: disc,
    playlistId: '00000',
    episodeSpec: '1-',
    dataDir: join(dir, 'data'),
    token: 'disc-routes-test',
    webDir: null,
    tools: null,
    sources: {},
  } as unknown as HelperContext;
  const [plan] = await episodePlans(ctx);
  expect(plan!.segments[0]!.audioTracks.map((a) => a.pid)).toEqual([0x1100]);
  expect(plan!.audio[0]!.sampleRate).toBe(48000);
});
