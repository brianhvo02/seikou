import hqConf from './anime4k/input-hq.conf?raw';
import fastConf from './anime4k/input-fast.conf?raw';

/** A named list of shader files applied together, in order. */
export interface ShaderSetDef {
  readonly name: string;
  /** File base names, in the order they run. */
  readonly files: readonly string[];
  /** Where the set came from: the built-in Anime4K sets or an imported `input.conf`. */
  readonly origin: 'anime4k' | 'imported';
}

/** A set as the menu lists it, with the files it lacks and whether it can be applied. */
export interface SetEntry extends ShaderSetDef {
  readonly missing: readonly string[];
  readonly available: boolean;
}

const SET_RE = /glsl-shaders\s+set\s+"([^"]*)"/;
const SHOW_TEXT_RE = /show-text\s+"([^"]*)"/;

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** `;` separates when present, else `:`; a colon after a lone drive letter before `/` or `\\` stays in the path. */
function splitList(list: string): string[] {
  if (list.includes(';')) return list.split(';');
  const parts = list.split(':');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const next = parts[i + 1];
    if (/^[A-Za-z]$/.test(parts[i]!) && next !== undefined && /^[/\\]/.test(next)) {
      out.push(`${parts[i]}:${next}`);
      i++;
    } else out.push(parts[i]!);
  }
  return out;
}

// Only double-quoted lists are recognized.
/** Reads the `glsl-shaders set` lines of an mpv input.conf (`:` or `;` separated lists). */
export function parseInputConf(text: string): ShaderSetDef[] {
  const sets: ShaderSetDef[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = SET_RE.exec(line);
    if (!m) continue;
    const files = splitList(m[1]!)
      .map((f) => baseName(f.trim()))
      .filter((f) => f !== '');
    if (files.length === 0) continue;
    const name = SHOW_TEXT_RE.exec(line)?.[1] ?? line.split(/\s+/)[0]!;
    sets.push({ name, files, origin: 'imported' });
  }
  return sets;
}

/** The built-in Anime4K sets, parsed from the bundled `input.conf` files (the high-quality and the fast modes). */
export const BUILT_IN_SETS: readonly ShaderSetDef[] = [
  ...parseInputConf(hqConf),
  ...parseInputConf(fastConf),
].map((s) => ({ ...s, origin: 'anime4k' as const }));

function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/** An imported set named like a built-in with a different list is renamed `<name> (imported)` so names stay unique. */
export function importedName(def: ShaderSetDef): ShaderSetDef {
  const clash = BUILT_IN_SETS.some((b) => b.name === def.name && !sameFiles(b.files, def.files));
  return clash ? { ...def, name: `${def.name} (imported)` } : def;
}

function entry(def: ShaderSetDef, library: ReadonlySet<string>): SetEntry {
  const missing = def.files.filter((f) => !library.has(f));
  return { ...def, missing, available: missing.length === 0 };
}

/**
 * Built-ins appear once any of their files is in the library; imported sets always, unless equal to a built-in's list.
 * Available sets come first, then unavailable ones; each group keeps built-ins (template order) before imported ones (import order).
 */
export function resolveSets(imported: readonly ShaderSetDef[], library: ReadonlySet<string>): SetEntry[] {
  const out: SetEntry[] = [];
  for (const def of BUILT_IN_SETS) {
    if (def.files.some((f) => library.has(f))) out.push(entry(def, library));
  }
  for (const def of imported) {
    if (BUILT_IN_SETS.some((b) => sameFiles(b.files, def.files))) continue;
    out.push(entry(def, library));
  }
  return [...out.filter((e) => e.available), ...out.filter((e) => !e.available)];
}

/** The menu's note for a set with missing files: the first name and how many more. */
export function missingLabel(missing: readonly string[]): string {
  const more = missing.length - 1;
  return `missing: ${missing[0]}${more > 0 ? ` +${more} more` : ''}`;
}
