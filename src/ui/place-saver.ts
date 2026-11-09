import type { DiscPlaces, PlaceFansub, PlaceSettings, PlaybackPlace } from '@seikou/nas/nas-api';
import type { PlaceState } from '@seikou/engine/protocol';
import { isFontName, pickedSubtitles, splitPick } from '@seikou/engine/controller/drop-files';
import type { PlayerSnapshot } from '@seikou/engine/controller/player-controller';
import { NasHttpError, type NasClient } from './nas/nas-client';
import { buildPlace, PLACE_MIN_DURATION_US, qualifies, type StoredSubtitleNote, type TrackNames } from './place-model';
import { pairingKey } from './nas/nas-store';
import { MAX_TEXT_FILE_BYTES, MAX_TEXT_FILES_BYTES, placeKey, type PlaceStore, type StoredTextFile } from './place-store';

/** A local disc's places name their device this way ("Stopped at 3:12 of 24:00 on this device"). */
export const LOCAL_DEVICE_NAME = 'this device';
/** Spec 2026-10-20 §6.2: saved this often while playing. */
export const SAVE_EVERY_MS = 10_000;
/** A time that moves this much more (or less) than the clock did between two snapshots was a seek. */
const SEEK_JUMP_US = 2_000_000;
/**
 * A playlist left this close to its end ended there: under a disc program the navigator (or BD-J) moves on before the
 * player reports `ended`, so the saver sees the playlist change at about its duration less one tick.
 */
const ENDED_WITHIN_US = 1_000_000;
/** What the NAS accepts in a place's text files (server/src/playback-store.ts). */
const MAX_TEXT_FILES = 64;
const MAX_TEXT_FILE_NAME = 512;

/** The disc a save is for, as its launch knows it. */
export interface PlaceTarget {
  /** `discKeyOf` of the disc's files: an `f.` key (content fingerprint), else `d.<disc id>`. */
  readonly discKey: string;
  /** The NAS's disc id; null for a local folder or a disc-server disc. */
  readonly discId: string | null;
  /** A NAS disc: places also go to the NAS. Otherwise they stay on this device. */
  readonly remote: boolean;
  /** The playlist the user launched (an episode, a link), which makes a place at any length. */
  readonly chosen: string | null;
  /** The disc's main title, which makes a place at any length. */
  readonly mainPlaylistId: string | null;
  readonly deviceName: string;
  /** `pairingKey` of the pairing a NAS disc was opened through (its places go to that pairing only); null otherwise. */
  readonly pairing: string | null;
  /**
   * An encoded episode (`discKey` its `e.` key, `discId` its encode id, its one playlist `mkv`): its places carry no
   * program state (mode `none`, no PSRs, GPRs or title), as the NAS requires of an encode's.
   */
  readonly encode?: boolean;
  /** Already saved finished (Next episode moved on, then failed to open the next): every save stays finished. */
  readonly finished?: boolean;
}

/**
 * Settings a launch hands to the player, applied once the disc has opened: a resumed place's (or Start from
 * beginning's), an Up next card's, or the disc's defaults (spec 2026-10-20 §6.1, §6.3, §6.6).
 */
export interface LaunchSettings {
  readonly settings: PlaceSettings;
  /**
   * Audio and PG chosen by language (`settingsForUpNext`): the settings are another playlist's. False when the launch's
   * start already set them (PSR 1–3 or the saved registers).
   */
  readonly byLanguage: boolean;
  /** With `byLanguage`: the names of the tracks that played (Next episode of an encode), preferred among a language's. */
  readonly names?: TrackNames;
}

export interface PlaceSaverDeps {
  readonly store: PlaceStore;
  /** Where a NAS disc's places go; null with no NAS paired. */
  readonly nas: Pick<NasClient, 'putPlace' | 'pairing'> | null;
  /** The engine's registers (PlayerController.readPlace): answered in command order. */
  readonly readPlace: () => Promise<PlaceState>;
  /** PlayerController.discOpens: a read made under another open is not this disc's. */
  readonly discOpens: () => number;
  readonly nowMs: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** PLACE_MIN_DURATION_US, or `?placemin=` (placeMinDurationUs). */
  readonly minDurationUs?: number;
  readonly log?: (message: string, err: unknown) => void;
  /** The open disc's level audio number (PSR1 numbering); null at Original or with no level session. */
  readonly levelAudio?: () => number | null;
}

interface Active extends PlaceTarget {
  /** The controller's open count when the disc opened: reads under another open are dropped. */
  readonly opens: number;
}

interface Seen {
  readonly snapshot: PlayerSnapshot;
  readonly shaderSet: string | null;
  readonly atMs: number;
}

/** The registers last read for a playlist of the open disc, for a save that can't wait for a read. */
interface Cached {
  readonly opens: number;
  readonly playlistId: string;
  readonly place: PlaceState;
}

/** The text files' sizes and the stored subtitle, by file name, as a save started (they are cleared when the disc ends). */
interface TextNotes {
  readonly sizes: Readonly<Record<string, number>>;
  readonly stored: Readonly<Record<string, StoredSubtitleNote>>;
}

/** What a save carries besides the registers: tracks, subtitles and their offsets, scale, shader. */
function settingsOf(seen: Seen): string {
  const s = seen.snapshot;
  const subs = s.subtitles;
  return JSON.stringify([s.selectedAudio, subs?.selected ?? null, subs?.scale ?? null, subs?.text?.files.map((f) => [f.name, f.startUs, f.offsetMs]) ?? null, seen.shaderSet]);
}

/** Spec §6.2's "at once" saves: a pause (or the end), a seek, a track, offset or shader change. */
function savesAtOnce(prev: Seen, next: Seen): boolean {
  const a = prev.snapshot;
  const b = next.snapshot;
  if (b.engineState !== a.engineState && (b.engineState === 'paused' || b.engineState === 'ended')) return true;
  const expectedUs = a.engineState === 'playing' ? (next.atMs - prev.atMs) * 1000 : 0;
  if (Math.abs(b.timeUs - a.timeUs - expectedUs) > SEEK_JUMP_US) return true;
  return settingsOf(prev) !== settingsOf(next);
}

/**
 * What a failed send means for an outbox place: `drop` (refused for good: a bad place, too large, a bad key), `wait`
 * (the NAS is unreachable, or doesn't have the place routes yet: a plain 404; try everything later), or `refused`
 * (another error answer: counted, and the place is dropped after MAX_SEND_ATTEMPTS).
 */
function failure(err: unknown): 'drop' | 'wait' | 'refused' {
  if (!(err instanceof NasHttpError)) return 'wait';
  if (err.status === 400 || err.status === 413 || (err.status === 404 && err.code === 'bad-key')) return 'drop';
  // a plain 404, a rate limit, or the NAS restarting behind its proxy: nothing wrong with the place
  return TRANSIENT.has(err.status) ? 'wait' : 'refused';
}

const TRANSIENT = new Set([404, 429, 502, 503, 504]);

/** An encode's place has no program: what its places carry in place of the engine's registers. */
const ENCODE_REGISTERS: PlaceState = { mode: 'none', title: null, psrs: [], gprs: null };

/**
 * Saves the open disc's place (spec 2026-10-20 §6.2): every 10 s while playing and at once on a pause, seek, track,
 * offset or shader change, or when the playlist changes (the one that stopped, where it stopped). Only a qualifying
 * playlist (qualifies) makes a place, so a menu loop after an episode keeps the episode's. Every save goes to the
 * device first: a local disc's into its places, a NAS disc's into the outbox only, sent from there and kept there while
 * the NAS can't be reached.
 */
export class PlaceSaver {
  private target: Active | null = null;
  private seen: Seen | null = null;
  private cached: Cached | null = null;
  private timer: unknown = null;
  /** Saves in order: a write never overtakes an earlier one. */
  private chain: Promise<void> = Promise.resolve();
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  /** Byte sizes of the text files added to this disc, by name (the engine's snapshot has none). */
  private sizes: Record<string, number> = {};
  /** The NAS subtitle (stored or a viewer's pick) in the text set, by its file name (a pick replaces the set, so there is at most one). */
  private readonly stored = new Map<string, StoredSubtitleNote>();
  /** `pairingKey` of the NAS pairing as last read (null: none; undefined: not read yet), for a send that can't wait. */
  private pairingNow: string | null | undefined = undefined;
  private readonly minUs: number;
  /** The launch's settings until the player takes them, for the open they were given with. */
  private launch: (LaunchSettings & { readonly discKey: string; readonly opens: number }) | null = null;

  constructor(private readonly deps: PlaceSaverDeps) {
    this.minUs = deps.minDurationUs ?? PLACE_MIN_DURATION_US;
  }

  /**
   * Starts saving for the disc just opened (call it right after the controller's open). A local disc without a
   * fingerprint (`d.` key, not remote) has nothing to be found by later, so nothing is saved for it.
   */
  begin(target: PlaceTarget, launch?: LaunchSettings): void {
    this.end();
    this.launch = launch ? { ...launch, discKey: target.discKey, opens: this.deps.discOpens() } : null;
    if (!target.remote && target.discKey.startsWith('d.')) return;
    this.target = { ...target, opens: this.deps.discOpens() };
    void this.currentPairing().catch(() => undefined); // known before a page-hide flush needs it
    void this.drainOutbox();
  }

  /** Stops saving (the disc closes); saves already started still land. */
  end(): void {
    this.launch = null;
    this.stopTimer();
    this.target = null;
    this.seen = null;
    this.cached = null;
    this.sizes = {};
    this.stored.clear();
  }

  /** The launch's settings (once), while the disc they were given with is the one open; null otherwise. */
  takeLaunchSettings(): (LaunchSettings & { readonly discKey: string }) | null {
    const launch = this.launch;
    this.launch = null;
    return launch && launch.opens === this.deps.discOpens()
      ? { settings: launch.settings, byLanguage: launch.byLanguage, ...(launch.names ? { names: launch.names } : {}), discKey: launch.discKey }
      : null;
  }

  /** The places this device holds for a local disc (never a NAS disc's: those are the NAS's, and never stored here). */
  placesOf(discKey: string): Promise<DiscPlaces> {
    return this.deps.store.get(discKey);
  }

  /**
   * A subtitle from the NAS became the text set (picked, or added again on a resume): its id, size and language, by the
   * file's name, so places keep it.
   */
  noteStoredSubtitle(fileName: string, id: string, size: number, language: string): void {
    if (!this.target) return; // no disc is being saved
    this.stored.clear();
    this.stored.set(fileName, { id, size, language });
  }

  /** A viewer's own Anime Tosho pick became the text set (picked, or picked again on a resume or for Up next). */
  noteFansubPick(fileName: string, fansub: PlaceFansub, size: number, language: string): void {
    if (!this.target) return;
    this.stored.clear();
    this.stored.set(fileName, { fansub, size, language });
  }

  /** The stored subtitle noted for the text set, by file name. */
  storedSubtitleNotes(): ReadonlyMap<string, StoredSubtitleNote> {
    return this.stored;
  }

  /** The subtitle and font files kept on this device for a disc. */
  storedTextFiles(discKey: string): Promise<StoredTextFile[]> {
    return this.deps.store.textFiles(discKey);
  }

  /** Each snapshot of the player, with the shader set chosen. */
  observe(snapshot: PlayerSnapshot, shaderSet: string | null): void {
    const t = this.target;
    if (!t) return;
    if (this.deps.discOpens() !== t.opens) {
      this.end(); // another disc opened, or this one closed
      return;
    }
    const prev = this.seen;
    const next: Seen = { snapshot, shaderSet, atMs: this.deps.nowMs() };
    this.seen = next;
    if (prev && prev.snapshot.currentPlaylistId !== snapshot.currentPlaylistId) this.savePlaylistLeft(t, prev);
    else if (prev && savesAtOnce(prev, next)) this.save();
    if (snapshot.engineState !== 'playing') this.stopTimer();
    else if (this.timer === null) this.startTimer();
  }

  /**
   * Saves now (a close, the page hidden or going away). With `keepalive` the NAS request is sent at once, alongside the
   * device's write, and outlives the page over HTTPS; the registers read last for this playlist are used when there
   * are some, as a page going away may not live to hear the engine.
   */
  flushNow(opts: { readonly keepalive: boolean }): Promise<void> {
    const t = this.target;
    const seen = this.seen;
    const c = this.cached;
    if (opts.keepalive && t && seen && c && c.opens === t.opens && c.playlistId === seen.snapshot.currentPlaylistId && this.qualifies(t, seen)) {
      return this.write(t, seen, c.place, this.textNotes(), true).then(
        () => undefined,
        (err: unknown) => this.log('saving the place failed', err),
      );
    }
    this.save(opts.keepalive);
    return this.chain;
  }

  /**
   * Saves the open episode as finished now, whatever its time (Next episode moves on before it ends), after earlier
   * saves; answers the place saved, or null when nothing is being saved.
   */
  finishNow(): Promise<PlaybackPlace | null> {
    const t = this.target;
    const seen = this.seen;
    if (!t || !seen || !this.qualifies(t, seen) || this.deps.discOpens() !== t.opens) return Promise.resolve(null);
    const read = this.deps.readPlace();
    const notes = this.textNotes();
    let saved: PlaybackPlace | null = null;
    this.chain = this.chain
      .then(async () => {
        saved = await this.write(t, seen, await read, notes, false, true);
      })
      .catch((err: unknown) => this.log('saving the place failed', err));
    return this.chain.then(() => saved);
  }

  /** Sends the places waiting in the outbox, oldest first; one that can't go stops the rest until the next try. */
  drainOutbox(): Promise<void> {
    if (!this.deps.nas) return Promise.resolve();
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    // `draining` is let go in the same step as the last check of `drainAgain`, so a call in between is never lost
    const run = async (): Promise<void> => {
      try {
        do {
          this.drainAgain = false;
          await this.sendOutbox();
        } while (this.drainAgain);
      } catch (err) {
        this.log('sending saved places failed', err);
      } finally {
        this.draining = null;
      }
    };
    this.draining = run();
    return this.draining;
  }

  /** Empties the outbox: the pairing changed, so nothing in it may go to the new one. */
  clearOutbox(): Promise<void> {
    return this.deps.store.clearOutbox().catch((err: unknown) => this.log('clearing saved places failed', err));
  }

  /** NasClient.onPairingChange: the outbox is emptied, and the pairing read again. */
  async pairingChanged(): Promise<void> {
    this.pairingNow = undefined;
    await Promise.all([this.clearOutbox(), this.currentPairing().catch(() => undefined)]);
  }

  /** The NAS pairing's key now (null when unpaired), remembered for sends that can't wait. */
  private async currentPairing(): Promise<string | null> {
    const nas = this.deps.nas;
    const pairing = nas ? await nas.pairing() : null;
    this.pairingNow = pairing ? pairingKey(pairing) : null;
    return this.pairingNow;
  }

  /**
   * Subtitle files the user added (a pick or a drop, as `loadSubtitleFiles` got them): their sizes go into places, and
   * their bytes are kept on this device for a resume here. A pick with subtitle files replaces the kept subtitle files
   * (fonts kept before stay); a pick of fonts alone adds them. A file of the same name replaces the kept one; files
   * over the store's limits are never read.
   */
  async addTextFiles(files: readonly File[]): Promise<void> {
    const t = this.target;
    if (!t) return;
    const split = splitPick(files);
    const subtitles = pickedSubtitles(files);
    if (subtitles.length > 0) this.stored.clear(); // the local files replace the set, a stored subtitle's too
    for (const f of subtitles) this.sizes[f.name] = f.size;
    const picked = [...subtitles, ...split.fonts].filter((f) => f.size <= MAX_TEXT_FILE_BYTES);
    const names = new Set(picked.map((f) => f.name));
    const before = await this.deps.store.textFiles(t.discKey);
    const kept = before.filter((f) => !names.has(f.name) && (subtitles.length === 0 || isFontName(f.name)));
    const total = kept.reduce((sum, f) => sum + f.bytes.byteLength, 0) + picked.reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_TEXT_FILES_BYTES) return;
    const read: StoredTextFile[] = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    await this.deps.store.putTextFiles(t.discKey, [...kept, ...read]);
  }

  private qualifies(t: Active, seen: Seen): boolean {
    return qualifies(seen.snapshot, t.chosen, t.mainPlaylistId, this.minUs);
  }

  /** Reads the registers now (under this disc's open) and saves the latest snapshot with them, after earlier saves. */
  private save(keepalive = false): void {
    const t = this.target;
    const seen = this.seen;
    if (!t || !seen || !this.qualifies(t, seen) || this.deps.discOpens() !== t.opens) return;
    const read = this.deps.readPlace();
    const notes = this.textNotes();
    this.chain = this.chain
      .then(async () => {
        const place = await read;
        if (this.target === t) this.cached = { opens: t.opens, playlistId: seen.snapshot.currentPlaylistId!, place };
        await this.write(t, seen, place, notes, keepalive);
      })
      .catch((err: unknown) => this.log('saving the place failed', err));
  }

  /** The playlist changed: the one left is saved where it stopped, with the registers read while it played. */
  private savePlaylistLeft(t: Active, left: Seen): void {
    const c = this.cached;
    if (!c || c.playlistId !== left.snapshot.currentPlaylistId || !this.qualifies(t, left)) return;
    const s = left.snapshot;
    const ended = s.durationUs > 0 && s.timeUs >= s.durationUs - ENDED_WITHIN_US;
    const notes = this.textNotes();
    this.chain = this.chain
      .then(async () => {
        await this.write(t, left, c.place, notes, false, ended);
      })
      .catch((err: unknown) => this.log('saving the place failed', err));
  }

  /** What the saver knows of the text set now, for a write that may land after the disc has ended (a close). */
  private textNotes(): TextNotes {
    return { sizes: { ...this.sizes }, stored: Object.fromEntries(this.stored) };
  }

  /** `ended`: the playlist was left at its end, so the place is finished whatever isFinished says. Answers the place. */
  private async write(t: Active, seen: Seen, registers: PlaceState, notes: TextNotes, keepalive: boolean, ended = false): Promise<PlaybackPlace> {
    const built = buildPlace({
      discKey: t.discKey, discId: t.discId ?? '', snapshot: seen.snapshot, place: t.encode ? ENCODE_REGISTERS : registers,
      shaderSet: seen.shaderSet, deviceName: t.deviceName, nowMs: this.deps.nowMs(), textFileSizes: notes.sizes, storedSubtitles: notes.stored,
    });
    const levelAudio = this.deps.levelAudio?.() ?? null;
    const place: PlaybackPlace = {
      ...built,
      finished: built.finished || ended || t.finished === true,
      settings: { ...built.settings, ...(levelAudio === null ? {} : { psr1: levelAudio }), textFiles: built.settings.textFiles.slice(0, MAX_TEXT_FILES).map((f) => ({ ...f, name: f.name.slice(0, MAX_TEXT_FILE_NAME) })) },
    };
    const { store, nas } = this.deps;
    if (!t.remote) {
      await store.put(place);
      return place;
    }
    // A NAS disc's place is the NAS's (its person's): it never goes into this device's places, which a local copy of
    // the disc (the same `f.` key) would read. The outbox is its device-first write.
    if (!nas) return place;
    // A keepalive request leaves before the page can go (checked against the pairing last read, as the page may not
    // live to read it again); the outbox keeps the place should it not arrive.
    const sending = keepalive && t.pairing !== null && t.pairing === this.pairingNow ? this.send(place, true) : null;
    let queued = false;
    if (t.pairing !== null) {
      try {
        await store.queue(place, t.pairing);
        queued = true;
      } catch (err) {
        this.log('queueing the place failed', err);
      }
    }
    // Nothing here waits on the NAS: a stalled request must not hold up the device's next writes.
    if (sending) {
      void sending.then((done) => (done && queued ? store.sent(placeKey(place), place.updatedAt) : undefined)).catch((err: unknown) => this.log('saving the place failed', err));
    } else if (queued) void this.drainOutbox();
    else if (t.pairing !== null) void this.sendIfPaired(place, t.pairing); // the device's store failed: straight to the NAS, best effort
    return place;
  }

  /** A send outside the outbox, only while the pairing is still the one the disc was opened through. */
  private async sendIfPaired(place: PlaybackPlace, pairing: string): Promise<void> {
    try {
      if ((await this.currentPairing()) === pairing) await this.send(place, false);
    } catch (err) {
      this.log('sending the place failed', err);
    }
  }

  /** One place to the NAS, outside the outbox; true once it needn't be sent again. */
  private async send(place: PlaybackPlace, keepalive: boolean): Promise<boolean> {
    try {
      await this.deps.nas?.putPlace(place, { keepalive });
      return true;
    } catch (err) {
      return failure(err) === 'drop';
    }
  }

  /**
   * The outbox, oldest first, to the pairing it was saved under (places of another pairing are dropped). An unreachable
   * NAS stops the round; a place the NAS refuses is counted and skipped.
   */
  private async sendOutbox(): Promise<void> {
    const { store, nas } = this.deps;
    if (!nas) return;
    for (const { place, pairing: savedUnder } of await store.outbox()) {
      const key = placeKey(place);
      // read before every send: the device may pair again while a round goes on
      const current = await this.currentPairing();
      if (current === null) return;
      if (savedUnder !== current) {
        await store.sent(key, place.updatedAt);
        continue;
      }
      try {
        await nas.putPlace(place); // 'stale': the NAS holds a newer one, which stays
      } catch (err) {
        const what = failure(err);
        if (what === 'wait') return; // the outbox waits for the next save or connection
        this.log('the NAS refused a saved place', err);
        if (what === 'refused') {
          await store.failed(key, place.updatedAt);
          continue;
        }
      }
      await store.sent(key, place.updatedAt);
    }
  }

  private startTimer(): void {
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.save();
      if (this.seen?.snapshot.engineState === 'playing') this.startTimer();
    }, SAVE_EVERY_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private log(message: string, err: unknown): void {
    (this.deps.log ?? ((m, e) => console.warn(m, e)))(message, err);
  }
}
