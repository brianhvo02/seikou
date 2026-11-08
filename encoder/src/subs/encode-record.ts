// SPDX-License-Identifier: LGPL-3.0-or-later
import { discKeyOfFolder } from '../disc/disc-key';
import { RecordStore, type SubtitleRecord } from './record';

/** The saved record does not describe this encode: it was saved for another playlist or episode list. The command line answers it with exit code 2. */
export class RecordMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordMismatchError';
  }
}

/** The record names subtitle or font files that are no longer in the data directory. The message names each release; the command line answers it with exit code 1. */
export class MissingSubtitleFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingSubtitleFilesError';
  }
}

/**
 * Loads the helper's saved record for the disc in `discDir` and `playlistId`, for the encode to follow. Returns null
 * when `noSubtitles` is set (the record is not even read) or no record was saved. Throws `RecordMismatchError` when the
 * record's playlist or episode list differs from this encode's, and `MissingSubtitleFilesError` when any file it
 * names is gone from `dataDir`. An unreadable or invalid record throws the store's `RecordError`.
 */
export async function loadEncodeRecord(o: {
  discDir: string;
  playlistId: string;
  episodeSpec: string;
  dataDir: string;
  noSubtitles: boolean;
}): Promise<SubtitleRecord | null> {
  if (o.noSubtitles) return null;
  const { key } = await discKeyOfFolder(o.discDir);
  const store = new RecordStore(o.dataDir);
  const record = await store.read(key, o.playlistId);
  if (record === null) return null;
  if (record.playlist !== o.playlistId || record.episodeSpec !== o.episodeSpec) {
    throw new RecordMismatchError(
      `The saved subtitle choices are for playlist ${record.playlist} episodes ${record.episodeSpec}; this encode asks for ${o.playlistId} episodes ${o.episodeSpec}. Re-save them in the helper or pass --no-subtitles.`,
    );
  }
  const missing = await store.missingFiles(record);
  if (missing.length > 0) {
    const lines = missing.map((m) => `${m.release}: ${m.files.join(', ')}`).join('; ');
    throw new MissingSubtitleFilesError(
      `Subtitle files the saved choices need are gone from ${o.dataDir} (${lines}). Fetch the release again in the helper or pass --no-subtitles.`,
    );
  }
  return record;
}
