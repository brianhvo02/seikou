// SPDX-License-Identifier: LGPL-3.0-or-later
import { pidHex } from '../disc/pmt';
import type { Playlist } from '../disc/playlist';
import type { AudioProbe, ClipProbe } from '../disc/probe';
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
  /** Channel count from the CLPI's audio format code, in the playlist's first clip. */
  channels: number;
  /** Hz, from the CLPI's audio rate code, in the playlist's first clip. */
  sampleRate: number;
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/** The English name of an ISO 639-2 code (`jpn` is `Japanese`), `Unknown` for `und`, else the code itself. */
function languageName(code: string): string {
  if (code === 'und') return 'Unknown';
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code; // not a well-formed language tag
  }
}

/**
 * The audio streams episode `episodeIndex` (1-based) keeps, in MKV order. Without a record every main-path audio
 * stream of the playlist's first play item is kept in STN order, named after its STN language, the first default.
 * With a record, the episode's `metadata.audio` decides: its order, its ticks (unticked streams are left out), its
 * names and languages; the first kept stream is the default. A playlist stream the record does not list is left
 * out, and a record entry for a PID the playlist lacks is ignored; each calls `warn` once with a message naming
 * the PID. Attributes come from `probes` of the first item's clip, which must be present. Throws when the record
 * has no episode `episodeIndex`; returns an empty list when nothing is kept.
 */
export function selectAudio(
  playlist: Playlist,
  probes: Map<string, ClipProbe>,
  record: SubtitleRecord | null,
  episodeIndex: number,
  warn: (message: string) => void = (message) => console.warn(message),
): SelectedAudio[] {
  const first = playlist.items[0];
  if (!first) return [];
  const probe = probes.get(first.clipId);
  if (!probe) throw new Error(`No probe for clip ${first.clipId}`);
  const attributes = (pid: number): AudioProbe => {
    const audio = probe.audio.find((a) => a.pid === pid);
    if (!audio) throw new Error(`Clip ${first.clipId} has no audio PID ${pidHex(pid)}`);
    return audio;
  };
  const stn = first.audioPids.map((pid, i) => ({ pid, language: first.audioLanguages[i] || 'und' }));
  const select = (pid: number, name: string, language: string, i: number): SelectedAudio => {
    const { codingType, channels, sampleRate } = attributes(pid);
    return { pid, name: name || languageName(language), language, isDefault: i === 0, codingType, channels, sampleRate };
  };

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
