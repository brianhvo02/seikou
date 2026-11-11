import type { LevelAt, LevelId, LevelInfo, LevelReason, PlaceSettings } from '@seikou/nas/nas-api';
import { RATE_MARGIN, bufferPlan } from './buffer-model';

/** What the pre-flight says when the NAS's GPU is busy but Original can play. */
export const BUSY_COPY = 'The NAS is busy re-encoding for others. This will play at original quality.';
/** What the pre-flight says when the GPU is busy and no level, Original included, can play. */
export const BUSY_TRY_LATER_COPY = 'The NAS is busy. Try again in a few minutes.';

/** What a NAS without levels means. */
export const ORIGINAL_ONLY: readonly LevelInfo[] = [{ level: 'original', label: 'Original', budgetMbps: 0, available: true }];

/** A level's rate in megabits per second for choosing and pricing: its budget, or `originalMbps` (the disc's own rate) for Original, which has none. */
export function levelRateMbps(l: LevelInfo, originalMbps: number): number {
  return l.level === 'original' ? originalMbps : l.budgetMbps;
}

/** The level to open at: a phone takes Phone; a computer the first that fits; else the lowest rate. */
export function autoLevel(levels: readonly LevelInfo[], o: { connectionMbps: number; phone: boolean; originalMbps: number }): LevelId {
  const available = levels.filter((l) => l.available);
  const lowest = (): LevelId => {
    let best: LevelInfo | undefined;
    for (const l of available) if (!best || levelRateMbps(l, o.originalMbps) < levelRateMbps(best, o.originalMbps)) best = l;
    return best?.level ?? 'original';
  };
  if (o.phone) return available.find((l) => l.level === 'phone-720')?.level ?? lowest();
  const fits = available.find((l) => levelRateMbps(l, o.originalMbps) * RATE_MARGIN <= o.connectionMbps);
  return fits?.level ?? lowest();
}

/** One row of the pre-flight's level list: the level, its label, whether it can be picked and the note beside it (`plays now`, `about N minutes`, `plays with pauses`, or why it is unavailable). */
export interface LevelRow {
  level: LevelId;
  label: string;
  available: boolean;
  note: string;
}

/** The note beside a level the NAS or this device can't offer, by the NAS's reason. */
export const REASON_COPY: Record<LevelReason, string> = {
  unplayable: "can't play in this browser",
  'no-encoder': 'not on this NAS',
  'no-hevc': "this device can't decode it",
  'no-hevc10': "this device can't decode it",
  'no-hdr-display': 'needs an HDR screen',
  busy: 'the NAS is busy',
};

/** The pre-flight's level list: each level with the note `bufferPlan` gives for its size (its budget rate over the main title's length; Original's own bytes) on this connection and storage, or its unavailability reason. */
export function levelRows(
  levels: readonly LevelInfo[],
  o: { durationS: number; originalBytes: number; connectionMbps: number; quotaBytes: number },
): LevelRow[] {
  return levels.map((l) => {
    const base = { level: l.level, label: l.label, available: l.available };
    if (!l.available) return { ...base, note: l.reason ? REASON_COPY[l.reason] : 'not available' };
    const playlistBytes = l.level === 'original' ? o.originalBytes : ((l.budgetMbps * 1e6) / 8) * o.durationS;
    const plan = bufferPlan({ durationS: o.durationS, playlistBytes, connectionMbps: o.connectionMbps, quotaBytes: o.quotaBytes });
    switch (plan.kind) {
      case 'play':
        return { ...base, note: 'plays now' };
      case 'silent':
      case 'ask':
        return { ...base, note: `about ${Math.ceil(plan.waitS / 60)} ${Math.ceil(plan.waitS / 60) === 1 ? 'minute' : 'minutes'}` };
      case 'too-big':
        return { ...base, note: 'plays with pauses' };
    }
  });
}

/** The notice for a level list where re-encoded levels are busy: `BUSY_COPY` when Original can play, `BUSY_TRY_LATER_COPY` when no level can, null when nothing is busy or some level can still be picked. */
export function busyMessage(levels: readonly LevelInfo[]): string | null {
  const reencoded = levels.filter((l) => l.level !== 'original');
  const original = levels.find((l) => l.level === 'original');
  const originalPlays = original ? original.available : true;
  if (!reencoded.some((l) => l.reason === 'busy')) return null;
  if (originalPlays) return BUSY_COPY;
  return reencoded.some((l) => l.available) ? null : BUSY_TRY_LATER_COPY;
}

// Disc languages are ISO 639-2; a browser's are ISO 639-1 (private table, the repo has no helper).
const ISO_639_2: Record<string, readonly string[]> = {
  en: ['eng'],
  ja: ['jpn'],
  fr: ['fra', 'fre'],
  de: ['deu', 'ger'],
  es: ['spa'],
  it: ['ita'],
  zh: ['zho', 'chi'],
  ko: ['kor'],
};

/**
 * The 1-based audio stream a level request asks for: a place's PSR1, then a place's audio language (ISO 639-2, as the
 * disc names it), then the browser's language, then 1.
 */
export function levelAudio(audio: readonly { language: string }[], o: { psr1?: number; audioLanguage?: string; language: string }): number {
  if (o.psr1 !== undefined && Number.isInteger(o.psr1) && o.psr1 >= 1 && o.psr1 <= audio.length) return o.psr1;
  if (o.audioLanguage) {
    const wanted = o.audioLanguage.toLowerCase();
    const i = audio.findIndex((a) => a.language.toLowerCase() === wanted);
    if (i >= 0) return i + 1;
  }
  const codes = ISO_639_2[o.language.slice(0, 2).toLowerCase()];
  if (codes) {
    const i = audio.findIndex((a) => codes.includes(a.language.toLowerCase()));
    if (i >= 0) return i + 1;
  }
  return 1;
}

/**
 * What a saved place says about the audio a level request asks for on `playlistId`. Stream numbers belong to a
 * playlist's STN, so the place's PSR1 counts only on its own playlist; on another, its audio language does.
 */
export function placeAudioHint(
  place: { readonly playlistId: string; readonly settings: Pick<PlaceSettings, 'psr1' | 'audioLanguage'> } | null,
  playlistId: string | null,
): { psr1?: number; audioLanguage?: string } {
  if (!place) return {};
  if (place.playlistId === playlistId) return { psr1: place.settings.psr1 };
  return place.settings.audioLanguage ? { audioLanguage: place.settings.audioLanguage } : {};
}

/**
 * The version a Quality menu pick asks for. At Original the audio is the stream that plays (Original numbering); at a
 * level it is the level's own audio number (the engine numbers the level's one track 1, so it can't say).
 */
export function pickAt(at: LevelAt, level: LevelId, playingAudio: number | null): LevelAt {
  return { level, audio: at.level === 'original' ? (playingAudio ?? at.audio) : at.audio };
}

/** The player's badge for the level playing, `<label> · re-encoded on the NAS`; null at Original. */
export function badgeText(l: LevelInfo): string | null {
  return l.level === 'original' ? null : `${l.label} · re-encoded on the NAS`;
}

/**
 * Whether the pre-flight knows enough to offer Play (the levels answered or failed, the probe settled, the device's
 * caps known), the level it preselects then, and whether any level can play at all. The pre-flight keeps the first non-null `auto` for the disc, so the
 * preselected radio never changes under the viewer.
 */
export function preflightLevelState(o: {
  levels: readonly LevelInfo[] | undefined;
  /** undefined while probing; null when there is no measurement. */
  connectionMbps: number | null | undefined;
  caps: { phone: boolean } | undefined;
  originalMbps: number;
}): { ready: boolean; auto: LevelId | null; playable: boolean } {
  if (o.levels === undefined || o.connectionMbps === undefined || o.caps === undefined) return { ready: false, auto: null, playable: false };
  const auto = autoLevel(o.levels, { connectionMbps: o.connectionMbps ?? Infinity, phone: o.caps.phone, originalMbps: o.originalMbps });
  // An MPEG-2 or VC-1 disc whose levels are all busy has nothing to play (Original would have no picture).
  return { ready: true, auto, playable: o.levels.some((l) => l.available) };
}
