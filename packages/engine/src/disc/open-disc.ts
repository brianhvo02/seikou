import { parseBdid, type BdidData } from '@seikou/bdmv/bdid-parser';
import { parseClpi, type Clpi } from '@seikou/bdmv/clpi-parser';
import { indexUsesBdj, parseIndex, type IndexBdmv } from '@seikou/bdmv/index-parser';
import { parseMovieObjects, type MovieObjects } from '@seikou/bdmv/mobj-parser';
import { MarkType, parseMpls, type Mpls } from '@seikou/bdmv/mpls-parser';
import { parseSoundBdmv, type SoundData } from '@seikou/bdmv/sound-parser';
import { ALIGNED_UNIT_SIZE, SOURCE_PACKET_SIZE } from '@seikou/bdmv/demux/constants';
import { ParseError } from '@seikou/bdmv/byte-reader';
import { ticks45ToUs } from '../util/time';
import { DiscError, readWhole, type ByteSource } from '@seikou/bdmv/byte-source';
import { chooseMainTitle, hasRepeatedSegments } from './main-title';

const INDEX_PATH = 'BDMV/INDEX.BDMV';
const MOVIE_OBJECT_PATH = 'BDMV/MOVIEOBJECT.BDMV';
const SOUND_PATH = 'BDMV/AUXDATA/SOUND.BDMV';
/** bdid_get: id.bdmv, then its backup. */
const BDID_PATHS = ['CERTIFICATE/ID.BDMV', 'CERTIFICATE/BACKUP/ID.BDMV'];

/** The disc path of playlist `id` (its file name without extension, such as `00001`). Paths are upper case, as `FileSource` keys them. */
export const playlistPath = (id: string): string => `BDMV/PLAYLIST/${id}.MPLS`;
/** The disc path of clip `clipId`'s CLPI file (clip information: stream attributes and the EP map). */
export const clipInfoPath = (clipId: string): string => `BDMV/CLIPINF/${clipId}.CLPI`;
/** The disc path of clip `clipId`'s M2TS file (the transport stream). */
export const streamPath = (clipId: string): string => `BDMV/STREAM/${clipId}.M2TS`;

/** What the title picker needs to know about one playlist (MPLS file) without parsing it again. */
export interface PlaylistSummary {
  /** The MPLS file name without extension, such as `00001`. */
  readonly id: string;
  /** Sum of the play items' out minus in times, in microseconds. */
  readonly durationUs: number;
  /** Number of chapter (entry) marks. */
  readonly chapterCount: number;
  /** The distinct clips its play items use, in first-use order. */
  readonly clipIds: readonly string[];
  /** Its first play item has a video stream and every clip's CLPI and M2TS file exist. */
  readonly playable: boolean;
  /** The CLPI and M2TS paths of its clips that are not on the disc. */
  readonly missingPaths: readonly string[];
  /** Plays one segment more than twice (a maze or loop playlist); never chosen as the main feature. */
  readonly looped: boolean;
}

/** Everything the engine reads from a disc's metadata files when it opens it. */
export interface DiscModel {
  /** The parsed `index.bdmv`: the titles and their objects. */
  readonly index: IndexBdmv;
  /** The index names a BD-J object (`indexUsesBdj`). */
  readonly usesBdj: boolean;
  /** Every playlist that parsed, by id (MPLS file name without extension). */
  readonly playlists: ReadonlyMap<string, Mpls>;
  /** The main feature first (libbluray's choice among playable playlists), then the rest longest first, loops last. */
  readonly summaries: readonly PlaylistSummary[];
  /** CLPI of every clip the playlists use, for the HDMV navigator's packet positions; empty for discs without MovieObject.bdmv. */
  readonly clips: ReadonlyMap<string, Clpi>;
  /** null when MovieObject.bdmv is missing or damaged. */
  readonly movieObjects: MovieObjects | null;
  /** BDMV/AUXDATA/sound.bdmv (menu sounds); null when absent or damaged. */
  readonly sounds: SoundData | null;
  /** Problems that did not stop the open, such as a playlist that failed to parse. */
  readonly warnings: readonly string[];
}

/**
 * Reads a disc's metadata: `index.bdmv`, every playlist, `MovieObject.bdmv` (with the CLPI files its navigator needs),
 * the menu sounds and the disc id, then checks that the main playlist's first clip is readable. Reads are issued
 * together. It throws `DiscError` with code `not-bdmv` (no index or no playlists, or a damaged index), `encrypted` or
 * `unreadable-stream` (the main clip's packets are not clear MPEG-TS), and passes on a failed read of the source. A
 * damaged playlist or `MovieObject.bdmv` becomes a warning; damaged menu sounds or clip info are skipped silently.
 * Runs on the engine worker.
 */
export async function openDisc(source: ByteSource): Promise<DiscModel> {
  const playlistFiles = source.list('BDMV/PLAYLIST').filter((name) => name.endsWith('.MPLS'));
  const missing: string[] = [];
  if (!source.exists(INDEX_PATH)) missing.push(INDEX_PATH);
  if (playlistFiles.length === 0) missing.push('BDMV/PLAYLIST/*.MPLS');
  if (missing.length > 0) throw new DiscError('not-bdmv', 'This folder is not a Blu-ray (BDMV) backup.', missing);

  let index: IndexBdmv;
  try {
    index = parseIndex(await readWhole(source, INDEX_PATH));
  } catch (err) {
    if (err instanceof ParseError) throw new DiscError('not-bdmv', `index.bdmv is damaged: ${err.message}`, [INDEX_PATH]);
    throw err;
  }

  const playlists = new Map<string, Mpls>();
  const warnings: string[] = [];
  // all reads go out at once (a disc can have hundreds of small files); parsing stays in name order
  const ids = playlistFiles.map((name) => name.slice(0, -'.MPLS'.length));
  const playlistBytes = await readAllInOrder(source, ids.map(playlistPath));
  for (const [i, id] of ids.entries()) {
    try {
      playlists.set(id, parseMpls(playlistBytes[i]!));
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      warnings.push(`Skipped playlist ${id}: ${err.message}`);
    }
  }

  let movieObjects: MovieObjects | null = null;
  if (source.exists(MOVIE_OBJECT_PATH)) {
    try {
      movieObjects = parseMovieObjects(await readWhole(source, MOVIE_OBJECT_PATH));
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      warnings.push(`MovieObject.bdmv is damaged and was ignored: ${err.message}`);
    }
  }

  let sounds: SoundData | null = null;
  if (source.exists(SOUND_PATH)) {
    try {
      sounds = parseSoundBdmv(await readWhole(source, SOUND_PATH));
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
    }
  }

  const usesBdj = indexUsesBdj(index);

  const clips = new Map<string, Clpi>();
  if (movieObjects) {
    const clipIds = [...new Set([...playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)))].filter((id) => source.exists(clipInfoPath(id)));
    const clipBytes = await readAllInOrder(source, clipIds.map(clipInfoPath));
    for (const [i, clipId] of clipIds.entries()) {
      try {
        clips.set(clipId, parseClpi(clipBytes[i]!));
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
      }
    }
  }

  const all = [...playlists].map(([id, mpls]) => summarize(source, id, mpls));
  const mainId = chooseMainTitle(all.filter((s) => s.playable).map((s) => ({ id: s.id, mpls: playlists.get(s.id) as Mpls })));
  const rank = (s: PlaylistSummary): number => (s.id === mainId ? 0 : s.looped ? 2 : 1);
  const summaries = all.sort((a, b) => rank(a) - rank(b) || b.durationUs - a.durationUs || a.id.localeCompare(b.id));
  const main = summaries.find((s) => s.playable);
  if (main) await checkStreamReadable(source, main.clipIds[0]);
  return { index, usesBdj, playlists, summaries, clips, movieObjects, sounds, warnings };
}

/**
 * index.bdmv read ahead of openDisc, so BD-J can start loading meanwhile; null when it is missing or damaged (openDisc
 * reports that).
 */
export async function peekIndex(source: ByteSource): Promise<IndexBdmv | null> {
  try {
    return source.exists(INDEX_PATH) ? parseIndex(await readWhole(source, INDEX_PATH)) : null;
  } catch {
    return null;
  }
}

/** bdid_get: the first of id.bdmv and its backup that reads and parses (bdj_org_id and bdj_disc_id); null when neither does. */
export async function readBdid(source: ByteSource): Promise<BdidData | null> {
  for (const path of BDID_PATHS) {
    if (!source.exists(path)) continue;
    try {
      return parseBdid(await readWhole(source, path));
    } catch {
      // libbluray's _bdid_get returns NULL on any failure and bdid_get tries the next file
    }
  }
  return null;
}

function summarize(source: ByteSource, id: string, mpls: Mpls): PlaylistSummary {
  const clipIds = [...new Set(mpls.playItems.map((p) => p.clipId))];
  const missingPaths = clipIds.flatMap((c) => [clipInfoPath(c), streamPath(c)]).filter((p) => !source.exists(p));
  const duration45 = mpls.playItems.reduce((sum, p) => sum + Math.max(0, p.outTime - p.inTime), 0);
  const hasVideo = mpls.playItems.length > 0 && mpls.playItems[0].stn.video.some((v) => !v.subPath);
  return {
    id,
    durationUs: ticks45ToUs(duration45),
    chapterCount: mpls.marks.filter((m) => m.type === MarkType.ENTRY).length,
    clipIds,
    playable: hasVideo && missingPaths.length === 0,
    missingPaths,
    looped: hasRepeatedSegments(mpls),
  };
}

/**
 * Reads the files at once; when reads fail, the error is the first failure in the given order (as reading them one by
 * one would report), whichever settled first.
 */
async function readAllInOrder(source: ByteSource, paths: readonly string[]): Promise<Uint8Array[]> {
  const results = await Promise.allSettled(paths.map((path) => readWhole(source, path)));
  return results.map((r) => {
    if (r.status === 'rejected') throw r.reason;
    return r.value;
  });
}

/**
 * Parses the CLPI files of `clipIds`. Throws `DiscError` `missing-file` when one is not on the disc, and the parser's
 * `ParseError` when one is damaged (unlike `openDisc`, which skips those).
 */
export async function loadClips(source: ByteSource, clipIds: readonly string[]): Promise<Map<string, Clpi>> {
  for (const clipId of clipIds) {
    const path = clipInfoPath(clipId);
    if (!source.exists(path)) throw new DiscError('missing-file', `Missing clip info ${path}`, [path]);
  }
  const bytes = await readAllInOrder(source, clipIds.map(clipInfoPath));
  return new Map(clipIds.map((id, i) => [id, parseClpi(bytes[i]!)]));
}

/**
 * Encrypted aligned units keep only the first 16 bytes in the clear, so later packets lose their sync byte. The check
 * peeks: on a NAS disc a read would start read-ahead through a clip nothing plays yet, ahead of BD-J's own reads.
 */
export async function checkStreamReadable(source: ByteSource, clipId: string): Promise<void> {
  const path = streamPath(clipId);
  const bytes = await (source.peek ? source.peek(path, 0, ALIGNED_UNIT_SIZE) : source.read(path, 0, ALIGNED_UNIT_SIZE));
  const packets = Math.floor(bytes.length / SOURCE_PACKET_SIZE);
  let readable = packets > 0;
  for (let k = 0; k < packets && readable; k++) {
    if (bytes[k * SOURCE_PACKET_SIZE + 4] !== 0x47) readable = false;
  }
  if (readable) return;
  if (source.list('AACS').length > 0) {
    throw new DiscError('encrypted', 'This disc appears to be encrypted (AACS). Only decrypted backups are supported.', [path]);
  }
  throw new DiscError('unreadable-stream', 'The video stream could not be read. The backup may be damaged or encrypted.', [path]);
}
