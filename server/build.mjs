import { copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SERVER_VENDORED } from '../vite/licenses-plugin.ts';
import { formatLicenses, SERVER_OWN_SOURCES, readPackageLicenses, readVendored, rootsFromMetafile } from '../vite/third-party-licenses.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const result = await build({
  // The metafile's input paths are relative to this directory, whatever the shell's.
  absWorkingDir: repoRoot,
  metafile: true,
  entryPoints: [new URL('src/main.ts', import.meta.url).pathname],
  outfile: new URL('dist/server.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'info',
  // CommonJS packages in the bundle (werift's `debug`) require Node's built-ins, which an ES module can only do
  // through a require of its own.
  banner: { js: "import { createRequire as __bundleRequire } from 'node:module'; const require = __bundleRequire(import.meta.url);" },
});

// 7-Zip's WASM (fansub archives, src/fansubs/archive.ts) is read from next to the bundle.
copyFileSync(new URL('../node_modules/7z-wasm/7zz.wasm', import.meta.url), new URL('dist/7zz.wasm', import.meta.url));

// The licence of every package esbuild put in the bundle (7z-wasm's WASM is copied beside it, so it counts), and the vendored
// notices; a bundled package without a licence file fails the build.
const roots = rootsFromMetafile(result.metafile.inputs, repoRoot, SERVER_OWN_SOURCES);
roots.add(`${repoRoot}node_modules/7z-wasm`);
writeFileSync(
  new URL('dist/third-party-licenses.txt', import.meta.url),
  formatLicenses('Seikou NAS server: third-party licences', [
    { heading: 'Packages bundled into the server', entries: readPackageLicenses(roots) },
    { heading: 'Ported, vendored and installed works', entries: readVendored(repoRoot, SERVER_VENDORED) },
  ]),
);
