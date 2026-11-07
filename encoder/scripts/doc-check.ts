// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';

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

interface Parsed {
  source: string;
  statements: StatementNode[];
  comments: CommentNode[];
}

// The parser is the oxc parser bundled with rolldown (which Vite already depends on), because the
// TypeScript 7 package has no in-process compiler API. Offsets are UTF-16 code units.
function parse(file: string): Parsed {
  const source = readFileSync(file, 'utf8');
  const result = parseSync(file, source);
  if (result.errors.length > 0) throw new Error(`${file}: ${result.errors[0]?.message}`);
  return {
    source,
    statements: result.program.body as unknown as StatementNode[],
    comments: result.comments as unknown as CommentNode[],
  };
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
 * allowed, so a bare section sign is not matched; `m2ts` is a file extension, not a milestone.
 */
const HISTORY = /\b(Task \d+|M\d+\b|milestone \d|ruling R?\d+|R\d{1,2}\b|spec §)/i;

/**
 * Finds comments (never string literals) that cite rulings, task numbers, milestone labels or
 * section numbers of an internal spec. Files are read from disk; a missing file or one that does
 * not parse throws.
 */
export function privateHistoryComments(files: readonly string[]): HistoryComment[] {
  const out: HistoryComment[] = [];
  for (const file of files) {
    const p = parse(file);
    for (const c of p.comments) {
      const text = p.source.slice(c.start, c.end);
      if (HISTORY.test(text)) out.push({ file, line: lineOf(p.source, c.start), text });
    }
  }
  return out;
}
