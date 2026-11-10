// SPDX-License-Identifier: LGPL-3.0-or-later
import { pidHex } from '../disc/pmt';
import { audioChannels, audioRate } from '../disc/stream-codes';
import type { Playlist } from '../disc/playlist';
import type { SubtitleRecord } from '../subs/record';

// Which audio streams of a playlist an episode keeps, in MKV order, with their names, languages and default flag.
// Streams are named by PID throughout: the STN table (the order a player numbers them), the CLPI (their attributes),
// the PMT (the order BestSource numbers them) and the saved record all list them differently.

/** One audio stream chosen for an episode, in MKV track order. */
export interface SelectedAudio {
  /** The stream's PID in the clips (main-path STN entry). */
  pid: number;
  /** Track name for players: the record's, else the language's English name (`jpn` is `Japanese`). */
  name: string;
  /** ISO 639-2 code: the record's, else the STN entry's; `und` when neither gives one. */
  language: string;
  /** True for the first stream only. */
  isDefault: boolean;
  /** CLPI stream coding type (0x80 LPCM, 0x81 AC-3, 0x82 DTS, 0x83 TrueHD, 0x84 E-AC-3, 0x85 and 0x86 DTS-HD). */
  codingType: number;
  /**
   * Channel count from the STN entry's audio format code in the playlist's first play item: 1, 2, or 6 for any
   * multi-channel layout (the code does not say how many channels above two). The STN table is what players go by,
   * and a clip's CLPI can disagree with it.
   */
  channels: number;
  /** Hz, from the STN entry's audio rate code in the playlist's first play item (for the combo codes, the lossless layer's rate, which is the rate BestSource decodes). */
  sampleRate: number;
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/** The English name of an ISO 639-2 code (`jpn` is `Japanese`), `Unknown` for `und`, else the code itself. */
export function languageName(code: string): string {
  if (code === 'und') return 'Unknown';
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code; // not a well-formed language tag
  }
}

interface StnStreams {
  /** The first play item's main-path STN audio entries, in STN order. */
  stn: { pid: number; language: string; formatCode: number; rateCode: number }[];
  /** Resolves the entry for `pid` (one of `stn`'s) into the `i`th selected stream. */
  select: (pid: number, name: string, language: string, i: number) => SelectedAudio;
}

/** The first play item's STN audio entries and their resolver; null for a playlist with no items. */
function stnStreams(playlist: Playlist): StnStreams | null {
  const first = playlist.items[0];
  if (!first) return null;
  // The coding type is the CLPI's, so no byte of the first item's clip is read: an episode that does not play it needs none.
  const attributes = (pid: number): { codingType: number } => {
    for (const program of first.clpi.programs) {
      const stream = program.streams.find((s) => s.pid === pid);
      if (stream) return stream;
    }
    throw new Error(`Clip ${first.clipId} has no audio PID ${pidHex(pid)} in its CLPI`);
  };
  const stn = first.audioPids.map((pid, i) => ({
    pid,
    language: first.audioLanguages[i] || 'und',
    formatCode: first.audioFormatCodes[i]!,
    rateCode: first.audioRateCodes[i]!,
  }));
  const select = (pid: number, name: string, language: string, i: number): SelectedAudio => {
    const { codingType } = attributes(pid);
    const entry = stn.find((s) => s.pid === pid)!;
    const fromStn = (f: () => number): number => {
      try {
        return f();
      } catch (e) {
        throw new Error(`Playlist ${playlist.id}: audio PID ${pidHex(pid)}: ${(e as Error).message} in its STN entry`);
      }
    };
    const channels = fromStn(() => audioChannels(entry.formatCode));
    const sampleRate = fromStn(() => audioRate(entry.rateCode));
    return { pid, name: name || languageName(language), language, isDefault: i === 0, codingType, channels, sampleRate };
  };
  return { stn, select };
}

/**
 * The first main-path STN audio stream of the playlist's first play item, as `selectAudio` without a record gives it,
 * or null when there is none. Only that entry is resolved, so the codes and CLPI attributes of the other streams do
 * not matter. Throws when the first item's CLPI lacks the stream, or its STN entry has a format or rate code the
 * tables lack.
 */
export function firstStnAudio(playlist: Playlist): SelectedAudio | null {
  const streams = stnStreams(playlist);
  const first = streams?.stn[0];
  if (!streams || !first) return null;
  return streams.select(first.pid, '', first.language, 0);
}

/**
 * The audio streams episode `episodeIndex` (1-based) keeps, in MKV order. Without a record every main-path audio
 * stream of the playlist's first play item is kept in STN order, named after its STN language, the first default.
 * With a record, the episode's `metadata.audio` decides: its order, its ticks (unticked streams are left out), its
 * names and languages; the first kept stream is the default. A playlist stream the record does not list is left
 * out, and a record entry for a PID the playlist lacks is ignored; each calls `warn` once with a message naming
 * the PID. The coding type comes from the first item's CLPI (no clip is read); channels and sample
 * rate from the first item's STN entries. Throws when the record has no episode `episodeIndex` or an STN entry has a
 * format or rate code the tables lack; returns an empty list when nothing is kept.
 */
export function selectAudio(
  playlist: Playlist,
  record: SubtitleRecord | null,
  episodeIndex: number,
  warn: (message: string) => void = (message) => console.warn(message),
): SelectedAudio[] {
  const streams = stnStreams(playlist);
  if (!streams) return [];
  const { stn, select } = streams;

  if (record === null) return stn.map((s, i) => select(s.pid, '', s.language, i));

  const episode = record.episodes.find((e) => e.index === episodeIndex);
  if (!episode) throw new Error(`The saved record has no episode ${episodeIndex}`);
  const listed = new Set(episode.metadata.audio.map((a) => a.pid));
  const inPlaylist = new Set(stn.map((s) => s.pid));
  for (const a of episode.metadata.audio) {
    if (!inPlaylist.has(a.pid)) warn(`Episode ${episodeIndex}: the saved record names audio PID ${pidHex(a.pid)}, which is not in playlist ${playlist.id}; ignored`);
  }
  for (const s of stn) {
    if (!listed.has(s.pid)) warn(`Episode ${episodeIndex}: audio PID ${pidHex(s.pid)} is not in the saved record; left out`);
  }
  return episode.metadata.audio
    .filter((a) => a.included && inPlaylist.has(a.pid))
    .map((a, i) => select(a.pid, a.name, a.language || 'und', i));
}
