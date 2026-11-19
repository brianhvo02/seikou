// SPDX-License-Identifier: LGPL-3.0-or-later
// Build the BD-J provider an engine worker entry passes to startEngineWorker, and load its class library.
import { readFile } from 'node:fs/promises';
import { bdjMissing, seikouBdjProvider } from '@seikou/bdj';

export default async function example(): Promise<void> {
  // #region missing
  // In an engine worker this is `self`; here, Node's global, which lacks workers and OffscreenCanvas.
  const missing = bdjMissing(globalThis as unknown as Record<string, unknown>, { inWorker: true });
  console.log('missing:', missing.join('; ') || 'nothing');
  // #endregion

  // #region provider
  // A page fetches CLASS_LIBRARY_URLS from @seikou/bdj-classlib; Node reads the package's jars from disk.
  const jar = async (name: string): Promise<Uint8Array> =>
    new Uint8Array(await readFile(new URL(`../../bdj-classlib/${name}`, import.meta.url)));
  const bdj = seikouBdjProvider({
    missing,
    loadClassLibrary: async () => ({
      rt: await jar('rt-bdj.jar'),
      libbluray: await jar('libbluray-j2se.jar'),
      libblurayAwt: await jar('libbluray-awt-j2se.jar'),
    }),
  });
  const library = await bdj.loadClassLibrary();
  console.log('BD-J offered:', bdj.missing.length === 0, '; rt-bdj.jar:', library.rt.length, 'bytes');
  // #endregion
}
