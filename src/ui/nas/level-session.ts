import { parseMpls } from '@seikou/bdmv/mpls-parser';
import type { DiscManifest, LevelAt, LevelInfo } from '@seikou/nas/nas-api';
import { audioTracks } from '@seikou/engine/playback/tracks';
import type { PlayerController } from '@seikou/engine/controller/player-controller';
import { trackLabel } from '@seikou/engine/controller/language';
import { levelQuery } from './disc-spec';
import { NasBusyError } from './nas-client';
import type { NasClient } from './nas-client';

/** The open NAS disc's quality state: the disc, the levels its NAS offers, the version playing (`at`) and the last switch's message. */
export interface LevelState {
  readonly discId: string;
  readonly levels: readonly LevelInfo[];
  readonly at: LevelAt;
  /** The last switch's busy or failure message. */
  readonly notice: string | null;
}

/** An audio stream of the original version: its 1-based number, language code and label. */
export interface OriginalAudioTrack {
  readonly number: number;
  readonly language: string;
  readonly label: string;
}

/** What a level switch needs to reopen the disc: the player's controller, and the NAS's API base and session token the engine reads with. */
export interface SwitchDeps {
  readonly controller: PlayerController;
  readonly base: string;
  readonly token: string;
}

const sameAt = (a: LevelAt, b: LevelAt): boolean => a.level === b.level && a.audio === b.audio;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The open NAS disc's quality level: switches between levels and the NAS's GPU leases they hold. One per NasClient. */
export class LevelSession {
  private state: LevelState | null = null;
  private original: DiscManifest | null = null;
  private readonly listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly nas: NasClient) {}

  get = (): LevelState | null => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Called after a pre-flight opens a disc. A disc still held from before is released first. */
  begin(s: { discId: string; levels: readonly LevelInfo[]; at: LevelAt; original: DiscManifest }): void {
    this.end();
    this.original = s.original;
    this.state = { discId: s.discId, levels: s.levels, at: s.at, notice: null };
    this.notify();
  }

  /** The original version's audio streams of a playlist (first play item's STN, numbered from 1), for the Audio menu at a level. */
  originalAudio(playlistId: string): readonly OriginalAudioTrack[] {
    const bytes = this.original?.inline[`BDMV/PLAYLIST/${playlistId}.MPLS`.toUpperCase()];
    if (bytes === undefined) return [];
    try {
      const item = parseMpls(decodeBase64(bytes)).playItems[0];
      if (!item) return [];
      return audioTracks(item.stn).map((t) => ({ number: t.index, language: t.language, label: trackLabel(t) }));
    } catch {
      return [];
    }
  }

  switchTo(at: LevelAt, deps: SwitchDeps): Promise<void> {
    const run = this.chain.then(() => this.doSwitch(at, deps));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doSwitch(at: LevelAt, deps: SwitchDeps): Promise<void> {
    const state = this.state;
    const original = this.original;
    if (!state || !original) return;
    let manifest: DiscManifest;
    try {
      manifest = await this.nas.manifest(state.discId, at);
    } catch (err) {
      if (err instanceof NasBusyError) {
        this.setState({ ...state, notice: err.message });
        return;
      }
      throw err;
    }
    if (this.state !== state) {
      // The disc closed meanwhile: the manifest request took a lease nothing will use.
      this.release(state.discId, at);
      return;
    }
    const outcome = await this.runSwitch(manifest, at, original, deps);
    if (this.state !== state) {
      // The disc closed during the switch (or the player ended the session on the switch's failure): end() released
      // the old lease only, so the new one goes too, whatever the outcome.
      this.release(state.discId, at);
      return;
    }
    if (outcome === 'idle') {
      if (!sameAt(state.at, at)) this.release(state.discId, state.at);
      this.setState({ ...state, at, notice: null });
    } else {
      this.release(state.discId, at);
      this.setState({ ...state, notice: outcome.error });
    }
  }

  private runSwitch(manifest: DiscManifest, at: LevelAt, original: DiscManifest, deps: SwitchDeps): Promise<'idle' | { error: string }> {
    const { controller } = deps;
    return new Promise((resolve) => {
      let started = false;
      let unsubscribe = (): void => undefined;
      const check = (): void => {
        const s = controller.getSnapshot().levelSwitch;
        if (s === 'switching') {
          started = true;
          return;
        }
        if (!started) return;
        unsubscribe();
        resolve(s);
      };
      unsubscribe = controller.subscribe(check);
      // to the original, the audio heard at the level goes on (a level's query names its own)
      controller.setLevel({ kind: 'remote', base: deps.base, token: deps.token, manifest, query: levelQuery(at), original }, at.level === 'original' ? at.audio : undefined);
      check();
    });
  }

  /** The disc closed or another opened: gives the current lease back (Original has none) and clears the state. Idempotent. */
  end(): void {
    const state = this.state;
    if (!state) return;
    this.state = null;
    this.original = null;
    this.release(state.discId, state.at);
    this.notify();
  }

  private release(discId: string, at: LevelAt): void {
    if (at.level === 'original') return;
    void this.nas.releaseViewing(discId, at);
  }

  private setState(next: LevelState): void {
    this.state = next;
    this.notify();
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/**
 * A launch's version of the disc: the original's manifest in hand, or the level's (asking for it takes a GPU lease).
 * A launch superseded meanwhile gives that lease back and gets null.
 */
export async function launchManifest(
  nas: Pick<NasClient, 'manifest' | 'releaseViewing'>,
  discId: string,
  at: LevelAt,
  original: DiscManifest,
  current: () => boolean,
): Promise<DiscManifest | null> {
  if (at.level === 'original') return original;
  const manifest = await nas.manifest(discId, at);
  if (current()) return manifest;
  void nas.releaseViewing(discId, at);
  return null;
}

const sessions = new WeakMap<NasClient, LevelSession>();

/** The `LevelSession` of a NAS client, made on first use. */
export function levelSessionOf(nas: NasClient): LevelSession {
  let s = sessions.get(nas);
  if (!s) {
    s = new LevelSession(nas);
    sessions.set(nas, s);
  }
  return s;
}
