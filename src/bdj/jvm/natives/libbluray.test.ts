import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { syntheticSource } from '../../../../tests/helpers/synthetic-disc';
import { loadClips, openDisc } from '@seikou/engine/disc/open-disc';
import { RecordingHost } from '../../host';
import type { BdjHost } from '../../host';
import { parseClassFile } from '../classfile';
import { Jvm } from '../jvm';
import type { JArray, JObject, JValue } from '../values';
import { Vfs } from '../vfs';
import { ZipArchive } from '../zip';
import { NativeTable } from './index';
import { registerLibblurayNatives } from './libbluray';

const file = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const LIBBLURAY = file('../../../bdj-classlib/libbluray-j2se.jar');
const LIBBLURAY_AWT = file('../../../bdj-classlib/libbluray-awt-j2se.jar');
const RT = file('../../../bdj-classlib/rt-bdj.jar');

const LIBBLURAY_CLASS = 'org/videolan/Libbluray';

/** Every native method libbluray's two jars declare. */
function declaredNatives(): string[] {
  const keys: string[] = [];
  for (const jar of [LIBBLURAY, LIBBLURAY_AWT]) {
    const z = ZipArchive.open(jar);
    for (const n of z.names) {
      if (!n.endsWith('.class')) continue;
      const cf = parseClassFile(z.read(n)!);
      for (const m of cf.methods) if (m.access & 0x0100) keys.push(`${cf.name}.${m.name}${m.desc}`);
    }
  }
  return keys.sort();
}

describe('libbluray natives', () => {
  let jvm: Jvm;
  let host: RecordingHost;
  /** Methods that replace the RecordingHost's for one test. */
  let overrides: Partial<BdjHost> = {};
  const str = (s: string): JObject => jvm.heap.newString(s);
  const field = (o: JValue, name: string, desc: string): JValue => jvm.getField(o as JObject, name, desc);
  const jstr = (v: JValue): string | null => jvm.heap.jsString(v as JObject | null);
  const call = (name: string, desc: string, args: JValue[]): Promise<JValue | undefined> => jvm.callStatic(LIBBLURAY_CLASS, name, desc, [0n, ...args]);

  beforeAll(async () => {
    const source = syntheticSource(fixtureDiscFiles('disc-bdj'));
    const disc = await openDisc(source);
    host = new RecordingHost(disc, await loadClips(source, ['00000']), { startTitle: () => {} });
    jvm = new Jvm({
      bootJars: [LIBBLURAY, LIBBLURAY_AWT, RT],
      nowMs: () => Date.now(),
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      stdout: () => {},
      stderr: () => {},
      vfs: new Vfs({ disc: source, discPaths: source.paths(), jdkLib: ZipArchive.open(RT), nowMs: () => 0 }),
    });
    const target = host;
    const view = new Proxy(target, {
      get: (t, key) => {
        const v: unknown = (overrides as Record<PropertyKey, unknown>)[key] ?? Reflect.get(t, key);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    registerLibblurayNatives(jvm.natives, view);
    await jvm.boot();
  }, 60_000);

  it('implements the 37 natives libbluray-j2se.jar and libbluray-awt-j2se.jar declare', () => {
    const t = new NativeTable();
    registerLibblurayNatives(t, host);
    const declared = declaredNatives();
    expect(declared).toHaveLength(37);
    expect([...t.keys].sort()).toEqual(declared);
  });

  it('getBdjoN builds org.videolan.bdjo.Bdjo as bdjo_make_jobj does', async () => {
    const bdjo = await call('getBdjoN', '(JLjava/lang/String;)Lorg/videolan/bdjo/Bdjo;', [str('00000.bdjo')]);
    expect((bdjo as JObject).cls.name).toBe('org/videolan/bdjo/Bdjo');
    const apps = field(bdjo!, 'appTable', '[Lorg/videolan/bdjo/AppEntry;') as JArray;
    expect(apps.data).toHaveLength(1);
    expect(jstr(field(apps.data[0] as JObject, 'initialClass', 'Ljava/lang/String;'))).toBe('bdjweb.test.FirstPlayXlet');
    expect(await call('getBdjoN', '(JLjava/lang/String;)Lorg/videolan/bdjo/Bdjo;', [str('00009.bdjo')])).toBeNull();
    expect(host.trace.filter((e) => e.call === 'getBdjoN')).toEqual([
      { call: 'getBdjoN', args: ['00000.bdjo'], ret: 1 },
      { call: 'getBdjoN', args: ['00009.bdjo'], ret: null },
    ]);
  });

  it('cacheBdRomFileN copies a disc file into the VFS, creating its directories', async () => {
    const desc = '(JLjava/lang/String;Ljava/lang/String;)I';
    expect(await call('cacheBdRomFileN', desc, [str('BDMV/JAR/00000.jar'), str('/tmp/x/00000.jar')])).toBe(0);
    const vfs = jvm.opts.vfs!;
    const h = vfs.open('/tmp/x/00000.jar', 'r')!;
    const copy = new Uint8Array(h.size());
    vfs.read(h, copy, 0, copy.length);
    expect(copy).toEqual(fixtureDiscFiles('disc-bdj').get('BDMV/JAR/00000.jar'));
    expect(await call('cacheBdRomFileN', desc, [str('BDMV/JAR/00009.jar'), str('/tmp/y/00009.jar')])).toBe(-1);
    expect(await call('cacheBdRomFileN', desc, [str('BDMV/JAR/'), str('/tmp/z/dir')])).toBe(0);
    expect(vfs.stat('/tmp/z')?.kind).toBe('dir');
    expect(await call('cacheBdRomFileN', desc, [str('BDMV/JAR/00000.jar'), str('')])).toBe(-1);
    expect(host.trace.filter((e) => e.call === 'cacheBdRomFileN').map((e) => e.ret)).toEqual([0, -1, 0, -1]);
  });

  it('listBdFilesN lists a disc directory', async () => {
    const desc = '(JLjava/lang/String;Z)[Ljava/lang/String;';
    const names = (await call('listBdFilesN', desc, [str('BDMV/BDJO'), 1])) as JArray;
    expect((names.data as JObject[]).map(jstr)).toEqual(['00000.bdjo', '00001.bdjo']);
    expect(await call('listBdFilesN', desc, [str('BDMV/NOPE'), 0])).toBeNull();
    expect(host.trace.filter((e) => e.call === 'listBdFilesN')).toEqual([
      { call: 'listBdFilesN', args: ['BDMV/BDJO', true], ret: 2 },
      { call: 'listBdFilesN', args: ['BDMV/NOPE', false], ret: null },
    ]);
  });

  it('getTitleInfosN and getPlaylistInfoN build TitleInfo and PlaylistInfo objects', async () => {
    const titles = (await call('getTitleInfosN', '(J)[Lorg/videolan/TitleInfo;', [])) as JArray;
    expect(titles.data).toHaveLength(3);
    const fp = titles.data[2] as JObject;
    expect(field(fp, 'title', 'I')).toBe(65535);
    expect(field(fp, 'objType', 'I')).toBe(2);
    expect(jstr(field(fp, 'bdjoName', 'Ljava/lang/String;'))).toBe('00000');
    const pl = (await call('getPlaylistInfoN', '(JI)Lorg/videolan/PlaylistInfo;', [0])) as JObject;
    expect(field(pl, 'duration', 'J')).toBe(180000n);
    const clips = field(pl, 'clips', '[Lorg/videolan/TIClip;') as JArray;
    expect(clips.data).toHaveLength(1);
    const video = field(clips.data[0] as JObject, 'videoStreams', '[Lorg/videolan/StreamInfo;') as JArray;
    expect(field(video.data[0] as JObject, 'subpath_id', 'B')).toBe(-1);
    expect(await call('getPlaylistInfoN', '(JI)Lorg/videolan/PlaylistInfo;', [999])).toBeNull();
  });

  it('forwards control calls to the host with JNI argument types', async () => {
    const before = host.trace.length;
    expect(await call('writeRegN', '(JIIII)I', [0, 100, 42, -1])).toBe(0);
    expect(await call('readRegN', '(JII)I', [0, 100])).toBe(42);
    expect(await call('selectPlaylistN', '(JIIIJ)I', [0, -1, -1, -1n])).toBe(1);
    expect(await call('seekN', '(JIIJ)J', [-1, -1, 0n])).toBe(1n);
    await call('setUOMaskN', '(JZZ)V', [0, 1]);
    expect(await call('getUOMaskN', '(J)J', [])).toBe(2n);
    expect(await call('selectRateN', '(JFI)I', [Math.fround(1), 1])).toBe(1);
    await call('updateGraphicN', '(JII[IIIII)V', [1920, 1080, null, 0, 0, 0, 0]);
    expect(host.trace.slice(before).map((e) => JSON.stringify(e))).toEqual([
      '{"call":"writeRegN","args":[0,100,42,-1],"ret":0}',
      '{"call":"readRegN","args":[0,100],"ret":42}',
      '{"call":"selectPlaylistN","args":[0,-1,-1,"-1"],"ret":1}',
      '{"call":"seekN","args":[-1,-1,"0"],"ret":"1"}',
      '{"call":"setUOMaskN","args":[false,true],"ret":null}',
      '{"call":"getUOMaskN","args":[],"ret":"2"}',
      '{"call":"selectRateN","args":[1,1],"ret":1}',
      '{"call":"updateGraphicN","args":[1920,1080,0,0,0,0,true],"ret":null}',
    ]);
  });

  it('parks the calling Java thread on a host promise and resumes with its value', async () => {
    let release: ((v: number) => void) | null = null;
    const later = <T>(v: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(v), 5));
    overrides = {
      writeReg: () => new Promise<number>((resolve) => setTimeout(() => (release = resolve), 5)),
      selectTitle: () => later(1),
      seek: () => later(-5n),
      setUOMask: () => later(undefined),
    };
    try {
      // Libbluray.writeGPR and selectHdmvTitle use the native's result in Java.
      const pending = jvm.callStatic(LIBBLURAY_CLASS, 'writeGPR', '(II)V', [1, 2]);
      await new Promise((r) => setTimeout(r, 20));
      release!(-1);
      await expect(pending).rejects.toThrow(/IllegalArgumentException: Invalid GPR/);
      expect(await jvm.callStatic(LIBBLURAY_CLASS, 'selectHdmvTitle', '(I)Z', [1])).toBe(1);
      expect(await call('seekN', '(JIIJ)J', [-1, -1, 0n])).toBe(-5n);
      expect(await call('setUOMaskN', '(JZZ)V', [1, 0])).toBeUndefined();
    } finally {
      overrides = {};
    }
  });

  it('turns a rejected host promise into a Java exception on the calling thread', async () => {
    overrides = { selectTitle: () => Promise.reject(new Error('engine gone')) };
    try {
      await expect(call('selectTitleN', '(JI)I', [1])).rejects.toThrow(/java\.lang\.RuntimeException: engine gone/);
      expect(await call('readRegN', '(JII)I', [1, 4])).toEqual(expect.any(Number));
    } finally {
      overrides = {};
    }
  });

  it('Logger.logN reaches the host unless the message is empty', async () => {
    const before = host.trace.length;
    const desc = '(ZLjava/lang/String;ILjava/lang/String;)V';
    await jvm.callStatic('org/videolan/Logger', 'logN', desc, [0, str('A.java'), 7, str('hello')]);
    await jvm.callStatic('org/videolan/Logger', 'logN', desc, [1, null, 0, str('')]);
    expect(host.trace.slice(before)).toEqual([{ call: 'logN', args: ['A.java', 7, 'hello'], ret: null }]);
  });
});
