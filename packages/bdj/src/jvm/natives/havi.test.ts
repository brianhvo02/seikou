import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../../tests/helpers/fixture-disc';
import { syntheticSource } from '../../../../../tests/helpers/synthetic-disc';
import type { ScreenRect } from '../../background';
import type { BdjHost } from '../../host';
import { Invoke } from '../interpreter';
import { Jvm } from '../jvm';
import type { JMethod } from '../loader';
import type { JObject, JValue } from '../values';
import { Vfs } from '../vfs';
import { ZipArchive } from '../zip';
import { DISPLAY_IMAGE, registerHaviNatives } from './havi';
import { byteArray } from './util';

const file = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const RT = file('../../../../bdj-classlib/rt-bdj.jar');
const BOOT_JARS = [file('../../../../bdj-classlib/libbluray-j2se.jar'), file('../../../../bdj-classlib/libbluray-awt-j2se.jar'), RT];
const CONFIG = 'org/havi/ui/HStillImageBackgroundConfiguration';
const DISC_FILE = 'BDMV/index.bdmv';

describe('HStillImageBackgroundConfiguration.displayImage (background stills)', () => {
  let jvm: Jvm;
  const shown: { image: Uint8Array | null; rect: ScreenRect }[] = [];
  const logged: string[] = [];
  let withDisplay = true;
  const files = fixtureDiscFiles('disc-bdj');

  async function run(cls: string, key: string, args: readonly JValue[]): Promise<void> {
    const c = jvm.bootClass(cls);
    let m: JMethod | undefined;
    for (let k: typeof c | null = c; k && !m; k = k.superClass) m = k.methods.get(key);
    if (!m) throw new Error(`${cls}.${key} is missing`);
    const method = m;
    const t = jvm.threads.spawnWith(jvm.mainThread, (t) => jvm.withInit(t, c, () => new Invoke(method, args, () => undefined)));
    const ended = new AbortController();
    t.onTerminate = () => ended.abort();
    if (t.state !== 'terminated') await jvm.threads.run(ended.signal);
    t.onTerminate = null;
    if (t.state !== 'terminated') throw new Error(`${cls}.${key} did not finish`);
    if (t.uncaught) throw new Error(`${cls}.${key} threw ${t.uncaught.cls.name}`);
  }

  /** An object of `cls` with the given fields set, without running its constructors. */
  function make(cls: string, fields: Readonly<Record<string, readonly [string, JValue]>> = {}): JObject {
    const o = jvm.heap.newObject(jvm.bootClass(cls));
    for (const [name, [desc, v]] of Object.entries(fields)) jvm.setField(o, name, desc, v);
    return o;
  }

  /** What new HBackgroundImage(path) holds: BDToolkitBase.createImage(String)'s BDImageConsumer over a FileImageSource. */
  function fileImage(path: string): JObject {
    const source = make('sun/awt/image/FileImageSource', { imagefile: ['Ljava/lang/String;', jvm.heap.newString(path)] });
    const img = make('java/awt/BDImageConsumer', { producer: ['Ljava/awt/image/ImageProducer;', source] });
    return make('org/havi/ui/HBackgroundImage', { img: ['Ljava/awt/Image;', img] });
  }

  /** What BDToolkitBase.createImage(byte[], int, int) and createImage(URL) put behind HBackgroundImage's image. */
  function producerImage(source: JObject): JObject {
    const img = make('java/awt/BDImageConsumer', { producer: ['Ljava/awt/image/ImageProducer;', source] });
    return make('org/havi/ui/HBackgroundImage', { img: ['Ljava/awt/Image;', img] });
  }

  const byteImage = (bytes: Uint8Array, offset: number, length: number): JObject =>
    producerImage(make('sun/awt/image/ByteArrayImageSource', { imagedata: ['[B', byteArray(jvm, bytes)], imageoffset: ['I', offset], imagelength: ['I', length] }));

  const urlImage = (protocol: string, host: string, path: string): JObject =>
    producerImage(
      make('sun/awt/image/URLImageSource', {
        url: ['Ljava/net/URL;', make('java/net/URL', { protocol: ['Ljava/lang/String;', jvm.heap.newString(protocol)], host: ['Ljava/lang/String;', jvm.heap.newString(host)], file: ['Ljava/lang/String;', jvm.heap.newString(path)] })],
      }),
    );

  const rect = (x: number, y: number, w: number, h: number): JObject =>
    make('org/havi/ui/HScreenRectangle', { x: ['F', x], y: ['F', y], width: ['F', w], height: ['F', h] });

  const display = (config: JObject, image: JValue, r: JValue): Promise<void> =>
    run(CONFIG, 'displayImage(Lorg/havi/ui/HBackgroundImage;Lorg/havi/ui/HScreenRectangle;)V', [config, image, r]);

  beforeAll(async () => {
    const source = syntheticSource(files);
    jvm = new Jvm({
      bootJars: BOOT_JARS,
      nowMs: () => Date.now(),
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      stdout: () => {},
      stderr: () => {},
      vfs: new Vfs({ disc: source, discPaths: source.paths(), jdkLib: ZipArchive.open(RT), nowMs: () => 0 }),
    });
    const host = {
      log: (_file: string | null, _line: number, msg: string) => void logged.push(msg),
      displayImage: (image: Uint8Array | null, r: ScreenRect) => void shown.push({ image, rect: r }),
    };
    // a host without displayImage (RecordingHost) is the same object with the method hidden
    const view = new Proxy(host, { get: (t, key) => (key === 'displayImage' && !withDisplay ? undefined : Reflect.get(t, key)) });
    registerHaviNatives(jvm.natives, view as unknown as BdjHost);
    await jvm.boot();
  }, 60_000);

  beforeEach(() => {
    shown.length = 0;
    logged.length = 0;
    withDisplay = true;
  });

  it('replaces the Java method (libbluray leaves it unimplemented)', () => {
    expect(jvm.natives.replaced.has(DISPLAY_IMAGE)).toBe(true);
  });

  it("hands the host the still's file bytes and rectangle, and keeps both as libbluray does", async () => {
    const config = make(CONFIG);
    const image = fileImage(`/disc/${DISC_FILE}`);
    const r = rect(0.25, 0.5, 0.5, 0.25);
    await display(config, image, r);
    expect(shown).toEqual([{ image: files.get(DISC_FILE), rect: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } }]);
    expect(jvm.getField(config, 'image', 'Lorg/havi/ui/HBackgroundImage;')).toBe(image);
    expect(jvm.getField(config, 'rect', 'Lorg/havi/ui/HScreenRectangle;')).toBe(r);
    expect(logged).toEqual([]); // no "UNIMPLEMENTED"
  });

  it('the one-argument form shows the still over the whole screen', async () => {
    await run(CONFIG, 'displayImage(Lorg/havi/ui/HBackgroundImage;)V', [make(CONFIG), fileImage(`/disc/${DISC_FILE}`)]);
    expect(shown).toEqual([{ image: files.get(DISC_FILE), rect: { x: 0, y: 0, width: 1, height: 1 } }]);
  });

  it('a null rectangle is the whole screen', async () => {
    await display(make(CONFIG), fileImage(`/disc/${DISC_FILE}`), null);
    expect(shown[0]!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('a null image, or one with no image behind it, shows none', async () => {
    const config = make(CONFIG);
    await display(config, null, rect(0, 0, 1, 1));
    await display(config, make('org/havi/ui/HBackgroundImage'), rect(0, 0, 1, 1));
    expect(shown.map((s) => s.image)).toEqual([null, null]);
    expect(jvm.getField(config, 'image', 'Lorg/havi/ui/HBackgroundImage;')).not.toBeNull();
  });

  it('a file that cannot be read leaves the background as it is and is logged', async () => {
    await display(make(CONFIG), fileImage('/disc/BDMV/JAR/missing.jpg'), null);
    await display(make(CONFIG), fileImage('/disc/BDMV'), null);
    expect(shown).toEqual([]);
    expect(logged).toEqual(['displayImage(): /disc/BDMV/JAR/missing.jpg cannot be read', 'displayImage(): /disc/BDMV cannot be read']);
  });

  it("shows the bytes of HBackgroundImage(byte[]) (a ByteArrayImageSource's imagedata from imageoffset, imagelength long)", async () => {
    const bytes = new Uint8Array([9, 9, 0x89, 0x50, 0x4e, 0x47, 7]);
    await display(make(CONFIG), byteImage(bytes, 2, 4), null);
    expect(shown).toEqual([{ image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), rect: { x: 0, y: 0, width: 1, height: 1 } }]);
    await display(make(CONFIG), byteImage(bytes, 5, 4), null); // past the end: the background stays as it is
    expect(shown).toHaveLength(1);
    expect(logged).toEqual(['displayImage(): byte[7] at 5, 4 long cannot be read']);
  });

  it('shows the file of a file: URL (HBackgroundImage(URL)), escapes decoded', async () => {
    await display(make(CONFIG), urlImage('file', '', `/disc/${DISC_FILE.replace('index', 'ind%65x')}`), null);
    expect(shown).toEqual([{ image: files.get(DISC_FILE), rect: { x: 0, y: 0, width: 1, height: 1 } }]);
  });

  it("shows a jar entry of a jar: URL over a file: jar, as an xlet's getResource hands them out", async () => {
    const jar = 'BDMV/JAR/00000.jar';
    const entry = 'bdjweb/test/TitleXlet.class';
    await display(make(CONFIG), urlImage('jar', '', `file:/disc/${jar}!/${entry}`), null);
    expect(shown.map((s) => s.image)).toEqual([ZipArchive.open(files.get(jar)!).read(entry)]);
  });

  it('a URL that names no file, or a jar entry that is missing, leaves the background as it is and is logged', async () => {
    await display(make(CONFIG), urlImage('http', 'bdlive.example.invalid', '/bg.png'), null);
    await display(make(CONFIG), urlImage('jar', '', 'file:/disc/BDMV/JAR/00000.jar!/none.png'), null);
    await display(make(CONFIG), urlImage('file', '', '/disc/BDMV/JAR/missing.png'), null);
    expect(shown).toEqual([]);
    expect(logged).toEqual([
      'displayImage(): http://bdlive.example.invalid/bg.png names no file',
      'displayImage(): /disc/BDMV/JAR/00000.jar!/none.png cannot be read',
      'displayImage(): /disc/BDMV/JAR/missing.png cannot be read',
    ]);
  });

  it('an image from another kind of source is logged and not shown', async () => {
    const img = make('java/awt/BDImage');
    await display(make(CONFIG), make('org/havi/ui/HBackgroundImage', { img: ['Ljava/awt/Image;', img] }), null);
    expect(shown).toEqual([]);
    expect(logged).toEqual(['displayImage(): background images from java/awt/BDImage are not shown']);
  });

  it('without a host that shows stills it only keeps the image and rectangle', async () => {
    withDisplay = false;
    const config = make(CONFIG);
    const image = fileImage(`/disc/${DISC_FILE}`);
    await display(config, image, null);
    expect(shown).toEqual([]);
    expect(jvm.getField(config, 'image', 'Lorg/havi/ui/HBackgroundImage;')).toBe(image);
  });
});
