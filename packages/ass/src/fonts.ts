/*
 * Font selection for ASS: which supplied face draws a request (family, weight, italic) and each character,
 * libass's matching and fallback rules, synthetic bold/italic, and registering the chosen faces for drawing.
 *
 * Ported from libass 0.17.5 (ass_fontselect.c): matches_family_name, matches_full_or_postscript_name,
 * font_attributes_similarity, find_font, select_font, ass_font_select, check_glyph_ft; (ass_font.c): add_face,
 * ass_font_get_index, the synthetic-style conditions of ass_font_get_glyph, ass_glyph_italicize's shear,
 * ass_face_set_size. libass is ISC-licensed; see packages/ass/NOTICE. Modified for Seikou, 2026.
 *
 * Not from libass: the device-font branch (marked "device fonts" below, the rest in device-fonts.ts), which stands in
 * for libass's system font provider when a family matches no supplied face. Supplied faces are matched as before.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { DEVICE_STYLES, deviceFaceInfo, localNames, type DeviceFaceMetrics, type DeviceFontSource } from './device-fonts';
import { extractFace, FontFileError, readFontFile, type FaceInfo, type FontFile } from './font-tables';

/** ASS_FontDesc: `bold` is a weight (ass_update_font maps \b1 to 700, \b0 to 400), `italic` 0 or 100 (or the \i value). */
export interface FontRequest { readonly family: string; readonly bold: number; readonly italic: number; readonly vertical: boolean }

export interface ResolvedFace {
  readonly face: FaceInfo;
  /** The private CSS family the face is registered under. */
  readonly cssFamily: string;
  /** ass_glyph_embolden applies: the face is not bold and the request is over 150 heavier. */
  readonly synthBold: boolean;
  /** ass_glyph_italicize applies: the face is not italic and the request's italic is over 55. */
  readonly synthItalic: boolean;
  /** The x-shear ass_glyph_italicize uses for this face (CFF faces lean less, as GDI). */
  readonly italicShear: number;
  /** No face of the requested family drew it: the default family or font did. */
  readonly fallback: boolean;
}

export interface FontLoader {
  load(cssFamily: string, bytes: Uint8Array): Promise<void>;
  unload(cssFamily: string): void;
}

const DEFAULT_FAMILY = 'DejaVu Sans';
/** Device fonts: families looked up per AssFonts at most; later ones take the default font and are reported missing. */
const MAX_DEVICE_FAMILIES = 32;
/** Device fonts: a style's lookup that takes longer counts as a miss, so a stuck local() load can't hold lines back. */
const DEVICE_LOOKUP_TIMEOUT_MS = 3000;
const ITALIC_SHEAR_TT = 0x05700 / 0x10000;
const ITALIC_SHEAR_PS = 0x02d24 / 0x10000;

/** A supplied face (`file`), or an installed one (device fonts: `file` null, registered under `cssFamily` already). */
interface Entry { readonly face: FaceInfo; readonly file: FontFile | null; readonly uid: number; readonly cssFamily?: string }

export interface AssFontsOptions {
  /**
   * Where a family no supplied face matches is looked up before falling back to the default font; null or absent
   * keeps libass's behaviour with no system fonts (the comparison harness needs that, for exact goldens).
   */
  readonly deviceFonts?: DeviceFontSource | null;
}

const lower = (s: string): string => s.toLowerCase();

/** matches_family_name (no extended family: there is no system font provider). */
const matchesFamilyName = (f: FaceInfo, family: string): boolean => f.families.some((n) => lower(n) === lower(family));

/** matches_full_or_postscript_name */
function matchesFullOrPostscriptName(f: FaceInfo, fullname: string): boolean {
  const full = f.fullNames.some((n) => lower(n) === lower(fullname));
  const ps = f.postscriptName !== null && lower(f.postscriptName) === lower(fullname);
  if (full === ps) return full;
  return f.isPostscript ? ps : full;
}

/** font_attributes_similarity: lower is better. */
function similarity(a: FaceInfo, weight: number, italic: boolean): number {
  let score = 0;
  if (italic && !a.italic) score += 1;
  else if (!italic && a.italic) score += 4;
  let w = a.weight;
  if (weight > a.weight + 150 && !a.bold) w += 120;
  return score + Math.floor((73 * Math.abs(w - weight)) / 256);
}

/**
 * px em size for an ASS font size: ass_face_set_size with REAL_DIM makes ascender + descender the size. This is the
 * scale of FreeType's unhinted outlines and of the size metrics ass_font_get_asc_desc reads.
 */
export function emSize(face: FaceInfo, size: number): number {
  return (size * face.unitsPerEm) / (face.ascender - face.descender);
}

/**
 * px em size of the shaper's advances: HarfBuzz reads them hinted (FT_LOAD_DEFAULT), and FreeType's TrueType
 * driver scales hinted glyphs by the ppem rounded to whole pixels for fonts whose head flags ask for it.
 */
export function advanceEmSize(face: FaceInfo, size: number): number {
  const em = emSize(face, size);
  return face.integerPpem ? Math.round(em) : em;
}

/** The faces an ASS_Font has added so far (add_face), in order. */
interface FontState { readonly faces: ResolvedFace[] }

export class AssFonts {
  private readonly entries: Entry[] = [];
  private readonly defaultEntry: Entry;
  private readonly fonts = new Map<string, FontState>();
  private readonly css = new Map<number, string>();
  private readonly loaded = new Set<number>();
  private readonly missing = new Map<string, string>();
  private readonly entryOf = new WeakMap<ResolvedFace, Entry>();
  private nextUid = 1;
  // device fonts: the installed faces of each family looked up (lower case; null when the device has none), the
  // lookups in flight, the requests made since the last add() (selected again once a lookup finds faces), and the
  // installed faces' private CSS families
  private readonly device: DeviceFontSource | null;
  private readonly deviceFaces = new Map<string, readonly Entry[] | null>();
  private readonly probing = new Map<string, Promise<void>>();
  private readonly requests = new Map<string, FontRequest>();
  private readonly deviceCss = new Set<string>();
  private reselect = false;
  private disposed = false;

  constructor(private readonly loader: FontLoader, defaultFont: FontFile, options: AssFontsOptions = {}) {
    this.defaultEntry = { face: defaultFont.faces[0]!, file: defaultFont, uid: 0 };
    this.device = options.deviceFonts ?? null;
  }

  /** Adds font files in the order libass would see them ([Fonts] of the script first, then the user's files). */
  async add(files: readonly { readonly name: string; readonly bytes: Uint8Array }[]): Promise<{ readonly unreadable: readonly string[] }> {
    const unreadable: string[] = [];
    for (const f of files) {
      let file: FontFile;
      try {
        file = await readFontFile(f.name, f.bytes);
      } catch (e) {
        if (!(e instanceof FontFileError)) throw e;
        unreadable.push(f.name);
        continue;
      }
      for (const face of file.faces) this.entries.push({ face, file, uid: this.nextUid++ });
    }
    // a new face can change what a request selects (libass rebuilds its font cache on ass_fonts_update)
    this.fonts.clear();
    this.missing.clear();
    this.requests.clear();
    return { unreadable };
  }

  /** find_font for one name: the best-scoring face that has `code` (0 = any), and whether any face matched the name. */
  private findFont(name: string, weight: number, italic: boolean, code: number): { entry: Entry | null; nameMatch: boolean } {
    let best: Entry | null = null;
    let min = Infinity;
    let nameMatch = false;
    for (const e of this.entries) {
      let score = Infinity;
      if (matchesFamilyName(e.face, name)) {
        score = similarity(e.face, weight, italic);
        nameMatch = true;
      } else if (matchesFullOrPostscriptName(e.face, name)) {
        score = 0;
        nameMatch = true;
      }
      if (score < min) {
        if (code !== 0 && !e.face.hasGlyph(code)) continue;
        min = score;
        best = e;
      }
      if (score === 0) break;
    }
    return { entry: best, nameMatch };
  }

  /** ass_font_select: the family, then the default family, then the default font. */
  private select(req: FontRequest, code: number): { entry: Entry; requested: boolean; nameMatch: boolean } {
    const italic = req.italic !== 0;
    let nameMatch = false;
    if (req.family !== '') {
      const r = this.findFont(req.family, req.bold, italic, code);
      nameMatch = r.nameMatch;
      if (r.entry) return { entry: r.entry, requested: true, nameMatch };
      // device fonts: no supplied face carries the name, so an installed face of the family draws, once looked up
      if (!nameMatch) {
        const installed = this.installed(req.family);
        if (installed) return { entry: this.closest(installed, req.bold, italic), requested: true, nameMatch };
      }
    }
    const d = this.findFont(DEFAULT_FAMILY, req.bold, italic, code);
    return { entry: d.entry ?? this.defaultEntry, requested: false, nameMatch };
  }

  /** Device fonts: the family's installed faces, null when it has none or isn't looked up yet (which starts that). */
  private installed(family: string): readonly Entry[] | null {
    const key = lower(family);
    const known = this.deviceFaces.get(key);
    if (known !== undefined) return known;
    // the bundled default's own family keeps the bundled face, exactly
    if (this.defaultEntry.face.families.some((n) => lower(n) === key)) return null;
    if (this.device && !this.probing.has(key) && this.deviceFaces.size + this.probing.size < MAX_DEVICE_FAMILIES) {
      this.probing.set(key, this.lookUp(this.device, family, key));
    }
    return null;
  }

  /** Device fonts: asks for each style of the family once, for the renderer's life (a miss is remembered too). */
  private async lookUp(device: DeviceFontSource, family: string, key: string): Promise<void> {
    const found = await Promise.all(DEVICE_STYLES.map(async (style): Promise<Entry | null> => {
      const uid = this.nextUid++;
      const cssFamily = `assd-${uid}`;
      const m = await this.loadInTime(device, cssFamily, localNames(family, style));
      return m ? { face: deviceFaceInfo(family, style, m), file: null, uid, cssFamily } : null;
    }));
    const entries = found.filter((e): e is Entry => e !== null);
    this.probing.delete(key);
    if (this.disposed) {
      for (const e of entries) device.unload(e.cssFamily!);
      return;
    }
    this.deviceFaces.set(key, entries.length ? entries : null);
    for (const e of entries) {
      this.css.set(e.uid, e.cssFamily!);
      this.loaded.add(e.uid);
      this.deviceCss.add(e.cssFamily!);
    }
    if (entries.length) this.reselect = true;
  }

  /** Device fonts: one style's lookup, null after DEVICE_LOOKUP_TIMEOUT_MS; a face that arrives later is unloaded. */
  private loadInTime(device: DeviceFontSource, cssFamily: string, names: readonly string[]): Promise<DeviceFaceMetrics | null> {
    return new Promise((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, DEVICE_LOOKUP_TIMEOUT_MS);
      device.load(cssFamily, names).then((m) => {
        clearTimeout(timer);
        if (timedOut && m) device.unload(cssFamily);
        resolve(m);
      }, () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /** Device fonts: find_font's scoring among a family's installed faces (they cover every character). */
  private closest(entries: readonly Entry[], weight: number, italic: boolean): Entry {
    let best = entries[0]!;
    for (const e of entries) if (similarity(e.face, weight, italic) < similarity(best.face, weight, italic)) best = e;
    return best;
  }

  private resolved(entry: Entry, req: FontRequest, fallback: boolean): ResolvedFace {
    let cssFamily = this.css.get(entry.uid);
    if (cssFamily === undefined) {
      cssFamily = entry.cssFamily ?? `assf-${entry.uid}`;
      this.css.set(entry.uid, cssFamily);
    }
    const face = entry.face;
    const r: ResolvedFace = {
      face, cssFamily, fallback,
      synthBold: !face.bold && req.bold > face.weight + 150,
      synthItalic: !face.italic && req.italic > 55,
      italicShear: face.isPostscript ? ITALIC_SHEAR_PS : ITALIC_SHEAR_TT,
    };
    this.entryOf.set(r, entry);
    return r;
  }

  private font(req: FontRequest): FontState {
    const key = `${req.family}\u0000${req.bold}\u0000${req.italic}\u0000${req.vertical ? 1 : 0}`;
    let state = this.fonts.get(key);
    if (!state) {
      const s = this.select(req, 0);
      if (req.family !== '' && !s.nameMatch && !this.missing.has(lower(req.family))) this.missing.set(lower(req.family), req.family);
      state = { faces: [this.resolved(s.entry, req, !s.requested)] };
      this.fonts.set(key, state);
      this.requests.set(key, req);
    }
    return state;
  }

  /** The request's first face (ass_font_new → add_face with code 0). */
  resolve(req: FontRequest): ResolvedFace {
    return this.font(req).faces[0]!;
  }

  /** ass_font_get_index: the first face of the font with the glyph, else one more face selected for it. */
  faceFor(req: FontRequest, codepoint: number): ResolvedFace {
    const state = this.font(req);
    if (codepoint < 0x20) return state.faces[0]!;
    const has = state.faces.find((f) => f.face.hasGlyph(codepoint));
    if (has) return has;
    const s = this.select(req, codepoint);
    const existing = state.faces.find((f) => this.entryOf.get(f) === s.entry);
    if (existing) return existing;
    const added = this.resolved(s.entry, req, !s.requested);
    state.faces.push(added);
    return added;
  }

  /** Registers every face resolved so far that is not registered yet. */
  async ready(): Promise<void> {
    // device fonts: wait for the lookups, then select again the requests a found face may now draw
    while (this.probing.size) await Promise.all(this.probing.values());
    if (this.reselect) {
      this.reselect = false;
      const requests = [...this.requests.values()];
      this.fonts.clear();
      this.missing.clear();
      for (const r of requests) this.font(r);
    }
    const pending: Promise<void>[] = [];
    for (const state of this.fonts.values()) {
      for (const f of state.faces) {
        const entry = this.entryOf.get(f)!;
        if (this.loaded.has(entry.uid) || !entry.file) continue;
        this.loaded.add(entry.uid);
        pending.push(this.loader.load(f.cssFamily, extractFace(entry.file, entry.face.index)));
      }
    }
    await Promise.all(pending);
  }

  /** Faces resolved but not registered yet: layout measured them with a fallback until ready() completes. */
  hasPending(): boolean {
    if (this.probing.size || this.reselect) return true;
    for (const state of this.fonts.values()) for (const f of state.faces) if (!this.loaded.has(this.entryOf.get(f)!.uid)) return true;
    return false;
  }

  /**
   * Requested families no supplied face matched by name and no installed face drew (device fonts), in first-request
   * order, case-insensitively unique. A family still being looked up on the device counts as missing.
   */
  missingFamilies(): readonly string[] {
    return [...this.missing.values()].filter((f) => !this.deviceFaces.get(lower(f)));
  }

  dispose(): void {
    this.disposed = true;
    for (const uid of this.loaded) {
      const css = this.css.get(uid)!;
      if (this.deviceCss.has(css)) this.device!.unload(css);
      else this.loader.unload(css);
    }
    this.loaded.clear();
  }
}

/** The production loader: FontFaces in a FontFaceSet (the worker's self.fonts). */
export function createFontFaceLoader(fontSet: FontFaceSet): FontLoader {
  const faces = new Map<string, FontFace>();
  return {
    async load(cssFamily, bytes) {
      const face = new FontFace(cssFamily, bytes as BufferSource);
      await face.load();
      fontSet.add(face);
      faces.set(cssFamily, face);
    },
    unload(cssFamily) {
      const face = faces.get(cssFamily);
      if (face) fontSet.delete(face);
      faces.delete(cssFamily);
    },
  };
}
