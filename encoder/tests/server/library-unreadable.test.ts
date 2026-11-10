// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startHelperServer, type AppContext } from '../../src/server/server';
import { fx } from '../paths';

const TOKEN = 'library-unreadable-token';

interface Lib {
  scanning: boolean;
  roots: string[];
  unreadableRoots: string[];
  discs: { label: string }[];
}

describe('a library folder that cannot be read', () => {
  it('keeps its discs from the last scan and is reported as unreadable', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'library-gone-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'library-gone-data-'));
    const moved = `${tree}-moved`;
    cpSync(fx('fixtures/disc-speech'), join(tree, 'speech'), { recursive: true });
    const server = await startHelperServer({ dataDir, token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [], nas: { client: null } });
    const headers = { authorization: `Bearer ${TOKEN}` };
    const base = `http://127.0.0.1:${server.port}`;
    const settled = async (): Promise<Lib> => {
      for (;;) {
        const lib = (await (await fetch(`${base}/api/library`, { headers })).json()) as Lib;
        if (!lib.scanning) return lib;
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      await fetch(`${base}/api/settings/roots`, { method: 'PUT', headers, body: JSON.stringify({ roots: [tree] }) });
      const first = await settled();
      expect(first.discs.map((d) => d.label)).toEqual(['speech']);
      expect(first.unreadableRoots).toEqual([]);
      renameSync(tree, moved);
      await fetch(`${base}/api/library/rescan`, { method: 'POST', headers });
      const second = await settled();
      expect(second.discs.map((d) => d.label)).toEqual(['speech']);
      expect(second.unreadableRoots).toHaveLength(1);
      expect(second.unreadableRoots).toEqual(second.roots);
    } finally {
      await server.close();
      rmSync(tree, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
