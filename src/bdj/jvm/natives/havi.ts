/*
 * HAVi background stills. libbluray leaves HStillImageBackgroundConfiguration.displayImage unimplemented (it keeps
 * the image and rectangle and logs "UNIMPLEMENTED"), so it never shows a disc's background still; a player does.
 * This replaces that method: it keeps the image and rectangle as libbluray's Java does
 * (src/libbluray/bdj/java/org/havi/ui/HStillImageBackgroundConfiguration.java), then reads the still's encoded bytes
 * from where java.awt.BDToolkitBase.createImage(String) put its source (a sun.awt.image.FileImageSource behind the
 * BDImageConsumer that HBackgroundImage(String) holds) and hands them to the host, which shows them under the video.
 * HBackgroundImage(byte[]) and HBackgroundImage(URL) hold a sun.awt.image.ByteArrayImageSource (the bytes are its
 * imagedata, imageoffset and imagelength) and a sun.awt.image.URLImageSource (a file: URL, or a jar: URL of a file:
 * jar, read through the virtual file system); a URL naming no file, or bytes out of range, is logged and leaves the
 * background as it is.
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ScreenRect } from '../../background';
import type { BdjHost } from '../../host';
import type { NativeResult } from '../interpreter';
import type { Jvm } from '../jvm';
import type { JArray, JObject, JValue } from '../values';
import { ZipArchive } from '../zip';
import type { NativeTable } from './index';
import { absolute, readVfsFile } from './io';

export const DISPLAY_IMAGE = 'org/havi/ui/HStillImageBackgroundConfiguration.displayImage(Lorg/havi/ui/HBackgroundImage;Lorg/havi/ui/HScreenRectangle;)V';

const CONFIG = 'org/havi/ui/HStillImageBackgroundConfiguration';
const FILE_IMAGE_SOURCE = 'sun/awt/image/FileImageSource';
const BYTE_ARRAY_IMAGE_SOURCE = 'sun/awt/image/ByteArrayImageSource';
const URL_IMAGE_SOURCE = 'sun/awt/image/URLImageSource';
const IMAGE_CONSUMER = 'java/awt/BDImageConsumer';

/**
 * Where a background image's encoded bytes are: a file of the virtual file system (an entry of a jar file when
 * `entry` is set), bytes Java holds, none, a URL that names no file, or a source of another kind.
 */
type StillSource =
  | { readonly kind: 'file'; readonly path: string; readonly entry?: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'none' }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'unreadable'; readonly what: string }
  | { readonly kind: 'unsupported'; readonly what: string };

/** The field `name` of `o`, or undefined when its class has no such instance field. */
function fieldOf(o: JObject, name: string, desc: string): JValue | undefined {
  const f = o.cls.findField(name, desc);
  return f && !f.isStatic ? o.fields[f.slot] : undefined;
}

const isA = (o: JObject, name: string): boolean => {
  for (let c: typeof o.cls | null = o.cls; c; c = c.superClass) if (c.name === name) return true;
  return false;
};

/** %XX escapes of a URL's path as UTF-8, as sun.net.www.ParseUtil.decode reads them for a file: URL; null if malformed. */
function decodePath(p: string): string | null {
  try {
    return decodeURIComponent(p.replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
  } catch {
    return null;
  }
}

/** The VFS file a URL names: file:<path>, or jar:file:<path>!/<entry>. */
function urlSource(protocol: string, file: string, spec: string): StillSource {
  if (protocol === 'file') {
    const path = decodePath(file.replace(/[?#].*$/, ''));
    return path ? { kind: 'file', path: absolute(path) } : { kind: 'url', url: spec };
  }
  if (protocol === 'jar') {
    const bang = file.indexOf('!/');
    const inner = bang < 0 ? null : /^file:(.*)$/.exec(file.slice(0, bang));
    const path = inner ? decodePath(inner[1]!) : null;
    const entry = bang < 0 ? null : decodePath(file.slice(bang + 2));
    if (path && entry) return { kind: 'file', path: absolute(path), entry };
  }
  return { kind: 'url', url: spec };
}

/**
 * HBackgroundImage.img → BDImageConsumer.producer (BDToolkitBase.createImage): a FileImageSource's imagefile, a
 * ByteArrayImageSource's bytes or a URLImageSource's url.
 */
function sourceOf(jvm: Jvm, image: JObject): StillSource {
  const img = fieldOf(image, 'img', 'Ljava/awt/Image;') as JObject | null | undefined;
  if (!img) return { kind: 'none' }; // HBackgroundImage(byte[]) with null pixels leaves no image
  if (!isA(img, IMAGE_CONSUMER)) return { kind: 'unsupported', what: img.cls.name };
  const producer = fieldOf(img, 'producer', 'Ljava/awt/image/ImageProducer;') as JObject | null | undefined;
  if (!producer) return { kind: 'none' };
  const str = (o: JObject, name: string): string | null => jvm.heap.jsString((fieldOf(o, name, 'Ljava/lang/String;') ?? null) as JObject | null);
  if (isA(producer, FILE_IMAGE_SOURCE)) {
    const file = str(producer, 'imagefile');
    return file ? { kind: 'file', path: absolute(file) } : { kind: 'none' };
  }
  if (isA(producer, BYTE_ARRAY_IMAGE_SOURCE)) {
    const data = fieldOf(producer, 'imagedata', '[B') as JArray | null | undefined;
    if (!data) return { kind: 'none' };
    const all = data.data as Int8Array;
    const off = fieldOf(producer, 'imageoffset', 'I') as number;
    const len = fieldOf(producer, 'imagelength', 'I') as number;
    if (off < 0 || len <= 0 || off + len > all.length) return { kind: 'unreadable', what: `byte[${all.length}] at ${off}, ${len} long` };
    return { kind: 'bytes', bytes: new Uint8Array(all.buffer, all.byteOffset + off, len).slice() };
  }
  if (isA(producer, URL_IMAGE_SOURCE)) {
    const url = fieldOf(producer, 'url', 'Ljava/net/URL;') as JObject | null | undefined;
    if (!url) return { kind: 'none' };
    const protocol = str(url, 'protocol') ?? '';
    const file = str(url, 'file') ?? '';
    const host = str(url, 'host') ?? '';
    return urlSource(protocol, file, `${protocol}:${host ? `//${host}` : ''}${file}`);
  }
  return { kind: 'unsupported', what: producer.cls.name };
}

/** HScreenRectangle's public fields; libbluray's default is the whole screen. */
function rectOf(jvm: Jvm, r: JObject | null): ScreenRect {
  if (!r) return { x: 0, y: 0, width: 1, height: 1 };
  const f = (name: string): number => jvm.getField(r, name, 'F') as number;
  return { x: f('x'), y: f('y'), width: f('width'), height: f('height') };
}

export function registerHaviNatives(table: NativeTable, host: BdjHost): void {
  const log = (msg: string): void => host.log(CONFIG, 0, msg, true);
  table.replace({
    [DISPLAY_IMAGE]: (ctx, self, image, r): NativeResult => {
      const jvm = ctx.jvm;
      if (self === null) return jvm.throwNew('java/lang/NullPointerException');
      // libbluray's body, without its "unimplemented" log
      jvm.setField(self as JObject, 'image', 'Lorg/havi/ui/HBackgroundImage;', image);
      jvm.setField(self as JObject, 'rect', 'Lorg/havi/ui/HScreenRectangle;', r);
      const rect = rectOf(jvm, r as JObject | null);
      const show = host.displayImage?.bind(host);
      if (!show) return undefined;
      if (image === null) {
        show(null, rect);
        return undefined;
      }
      const source = sourceOf(jvm, image as JObject);
      if (source.kind === 'none') {
        show(null, rect);
        return undefined;
      }
      if (source.kind === 'unsupported') {
        log(`displayImage(): background images from ${source.what} are not shown`);
        return undefined;
      }
      if (source.kind === 'bytes') {
        show(source.bytes, rect);
        return undefined;
      }
      if (source.kind === 'unreadable') {
        log(`displayImage(): ${source.what} cannot be read`);
        return undefined;
      }
      if (source.kind === 'url') {
        log(`displayImage(): ${source.url} names no file`);
        return undefined;
      }
      const { path, entry } = source;
      const what = entry === undefined ? path : `${path}!/${entry}`;
      const vfs = jvm.opts.vfs;
      if (!vfs || vfs.stat(path)?.kind !== 'file') {
        log(`displayImage(): ${what} cannot be read`);
        return undefined;
      }
      return readVfsFile(vfs, path, (bytes) => {
        let still = bytes;
        if (still && entry !== undefined) {
          try {
            still = ZipArchive.open(still).read(entry);
          } catch {
            still = null;
          }
        }
        if (still) show(still, rect);
        else log(`displayImage(): ${what} cannot be read`);
        return undefined;
      });
    },
  });
}
