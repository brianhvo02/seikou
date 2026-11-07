import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OwnerChoice, OwnTitle, TitleKind } from '@seikou/nas/nas-api';
import { isCode, lockFile, replaceAtomically } from '../atomic-json';

export interface OwnerSnapshot {
  readonly choices: ReadonlyMap<string, OwnerChoice>;
  readonly ownTitles: readonly OwnTitle[];
  readonly displayNames: ReadonlyMap<string, string>;
  readonly gate: 'owners' | 'everyone' | null;
}

/** `direct`: the owner chose for this disc; `group`: filed with "apply to the group" from another disc (ruling T9f). */
export type ChoiceOrigin = 'direct' | 'group';

interface OwnerData {
  choices: Record<string, { choice: OwnerChoice; fingerprint: string | null; setAt: number; propagated: boolean; origin: ChoiceOrigin }>;
  ownTitles: OwnTitle[];
  displayNames: Record<string, string>;
  gate: 'owners' | 'everyone' | null;
}

function fail(file: string, what: string): never {
  throw new Error(`${file} is corrupt: ${what}`);
}

/**
 * The owner's choices per disc, own titles, display names and the library gate, in `<dir>/owner.json`.
 * Choices are keyed by disc id and carry the disc's content fingerprint so `reattach` can follow a moved disc.
 * Every change re-reads the file under a lock and replaces it atomically, like `Store`.
 */
export class OwnerStore {
  private readonly file: string;
  /** The gate as last read, and the owner.json it was read from (inode, mtime, size), or 'missing' (M10). */
  private gateRead: { readonly stamp: string; readonly gate: 'owners' | 'everyone' | null } | null = null;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'owner.json');
  }

  snapshot(): OwnerSnapshot {
    const data = this.load();
    return {
      choices: new Map(Object.entries(data.choices).map(([id, c]) => [id, c.choice])),
      ownTitles: data.ownTitles,
      displayNames: new Map(Object.entries(data.displayNames)),
      gate: data.gate,
    };
  }

  /**
   * The library gate, read again only when owner.json changes (M10): it is asked on every title and art request.
   */
  gate(): 'owners' | 'everyone' | null {
    let stamp = 'missing';
    try {
      const st = statSync(this.file);
      stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
    }
    if (this.gateRead?.stamp !== stamp) this.gateRead = { stamp, gate: this.load().gate };
    return this.gateRead.gate;
  }

  setChoice(discId: string, fingerprint: string | null, choice: OwnerChoice, origin: ChoiceOrigin = 'direct'): void {
    this.update((d) => {
      d.choices[discId] = { choice, fingerprint, setAt: Date.now(), propagated: false, origin };
    });
  }

  /**
   * Where a disc's choice comes from: null when it has none, `direct` or `group` when it was set with `setChoice`,
   * otherwise `copy` with the disc whose choice it follows (the newest for its fingerprint, as `reattach` picks it), or
   * null when none is left.
   */
  choiceOrigin(discId: string): { readonly kind: ChoiceOrigin } | { readonly kind: 'copy'; readonly source: string | null } | null {
    const data = this.load();
    const entry = data.choices[discId];
    if (!entry) return null;
    if (!entry.propagated) return { kind: entry.origin };
    let source: string | null = null;
    let setAt = -Infinity;
    for (const [id, e] of Object.entries(data.choices)) {
      if (e.propagated || e.fingerprint === null || e.fingerprint !== entry.fingerprint) continue;
      if (e.setAt > setAt) {
        source = id;
        setAt = e.setAt;
      }
    }
    return { kind: 'copy', source };
  }

  clearChoice(discId: string): void {
    this.update((d) => {
      delete d.choices[discId];
    });
  }

  /** `id` is a disc id or a music title id; null clears the name. */
  setDisplayName(id: string, name: string | null): void {
    this.update((d) => {
      if (name === null) delete d.displayNames[id];
      else d.displayNames[id] = name;
    });
  }

  createTitle(kind: TitleKind, name: string, seasons: number | null): OwnTitle {
    const title: OwnTitle = { id: `own:${randomUUID()}`, kind, name, seasons };
    this.update((d) => {
      d.ownTitles.push(title);
    });
    return title;
  }

  updateTitle(id: string, change: { name?: string; seasons?: number | null }): OwnTitle {
    return this.update((d) => {
      const at = d.ownTitles.findIndex((t) => t.id === id);
      if (at < 0) throw new Error(`No own title ${id}`);
      const next: OwnTitle = {
        ...d.ownTitles[at]!,
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.seasons !== undefined ? { seasons: change.seasons } : {}),
      };
      d.ownTitles[at] = next;
      return next;
    });
  }

  /** Also clears every choice naming the title, so those discs return to Unsorted. */
  deleteTitle(id: string): void {
    this.update((d) => {
      d.ownTitles = d.ownTitles.filter((t) => t.id !== id);
      for (const [discId, c] of Object.entries(d.choices)) {
        if ((c.choice.kind === 'title' || c.choice.kind === 'extras') && c.choice.titleId === id) delete d.choices[discId];
      }
    });
  }

  setGate(gate: 'owners' | 'everyone'): void {
    this.update((d) => {
      d.gate = gate;
    });
  }

  /**
   * Applies choices to discs by content fingerprint (copies and moved discs are the same disc), after each scan:
   * - A present disc whose fingerprint is known or changed gets it stored.
   * - Every present disc with a non-null fingerprint and no choice of its own takes the choice stored under that
   *   fingerprint. A present disc's own choice always wins.
   * - Such a copy's entry is marked `propagated`. On every reattach it follows the newest direct choice for its
   *   fingerprint and is removed when none is left (clearing the source clears the copies). A direct choice
   *   (made with `setChoice`) is never overwritten by propagation.
   * - When several direct choices share a fingerprint (copies filed differently), the most recently set one
   *   propagates; ties keep the first in file order.
   * - No direct entry is ever deleted, even one whose disc is absent: a disc that is only offline (a mount down during
   *   the scan) keeps its choice for when it returns. A choice with a null fingerprint stays under its id.
   * The file is written only when something changed.
   */
  reattach(discs: readonly { id: string; fingerprint: string | null }[]): void {
    this.update((d) => {
      for (const disc of discs) {
        const entry = d.choices[disc.id];
        if (entry && disc.fingerprint !== null && entry.fingerprint !== disc.fingerprint) entry.fingerprint = disc.fingerprint;
      }
      const source = new Map<string, { choice: OwnerChoice; setAt: number }>();
      for (const entry of Object.values(d.choices)) {
        if (entry.propagated || entry.fingerprint === null) continue;
        const best = source.get(entry.fingerprint);
        if (!best || entry.setAt > best.setAt) source.set(entry.fingerprint, { choice: entry.choice, setAt: entry.setAt });
      }
      for (const [id, entry] of Object.entries(d.choices)) {
        if (!entry.propagated) continue;
        const from = entry.fingerprint === null ? undefined : source.get(entry.fingerprint);
        if (!from) delete d.choices[id];
        else {
          entry.choice = from.choice;
          entry.setAt = from.setAt;
        }
      }
      for (const disc of discs) {
        if (disc.fingerprint === null || d.choices[disc.id] !== undefined) continue;
        const from = source.get(disc.fingerprint);
        if (from) d.choices[disc.id] = { choice: from.choice, fingerprint: disc.fingerprint, setAt: from.setAt, propagated: true, origin: 'direct' }; // origin is unused while propagated
      }
    });
  }

  private update<T>(change: (data: OwnerData) => T): T {
    const release = lockFile(this.file);
    try {
      const data = this.load();
      const before = JSON.stringify(data);
      const result = change(data);
      const after = JSON.stringify(data);
      if (after !== before) replaceAtomically(this.file, after);
      return result;
    } finally {
      release();
    }
  }

  private load(): OwnerData {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return { choices: {}, ownTitles: [], displayNames: {}, gate: null };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(this.file, 'not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(this.file, 'not a JSON object');
    const { choices, ownTitles, displayNames, gate } = parsed as Record<string, unknown>;
    const isObj = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObj(choices)) fail(this.file, '"choices" is not an object');
    if (!Array.isArray(ownTitles)) fail(this.file, '"ownTitles" is not an array');
    if (!isObj(displayNames)) fail(this.file, '"displayNames" is not an object');
    if (gate !== null && gate !== 'owners' && gate !== 'everyone') fail(this.file, '"gate" is not owners, everyone or null');
    const bad = (where: string): never => fail(this.file, `${where} is malformed`);
    const str = (v: unknown): boolean => typeof v === 'string';
    const num = (v: unknown): boolean => v === null || typeof v === 'number';
    const kinds = ['series', 'movie', 'music'];
    for (const [id, e] of Object.entries(choices as Record<string, unknown>)) {
      const entry = e as Record<string, unknown> | null;
      if (!isObj(entry) || !(entry!.fingerprint === null || str(entry!.fingerprint)) || typeof entry!.setAt !== 'number' || typeof entry!.propagated !== 'boolean' || (entry!.origin !== 'direct' && entry!.origin !== 'group')) bad(`choices.${id}`);
      const c = entry!.choice as Record<string, unknown> | null;
      const ok =
        isObj(c) &&
        ((c!.kind === 'title' && str(c!.titleId) && num(c!.season) && num(c!.disc)) ||
          (c!.kind === 'music' && (c!.name === null || str(c!.name)) && (c!.artist === undefined || c!.artist === null || str(c!.artist)) && (c!.rejectMatch === undefined || typeof c!.rejectMatch === 'boolean')) ||
          (c!.kind === 'extras' && str(c!.titleId) && num(c!.season)) ||
          c!.kind === 'hidden');
      if (!ok) bad(`choices.${id}.choice`);
    }
    (ownTitles as unknown[]).forEach((t, i) => {
      const o = t as Record<string, unknown> | null;
      if (!isObj(o) || !str(o!.id) || !kinds.includes(o!.kind as string) || !str(o!.name) || !num(o!.seasons)) bad(`ownTitles[${i}]`);
    });
    for (const [id, v] of Object.entries(displayNames as Record<string, unknown>)) if (!str(v)) bad(`displayNames.${id}`);
    return parsed as OwnerData;
  }
}
