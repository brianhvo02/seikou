import type { PlaceFansub, PlaceSettings, PlaybackPlace, PlaceTextFile } from '@seikou/nas/nas-api';
import type { AudioTrack, PgTrack, PlaceState, StartPoint } from '../engine/protocol';
import type { PlayerSnapshot } from '../player/player-controller';
import { formatTime } from './format';

/** Spec §6.2: a playlist of this length or more makes a place. */
export const PLACE_MIN_DURATION_US = 300_000_000;
const PG_DISPLAY_FLAG = 0x80000000;

/** `?placemin=<seconds>` (test-only) overrides the threshold. */
export function placeMinDurationUs(search: string): number {
  const raw = new URLSearchParams(search).get('placemin');
  if (raw === null || raw.trim() === '') return PLACE_MIN_DURATION_US;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1e6 : PLACE_MIN_DURATION_US;
}

/**
 * Spec §6.2: the playlist the user launched (an episode or a link), the disc's main title, or any playlist of
 * `minUs` or more makes a place; a shorter one (a menu loop) never does.
 */
export function qualifies(
  snapshot: { readonly currentPlaylistId: string | null; readonly durationUs: number },
  chosen: string | null,
  mainPlaylistId: string | null,
  minUs: number,
): boolean {
  const id = snapshot.currentPlaylistId;
  if (id === null) return false;
  if (id === chosen || id === mainPlaylistId) return true;
  return snapshot.durationUs >= minUs;
}

/** Spec §6.5: ended, past the start of a last chapter that starts in the final 10%, or past 95% with no chapters. */
export function isFinished(s: {
  readonly engineState: string; readonly timeUs: number; readonly durationUs: number; readonly chapters: readonly { readonly startUs: number }[];
}): boolean {
  if (s.engineState === 'ended') return true;
  if (!(s.durationUs > 0)) return false;
  if (s.chapters.length === 0) return s.timeUs >= s.durationUs * 0.95;
  const last = s.chapters[s.chapters.length - 1]!.startUs;
  return last >= s.durationUs * 0.9 && s.timeUs >= last;
}

/**
 * A subtitle from the NAS that is in the text set: a stored one (StoredSubtitle's id) or a viewer's own Anime Tosho
 * pick (its release, file and track), with its file size and language.
 */
export type StoredSubtitleNote = { readonly size: number; readonly language: string } & ({ readonly id: string } | { readonly fansub: PlaceFansub });

export function buildPlace(input: {
  readonly discKey: string; readonly discId: string; readonly snapshot: PlayerSnapshot; readonly place: PlaceState;
  readonly shaderSet: string | null; readonly deviceName: string; readonly nowMs: number;
  /** Byte sizes of the text subtitle files by name (the snapshot lacks them). */
  readonly textFileSizes?: Readonly<Record<string, number>>;
  /** The subtitles in the text set that came from the NAS, by file name: their id, size and language. */
  readonly storedSubtitles?: Readonly<Record<string, StoredSubtitleNote>>;
}): PlaybackPlace {
  const { snapshot: s, place } = input;
  const audio = s.audioTracks.find((t) => t.index === s.selectedAudio);
  const sel = s.subtitles?.selected ?? 'off';
  const psr = (i: number): number | undefined => (place.psrs.length > i ? place.psrs[i] : undefined);
  const psr2Fallback = typeof sel === 'object' ? ((PG_DISPLAY_FLAG | sel.pg) >>> 0) : 0;
  const settings: PlaceSettings = {
    pgLanguage: typeof sel === 'object' ? (s.subtitles?.pg.find((t) => t.index === sel.pg)?.language || null) : null,
    textFiles: (s.subtitles?.text?.files ?? []).map((f): PlaceTextFile => {
      const stored = input.storedSubtitles?.[f.name];
      if (stored && 'fansub' in stored) return { name: f.name, size: stored.size, startUs: f.startUs, offsetMs: f.offsetMs, language: stored.language, fansub: stored.fansub };
      if (stored) return { name: f.name, size: stored.size, startUs: f.startUs, offsetMs: f.offsetMs, subtitleId: stored.id, language: stored.language };
      return { name: f.name, size: input.textFileSizes?.[f.name] ?? 0, startUs: f.startUs, offsetMs: f.offsetMs };
    }),
    audioLanguage: audio && audio.language !== '' ? audio.language : null,
    psr1: psr(1) ?? s.selectedAudio ?? 0,
    psr2: psr(2) ?? psr2Fallback,
    psr3: psr(3) ?? 1,
    textOn: sel === 'text',
    textScale: s.subtitles?.scale ?? 1,
    shaderSet: input.shaderSet,
    volume: s.volume,
    muted: s.muted,
  };
  return {
    discKey: input.discKey, discId: input.discId, playlistId: s.currentPlaylistId ?? '',
    timeUs: s.timeUs, durationUs: s.durationUs, finished: isFinished(s),
    mode: place.mode, title: place.title, psrs: place.psrs, gprs: place.gprs,
    settings, updatedAt: input.nowMs, deviceName: input.deviceName,
  };
}

/**
 * The settings an Up next card carries to the next episode: audio and PG by language (numbering differs between
 * discs), the rest as is (text files too: a stored subtitle's language picks the next episode's in place-apply). The first playable audio track with the
 * language, else the first playable one (the disc's default); PG off when the new disc has no stream in the language.
 */
export function settingsForUpNext(prev: PlaceSettings, tracks: readonly AudioTrack[], pgTracks: readonly PgTrack[]): PlaceSettings {
  let psr1 = prev.psr1;
  if (tracks.length > 0 && prev.audioLanguage) {
    const first = tracks.find((t) => t.playable && t.language === prev.audioLanguage) ?? tracks.find((t) => t.playable);
    if (first) psr1 = first.index;
  }
  let psr2 = prev.psr2;
  if (prev.pgLanguage) {
    const match = pgTracks.find((t) => t.language === prev.pgLanguage);
    psr2 = match ? (((prev.psr2 & PG_DISPLAY_FLAG) | match.index) >>> 0) : 0xfff;
  }
  return { ...prev, psr1, psr2 };
}

/**
 * Where to open for a resume. `hdmv` carries the whole register file (the engine skips the setting PSRs, §6.1); direct
 * playback gets only PSR 1–3. `playlists` null means the disc's list isn't known yet: no check is made.
 */
export function resumeStart(
  place: PlaybackPlace,
  playlists: readonly { readonly id: string; readonly durationUs?: number }[] | null,
): StartPoint | { readonly problem: 'no-playlist' | 'past-end' } {
  let durationUs = place.durationUs;
  if (playlists) {
    const p = playlists.find((x) => x.id === place.playlistId);
    if (!p) return { problem: 'no-playlist' };
    durationUs = p.durationUs ?? durationUs;
  }
  if (durationUs > 0 && place.timeUs >= durationUs) return { problem: 'past-end' };
  if (place.mode === 'hdmv' && place.title !== null) {
    return { playlistId: place.playlistId, timeUs: place.timeUs, hdmv: { title: place.title, psrs: place.psrs, gprs: place.gprs ?? {} }, playback: null };
  }
  const { psr1, psr2, psr3 } = place.settings;
  return { playlistId: place.playlistId, timeUs: place.timeUs, hdmv: null, playback: { psr1, psr2, psr3 } };
}

function when(updatedAt: number, nowMs: number): string {
  const ms = Math.max(0, nowMs - updatedAt);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const day = (t: number): number => Math.floor(t / 86_400_000);
  if (day(nowMs) - day(updatedAt) === 1) return 'yesterday';
  return new Date(updatedAt).toISOString().slice(0, 10);
}

export function promptLines(place: PlaybackPlace, nowMs: number): { heading: string; line: string; details: string; resumeLabel: string } {
  const t = formatTime(place.timeUs);
  const s = place.settings;
  const parts: string[] = [];
  if (s.audioLanguage) parts.push(`Audio: ${s.audioLanguage}`);
  const stream = s.psr2 & 0xfff;
  if (s.textOn) {
    const f = s.textFiles[0];
    const off = f && f.offsetMs !== 0 ? ` ${f.offsetMs > 0 ? '+' : '-'}${(Math.abs(f.offsetMs) / 1000).toFixed(1)} s` : '';
    parts.push(f ? `Subtitles: ${f.name}${off}` : 'Subtitles: text file');
  }
  else if ((s.psr2 & PG_DISPLAY_FLAG) !== 0 && stream !== 0 && stream !== 0xfff) parts.push(`Subtitles: track ${stream}`);
  if (s.shaderSet) parts.push(`Shader: ${s.shaderSet}`);
  return {
    heading: 'Pick up where you left off?',
    line: `Stopped at ${t} of ${formatTime(place.durationUs)} on ${place.deviceName}, ${when(place.updatedAt, nowMs)}.`,
    details: parts.join(' · '),
    resumeLabel: `Resume at ${t}`,
  };
}
