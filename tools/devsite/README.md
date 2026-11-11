# tools/devsite

TypeDoc on its own TypeScript 5.9 (the repository is on TypeScript 7, which has no JavaScript compiler API). `model.mjs` converts the eight `@seikou` packages' entry points (`packages/<name>/src/index.ts`) and writes `.cache/devsite/model.json`: TypeDoc's JSON with one module per package, internal and private members left out, and a top-level `seikouSourceHash`.

```
npm run devsite:install   # npm ci --prefix tools/devsite
npm run devsite:model     # writes .cache/devsite/model.json
```

`source-hash.mjs` (typed by `source-hash.d.mts`) computes the hash: SHA-256 over every tracked file under `packages/*/src`, `packages/*/README.md` and `packages/*/examples`, sorted by path, each fed as `<path>\0<bytes>\0`. The site's loader and `tests/devsite-model.test.ts` use the same function to notice a model built from other sources.

TypeDoc runs with `skipErrorChecking`, because the repository's own typecheck is TypeScript 7's.
