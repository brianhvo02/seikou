// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { formatLicenses, packageRootOf, readPackageLicenses, readVendored, type VendoredWork } from './third-party-licenses.ts';

/** Package roots of every module any build of this process bundled (the app, its workers, the service worker, the developer site). */
const bundledRoots = new Set<string>();

/** Forget what earlier builds collected (tests). */
export function resetBundledRoots(): void {
  bundledRoots.clear();
}

/** The package roots collected so far. */
export function collectedRoots(): ReadonlySet<string> {
  return bundledRoots;
}

/**
 * Records the packages of the modules each output chunk of a build holds. Put it in every nested build (the workers, the
 * service worker, the developer examples) so {@link thirdPartyLicenses} sees them all.
 */
export function collectBundledPackages(): Plugin {
  return { name: 'collect-bundled-packages', generateBundle: (_options, bundle) => recordBundle(bundle) };
}

function recordBundle(bundle: Record<string, { type: string; modules?: Record<string, unknown> }>): void {
  for (const item of Object.values(bundle)) {
    if (item.type !== 'chunk' || !item.modules) continue;
    for (const id of Object.keys(item.modules)) {
      const root = packageRootOf(id);
      if (root) bundledRoots.add(root);
    }
  }
}

/** Works the site ships that are not npm packages: ported or vendored code, assets, data and test clips. Paths are repo-relative. */
export const SITE_VENDORED: readonly VendoredWork[] = [
  { name: 'Seikou (LGPL-3.0-or-later)', version: '', license: 'LGPL-3.0-or-later', files: ['LICENSE', 'COPYING'] },
  { name: 'LGPL 2.1 (libbluray, libudfread, FFmpeg ports and decoders)', version: '', license: 'LGPL-2.1-or-later', files: ['LICENSES/LGPL-2.1.txt'] },
  { name: 'libbluray, libudfread (ports in @seikou/bdmv)', version: '', license: 'LGPL-2.1-or-later', files: ['packages/bdmv/NOTICE'] },
  { name: 'libbluray (ports in @seikou/engine) and FFmpeg decoders', version: '', license: 'LGPL-2.1-or-later', files: ['packages/engine/NOTICE', 'packages/engine/wasm/audio/NOTICE', 'packages/engine/wasm/video/NOTICE'] },
  { name: 'libbluray (ports in @seikou/pg)', version: '', license: 'LGPL-2.1-or-later', files: ['packages/pg/NOTICE'] },
  { name: 'libass (port in @seikou/ass)', version: '0.17.5', license: 'ISC', files: ['packages/ass/NOTICE'] },
  { name: 'libbluray (BD-J ports in @seikou/bdj)', version: '', license: 'LGPL-2.1-or-later', files: ['packages/bdj/NOTICE'] },
  { name: 'DejaVu Sans (default subtitle font)', version: '2.37', license: 'Bitstream Vera / DejaVu', files: ['packages/ass/src/LICENSE-DejaVu.txt'] },
  { name: 'FreeType (freetype.wasm)', version: '2.13.2', license: 'FreeType License', files: ['packages/bdj/wasm/freetype/NOTICE', 'packages/bdj/wasm/freetype/FTL.TXT'] },
  {
    name: 'OpenJDK 8 class library, libbluray BD-J jars, Apache Xerces, SAX, ICU4J (@seikou/bdj-classlib)',
    version: '8u504',
    license: 'GPL-2.0 with Classpath Exception; Apache-2.0; public domain; ICU; LGPL-2.1-or-later',
    files: ['packages/bdj-classlib/NOTICE', 'packages/bdj-classlib/LICENSE', 'packages/bdj-classlib/ASSEMBLY_EXCEPTION', 'packages/bdj-classlib/THIRD_PARTY_APACHE', 'packages/bdj-classlib/SAX_NOTICE', 'packages/bdj-classlib/THIRD_PARTY_ICU'],
  },
  { name: 'Anime4K shaders', version: '4.0.1', license: 'MIT', files: ['src/ui/anime4k/LICENSE'] },
  { name: '"Stumpy Lake forest in HD" by Microdac (speed probe clip)', version: '', license: 'CC BY 2.5', files: ['fixtures/NOTICE'] },
];

/** The same for the server image's bundle. */
export const SERVER_VENDORED: readonly VendoredWork[] = [
  { name: 'Seikou (LGPL-3.0-or-later)', version: '', license: 'LGPL-3.0-or-later', files: ['LICENSE', 'COPYING'] },
  { name: 'libbluray, libudfread (ports in @seikou/bdmv)', version: '', license: 'LGPL-2.1-or-later', files: ['LICENSES/LGPL-2.1.txt', 'packages/bdmv/NOTICE'] },
  { name: 'libass (script parser port in @seikou/ass)', version: '0.17.5', license: 'ISC', files: ['packages/ass/NOTICE'] },
  { name: 'The server bundle and TheDiscDB data', version: '', license: 'LGPL-3.0-or-later; MIT', files: ['server/NOTICE', 'packages/nas/NOTICE'] },
  { name: 'Software installed in the image (ffmpeg, Intel media driver, oneVPL)', version: '', license: 'GPL-2.0-or-later; MIT; BSD-3-Clause', files: ['server/deploy/IMAGE-NOTICE'] },
];

/**
 * Writes `third-party-licenses.txt` into the build's output once every build has closed: each npm package bundled into the
 * site (name, version, licence and its own licence text), then the vendored works. A bundled package with no licence file
 * fails the build. Put it last in `plugins`, after the plugin that runs the service worker's build.
 */
export function thirdPartyLicenses(repoRoot: string): Plugin {
  let outDir = '';
  return {
    name: 'third-party-licenses',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle: (_options, bundle) => recordBundle(bundle),
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        if (!outDir) return;
        const dir = join(repoRoot, outDir);
        const text = formatLicenses('Seikou: third-party licences for the site', [
          { heading: 'Packages bundled into the site', entries: readPackageLicenses(bundledRoots) },
          { heading: 'Ported, vendored and shipped works', entries: readVendored(repoRoot, SITE_VENDORED) },
        ]);
        mkdirSync(dirname(join(dir, 'third-party-licenses.txt')), { recursive: true });
        writeFileSync(join(dir, 'third-party-licenses.txt'), text);
      },
    },
  };
}
