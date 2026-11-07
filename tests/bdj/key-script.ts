import type { MenuKey } from '@seikou/engine/protocol';

/**
 * A step of a bdj-trace key script (tools/bdj-trace/README.md, Key scripts): the `.keys` syntax of tests/vm-trace, with
 * `wait flush`, `wait still`, `wait menu`, `wait quiet`, `wait playlist` (a number or `any`), `key`, `mouse` and `click`.
 */
export type KeyStep =
  | { readonly kind: 'waitFlush'; readonly text: string; readonly n: number }
  | { readonly kind: 'waitStill'; readonly text: string; readonly ms: number }
  /** `wait menu <ms>`: the plane is visible and has not flushed for ms (or stayed visible, flushing, for 30 s). */
  | { readonly kind: 'waitMenu'; readonly text: string; readonly ms: number }
  /** `wait quiet <ms>`: no flush for ms since the step began; unlike `wait still`, no flush is needed (Ruling R5). */
  | { readonly kind: 'waitQuiet'; readonly text: string; readonly ms: number }
  /** `wait playlist <n>`, or `wait playlist any` (playlist null): any playlist starting. */
  | { readonly kind: 'waitPlaylist'; readonly text: string; readonly playlist: number | null }
  | { readonly kind: 'key'; readonly text: string; readonly key: MenuKey }
  | { readonly kind: 'pointer'; readonly text: string; readonly click: boolean; readonly x: number; readonly y: number };

/** The harness's key names (vm-trace's and keys.h's) that the player's menuKey command has. */
const KEYS: Readonly<Record<string, MenuKey>> = {
  up: 'up', down: 'down', left: 'left', right: 'right', ok: 'ok', topmenu: 'topMenu', popup: 'popup',
  BD_VK_UP: 'up', BD_VK_DOWN: 'down', BD_VK_LEFT: 'left', BD_VK_RIGHT: 'right', BD_VK_ENTER: 'ok',
  BD_VK_ROOT_MENU: 'topMenu', BD_VK_POPUP: 'popup',
  ...Object.fromEntries([...'0123456789'].flatMap((d) => [[d, d], [`BD_VK_${d}`, d]])),
};

const int = (s: string | undefined, line: string): number => {
  if (s === undefined || !/^\d+$/.test(s)) throw new Error(`key script: bad number in "${line}"`);
  return Number(s);
};

/** Parses a `.keys` script; the step text is the line without its comment, as the harness prints it. */
export function parseKeyScript(source: string): KeyStep[] {
  const steps: KeyStep[] = [];
  for (const raw of source.split('\n')) {
    const text = raw.replace(/#.*/, '').trim();
    if (!text) continue;
    const [verb, a, b, c] = text.split(/\s+/);
    if (verb === 'wait' && a === 'flush') steps.push({ kind: 'waitFlush', text, n: int(b, text) });
    else if (verb === 'wait' && a === 'still') steps.push({ kind: 'waitStill', text, ms: int(b, text) });
    else if (verb === 'wait' && a === 'menu') steps.push({ kind: 'waitMenu', text, ms: int(b, text) });
    else if (verb === 'wait' && a === 'quiet') steps.push({ kind: 'waitQuiet', text, ms: int(b, text) });
    else if (verb === 'wait' && a === 'playlist') steps.push({ kind: 'waitPlaylist', text, playlist: b === 'any' ? null : int(b, text) });
    else if (verb === 'key' && a !== undefined && KEYS[a]) steps.push({ kind: 'key', text, key: KEYS[a] });
    else if ((verb === 'mouse' || verb === 'click') && c === undefined) steps.push({ kind: 'pointer', text, click: verb === 'click', x: int(a, text), y: int(b, text) });
    else throw new Error(`key script: unsupported step "${text}"`);
  }
  return steps;
}

/**
 * What a script says about its own comparison, in `#!` lines that the harness reads as comments:
 * `#! vary gpr <n>... [after playlist <p>]` names general-purpose registers whose written values depend on timing (a disc
 * saving its playback position as it plays). Their writeRegN calls, from Java's selectPlaylistN of playlist <p> on (or
 * from the start), are left out of the comparison, as settled.py leaves them out of the golden; whether any such write
 * happened is still compared (settled.py's `vary` lines).
 */
export interface VaryRule {
  readonly gprs: readonly number[];
  /** Only writes after Java selects this playlist; null: all of them. */
  readonly afterPlaylist: number | null;
}

export interface ScriptOptions {
  readonly vary: readonly VaryRule[];
}

export const VARY_LINE = /^\s*#!\s*vary\s+gpr((?:\s+\d+)+?)(?:\s+after\s+playlist\s+(\d+))?\s*(?:#.*)?$/;

export function parseScriptOptions(source: string): ScriptOptions {
  const vary: VaryRule[] = [];
  for (const raw of source.split('\n')) {
    const m = VARY_LINE.exec(raw);
    if (m) vary.push({ gprs: m[1]!.trim().split(/\s+/).map(Number), afterPlaylist: m[2] === undefined ? null : Number(m[2]) });
    else if (/^\s*#!/.test(raw)) throw new Error(`key script: unsupported option "${raw.trim()}"`);
  }
  return { vary };
}

/** A script step as it ran, in tools/bdj-trace/settled.py's form: a `wait still` step carries the settled plane's hash. */
export interface SettledStep {
  readonly script: 'step';
  readonly n: number;
  readonly step: string;
  readonly hash?: string | null;
  /** A `wait menu` step that held on an animated menu (visible, still flushing after 30 s): its hash is not compared. */
  readonly animated?: true;
}
