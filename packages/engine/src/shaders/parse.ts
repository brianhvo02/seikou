/*
 * Original code for bluray-web, 2026. Parses the mpv user shader format.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export interface ShaderPass {
  readonly file: string; // file name it came from
  readonly index: number; // pass number within the file, from 0
  readonly line: number; // 1-based line of its first //! directive
  readonly desc: string; // DESC, or `${file} #${index}`
  readonly hooks: readonly string[];
  readonly binds: readonly string[];
  readonly save: string | null; // null = the hooked texture
  readonly width: string | null; // raw RPN text; null = HOOKED.w
  readonly height: string | null;
  readonly when: string | null;
  readonly components: 1 | 2 | 3 | 4 | null;
  readonly body: string;
}

export class ShaderFileError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly reason: string,
  ) {
    super(`${file}:${line}: ${reason}`);
    this.name = 'ShaderFileError';
  }
}

/** Hooks the player fires. A pass hooking any other name never fires on its own (spec section 3.3). */
export const FIRING_HOOKS: readonly string[] = ['MAIN', 'MAINPRESUB', 'NATIVE', 'PREKERNEL'];

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_BINDS = 16;
const UNSUPPORTED = new Set(['COMPUTE', 'TEXTURE', 'PARAM', 'BUFFER', 'OFFSET']);

interface Draft {
  line: number;
  hooks: string[];
  binds: string[];
  save: string | null;
  width: string | null;
  height: string | null;
  when: string | null;
  components: 1 | 2 | 3 | 4 | null;
  desc: string | null;
  body: string[];
}

export function parseShaderFile(file: string, source: string): ShaderPass[] {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let inBody = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('//!')) {
      // Text before the first directive (license headers) belongs to no pass.
      if (cur && (inBody || trimmed !== '')) {
        cur.body.push(raw);
        if (trimmed !== '') inBody = true;
      }
      continue;
    }
    if (!cur || inBody) {
      cur = {
        line: lineNo,
        hooks: [],
        binds: [],
        save: null,
        width: null,
        height: null,
        when: null,
        components: null,
        desc: null,
        body: [],
      };
      drafts.push(cur);
      inBody = false;
    }
    const m = /^(\S+)\s*(.*)$/.exec(trimmed.slice(3).trim());
    const name = m?.[1] ?? '';
    const arg = (m?.[2] ?? '').replace(/\s+/g, ' ').trim();
    if (UNSUPPORTED.has(name)) throw new ShaderFileError(file, lineNo, `//!${name} is not supported`);
    if (name !== 'DESC' && arg === '' && ['HOOK', 'BIND', 'SAVE', 'WIDTH', 'HEIGHT', 'WHEN', 'COMPONENTS'].includes(name)) {
      throw new ShaderFileError(file, lineNo, `//!${name} needs a value`);
    }
    switch (name) {
      case 'HOOK':
        cur.hooks.push(arg);
        break;
      case 'BIND':
        cur.binds.push(arg);
        break;
      case 'SAVE':
        cur.save = arg;
        break;
      case 'WIDTH':
        cur.width = arg;
        break;
      case 'HEIGHT':
        cur.height = arg;
        break;
      case 'WHEN':
        cur.when = arg;
        break;
      case 'DESC':
        cur.desc = arg;
        break;
      case 'COMPONENTS': {
        const n = Number(arg);
        if (n !== 1 && n !== 2 && n !== 3 && n !== 4) {
          throw new ShaderFileError(file, lineNo, `//!COMPONENTS must be 1 to 4, got "${arg}"`);
        }
        cur.components = n;
        break;
      }
      default:
        throw new ShaderFileError(file, lineNo, `unknown directive //!${name}`);
    }
  }

  return drafts.map((d, index) => {
    if (d.hooks.length === 0) throw new ShaderFileError(file, d.line, 'pass has no //!HOOK');
    if (d.binds.length > MAX_BINDS) {
      throw new ShaderFileError(file, d.line, `pass has ${d.binds.length} //!BIND lines, the limit is ${MAX_BINDS}`);
    }
    return {
      file,
      index,
      line: d.line,
      desc: d.desc !== null && d.desc !== '' ? d.desc : `${file} #${index}`,
      hooks: d.hooks,
      binds: d.binds,
      save: d.save,
      width: d.width,
      height: d.height,
      when: d.when,
      components: d.components,
      body: d.body.join('\n').trim() + '\n',
    };
  });
}

/** Null when the file can be added; else the reason shown to the user. */
export function validateShaderFile(file: string, source: string, bytes: number): string | null {
  if (bytes > MAX_BYTES) return 'file is larger than 4 MiB';
  let passes: ShaderPass[];
  try {
    passes = parseShaderFile(file, source);
  } catch (e) {
    if (e instanceof ShaderFileError) return `line ${e.line}: ${e.reason}`;
    throw e;
  }
  if (passes.length === 0) return 'no //!HOOK passes found, this is not an mpv user shader';
  if (!passes.some((p) => p.hooks.some((h) => FIRING_HOOKS.includes(h)))) {
    const names = [...new Set(passes.flatMap((p) => p.hooks))];
    return `this shader hooks only ${names.join(', ')}, which this player doesn't provide`;
  }
  return null;
}
