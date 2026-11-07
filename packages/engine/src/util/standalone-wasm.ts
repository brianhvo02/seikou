/*
 * Original code for bluray-web: instantiates the standalone (WASI-flavoured) emscripten modules in src/wasm/
 * (audio.wasm, freetype.wasm) without emscripten's JS glue.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

const ENOSYS = 52;

/** Streams the compile; a wrong Content-Type makes that reject with a TypeError, so retry from the buffered body. */
async function compileResponse(response: Response): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(response.clone());
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

/**
 * Compiles and instantiates a module and runs its `_initialize`. The C code never does I/O, so WASI calls fail with
 * ENOSYS, other imported functions return 0 and exits throw `${what} aborted`.
 */
export async function instantiateStandaloneWasm<T>(
  source: BufferSource | Promise<Response>,
  name: string,
  what: string,
): Promise<T> {
  const module = source instanceof Promise ? await compileResponse(await source) : await WebAssembly.compile(source);
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') throw new Error(`${name} needs an unexpected ${imp.kind} import ${imp.module}.${imp.name}`);
    const exits = imp.name === 'proc_exit' || imp.name === 'abort';
    const value = imp.module === 'wasi_snapshot_preview1' ? ENOSYS : 0;
    (imports[imp.module] ??= {})[imp.name] = exits
      ? (code: number): never => {
          throw new Error(`${what} aborted (${code})`);
        }
      : (): number => value;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const exports = instance.exports as unknown as T & { _initialize?: () => void };
  exports._initialize?.();
  return exports;
}
