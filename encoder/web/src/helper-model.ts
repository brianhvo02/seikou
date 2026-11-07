// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The helper page's state and its pure reducer: the show, the release and its episode match, the tracks chosen per
 * episode, each episode's timing, and the metadata draft. `toRecord` and `fromRecord` convert it to and from the
 * record the backend saves for the encode.
 */
import type {
  CachedRelease,
  EpisodesAnswer,
  FansubAlignment,
  MatchRow,
  RecordEpisode,
  RecordTrack,
  ReleaseAnswer,
  SessionInfo,
  SubtitleRecord,
  TitleHit,
} from './api-types';
import { defaultMetadata, defaultTrack, type EpisodeDraft, type MetadataDraft, type TrackDraft } from './metadata/metadata-model';

/** The page's three steps, in order: pick a release, match episodes, line up. */
export type Step = 1 | 2 | 3;

/** Where the chosen release came from: SeaDex's list, an Anime Tosho search, or the user's own files. */
export type ReleaseSource = 'seadex' | 'tosho' | 'local';

/** An episode's chosen tracks (ids within the matched file), or `none` when the user wants it without subtitles. */
export type EpisodeChoice = { readonly trackIds: readonly string[] } | 'none';

/** An episode's timing: what lining up found (or `original`), the user's nudge on top, and whether it was accepted. */
export interface EpisodeTiming {
  /** The timing found, `original` for the release's own, or `none` with the reason nothing was found. */
  readonly alignment: FansubAlignment;
  /** The user's adjustment in milliseconds, added to whatever the alignment does. */
  readonly nudgeMs: number;
  /** Whether the user accepted the episode's timing. */
  readonly accepted: boolean;
}

/** Everything the user has chosen so far. Episodes are keyed by their 1-based index in the run's list. */
export interface HelperState {
  /** The step on screen. */
  readonly step: Step;
  /** The show picked on AniList; null before one is picked. */
  readonly title: TitleHit | null;
  /** How many episodes the release numbers before this disc's first (for a later season or disc). */
  readonly episodeOffset: number;
  /** The fetched release; null before one is picked. */
  readonly release: CachedRelease | null;
  /** Where `release` came from; null exactly when `release` is. */
  readonly releaseSource: ReleaseSource | null;
  /** One row per run episode: which release file it uses. */
  readonly match: readonly MatchRow[];
  /** Chosen tracks per episode; an episode without an entry has nothing chosen. */
  readonly choices: Readonly<Record<number, EpisodeChoice>>;
  /** Timing per episode; an episode without an entry has not been lined up. */
  readonly timing: Readonly<Record<number, EpisodeTiming>>;
  /** The metadata panel's draft. */
  readonly metadata: MetadataDraft;
  /** Whether anything changed since the last save or restore. */
  readonly dirty: boolean;
}

/** What can happen to the state. Every action but `goTo`, `load` and `saved` marks the state dirty. */
export type HelperAction =
  /** Moves to a step, when `canEnter` allows it. */
  | { readonly type: 'goTo'; readonly step: Step }
  /** Picks the show; a different show drops the release, the match, the choices and the timings. */
  | { readonly type: 'setTitle'; readonly title: TitleHit | null }
  /** Sets the episode offset; the caller fetches the release again at the new offset and sends `setRelease`. */
  | { readonly type: 'setOffset'; readonly offset: number }
  /** Sets the release and its match; resets the choices to every track of each matched file, and drops timings. */
  | { readonly type: 'setRelease'; readonly release: ReleaseAnswer | null; readonly from: ReleaseSource }
  /** Uses another release file for an episode (null for none): its tracks become the choice, its timing is dropped. */
  | { readonly type: 'chooseFile'; readonly episode: number; readonly fileId: string | null }
  /** Sets which of the matched file's tracks an episode uses. */
  | { readonly type: 'chooseTracks'; readonly episode: number; readonly trackIds: readonly string[] }
  /** Marks an episode as having no subtitles; its timing is dropped. */
  | { readonly type: 'markNone'; readonly episode: number }
  /** Stores what lining up found for an episode, keeping its nudge; the episode is no longer accepted. */
  | { readonly type: 'setTiming'; readonly episode: number; readonly alignment: FansubAlignment }
  /** Adds `deltaMs` to an episode's nudge (an episode not lined up keeps the release's own timing). */
  | { readonly type: 'nudge'; readonly episode: number; readonly deltaMs: number }
  /** Accepts an episode's timing. */
  | { readonly type: 'accept'; readonly episode: number }
  /** Leaves an episode without subtitles, as `markNone`. */
  | { readonly type: 'skip'; readonly episode: number }
  /** Drops the shift found for an episode and uses the release's own timing, keeping the nudge. */
  | { readonly type: 'useOriginal'; readonly episode: number }
  /** Replaces the metadata draft. */
  | { readonly type: 'setMetadata'; readonly metadata: MetadataDraft }
  /** Replaces the whole state, such as one restored by `fromRecord`. */
  | { readonly type: 'load'; readonly state: HelperState }
  /** Notes a successful save: the state is no longer dirty. */
  | { readonly type: 'saved' };

/** The state of a fresh page: step 1, nothing picked. */
export function initialState(): HelperState {
  return {
    step: 1,
    title: null,
    episodeOffset: 0,
    release: null,
    releaseSource: null,
    match: [],
    choices: {},
    timing: {},
    metadata: { episodes: {}, edited: new Set() },
    dirty: false,
  };
}

/**
 * Whether the user may go to `step`: step 1 always, step 2 once a release is picked, step 3 once at least one
 * episode has tracks chosen or is marked as having none.
 */
export function canEnter(state: HelperState, step: Step): boolean {
  if (step === 1) return true;
  if (step === 2) return state.release !== null;
  return Object.values(state.choices).some((c) => c === 'none' || c.trackIds.length > 0);
}

/** The cached file an episode's match row points at, or null. */
function fileOf(state: Pick<HelperState, 'release' | 'match'>, episode: number) {
  const fileId = state.match.find((r) => r.episode === episode)?.fileId ?? null;
  return fileId === null ? null : (state.release?.files.find((f) => f.id === fileId) ?? null);
}

/** `record` without `key`. */
function without<T>(record: Readonly<Record<number, T>>, key: number): Record<number, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** The choices a fresh match gets: every track of each matched file. */
function defaultChoices(release: CachedRelease, rows: readonly MatchRow[]): Record<number, EpisodeChoice> {
  const choices: Record<number, EpisodeChoice> = {};
  for (const row of rows) {
    const file = release.files.find((f) => f.id === row.fileId);
    if (file && file.tracks.length > 0) choices[row.episode] = { trackIds: file.tracks.map((t) => t.id) };
  }
  return choices;
}

/** The timing an episode has, or the release's own timing when it was never lined up. */
function timingOf(state: HelperState, episode: number): EpisodeTiming {
  return state.timing[episode] ?? { alignment: { kind: 'original' }, nudgeMs: 0, accepted: false };
}

function apply(state: HelperState, action: HelperAction): HelperState {
  switch (action.type) {
    case 'goTo':
      return canEnter(state, action.step) ? { ...state, step: action.step } : state;
    case 'load':
      return action.state;
    case 'saved':
      return { ...state, dirty: false };
    case 'setTitle':
      if (action.title?.alId === state.title?.alId) return { ...state, title: action.title };
      return { ...state, title: action.title, release: null, releaseSource: null, match: [], choices: {}, timing: {} };
    case 'setOffset':
      return { ...state, episodeOffset: action.offset };
    case 'setRelease': {
      if (action.release === null) return { ...state, release: null, releaseSource: null, match: [], choices: {}, timing: {} };
      const { match, ...release } = action.release;
      return { ...state, release, releaseSource: action.from, match: match.rows, choices: defaultChoices(release, match.rows), timing: {} };
    }
    case 'chooseFile': {
      const match = state.match.map((r) => (r.episode === action.episode ? { ...r, fileId: action.fileId } : r));
      const file = fileOf({ release: state.release, match }, action.episode);
      const choices = file && file.tracks.length > 0 ? { ...state.choices, [action.episode]: { trackIds: file.tracks.map((t) => t.id) } } : without(state.choices, action.episode);
      return { ...state, match, choices, timing: without(state.timing, action.episode) };
    }
    case 'chooseTracks':
      return { ...state, choices: { ...state.choices, [action.episode]: { trackIds: [...action.trackIds] } } };
    case 'markNone':
    case 'skip':
      return { ...state, choices: { ...state.choices, [action.episode]: 'none' }, timing: without(state.timing, action.episode) };
    case 'setTiming': {
      const nudgeMs = state.timing[action.episode]?.nudgeMs ?? 0;
      return { ...state, timing: { ...state.timing, [action.episode]: { alignment: action.alignment, nudgeMs, accepted: false } } };
    }
    case 'nudge': {
      const t = timingOf(state, action.episode);
      return { ...state, timing: { ...state.timing, [action.episode]: { ...t, nudgeMs: t.nudgeMs + action.deltaMs } } };
    }
    case 'accept':
      return { ...state, timing: { ...state.timing, [action.episode]: { ...timingOf(state, action.episode), accepted: true } } };
    case 'useOriginal':
      return { ...state, timing: { ...state.timing, [action.episode]: { ...timingOf(state, action.episode), alignment: { kind: 'original' } } } };
    case 'setMetadata':
      return { ...state, metadata: action.metadata };
  }
}

/**
 * The state after `action`. Pure: `state` is never changed. When the action closes the step on screen (a new show
 * drops the release), the state falls back to the furthest step still open.
 */
export function reduce(state: HelperState, action: HelperAction): HelperState {
  let next = apply(state, action);
  if (action.type !== 'goTo' && action.type !== 'load' && action.type !== 'saved' && next !== state) next = { ...next, dirty: true };
  while (next.step > 1 && !canEnter(next, next.step)) next = { ...next, step: (next.step - 1) as Step };
  return next;
}

/** The shift and split a track saves for an alignment: the offset as the shift, a split's parts, zero otherwise. */
function savedShift(alignment: FansubAlignment): Pick<RecordTrack, 'shiftMs' | 'split'> {
  if (alignment.kind === 'offset') return { shiftMs: alignment.offsetMs, split: null };
  if (alignment.kind === 'split') return { shiftMs: 0, split: alignment.parts.map((p) => ({ fromMs: p.fromMs, offsetMs: p.offsetMs })) };
  return { shiftMs: 0, split: null };
}

/** An episode's tracks to save, in the panel's order: drafted tracks first, then chosen ones the panel has not seen. */
function recordTracks(state: HelperState, episode: number, draft: EpisodeDraft | undefined): RecordTrack[] {
  const choice = state.choices[episode];
  const file = fileOf(state, episode);
  if (choice === undefined || choice === 'none' || file === null) return [];
  const chosen = file.tracks.filter((t) => choice.trackIds.includes(t.id));
  const byKey = new Map(chosen.map((t) => [t.path, t]));
  const drafted = (draft?.tracks ?? []).filter((d) => byKey.has(d.key));
  const seen = new Set(drafted.map((d) => d.key));
  const group = state.release?.group ?? '';
  const rest = chosen.filter((t) => !seen.has(t.path)).map((t, i) => defaultTrack({ ...t, group, key: t.path }, drafted.length + i));
  const timing = timingOf(state, episode);
  const shift = savedShift(timing.alignment);
  return [...drafted, ...rest].map((d) => ({
    file: d.key,
    kind: d.kind,
    language: d.language,
    name: d.name,
    shiftMs: shift.shiftMs,
    nudgeMs: timing.nudgeMs,
    split: shift.split,
    included: d.included,
  }));
}

/**
 * The record to save for this run. Every episode of `episodes` is written, in order: its chosen tracks with the
 * panel's names, languages, order and ticks, its timing (an offset as `shiftMs`; a split as `split` with `shiftMs` 0;
 * `none`, `original` and an episode never lined up as 0 and null), and its metadata, falling back to the defaults
 * for an episode the panel has no draft of. `savedAt` is left empty for the server to set.
 */
export function toRecord(state: HelperState, session: SessionInfo, episodes: EpisodesAnswer): SubtitleRecord {
  const defaults = defaultMetadata({
    show: state.title?.title ?? null,
    episodes: episodes.episodes.map((e) => ({ index: e.index, title: null, chapterCount: e.chapters.length })),
    audio: episodes.audio,
    tracks: {},
  });
  const recordEpisodes = episodes.episodes.map((e): RecordEpisode => {
    const draft = state.metadata.episodes[e.index];
    const meta = draft ?? defaults.episodes[e.index]!;
    return {
      index: e.index,
      title: meta.episodeTitle !== '' ? meta.episodeTitle : `Episode ${e.index}`,
      tracks: recordTracks(state, e.index, draft),
      metadata: {
        title: meta.title,
        video: { ...meta.video },
        audio: meta.audio.map((a) => ({ ...a })),
        chapters: [...meta.chapters],
      },
    };
  });
  const release = state.release;
  return {
    disc: { key: session.discKey, label: session.label },
    playlist: session.playlistId,
    episodeSpec: session.episodeSpec,
    anilist: state.title ? { id: state.title.alId, title: state.title.title, episodeOffset: state.episodeOffset } : null,
    release: release ? { source: state.releaseSource ?? release.source, id: release.key, group: release.group, label: release.label } : null,
    fonts: release ? [...new Set(release.fonts.map((f) => f.path))] : [],
    episodes: recordEpisodes,
    savedAt: '',
  };
}

/** The alignment a saved track stands for. The record keeps no confidence, so a restored one reads as certain (1). */
function restoredAlignment(track: RecordTrack): FansubAlignment {
  if (track.split !== null) return { kind: 'split', parts: track.split.map((p) => ({ ...p })), confidence: 1 };
  if (track.shiftMs !== 0) return { kind: 'offset', offsetMs: track.shiftMs, confidence: 1 };
  return { kind: 'original' };
}

/**
 * The state a saved record stands for, on step 1 and not dirty. `release` is the record's release as the backend
 * answers it now (`HelperApi.release(record.release.id, offset)`); with it, each episode's file and tracks are found
 * again by their paths, and an episode saved without tracks is marked as having none. Without it (or when its key is
 * not the record's) the release, match and choices stay empty, while the show, timings and metadata are restored.
 * A timing with no shift, split or nudge is not restored, so that episode is lined up again; whether it was `none`
 * or `original` is not saved.
 */
export function fromRecord(record: SubtitleRecord, release: ReleaseAnswer | null = null): HelperState {
  const usable = release !== null && record.release !== null && release.key === record.release.id ? release : null;
  const base = initialState();
  const title: TitleHit | null = record.anilist
    ? { alId: record.anilist.id, title: record.anilist.title, nativeTitle: null, year: null, format: null, episodes: null, poster: null }
    : null;

  const timing: Record<number, EpisodeTiming> = {};
  const episodes: Record<number, EpisodeDraft> = {};
  const edited = new Set<string>();
  const choices: Record<number, EpisodeChoice> = {};
  let match: MatchRow[] = [];
  let cached: CachedRelease | null = null;
  if (usable) {
    const { match: answerMatch, ...rest } = usable;
    cached = rest;
    match = answerMatch.rows.map((r) => ({ ...r }));
  }

  for (const e of record.episodes) {
    const first = e.tracks[0];
    if (first && (first.shiftMs !== 0 || first.split !== null || first.nudgeMs !== 0)) {
      timing[e.index] = { alignment: restoredAlignment(first), nudgeMs: first.nudgeMs, accepted: true };
    }
    const tracks: TrackDraft[] = e.tracks.map((t) => ({ key: t.file, kind: t.kind, name: t.name, language: t.language, included: t.included }));
    episodes[e.index] = {
      index: e.index,
      episodeTitle: e.title,
      title: e.metadata.title,
      video: { ...e.metadata.video },
      audio: e.metadata.audio.map((a) => ({ ...a })),
      chapters: [...e.metadata.chapters],
      tracks,
    };
    for (const field of ['title', 'video', 'audio', 'chapters', 'tracks']) edited.add(`episodes.${e.index}.${field}`);

    if (cached === null) continue;
    const paths = new Set(e.tracks.map((t) => t.file));
    const file = cached.files.find((f) => f.tracks.some((t) => paths.has(t.path)));
    if (!file) {
      choices[e.index] = 'none';
      continue;
    }
    match = match.map((r) => (r.episode === e.index ? { ...r, fileId: file.id } : r));
    choices[e.index] = { trackIds: file.tracks.filter((t) => paths.has(t.path)).map((t) => t.id) };
  }

  return {
    ...base,
    title,
    episodeOffset: record.anilist?.episodeOffset ?? 0,
    release: cached,
    releaseSource: cached ? (record.release?.source ?? cached.source) : null,
    match,
    choices,
    timing,
    metadata: { episodes, edited },
  };
}
