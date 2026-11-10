// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHelperServer, type AppContext, type HelperServer } from '../../src/server/server';
import { appSettings } from '../../src/subs/app-settings';
import { fx } from '../paths';

const TOKEN = 'library-roots-token';

interface Lib {
  scanning: boolean;
  roots: string[];
  savedRoots: string[];
  runRoots: string[];
  discs: { label: string; relPath: string; root: string; otherPaths: { relPath: string; root: string }[] }[];
}

describe('library roots and copies of a disc', () => {
  let saved: string;
  let run: string;
  let dataDir: string;
  let server: HelperServer;
  const headers = { authorization: `Bearer ${TOKEN}` };

  const settled = async (): Promise<Lib> => {
    for (;;) {
      const lib = (await (await fetch(`http://127.0.0.1:${server.port}/api/library`, { headers })).json()) as Lib;
      if (!lib.scanning) return lib;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    saved = realpathSync(mkdtempSync(join(tmpdir(), 'library-saved-')));
    run = realpathSync(mkdtempSync(join(tmpdir(), 'library-run-')));
    dataDir = mkdtempSync(join(tmpdir(), 'library-roots-data-'));
    cpSync(fx('fixtures/disc-speech'), join(saved, 'speech'), { recursive: true });
    cpSync(fx('fixtures/disc-speech'), join(run, 'speech-copy'), { recursive: true });
    const app: AppContext = { dataDir, token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [run], nas: { client: null } };
    server = await startHelperServer(app);
    await fetch(`http://127.0.0.1:${server.port}/api/settings/roots`, { method: 'PUT', headers, body: JSON.stringify({ roots: [saved] }) });
  });
  afterAll(async () => {
    await server.close();
    for (const d of [saved, run, dataDir]) rmSync(d, { recursive: true, force: true });
  });

  it('says which roots are saved and which come from this run, and saving the saved list never writes the run folder', async () => {
    const lib = await settled();
    expect(lib.savedRoots).toEqual([saved]);
    expect(lib.runRoots).toEqual([run]);
    expect(lib.roots).toEqual([saved, run]);
    expect((await appSettings(dataDir).read()).roots).toEqual([saved]);
  });

  it('lists a disc once when two folders hold copies of it, naming the other place', async () => {
    const lib = await settled();
    expect(lib.discs).toHaveLength(1);
    const disc = lib.discs[0]!;
    expect(disc.otherPaths).toHaveLength(1);
    const places = [`${disc.root}|${disc.relPath}`, `${disc.otherPaths[0]!.root}|${disc.otherPaths[0]!.relPath}`].sort();
    expect(places).toEqual([`${run}|speech-copy`, `${saved}|speech`].sort());
  });
});
