// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Turns an ASS script into the CodecPrivate and blocks of a Matroska `S_TEXT/ASS` track, as the Matroska codec
 * specification lays it out (Codec Mappings, "S_TEXT/ASS" and its "SSA/ASS" subtitle section): the script's header
 * goes into CodecPrivate, and each Dialogue line becomes one block holding
 * `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`, its Start and End moved into the block's
 * timestamp and BlockDuration.
 */
import type { SubtitleBlock } from '@seikou/matroska';

/** The `[Events]` Format line every CodecPrivate carries: Layer, Start and End first, as Matroska readers expect. */
const EVENT_FORMAT = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];

/** The block fields after ReadOrder, in the order the codec mapping fixes. */
const BLOCK_FIELDS = ['layer', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

const NUMERIC_FIELDS = new Set(['layer', 'marginl', 'marginr', 'marginv']);

const TIME = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/;

// ASS times are H:MM:SS.cc (centiseconds); one to three fraction digits are read as a decimal fraction of a second.
function parseTime(field: string): number | null {
  const m = TIME.exec(field.trim());
  if (!m) return null;
  const frac = m[4] ? Number(m[4].padEnd(3, '0').slice(0, 3)) : 0;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}

/** Splits an event line's value into `count` fields; the last field (Text) keeps any commas it holds. */
function splitFields(value: string, count: number): string[] {
  const out: string[] = [];
  let from = 0;
  for (let k = 0; k < count - 1; k++) {
    const comma = value.indexOf(',', from);
    if (comma < 0) break;
    out.push(value.slice(from, comma));
    from = comma + 1;
  }
  out.push(value.slice(from));
  return out;
}

/** A Matroska `S_TEXT/ASS` track's CodecPrivate and blocks, as `assToMatroska` returns them. */
export interface AssTrackData {
  /** The script without its Dialogue and Comment lines, UTF-8, with the canonical `[Events]` Format line. */
  codecPrivate: Uint8Array;
  /** One block per kept Dialogue line, sorted by `timeMs` (events at one time keep their file order). */
  blocks: SubtitleBlock[];
}

/**
 * Converts the ASS `script` for an episode of `durationMs` milliseconds.
 *
 * CodecPrivate is the script with every Dialogue and Comment line of its `[Events]` section removed (a leading BOM
 * too), and that section's Format line rewritten as `Format: Layer, Start, End, Style, Name, MarginL, MarginR,
 * MarginV, Effect, Text` (`Marked` in place of `Layer` for an SSA script that has no Layer field), because Matroska
 * readers rebuild events with Layer, Start and End as the first three fields. Each block's fields are taken by name
 * from the script's own Format line, so a script that orders its fields differently still muxes correctly; a field
 * the script lacks is written as `0` (Layer, margins) or empty. ReadOrder is the line's 0-based position among the
 * script's Dialogue lines in file order (Comment lines are not counted), so it stays the same whichever events are
 * dropped. Comment lines are dropped, as are Dialogue lines whose Start or End cannot be read.
 *
 * Timing: `offsetMs` is called once per Dialogue line with its Start in the script, in milliseconds, and its result
 * moves both Start and End (positive is later). The moved times are rounded to whole milliseconds once. An event
 * that then ends at or before 0, starts at or after `durationMs`, or does not end after it starts is dropped; a
 * start before 0 is clamped to 0 (the block lasts until the event's own end). `timeMs` is the start and
 * `durationMs` the end minus the start.
 */
export function assToMatroska(script: string, durationMs: number, offsetMs: (startMs: number) => number = () => 0): AssTrackData {
  const enc = new TextEncoder();
  const header: string[] = [];
  const events: { timeMs: number; durationMs: number; data: Uint8Array; order: number }[] = [];
  let inEvents = false;
  let format = EVENT_FORMAT.map((n) => n.toLowerCase());
  let readOrder = 0;
  const pieces = script.replace(/^﻿/, '').split(/(\r\n|\n|\r)/); // text and terminators alternate
  for (let i = 0; i < pieces.length; i += 2) {
    const line = pieces[i]!;
    const eol = pieces[i + 1] ?? '';
    if (/^\s*\[/.test(line)) {
      inEvents = /^\s*\[events\]/i.test(line);
      header.push(line + eol);
      continue;
    }
    if (!inEvents) {
      header.push(line + eol);
      continue;
    }
    if (/^Format\s*:/i.test(line)) {
      format = line.slice(line.indexOf(':') + 1).split(',').map((n) => n.trim().toLowerCase());
      const marked = !format.includes('layer') && format.includes('marked');
      const names = EVENT_FORMAT.map((n) => (n === 'Layer' && marked ? 'Marked' : n));
      header.push(`Format: ${names.join(', ')}${eol}`);
      continue;
    }
    if (/^Comment\s*:/i.test(line)) continue;
    if (!/^Dialogue\s*:/i.test(line)) {
      header.push(line + eol);
      continue;
    }

    const order = readOrder++;
    const values = splitFields(line.slice(line.indexOf(':') + 1).replace(/^\s+/, ''), format.length);
    const byName = new Map<string, string>();
    format.forEach((name, k) => {
      const v = values[k];
      if (v !== undefined && !byName.has(name)) byName.set(name, name === 'text' ? v : v.trim());
    });
    if (!byName.has('layer') && byName.has('marked')) byName.set('layer', byName.get('marked')!);
    const start = parseTime(byName.get('start') ?? '');
    const end = parseTime(byName.get('end') ?? '');
    if (start === null || end === null) continue;
    const offset = offsetMs(start);
    let startMs = Math.round(start + offset);
    const endMs = Math.round(end + offset);
    if (endMs <= 0 || startMs >= durationMs || endMs <= startMs) continue;
    if (startMs < 0) startMs = 0;
    const fields = BLOCK_FIELDS.map((name) => byName.get(name) ?? (NUMERIC_FIELDS.has(name) ? '0' : ''));
    events.push({ timeMs: startMs, durationMs: endMs - startMs, data: enc.encode([String(order), ...fields].join(',')), order });
  }
  events.sort((a, b) => a.timeMs - b.timeMs || a.order - b.order);
  return {
    codecPrivate: enc.encode(header.join('')),
    blocks: events.map((e) => ({ timeMs: e.timeMs, durationMs: e.durationMs, data: e.data })),
  };
}
