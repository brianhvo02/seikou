// The package's `main` is its UMD build, which uses __dirname and cannot sit in an ES module bundle; the ES module
// build is imported by path and has the same types.
declare module '7z-wasm/7zz.es6.js' {
  import type { SevenZipModuleFactory } from '7z-wasm';
  const factory: SevenZipModuleFactory;
  export default factory;
}
