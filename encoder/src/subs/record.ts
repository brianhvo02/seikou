// SPDX-License-Identifier: LGPL-3.0-or-later
/** The saved subtitle record: what the user chose for one disc playlist, kept for the encode to read. */
import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDiscKey } from '@seikou/nas/disc-key';
import { replaceAtomically } from '@seikou/titles';
import type { TrackKind } from './release-match';

/** One subtitle track of an episode. Array order in `RecordEpisode.tracks` is the MKV track order. */
export interface RecordTrack {
  /** Path of the track's ASS file, relative to the data directory. */
  file: string;
  /** Whether the track holds all dialogue or only signs and songs. */
  kind: TrackKind;
  /** ISO 639-2 three-letter language code. */
  language: string;
  /** Track name shown in players. */
  name: string;
  /** Shift found by alignment, in milliseconds. */
  shiftMs: number;
  /** The user's extra adjustment on top of `shiftMs`, in milliseconds. */
  nudgeMs: number;
  /** Per-segment offsets for a track that needs a split: from `fromMs` on, use `offsetMs`. Null when none. */
  split: { fromMs: number; offsetMs: number }[] | null;
  /** The metadata panel's tick: false when the user unticked the track. */
  included: boolean;
}

/** The container-level metadata the user edited for one episode. */
export interface RecordMetadata {
  /** Title of the MKV. */
  title: string;
  /** Name and language of the video track. */
  video: { name: string; language: string };
  /** Audio streams in MKV order, keyed by the playlist's PID. */
  audio: { pid: number; name: string; language: string; included: boolean }[];
  /** Chapter names, in chapter order. */
  chapters: string[];
}

/** One episode cut from the playlist. */
export interface RecordEpisode {
  /** 1-based position among the episodes of the playlist; unique within the record. */
  index: number;
  /** Episode title. */
  title: string;
  /** Subtitle tracks in MKV order; the first of each kind is the default. */
  tracks: RecordTrack[];
  /** The metadata panel's values. */
  metadata: RecordMetadata;
}

/** Everything saved for one disc and playlist. All paths are relative to the data directory. */
export interface SubtitleRecord {
  /** The disc's key and a human label. */
  disc: { key: string; label: string };
  /** The playlist's id, such as `00000`. */
  playlist: string;
  /** The episode spec the encode was planned with, such as `1-4,5-8`. */
  episodeSpec: string;
  /** The show picked on AniList, and how many episodes the release numbers ahead of the disc. */
  anilist: { id: number; title: string; episodeOffset: number } | null;
  /** The chosen release; null when the user supplied no release. */
  release: { source: 'seadex' | 'tosho' | 'local'; id: string; group: string; label: string } | null;
  /** Font files used by the tracks. */
  fonts: string[];
  /** The episodes, in `index` order of the user's choosing. */
  episodes: RecordEpisode[];
  /** When the record was saved, as an ISO 8601 UTC string, set by the caller. */
  savedAt: string;
}

/** A record failed validation or could not be parsed; the message starts with the JSON path of the first bad field. */
export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

function bad(path: string, why: string): never {
  throw new RecordError(`${path}: ${why}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad(path, 'expected an object');
  return v as Record<string, unknown>;
}
function str(v: unknown, path: string): string {
  return typeof v === 'string' ? v : bad(path, 'expected a string');
}
function arr(v: unknown, path: string): unknown[] {
  return Array.isArray(v) ? v : bad(path, 'expected an array');
}
function num(v: unknown, path: string): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : bad(path, 'expected a finite number');
}
function bool(v: unknown, path: string): boolean {
  return typeof v === 'boolean' ? v : bad(path, 'expected true or false');
}
function lang(v: unknown, path: string): string {
  const s = str(v, path);
  return /^[a-z]{3}$/.test(s) ? s : bad(path, 'expected an ISO 639-2 three-letter code');
}
function checkedDiscKey(v: unknown, path: string): string {
  const s = str(v, path);
  return parseDiscKey(s) ? s : bad(path, 'expected a disc key (f.<32 hex> or d.<16 hex>)');
}
function playlistId(v: unknown, path: string): string {
  const s = str(v, path);
  return /^\d{5}$/.test(s) ? s : bad(path, 'expected a five-digit playlist id');
}
function relPath(v: unknown, path: string): string {
  const s = str(v, path);
  if (s === '' || s.startsWith('/') || s.startsWith('\\') || /^[a-zA-Z]:/.test(s)) {
    return bad(path, 'expected a path relative to the data directory');
  }
  if (s.split(/[\\/]/).includes('..')) return bad(path, 'the path must not contain ..');
  return s;
}

function parseTrack(v: unknown, path: string): RecordTrack {
  const o = obj(v, path);
  const kind = o.kind;
  if (kind !== 'full' && kind !== 'signs') bad(`${path}.kind`, 'expected "full" or "signs"');
  let split: RecordTrack['split'] = null;
  if (o.split !== null) {
    split = arr(o.split, `${path}.split`).map((s, i) => {
      const so = obj(s, `${path}.split[${i}]`);
      return {
        fromMs: num(so.fromMs, `${path}.split[${i}].fromMs`),
        offsetMs: num(so.offsetMs, `${path}.split[${i}].offsetMs`),
      };
    });
  }
  return {
    file: relPath(o.file, `${path}.file`),
    kind: kind as TrackKind,
    language: lang(o.language, `${path}.language`),
    name: str(o.name, `${path}.name`),
    shiftMs: num(o.shiftMs, `${path}.shiftMs`),
    nudgeMs: num(o.nudgeMs, `${path}.nudgeMs`),
    split,
    included: bool(o.included, `${path}.included`),
  };
}

function parseMetadata(v: unknown, path: string): RecordMetadata {
  const o = obj(v, path);
  const video = obj(o.video, `${path}.video`);
  return {
    title: str(o.title, `${path}.title`),
    video: { name: str(video.name, `${path}.video.name`), language: lang(video.language, `${path}.video.language`) },
    audio: arr(o.audio, `${path}.audio`).map((a, i) => {
      const p = `${path}.audio[${i}]`;
      const ao = obj(a, p);
      return {
        pid: num(ao.pid, `${p}.pid`),
        name: str(ao.name, `${p}.name`),
        language: lang(ao.language, `${p}.language`),
        included: bool(ao.included, `${p}.included`),
      };
    }),
    chapters: arr(o.chapters, `${path}.chapters`).map((c, i) => str(c, `${path}.chapters[${i}]`)),
  };
}

/**
 * Validates parsed JSON as a record and returns it as a clean copy. Throws `RecordError` naming the JSON path
 * of the first bad field. Checks that languages are three lowercase letters, shifts are finite, episode
 * indexes are positive integers and unique, and every path is relative to the data directory without `..`.
 */
export function parseRecord(json: unknown): SubtitleRecord {
  const o = obj(json, '$');
  const disc = obj(o.disc, 'disc');
  let anilist: SubtitleRecord['anilist'] = null;
  if (o.anilist !== null) {
    const a = obj(o.anilist, 'anilist');
    anilist = {
      id: num(a.id, 'anilist.id'),
      title: str(a.title, 'anilist.title'),
      episodeOffset: num(a.episodeOffset, 'anilist.episodeOffset'),
    };
  }
  let release: SubtitleRecord['release'] = null;
  if (o.release !== null) {
    const r = obj(o.release, 'release');
    const source = r.source;
    if (source !== 'seadex' && source !== 'tosho' && source !== 'local') {
      bad('release.source', 'expected "seadex", "tosho" or "local"');
    }
    release = {
      source: source as 'seadex' | 'tosho' | 'local',
      id: str(r.id, 'release.id'),
      group: str(r.group, 'release.group'),
      label: str(r.label, 'release.label'),
    };
  }
  const seen = new Set<number>();
  const episodes = arr(o.episodes, 'episodes').map((e, i): RecordEpisode => {
    const p = `episodes[${i}]`;
    const eo = obj(e, p);
    const index = num(eo.index, `${p}.index`);
    if (!Number.isInteger(index) || index < 1) bad(`${p}.index`, 'expected a 1-based integer');
    if (seen.has(index)) bad(`${p}.index`, `episode ${index} appears twice`);
    seen.add(index);
    return {
      index,
      title: str(eo.title, `${p}.title`),
      tracks: arr(eo.tracks, `${p}.tracks`).map((t, j) => parseTrack(t, `${p}.tracks[${j}]`)),
      metadata: parseMetadata(eo.metadata, `${p}.metadata`),
    };
  });
  return {
    disc: { key: checkedDiscKey(disc.key, 'disc.key'), label: str(disc.label, 'disc.label') },
    playlist: playlistId(o.playlist, 'playlist'),
    episodeSpec: str(o.episodeSpec, 'episodeSpec'),
    anilist,
    release,
    fonts: arr(o.fonts, 'fonts').map((f, i) => relPath(f, `fonts[${i}]`)),
    episodes,
    savedAt: str(o.savedAt, 'savedAt'),
  };
}

/** Group name `missingFiles` uses for files of a record that names no release. */
export const OWN_FILES_LABEL = 'your own files';

/** Reads and writes records under `<dataDir>/subtitles/<discKey>/<playlist>.json`. */
export class RecordStore {
  /** @param dataDir the app data directory; record paths are relative to it. */
  constructor(private readonly dataDir: string) {}

  /** The file a disc's playlist record lives in. Throws `RecordError` unless the key is a disc key and the playlist a five-digit id, so no segment can leave `subtitles/`. */
  path(discKey: string, playlist: string): string {
    checkedDiscKey(discKey, 'discKey');
    playlistId(playlist, 'playlist');
    return join(this.dataDir, 'subtitles', discKey, `${playlist}.json`);
  }

  /** Returns the saved record, or null when none was saved. A file that is not valid JSON or fails validation throws `RecordError`. */
  async read(discKey: string, playlist: string): Promise<SubtitleRecord | null> {
    let text: string;
    try {
      text = await readFile(this.path(discKey, playlist), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RecordError('$: the saved record is not valid JSON');
    }
    return parseRecord(json);
  }

  /** Validates and saves the record, replacing any earlier file atomically. The caller sets `savedAt`. */
  async write(record: SubtitleRecord): Promise<void> {
    const valid = parseRecord(record);
    const file = this.path(valid.disc.key, valid.playlist);
    await mkdir(dirname(file), { recursive: true });
    replaceAtomically(file, `${JSON.stringify(valid, null, 2)}\n`);
  }

  /**
   * Lists the record's fonts and track files that are no longer under the data directory, grouped under
   * the release's label. A record with `release: null` groups them under "your own files". Empty when
   * nothing is missing.
   */
  async missingFiles(record: SubtitleRecord): Promise<{ release: string; files: string[] }[]> {
    const wanted = [...record.fonts, ...record.episodes.flatMap((e) => e.tracks.map((t) => t.file))];
    const missing: string[] = [];
    for (const file of new Set(wanted)) {
      try {
        await access(join(this.dataDir, file));
      } catch {
        missing.push(file);
      }
    }
    return missing.length === 0 ? [] : [{ release: record.release?.label ?? OWN_FILES_LABEL, files: missing }];
  }
}
