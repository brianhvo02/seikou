// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// TypeScript 7 exposes no compiler API, so the checker parses with rolldown's parser (oxc).
// rolldown arrives transitively with vite; it is not a declared dependency of this repository.
// It is imported dynamically so that a missing module fails with a message that says so.
type ParseSync = typeof import('rolldown/utils').parseSync;
const parseSync: ParseSync = await import('rolldown/utils').then(
  (m) => m.parseSync,
  (cause: unknown) => {
    throw new Error('doc-check needs rolldown, which comes with vite (run npm install); it could not be loaded', { cause });
  },
);

/** One exported declaration that has no doc comment. */
export interface UndocumentedExport {
  /** The file as it was passed in. */
  file: string;
  /** The exported name (the first declared name for a variable statement). */
  name: string;
  /** 1-based line of the declaration. */
  line: number;
}

/** One comment that points at private planning history. */
export interface HistoryComment {
  /** The file as it was passed in. */
  file: string;
  /** 1-based line where the comment starts. */
  line: number;
  /** The comment text as written, including its delimiters. */
  text: string;
}

/** The parts of the parser's comment nodes this checker reads. */
interface CommentNode {
  type: 'Line' | 'Block';
  value: string;
  start: number;
  end: number;
}

/** The parts of a top-level statement this checker reads. */
interface StatementNode {
  type: string;
  start: number;
  declaration?: { type: string; id?: { name?: string } | null; declarations?: { id: { name?: string } }[] } | null;
}

/** One parsed file: its text, top-level statements, comments and whole program. */
export interface Parsed {
  source: string;
  program: unknown;
  statements: StatementNode[];
  comments: CommentNode[];
}

/** Parses source text; `file` only chooses the language (`.ts`, `.tsx`) and names the file in an error. Throws on a syntax error. */
export function parseSource(file: string, source: string): Parsed {
  const result = parseSync(file, source);
  if (result.errors.length > 0) throw new Error(`${file}: ${result.errors[0]?.message}`);
  return {
    source,
    program: result.program,
    statements: result.program.body as unknown as StatementNode[],
    comments: result.comments as unknown as CommentNode[],
  };
}

// The parser is the oxc parser bundled with rolldown (which Vite already depends on), because the
// TypeScript 7 package has no in-process compiler API. Offsets are UTF-16 code units.
function parse(file: string): Parsed {
  return parseSource(file, readFileSync(file, 'utf8'));
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** The exported name of a statement, or undefined when it exports no declaration (a re-export). */
function exportedName(st: StatementNode): string | undefined {
  if (st.type !== 'ExportNamedDeclaration' && st.type !== 'ExportDefaultDeclaration') return undefined;
  const d = st.declaration;
  if (!d) return undefined;
  if (d.type === 'VariableDeclaration') return d.declarations?.[0]?.id.name ?? '(destructured)';
  if (d.id?.name) return d.id.name;
  return st.type === 'ExportDefaultDeclaration' && /Declaration$/.test(d.type) ? 'default' : undefined;
}

/** True when a JSDoc block (a block comment opening with two stars) ends right before the statement, with only whitespace between. */
function hasDocComment(p: Parsed, st: StatementNode): boolean {
  for (let i = p.comments.length - 1; i >= 0; i--) {
    const c = p.comments[i]!;
    if (c.end > st.start) continue;
    return c.type === 'Block' && c.value.startsWith('*') && p.source.slice(c.end, st.start).trim() === '';
  }
  return false;
}

/**
 * Finds top-level exported declarations without a JSDoc comment directly above them. Re-exports
 * (`export { a } from`) and `export default <expression>` are not declarations and are skipped.
 * Overload signatures count individually. Files are read from disk; a missing file or one that
 * does not parse throws.
 */
export function undocumentedExports(files: readonly string[]): UndocumentedExport[] {
  const out: UndocumentedExport[] = [];
  for (const file of files) {
    const p = parse(file);
    for (const st of p.statements) {
      const name = exportedName(st);
      if (name === undefined || hasDocComment(p, st)) continue;
      out.push({ file, name, line: lineOf(p.source, st.start) });
    }
  }
  return out;
}

/**
 * Words that mark a reference to private planning history: task numbers, milestone labels, ruling
 * numbers and internal spec sections. A section of an external specification ("RFC 9559 §5.1") is
 * allowed, so a bare section sign is not matched.
 */
const HISTORY_WORDS = /\b(Task \d+|milestone \d|ruling R?\d+|spec §)/i;

/**
 * Case-sensitive labels: milestones (`M4`, `M2b`), sub-milestones (`5e`), ruling numbers (`R12`)
 * and lettered rulings (`T7h`). Deliberate exclusions: `M2TS` and `m2ts` (no boundary after the
 * digits), `PSR22` (`R22` after `PS`), hex such as `0x5e` (no boundary before the 5), and a bare
 * `T1` (a type parameter; Seikou's lettered rulings always carry a letter).
 */
const HISTORY_LABELS = /\b(M\d+[a-z]?\b|(?<!PS)R\d{1,2}\b|T\d+[a-z]\b|5[a-e]\b)/;

function isHistory(text: string): boolean {
  return HISTORY_WORDS.test(text) || HISTORY_LABELS.test(text);
}

/**
 * Finds comments (never string literals) that cite rulings, task numbers, milestone labels or
 * section numbers of an internal spec. Files are read from disk; a missing file or one that does
 * not parse throws.
 */
export function privateHistoryComments(files: readonly string[]): HistoryComment[] {
  return commentsMatching(files, isHistory);
}

function commentsMatching(files: readonly string[], test: (text: string) => boolean): HistoryComment[] {
  const out: HistoryComment[] = [];
  for (const file of files) {
    const p = parse(file);
    for (const c of p.comments) {
      const text = p.source.slice(c.start, c.end);
      if (test(text)) out.push({ file, line: lineOf(p.source, c.start), text });
    }
  }
  return out;
}

/**
 * Finds comments that use the old name `bluray-web` outside a backtick code span (a kept
 * identifier is written in backticks). Strings and code are never read. Files are read from disk.
 */
export function oldNameComments(files: readonly string[]): HistoryComment[] {
  return commentsMatching(files, (text) => /bluray-web/.test(text.replace(/`[^`]*`/g, '')));
}

/** The program with positions dropped, as JSON: equal for two sources that differ only in comments and layout. */
function codeShape(file: string, source: string): string {
  const p = parseSource(file, source);
  return JSON.stringify(p.program, (k, v: unknown) =>
    k === 'start' || k === 'end' || k === 'range' || k === 'loc' ? undefined : typeof v === 'bigint' ? `${v.toString()}n` : v);
}

/** The file's text at `base`, or undefined when it did not exist there. */
function textAt(base: string, file: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${base}:./${basename(file)}`], {
      cwd: dirname(file),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/**
 * Lists the files whose code differs from `git show <base>:<file>`. Comments, whitespace and
 * layout between tokens (and trailing commas) are ignored (the programs are compared as syntax trees), but a string,
 * template or regex literal is compared as written. A file deleted since `base` is listed; a file
 * new since `base` is listed unless it is Markdown. A file that exists in neither is skipped.
 */
export function codeChanges(base: string, files: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const now = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    const before = textAt(base, file);
    if (now === undefined) {
      if (before !== undefined) out.push(file);
    } else if (before === undefined) {
      if (!file.endsWith('.md')) out.push(file);
    } else if (/\.tsx?$/.test(file) ? codeShape(file, now) !== codeShape(file, before) : now !== before) {
      out.push(file);
    }
  }
  return out;
}

/** The globs of the checked scope, relative to the repository root. */
const SCOPE = ['packages/*/src/**', 'src/**', 'server/src/**', 'rendezvous/src/**', 'encoder/src/**', 'encoder/web/src/**'];

/** The tracked source files in the checked scope (no tests, declaration files or the BD-J class library). */
function scopeFromGit(): string[] {
  const out = execFileSync('git', ['ls-files', '--', ...SCOPE.map((g) => `:(glob)${g}`)], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.(test\.tsx?|d\.ts)$/.test(f) && !f.startsWith('src/bdj-classlib/'))
    .sort();
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'check') {
    const files = rest.length > 0 ? rest : scopeFromGit();
    let found = 0;
    const report = (kind: string, items: HistoryComment[]): void => {
      for (const c of items) {
        console.log(`${c.file}:${c.line} ${kind} ${c.text.replace(/\s+/g, ' ').slice(0, 200)}`);
        found++;
      }
    };
    for (const u of undocumentedExports(files)) {
      console.log(`${u.file}:${u.line} undocumented ${u.name}`);
      found++;
    }
    report('history', privateHistoryComments(files));
    report('old-name', oldNameComments(files));
    return found > 0 ? 1 : 0;
  }
  if (cmd === 'unchanged') {
    const [base, ...rest2] = rest;
    if (!base) throw new Error('usage: doc-check unchanged <base> [file...]');
    const changed = codeChanges(base, rest2.length > 0 ? rest2 : scopeFromGit());
    for (const f of changed) console.log(f);
    return changed.length > 0 ? 1 : 0;
  }
  console.error('usage: doc-check check [file...] | doc-check unchanged <base> [file...]');
  return 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
