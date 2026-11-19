# @seikou/bdj-classlib

The Java class library `@seikou/bdj` boots: `rt-bdj.jar` (the OpenJDK 8 runtime classes BD-J discs use, about 4 MB), and libbluray's BD-J Java stack, `libbluray-j2se.jar` and `libbluray-awt-j2se.jar`. The root exports `CLASS_LIBRARY_URLS`, where the bundler serves the three jars, for the `loadClassLibrary` an engine worker entry gives `seikouBdjProvider`. It also holds the TypeScript intrinsics that derive from OpenJDK's code (`intrinsics/`, imported as `@seikou/bdj-classlib/intrinsics`), which only `@seikou/bdj`'s BD-J worker entry imports.

The reference is at [/developers/bdj-classlib](https://bluray.pages.dev/developers/bdj-classlib).

## Licences

This package is not under Seikou's LGPL. Its `license` field is `GPL-2.0-only WITH Classpath-exception-2.0 AND LGPL-2.1-or-later AND Apache-2.0 AND ICU AND SAX-PD`:

- `rt-bdj.jar` and `intrinsics/`: GPLv2 with the Classpath Exception (`LICENSE`, `ASSEMBLY_EXCEPTION`), with the Apache Xerces classes under Apache-2.0 (`THIRD_PARTY_APACHE`), the SAX classes' public-domain notice (`SAX_NOTICE`) and ICU's notice for the normalizer classes (`THIRD_PARTY_ICU`).
- `libbluray-j2se.jar` and `libbluray-awt-j2se.jar`: LGPL-2.1-or-later (`LICENSES/LGPL-2.1.txt`).
- `src/index.ts`, the asset URLs: GPLv2 with the Classpath Exception, as the rest.

`NOTICE` names the OpenJDK source package, the libbluray commit and how `classes.txt` picks the classes.

## Rebuilding

The jars, `classes.txt` and the licence files are committed and rebuilt only with `npm run bdj-classlib:build` (Docker, `tools/bdj-classlib/`) at the repository root; CI rebuilds them and fails on any difference. `npm run bdj-classlib:collect` grows `classes.txt` from real runs.

## Documentation

These are in the Seikou repository.

- Using BD-J in your own page: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- The JVM that loads these jars: `@seikou/bdj`.
