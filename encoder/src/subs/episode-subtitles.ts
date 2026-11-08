// SPDX-License-Identifier: LGPL-3.0-or-later
/** The ASS subtitle tracks and font attachments of one episode's MKV, built from the saved subtitle record. */
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { retime } from '@seikou/fansubs/retime';
import type { FansubAlignment } from '@seikou/nas/nas-api';
import { assToMatroska } from '../mux/ass-track';
import type { MkvAttachment, MkvSubtitleTrack } from '../mux/mkv-writer';
import type { RecordTrack, SubtitleRecord } from './record';
import { readCachedRelease } from './release-cache';
import { decodeSubtitleText } from './srt-to-ass';

/**
 * Media types of font files by extension, as registered by RFC 8081 §4.4. A font with another
 * extension is attached as `application/octet-stream`.
 */
export const FONT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * The alignment `retime` (from `@seikou/fansubs`) applies to `track`'s script: its `split` parts when it has any,
 * else its `shiftMs` as one offset (0 for a track never lined up). The nudge is not part of it: the helper's preview
 * plays the backend's retimed copy and adds the nudge on top in milliseconds, so the encode does the same.
 */
export function trackAlignment(track: Pick<RecordTrack, 'shiftMs' | 'split'>): FansubAlignment {
  if (track.split !== null && track.split.length > 0) return { kind: 'split', parts: track.split, confidence: 1 };
  return { kind: 'offset', offsetMs: track.shiftMs, confidence: 1 };
}

/** What `episodeSubtitleTracks` gives the muxer for one episode. */
export interface EpisodeSubtitles {
  /** `S_TEXT/ASS` tracks, in the record's order. */
  tracks: MkvSubtitleTrack[];
  /** The release's fonts, in the record's order. */
  attachments: MkvAttachment[];
}

/** Gives a record's font attachments; see `recordFontLoader`. */
export type FontLoader = () => Promise<MkvAttachment[]>;

/**
 * A `FontLoader` for `record`'s `fonts` under the data directory `dataDir`: the first call reads every font, each
 * with its media type from `FONT_MEDIA_TYPES` and its file name from the cached release named by
 * `record.release.id` (the first name the release lists for that pooled file), else the pooled file's own name; every
 * later call gives the same attachments without reading again, so the episodes of one encode share one copy of each
 * font. A failed read is not kept: the next call reads again.
 */
export function recordFontLoader(record: SubtitleRecord, dataDir: string): FontLoader {
  let loaded: Promise<MkvAttachment[]> | null = null;
  return () => {
    loaded ??= readRecordFonts(record, dataDir).catch((err: unknown) => {
      loaded = null;
      throw err;
    });
    return loaded;
  };
}

async function readRecordFonts(record: SubtitleRecord, dataDir: string): Promise<MkvAttachment[]> {
  const release = record.release !== null ? await readCachedRelease(dataDir, record.release.id) : null;
  const names = new Map<string, string>();
  for (const f of release?.fonts ?? []) if (!names.has(f.path)) names.set(f.path, f.name);
  const attachments: MkvAttachment[] = [];
  for (const path of record.fonts) {
    attachments.push({
      name: names.get(path) ?? basename(path),
      mediaType: FONT_MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      data: await readFile(join(dataDir, path)),
    });
  }
  return attachments;
}

/**
 * Builds episode `episodeIndex`'s subtitle tracks and font attachments from `record`, reading the cached files under
 * the data directory `dataDir`. The episode lasts `durationMs` milliseconds from its first video frame, which is the
 * subtitles' zero, as in the helper's preview.
 *
 * Tracks: every track the user left ticked (`included`), in the record's order, as `S_TEXT/ASS` with the record's
 * name and language. Each is timed exactly as the helper previewed it: the script goes through `retime` with
 * `trackAlignment(track)` (the split part chosen by the event's start in the script, the times clamped at 0 and
 * rounded to centiseconds), then `nudgeMs` is added in milliseconds with no further rounding, and only then are
 * `assToMatroska`'s drop and clamp rules applied. The first track is the default; none is when nothing is ticked.
 * A `signs` track is marked forced (FlagForced), which is how the MKV keeps a track's kind for packaging.
 *
 * Attachments: the record's `fonts`, as `fonts` gives them (see `recordFontLoader`); pass one loader to every
 * episode of a record so the fonts are read once and shared. No fonts are attached, or read, when no track is.
 *
 * Throws when the record has no such episode, when a file cannot be read (the caller checks for missing files first)
 * and `SubtitleEncodingError` for a track that is not UTF-8 or UTF-16 with a BOM.
 */
export async function episodeSubtitleTracks(
  record: SubtitleRecord,
  episodeIndex: number,
  durationMs: number,
  dataDir: string,
  fonts: FontLoader = recordFontLoader(record, dataDir),
): Promise<EpisodeSubtitles> {
  const episode = record.episodes.find((e) => e.index === episodeIndex);
  if (episode === undefined) throw new Error(`the subtitle record holds no episode ${episodeIndex}`);

  const tracks: MkvSubtitleTrack[] = [];
  for (const t of episode.tracks.filter((track) => track.included)) {
    const aligned = retime(decodeSubtitleText(await readFile(join(dataDir, t.file))), trackAlignment(t));
    const { codecPrivate, blocks } = assToMatroska(aligned, durationMs, () => t.nudgeMs);
    tracks.push({ codecId: 'S_TEXT/ASS', name: t.name, language: t.language, isDefault: tracks.length === 0, isForced: t.kind === 'signs', codecPrivate, blocks });
  }
  if (tracks.length === 0) return { tracks, attachments: [] };
  return { tracks, attachments: await fonts() };
}
