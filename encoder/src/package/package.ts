// SPDX-License-Identifier: LGPL-3.0-or-later
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { readMkv, type ParsedMkv } from '../mux/mkv-reader';
import type { MkvAttachment, SubtitleBlock } from '../mux/mkv-writer';
import { toSup } from './sup';
import { toVtt } from './vtt';
import { webmTracks, writeWebm } from './webm';

/**
 * `episode.json`, the manifest of a packaged episode directory. Every `file` is a path relative to
 * the directory, with `/` separators.
 */
export interface EpisodeManifest {
  /** The MKV's title (its Info Title), else the MKV's file name without its extension. */
  title: string;
  /** Always `video.webm`; its coded picture size in pixels. */
  video: { file: string; width: number; height: number };
  /** The WebM's audio tracks in order; `index` is the 0-based position among them, as a player's audio track list counts it. */
  audio: { index: number; name: string; language: string; default: boolean }[];
  /** The ASS files, in the MKV's track order. */
  subtitles: { file: string; name: string; language: string; default: boolean }[];
  /** The `.sup` files, in the MKV's track order. */
  pgs: { file: string; name: string; language: string }[];
  /** The font files (`fonts/<file>`), in the MKV's attachment order. */
  fonts: string[];
  /** Always `chapters.vtt`. */
  chapters: string;
}

/**
 * Thrown when an MKV holds something packaging cannot turn into files, such as an `S_TEXT/ASS` block
 * that is not a Matroska ASS event, or when the output path holds something other than a package.
 */
export class PackageError extends Error {}

const EVENT_FORMAT = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);

/** Font media types: RFC 8081's `font/*`, and the older names other muxers write. */
const LEGACY_FONT_TYPES = new Set([
  'application/x-truetype-font',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/vnd.ms-opentype',
  'application/font-sfnt',
  'application/font-woff',
]);

function isFont(a: MkvAttachment): boolean {
  const type = a.mediaType.toLowerCase();
  return type.startsWith('font/') || LEGACY_FONT_TYPES.has(type) || FONT_EXTENSIONS.has(extname(a.name).toLowerCase());
}

const MAX_NAME_BYTES = 200;

/**
 * A file name safe to write inside the directory: separators and control characters become `_`,
 * leading dots go, and a name over 200 bytes of UTF-8 keeps its last whole code points that fit (so
 * the extension stays), never splitting one. `fallback` stands in for a name left empty.
 */
export function safeName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '');
  const points = Array.from(cleaned);
  let bytes = 0;
  let from = points.length;
  while (from > 0) {
    const size = Buffer.byteLength(points[from - 1]!, 'utf8');
    if (bytes + size > MAX_NAME_BYTES) break;
    bytes += size;
    from--;
  }
  const kept = points.slice(from).join('').replace(/^\.+/, '');
  return kept === '' ? fallback : kept;
}

function languageTag(language: string): string {
  const tag = language.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return tag === '' ? 'und' : tag;
}

// ASS times are H:MM:SS.cc, centiseconds; a Matroska time in milliseconds is rounded to the nearest one.
function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360_000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

/**
 * Rebuilds an ASS script from an `S_TEXT/ASS` track (Matroska codec specification, "SSA/ASS"
 * subtitles): `codecPrivate` is the script without its events, and each block holds one event as
 * `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`, its start being the block's
 * time and its end the time plus BlockDuration. The events become Dialogue lines in ReadOrder order
 * (the script's own order), with times rounded to centiseconds, placed right after the `[Events]`
 * section's Format line, which is expected to read `Layer, Start, End, ...` (a section and Format
 * line are added when the header has none). Lines end as the header's do. Throws `PackageError` for
 * a block with fewer than nine fields or a ReadOrder that is not a number.
 */
export function rebuildAss(codecPrivate: Uint8Array, blocks: readonly SubtitleBlock[]): string {
  const header = new TextDecoder().decode(codecPrivate).replace(/^﻿/, '');
  const eol = header.includes('\r\n') ? '\r\n' : '\n';
  const decoder = new TextDecoder();
  const events = blocks.map((b, i) => {
    const text = decoder.decode(b.data);
    const fields: string[] = [];
    let from = 0;
    for (let k = 0; k < 8; k++) {
      const comma = text.indexOf(',', from);
      if (comma < 0) throw new PackageError(`ASS block ${i + 1} at ${b.timeMs} ms has fewer than nine fields`);
      fields.push(text.slice(from, comma));
      from = comma + 1;
    }
    fields.push(text.slice(from));
    const order = Number(fields[0]);
    if (fields[0]!.trim() === '' || !Number.isFinite(order)) throw new PackageError(`ASS block ${i + 1} at ${b.timeMs} ms has no ReadOrder`);
    const [, layer, ...rest] = fields;
    const line = `Dialogue: ${layer},${assTime(b.timeMs)},${assTime(b.timeMs + (b.durationMs ?? 0))},${rest.join(',')}`;
    return { order, i, line };
  });
  events.sort((a, b) => a.order - b.order || a.i - b.i);
  const dialogue = events.map((e) => e.line + eol);

  const lines = header.split(/(?<=\r\n|\n|\r)/);
  const eventsAt = lines.findIndex((l) => /^\s*\[events\]/i.test(l));
  if (eventsAt < 0) {
    const sep = header === '' || /[\r\n]$/.test(header) ? '' : eol;
    return `${header}${sep}[Events]${eol}${EVENT_FORMAT}${eol}${dialogue.join('')}`;
  }
  let formatAt = -1;
  for (let k = eventsAt + 1; k < lines.length && !/^\s*\[/.test(lines[k]!); k++) {
    if (/^Format\s*:/i.test(lines[k]!)) {
      formatAt = k;
      break;
    }
  }
  const insertAt = formatAt >= 0 ? formatAt + 1 : eventsAt + 1;
  const before = lines.slice(0, insertAt);
  if (formatAt < 0) {
    const sectionLine = before[before.length - 1]!;
    if (!/[\r\n]$/.test(sectionLine)) before[before.length - 1] = sectionLine + eol;
    before.push(EVENT_FORMAT + eol);
  }
  const last = before[before.length - 1]!;
  if (!/[\r\n]$/.test(last)) before[before.length - 1] = last + eol;
  return [...before, ...dialogue, ...lines.slice(insertAt)].join('');
}

/**
 * One pass over the blocks: the subtitle blocks of every ASS and PGS track, copied out of the
 * clusters, the number of blocks of every track (which the WebM remux needs) and the end of the
 * latest block of any track.
 */
async function scanBlocks(
  mkv: ParsedMkv,
  tracks: ReadonlySet<number>,
): Promise<{ blocks: Map<number, SubtitleBlock[]>; counts: Map<number, number>; endMs: number }> {
  const blocks = new Map<number, SubtitleBlock[]>();
  for (const t of tracks) blocks.set(t, []);
  const counts = new Map<number, number>();
  let endMs = 0;
  for await (const b of mkv.blocks()) {
    counts.set(b.track, (counts.get(b.track) ?? 0) + 1);
    endMs = Math.max(endMs, b.timeMs + (b.durationMs ?? 0));
    const list = blocks.get(b.track);
    if (list === undefined) continue;
    list.push({ timeMs: b.timeMs, ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}), data: new Uint8Array(b.data) });
  }
  return { blocks, counts, endMs };
}

/**
 * Refuses an output path that packaging must not replace: anything but a missing path, an empty
 * directory or a directory holding an `episode.json` (an earlier package of an episode).
 */
async function checkReplaceable(outDir: string): Promise<void> {
  let isDirectory: boolean;
  try {
    isDirectory = (await lstat(outDir)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!isDirectory) throw new PackageError(`${outDir} exists and is not a directory; refusing to replace it`);
  const entries = await readdir(outDir);
  if (entries.length > 0 && !entries.includes('episode.json')) {
    throw new PackageError(`${outDir} is not empty and holds no episode.json, so it is not a packaged episode; refusing to replace it`);
  }
}

async function* iterate<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}

/**
 * Packages the episode MKV at `mkvPath` for the web player into the directory `outDir`:
 *
 * - `video.webm`: the AV1 track and every Opus track, with chapters (see `writeWebm`);
 * - `subs/<n>-<lang>-<kind>.ass`: each `S_TEXT/ASS` track rebuilt as a script (see `rebuildAss`),
 *   `n` counting the ASS tracks from 1, `lang` its Language, `kind` `signs` for a forced track
 *   (FlagForced, RFC 9559 §5.1.4.1.6) and `full` otherwise;
 * - `fonts/<file>`: every font attachment under its own file name (made safe, and made unique with a
 *   `-2`, `-3` suffix); other attachments are left out;
 * - `pgs/<n>-<lang>.sup`: each `S_HDMV/PGS` track as a `.sup` file (see `toSup`);
 * - `chapters.vtt`: the chapters as WebVTT (see `toVtt`), ending at the MKV's Duration;
 * - `episode.json`: the `EpisodeManifest`, which it also returns.
 *
 * Other tracks (another video codec, other audio or subtitle codecs) are left out. The MKV is read
 * twice, one cluster at a time; only the subtitle blocks are held in memory. The directory is built
 * beside `outDir` under a temporary name and moved into place when complete. An existing `outDir`
 * is replaced only when it is an empty directory or holds an `episode.json` (an earlier package);
 * anything else is refused with `PackageError` before anything is written. On any failure the
 * temporary directory is removed, and a failure before the move leaves an existing `outDir` as it
 * was.
 * Throws `NotMatroskaError` or `MkvReadError` (from `readMkv`) before anything is written,
 * `WebmError` when there is no AV1 track, `PackageError` or `SupError` for an unreadable subtitle
 * block, and any file system error.
 */
export async function packageEpisode(mkvPath: string, outDir: string): Promise<EpisodeManifest> {
  await checkReplaceable(outDir);
  const mkv = await readMkv(mkvPath);
  const { video, audio } = webmTracks(mkv);
  const ass = mkv.tracks.filter((t) => t.codecId === 'S_TEXT/ASS');
  const pgs = mkv.tracks.filter((t) => t.codecId === 'S_HDMV/PGS');

  await mkdir(dirname(outDir), { recursive: true });
  const tmp = await mkdtemp(join(dirname(outDir), `.${basename(outDir)}.partial-`));
  try {
    const { blocks, counts, endMs } = await scanBlocks(mkv, new Set([...ass, ...pgs].map((t) => t.number)));
    const durationMs = Math.round(mkv.durationMs ?? endMs);

    const subtitles: EpisodeManifest['subtitles'] = [];
    if (ass.length > 0) await mkdir(join(tmp, 'subs'));
    for (const [i, t] of ass.entries()) {
      const file = `subs/${i + 1}-${languageTag(t.language)}-${t.isForced ? 'signs' : 'full'}.ass`;
      await writeFile(join(tmp, file), rebuildAss(t.codecPrivate ?? new Uint8Array(0), blocks.get(t.number)!));
      subtitles.push({ file, name: t.name, language: t.language, default: t.isDefault });
    }

    const pgsFiles: EpisodeManifest['pgs'] = [];
    if (pgs.length > 0) await mkdir(join(tmp, 'pgs'));
    for (const [i, t] of pgs.entries()) {
      const file = `pgs/${i + 1}-${languageTag(t.language)}.sup`;
      await writeFile(join(tmp, file), await toSup(iterate(blocks.get(t.number)!)));
      pgsFiles.push({ file, name: t.name, language: t.language });
    }

    const fonts: string[] = [];
    const taken = new Set<string>();
    const fontFiles = mkv.attachments.filter(isFont);
    if (fontFiles.length > 0) await mkdir(join(tmp, 'fonts'));
    for (const [i, a] of fontFiles.entries()) {
      const name = safeName(a.name, `font-${i + 1}`);
      const ext = extname(name);
      let unique = name;
      for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
      taken.add(unique.toLowerCase());
      await writeFile(join(tmp, 'fonts', unique), a.data);
      fonts.push(`fonts/${unique}`);
    }

    await writeFile(join(tmp, 'chapters.vtt'), toVtt(mkv.chapters, durationMs));
    await writeWebm(mkv, join(tmp, 'video.webm'), { blockCounts: counts });

    const manifest: EpisodeManifest = {
      title: mkv.title ?? basename(mkvPath, extname(mkvPath)),
      video: { file: 'video.webm', width: video.video?.width ?? 0, height: video.video?.height ?? 0 },
      audio: audio.map((t, index) => ({ index, name: t.name, language: t.language, default: t.isDefault })),
      subtitles,
      pgs: pgsFiles,
      fonts,
      chapters: 'chapters.vtt',
    };
    await writeFile(join(tmp, 'episode.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await checkReplaceable(outDir);
    await rm(outDir, { recursive: true, force: true });
    await rename(tmp, outDir);
    return manifest;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
