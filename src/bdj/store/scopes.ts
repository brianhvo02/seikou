/*
 * The BD-J storage scopes of a disc: the directories libbluray's Java gives each application under /persistent/ and
 * /buda/, and the keys they are stored under. Derived from libbluray src/libbluray/bdj/java/org/videolan/BDJAppProxy.java
 * (createStorage), BDJXletContext.java (getXletProperty: dvb.org.id, dvb.app.id), src/libbluray/bdj/bdj.c (_bdj_init's
 * disc ID) and src/libbluray/bluray.c (bdj_disc_id from bdid_get).
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2010-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { parseBdjo, type Bdjo } from '@seikou/bdmv/bdjo-parser';
import { readWhole, type ByteSource } from '@seikou/bdmv/byte-source';
import type { DiscSpec } from '@seikou/engine/disc/disc-spec';

/**
 * A storage scope: its store key (`persistent/<orgId>`, `buda/<orgId>/<discId>`, `buda/<orgId>`) and the VFS directory
 * Java uses.
 */
export interface StoreScope {
  readonly key: string;
  /** Canonical, no trailing slash: `/persistent/<org>`, `/buda/<org>/<disc>` or `/buda/<org>`. */
  readonly dir: string;
  /**
   * Only the files directly in `dir` (ruling R14): `buda/<orgId>` holds the files a disc puts beside the disc folders
   * in /buda/<org>/, which libbluray keeps on disk as it keeps the rest; its subfolders are not part of it.
   */
  readonly looseOnly?: boolean;
}

/** _bdj_init's disc ID when bluray.c has none (no id.bdmv, or one that does not parse). */
export const NO_DISC_ID = '00000000000000000000000000000000';

/** The disc ID Java sees (DiscManager.getCurrentDisc().getId()): id.bdmv's, else 32 zeros (_bdj_init). */
export function javaDiscId(discId: string | null | undefined): string {
  return discId || NO_DISC_ID;
}

/** BDJXletContext.getXletProperty("dvb.org.id"): Integer.toHexString of the organisation ID, without leading zeros. */
export function orgDirName(orgId: number): string {
  return (orgId >>> 0).toString(16);
}

/** The store's organisation ID: 8 lower-case hex digits (the NAS contract). */
function orgKey(orgId: number): string {
  return (orgId >>> 0).toString(16).padStart(8, '0');
}

/**
 * The scopes of one application of the disc (BDJAppProxy.createStorage): `/persistent/<org>/<app>` lives in the
 * organisation's scope, shared by its applications, and `/buda/<org>/<disc>` is the binding unit area. Java's paths
 * are libbluray's exactly: the disc ID is id.bdmv's or, without one, 32 zeros. The store key of a disc without a disc
 * ID (or with an all-zero one) uses `fallbackDiscId` instead (discFingerprint), so two such discs of one organisation do
 * not share their saved data by accident, as they would in libbluray's one directory.
 */
export function scopesFor(
  app: { readonly orgId: number },
  discId: string | null,
  fallbackDiscId: string,
): { readonly persistent: StoreScope; readonly buda: StoreScope; readonly budaOrg: StoreScope } {
  const javaDisc = javaDiscId(discId);
  // Task 8's migration of browser scopes to the NAS must key a disc without an ID the same way (ruling R15)
  const keyDisc = javaDisc === NO_DISC_ID ? fallbackDiscId : javaDisc;
  return {
    persistent: { key: `persistent/${orgKey(app.orgId)}`, dir: `/persistent/${orgDirName(app.orgId)}` },
    buda: { key: `buda/${orgKey(app.orgId)}/${keyDisc}`, dir: `/buda/${orgDirName(app.orgId)}/${javaDisc}` },
    budaOrg: { key: `buda/${orgKey(app.orgId)}`, dir: `/buda/${orgDirName(app.orgId)}`, looseOnly: true },
  };
}

/**
 * A stand-in disc ID for a disc whose id.bdmv gives none (ruling R15: Task 8's migration must use this same key): 32 hex digits of the SHA-256 of its BDMV files' paths and
 * sizes (not the backup copies), the same whether the disc is a picked folder or on the NAS.
 */
export async function discFingerprint(files: Iterable<{ readonly path: string; readonly size: number }>): Promise<string> {
  const lines = [...files]
    .filter((f) => f.path.startsWith('BDMV/') && !f.path.startsWith('BDMV/BACKUP/'))
    .map((f) => `${f.path}\t${f.size}\n`)
    .sort();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join(''))));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const BDJO_DIR = 'BDMV/BDJO/';
const BDJO_BACKUP_DIR = 'BDMV/BACKUP/BDJO/';

/** Every BDJO of the disc, each from BDMV/BDJO/ or, when that does not read or parse, its backup (bdjo_get). */
export async function readBdjos(source: ByteSource & { paths(): Iterable<string> }): Promise<Bdjo[]> {
  const names = new Set<string>();
  for (const p of source.paths()) {
    for (const dir of [BDJO_DIR, BDJO_BACKUP_DIR]) {
      if (p.startsWith(dir) && p.endsWith('.BDJO') && !p.slice(dir.length).includes('/')) names.add(p.slice(dir.length));
    }
  }
  const out: Bdjo[] = [];
  for (const name of [...names].sort()) {
    for (const dir of [BDJO_DIR, BDJO_BACKUP_DIR]) {
      const path = dir + name;
      if (!source.exists(path)) continue;
      try {
        out.push(parseBdjo(await readWhole(source, path)));
        break;
      } catch {
        // the backup is tried next, as bdjo_get does
      }
    }
  }
  return out;
}

/**
 * The scopes of every application the disc's BDJOs list, each once: what is loaded before the first xlet starts.
 * `discId` is the one the engine passes Libbluray.init (id.bdmv's, or null).
 */
export async function discScopes(source: ByteSource & { paths(): Iterable<string> }, discId: string | null): Promise<StoreScope[]> {
  const bdjos = await readBdjos(source);
  const orgs = [...new Set(bdjos.flatMap((b) => b.apps.map((a) => a.orgId >>> 0)))].sort((a, b) => a - b);
  if (orgs.length === 0) return [];
  const fallback = javaDiscId(discId) === NO_DISC_ID ? await discFingerprint([...source.paths()].map((path) => ({ path, size: source.size(path) }))) : NO_DISC_ID;
  return orgs.flatMap((orgId) => {
    const s = scopesFor({ orgId }, discId, fallback);
    return [s.persistent, s.buda, s.budaOrg];
  });
}

/** The disc's source in the browser store: `nas:<nasDiscId>` for a NAS disc, `local` for a picked folder. */
export function storeSource(disc: DiscSpec): string {
  return disc.kind === 'remote' ? `nas:${disc.manifest.discId}` : 'local';
}
