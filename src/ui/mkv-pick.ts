// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkvTrackFileName, type MkvTextExtract, type MkvTextTrack } from '@seikou/engine/subs/mkv-extract';
import { languageMatches } from './disc-preferences';

/** One text track of a picked MKV, the MKV it is in, and whether it is the one loaded now. */
export interface MkvListedTrack {
  readonly source: string;
  readonly track: MkvTextTrack;
  readonly current: boolean;
}

/** `tracks` with the track `number` of `source` marked as the loaded one and every other of that MKV not. */
export function markCurrentTrack(tracks: readonly MkvListedTrack[], source: string, number: number): MkvListedTrack[] {
  return tracks.map((t) => (t.source === source ? { ...t, current: t.track.number === number } : t));
}

/** What `expandMkvPicks` made of a pick. */
export interface MkvExpansion {
  /** The pick with each MKV replaced by its chosen track's file and its fonts, other files as they were. */
  readonly files: File[];
  /** Every text track of the picked MKVs (the loaded one marked current), for the Subtitles menu. */
  readonly tracks: readonly MkvListedTrack[];
  /** What to tell the viewer (an MKV with no text track). */
  readonly notices: readonly string[];
}

const isMkv = (f: File): boolean => f.name.toLowerCase().endsWith('.mkv');

function trackFile(source: string, track: MkvTextTrack): File {
  return new File([track.text], mkvTrackFileName(source, track), { type: track.kind === 'ass' ? 'text/x-ssa' : 'application/x-subrip' });
}

const fontFiles = (extract: MkvTextExtract): File[] => extract.fonts.map((f) => new File([f.data as BlobPart], f.name));

/** The track a pick takes: the default one, else the first in the viewer's subtitle language, else the first. */
function chosenTrack(tracks: readonly MkvTextTrack[], language: string | null): MkvTextTrack {
  return tracks.find((t) => t.isDefault) ?? (language === null ? undefined : tracks.find((t) => languageMatches(t.language, language))) ?? tracks[0]!;
}

/**
 * Turns each `.mkv` of a pick into one subtitle file (its default text track, else the first in the viewer's subtitle
 * language, else the first) followed by its fonts, so the rest of the pick path sees files it knows. An MKV with no
 * text track adds nothing and gets a notice. All the MKV's text tracks come back for the menu.
 */
export async function expandMkvPicks(
  files: readonly File[],
  prefs: { subtitleLanguage: string | null },
  extract: (file: File) => Promise<MkvTextExtract>,
): Promise<MkvExpansion> {
  const out: File[] = [];
  const tracks: MkvListedTrack[] = [];
  const notices: string[] = [];
  for (const file of files) {
    if (!isMkv(file)) {
      out.push(file);
      continue;
    }
    const found = await extract(file);
    if (found.tracks.length === 0) {
      notices.push(`${file.name} has no text subtitle tracks.`);
      continue;
    }
    const chosen = chosenTrack(found.tracks, prefs.subtitleLanguage);
    out.push(trackFile(file.name, chosen), ...fontFiles(found));
    for (const track of found.tracks) tracks.push({ source: file.name, track, current: track === chosen });
  }
  return { files: out, tracks, notices };
}

/** The extracts of the MKVs picked on this disc, so the menu can switch tracks without reading a file again. */
export class MkvPickCache {
  private readonly extracts = new Map<string, MkvTextExtract>();
  private generation = 0;
  private readonly pending = new Map<string, Promise<MkvTextExtract>>();

  constructor(private readonly read: (file: File) => Promise<MkvTextExtract>) {}

  /** Reads `file`, or answers from what an earlier read of the same file found. */
  readonly extract = (file: File): Promise<MkvTextExtract> => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    const known = this.pending.get(key);
    if (known) return known;
    const generation = this.generation;
    const run = this.read(file).then((e) => {
      if (generation === this.generation) this.extracts.set(file.name, e);
      return e;
    }, (err: unknown) => {
      this.pending.delete(key);
      throw err;
    });
    this.pending.set(key, run);
    return run;
  };

  /** The track's file and its MKV's fonts, or null when that MKV or track isn't held. */
  filesFor(source: string, trackNumber: number): File[] | null {
    const found = this.extracts.get(source);
    const track = found?.tracks.find((t) => t.number === trackNumber);
    return found && track ? [trackFile(source, track), ...fontFiles(found)] : null;
  }

  /** Lets go of everything held (a new disc). */
  clear(): void {
    this.generation++;
    this.extracts.clear();
    this.pending.clear();
  }
}
