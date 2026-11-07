/*
 * Ported from libbluray src/libbluray/bdnav/index_parse.c
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from '@seikou/bdmv/byte-reader';
import { checkVersion } from './version';

/** Ported from libbluray bdnav/index_parse.c. */
export type IndexObject =
  | { readonly kind: 'hdmv'; readonly playbackType: number; readonly movieObjectId: number }
  | { readonly kind: 'bdj'; readonly playbackType: number; readonly name: string }
  | { readonly kind: 'unknown'; readonly objectType: number };

export interface IndexTitle {
  readonly object: IndexObject;
  readonly accessType: number;
}

/** INDX_APP_INFO, the fields the player reads (_fill_disc_info's 3D profile switch). */
export interface IndexAppInfo {
  readonly initialOutputModePreference: number;
  readonly contentExistFlag: boolean;
}

export interface IndexBdmv {
  readonly version: string;
  readonly appInfo: IndexAppInfo;
  readonly firstPlay: IndexObject;
  readonly topMenu: IndexObject;
  readonly titles: readonly IndexTitle[];
}

const OBJECT_TYPE_HDMV = 1;
const OBJECT_TYPE_BDJ = 2;

export function parseIndex(bytes: Uint8Array): IndexBdmv {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'INDX') throw new ParseError(`index.bdmv: bad signature "${signature}"`);
  checkVersion('index.bdmv', version);
  const indexesStart = r.u32();
  const appInfo = parseAppInfo(r);
  r.seek(indexesStart);
  const length = r.u32();
  if (length > r.remaining) throw new ParseError('index.bdmv: truncated indexes section');

  const firstPlayType = r.bits(2);
  r.skipBits(30);
  const firstPlay = readObject(r, firstPlayType);
  const topMenuType = r.bits(2);
  r.skipBits(30);
  const topMenu = readObject(r, topMenuType);

  const count = r.u16();
  const titles: IndexTitle[] = [];
  for (let i = 0; i < count; i++) {
    const objectType = r.bits(2);
    const accessType = r.bits(2);
    r.skipBits(28);
    titles.push({ object: readObject(r, objectType), accessType });
  }
  return { version, appInfo, firstPlay, topMenu, titles };
}

const APP_INFO_START = 40;

/** _parse_app_info (the length is not checked, as libbluray only logs a mismatch). */
function parseAppInfo(r: ByteReader): IndexAppInfo {
  r.seek(APP_INFO_START);
  r.u32(); // length
  r.skipBits(1);
  const initialOutputModePreference = r.bits(1);
  const contentExistFlag = r.flag();
  r.skipBits(5);
  return { initialOutputModePreference, contentExistFlag };
}

function readObject(r: ByteReader, objectType: number): IndexObject {
  const playbackType = r.bits(2);
  r.skipBits(14);
  if (objectType === OBJECT_TYPE_HDMV) {
    const movieObjectId = r.u16();
    r.skip(4);
    return { kind: 'hdmv', playbackType, movieObjectId };
  }
  if (objectType === OBJECT_TYPE_BDJ) {
    const name = r.ascii(5);
    r.skip(1);
    return { kind: 'bdj', playbackType, name };
  }
  r.skip(6);
  return { kind: 'unknown', objectType };
}

export function indexUsesBdj(index: IndexBdmv): boolean {
  return [index.firstPlay, index.topMenu, ...index.titles.map((t) => t.object)].some((o) => o.kind === 'bdj');
}
