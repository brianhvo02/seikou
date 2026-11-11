// SPDX-License-Identifier: LGPL-3.0-or-later
// Writes .cache/devsite/model.json: TypeDoc's JSON for the eight packages' public APIs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHash } from './source-hash.mjs';

let typedoc;
try {
  typedoc = await import('typedoc');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  console.error('tools/devsite has no dependencies: run npm run devsite:install');
  process.exit(1);
}
const { Application, TSConfigReader } = typedoc;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const packages = ['bdmv', 'nas', 'pg', 'ass', 'engine', 'titles', 'fansubs', 'matroska'];

const app = await Application.bootstrapWithPlugins({
  tsconfig: resolve(here, 'tsconfig.json'),
  entryPoints: packages.map((p) => resolve(root, `packages/${p}/src/index.ts`)),
  entryPointStrategy: 'resolve',
  excludeInternal: true,
  excludePrivate: true,
  excludeProtected: false,
  skipErrorChecking: true,
  readme: 'none',
  name: 'Seikou',
  logLevel: 'Warn',
});
app.options.addReader(new TSConfigReader());

const project = await app.convert();
if (!project) {
  console.error('TypeDoc could not convert the packages.');
  process.exit(1);
}
const out = resolve(root, '.cache/devsite/model.json');
mkdirSync(dirname(out), { recursive: true });
await app.generateJson(project, out);
const model = JSON.parse(readFileSync(out, 'utf8'));
for (const mod of model.children ?? []) mod.name = mod.name.replace(/\/src$/, '');
model.seikouSourceHash = sourceHash(root);
writeFileSync(out, JSON.stringify(model));
console.log(`Wrote ${out} (${model.children?.length ?? 0} modules)`);
