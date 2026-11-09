// SPDX-License-Identifier: LGPL-3.0-or-later
import { parseAssCodecPrivate, parseChunkEvent, type AssEvent, type AssFonts, type AssRenderer, type AssTrack, type Rect, type TextRendererLike, type TextRenderOptions } from '@seikou/ass';
import type { MatroskaFile, MkvAttachedFile, MkvTrack } from '@seikou/matroska';
import { OverlayPlane, PgRenderer, PgSegmentDecoder, type OverlayOp, type PgDisplaySet } from '@seikou/pg';

// An encoded episode's own subtitle tracks. Both kinds arrive a block at a time as the file is read, never all at once
// (reading the whole file first would mean reading the episode):
// - S_TEXT/ASS (Matroska codec specification): CodecPrivate is the script up to its [Events] Format line, and each block
//   holds one Dialogue line as `ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text`, with its start
//   in the block's time and its length in BlockDuration. The script is rebuilt as the blocks come: the header is parsed
//   once (ass_process_codec_private), and each block's line against its event Format, each event once by ReadOrder,
//   appended to the track the renderer draws (as libass's ass_process_chunk does).
// - S_HDMV/PGS: each block holds one display set's segments with no PES header; they go to the PG segment decoder one
//   segment at a time, and display sets are rendered into the PG plane when the clock reaches them, as on a disc.

/** One of an encode's subtitle tracks the engine can show, in file order: its kind and its TrackEntry. */
export interface EncodeSubtitleTrack {
  readonly kind: 'ass' | 'pgs';
  readonly track: MkvTrack;
}

/** The file's ASS (or SSA) and PGS tracks, in file order; their 1-based positions are the subtitle stream numbers. */
export function encodeSubtitleTracks(file: MatroskaFile): EncodeSubtitleTrack[] {
  return file.tracks.flatMap((track): EncodeSubtitleTrack[] => {
    if (track.type !== 17) return [];
    if ((track.codecId === 'S_TEXT/ASS' || track.codecId === 'S_TEXT/SSA' || track.codecId === 'S_ASS' || track.codecId === 'S_SSA') && track.codecPrivate) return [{ kind: 'ass', track }];
    if (track.codecId === 'S_HDMV/PGS') return [{ kind: 'pgs', track }];
    return [];
  });
}

const FONT_TYPES = new Set([
  'application/x-truetype-font',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/x-font',
  'application/vnd.ms-opentype',
  'application/font-sfnt',
  'application/font-woff',
]);
const FONT_EXTENSIONS = /\.(ttf|otf|ttc|woff2?)$/i;

/** The attachments that are fonts: a font media type (`font/…` or one of the older application types), or a font file name. */
export function fontAttachments(attachments: readonly MkvAttachedFile[]): MkvAttachedFile[] {
  return attachments.filter((a) => a.mediaType.toLowerCase().startsWith('font/') || FONT_TYPES.has(a.mediaType.toLowerCase()) || FONT_EXTENSIONS.test(a.name));
}

/**
 * The subtitle stream that shows (1-based; 0 none): the viewer's choice, else, with the choice off, the first forced
 * track in the playing audio's language (FlagForced, the Matroska form of a disc's forced captions).
 */
export function shownSubtitle(tracks: readonly Pick<MkvTrack, 'language' | 'isForced'>[], choice: number, audioLanguage: string | null): number {
  if (choice > 0) return choice;
  if (audioLanguage === null) return 0;
  return tracks.findIndex((t) => t.isForced && t.language === audioLanguage) + 1;
}

/** The subtitle stream shown at open: the first track flagged default, or 0 (none). */
export function defaultSubtitle(tracks: readonly Pick<MkvTrack, 'isDefault'>[]): number {
  return tracks.findIndex((t) => t.isDefault) + 1;
}

/** Matches every family an MKV ASS track names (its styles and the \fn tags of its events so far), so the faces load. */
export function resolveMkvAssFonts(fonts: AssFonts, track: AssTrack): void {
  for (const st of track.styles.slice(1)) {
    fonts.resolve({ family: st.fontName.replace(/^@/, ''), bold: st.bold ? 700 : 400, italic: st.italic ? 100 : 0, vertical: st.fontName.startsWith('@') });
  }
  for (const e of track.events) resolveEventFonts(fonts, e);
}

function resolveEventFonts(fonts: AssFonts, e: AssEvent): void {
  for (const m of e.text.matchAll(/\\fn([^\\}]*)/g)) {
    const name = m[1]!.trim();
    if (name && name !== '0') fonts.resolve({ family: name.replace(/^@/, ''), bold: 400, italic: 0, vertical: name.startsWith('@') });
  }
}

const TEXT = new TextDecoder();

/**
 * An MKV ASS track: its script header parsed once, its events added as their blocks are read, and the renderer that
 * draws them once its fonts have loaded (attach). As a TextRendererLike it draws nothing until then.
 */
export class MkvAssTrack implements TextRendererLike {
  /** The rebuilt script: the header's styles and settings, with the events read so far. */
  readonly track: AssTrack;
  private readonly events: AssEvent[] = [];
  private readonly seen = new Set<number>();
  private rendererValue: AssRenderer | null = null;
  private fontsValue: AssFonts | null = null;
  private attachedChange = false;

  /** `defaultDurationMs`: the track's DefaultDuration, the length of a block that has no BlockDuration. */
  constructor(codecPrivate: Uint8Array, private readonly defaultDurationMs?: number) {
    this.track = { ...parseAssCodecPrivate(TEXT.decode(codecPrivate)), events: this.events };
  }

  /** The renderer, once attached. */
  get renderer(): AssRenderer | null {
    return this.rendererValue;
  }

  /**
   * Adds one block's event; false when it is not an ASS block, or its ReadOrder was added before (a block read again
   * after a seek). A block without BlockDuration lasts the track's DefaultDuration; without that either, when the
   * event ends is unknown (ASS events are always BlockGroups with a duration, so this is a malformed file) and the
   * block is skipped.
   */
  add(block: { readonly data: Uint8Array; readonly timeMs: number; readonly durationMs?: number }): boolean {
    const durationMs = block.durationMs ?? this.defaultDurationMs;
    if (durationMs === undefined) return false;
    const text = TEXT.decode(block.data).replace(/[\r\n]+/g, ' ');
    const m = /^\s*(-?\d+)\s*,/.exec(text);
    if (!m) return false;
    const readOrder = Number(m[1]);
    if (this.seen.has(readOrder)) return false;
    const event = parseChunkEvent(this.track, text, Math.round(block.timeMs), Math.max(0, Math.round(durationMs)));
    if (!event) return false;
    this.seen.add(readOrder);
    this.events.push(event);
    if (this.fontsValue) resolveEventFonts(this.fontsValue, event);
    this.rendererValue?.eventsAdded();
    return true;
  }

  /** The renderer that draws this track (built on `track`), once its fonts are ready; later fonts named by \fn resolve with `fonts`. */
  attach(renderer: AssRenderer, fonts?: AssFonts): void {
    this.rendererValue = renderer;
    this.fontsValue = fonts ?? null;
    this.attachedChange = true;
  }

  /** A seek: the renderer forgets its collision memory. */
  reset(): void {
    this.rendererValue?.reset();
  }

  render(ctx: OffscreenCanvasRenderingContext2D, timeUs: number, videoRect: Rect, opts: TextRenderOptions): number {
    this.attachedChange = false;
    return this.rendererValue?.render(ctx, timeUs, videoRect, opts) ?? 0;
  }

  changed(timeUs: number, opts: TextRenderOptions): boolean {
    if (this.attachedChange) return true;
    return this.rendererValue?.changed(timeUs, opts) ?? false;
  }

  visible(timeUs: number, opts: TextRenderOptions): boolean {
    return this.rendererValue?.visible(timeUs, opts) ?? false;
  }
}

const MAX_QUEUED_SETS = 64;

/**
 * An MKV PGS track shown in the PG plane, with no PSRs: every object shows (the track is shown because it was chosen,
 * or because it is forced). Display sets are decoded as their blocks arrive and rendered when the clock reaches them.
 */
export class PgsControl {
  private planeValue = new OverlayPlane(1920, 1080, { buffered: true });
  private readonly decoder = new PgSegmentDecoder();
  private readonly renderer: PgRenderer;
  private sets: PgDisplaySet[] = [];
  private shownValue: { readonly objectsShown: number; readonly forced: number } | null = null;

  constructor() {
    this.renderer = new PgRenderer({ displayFlag: () => true, onOverlay: (op) => this.applyOverlay(op) });
  }

  /** The PG plane the compositor draws (replaced by one of the composition's size when that differs). */
  get plane(): OverlayPlane {
    return this.planeValue;
  }

  /** One block: the segments of a display set, each `type, length (16 bits), payload`, at the block's time. */
  push(data: Uint8Array, ptsUs: number): void {
    for (let at = 0; at + 3 <= data.length; ) {
      const end = at + 3 + ((data[at + 1]! << 8) | data[at + 2]!);
      if (end > data.length) {
        this.decoder.errors++;
        break;
      }
      const ds = this.decoder.push(data.subarray(at, end), ptsUs, null);
      if (ds) {
        this.sets.push(ds);
        if (this.sets.length > MAX_QUEUED_SETS) this.sets.shift();
      }
      at = end;
    }
  }

  /** Completed display sets waiting for their time. */
  get queued(): number {
    return this.sets.length;
  }

  /** Renders the display sets whose time has come, in order. */
  tick(clockUs: number): void {
    while (this.sets.length > 0 && this.sets[0]!.pts <= clockUs) {
      const ds = this.sets.shift()!;
      const drawn = this.renderer.render(ds);
      this.shownValue = { objectsShown: drawn, forced: this.renderer.lastForced };
    }
  }

  /** A seek or a change of track: queued display sets go, the decoder starts afresh and the plane clears. */
  seek(): void {
    this.sets = [];
    this.decoder.reset();
    this.renderer.reset();
    this.shownValue = null;
  }

  /** The last render: objects drawn and how many were forced; null before any. */
  get shown(): { readonly objectsShown: number; readonly forced: number } | null {
    return this.shownValue;
  }

  /** Segments the decoder could not read. */
  get errors(): number {
    return this.decoder.errors;
  }

  private applyOverlay(op: OverlayOp): void {
    if (op.cmd === 'init' && op.w > 0 && op.h > 0 && (op.w !== this.planeValue.width || op.h !== this.planeValue.height)) {
      this.planeValue = new OverlayPlane(op.w, op.h, { buffered: true });
    }
    this.planeValue.apply(op);
  }
}
