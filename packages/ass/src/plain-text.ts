// SPDX-License-Identifier: LGPL-3.0-or-later
// Original code for Seikou (not part of the libass port): an ASS event as plain text, for places that show text
// without the renderer, such as a video's WebVTT track in Picture in Picture.
import type { AssEvent } from './types';

/** Override tags that place, clip or draw an event: a sign or a drawing, which plain text can't show where it belongs. */
const PLACED = /\\(?:pos|move|org|i?clip|p[1-9])/;

/**
 * The event's text as plain lines, or null when it is a sign or a drawing (a `\pos`, `\move`, `\org`, `\clip` or
 * `\p1`… override): override blocks dropped, `\N` and `\n` as line breaks, `\h` as a space, empty lines left out.
 */
export function plainEventText(event: AssEvent): string | null {
  const blocks = event.text.match(/\{[^}]*\}/g) ?? [];
  if (blocks.some((b) => PLACED.test(b))) return null;
  const lines = event.text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\h/g, ' ')
    .split(/\\[Nn]/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * The plain text of `events` that shows at once (dialogue, not signs or drawings), in their file order, each distinct
 * text once (a line drawn twice on two layers, for a border or a glow, counts once).
 */
export function plainText(events: readonly AssEvent[]): string[] {
  const out: string[] = [];
  for (const e of [...events].sort((a, b) => a.readOrder - b.readOrder)) {
    const text = plainEventText(e);
    if (text !== null && !out.includes(text)) out.push(text);
  }
  return out;
}
