// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { discKeyOf } from '@seikou/nas/disc-key';
// Seikou's NAS server builds manifests this way; the key is computed from the same manifest the helper serves.
import { buildManifest } from '../../../server/src/manifest';

/**
 * The key and label of the disc in `discDir` (the folder that holds BDMV, or the BDMV folder itself). The key is
 * `f.<content fingerprint>`, or `d.<id>` for a disc with no streams; it is stable across runs, so a saved record
 * finds its disc again. The label is the disc folder's name. Throws when the folder has no `BDMV/index.bdmv`.
 */
export async function discKeyOfFolder(discDir: string): Promise<{ key: string; label: string }> {
  const given = await realpath(discDir);
  const root = basename(given).toUpperCase() === 'BDMV' ? dirname(given) : given;
  const label = basename(root);
  const id16 = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const manifest = await buildManifest(root, { id: id16, name: label });
  if (!manifest.files.some((f) => f.path === 'BDMV/INDEX.BDMV')) throw new Error(`${discDir} is not a Blu-ray folder (no BDMV/index.bdmv)`);
  return { key: discKeyOf(id16, manifest.files), label };
}
