// SPDX-License-Identifier: LGPL-3.0-or-later
import { openMatroska, type MkvBlock, type MkvTrack, type RangeReader } from '@seikou/matroska';
import { textTrackBlocks } from '@seikou/matroska/text-blocks';
import { fontAttachments } from '../encode/mkv-subtitles';

// A release MKV's text subtitle tracks rebuilt as the files they were muxed from, for the owner's
// upload form and the player's pick path (Matroska codec specification):
// - S_TEXT/ASS and S_TEXT/SSA: CodecPrivate is the script up to its [Events] Format line, and each
//   block holds `ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text`, with the
//   start in the block's time and the length in BlockDuration. The file is the header followed by
//   one Dialogue line per block in ReadOrder, the order the muxer took them out of the script in.
// - S_TEXT/UTF8 and S_TEXT/ASCII: each block is one cue's text; the file is numbered SRT cues.

/**
 * One text subtitle track of an MKV, rebuilt as a whole file.
 * @internal
 */
export interface MkvTextTrack {
  /** The Matroska track number. */
  readonly number: number;
  /** `ass` (an .ass file, from S_TEXT/ASS or S_TEXT/SSA) or `srt`. */
  readonly kind: 'ass' | 'srt';
  /** The track's Name, or null when it has none. */
  readonly name: string | null;
  /** The track's Language (ISO 639-2), or null when empty. */
  readonly language: string | null;
  /** FlagDefault. */
  readonly isDefault: boolean;
  /** FlagForced. */
  readonly isForced: boolean;
  /** How many Dialogue lines (ASS) or cues (SRT) the file holds. */
  readonly dialogueLines: number;
  /** The file's text. */
  readonly text: string;
}

/**
 * What `extractMkvText` found in an MKV.
 * @internal
 */
export interface MkvTextExtract {
  /** The text tracks, in file order. */
  readonly tracks: readonly MkvTextTrack[];
  /** The attached fonts, read only when there is a text track. */
  readonly fonts: readonly { readonly name: string; readonly data: Uint8Array }[];
  /** How the blocks were found (`none` when the file has no text track, and nothing past its structure was read). */
  readonly via: 'cues' | 'walk' | 'none';
}

/**
 * Options of `extractMkvText`.
 * @internal
 */
export interface MkvExtractOptions {
  /** Called as the file is read with the position reached and the file's size. */
  onProgress?: (readBytes: number, totalBytes: number) => void;
  /** Aborts the read. */
  signal?: AbortSignal;
}

const ASS_IDS = new Set(['S_TEXT/ASS', 'S_TEXT/SSA', 'S_ASS', 'S_SSA']);
const SRT_IDS = new Set(['S_TEXT/UTF8', 'S_TEXT/ASCII']);
const TEXT = new TextDecoder();

function kindOf(t: MkvTrack): 'ass' | 'srt' | null {
  if (t.type !== 17) return null;
  if (ASS_IDS.has(t.codecId)) return t.codecPrivate ? 'ass' : null;
  return SRT_IDS.has(t.codecId) ? 'srt' : null;
}

/**
 * Reads the text subtitle tracks of the Matroska file `reader` gives access to, and its fonts, and
 * rebuilds each track as a whole ASS or SRT file. Reads through the Cues where they name every
 * subtitle block, else walks the clusters (`textTrackBlocks`). Rejects with `MkvReadError` for a
 * malformed file and with the signal's reason when it aborts.
 * @internal
 */
export async function extractMkvText(reader: RangeReader, opts: MkvExtractOptions = {}): Promise<MkvTextExtract> {
  const file = await openMatroska(reader, opts.signal);
  const wanted = file.tracks.flatMap((t) => {
    const kind = kindOf(t);
    return kind === null ? [] : [{ track: t, kind }];
  });
  if (wanted.length === 0) return { tracks: [], fonts: [], via: 'none' };
  const { blocks, via } = await textTrackBlocks(reader, wanted.map((w) => w.track.number), opts);
  const tracks = wanted.map(({ track, kind }) => {
    const own = blocks.filter((b) => b.track === track.number);
    const built = kind === 'ass' ? buildAss(track, own) : buildSrt(track, own);
    return {
      number: track.number,
      kind,
      name: track.name === '' ? null : track.name,
      language: track.language === '' ? null : track.language,
      isDefault: track.isDefault,
      isForced: track.isForced,
      dialogueLines: built.count,
      text: built.text,
    };
  });
  const fonts: { name: string; data: Uint8Array }[] = [];
  for (const a of fontAttachments(file.attachments)) {
    opts.signal?.throwIfAborted();
    fonts.push({ name: a.name, data: await a.data() });
  }
  return { tracks, fonts, via };
}

function durationOf(track: MkvTrack, block: MkvBlock): number | null {
  if (block.durationMs !== undefined) return block.durationMs;
  return track.defaultDurationNs === undefined ? null : Math.round(Number(track.defaultDurationNs) / 1e6);
}

function assTime(ms: number): string {
  const cs = Math.round(Math.max(0, ms) / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const p = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000), 2)}:${p(Math.floor((t % 3600000) / 60000), 2)}:${p(Math.floor((t % 60000) / 1000), 2)},${p(t % 1000, 3)}`;
}

function buildAss(track: MkvTrack, blocks: readonly MkvBlock[]): { text: string; count: number } {
  const lines: { order: number; line: string }[] = [];
  for (const b of blocks) {
    const dur = durationOf(track, b);
    if (dur === null) continue;
    // Eight commas end the fixed fields; the Text may hold more.
    const raw = TEXT.decode(b.data).replace(/\r?\n$/, '');
    const fields: string[] = [];
    let at = 0;
    for (let i = 0; i < 8; i++) {
      const c = raw.indexOf(',', at);
      if (c < 0) break;
      fields.push(raw.slice(at, c));
      at = c + 1;
    }
    if (fields.length < 8) continue;
    const order = Number(fields[0]);
    if (!Number.isFinite(order)) continue;
    const [, layer, style, name, ml, mr, mv, effect] = fields;
    lines.push({ order, line: `Dialogue: ${layer},${assTime(b.timeMs)},${assTime(b.timeMs + dur)},${style},${name},${ml},${mr},${mv},${effect},${raw.slice(at)}\n` });
  }
  lines.sort((a, b) => a.order - b.order);
  let header = TEXT.decode(track.codecPrivate!);
  if (!header.endsWith('\n')) header += '\n';
  return { text: header + lines.map((l) => l.line).join(''), count: lines.length };
}

function buildSrt(track: MkvTrack, blocks: readonly MkvBlock[]): { text: string; count: number } {
  const sorted = [...blocks].sort((a, b) => a.timeMs - b.timeMs);
  const cues = sorted.map((b, i) => {
    const dur = durationOf(track, b);
    const next = sorted[i + 1];
    const end = dur !== null ? b.timeMs + dur : next ? next.timeMs : b.timeMs + 2000;
    const body = TEXT.decode(b.data).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    return `${i + 1}\n${srtTime(b.timeMs)} --> ${srtTime(end)}\n${body}\n`;
  });
  return { text: cues.join('\n'), count: cues.length };
}

const MAX_NAME_BYTES = 255;
const byteLength = (s: string): number => new TextEncoder().encode(s).length;

function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[/\\\u0000-\u001f\u007f]/g, '_').trim();
}

function fit(s: string, maxBytes: number): string {
  let out = '';
  for (const ch of s) {
    if (byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * The name a rebuilt track is saved under: `<file base> [<n>] <name or language>.ass` (or `.srt`),
 * where the file base is the MKV's name without its folders and extension. Slashes and control
 * characters become underscores, and the base is cut so the whole name stays within 255 bytes.
 * @internal
 */
export function mkvTrackFileName(fileName: string, track: MkvTextTrack): string {
  const base = plain(fileName.replace(/\.[^.]*$/, ''));
  const label = fit(plain(track.name ?? track.language ?? ''), 64);
  const tail = ` [${track.number}]${label === '' ? '' : ` ${label}`}.${track.kind}`;
  return fit(base, MAX_NAME_BYTES - byteLength(tail)).trimEnd() + tail;
}
