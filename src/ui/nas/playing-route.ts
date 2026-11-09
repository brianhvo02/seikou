import type { NasHistory } from './nas-history';

/** The address bar is brought up to date at most this often while a disc plays (spec §5.1)... */
const REPLACE_EVERY_MS = 5000;
/** ...and at once when the time moved this much further than playing on would have taken it (a seek). */
const JUMP_US = 2_000_000;
/** A seek-triggered write waits for this floor (Safari refuses about 100 history changes in 30 s); a trailing write lands the final position. */
const JUMP_FLOOR_MS = 1000;

/** Marks an encode in the key PlayingRoute follows (no disc key starts so). */
const ENCODE_PREFIX = 'encode:';

/** What the launch knew of the disc: its name, and the catalogue title it was opened from (null: a folder or a link). */
export interface PlayingAbout {
  readonly discName: string;
  readonly title: { readonly id: string; readonly name: string } | null;
}

export interface PlayingState {
  readonly currentPlaylistId: string | null;
  readonly timeUs: number;
  readonly engineState: string;
}

/**
 * Keeps `/nas/play/<discKey>?pl=&t=` current while a NAS disc plays, so the address bar is always a link to "here,
 * now". The pre-flight starts it when it launches a disc; a local or disc-server disc never does, so its playback leaves
 * the address bar alone. It writes only while the address bar is on a play route: Back has gone elsewhere otherwise.
 */
export class PlayingRoute {
  private key: string | null = null;
  /** An encoded episode playing (startEncode): the address bar is its `/nas/encodes/play/<id>?t=` route. */
  private encode: string | null = null;
  private aboutNow: PlayingAbout | null = null;
  private lastReplaceMs = -Infinity;
  private lastWriteMs = -Infinity;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private last: { readonly state: PlayingState; readonly atMs: number } | null = null;

  constructor(
    private readonly history: Pick<NasHistory, 'route' | 'replace'>,
    private readonly nowMs: () => number,
  ) {}

  /** The disc whose playback the address bar follows, or null. */
  get discKey(): string | null {
    return this.key;
  }

  /** The playing disc's name and title, as its launch gave them (for the player's Anime Tosho search); null when stopped. */
  get about(): PlayingAbout | null {
    return this.aboutNow;
  }

  /** The encoded episode whose playback the address bar follows, or null. */
  get encodeId(): string | null {
    return this.encode;
  }

  /** Follows a NAS disc's playback (`/nas/play/<discKey>`). */
  start(discKey: string, about: PlayingAbout | null = null): void {
    this.begin(discKey, null, about);
  }

  /** Follows an encoded episode's playback (`/nas/encodes/play/<id>?t=`) in place of any disc's. */
  startEncode(encodeId: string): void {
    this.begin(null, encodeId, null);
  }

  private begin(discKey: string | null, encodeId: string | null, about: PlayingAbout | null): void {
    this.key = discKey;
    this.encode = encodeId;
    this.aboutNow = about;
    this.lastReplaceMs = -Infinity;
    this.lastWriteMs = -Infinity;
    this.last = null;
    this.clearTrailing();
  }

  private clearTrailing(): void {
    if (this.trailing !== null) clearTimeout(this.trailing);
    this.trailing = null;
  }

  /** `key`: a disc's key, or `encode:<id>` for an encode (whose route is the encode's play route). */
  private write(key: string, s: PlayingState, now: number): void {
    this.clearTrailing();
    const encodeId = key.startsWith(ENCODE_PREFIX) ? key.slice(ENCODE_PREFIX.length) : null;
    const here = this.history.route();
    if (s.currentPlaylistId === null) return;
    if (encodeId === null ? here?.kind !== 'play' : here?.kind !== 'encodePlay' || here.encodeId !== encodeId) return;
    this.lastReplaceMs = now;
    this.lastWriteMs = now;
    const timeS = Math.floor(s.timeUs / 1e6);
    this.history.replace(encodeId === null ? { kind: 'play', discKey: key, playlistId: s.currentPlaylistId, timeS, resume: false } : { kind: 'encodePlay', encodeId, timeS, resume: false });
  }

  /** What is followed: a disc's key, `encode:<id>`, or null. */
  private followed(): string | null {
    return this.key ?? (this.encode === null ? null : `${ENCODE_PREFIX}${this.encode}`);
  }

  update(s: PlayingState): void {
    const key = this.followed();
    if (key === null || s.currentPlaylistId === null) return;
    const now = this.nowMs();
    const last = this.last;
    this.last = { state: s, atMs: now };
    // The first playlist's start doesn't write: a link's own time is in the address bar until playback moves on (the
    // link's seek, a pause, or the first 5 s).
    if (last === null) {
      this.lastReplaceMs = now;
      return;
    }
    const expectedUs = last.state.timeUs + (last.state.engineState === 'playing' ? (now - last.atMs) * 1000 : 0);
    const paused = s.engineState === 'paused' && last.state.engineState !== 'paused';
    const jumped = Math.abs(s.timeUs - expectedUs) > JUMP_US;
    const otherPlaylist = last.state.currentPlaylistId !== s.currentPlaylistId;
    if (now - this.lastReplaceMs < REPLACE_EVERY_MS && !paused && !jumped && !otherPlaylist) return;
    if (jumped && !paused && !otherPlaylist && now - this.lastWriteMs < JUMP_FLOOR_MS) {
      // Too soon after the last write: the latest state is written when the floor has passed.
      if (this.trailing === null) {
        this.trailing = setTimeout(() => {
          this.trailing = null;
          const l = this.last;
          if (this.followed() === key && l !== null) this.write(key, l.state, this.nowMs());
        }, JUMP_FLOOR_MS - (now - this.lastWriteMs));
      }
      return;
    }
    this.write(key, s, now);
  }

  stop(): void {
    this.key = null;
    this.encode = null;
    this.aboutNow = null;
    this.last = null;
    this.clearTrailing();
  }
}
