/*
 * Original code for Seikou: the BD-J worker's entry point. Like the engine worker's entry, which loads the class
 * library's jars, it brings in the class library's own intrinsics (src/bdj-classlib/intrinsics, GPLv2 with the
 * Classpath Exception); the engine does not import from the class library. It also gives the worker
 * FreeType (src/wasm/freetype/freetype.wasm) and the fallback font (packages/ass/src/default-font.ttf), each fetched the
 * first time BD-J text needs it.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import freetypeWasmUrl from '../wasm/freetype/freetype.wasm?url';
import defaultFontUrl from '@seikou/ass/default-font.ttf?url';
import { registerClassLibraryIntrinsics } from '../bdj-classlib/intrinsics/index';
import { runBdjWorker, type BdjPort } from './bdj-worker';
import { loadFreeType, type FreeType } from './fonts/freetype';
import { IdbBdjStore } from './store/idb-store';

/** As the engine worker's asset fetches (the audio wasm, the default font, the class library jars). */
const ASSET_FETCH_TIMEOUT_MS = 20_000;

let freeType: Promise<FreeType> | null = null;
let defaultFont: Promise<Uint8Array> | null = null;

const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

runBdjWorker(globalThis as unknown as BdjPort, {
  extraIntrinsics: registerClassLibraryIntrinsics,
  // a failed load is remembered for this worker's session (one BD-J entry): later fonts fail at once rather than each
  // waiting for the fetch's timeout again (natives/fonts.ts, fonts/system-fonts.ts)
  loadFreeType: () => (freeType ??= loadFreeType(fetch(freetypeWasmUrl, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) }))),
  loadDefaultFont: () => (defaultFont ??= fetchBytes(defaultFontUrl)),
  // what discs save lasts in this browser's IndexedDB (none where it is missing: it lasts until BD-J stops)
  createStore: (source) => (typeof indexedDB === 'undefined' ? null : new IdbBdjStore(source, indexedDB)),
  // a NAS disc's go to the person's store on the NAS, with a write-ahead copy in IndexedDB first, so a page closed
  // before the NAS has them keeps them on this device
  ...(typeof indexedDB === 'undefined' ? {} : { indexedDB }),
});
