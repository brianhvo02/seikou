/*
 * Ported from libbluray src/libbluray/bdj/bdjo_parse.c
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2014  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { checkVersion } from './version';

/**
 * The BD-J title's terminal settings, libbluray `BDJO_TERMINAL_INFO` (`bdj/bdjo_data.h`), read by
 * `_parse_terminal_info` in `bdjo_parse.c`.
 */
export interface BdjoTerminalInfo {
  /** `default_font`: the 5-digit name of the default AWT font, `BDMV/AUXDATA/<name>.otf`; `*****` for none. */
  readonly defaultFont: string;
  /** `initial_havi_config_id`: the HAVi graphics configuration to start in; valid only without an autostart playlist. */
  readonly initialHaviConfigId: number;
  /** `menu_call_mask`: 1 when the Menu Call user operation is not allowed in this title. */
  readonly menuCallMask: number;
  /** `title_search_mask`: 1 when the Title Search user operation is not allowed in this title. */
  readonly titleSearchMask: number;
}
/** One entry of the application cache list, libbluray `BDJO_APP_CACHE_ITEM` (read by `_parse_app_cache_item`). */
export interface BdjoAppCacheItem {
  /** `type`: 1 for a JAR file, 2 for a directory. */
  readonly type: number;
  /** `ref_to_name`: the 5-digit name, `BDMV/JAR/<name>.jar` or `BDMV/JAR/<name>/`. */
  readonly refToName: string;
  /**
   * `lang_code`: the language the item is cached for, compared with PSR18 (menu language); `*.*` caches it always and
   * `%%%` when no other item's language matches PSR18.
   */
  readonly langCode: string;
}
/** The playlists the title may play, libbluray `BDJO_ACCESSIBLE_PLAYLISTS` (read by `_parse_accessible_playlists`). */
export interface BdjoAccessiblePlaylists {
  /** `access_to_all_flag`: 1 when the title may play every playlist on the disc, not only those listed. */
  readonly accessToAllFlag: number;
  /** `autostart_first_playlist_flag`: 1 when the first listed playlist starts with the title. */
  readonly autostartFirstPlaylistFlag: number;
  /** `pl`: the 5-digit playlist names, `BDMV/PLAYLIST/<name>.mpls`. */
  readonly playlists: readonly string[];
}
/** One BD-ROM profile an application needs, libbluray `BDJO_APP_PROFILE` (read by `_parse_app_profile`). */
export interface BdjoAppProfile {
  /** `profile_number`: 1 for BD-ROM profile 1, 2 for profile 2. */
  readonly profileNumber: number;
  /** `major_version`. */
  readonly majorVersion: number;
  /** `minor_version`. */
  readonly minorVersion: number;
  /** `micro_version`. */
  readonly microVersion: number;
}
/** One informative name of an application, libbluray `BDJO_APP_NAME`. */
export interface BdjoAppName {
  /** `lang`: the ISO 639-2 language code of the name. */
  readonly lang: string;
  /** `name`: the name, decoded as UTF-8. */
  readonly name: string;
}
/**
 * One entry of the application management table: a Java application of the title and how it starts. It mirrors
 * libbluray `BDJO_APP` (`bdj/bdjo_data.h`), read by `_parse_bdjo_app`.
 */
export interface BdjoApp {
  /** `control_code`: 1 when the application starts with the title (autostart), 2 when it is only present. */
  readonly controlCode: number;
  /** `type`: 1 for a BD-J application. */
  readonly type: number;
  /** `org_id`: the 32-bit organisation ID of the application. */
  readonly orgId: number;
  /** `app_id`: the 16-bit application ID within the organisation. */
  readonly appId: number;
  /** `profile`: the BD-ROM profiles the application needs. */
  readonly profiles: readonly BdjoAppProfile[];
  /** `priority`: the application's priority, as stored. */
  readonly priority: number;
  /** `binding`: bit 0 set for a disc-bound and bit 1 for a title-bound application (libbluray `AppEntry.java`). */
  readonly binding: number;
  /** `visibility`: the application's visibility code, as stored. */
  readonly visibility: number;
  /** `name`: the informative names, one per language; empty when the names chunk does not add up. */
  readonly names: readonly BdjoAppName[];
  /** `icon_flags`: the 16 bits as stored. */
  readonly iconFlags: number;
  /** `icon_locator`: the icon's path, relative to `baseDir`. */
  readonly iconLocator: string;
  /** `base_dir`: the application's base inside its JAR: `00000` is `00000.jar!/`, `00000/base` is `00000.jar!/base/`. */
  readonly baseDir: string;
  /**
   * `classpath_extension`: more class path entries separated by `;`; relative paths are relative to `baseDir`, and
   * absolute paths name JAR files.
   */
  readonly classpathExtension: string;
  /** `initial_class`: the name of the application's Xlet class, which starts it. */
  readonly initialClass: string;
  /** `param`: the arguments passed to the Xlet; empty when the parameters chunk does not add up. */
  readonly params: readonly string[];
}
/** A parsed `BDMV/BDJO/*.bdjo` BD-J object, libbluray `BDJO` (`bdj/bdjo_data.h`, read by `_bdjo_parse`). */
export interface Bdjo {
  /** The four version characters after the `BDJO` signature, such as `0200`. */
  readonly version: string;
  /** `terminal_info`. */
  readonly terminalInfo: BdjoTerminalInfo;
  /** `app_cache_info.item`: the JAR files and directories of the title's application cache. */
  readonly appCache: readonly BdjoAppCacheItem[];
  /** `accessible_playlists`. */
  readonly accessiblePlaylists: BdjoAccessiblePlaylists;
  /** `app_table.app`: the title's applications. */
  readonly apps: readonly BdjoApp[];
  /**
   * `key_interest_table`: the 32 bits as read, one per remote key the title wants as a key event. libbluray's bitfield
   * order puts `vk_play` in bit 31, then `vk_stop`, `vk_ffw`, `vk_rew`, `vk_track_next`, `vk_track_prev`, `vk_pause`,
   * `vk_still_off`, `vk_sec_audio_ena_dis`, `vk_sec_video_ena_dis` and `pg_textst_ena_dis` in bit 21; the rest is
   * padding.
   */
  readonly keyInterestTable: number;
  /**
   * `file_access_info.path`: the paths the applications may read, relative to the virtual file system root and
   * separated by `;`; `.` gives access to every file.
   */
  readonly fileAccessInfo: string;
}

const decoder = new TextDecoder('utf-8');

/** `_read_string`: length bytes, decoded as UTF-8. */
function readString(r: ByteReader, length: number): string {
  return decoder.decode(r.take(length));
}

/** Runs one section parser; any failure becomes a ParseError naming the section. */
function section<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ParseError) throw new ParseError(`bdjo: ${name}: ${e.message}`);
    throw e;
  }
}

function parseTerminalInfo(r: ByteReader): BdjoTerminalInfo {
  r.skip(4); // length
  const defaultFont = r.ascii(5);
  const initialHaviConfigId = r.bits(4);
  const menuCallMask = r.bits(1);
  const titleSearchMask = r.bits(1);
  r.skipBits(34);
  return { defaultFont, initialHaviConfigId, menuCallMask, titleSearchMask };
}

function parseAppCacheInfo(r: ByteReader): BdjoAppCacheItem[] {
  r.skip(4); // length
  const count = r.u8();
  r.skip(1);
  const items: BdjoAppCacheItem[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    const refToName = r.ascii(5);
    const langCode = r.ascii(3);
    r.skip(3);
    items.push({ type, refToName, langCode });
  }
  return items;
}

function parseAccessiblePlaylists(r: ByteReader): BdjoAccessiblePlaylists {
  r.skip(4); // length
  const count = r.bits(11);
  const accessToAllFlag = r.bits(1);
  const autostartFirstPlaylistFlag = r.bits(1);
  r.skipBits(19);
  const playlists: string[] = [];
  for (let i = 0; i < count; i++) {
    playlists.push(r.ascii(5));
    r.skip(1);
  }
  return { accessToAllFlag, autostartFirstPlaylistFlag, playlists };
}

function parseAppProfile(r: ByteReader): BdjoAppProfile {
  const profileNumber = r.u16();
  const majorVersion = r.u8();
  const minorVersion = r.u8();
  const microVersion = r.u8();
  r.skip(1);
  return { profileNumber, majorVersion, minorVersion, microVersion };
}

/**
 * `_count_app_strings`: counts the length-prefixed strings in a chunk, then rewinds. A chunk whose strings do not add
 * up to `dataLength` counts as zero (libbluray skips such a chunk).
 */
function countAppStrings(r: ByteReader, dataLength: number, prefixBytes: number): number {
  let count = 0;
  let bytesRead = 0;
  const pos = r.position;
  while (bytesRead < dataLength) {
    r.skip(prefixBytes);
    const length = r.u8();
    r.skip(length);
    bytesRead += prefixBytes + 1 + length;
    count++;
  }
  if (bytesRead) r.seek(pos);
  return bytesRead !== dataLength ? 0 : count;
}

function parseAppNames(r: ByteReader): BdjoAppName[] {
  const dataLength = r.u16();
  const count = countAppStrings(r, dataLength, 3);
  if (dataLength === 0) return [];
  const names: BdjoAppName[] = [];
  if (count) {
    for (let i = 0; i < count; i++) {
      const lang = r.ascii(3);
      names.push({ lang, name: readString(r, r.u8()) });
    }
  } else {
    r.skip(dataLength); // invalid data: seek over the chunk
  }
  r.skip(dataLength & 1); // word align
  return names;
}

/** `_read_app_string`: a length byte, the bytes, and a pad byte when the length is even. */
function readAppString(r: ByteReader): string {
  const length = r.u8();
  const s = readString(r, length);
  if (!(length & 1)) r.skip(1);
  return s;
}

function parseAppParams(r: ByteReader): string[] {
  const dataLength = r.u8();
  const count = countAppStrings(r, dataLength, 0);
  const params: string[] = [];
  if (count) {
    for (let i = 0; i < count; i++) params.push(readString(r, r.u8()));
  } else {
    r.skip(dataLength);
  }
  if (!(dataLength & 1)) r.skip(1);
  return params;
}

function parseApp(r: ByteReader): BdjoApp {
  const controlCode = r.u8();
  const type = r.bits(4);
  r.skipBits(4);
  const orgId = r.u32();
  const appId = r.u16();
  r.skip(10); // descriptor tag and length

  const profileCount = r.bits(4);
  r.skipBits(12);
  const profiles: BdjoAppProfile[] = [];
  for (let i = 0; i < profileCount; i++) profiles.push(parseAppProfile(r));

  const priority = r.u8();
  const binding = r.bits(2);
  const visibility = r.bits(2);
  r.skipBits(4);

  const names = parseAppNames(r);
  const iconLocator = readAppString(r);
  const iconFlags = r.u16();
  const baseDir = readAppString(r);
  const classpathExtension = readAppString(r);
  const initialClass = readAppString(r);
  const params = parseAppParams(r);
  return { controlCode, type, orgId, appId, profiles, priority, binding, visibility, names, iconFlags, iconLocator, baseDir, classpathExtension, initialClass, params };
}

function parseAppManagementTable(r: ByteReader): BdjoApp[] {
  r.skip(4); // length
  const count = r.u8();
  r.skip(1);
  const apps: BdjoApp[] = [];
  for (let i = 0; i < count; i++) apps.push(parseApp(r));
  return apps;
}

/**
 * Parses the bytes of a `.bdjo` file (libbluray `_bdjo_parse`). Throws a ParseError naming the section (header,
 * terminal info, app cache info, accessible playlists, app management table, key interest table, file access info)
 * for a bad signature, an unsupported version or a read past the end of the file.
 */
export function parseBdjo(bytes: Uint8Array): Bdjo {
  const r = new ByteReader(bytes);
  const version = section('header', () => {
    const signature = r.ascii(4);
    const v = r.ascii(4);
    if (signature !== 'BDJO') throw new ParseError(`bad signature "${signature}"`);
    checkVersion('bdjo', v);
    r.skip(40); // address table
    return v;
  });
  const terminalInfo = section('terminal info', () => parseTerminalInfo(r));
  const appCache = section('app cache info', () => parseAppCacheInfo(r));
  const accessiblePlaylists = section('accessible playlists', () => parseAccessiblePlaylists(r));
  const apps = section('app management table', () => parseAppManagementTable(r));
  const keyInterestTable = section('key interest table', () => r.bits(32));
  const fileAccessInfo = section('file access info', () => readString(r, r.u16()));
  return { version, terminalInfo, appCache, accessiblePlaylists, apps, keyInterestTable, fileAccessInfo };
}
