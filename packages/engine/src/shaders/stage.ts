/*
 * Original code for bluray-web, 2026. Chooses, compiles and runs the selected mpv user shader set for the
 * compositor (spec section 5).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ShaderSetData, ShaderState } from '../protocol';
import { parseShaderFile, ShaderFileError, type ShaderPass } from './parse';
import type { Size } from './plan';
import { ShaderContextLostError, ShaderSetStaleError, type CompiledSet, type ShaderBackend } from './webgl-backend';

export interface ShaderStatus {
  readonly state: ShaderState;
  readonly set: string | null;
  readonly error: string | null;
}

export interface ShaderStats {
  readonly set: string;
  readonly passesRun: number;
  readonly gpuMs: number | null;
}

const LOST_MESSAGE = new ShaderContextLostError().message;

/** A chosen set, parsed; `key` names it together with its sources. */
interface Choice {
  readonly name: string;
  readonly key: string;
  readonly passes: readonly ShaderPass[];
}

/** A set compiled or compiling on the current context. */
interface Entry extends Choice {
  compiled: CompiledSet | null;
}

interface LastOutput {
  readonly entry: Entry;
  readonly frame: VideoFrame;
  readonly width: number;
  readonly height: number;
  readonly image: OffscreenCanvas;
}

/** FNV-1a (32-bit) over each file's name and source. */
function hashFiles(files: ShaderSetData['files']): string {
  let h = 0x811c9dc5;
  const add = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h = Math.imul(h ^ 0xffff, 0x01000193); // a separator (U+FFFF, a noncharacter), so "ab"+"c" differs from "a"+"bc"
  };
  for (const f of files) {
    add(f.name);
    add(f.source);
  }
  return (h >>> 0).toString(16);
}

/**
 * The selected shader set: parses and compiles it in the background (keeping the previous set's output meanwhile),
 * caches compiled sets for as long as it lives, and shades frames for the compositor. Never throws from `process`.
 */
export class ShaderStage {
  private readonly backend: ShaderBackend | null;
  private readonly unavailable: string | null;
  private readonly cache = new Map<string, Entry>();
  /** The user's choice; null when off or when its files could not be read. */
  private selected: Choice | null = null;
  /** The compiled set frames are shaded with: the selected one, or the previous one while the selected one compiles. */
  private active: Entry | null = null;
  private last: LastOutput | null = null;
  private lastStats: ShaderStats | null = null;
  private lost = false;
  /** Bumped by every context loss: compiles started before it are stale. */
  private epoch = 0;

  constructor(
    backend: ShaderBackend | string,
    private readonly onStatus: (s: ShaderStatus) => void,
    private readonly onReady: () => void,
  ) {
    this.backend = typeof backend === 'string' ? null : backend;
    this.unavailable = typeof backend === 'string' ? backend : null;
  }

  get stats(): ShaderStats | null {
    return this.active && !this.lost ? this.lastStats : null;
  }

  setSet(set: ShaderSetData | null): void {
    if (this.unavailable !== null) {
      this.onStatus({ state: 'unavailable', set: set?.name ?? null, error: this.unavailable });
      return;
    }
    if (!set) {
      this.selected = null;
      this.onStatus({ state: 'off', set: null, error: null });
      if (this.active) this.setActive(null); // asks for the repaint
      else this.onReady();
      return;
    }
    const key = `${set.name}\u0000${hashFiles(set.files)}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.selected = cached;
      if (cached.compiled) this.activate(cached);
      else this.onStatus({ state: 'compiling', set: set.name, error: null });
      return;
    }
    let passes: ShaderPass[];
    try {
      passes = set.files.flatMap((f) => parseShaderFile(f.name, f.source));
    } catch (err) {
      this.selected = null;
      this.setActive(null);
      const error = err instanceof ShaderFileError ? `${err.file} line ${err.line}: ${err.reason}` : err instanceof Error ? err.message : String(err);
      this.onStatus({ state: 'error', set: set.name, error });
      return;
    }
    this.selected = { name: set.name, key, passes };
    this.compile(this.selected);
  }

  /** The shaded image for this frame at this output size, or null to draw the raw frame. Reuses the last result for the same frame and size. */
  process(frame: VideoFrame, output: Size): OffscreenCanvas | null {
    const entry = this.active;
    const backend = this.backend;
    if (!entry?.compiled || !backend || this.lost) {
      this.lastStats = null;
      return null;
    }
    const last = this.last;
    if (last && last.entry === entry && last.frame === frame && last.width === output.width && last.height === output.height) return last.image;
    try {
      const result = backend.render(entry.compiled, frame, output);
      this.last = { entry, frame, width: output.width, height: output.height, image: result.image };
      this.lastStats = { set: entry.name, passesRun: result.passesRun, gpuMs: result.gpuMs };
      return result.image;
    } catch (err) {
      this.last = null;
      this.lastStats = null;
      if (err instanceof ShaderContextLostError) {
        this.markLost();
        return null;
      }
      this.setActive(null);
      if (err instanceof ShaderSetStaleError) {
        // disposed, or compiled on an earlier context: compile it again if it is still wanted
        this.cache.delete(entry.key);
        entry.compiled.dispose();
        if (this.selected?.key === entry.key) this.compile(this.selected);
      } else if (this.selected?.key === entry.key) {
        // the set cannot run (a GL failure): stay unshaded rather than recompiling into the same failure
        this.onStatus({ state: 'error', set: entry.name, error: err instanceof Error ? err.message : String(err) });
      }
      return null;
    }
  }

  contextLost(): void {
    this.markLost();
  }

  contextRestored(): void {
    if (!this.lost) return;
    this.lost = false;
    if (this.selected) this.compile(this.selected);
  }

  private compile(choice: Choice): void {
    const backend = this.backend;
    if (!backend) return;
    if (this.lost) {
      this.onStatus({ state: 'error', set: choice.name, error: LOST_MESSAGE });
      return;
    }
    const entry: Entry = { ...choice, compiled: null };
    this.cache.set(entry.key, entry);
    this.onStatus({ state: 'compiling', set: entry.name, error: null });
    const epoch = this.epoch;
    const current = (): boolean => epoch === this.epoch && this.cache.get(entry.key) === entry;
    backend.compile(entry.passes).then(
      (compiled) => {
        if (!current()) {
          compiled.dispose();
          return;
        }
        entry.compiled = compiled;
        if (this.selected?.key === entry.key) this.activate(entry);
        this.evictOtherVersions(entry);
      },
      (err: unknown) => {
        if (!current()) return;
        this.cache.delete(entry.key);
        if (err instanceof ShaderContextLostError) {
          this.markLost();
          return;
        }
        if (this.selected?.key !== entry.key) return;
        this.setActive(null);
        this.onStatus({ state: 'error', set: entry.name, error: err instanceof Error ? err.message : String(err) });
      },
    );
  }

  private activate(entry: Entry): void {
    this.setActive(entry);
    this.onStatus({ state: 'active', set: entry.name, error: null });
  }

  /** Changes the set frames are shaded with; a change asks for a repaint. */
  private setActive(entry: Entry | null): void {
    if (entry === this.active) return;
    this.active = entry;
    this.last = null;
    this.lastStats = null;
    this.onReady();
  }

  /** A set re-added with other sources replaces the compiled old version once the new one is compiled. */
  private evictOtherVersions(entry: Entry): void {
    for (const other of this.cache.values()) {
      if (other === entry || other.name !== entry.name || other === this.active || !other.compiled) continue;
      other.compiled.dispose();
      this.cache.delete(other.key);
    }
  }

  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    this.epoch++;
    for (const entry of this.cache.values()) entry.compiled?.dispose();
    this.cache.clear();
    this.setActive(null);
    if (this.selected) this.onStatus({ state: 'error', set: this.selected.name, error: LOST_MESSAGE });
  }
}
