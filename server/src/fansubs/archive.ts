/** Anime Tosho's xz tracks and 7z font packs, unpacked with 7-Zip's WASM build (no native code). Original code. */
import { readFile } from 'node:fs/promises';
import SevenZip from '7z-wasm/7zz.es6.js';
import type { SevenZipModule } from '7z-wasm';

export class TooLargeArchive extends Error {
  constructor(what: string) {
    super(`archive too large: ${what}`);
    this.name = 'TooLargeArchive';
  }
}

// No WOFF2: the ASS renderer can't read it.
const FONT_NAME = /\.(ttf|otf|ttc|woff)$/i;
const MAX_FONT_ENTRIES = 200;
const MAX_FONT_BYTES = 200 * 1024 * 1024;
/** Everything in a pack is extracted before filtering, so the whole archive is bounded too (a test lowers these). */
export const PACK_LIMITS = { entries: 2000, bytes: 512 * 1024 * 1024 };
/**
 * The WASM heap grows to the largest job and never shrinks, so after a job whose input or output passed `recycleBytes`
 * the module is dropped and the next job loads a fresh one (`loads` counts them, for the tests).
 */
export const ARCHIVE_MODULE = { recycleBytes: 32 * 1024 * 1024, loads: 0 };

/** The WASM sits next to the bundle (`dist/7zz.wasm`); unbundled (tests, tsx) it is in node_modules. */
async function loadWasm(): Promise<Buffer> {
  for (const url of [new URL('./7zz.wasm', import.meta.url), new URL('../../../node_modules/7z-wasm/7zz.wasm', import.meta.url)]) {
    try {
      return await readFile(url);
    } catch {
      // try the next place
    }
  }
  throw new Error('7zz.wasm not found');
}

interface Instance {
  readonly sz: SevenZipModule;
  /** What 7-Zip printed since the last `run` (Latin-1 decoded; entry names are not needed in full). `sink` takes stdout's bytes instead. */
  text: string;
  sink: ((byte: number | null) => void) | null;
  /** The largest input or output of the running job. */
  peak: number;
}

let instance: Promise<Instance> | null = null;
let chain: Promise<unknown> = Promise.resolve();

function getInstance(): Promise<Instance> {
  instance ??= (async () => {
    const wasm = await loadWasm();
    ARCHIVE_MODULE.loads++;
    const inst: Instance = { sz: undefined as unknown as SevenZipModule, text: '', sink: null, peak: 0 };
    const sz = await SevenZip({
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
      printErr: (s: string) => { inst.text += `${s}\n`; },
      // Giving `stdout` a callback routes everything 7-Zip prints through it, as raw bytes.
      stdout: (c: number | null) => {
        if (inst.sink) inst.sink(c);
        else if (c !== null) inst.text += String.fromCharCode(c & 0xff);
      },
    });
    (inst as { sz: SevenZipModule }).sz = sz;
    return inst;
  })();
  instance.catch(() => { instance = null; });
  return instance;
}

/** One module instance, one call at a time: its file system is shared. A job past the recycle size drops the instance. */
function serialized<T>(job: (inst: Instance) => Promise<T> | T): Promise<T> {
  const next = chain.then(async () => {
    const inst = await getInstance();
    inst.peak = 0;
    try {
      return await job(inst);
    } finally {
      if (inst.peak > ARCHIVE_MODULE.recycleBytes) instance = null;
    }
  });
  chain = next.catch(() => undefined);
  return next;
}

function run(inst: Instance, args: string[]): void {
  inst.text = '';
  let code: unknown;
  try {
    code = inst.sz.callMain(args);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 0) return;
    throw new Error(`7-Zip failed: ${inst.text.trim().split('\n').slice(-3).join(' ') || String(e)}`);
  }
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`7-Zip failed (${code}): ${inst.text.trim().split('\n').slice(-3).join(' ')}`);
  }
}

function removeTree(fs: SevenZipModule['FS'], path: string): void {
  let entries: string[];
  try {
    entries = fs.readdir(path).filter((n) => n !== '.' && n !== '..');
  } catch {
    try { fs.unlink(path); } catch { /* already gone */ }
    return;
  }
  for (const n of entries) removeTree(fs, `${path}/${n}`);
  try { fs.rmdir(path); } catch { /* not a directory or gone */ }
}

/** Decompresses an .xz stream. Bytes past `maxBytes` are dropped as they arrive and the call throws TooLargeArchive. */
export function unxz(data: Buffer, maxBytes: number): Promise<Buffer> {
  return serialized((inst) => {
    const { FS } = inst.sz;
    // Grows as output arrives, never past maxBytes; the sink throws at the cap to abort 7-Zip.
    let out = Buffer.alloc(Math.min(maxBytes, 64 * 1024));
    let length = 0;
    inst.sink = (c) => {
      if (c === null) return;
      if (length >= maxBytes) throw new TooLargeArchive(`more than ${maxBytes} bytes`);
      if (length === out.length) {
        const bigger = Buffer.alloc(Math.min(maxBytes, out.length * 2));
        out.copy(bigger);
        out = bigger;
      }
      out[length++] = c & 0xff;
    };
    inst.peak = data.length;
    try {
      FS.writeFile('in.xz', data);
      run(inst, ['e', '-so', '-bd', '-y', 'in.xz']);
    } catch (e) {
      if (e instanceof TooLargeArchive || length >= maxBytes) throw new TooLargeArchive(`more than ${maxBytes} bytes`);
      throw e;
    } finally {
      inst.sink = null;
      inst.peak = Math.max(inst.peak, length);
      removeTree(FS, 'in.xz');
    }
    return out.subarray(0, length);
  });
}

/** The font files in a 7z pack (base names only), at most 200 entries and 200 MB. */
export function fontsIn7z(data: Buffer): Promise<{ name: string; data: Buffer }[]> {
  return serialized((inst) => {
    const { FS } = inst.sz;
    inst.peak = data.length;
    try {
      FS.writeFile('in.7z', data);
      // List first, so a bomb is refused before anything is written to the in-memory file system.
      run(inst, ['l', '-slt', '-ba', 'in.7z']);
      let count = 0;
      let entries = 0;
      let allBytes = 0;
      let total = 0;
      // The progress line is overwritten with backspaces and shares a line with the first entry.
      const listing = inst.text.replace(/^.*\x08/gm, '');
      for (const block of listing.split(/\n\n+/)) {
        const path = /^Path = (.*)$/m.exec(block)?.[1];
        if (path === undefined) continue;
        const size = Number(/^Size = (\d+)$/m.exec(block)?.[1] ?? 0);
        if (++entries > PACK_LIMITS.entries) throw new TooLargeArchive(`more than ${PACK_LIMITS.entries} entries`);
        if ((allBytes += size) > PACK_LIMITS.bytes) throw new TooLargeArchive(`over ${PACK_LIMITS.bytes} bytes in all`);
        if (/^Folder = \+/m.test(block) || !FONT_NAME.test(path)) continue;
        count++;
        total += size;
        if (count > MAX_FONT_ENTRIES) throw new TooLargeArchive(`more than ${MAX_FONT_ENTRIES} fonts`);
        if (total > MAX_FONT_BYTES) throw new TooLargeArchive(`fonts over ${MAX_FONT_BYTES} bytes`);
      }
      if (count === 0) return [];
      inst.peak = Math.max(inst.peak, allBytes);
      // Everything is extracted and filtered in the walk: 7-Zip's wildcards are case-sensitive here (A.TTF, b.Otf).
      run(inst, ['x', '-bd', '-y', '-oout', 'in.7z']);
      const fonts: { name: string; data: Buffer }[] = [];
      const walk = (dir: string): void => {
        for (const n of FS.readdir(dir)) {
          if (n === '.' || n === '..') continue;
          const p = `${dir}/${n}`;
          if (FS.isDir(FS.stat(p).mode)) walk(p);
          else if (FONT_NAME.test(n)) fonts.push({ name: n, data: Buffer.from(FS.readFile(p)) });
        }
      };
      walk('out');
      return fonts;
    } finally {
      removeTree(FS, 'in.7z');
      removeTree(FS, 'out');
    }
  });
}
