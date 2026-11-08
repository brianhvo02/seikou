// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The helper page's state and its pure reducer: the show, the pool of releases with their episode matches, the file
 * and tracks chosen per episode (from any pooled release), each episode's timing, and the metadata draft. `toRecord`
 * and `fromRecord` convert it to and from the record the backend saves for the encode.
 */
import type {
  CachedReleaseFile,
  EpisodesAnswer,
  FansubAlignment,
  RecordEpisode,
  RecordRelease,
  RecordTrack,
  ReleaseAnswer,
  SessionInfo,
  SingleReleaseRecord,
  SubtitleRecord,
  TitleHit,
} from './api-types';
import {
  defaultMetadata,
  defaultTrack,
  languageCode,
  mergeDefaults,
  type DefaultTrackInput,
  type EpisodeDraft,
  type MetadataDraft,
  type TrackDraft,
} from './metadata/metadata-model';

/** The page's three steps, in order: pick releases, match episodes, line up. */
export type Step = 1 | 2 | 3;

/** Where a pooled release came from: SeaDex's list, an Anime Tosho search, or the user's own files. */
export type ReleaseSource = 'seadex' | 'tosho' | 'local';

/** A release in the page's pool: the backend's answer (its files and its match at the episode offset) and where it came from. */
export interface PooledRelease {
  /** The release as the backend answered it, matched at the state's episode offset. */
  readonly release: ReleaseAnswer;
  /** Where the user found it; a SeaDex release belongs to the show it was listed for. */
  readonly source: ReleaseSource;
}

/**
 * An episode's choice: a file of a pooled release and the ids of the tracks to use from it, or `none` when the user
 * wants the episode without subtitles. An episode with no file has no entry in `HelperState.choices`. File and track
 * ids are unique only within their release (and track ids only within their file), so a file is named by its
 * release's key and its id together.
 */
export type EpisodeChoice =
  | 'none'
  | {
      /** The key of the pooled release the file belongs to. */
      readonly releaseKey: string;
      /** The file's id within that release. */
      readonly fileId: string;
      /** The chosen tracks' ids within that file. */
      readonly trackIds: readonly string[];
    };

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
  /** How many episodes the releases number before this disc's first (for a later season or disc). */
  readonly episodeOffset: number;
  /** The releases the user added, in the order they were added; keys are unique. */
  readonly releases: readonly PooledRelease[];
  /** Each episode's file and tracks, or `none`; an episode without an entry has no file. */
  readonly choices: Readonly<Record<number, EpisodeChoice>>;
  /** Timing per episode; an episode without an entry has not been lined up. */
  readonly timing: Readonly<Record<number, EpisodeTiming>>;
  /** The metadata panel's draft. */
  readonly metadata: MetadataDraft;
  /** Whether anything changed since the last save or restore. */
  readonly dirty: boolean;
}

/** What can happen to the state. Every action but `goTo`, `load`, `saved` and `fillDefaults` marks the state dirty. */
export type HelperAction =
  /** Moves to a step, when `canEnter` allows it. */
  | { readonly type: 'goTo'; readonly step: Step }
  /**
   * Picks the show (null clears it). A different show removes every release that came from the old show's SeaDex
   * list, as `removeRelease` does; releases from an Anime Tosho search or the user's own files stay. A different show
   * also forgets the old show's episode titles in the metadata draft.
   */
  | { readonly type: 'setTitle'; readonly title: TitleHit | null }
  /**
   * Sets the episode offset. The caller fetches every pooled release again at the new offset and sends `addRelease`
   * for each, which keeps an episode's file only while it still fits that episode.
   */
  | { readonly type: 'setOffset'; readonly offset: number }
  /**
   * Adds a release at the end of the pool, or replaces the pooled release with the same key in place (a fetch at
   * another offset, or the same release found again). A replaced release keeps each episode's choice whose file still
   * fits that episode: the file is among the episode's candidates in the new match, or is a file no episode was or is
   * numbered for (an extra), with the tracks still in it; other episodes that used it lose their file, timing and
   * drafted tracks. Then every episode with no file (not one marked `none`) takes this release's matched file with all
   * its tracks, when that file has any.
   */
  | { readonly type: 'addRelease'; readonly release: ReleaseAnswer; readonly from: ReleaseSource }
  /** Removes a release from the pool; the episodes that used it lose their file, timing and drafted tracks. */
  | { readonly type: 'removeRelease'; readonly key: string }
  /**
   * Uses a pooled release's file for an episode, with all its tracks, dropping the episode's timing. A null key or id
   * leaves the episode with no file and clears its drafted tracks; a file not in the pool changes nothing.
   */
  | { readonly type: 'chooseFile'; readonly episode: number; readonly releaseKey: string | null; readonly fileId: string | null }
  /** Sets which tracks of the episode's file it uses; does nothing to an episode with no file. */
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
  /** Replaces the metadata draft, as the user edited it. */
  | { readonly type: 'setMetadata'; readonly metadata: MetadataDraft }
  /**
   * Puts fresh defaults (`metadataDefaults`) into the fields of the metadata draft the user has not edited
   * (`mergeDefaults`). Filling defaults is not a change the user made, so it leaves `dirty` as it is.
   */
  | { readonly type: 'fillDefaults'; readonly defaults: MetadataDraft }
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
    releases: [],
    choices: {},
    timing: {},
    metadata: { episodes: {}, edited: new Set() },
    dirty: false,
  };
}

/**
 * Whether the user may go to `step`: step 1 always, step 2 once the pool holds a release, step 3 once at least one
 * episode has tracks chosen or is marked as having none.
 */
export function canEnter(state: HelperState, step: Step): boolean {
  if (step === 1) return true;
  if (step === 2) return state.releases.length > 0;
  return Object.values(state.choices).some((c) => c === 'none' || c.trackIds.length > 0);
}

/** The pooled release with key `key`, or null when the pool has none. */
export function releaseOf(state: Pick<HelperState, 'releases'>, key: string): PooledRelease | null {
  return state.releases.find((p) => p.release.key === key) ?? null;
}

/**
 * The file an episode uses and the pooled release it belongs to, found by the choice's release key and file id
 * together; null for an episode with no file, one marked `none`, or one whose release or file is not in the pool.
 */
export function episodeFile(state: Pick<HelperState, 'releases' | 'choices'>, episode: number): { readonly pooled: PooledRelease; readonly file: CachedReleaseFile } | null {
  const choice = state.choices[episode];
  if (choice === undefined || choice === 'none') return null;
  const pooled = releaseOf(state, choice.releaseKey);
  const file = pooled?.release.files.find((f) => f.id === choice.fileId);
  return pooled && file ? { pooled, file } : null;
}

/** A file an episode may use: its release's key, its id within that release, and whether it is numbered for the episode. */
export interface FileCandidate {
  /** The key of the pooled release the file belongs to. */
  readonly releaseKey: string;
  /** The file's id within that release. */
  readonly fileId: string;
  /** True for a file the release's match numbers for this episode; false for one numbered for no episode (an extra). */
  readonly matched: boolean;
}

/** The ids of a release's files that no row of its match lists as a candidate: extras, unnumbered files and numbers outside the run. */
function strayIds(release: ReleaseAnswer): Set<string> {
  const numbered = new Set(release.match.rows.flatMap((r) => r.candidates));
  return new Set(release.files.filter((f) => !numbered.has(f.id)).map((f) => f.id));
}

/**
 * The files an episode may use, release by release in pool order: within each release the files its match numbers
 * for the episode (newest version first, as the backend lists them), then the release's files numbered for no
 * episode, in release order. Files numbered for another episode are left out.
 */
export function candidatesFor(state: Pick<HelperState, 'releases'>, episode: number): FileCandidate[] {
  return state.releases.flatMap(({ release }) => {
    const row = release.match.rows.find((r) => r.episode === episode);
    const matched = (row?.candidates ?? []).filter((id) => release.files.some((f) => f.id === id)).map((fileId) => ({ releaseKey: release.key, fileId, matched: true }));
    const strays = strayIds(release);
    const extras = release.files.filter((f) => strays.has(f.id)).map((f) => ({ releaseKey: release.key, fileId: f.id, matched: false }));
    return [...matched, ...extras];
  });
}

/** `record` without `key`. */
function without<T>(record: Readonly<Record<number, T>>, key: number): Record<number, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** The draft without AniList's episode titles, which belong to the show they were asked for. */
function withoutEpisodeTitles(metadata: MetadataDraft): MetadataDraft {
  const episodes: Record<number, EpisodeDraft> = {};
  for (const e of Object.values(metadata.episodes)) episodes[e.index] = { ...e, episodeTitle: '' };
  return { ...metadata, episodes };
}

/** The draft without one episode's subtitle tracks, for when the file they came from is no longer its file. */
function withoutTracks(metadata: MetadataDraft, episode: number): MetadataDraft {
  const draft = metadata.episodes[episode];
  if (draft === undefined || draft.tracks.length === 0) return metadata;
  return { ...metadata, episodes: { ...metadata.episodes, [episode]: { ...draft, tracks: [] } } };
}

/** The state with an episode left with no file: no choice, no timing, no drafted tracks. */
function withoutFile(state: HelperState, episode: number): HelperState {
  return { ...state, choices: without(state.choices, episode), timing: without(state.timing, episode), metadata: withoutTracks(state.metadata, episode) };
}

/** The timing an episode has, or the release's own timing when it was never lined up. */
function timingOf(state: HelperState, episode: number): EpisodeTiming {
  return state.timing[episode] ?? { alignment: { kind: 'original' }, nudgeMs: 0, accepted: false };
}

/** The state without the pooled release `key`, and without the files of the episodes that used it. */
function removeRelease(state: HelperState, key: string): HelperState {
  if (releaseOf(state, key) === null) return state;
  let next: HelperState = { ...state, releases: state.releases.filter((p) => p.release.key !== key) };
  for (const [episode, choice] of Object.entries(state.choices)) {
    if (choice !== 'none' && choice.releaseKey === key) next = withoutFile(next, Number(episode));
  }
  return next;
}

/** The `addRelease` action: see its description. */
function addRelease(state: HelperState, release: ReleaseAnswer, from: ReleaseSource): HelperState {
  const key = release.key;
  const old = releaseOf(state, key);
  const pooled: PooledRelease = { release, source: from };
  let next: HelperState = { ...state, releases: old ? state.releases.map((p) => (p === old ? pooled : p)) : [...state.releases, pooled] };

  if (old) {
    const oldStrays = strayIds(old.release);
    const newStrays = strayIds(release);
    for (const [index, choice] of Object.entries(state.choices)) {
      if (choice === 'none' || choice.releaseKey !== key) continue;
      const episode = Number(index);
      const file = release.files.find((f) => f.id === choice.fileId);
      const row = release.match.rows.find((r) => r.episode === episode);
      const fits = row?.candidates.includes(choice.fileId) === true || (oldStrays.has(choice.fileId) && newStrays.has(choice.fileId));
      if (file && fits) {
        const trackIds = choice.trackIds.filter((id) => file.tracks.some((t) => t.id === id));
        next = { ...next, choices: { ...next.choices, [episode]: { ...choice, trackIds } } };
      } else {
        next = withoutFile(next, episode);
      }
    }
  }

  for (const row of release.match.rows) {
    if (next.choices[row.episode] !== undefined || row.fileId === null) continue;
    const file = release.files.find((f) => f.id === row.fileId);
    if (!file || file.tracks.length === 0) continue;
    const choice: EpisodeChoice = { releaseKey: key, fileId: file.id, trackIds: file.tracks.map((t) => t.id) };
    next = { ...next, choices: { ...next.choices, [row.episode]: choice }, timing: without(next.timing, row.episode) };
  }
  return next;
}

function apply(state: HelperState, action: HelperAction): HelperState {
  switch (action.type) {
    case 'goTo':
      return canEnter(state, action.step) ? { ...state, step: action.step } : state;
    case 'load':
      return action.state;
    case 'saved':
      return { ...state, dirty: false };
    case 'setTitle': {
      if (action.title?.alId === state.title?.alId) return { ...state, title: action.title };
      let next: HelperState = { ...state, title: action.title, metadata: withoutEpisodeTitles(state.metadata) };
      for (const p of state.releases) if (p.source === 'seadex') next = removeRelease(next, p.release.key);
      return next;
    }
    case 'setOffset':
      return { ...state, episodeOffset: action.offset };
    case 'addRelease':
      return addRelease(state, action.release, action.from);
    case 'removeRelease':
      return removeRelease(state, action.key);
    case 'chooseFile': {
      if (action.releaseKey === null || action.fileId === null) return withoutFile(state, action.episode);
      const file = releaseOf(state, action.releaseKey)?.release.files.find((f) => f.id === action.fileId);
      if (!file) return state;
      const choice: EpisodeChoice = { releaseKey: action.releaseKey, fileId: file.id, trackIds: file.tracks.map((t) => t.id) };
      return { ...state, choices: { ...state.choices, [action.episode]: choice }, timing: without(state.timing, action.episode) };
    }
    case 'chooseTracks': {
      const choice = state.choices[action.episode];
      if (choice === undefined || choice === 'none') return state;
      return { ...state, choices: { ...state.choices, [action.episode]: { ...choice, trackIds: [...action.trackIds] } } };
    }
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
    case 'fillDefaults': {
      const metadata = mergeDefaults(state.metadata, action.defaults);
      return metadata === state.metadata ? state : { ...state, metadata };
    }
  }
}

/**
 * The state after `action`. Pure: `state` is never changed, and an action that changes nothing answers `state`
 * itself. When the action closes the step on screen (the last release removed), the state falls back to the furthest
 * step still open.
 */
export function reduce(state: HelperState, action: HelperAction): HelperState {
  let next = apply(state, action);
  const quiet = action.type === 'goTo' || action.type === 'load' || action.type === 'saved' || action.type === 'fillDefaults';
  if (!quiet && next !== state) next = { ...next, dirty: true };
  while (next.step > 1 && !canEnter(next, next.step)) next = { ...next, step: (next.step - 1) as Step };
  return next;
}

/** The chosen tracks of an episode as `defaultMetadata` takes them, in the file's order, with its own release's group. */
function chosenTrackInputs(state: HelperState, episode: number): DefaultTrackInput[] {
  const choice = state.choices[episode];
  const found = episodeFile(state, episode);
  if (choice === undefined || choice === 'none' || found === null) return [];
  const group = found.pooled.release.group;
  return found.file.tracks.filter((t) => choice.trackIds.includes(t.id)).map((t) => ({ ...t, group, key: t.path }));
}

/**
 * The metadata defaults for the state as it is now: the MKV titles from the show and AniList's episode titles, the
 * disc's audio streams and chapters, and each episode's chosen tracks, named after the group of the release that
 * episode's file comes from. Episode numbers are the releases': the run's index plus the episode offset, both in the
 * title's `nn` and for looking up AniList's title. `titles` is AniList's answer for the state's show, keyed by episode
 * number, or null while it is not known (not asked yet, still on its way, or failed): then each episode keeps the
 * AniList title its draft already has, such as one restored from a record. Without a show there are no episode
 * titles. An episode with no file keeps the tracks its draft has, so that a restored episode whose release is gone
 * keeps its saved tracks; every action that takes a file away from an episode clears them. Give the result to the
 * `fillDefaults` action.
 */
export function metadataDefaults(state: HelperState, episodes: EpisodesAnswer, titles: Readonly<Record<number, string>> | null): MetadataDraft {
  const titleOf = (index: number): string | null => {
    if (state.title === null) return null;
    const title = titles === null ? state.metadata.episodes[index]?.episodeTitle : titles[index + state.episodeOffset];
    return title === undefined || title === '' ? null : title;
  };
  const tracks: Record<number, DefaultTrackInput[]> = {};
  for (const e of episodes.episodes) tracks[e.index] = chosenTrackInputs(state, e.index);
  const defaults = defaultMetadata({
    show: state.title?.title ?? null,
    episodes: episodes.episodes.map((e) => ({ index: e.index, number: e.index + state.episodeOffset, title: titleOf(e.index), chapterCount: e.chapters.length })),
    audio: episodes.audio,
    tracks,
  });
  const kept: Record<number, EpisodeDraft> = {};
  for (const d of Object.values(defaults.episodes)) {
    kept[d.index] = state.choices[d.index] === undefined ? { ...d, tracks: state.metadata.episodes[d.index]?.tracks ?? [] } : d;
  }
  return { ...defaults, episodes: kept };
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
  const found = episodeFile(state, episode);
  if (choice === undefined || choice === 'none' || found === null) return [];
  const chosen = found.file.tracks.filter((t) => choice.trackIds.includes(t.id));
  const byKey = new Map(chosen.map((t) => [t.path, t]));
  const drafted = (draft?.tracks ?? []).filter((d) => byKey.has(d.key));
  const seen = new Set(drafted.map((d) => d.key));
  const group = found.pooled.release.group;
  const rest = chosen.filter((t) => !seen.has(t.path)).map((t, i) => defaultTrack({ ...t, group, key: t.path }, drafted.length + i));
  const timing = timingOf(state, episode);
  const shift = savedShift(timing.alignment);
  return [...drafted, ...rest].map((d) => ({
    file: d.key,
    release: choice.releaseKey,
    kind: d.kind,
    language: languageCode(d.language),
    name: d.name,
    shiftMs: shift.shiftMs,
    nudgeMs: timing.nudgeMs,
    split: shift.split,
    included: d.included,
  }));
}

/**
 * The record to save for this run. Every episode of `episodes` is written, in order: its chosen tracks with the
 * panel's names, languages, order and ticks and the key of the release they come from, its timing (an offset as
 * `shiftMs`; a split as `split` with `shiftMs` 0; `none`, `original` and an episode never lined up as 0 and null), and
 * its metadata, falling back to the defaults for an episode the panel has no draft of. `releases` lists, in pool
 * order, only the releases some saved track comes from, and `fonts` the fonts of those releases, each once. An
 * episode with no title is named `Episode <n>`, with n its number as in its MKV title (the run's index plus the
 * episode offset). Languages that are not three letters (a code left half typed) are written as `und`, as the backend
 * accepts nothing else. `savedAt` is left empty for the server to set.
 */
export function toRecord(state: HelperState, session: SessionInfo, episodes: EpisodesAnswer): SubtitleRecord {
  const defaults = metadataDefaults(state, episodes, null);
  const recordEpisodes = episodes.episodes.map((e): RecordEpisode => {
    const draft = state.metadata.episodes[e.index];
    const meta = draft ?? defaults.episodes[e.index]!;
    return {
      index: e.index,
      title: meta.episodeTitle !== '' ? meta.episodeTitle : `Episode ${e.index + state.episodeOffset}`,
      tracks: recordTracks(state, e.index, draft),
      metadata: {
        title: meta.title,
        video: { ...meta.video, language: languageCode(meta.video.language) },
        audio: meta.audio.map((a) => ({ ...a, language: languageCode(a.language) })),
        chapters: [...meta.chapters],
      },
    };
  });
  const used = new Set(recordEpisodes.flatMap((e) => e.tracks.map((t) => t.release)));
  const releases = state.releases.filter((p) => used.has(p.release.key));
  return {
    disc: { key: session.discKey, label: session.label },
    playlist: session.playlistId,
    episodeSpec: session.episodeSpec,
    anilist: state.title ? { id: state.title.alId, title: state.title.title, episodeOffset: state.episodeOffset } : null,
    releases: releases.map(({ release, source }): RecordRelease => ({ source, id: release.key, group: release.group, label: release.label })),
    fonts: [...new Set(releases.flatMap((p) => p.release.fonts.map((f) => f.path)))],
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
 * The AniList episode title a record episode holds: its `title`, unless that is the `Episode n` stand-in, n being the
 * episode's number with the record's episode offset.
 */
function savedEpisodeTitle(record: SubtitleRecord, e: RecordEpisode): string {
  return e.title === `Episode ${e.index + (record.anilist?.episodeOffset ?? 0)}` ? '' : e.title;
}

/** Whether two plain values differ. */
function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * The metadata the page would have proposed for a record episode: the defaults built from the record's show, episode
 * offset and episode title, the disc's audio streams (the record's own, in its order, when `disc` is not known), the episode's
 * chapter count and the given tracks.
 */
function recordDefaults(record: SubtitleRecord, e: RecordEpisode, disc: Pick<EpisodesAnswer, 'audio'> | null, tracks: readonly DefaultTrackInput[]): EpisodeDraft {
  const audio = disc?.audio ?? e.metadata.audio.map((a) => ({ pid: a.pid, language: a.language }));
  const draft = defaultMetadata({
    show: record.anilist?.title ?? null,
    episodes: [{ index: e.index, number: e.index + (record.anilist?.episodeOffset ?? 0), title: savedEpisodeTitle(record, e) || null, chapterCount: e.metadata.chapters.length }],
    audio,
    tracks: { [e.index]: tracks },
  });
  return draft.episodes[e.index]!;
}

/** A record in the current form: a single-release record becomes one with that release (or none) and tracks naming it. */
function currentForm(record: SubtitleRecord | SingleReleaseRecord): SubtitleRecord {
  if ('releases' in record) return record;
  const { release, episodes, ...rest } = record;
  const id = release?.id ?? '';
  return { ...rest, releases: release ? [release] : [], episodes: episodes.map((e) => ({ ...e, tracks: e.tracks.map((t) => ({ ...t, release: id })) })) };
}

/**
 * The state a saved record stands for, on step 1 and not dirty. `releases` are the backend's answers for the record's
 * releases as asked for again (`HelperApi.release(id, offset)`), in any order; the pool holds those whose key is one
 * of the record's, in the record's order and with its sources, and answers for other keys are ignored. Each episode's
 * file and tracks are found again by its tracks' release and paths. An episode saved without tracks is marked as
 * having none when any of the record's releases came back; one whose release did not come back, or whose saved tracks
 * are no longer in its release, is left with no file, so step 2 asks about it again, and its drafted tracks stay as
 * saved. Without any release the pool and choices stay empty, while the show, timings and metadata are restored. A
 * timing with no shift, split or nudge is not restored, so that episode is lined up again; whether it was `none` or
 * `original` is not saved. A record in the single-release form is read as a record with that one release.
 *
 * Only the metadata fields that differ from what the page would propose for them are marked edited, so a restored
 * record still takes new defaults (such as AniList's episode titles arriving) where the user changed nothing. `disc`
 * is the run's episodes answer, whose audio streams are the defaults to compare with; without it the record's own
 * stream languages stand in. A track list is compared only when its file is found in its release, and counts as
 * edited otherwise.
 */
export function fromRecord(saved: SubtitleRecord | SingleReleaseRecord, releases: readonly ReleaseAnswer[] = [], disc: Pick<EpisodesAnswer, 'audio'> | null = null): HelperState {
  const record = currentForm(saved);
  const base = initialState();
  const title: TitleHit | null = record.anilist
    ? { alId: record.anilist.id, title: record.anilist.title, nativeTitle: null, year: null, format: null, episodes: null, poster: null }
    : null;
  const pool: PooledRelease[] = record.releases.flatMap((r) => {
    const release = releases.find((a) => a.key === r.id);
    return release ? [{ release, source: r.source }] : [];
  });

  const timing: Record<number, EpisodeTiming> = {};
  const episodes: Record<number, EpisodeDraft> = {};
  const edited = new Set<string>();
  const choices: Record<number, EpisodeChoice> = {};

  for (const e of record.episodes) {
    const first = e.tracks[0];
    if (first && (first.shiftMs !== 0 || first.split !== null || first.nudgeMs !== 0)) {
      timing[e.index] = { alignment: restoredAlignment(first), nudgeMs: first.nudgeMs, accepted: true };
    }
    const tracks: TrackDraft[] = e.tracks.map((t) => ({ key: t.file, kind: t.kind, name: t.name, language: t.language, included: t.included }));
    const draft: EpisodeDraft = {
      index: e.index,
      episodeTitle: savedEpisodeTitle(record, e),
      title: e.metadata.title,
      video: { ...e.metadata.video },
      audio: e.metadata.audio.map((a) => ({ ...a })),
      chapters: [...e.metadata.chapters],
      tracks,
    };
    episodes[e.index] = draft;

    const pooled = first === undefined ? null : (pool.find((p) => p.release.key === first.release) ?? null);
    const paths = new Set(e.tracks.filter((t) => t.release === pooled?.release.key).map((t) => t.file));
    const file = pooled?.release.files.find((f) => f.tracks.some((t) => paths.has(t.path))) ?? null;
    const group = pooled?.release.group ?? '';
    const fileTracks = file === null ? null : file.tracks.filter((t) => paths.has(t.path)).map((t) => ({ ...t, group, key: t.path }));
    const defaults = recordDefaults(record, e, disc, fileTracks ?? []);
    if (draft.title !== defaults.title) edited.add(`episodes.${e.index}.title`);
    if (differs(draft.video, defaults.video)) edited.add(`episodes.${e.index}.video`);
    if (differs(draft.audio, defaults.audio)) edited.add(`episodes.${e.index}.audio`);
    if (differs(draft.chapters, defaults.chapters)) edited.add(`episodes.${e.index}.chapters`);
    if (fileTracks === null ? tracks.length > 0 : differs(tracks, defaults.tracks)) edited.add(`episodes.${e.index}.tracks`);

    if (e.tracks.length === 0) {
      if (pool.length > 0) choices[e.index] = 'none';
      continue;
    }
    if (pooled === null || file === null) continue;
    choices[e.index] = { releaseKey: pooled.release.key, fileId: file.id, trackIds: file.tracks.filter((t) => paths.has(t.path)).map((t) => t.id) };
  }

  return {
    ...base,
    title,
    episodeOffset: record.anilist?.episodeOffset ?? 0,
    releases: pool,
    choices,
    timing,
    metadata: { episodes, edited },
  };
}
