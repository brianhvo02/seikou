/** Shifts an ASS script's event times, touching only the Start and End fields of its Dialogue lines. Pure; original code. */
import type { FansubAlignment } from '@seikou/nas/nas-api';

const TIME = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/;

function parseTime(field: string): number | null {
  const m = TIME.exec(field.trim());
  if (!m) return null;
  const frac = m[4] ? Number(m[4].padEnd(3, '0').slice(0, 3)) : 0;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}

function formatTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${h}:${p2(m)}:${p2(s)}.${p2(cs % 100)}`;
}

/** `offset` adds `offsetMs`; `split` uses the part the event's start falls in; `none` and `original` change nothing. */
export function retime(ass: string, alignment: FansubAlignment): string {
  if (alignment.kind === 'none' || alignment.kind === 'original') return ass;
  const parts = alignment.kind === 'split' ? [...alignment.parts].sort((a, b) => a.fromMs - b.fromMs) : [];
  const offsetFor = (startMs: number): number => {
    if (alignment.kind === 'offset') return alignment.offsetMs;
    let offset = 0;
    for (const p of parts) if (p.fromMs <= startMs) offset = p.offsetMs;
    return offset;
  };

  let inEvents = false;
  let startIdx = 1;
  let endIdx = 2;
  const pieces = ass.split(/(\r\n|\n|\r)/); // text and terminators alternate
  for (let i = 0; i < pieces.length; i += 2) {
    const line = pieces[i]!;
    const bare = line.replace(/^﻿/, '');
    if (/^\s*\[/.test(bare)) { inEvents = /^\s*\[events\]/i.test(bare); continue; }
    if (!inEvents) continue;
    if (/^Format:/i.test(bare)) {
      const names = bare.slice(bare.indexOf(':') + 1).split(',').map((n) => n.trim().toLowerCase());
      const s = names.indexOf('start');
      const e = names.indexOf('end');
      if (s >= 0 && e >= 0) { startIdx = s; endIdx = e; }
      continue;
    }
    if (!/^Dialogue:/i.test(bare)) continue;

    // field boundaries up to the later of Start and End; the text's commas never matter
    const need = Math.max(startIdx, endIdx);
    const bounds: number[] = [bare.indexOf(':') + 1]; // start offset of each field within `bare`
    let from = bounds[0]!;
    for (let k = 0; k <= need; k++) {
      const comma = bare.indexOf(',', from);
      if (comma < 0) { bounds.push(bare.length); break; }
      bounds.push(comma);
      from = comma + 1;
      if (k < need) bounds.push(from);
    }
    // bounds is [start0, end0, start1, end1, ...]
    const field = (k: number): [number, number] | null => (bounds.length > 2 * k + 1 ? [bounds[2 * k]!, bounds[2 * k + 1]!] : null);
    const sf = field(startIdx);
    const ef = field(endIdx);
    if (!sf || !ef) continue;
    const start = parseTime(bare.slice(sf[0], sf[1]));
    const end = parseTime(bare.slice(ef[0], ef[1]));
    if (start === null || end === null) continue;
    const offset = offsetFor(start);
    const replacements = [
      { range: sf, text: formatTime(start + offset) },
      { range: ef, text: formatTime(end + offset) },
    ].sort((a, b) => b.range[0] - a.range[0]);
    let out = bare;
    for (const r of replacements) {
      const old = out.slice(r.range[0], r.range[1]);
      const lead = old.length - old.trimStart().length;
      const trail = old.length - old.trimEnd().length;
      out = out.slice(0, r.range[0] + lead) + r.text + out.slice(r.range[1] - trail);
    }
    pieces[i] = line.slice(0, line.length - bare.length) + out;
  }
  return pieces.join('');
}
