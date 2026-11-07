/*
 * Ported from libbluray src/libbluray/bdj/bdjo_parse.c
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2014  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { checkVersion } from './version';

/** Ported from libbluray bdj/bdjo_data.h. */
export interface BdjoTerminalInfo {
  readonly defaultFont: string;
  readonly initialHaviConfigId: number;
  readonly menuCallMask: number;
  readonly titleSearchMask: number;
}
export interface BdjoAppCacheItem {
  readonly type: number;
  readonly refToName: string;
  readonly langCode: string;
}
export interface BdjoAccessiblePlaylists {
  readonly accessToAllFlag: number;
  readonly autostartFirstPlaylistFlag: number;
  readonly playlists: readonly string[];
}
export interface BdjoAppProfile {
  readonly profileNumber: number;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly microVersion: number;
}
export interface BdjoAppName {
  readonly lang: string;
  readonly name: string;
}
export interface BdjoApp {
  readonly controlCode: number;
  readonly type: number;
  readonly orgId: number;
  readonly appId: number;
  readonly profiles: readonly BdjoAppProfile[];
  readonly priority: number;
  readonly binding: number;
  readonly visibility: number;
  readonly names: readonly BdjoAppName[];
  readonly iconFlags: number;
  readonly iconLocator: string;
  readonly baseDir: string;
  readonly classpathExtension: string;
  readonly initialClass: string;
  readonly params: readonly string[];
}
export interface Bdjo {
  readonly version: string;
  readonly terminalInfo: BdjoTerminalInfo;
  readonly appCache: readonly BdjoAppCacheItem[];
  readonly accessiblePlaylists: BdjoAccessiblePlaylists;
  readonly apps: readonly BdjoApp[];
  /** The 32 bits as read; libbluray's bitfield order is bit 31 = vk_play. */
  readonly keyInterestTable: number;
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
