import type { FansubPick, FansubPickRequest, PlaceFansub, PlaceTextFile, StoredSubtitle } from '../engine/disc/nas-api';
import type { PgTrack, SubtitleChoice } from '../engine/protocol';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { isFontName } from '../player/drop-files';
import { settingsForUpNext } from './place-model';
import type { PlaceSaver } from './place-saver';
import type { StoredTextFile } from './place-store';
import { NasHttpError, type NasClient } from './nas/nas-client';
import { PICK_FAILED, sameTrack, type FansubOrigin } from './nas/tosho-search-model';
import { forPlaylist, sameLanguage, STORED_LIST_TIMEOUT_MS } from './nas/subtitle-model';

const PG_DISPLAY_FLAG = 0x80000000;
/** StoredSubtitlePicker's notice code for an Anime Tosho pick, so a resume's failure replaces (or is replaced by) the menu's. */
const FANSUB_NOTICE_CODE = 'fansub-pick';
/** The engine has this long to list the re-added files; past it they are given up (a later pick is the user's own). */
export const TEXT_WAIT_MS = 10_000;
/** A resumed stored subtitle's download (file and fonts) is given up after this long (a stalled route). */
export const STORED_FETCH_TIMEOUT_MS = 15_000;

/** `p`, or a rejection after `ms` (calling `onLate` then, to stop what `p` waits on). */
function within<T>(p: Promise<T>, ms: number, onLate?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onLate?.();
      reject(new Error(`no answer in ${ms} ms`));
    }, ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export interface LaunchSettingsDeps {
  readonly controller: Pick<
    PlayerController,
    'discOpens' | 'setVolume' | 'toggleMute' | 'selectAudio' | 'selectSubtitle' | 'loadSubtitleFiles' | 'setSubtitleStart' | 'shiftSubtitleFile' | 'scaleSubtitles' | 'showNotice'
  >;
  readonly places: Pick<PlaceSaver, 'takeLaunchSettings' | 'storedTextFiles' | 'addTextFiles' | 'noteStoredSubtitle' | 'noteFansubPick'>;
  /** Where subtitles stored on the NAS (and a viewer's Anime Tosho picks) come from; absent with no NAS paired. */
  readonly nas?: Pick<NasClient, 'subtitlesForDisc' | 'subtitleFiles' | 'pickFansub' | 'toshoRelease'>;
  /** Picks a stored subtitle as the Subtitles menu does (StoredSubtitlePicker.pick), for Up next; true once placed. */
  readonly pickStored?: (s: StoredSubtitle) => Promise<boolean>;
  /** Picks an Anime Tosho track as the search does (StoredSubtitlePicker.pickFansub), for Up next; the pick once placed. */
  readonly pickFansub?: (req: FansubPickRequest, origin: FansubOrigin) => Promise<FansubPick | null>;
  /** A resumed stored subtitle is in the text set again (the menu checks its row). */
  readonly onStoredSubtitle?: (id: string) => void;
  /** A resumed Anime Tosho pick is in the text set again (the search checks its track). */
  readonly onFansubPick?: (pick: FansubPick, fansub: PlaceFansub) => void;
  readonly log?: (message: string, err: unknown) => void;
  readonly nowMs?: () => number;
}

/** The text files being added again, until the engine reports them and their placements and offsets can be set. */
interface PendingText {
  readonly opens: number;
  readonly files: readonly PlaceTextFile[];
  readonly placed: boolean;
  readonly textOn: boolean;
  readonly psr2: number;
  readonly scale: number;
  /** When to give up waiting for the engine's list. */
  readonly untilMs: number;
}

/** PSR2 as a subtitle choice: its PG stream when the display flag is on and the stream exists, else off. */
function pgChoice(psr2: number, pg: readonly PgTrack[]): SubtitleChoice {
  const stream = psr2 & 0xfff;
  return (psr2 & PG_DISPLAY_FLAG) !== 0 && pg.some((t) => t.index === stream) ? { kind: 'pg', stream } : { kind: 'off' };
}

/**
 * A stored subtitle (or a viewer's Anime Tosho pick, with `fansub`) a resumed place names, fetched again: its place
 * entry (under the NAS's file name now) and files.
 */
interface Fetched {
  readonly entry: PlaceTextFile;
  readonly subtitle: StoredSubtitle;
  readonly fansub?: PlaceFansub;
  readonly files: readonly File[];
}

/** A place's entry for a file from the NAS: a stored subtitle's or an Anime Tosho pick's (never on this device). */
const fromNas = (f: PlaceTextFile): boolean => f.subtitleId !== undefined || f.fansub !== undefined;

/** The stored files a place's text files name (by name, and by size when the place knows it), with the stored fonts. */
export function filesToAdd(wanted: readonly PlaceTextFile[], stored: readonly StoredTextFile[]): { readonly subtitles: readonly StoredTextFile[]; readonly fonts: readonly StoredTextFile[] } {
  const subtitles = wanted.flatMap((w) => {
    const f = stored.find((s) => s.name === w.name && !isFontName(s.name) && (w.size === 0 || s.bytes.byteLength === w.size));
    return f ? [f] : [];
  });
  return { subtitles, fonts: subtitles.length > 0 ? stored.filter((s) => isFontName(s.name)) : [] };
}

/**
 * Applies a launch's settings once its disc plays (spec 2026-10-20 §6.1, §6.3, §6.6): volume and mute, audio and PG by language for another playlist's settings, and the text subtitle files (this device's, and on a resume
 * those stored on the NAS) with their placements, offsets and scale. A carried file this device has no bytes for (for
 * this disc), or that the NAS no longer has or can't send, is skipped silently. For Up next, a stored subtitle that was
 * shown picks this playlist's stored subtitle in its language instead, and the episode before's other files are left.
 */
export class LaunchSettingsApplier {
  private text: PendingText | null = null;
  /** Bumped by supersede: a re-add started under an older value loads and notes nothing. */
  private generation = 0;
  /** The stored subtitles being downloaded for a resume: stopped by supersede (and each by its timeout). */
  private readonly downloads = new Set<AbortController>();

  constructor(private readonly deps: LaunchSettingsDeps) {}

  /**
   * The user replaced the text set (a local pick, or a stored row in the menu): files still being re-added for the
   * launch are dropped, so they never replace the user's pick.
   */
  supersede(): void {
    this.generation++;
    this.text = null;
    for (const d of this.downloads) d.abort();
    this.downloads.clear();
  }

  /**
   * Each snapshot of the player. A place's shader set is never applied: the shader is this device's own choice (Off
   * until chosen here), so a place saved elsewhere doesn't switch one on.
   */
  observe(s: PlayerSnapshot): void {
    if (this.text) this.finishText(s);
    // nothing playing: no playlist to pick a resumed subtitle for, so the launch waits (a pick needs one)
    const playlistId = s.currentPlaylistId;
    if (playlistId === null || (s.engineState !== 'playing' && s.engineState !== 'paused')) return;
    const launch = this.deps.places.takeLaunchSettings();
    if (!launch) return;
    const { controller } = this.deps;
    const settings = launch.byLanguage ? settingsForUpNext(launch.settings, s.audioTracks, s.subtitles?.pg ?? []) : launch.settings;
    controller.setVolume(settings.volume);
    if (settings.muted !== s.muted) controller.toggleMute();
    const pg = s.subtitles?.pg ?? [];
    // Up next: a stored subtitle shown on the episode before carries its language to this one's (spec §6.6)
    const carried = launch.byLanguage && settings.textOn ? settings.textFiles.find((f) => fromNas(f) && f.language !== undefined) : undefined;
    if (launch.byLanguage) {
      controller.selectAudio(settings.psr1);
      if (!settings.textOn) controller.selectSubtitle(pgChoice(settings.psr2, pg));
    }
    if (carried?.fansub) void this.pickNextFansub(launch.discKey, playlistId, carried.fansub, carried.language!, pgChoice(settings.psr2, pg));
    else if (carried) void this.pickNext(launch.discKey, playlistId, carried.language!, pgChoice(settings.psr2, pg));
    else if (settings.textFiles.length > 0) void this.addText(launch.discKey, playlistId, settings, !launch.byLanguage);
  }

  /**
   * Up next after an Anime Tosho pick (spec §9): the release is listed for this playlist, and the episode's file there
   * with a track of the same name is picked as the search picks one. With none (or the release not listed), as for a
   * stored subtitle: this playlist's stored subtitle in the pick's language, else PG.
   */
  private async pickNextFansub(discKey: string, playlistId: string, fansub: PlaceFansub, language: string, pg: SubtitleChoice): Promise<void> {
    const { controller, nas, pickFansub } = this.deps;
    const opens = controller.discOpens;
    const gen = this.generation;
    let req: FansubPickRequest | null = null;
    let trackName = '';
    if (nas && pickFansub) {
      try {
        const listed = await within(nas.toshoRelease(fansub.releaseId, discKey, playlistId), STORED_FETCH_TIMEOUT_MS);
        const file = listed.files.find((f) => f.id === listed.matchedFileId);
        const track = file?.tracks.find((t) => sameTrack(t, fansub.trackName));
        if (file && track) {
          req = { fileId: file.id, track: track.track, discKey, playlistId };
          trackName = track.name;
        }
      } catch (err) {
        this.deps.log?.('listing the Anime Tosho release failed', err);
      }
    }
    if (controller.discOpens !== opens || this.generation !== gen) return;
    if (req) void pickFansub!(req, { releaseId: fansub.releaseId, trackName });
    else await this.pickNext(discKey, playlistId, language, pg);
  }

  /**
   * Up next: this playlist's stored subtitle in `language`, picked as the menu picks one (at its default offset); with
   * none (or no list), PG as the language chose it.
   */
  private async pickNext(discKey: string, playlistId: string, language: string, pg: SubtitleChoice): Promise<void> {
    const { controller, nas, pickStored } = this.deps;
    const opens = controller.discOpens;
    const gen = this.generation;
    let match: StoredSubtitle | null = null;
    if (nas && pickStored) {
      try {
        match = sameLanguage(forPlaylist(await nas.subtitlesForDisc(discKey, { timeoutMs: STORED_LIST_TIMEOUT_MS }), discKey, playlistId), language);
      } catch (err) {
        this.deps.log?.('listing the stored subtitles failed', err);
      }
    }
    // another disc, or a pick the user made while the list came (supersede): theirs stands
    if (controller.discOpens !== opens || this.generation !== gen) return;
    if (match) void pickStored!(match);
    else controller.selectSubtitle(pg);
  }

  /**
   * A resume's text files again: local ones from this device's store, stored ones (`subtitleId`, only when `placed`:
   * the place is this playlist's) from the NAS, all in one load so the set is replaced once. A file that can't be had
   * is skipped silently.
   */
  private async addText(discKey: string, playlistId: string, settings: { readonly textFiles: readonly PlaceTextFile[]; readonly textOn: boolean; readonly psr2: number; readonly textScale: number }, placed: boolean): Promise<void> {
    const { controller, places } = this.deps;
    const opens = controller.discOpens;
    const gen = this.generation;
    const current = (): boolean => controller.discOpens === opens && this.generation === gen;
    try {
      const [{ subtitles, fonts }, fetched] = await Promise.all([
        places.storedTextFiles(discKey).then((kept) => filesToAdd(settings.textFiles.filter((f) => !fromNas(f)), kept)),
        placed ? Promise.all([this.fetchStored(discKey, settings.textFiles), this.fetchPicks(discKey, playlistId, settings.textFiles)]).then(([a, b]) => [...a, ...b]) : Promise.resolve([]),
      ]);
      if ((subtitles.length === 0 && fetched.length === 0) || !current()) return;
      const local = new Map(subtitles.map((f) => [f.name, f]));
      const toFile = (f: StoredTextFile): File => new File([f.bytes as Uint8Array<ArrayBuffer>], f.name);
      const localFiles = [...subtitles, ...fonts].map(toFile);
      // the place's order (the engine lists the set in load order), then the fonts
      const entries: PlaceTextFile[] = [];
      const files: File[] = [];
      for (const f of settings.textFiles) {
        const got = f.subtitleId !== undefined ? fetched.find((x) => x.subtitle.id === f.subtitleId) : f.fansub !== undefined ? fetched.find((x) => x.fansub === f.fansub) : undefined;
        if (got) {
          entries.push(got.entry);
          files.push(got.files[0]!);
        } else if (!fromNas(f) && local.has(f.name) && !entries.some((e) => e.name === f.name)) {
          entries.push(f);
          files.push(toFile(local.get(f.name)!));
        }
      }
      files.push(...fonts.map(toFile), ...fetched.flatMap((x) => x.files.slice(1)));
      const pending: PendingText = {
        opens, files: entries, placed, textOn: settings.textOn, psr2: settings.psr2, scale: settings.textScale,
        untilMs: this.now() + TEXT_WAIT_MS,
      };
      this.text = pending;
      try {
        await controller.loadSubtitleFiles(files);
      } catch (err) {
        if (this.text === pending) this.text = null;
        throw err;
      }
      if (!current()) return;
      // The local ones kept again for this disc's later places (their sizes); the NAS keeps the stored ones. Keeping
      // them clears the saver's note at once (before its first await), so the note follows the start of the keep, and
      // doesn't wait for (or depend on) the device's write.
      const keeping = subtitles.length > 0 ? places.addTextFiles(localFiles) : Promise.resolve();
      // A stored pick replaces the set, so a place names at most one stored subtitle (the saver keeps one note).
      const stored = fetched[0];
      if (stored?.fansub) {
        places.noteFansubPick(stored.subtitle.fileName, stored.fansub, stored.subtitle.fileSize, stored.subtitle.language);
        this.deps.onFansubPick?.(stored.subtitle as FansubPick, stored.fansub);
      } else if (stored) {
        places.noteStoredSubtitle(stored.subtitle.fileName, stored.subtitle.id, stored.subtitle.fileSize, stored.subtitle.language);
        this.deps.onStoredSubtitle?.(stored.subtitle.id);
      }
      await keeping;
    } catch (err) {
      this.deps.log?.('adding the subtitle files again failed', err);
    }
  }

  /** The stored subtitles a place names, by id, fetched from the NAS; one gone or failing is left out. */
  private async fetchStored(discKey: string, wanted: readonly PlaceTextFile[]): Promise<Fetched[]> {
    const { nas } = this.deps;
    const ids = wanted.filter((f) => f.subtitleId !== undefined);
    if (!nas || ids.length === 0) return [];
    let list: StoredSubtitle[];
    try {
      list = await nas.subtitlesForDisc(discKey, { timeoutMs: STORED_LIST_TIMEOUT_MS });
    } catch (err) {
      this.deps.log?.('listing the stored subtitles failed', err);
      return [];
    }
    const found = await Promise.all(ids.map(async (entry): Promise<Fetched | null> => {
      const subtitle = list.find((x) => x.id === entry.subtitleId);
      if (!subtitle) return null;
      const download = new AbortController();
      this.downloads.add(download);
      try {
        const files = await within(nas.subtitleFiles(subtitle, download.signal), STORED_FETCH_TIMEOUT_MS, () => download.abort());
        return { entry: { ...entry, name: subtitle.fileName }, subtitle, files };
      } catch (err) {
        this.deps.log?.('fetching the stored subtitle failed', err);
        return null;
      } finally {
        this.downloads.delete(download);
      }
    }));
    return found.filter((x): x is Fetched => x !== null);
  }

  /**
   * The Anime Tosho picks a place names, picked again on the NAS for this playlist (from its cache, or fetched again)
   * with their files, each within STORED_FETCH_TIMEOUT_MS. A NAS that no longer knows the file (404 unknown-file) is
   * asked to list its release first. One that fails shows PICK_FAILED and is left out, so the text set stays as it was.
   */
  private async fetchPicks(discKey: string, playlistId: string, wanted: readonly PlaceTextFile[]): Promise<Fetched[]> {
    const { nas, controller } = this.deps;
    const picks = wanted.filter((f) => f.fansub !== undefined);
    if (!nas || picks.length === 0) return [];
    const opens = controller.discOpens;
    const gen = this.generation;
    const found = await Promise.all(picks.map(async (entry): Promise<Fetched | null> => {
      const fansub = entry.fansub!;
      const req: FansubPickRequest = { fileId: fansub.fileId, track: fansub.track, discKey, playlistId };
      const download = new AbortController();
      this.downloads.add(download);
      const fetchOne = async (): Promise<Fetched> => {
        let subtitle: FansubPick;
        try {
          subtitle = await nas.pickFansub(req);
        } catch (err) {
          if (!(err instanceof NasHttpError && err.status === 404 && err.code === 'unknown-file')) throw err;
          await nas.toshoRelease(fansub.releaseId, discKey, playlistId);
          subtitle = await nas.pickFansub(req);
        }
        const files = await nas.subtitleFiles(subtitle, download.signal);
        return { entry: { ...entry, name: subtitle.fileName }, subtitle, fansub, files };
      };
      try {
        return await within(fetchOne(), STORED_FETCH_TIMEOUT_MS, () => download.abort());
      } catch (err) {
        this.deps.log?.('picking the Anime Tosho subtitle again failed', err);
        if (controller.discOpens === opens && this.generation === gen) controller.showNotice(FANSUB_NOTICE_CODE, PICK_FAILED);
        return null;
      } finally {
        this.downloads.delete(download);
      }
    }));
    return found.filter((x): x is Fetched => x !== null);
  }

  private now(): number {
    return (this.deps.nowMs ?? Date.now)();
  }

  /**
   * Once the engine has the files: their placements (the same playlist's only), offsets and scale, and PG back if text
   * was off. Given up on another disc, past TEXT_WAIT_MS, or at a list without them (a file that didn't parse).
   */
  private finishText(s: PlayerSnapshot): void {
    const t = this.text!;
    const { controller } = this.deps;
    const subs = s.subtitles;
    const loaded = subs?.text?.files;
    if (controller.discOpens !== t.opens || this.now() > t.untilMs) {
      this.text = null;
      return;
    }
    if (!subs || !loaded) return;
    this.text = null;
    if (!t.files.every((f) => loaded.some((l) => l.name === f.name))) return;
    for (const f of t.files) {
      const i = loaded.findIndex((l) => l.name === f.name);
      const now = loaded[i]!;
      if (t.placed && f.startUs !== now.startUs) controller.setSubtitleStart(i, f.startUs);
      if (f.offsetMs !== now.offsetMs) controller.shiftSubtitleFile(i, f.offsetMs - now.offsetMs);
    }
    if (t.scale !== subs.scale) controller.scaleSubtitles(t.scale - subs.scale);
    if (!t.textOn) controller.selectSubtitle(pgChoice(t.psr2, subs.pg));
  }
}
