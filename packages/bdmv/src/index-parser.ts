/*
 * Ported from libbluray src/libbluray/bdnav/index_parse.c
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { checkVersion } from './version';

/**
 * What an index.bdmv entry (First Play, Top Menu or a title) starts: an HDMV movie object or a BD-J object. It mirrors
 * libbluray's `INDX_PLAY_ITEM` with its `INDX_HDMV_OBJ` and `INDX_BDJ_OBJ` (`index_data.h`), read by
 * `_parse_playback_obj`, `_parse_hdmv_obj` and `_parse_bdj_obj` in `index_parse.c`.
 *
 * `playbackType` is `playback_type`: 0 for an HDMV movie title and 1 for an HDMV interactive title; 2 for a BD-J movie
 * title and 3 for a BD-J interactive title. `movieObjectId` is `INDX_HDMV_OBJ.id_ref`, the index of the movie object in
 * MovieObject.bdmv (0xFFFF for none). `name` is `INDX_BDJ_OBJ.name`, the 5-digit name of the BDJO file in
 * `BDMV/BDJO/`. `kind: 'unknown'` keeps an `object_type` other than 1 (HDMV) or 2 (BD-J), where libbluray fails the
 * whole parse.
 */
export type IndexObject =
  | { readonly kind: 'hdmv'; readonly playbackType: number; readonly movieObjectId: number }
  | { readonly kind: 'bdj'; readonly playbackType: number; readonly name: string }
  | { readonly kind: 'unknown'; readonly objectType: number };

/** One title of index.bdmv, libbluray `INDX_TITLE` (`index_data.h`), read in `_parse_index`. */
export interface IndexTitle {
  /** The object the title starts. */
  readonly object: IndexObject;
  /**
   * `access_type`: 0 lets a jump into the title happen, 1 prohibits it (`INDX_ACCESS_PROHIBITED_MASK`), and 3 also
   * keeps the title number off the user interface (`INDX_ACCESS_HIDDEN_MASK` with the prohibited bit).
   */
  readonly accessType: number;
}

/**
 * The AppInfoBDMV fields the player reads, from libbluray `INDX_APP_INFO` (`index_data.h`, read by `_parse_app_info`).
 * libbluray's `_fill_disc_info` (`bluray.c`) switches to the 3D profile when the file version is 2.x and
 * `contentExistFlag` is set, and the engine does the same.
 */
export interface IndexAppInfo {
  /** `initial_output_mode_preference`: 0 to start in 2D, 1 to start in 3D. */
  readonly initialOutputModePreference: number;
  /** `content_exist_flag`: the disc holds 3D content (libbluray copies it to `disc_info.content_exist_3D`). */
  readonly contentExistFlag: boolean;
}

/** The parsed `BDMV/index.bdmv`, libbluray `INDX_ROOT` (`index_data.h`, read by `_indx_parse`). */
export interface IndexBdmv {
  /** The four version characters after the `INDX` signature, such as `0200`. */
  readonly version: string;
  readonly appInfo: IndexAppInfo;
  /** `first_play`: what runs when the disc is inserted. */
  readonly firstPlay: IndexObject;
  /** `top_menu`: what the Top Menu key starts (title number 0). */
  readonly topMenu: IndexObject;
  /** The numbered titles in order; `titles[0]` is title 1. */
  readonly titles: readonly IndexTitle[];
}

const OBJECT_TYPE_HDMV = 1;
const OBJECT_TYPE_BDJ = 2;

/**
 * Parses the bytes of `BDMV/index.bdmv` (libbluray `_indx_parse`). Throws a ParseError for a bad signature, an
 * unsupported version, or a truncated indexes section. The UHD extension data libbluray reads is ignored.
 * @example ../examples/parse-index.ts#parse
 */
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

/**
 * True when First Play, Top Menu or any title starts a BD-J object, so the disc needs the BD-J runtime.
 * @internal
 */
export function indexUsesBdj(index: IndexBdmv): boolean {
  return [index.firstPlay, index.topMenu, ...index.titles.map((t) => t.object)].some((o) => o.kind === 'bdj');
}
