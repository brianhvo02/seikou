// SPDX-License-Identifier: LGPL-3.0-or-later
/** The ASS subtitle tracks and font attachments of one episode's MKV, built from the saved subtitle record. */
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
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
 * The offset in milliseconds to add to an event of `track` that starts at `startMs` in the script: the track's
 * alignment (the `split` part whose `fromMs` is the latest at or before the start, 0 before the first part; else
 * `shiftMs`) plus `nudgeMs`. Positive moves the event later. This is the rule `retime` in `@seikou/fansubs` applies
 * (the helper's preview runs the alignment and then the nudge through it), summed into one offset so the times are
 * rounded once, to whole milliseconds, instead of to centiseconds at each step.
 */
export function trackOffset(track: Pick<RecordTrack, 'shiftMs' | 'nudgeMs' | 'split'>): (startMs: number) => number {
  if (track.split !== null && track.split.length > 0) {
    const parts = [...track.split].sort((a, b) => a.fromMs - b.fromMs);
    return (startMs) => {
      let offset = 0;
      for (const p of parts) if (p.fromMs <= startMs) offset = p.offsetMs;
      return offset + track.nudgeMs;
    };
  }
  const offset = track.shiftMs + track.nudgeMs;
  return () => offset;
}

/** What `episodeSubtitleTracks` gives the muxer for one episode. */
export interface EpisodeSubtitles {
  /** `S_TEXT/ASS` tracks, in the record's order. */
  tracks: MkvSubtitleTrack[];
  /** The release's fonts, in the record's order. */
  attachments: MkvAttachment[];
}

/**
 * Builds episode `episodeIndex`'s subtitle tracks and font attachments from `record`, reading the cached files under
 * the data directory `dataDir`. The episode lasts `durationMs` milliseconds from its first video frame, which is the
 * subtitles' zero, as in the helper's preview.
 *
 * Tracks: every track the user left ticked (`included`), in the record's order, as `S_TEXT/ASS` with the record's
 * name and language, timed by `trackOffset` and cut to the episode by `assToMatroska`'s rules. The first is the
 * default track; none is when nothing is ticked.
 *
 * Attachments: the record's `fonts`, each with its media type from `FONT_MEDIA_TYPES` and its file name from the
 * cached release named by `record.release.id` (the first name the release lists for that pooled file), else the
 * pooled file's own name. No fonts are attached when no track is.
 *
 * Throws when the record has no such episode, when a file cannot be read (the caller checks for missing files first)
 * and `SubtitleEncodingError` for a track that is not UTF-8 or UTF-16 with a BOM.
 */
export async function episodeSubtitleTracks(
  record: SubtitleRecord,
  episodeIndex: number,
  durationMs: number,
  dataDir: string,
): Promise<EpisodeSubtitles> {
  const episode = record.episodes.find((e) => e.index === episodeIndex);
  if (episode === undefined) throw new Error(`the subtitle record holds no episode ${episodeIndex}`);

  const tracks: MkvSubtitleTrack[] = [];
  for (const t of episode.tracks.filter((track) => track.included)) {
    const script = decodeSubtitleText(await readFile(join(dataDir, t.file)));
    const { codecPrivate, blocks } = assToMatroska(script, durationMs, trackOffset(t));
    tracks.push({ codecId: 'S_TEXT/ASS', name: t.name, language: t.language, isDefault: tracks.length === 0, codecPrivate, blocks });
  }
  if (tracks.length === 0) return { tracks, attachments: [] };

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
  return { tracks, attachments };
}
