/*
 * The GSUB ligature lookups HarfBuzz applies by default (liga, clig, rlig): which runs of characters a face draws
 * as one glyph, so layout can merge them into one cluster as libass's shaping does.
 *
 * Original implementation for bluray-web, 2026, from the OpenType specification; contains no libass, HarfBuzz,
 * libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

interface Ligature { readonly glyph: number; readonly components: readonly number[] }
/** One ligature lookup: first glyph → candidate ligatures, in table order. */
type LigatureLookup = ReadonlyMap<number, readonly Ligature[]>;

const FEATURES = new Set(['liga', 'clig', 'rlig']);

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
const tagAt = (b: Uint8Array, at: number): string => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** Coverage table: glyph → coverage index. */
function coverage(b: Uint8Array, at: number): Map<number, number> {
  const v = view(b);
  const out = new Map<number, number>();
  const format = v.getUint16(at);
  const n = v.getUint16(at + 2);
  if (format === 1) {
    for (let i = 0; i < n; i++) out.set(v.getUint16(at + 4 + 2 * i), i);
  } else if (format === 2) {
    for (let i = 0; i < n; i++) {
      const r = at + 4 + 6 * i;
      const start = v.getUint16(r);
      const end = v.getUint16(r + 2);
      const index = v.getUint16(r + 4);
      for (let g = start; g <= end; g++) out.set(g, index + g - start);
    }
  }
  return out;
}

/** A ligature substitution subtable (lookup type 4, format 1) into `into`. */
function ligatureSubtable(b: Uint8Array, at: number, into: Map<number, Ligature[]>): void {
  const v = view(b);
  if (v.getUint16(at) !== 1) return;
  const cov = coverage(b, at + v.getUint16(at + 2));
  const setCount = v.getUint16(at + 4);
  const sets: number[] = [];
  for (let i = 0; i < setCount; i++) sets.push(at + v.getUint16(at + 6 + 2 * i));
  for (const [glyph, index] of cov) {
    const set = sets[index];
    if (set === undefined) continue;
    const count = v.getUint16(set);
    for (let k = 0; k < count; k++) {
      const lig = set + v.getUint16(set + 2 + 2 * k);
      const compCount = v.getUint16(lig + 2);
      const components: number[] = [];
      for (let c = 1; c < compCount; c++) components.push(v.getUint16(lig + 4 + 2 * (c - 1)));
      const list = into.get(glyph) ?? [];
      list.push({ glyph: v.getUint16(lig), components });
      into.set(glyph, list);
    }
  }
}

/** The ligature lookups of the default features for `script` (else DFLT, else latn), in lookup order. */
export function readLigatureLookups(gsub: Uint8Array | undefined, script: string): LigatureLookup[] {
  if (!gsub || gsub.length < 10) return [];
  try {
    const v = view(gsub);
    const scriptList = v.getUint16(4);
    const featureList = v.getUint16(6);
    const lookupList = v.getUint16(8);
    const scripts = new Map<string, number>();
    for (let i = 0, n = v.getUint16(scriptList); i < n; i++) {
      const r = scriptList + 2 + 6 * i;
      scripts.set(tagAt(gsub, r), scriptList + v.getUint16(r + 4));
    }
    const scriptTable = scripts.get(script) ?? scripts.get('DFLT') ?? scripts.get('latn');
    if (scriptTable === undefined) return [];
    const langSysOffset = v.getUint16(scriptTable);
    if (langSysOffset === 0) return [];
    const langSys = scriptTable + langSysOffset;
    const featureIndices: number[] = [];
    const required = v.getUint16(langSys + 2);
    if (required !== 0xffff) featureIndices.push(required);
    for (let i = 0, n = v.getUint16(langSys + 4); i < n; i++) featureIndices.push(v.getUint16(langSys + 6 + 2 * i));
    const lookupIndices = new Set<number>();
    for (const fi of featureIndices) {
      const r = featureList + 2 + 6 * fi;
      if (!FEATURES.has(tagAt(gsub, r))) continue;
      const feature = featureList + v.getUint16(r + 4);
      for (let i = 0, n = v.getUint16(feature + 2); i < n; i++) lookupIndices.add(v.getUint16(feature + 4 + 2 * i));
    }
    const lookups: LigatureLookup[] = [];
    for (const li of [...lookupIndices].sort((a, b) => a - b)) {
      const lookup = lookupList + v.getUint16(lookupList + 2 + 2 * li);
      let type = v.getUint16(lookup);
      const into = new Map<number, Ligature[]>();
      for (let i = 0, n = v.getUint16(lookup + 4); i < n; i++) {
        let sub = lookup + v.getUint16(lookup + 6 + 2 * i);
        if (type === 7) {
          // extension: the real type and a 32-bit offset
          type = v.getUint16(sub + 2);
          sub += v.getUint32(sub + 4);
        }
        if (type === 4) ligatureSubtable(gsub, sub, into);
      }
      if (into.size) lookups.push(into);
    }
    return lookups;
  } catch {
    return []; // a malformed table: no ligatures
  }
}

/**
 * Applies the lookups to the glyphs of a run; returns, per character, the index of the character whose cluster it
 * belongs to (itself when not merged).
 */
export function ligatureClusters(glyphs: readonly number[], lookups: readonly LigatureLookup[]): number[] {
  let seq = glyphs.map((glyph, i) => ({ glyph, cluster: i }));
  for (const lookup of lookups) {
    const next: typeof seq = [];
    for (let i = 0; i < seq.length; ) {
      const cands = lookup.get(seq[i]!.glyph);
      const match = cands?.find((l) => l.components.every((c, k) => seq[i + 1 + k]?.glyph === c));
      if (match) {
        next.push({ glyph: match.glyph, cluster: seq[i]!.cluster });
        i += 1 + match.components.length;
      } else {
        next.push(seq[i]!);
        i++;
      }
    }
    seq = next;
  }
  const out = glyphs.map((_, i) => i);
  // every character between one cluster start and the next belongs to the first
  const starts = seq.map((s) => s.cluster);
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k]!;
    const to = k + 1 < starts.length ? starts[k + 1]! : glyphs.length;
    for (let i = from; i < to; i++) out[i] = from;
  }
  return out;
}

/** The OpenType script tag HarfBuzz would pick for a run, from its first letter. */
export function scriptTag(codepoints: readonly number[]): string {
  for (const c of codepoints) {
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) return 'latn';
    if (c >= 0x370 && c <= 0x3ff) return 'grek';
    if (c >= 0x400 && c <= 0x4ff) return 'cyrl';
    if (c >= 0x590 && c <= 0x5ff) return 'hebr';
    if (c >= 0x600 && c <= 0x6ff) return 'arab';
    if (c >= 0x3040 && c <= 0x30ff) return 'kana';
    if (c >= 0x4e00 && c <= 0x9fff) return 'hani';
    if (c >= 0xac00 && c <= 0xd7af) return 'hang';
  }
  return 'DFLT';
}
