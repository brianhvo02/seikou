/*
 * SubRip (.srt) text decoding and parsing.
 *
 * Original implementation for bluray-web, 2026; contains no libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export interface StyledRun {
  readonly text: string;
  readonly italic: boolean;
  readonly bold: boolean;
  readonly underline: boolean;
  /** A CSS colour, or null for the default. */
  readonly color: string | null;
}

export type Alignment = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface TextCue {
  readonly startUs: number;
  readonly endUs: number;
  readonly lines: readonly (readonly StyledRun[])[];
  /** Numpad position ({\anN}); 2 is bottom centre. */
  readonly align: Alignment;
}

export type DecodeResult = { readonly text: string } | { readonly needsEncoding: true };

/** BOM (UTF-8, UTF-16 LE/BE), then strict UTF-8, then `fallback` (a TextDecoder label); needsEncoding if all fail or none given. */
export function decodeText(bytes: Uint8Array, fallback?: string): DecodeResult {
  const bom = (...b: number[]): boolean => b.every((v, i) => bytes[i] === v);
  if (bom(0xef, 0xbb, 0xbf)) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)) };
  if (bom(0xff, 0xfe)) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)) };
  if (bom(0xfe, 0xff)) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)) };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    // not UTF-8: the user's choice of encoding decides
  }
  if (fallback === undefined) return { needsEncoding: true };
  try {
    return { text: new TextDecoder(fallback).decode(bytes) };
  } catch {
    return { needsEncoding: true }; // an encoding label this browser does not know
  }
}

export interface SrtParse {
  /** Sorted by start time. */
  readonly cues: readonly TextCue[];
  /** Blocks that could not be read (no valid time line, or an end not after the start). */
  readonly skipped: number;
  /** Non-empty blocks in the file. */
  readonly blocks: number;
}

const TIME_LINE = /^\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

function toUs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1_000_000 + Number(ms.padEnd(3, '0')) * 1000;
}

export function parseSrt(text: string): SrtParse {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const cues: TextCue[] = [];
  let skipped = 0;
  let count = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
    if (lines.length === 0) continue;
    count++;
    let at = 0;
    if (!TIME_LINE.test(lines[0]!) && /^\s*\d+\s*$/.test(lines[0]!)) at = 1; // the cue number, which may be absent or out of order
    const m = TIME_LINE.exec(lines[at] ?? '');
    if (!m) {
      skipped++;
      continue;
    }
    const startUs = toUs(m[1]!, m[2]!, m[3]!, m[4]!);
    const endUs = toUs(m[5]!, m[6]!, m[7]!, m[8]!);
    if (endUs <= startUs) {
      skipped++;
      continue;
    }
    cues.push({ startUs, endUs, ...styleLines(lines.slice(at + 1)) });
  }
  cues.sort((a, b) => a.startUs - b.startUs); // stable: equal starts keep file order
  return { cues, skipped, blocks: count };
}

/** <i> <b> <u> <font …> (open or close), or an override block {\…}; anything else is text. */
const TAG = /<(\/?)(i|b|u|font)\b([^>]*)>|\{\\([^}]*)\}/gi;
/** A CSS hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa) or a word; other values are ignored. */
const COLOR_ATTR = /color\s*=\s*["']?(#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-f])|[a-z]+\b)/i;

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function styleLines(raw: readonly string[]): { lines: StyledRun[][]; align: Alignment } {
  let align: Alignment = 2;
  let italic = 0;
  let bold = 0;
  let underline = 0;
  const colors: Array<string | null> = [];
  const lines: StyledRun[][] = [];
  for (const line of raw) {
    const runs: StyledRun[] = [];
    const add = (text: string): void => {
      if (text === '') return;
      const style = { italic: italic > 0, bold: bold > 0, underline: underline > 0, color: colors.at(-1) ?? null };
      const last = runs.at(-1);
      if (last && last.italic === style.italic && last.bold === style.bold && last.underline === style.underline && last.color === style.color) {
        runs[runs.length - 1] = { ...last, text: last.text + text };
      } else {
        runs.push({ text, ...style });
      }
    };
    let pos = 0;
    for (const m of line.matchAll(TAG)) {
      add(decodeEntities(line.slice(pos, m.index)));
      pos = m.index + m[0].length;
      if (m[4] !== undefined) {
        const an = /^an([1-9])$/.exec(m[4].trim());
        if (an) align = Number(an[1]) as Alignment; // the last one wins; other overrides are dropped
        continue;
      }
      const closing = m[1] === '/';
      const step = closing ? -1 : 1;
      switch (m[2]!.toLowerCase()) {
        case 'i': italic = Math.max(0, italic + step); break;
        case 'b': bold = Math.max(0, bold + step); break;
        case 'u': underline = Math.max(0, underline + step); break;
        default:
          if (closing) colors.pop();
          else colors.push(COLOR_ATTR.exec(m[3]!)?.[1]!.toLowerCase() ?? colors.at(-1) ?? null);
      }
    }
    add(decodeEntities(line.slice(pos)));
    lines.push(runs);
  }
  return { lines, align };
}

/**
 * A max-end segment tree over the cues (sorted by start), built once per cue list: node i holds the latest end among its
 * cues, so a lookup skips every subtree in which nothing is still showing.
 */
const indexes = new WeakMap<readonly TextCue[], Float64Array>();

function buildIndex(cues: readonly TextCue[]): Float64Array {
  const tree = new Float64Array(Math.max(1, 4 * cues.length));
  const build = (node: number, lo: number, hi: number): number => {
    const end = hi - lo === 1 ? cues[lo]!.endUs : Math.max(build(2 * node, lo, (lo + hi) >>> 1), build(2 * node + 1, (lo + hi) >>> 1, hi));
    tree[node] = end;
    return end;
  };
  if (cues.length > 0) build(1, 0, cues.length);
  return tree;
}

/** The cues active at `timeUs` (start ≤ t < end), in start order, in O((k + 1) log n) for k active cues. */
export function activeCues(cues: readonly TextCue[], timeUs: number): TextCue[] {
  let tree = indexes.get(cues);
  if (!tree) {
    tree = buildIndex(cues);
    indexes.set(cues, tree);
  }
  let lo = 0;
  let hi = cues.length; // first cue starting after timeUs
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid]!.startUs <= timeUs) lo = mid + 1;
    else hi = mid;
  }
  const started = lo;
  const out: TextCue[] = [];
  const visit = (node: number, from: number, to: number): void => {
    if (from >= started || tree![node]! <= timeUs) return; // every cue here starts later, or has ended
    if (to - from === 1) {
      out.push(cues[from]!);
      return;
    }
    const mid = (from + to) >>> 1;
    visit(2 * node, from, mid);
    visit(2 * node + 1, mid, to);
  };
  if (cues.length > 0) visit(1, 0, cues.length);
  return out;
}
