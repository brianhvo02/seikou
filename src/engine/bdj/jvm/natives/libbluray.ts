/*
 * libbluray's BD-J natives. Ported from libbluray src/libbluray/bdj/native/org_videolan_Libbluray.c
 * (_make_title_info, _make_title_infos, _make_stream_array, _make_playlist_info and the Java_org_videolan_Libbluray_*
 * functions), bdj/native/bdjo.c (_make_terminal_info, _make_app_cache_info, _make_accessible_playlists, _make_app,
 * _make_app_management_table, bdjo_make_jobj), bdj/native/util.c (bdj_make_object, bdj_make_array),
 * bdj/native/org_videolan_Logger.c, bdj/bdjo_parse.c (bdjo_get), disc/disc.c (disc_cache_bdrom_file,
 * disc_open_dir) and file/file.c (file_mkdirs). The font and text natives (bdj/native/java_awt_BDFontMetrics.c,
 * java_awt_BDGraphics.c) are in fonts.ts. libbluray's java/io/FileInputStream natives share the JDK's.
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2012-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { parseBdjo } from '../../../bdmv/bdjo-parser';
import type { Bdjo, BdjoApp } from '../../../bdmv/bdjo-parser';
import { ParseError } from '@seikou/bdmv/byte-reader';
import type { BdjHost, PlaylistInfo, StreamInfo, TitleInfo, TraceEntry } from '../../host';
import { Invoke, andThen } from '../interpreter';
import type { NativeResult } from '../interpreter';
import type { Jvm } from '../jvm';
import type { JArray, JObject, JValue } from '../values';
import type { Vfs } from '../vfs';
import type { NativeContext, NativeTable } from './index';
import { registerFontNatives } from './fonts';
import type { FontNativeDeps } from './fonts';
import { closeStream, openInto, readBytes, readVfsFile, suspendRead } from './io';
import { method, none } from './util';

const DISC = '/disc/';
const TITLE_TYPE_HDMV = 1;
const TITLE_TYPE_BDJ = 2;

const i8 = (v: number): number => (v << 24) >> 24;
const i16 = (v: number): number => (v << 16) >> 16;
const z = (v: number | boolean): number => (v ? 1 : 0);
/** NewStringUTF of a C string: it ends at the first NUL. */
const cstr = (s: string): string => {
  const nul = s.indexOf('\0');
  return nul < 0 ? s : s.slice(0, nul);
};

/** bdj_make_object: FindClass, then NewObject with the constructor `sig`; the result is the new object. */
function makeObject(ctx: NativeContext, name: string, sig: string, args: readonly JValue[]): NativeResult {
  const jvm = ctx.jvm;
  const c = jvm.bootClass(name);
  return jvm.withInit(ctx.thread, c, () => {
    const o = jvm.heap.newObject(c);
    return new Invoke(method(c, `<init>${sig}`), [o, ...args], () => o);
  });
}

/** bdj_make_array of `name` (a class name or an array descriptor), filled in order by `make`. */
function makeArray<T>(ctx: NativeContext, name: string, items: readonly T[], make: (item: T, i: number) => NativeResult): NativeResult {
  const jvm = ctx.jvm;
  const loader = jvm.loader;
  const component = name.startsWith('[') ? loader.arrayOf(jvm.bootClass(name.slice(2, -1))) : jvm.bootClass(name);
  const arr = jvm.heap.newArray(loader.arrayOf(component), items.length);
  const step = (i: number): NativeResult =>
    i >= items.length
      ? arr
      : andThen(make(items[i]!, i), (v) => {
          (arr.data as JValue[])[i] = v ?? null;
          return step(i + 1);
        });
  return step(0);
}

function strings(ctx: NativeContext, items: readonly (string | null)[]): NativeResult {
  return makeArray(ctx, 'java/lang/String', items, (s) => (s === null ? null : ctx.jvm.heap.newString(s)));
}

/** Runs each step in turn, passing on the results in order. */
function all(steps: readonly (() => NativeResult)[], k: (values: JValue[]) => NativeResult): NativeResult {
  const values: JValue[] = [];
  const step = (i: number): NativeResult =>
    i >= steps.length
      ? k(values)
      : andThen(steps[i]!(), (v) => {
          values.push(v ?? null);
          return step(i + 1);
        });
  return step(0);
}

/** _make_title_info */
function makeTitleInfo(ctx: NativeContext, t: TitleInfo | null): NativeResult {
  if (!t) return null;
  const bdj = t.objectType === 'bdj';
  const idRef = bdj ? Number.parseInt(t.bdjoName ?? '0', 10) || 0 : (t.hdmvObjectId ?? 0);
  return makeObject(ctx, 'org/videolan/TitleInfo', '(IIII)V', [t.number, bdj ? TITLE_TYPE_BDJ : TITLE_TYPE_HDMV, t.playbackType, idRef]);
}

/** _make_stream_array */
function makeStreamArray(ctx: NativeContext, streams: readonly StreamInfo[]): NativeResult {
  return makeArray(ctx, 'org/videolan/StreamInfo', streams, (s) =>
    makeObject(ctx, 'org/videolan/StreamInfo', '(BBBCLjava/lang/String;BB)V', [
      i8(s.codingType),
      i8(s.format),
      i8(s.rate),
      s.charCode & 0xffff,
      ctx.jvm.heap.newString(cstr(s.lang)),
      i8(s.aspect),
      i8(s.subpathId),
    ]),
  );
}

const STREAM_ARRAY = '[Lorg/videolan/StreamInfo;';

/** _make_playlist_info */
function makePlaylistInfo(ctx: NativeContext, ti: PlaylistInfo): NativeResult {
  return all(
    [
      () => makeArray(ctx, 'org/videolan/TIMark', ti.marks, (m, i) => makeObject(ctx, 'org/videolan/TIMark', '(IIJ)V', [i, m.type, BigInt.asIntN(64, m.startTicks)])),
      () =>
        makeArray(ctx, 'org/videolan/TIClip', ti.clips, (c, i) =>
          all(
            [c.videoStreams, c.audioStreams, c.pgStreams, c.igStreams, c.secondaryVideoStreams, c.secondaryAudioStreams].map((s) => () => makeStreamArray(ctx, s)),
            (arrays) => makeObject(ctx, 'org/videolan/TIClip', `(I${STREAM_ARRAY.repeat(6)})V`, [i, ...arrays]),
          ),
        ),
    ],
    ([marks, clips]) =>
      makeObject(ctx, 'org/videolan/PlaylistInfo', '(IJI[Lorg/videolan/TIMark;[Lorg/videolan/TIClip;)V', [
        ti.playlist,
        BigInt.asIntN(64, ti.durationTicks),
        ti.angleCount,
        marks!,
        clips!,
      ]),
  );
}

/** _make_app */
function makeApp(ctx: NativeContext, p: BdjoApp): NativeResult {
  const heap = ctx.jvm.heap;
  return all(
    [
      () =>
        makeArray(ctx, 'org/videolan/bdjo/AppProfile', p.profiles, (pr) =>
          makeObject(ctx, 'org/videolan/bdjo/AppProfile', '(SBBB)V', [i16(pr.profileNumber), i8(pr.majorVersion), i8(pr.minorVersion), i8(pr.microVersion)]),
        ),
      () => makeArray(ctx, '[Ljava/lang/String;', p.names, (n) => strings(ctx, [cstr(n.lang), cstr(n.name)])),
      () => strings(ctx, p.params.map(cstr)),
    ],
    ([profiles, names, params]) =>
      makeObject(
        ctx,
        'org/videolan/bdjo/AppEntry',
        '(IIIS[Lorg/videolan/bdjo/AppProfile;SII[[Ljava/lang/String;Ljava/lang/String;SLjava/lang/String;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)V',
        [
          p.controlCode,
          p.type,
          p.orgId | 0,
          i16(p.appId),
          profiles!,
          i16(p.priority),
          p.binding,
          p.visibility,
          names!,
          heap.newString(cstr(p.iconLocator)),
          i16(p.iconFlags),
          heap.newString(cstr(p.baseDir)),
          heap.newString(cstr(p.classpathExtension)),
          heap.newString(cstr(p.initialClass)),
          params!,
        ],
      ),
  );
}

/** bdjo_make_jobj; the key interest bits are libbluray's bit-field order (vk_play first, at bit 31 of the table). */
function makeBdjo(ctx: NativeContext, p: Bdjo): NativeResult {
  const heap = ctx.jvm.heap;
  let keyInterest = 0;
  for (let i = 0; i <= 10; i++) keyInterest |= ((p.keyInterestTable >>> (31 - i)) & 1) << i;
  const t = p.terminalInfo;
  const pl = p.accessiblePlaylists;
  return all(
    [
      () =>
        makeObject(ctx, 'org/videolan/bdjo/TerminalInfo', '(Ljava/lang/String;IZZ)V', [
          heap.newString(cstr(t.defaultFont)),
          t.initialHaviConfigId,
          z(t.menuCallMask),
          z(t.titleSearchMask),
        ]),
      () =>
        makeArray(ctx, 'org/videolan/bdjo/AppCache', p.appCache, (a) =>
          makeObject(ctx, 'org/videolan/bdjo/AppCache', '(ILjava/lang/String;Ljava/lang/String;)V', [a.type, heap.newString(cstr(a.refToName)), heap.newString(cstr(a.langCode))]),
        ),
      () =>
        andThen(strings(ctx, pl.playlists.map(cstr)), (names) =>
          makeObject(ctx, 'org/videolan/bdjo/PlayListTable', '(ZZ[Ljava/lang/String;)V', [z(pl.accessToAllFlag), z(pl.autostartFirstPlaylistFlag), names ?? null]),
        ),
      () => makeArray(ctx, 'org/videolan/bdjo/AppEntry', p.apps, (a) => makeApp(ctx, a)),
    ],
    ([terminal, cache, playlists, apps]) =>
      makeObject(
        ctx,
        'org/videolan/bdjo/Bdjo',
        '(Lorg/videolan/bdjo/TerminalInfo;[Lorg/videolan/bdjo/AppCache;Lorg/videolan/bdjo/PlayListTable;[Lorg/videolan/bdjo/AppEntry;ILjava/lang/String;)V',
        [terminal!, cache!, playlists!, apps!, keyInterest, heap.newString(cstr(p.fileAccessInfo))],
      ),
  );
}

/** file_mkdirs: creates the missing directories above the file `path`. */
function mkdirs(vfs: Vfs, path: string): boolean {
  const end = path.lastIndexOf('/');
  if (end < 0) return false;
  const parts = path.slice(0, end).split('/');
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (dir === '' || vfs.stat(dir)) continue;
    if (!vfs.mkdir(dir)) return false;
  }
  return true;
}

/** disc_cache_bdrom_file */
function cacheBdromFile(vfs: Vfs, relPath: string, cachePath: string, k: (result: number) => NativeResult): NativeResult {
  if (cachePath === '' || !mkdirs(vfs, cachePath)) return k(-1);
  if (relPath === '' || relPath.endsWith('/') || relPath.endsWith('\\')) return k(0);
  return readVfsFile(vfs, DISC + relPath, (bytes) => {
    if (!bytes) return k(-1);
    const out = vfs.open(cachePath, 'w');
    if (!out) return k(-1);
    const ok = vfs.write(out, bytes, 0, bytes.length);
    vfs.close(out);
    if (!ok) vfs.delete(cachePath);
    return k(ok ? 0 : -1);
  });
}

/** bdjo_get: BDMV/BDJO/<file>, then the backup copy. */
function bdjoGet(vfs: Vfs, file: string, k: (bdjo: Bdjo | null) => NativeResult): NativeResult {
  const parse = (bytes: Uint8Array | null): Bdjo | null => {
    if (!bytes) return null;
    try {
      return parseBdjo(bytes);
    } catch (e) {
      if (e instanceof ParseError) return null;
      throw e;
    }
  };
  return readVfsFile(vfs, `${DISC}BDMV/BDJO/${file}`, (bytes) => {
    const bdjo = parse(bytes);
    return bdjo ? k(bdjo) : readVfsFile(vfs, `${DISC}BDMV/BACKUP/BDJO/${file}`, (backup) => k(parse(backup)));
  });
}

function vfsOf(jvm: Jvm): Vfs {
  const vfs = jvm.opts.vfs;
  if (!vfs) throw new Error('libbluray natives need a Vfs');
  return vfs;
}

/** A host answer: a promise parks the calling thread, and a rejected one throws a RuntimeException in it. */
function answer<T>(ctx: NativeContext, r: T | Promise<T>, toJava: (v: T) => JValue | undefined): NativeResult {
  return r instanceof Promise ? suspendRead(ctx.jvm, r, 'java/lang/RuntimeException', toJava) : toJava(r);
}

const int = (v: number): number => v;
const long = (v: bigint): bigint => BigInt.asIntN(64, v);
const voidOf = (): undefined => undefined;

/** The natives libbluray registers; `fonts` gives the font and text natives (fonts.ts) FreeType. */
export function registerLibblurayNatives(table: NativeTable, host: BdjHost, fonts: FontNativeDeps = {}): void {
  const record = (e: TraceEntry): void => host.record?.(e);
  registerFontNatives(table, fonts);

  table.register({
    'org/videolan/Libbluray.getTitleInfosN(J)[Lorg/videolan/TitleInfo;': (ctx) => {
      const titles = host.getTitleInfos();
      return makeArray(ctx, 'org/videolan/TitleInfo', titles, (t) => makeTitleInfo(ctx, t));
    },
    'org/videolan/Libbluray.getPlaylistInfoN(JI)Lorg/videolan/PlaylistInfo;': (ctx, _np, playlist) => {
      const ti = host.getPlaylistInfo(playlist as number);
      return ti ? makePlaylistInfo(ctx, ti) : null;
    },
    'org/videolan/Libbluray.getAacsDataN(JI)[B': (ctx, _np, type) => {
      const data = host.getAacsData(type as number);
      if (!data) return null;
      const arr = ctx.jvm.heap.newArray(ctx.jvm.loader.arrayOf(ctx.jvm.loader.primitive('B')), data.length);
      (arr.data as Int8Array).set(new Int8Array(data.buffer, data.byteOffset, data.length));
      return arr;
    },
    'org/videolan/Libbluray.getUOMaskN(J)J': () => BigInt.asIntN(64, host.getUOMask()),
    'org/videolan/Libbluray.setUOMaskN(JZZ)V': (ctx, _np, menuCall, titleSearch) => answer(ctx, host.setUOMask(menuCall !== 0, titleSearch !== 0), voidOf),
    'org/videolan/Libbluray.setKeyInterestN(JI)V': (ctx, _np, mask) => answer(ctx, host.setKeyInterest(mask as number), voidOf),
    'org/videolan/Libbluray.setVirtualPackageN(JLjava/lang/String;Z)I': (ctx, _np, path, backup) =>
      answer(ctx, host.setVirtualPackage(ctx.jvm.heap.jsString(path as JObject | null), backup !== 0), int),
    'org/videolan/Libbluray.seekN(JIIJ)J': (ctx, _np, playitem, playmark, time) => answer(ctx, host.seek(playitem as number, playmark as number, time as bigint), long),
    'org/videolan/Libbluray.selectPlaylistN(JIIIJ)I': (ctx, _np, playlist, playitem, playmark, time) =>
      answer(ctx, host.selectPlaylist(playlist as number, playitem as number, playmark as number, time as bigint), int),
    'org/videolan/Libbluray.selectTitleN(JI)I': (ctx, _np, title) => answer(ctx, host.selectTitle(title as number), int),
    'org/videolan/Libbluray.selectAngleN(JI)I': (ctx, _np, angle) => answer(ctx, host.selectAngle(angle as number), int),
    'org/videolan/Libbluray.soundEffectN(JI)I': (ctx, _np, id) => answer(ctx, host.soundEffect(id as number), int),
    'org/videolan/Libbluray.tellTimeN(J)J': () => long(host.tellTime()),
    'org/videolan/Libbluray.selectRateN(JFI)I': (ctx, _np, rate, reason) => answer(ctx, host.selectRate(rate as number, reason as number), int),
    'org/videolan/Libbluray.readRegN(JII)I': (_ctx, _np, isPsr, num) => host.readReg(isPsr as number, num as number),
    'org/videolan/Libbluray.writeRegN(JIIII)I': (ctx, _np, isPsr, num, value, mask) =>
      answer(ctx, host.writeReg(isPsr as number, num as number, value as number, mask as number), int),
    'org/videolan/Libbluray.cacheBdRomFileN(JLjava/lang/String;Ljava/lang/String;)I': (ctx, _np, rel, cache) => {
      const heap = ctx.jvm.heap;
      const relPath = heap.jsString(rel as JObject | null);
      const cachePath = heap.jsString(cache as JObject | null);
      const done = (result: number): number => {
        record({ call: 'cacheBdRomFileN', args: [relPath, cachePath], ret: result });
        return result;
      };
      if (relPath === null || cachePath === null) return done(-1);
      return cacheBdromFile(vfsOf(ctx.jvm), relPath, cachePath, done);
    },
    'org/videolan/Libbluray.listBdFilesN(JLjava/lang/String;Z)[Ljava/lang/String;': (ctx, _np, jpath, onlyBdRom) => {
      const path = ctx.jvm.heap.jsString(jpath as JObject | null);
      if (path === null) return null;
      const names = vfsOf(ctx.jvm).list(DISC + path);
      record({ call: 'listBdFilesN', args: [path, onlyBdRom !== 0], ret: names ? names.length : null });
      return names ? strings(ctx, names) : null;
    },
    'org/videolan/Libbluray.getBdjoN(JLjava/lang/String;)Lorg/videolan/bdjo/Bdjo;': (ctx, _np, jfile) => {
      const file = ctx.jvm.heap.jsString(jfile as JObject | null);
      if (file === null) return null;
      return bdjoGet(vfsOf(ctx.jvm), file, (bdjo) =>
        andThen(bdjo ? makeBdjo(ctx, bdjo) : null, (o) => {
          record({ call: 'getBdjoN', args: [file], ret: o ? 1 : null });
          return o ?? null;
        }),
      );
    },
    'org/videolan/Libbluray.updateGraphicN(JII[IIIII)V': (_ctx, _np, width, height, rgb, x0, y0, x1, y1) =>
      void host.updateGraphic(
        width as number,
        height as number,
        rgb === null ? null : ((rgb as JArray).data as Int32Array),
        x0 as number,
        y0 as number,
        x1 as number,
        y1 as number,
      ),

    'org/videolan/Logger.logN(ZLjava/lang/String;ILjava/lang/String;)V': (ctx, error, file, line, msg) => {
      const text = ctx.jvm.heap.jsString(msg as JObject | null);
      if (!text) return undefined;
      host.log(ctx.jvm.heap.jsString(file as JObject | null), line as number, text, error !== 0);
      return undefined;
    },

    // libbluray's java.io.FileInputStream: open() is the pre-OpenJDK 8 name of open0(); close0() returns an int.
    'java/io/FileInputStream.initIDs()V': none,
    'java/io/FileInputStream.open0(Ljava/lang/String;)V': (ctx, self, name) => openInto(ctx, self, name, 'r'),
    'java/io/FileInputStream.open(Ljava/lang/String;)V': (ctx, self, name) => openInto(ctx, self, name, 'r'),
    'java/io/FileInputStream.readBytes([BII)I': readBytes,
    'java/io/FileInputStream.close0()I': closeStream,
  });
}
