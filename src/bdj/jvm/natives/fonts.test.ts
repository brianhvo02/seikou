/// <reference types="node" />
/**
 * The BD-J font and text natives against libbluray's own (tests/bdj/fonts/text-golden.json, made by
 * tools/bdj-trace/text-golden.sh from the harness image's compiled java_awt_BDFontMetrics.c and java_awt_BDGraphics.c
 * on its system FreeType): the fallback font through a JRE font path, and a font a disc ships, read from the disc.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { syntheticSource } from '../../../../tests/helpers/synthetic-disc';
import { testBdjFonts } from '../../../../tests/helpers/bdj-fonts';
import type { BdjHost } from '../../host';
import type { FreeType } from '../../fonts/freetype';
import { DEFAULT_FONT_PATH, DEFAULT_FONT_SIZE, JRE_FONT_FILES, systemFontFiles } from '../../fonts/system-fonts';
import { Invoke } from '../interpreter';
import type { NativeResult } from '../interpreter';
import { Jvm } from '../jvm';
import type { JMethod } from '../loader';
import type { JArray, JObject, JValue } from '../values';
import { Vfs } from '../vfs';
import { ZipArchive } from '../zip';
import { NativeTable } from './index';
import type { NativeContext } from './index';
import { registerLibblurayNatives } from './libbluray';

const file = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const RT = file('../../../bdj-classlib/rt-bdj.jar');
const BOOT_JARS = [file('../../../bdj-classlib/libbluray-j2se.jar'), file('../../../bdj-classlib/libbluray-awt-j2se.jar'), RT];

interface GoldenDraw {
  text: number[];
  x: number;
  y: number;
  rgb: number;
  calls: number;
  callsHash: string;
  bufferHash: string;
  callList?: string;
}

interface GoldenSize {
  size: number;
  metrics: { ascent: number; descent: number; leading: number; maxAdvance: number };
  charWidths: number[];
  extraCharWidths: { code: number; width: number }[];
  stringWidths: { text: number[]; width: number }[];
  charsWidths: { offset: number; length: number; width: number; exception: boolean }[];
  draws: GoldenDraw[];
}

interface Golden {
  buffer: { width: number; height: number };
  missing: { familyAndStyle: null; loadFont: number };
  notAFont: { familyAndStyle: null; loadFont: number };
  fonts: { name: 'fallback' | 'disc'; familyAndStyle: [string, string]; sizes: GoldenSize[] }[];
}

const golden = JSON.parse(new TextDecoder().decode(file('../../../../tests/bdj/fonts/text-golden.json'))) as Golden;
const { width: W, height: H } = golden.buffer;

/** Where each golden font is in the Vfs: the harness's JRE path (linked to the fallback font), and an AUXDATA font. */
const PATHS = { fallback: `/jdk/lib/fonts/${JRE_FONT_FILES[4]}`, disc: '/disc/BDMV/AUXDATA/00001.otf' } as const;
const MISSING = '/disc/BDMV/AUXDATA/missing.otf';
const NOT_A_FONT = '/disc/BDMV/index.bdmv';
/** text_golden.c's "xxPLAYxx" for charsWidthN. */
const CHARS = 'xxPLAYxx';

const utf16 = (units: readonly number[]): string => String.fromCharCode(...units);

/** text_golden.c's background: four bands of colour across the buffer. */
function background(x: number): number {
  if (x < W / 4) return 0;
  if (x < W / 2) return 0xff203040 | 0;
  if (x < (W * 3) / 4) return 0x80ff0000 | 0;
  return 0x40ffffff;
}

/** FNV-1a 32 over the words' little-endian bytes (tools/bdj-trace/README.md, Planes). */
function fnv(words: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) for (let b = 0; b < 32; b += 8) h = Math.imul(h ^ ((words[i]! >>> b) & 0xff), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Runs `cls.key` with `args` on a new Java thread (initialising `cls` first); the uncaught exception's class, or null. */
async function runIn(jvm: Jvm, cls: string, key: string, args: readonly JValue[]): Promise<{ ret: JValue | undefined; thrown: string | null }> {
  const c = jvm.bootClass(cls);
  let m: JMethod | undefined;
  for (let k: typeof c | null = c; k && !m; k = k.superClass) m = k.methods.get(key);
  if (!m) throw new Error(`${cls}.${key} is missing`);
  const method = m;
  const t = jvm.threads.spawnWith(jvm.mainThread, (t) =>
    jvm.withInit(t, c, () =>
      new Invoke(method, args, (ret) => {
        t.result = ret;
        return undefined;
      }),
    ),
  );
  const ended = new AbortController();
  t.onTerminate = () => ended.abort();
  let outcome = t.state === 'terminated' ? 'idle' : await jvm.threads.run(ended.signal);
  while (outcome === 'idle' && t.state !== 'terminated' && jvm.threads.timersPending) {
    await jvm.threads.nextTimer();
    outcome = await jvm.threads.run(ended.signal);
  }
  t.onTerminate = null;
  if (t.state !== 'terminated') throw new Error(`${cls}.${key} did not finish (${outcome})`);
  if (!t.uncaught) return { ret: t.result, thrown: null };
  return { ret: undefined, thrown: t.uncaught.cls.name };
}

/**
 * A JVM on disc-bdj (with a disc font at PATHS.disc), the libbluray natives over `fonts.loadFreeType`, and the JRE font
 * files over `fonts.loadDefaultFont`; libbluray's and the natives' log lines go to `logged`.
 */
async function bootFontJvm(fonts: { loadFreeType(): Promise<FreeType>; loadDefaultFont(): Promise<Uint8Array> }, logged: string[]): Promise<Jvm> {
  const files = fixtureDiscFiles('disc-bdj');
  files.set('BDMV/AUXDATA/00001.otf', new Uint8Array(readFileSync(fileURLToPath(new URL('../../../../fixtures/ass/fonts/DejaVuSerif.ttf', import.meta.url)))));
  const source = syntheticSource(files);
  const jvm = new Jvm({
    bootJars: BOOT_JARS,
    nowMs: () => Date.now(),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    stdout: () => {},
    stderr: () => {},
    vfs: new Vfs({
      disc: source,
      discPaths: source.paths(),
      jdkLib: ZipArchive.open(RT),
      nowMs: () => 0,
      jdkLazy: systemFontFiles(() => fonts.loadDefaultFont()),
    }),
    systemProperties: new Map([
      ['awt.toolkit', 'java.awt.BDToolkit'],
      ['java.awt.graphicsenv', 'java.awt.BDGraphicsEnvironment'],
      ['java.awt.headless', 'false'],
    ]),
  });
  const host = { log: (_file: string | null, _line: number, msg: string) => void logged.push(msg) } as unknown as BdjHost;
  registerLibblurayNatives(jvm.natives, host, {
    loadFreeType: () => fonts.loadFreeType(),
    fallbackFontPath: DEFAULT_FONT_PATH,
    log: (line) => void logged.push(line),
  });
  await jvm.boot();
  return jvm;
}

describe('BD-J font and text natives against libbluray', () => {
  let jvm: Jvm;
  let freeTypeLoads = 0;
  let fontLoads = 0;
  const logged: string[] = [];

  const str = (s: string): JObject => jvm.heap.newString(s);
  const jstr = (v: JValue | undefined): string | null => jvm.heap.jsString((v ?? null) as JObject | null);
  const native = (key: string) => jvm.natives.get(key)!;
  const ctx = (): NativeContext => ({ jvm, thread: null, method: null }) as unknown as NativeContext;
  const run = (cls: string, key: string, args: readonly JValue[]): Promise<{ ret: JValue | undefined; thrown: string | null }> => runIn(jvm, cls, key, args);

  async function ok(cls: string, key: string, args: readonly JValue[]): Promise<JValue | undefined> {
    const r = await run(cls, key, args);
    if (r.thrown) throw new Error(`${cls}.${key} threw ${r.thrown}`);
    return r.ret;
  }

  async function construct(cls: string, desc: string, args: readonly JValue[]): Promise<JObject> {
    const o = jvm.heap.newObject(jvm.bootClass(cls));
    await ok(cls, `<init>${desc}`, [o, ...args]);
    return o;
  }

  const newMetrics = (): JObject => jvm.heap.newObject(jvm.bootClass('java/awt/BDFontMetrics'));

  async function loadFont(metrics: JObject, path: string, size: number): Promise<bigint> {
    return (await ok('java/awt/BDFontMetrics', 'loadFontN(JLjava/lang/String;I)J', [metrics, 1n, str(path), size])) as bigint;
  }

  async function familyAndStyle(path: string): Promise<(string | null)[] | null> {
    const r = (await ok('java/awt/BDFontMetrics', 'getFontFamilyAndStyleN(JLjava/lang/String;)[Ljava/lang/String;', [1n, str(path)])) as JArray | null;
    return r === null ? null : (r.data as JValue[]).map((v) => jstr(v));
  }

  beforeAll(async () => {
    jvm = await bootFontJvm(
      {
        loadFreeType: () => {
          freeTypeLoads++;
          return testBdjFonts.loadFreeType();
        },
        loadDefaultFont: () => {
          fontLoads++;
          return testBdjFonts.loadDefaultFont();
        },
      },
      logged,
    );
  }, 60_000);

  it('initN does not load FreeType; the first font does, once', async () => {
    expect(await ok('java/awt/BDFontMetrics', 'initN()J', [])).not.toBe(0n);
    expect(freeTypeLoads).toBe(0);
    expect(fontLoads).toBe(0);
    const face = await loadFont(newMetrics(), PATHS.fallback, 24);
    expect(face).not.toBe(0n);
    await loadFont(newMetrics(), PATHS.disc, 24);
    expect(freeTypeLoads).toBe(1);
    expect(fontLoads).toBe(1);
  });

  it('getFontFamilyAndStyleN and loadFontN: both fonts, a missing file and a file that is not a font', async () => {
    for (const f of golden.fonts) expect(await familyAndStyle(PATHS[f.name])).toEqual(f.familyAndStyle);
    expect(await familyAndStyle(MISSING)).toBe(golden.missing.familyAndStyle);
    expect(await familyAndStyle(NOT_A_FONT)).toBe(golden.notAFont.familyAndStyle);
    expect(await loadFont(newMetrics(), MISSING, 24)).toBe(BigInt(golden.missing.loadFont));
    expect(await loadFont(newMetrics(), NOT_A_FONT, 24)).toBe(BigInt(golden.notAFont.loadFont));
  });

  it('resolveFontN resolves any family to the fallback font, which loads like the JRE font files', async () => {
    const resolve = 'resolveFontN(Ljava/lang/String;I)Ljava/lang/String;';
    expect(jstr(await ok('java/awt/BDFontMetrics', resolve, [str('Arial'), 0]))).toBe(DEFAULT_FONT_PATH);
    expect(jstr(await ok('java/awt/BDFontMetrics', resolve, [str('No Such Family'), 3]))).toBe(DEFAULT_FONT_PATH);
    const m = newMetrics();
    await loadFont(m, DEFAULT_FONT_PATH, 24);
    const want = golden.fonts.find((f) => f.name === 'fallback')!.sizes.find((s) => s.size === 24)!.metrics;
    expect({
      ascent: jvm.getField(m, 'ascent', 'I'),
      descent: jvm.getField(m, 'descent', 'I'),
      leading: jvm.getField(m, 'leading', 'I'),
      maxAdvance: jvm.getField(m, 'maxAdvance', 'I'),
    }).toEqual(want);
  });

  for (const font of golden.fonts) {
    for (const size of font.sizes) {
      it(`${font.name} font at ${size.size} px: metrics, widths and drawPoint calls equal libbluray's`, async () => {
        const m = newMetrics();
        const face = await loadFont(m, PATHS[font.name], size.size);
        expect({
          ascent: jvm.getField(m, 'ascent', 'I'),
          descent: jvm.getField(m, 'descent', 'I'),
          leading: jvm.getField(m, 'leading', 'I'),
          maxAdvance: jvm.getField(m, 'maxAdvance', 'I'),
        }).toEqual(size.metrics);

        const charWidth = native('java/awt/BDFontMetrics.charWidthN(JC)I');
        expect(Array.from({ length: 256 }, (_, c) => charWidth(ctx(), m, face, c))).toEqual(size.charWidths);
        expect(size.extraCharWidths.map((e) => ({ code: e.code, width: charWidth(ctx(), m, face, e.code) }))).toEqual(size.extraCharWidths);

        const stringWidth = native('java/awt/BDFontMetrics.stringWidthN(JLjava/lang/String;)I');
        expect(size.stringWidths.map((s) => ({ text: s.text, width: stringWidth(ctx(), m, face, str(utf16(s.text))) }))).toEqual(size.stringWidths);

        const chars = jvm.heap.newArray(jvm.loader.arrayOf(jvm.loader.primitive('C')), CHARS.length);
        for (let i = 0; i < CHARS.length; i++) (chars.data as Uint16Array)[i] = CHARS.charCodeAt(i);
        const got = [];
        for (const c of size.charsWidths) {
          const r = await run('java/awt/BDFontMetrics', 'charsWidthN(J[CII)I', [m, face, chars, c.offset, c.length]);
          got.push({ offset: c.offset, length: c.length, width: r.ret ?? 0, exception: r.thrown === 'java/lang/ArrayIndexOutOfBoundsException' });
        }
        expect(got).toEqual(size.charsWidths);

        // drawStringN's CallVoidMethod(drawPoint) calls, in order
        const drawString = native('java/awt/BDGraphicsBase.drawStringN(JLjava/lang/String;III)V');
        const graphics = jvm.heap.newObject(jvm.bootClass('java/awt/BDGraphics'));
        for (const d of size.draws) {
          const calls: number[] = [];
          let r: NativeResult = drawString(ctx(), graphics, face, str(utf16(d.text)), d.x, d.y, d.rgb);
          while (r instanceof Invoke) {
            expect(r.method.cls.name).toBe('java/awt/BDGraphicsBase');
            expect(r.method.name + r.method.desc).toBe('drawPoint(III)V');
            expect(r.args[0]).toBe(graphics);
            calls.push(r.args[1] as number, r.args[2] as number, r.args[3] as number);
            r = r.then(undefined);
          }
          expect(r).toBeUndefined();
          if (d.callList) expect(Buffer.from(new Int32Array(calls).buffer).toString('base64')).toBe(d.callList);
          expect({ calls: calls.length / 3, callsHash: fnv(calls) }).toEqual({ calls: d.calls, callsHash: d.callsHash });
        }
        await ok('java/awt/BDFontMetrics', 'destroyFontN(J)V', [m, face]);
        expect(stringWidth(ctx(), m, face, str('PLAY'))).toBe(0);
      });
    }
  }

  it('drawString through libbluray\'s Java leaves the back buffer libbluray leaves', { timeout: 120_000 }, async () => {
    await ok('java/awt/BDFontMetrics', 'init()V', []);
    for (const font of golden.fonts) {
      let base: JObject;
      if (font.name === 'fallback') base = await construct('java/awt/Font', '(Ljava/lang/String;II)V', [str('SansSerif'), 0, 1]);
      else {
        const f = await construct('java/io/File', '(Ljava/lang/String;)V', [str(PATHS.disc)]);
        base = (await ok('java/awt/Font', 'createFont(ILjava/io/File;)Ljava/awt/Font;', [0, f])) as JObject;
      }
      for (const size of font.sizes) {
        const style = jvm.getField(base, 'style', 'I');
        const derived = (await ok('java/awt/Font', 'deriveFont(II)Ljava/awt/Font;', [base, style, size.size])) as JObject;
        for (const d of size.draws) {
          const buffer = jvm.heap.newArray(jvm.loader.arrayOf(jvm.loader.primitive('I')), W * H);
          const data = buffer.data as Int32Array;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = background(x);
          const g = jvm.heap.newObject(jvm.bootClass('java/awt/BDGraphics'));
          jvm.setField(g, 'width', 'I', W);
          jvm.setField(g, 'height', 'I', H);
          jvm.setField(g, 'backBuffer', '[I', buffer);
          jvm.setField(g, 'dirty', 'Ljava/awt/Area;', await construct('java/awt/Area', '(II)V', [W, H]));
          jvm.setField(g, 'font', 'Ljava/awt/Font;', derived);
          await ok('java/awt/BDGraphics', 'postInit()V', [g]);
          await ok('java/awt/BDGraphics', 'setColor(Ljava/awt/Color;)V', [g, await construct('java/awt/Color', '(IZ)V', [d.rgb, 1])]);
          await ok('java/awt/BDGraphics', 'drawString(Ljava/lang/String;II)V', [g, str(utf16(d.text)), d.x, d.y]);
          expect(`${font.name} ${size.size} ${utf16(d.text)}: ${fnv(data)}`).toBe(`${font.name} ${size.size} ${utf16(d.text)}: ${d.bufferHash}`);
        }
        const metrics = (await ok('java/awt/BDGraphics', 'getFontMetrics(Ljava/awt/Font;)Ljava/awt/FontMetrics;', [jvm.heap.newObject(jvm.bootClass('java/awt/BDGraphics')), derived])) as JObject;
        for (const s of size.stringWidths) {
          expect(await ok('java/awt/BDFontMetrics', 'stringWidth(Ljava/lang/String;)I', [metrics, str(utf16(s.text))])).toBe(s.width);
        }
        expect(await ok('java/awt/BDFontMetrics', 'getAscent()I', [metrics])).toBe(size.metrics.ascent);
        // a component's metrics are the same BDFontMetrics (libbluray's FontDesignMetrics), with no platform font manager
        const component = jvm.heap.newObject(jvm.bootClass('java/awt/Container'));
        expect(await ok('java/awt/Component', 'getFontMetrics(Ljava/awt/Font;)Ljava/awt/FontMetrics;', [component, derived])).toBe(metrics);
      }
    }
    expect(logged.filter((l) => /Can't resolve font/.test(l))).toEqual([]);
  });
});

describe('BD-J fonts when FreeType cannot be loaded', () => {
  it('the first font throws AWTError after one wait; later fonts fail at once, without loading again', async () => {
    const logged: string[] = [];
    let loads = 0;
    let waits = 0;
    const jvm = await bootFontJvm(
      {
        // a fetch that times out: the rejection comes later, so a second load would be a second wait
        loadFreeType: () => {
          loads++;
          return new Promise<FreeType>((_resolve, reject) => {
            setTimeout(() => {
              waits++;
              reject(new Error('freetype.wasm: The operation timed out.'));
            }, 200);
          });
        },
        loadDefaultFont: () => testBdjFonts.loadDefaultFont(),
      },
      logged,
    );
    const run = (cls: string, key: string, args: readonly JValue[]): Promise<{ ret: JValue | undefined; thrown: string | null }> => runIn(jvm, cls, key, args);
    const font = async (size: number): Promise<JObject> => {
      const f = jvm.heap.newObject(jvm.bootClass('java/awt/Font'));
      expect((await run('java/awt/Font', '<init>(Ljava/lang/String;II)V', [f, jvm.heap.newString('SansSerif'), 0, size])).thrown).toBeNull();
      return f;
    };
    const metrics = 'getFontMetrics(Ljava/awt/Font;)Ljava/awt/BDFontMetrics;';
    expect((await run('java/awt/BDFontMetrics', 'init()V', [])).thrown).toBeNull();
    expect((await run('java/awt/BDFontMetrics', metrics, [await font(24)])).thrown).toBe('java/awt/AWTError');
    expect({ loads, waits }).toEqual({ loads: 1, waits: 1 });
    const later = [await font(30), await font(36)];
    for (const f of later) expect((await run('java/awt/BDFontMetrics', metrics, [f])).thrown).toBe('java/awt/AWTError');
    expect({ loads, waits }).toEqual({ loads: 1, waits: 1 }); // no second load, so no second wait
    expect(logged.filter((l) => /FreeType could not be loaded/.test(l))).toEqual(['BD-J: FreeType could not be loaded: freetype.wasm: The operation timed out.']);
  }, 60_000);
});

describe('BD-J font natives without FreeType', () => {
  it('behave as libbluray built without FreeType or fontconfig', () => {
    const table = new NativeTable();
    const lines: string[] = [];
    registerLibblurayNatives(table, {} as BdjHost, { log: (l) => void lines.push(l) });
    const ctx = {} as NativeContext;
    expect(table.get('java/awt/BDFontMetrics.initN()J')!(ctx)).toBe(0n);
    expect(table.get('java/awt/BDFontMetrics.resolveFontN(Ljava/lang/String;I)Ljava/lang/String;')!(ctx, null, 0)).toBeNull();
    expect(table.get('java/awt/BDFontMetrics.loadFontN(JLjava/lang/String;I)J')!(ctx, null, 1n, null, 24)).toBe(0n);
    expect(table.get('java/awt/BDFontMetrics.charWidthN(JC)I')!(ctx, null, 5n, 65)).toBe(0);
    expect(table.get('java/awt/BDGraphicsBase.drawStringN(JLjava/lang/String;III)V')!(ctx, null, 5n, null, 0, 0, 0)).toBeUndefined();
    expect(lines).toEqual(['BD-J font support not compiled in', 'BD-J font config support not compiled in']);
  });
});

describe('system fonts', () => {
  it('DEFAULT_FONT_SIZE is the size of packages/ass/src/default-font.ttf', () => {
    expect(file('../../../../packages/ass/src/default-font.ttf').length).toBe(DEFAULT_FONT_SIZE);
  });

  it('remembers a failed fetch: later reads fail at once with the same error', async () => {
    let loads = 0;
    const files = systemFontFiles(() => {
      loads++;
      return Promise.reject(new Error('default-font.ttf: HTTP 503'));
    });
    for (const f of files.values()) await expect(f.load()).rejects.toThrow('HTTP 503');
    expect(loads).toBe(1);
  });

  it('maps the twelve JRE font files and the fallback path to one fetch of the font', async () => {
    let loads = 0;
    const files = systemFontFiles(() => {
      loads++;
      return Promise.resolve(new Uint8Array(DEFAULT_FONT_SIZE));
    });
    expect([...files.keys()]).toEqual([...JRE_FONT_FILES.map((f) => `lib/fonts/${f}`), 'lib/fonts/default-font.ttf']);
    await Promise.all([...files.values()].map((f) => f.load()));
    expect(loads).toBe(1);
  });
});
