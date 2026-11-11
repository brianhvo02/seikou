// SPDX-License-Identifier: LGPL-3.0-or-later
// Shift an ASS script's Dialogue times by an offset, or by a different offset after a cut.
import { retime } from '@seikou/fansubs';

const SCRIPT = [
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,The lanterns are lit, and so, we walk.',
  'Dialogue: 0,0:10:00.00,0:10:02.00,Default,,0,0,0,,Is that the harbour?',
].join('\n');

export default async function example(): Promise<void> {
  const later = retime(SCRIPT, { kind: 'offset', offsetMs: 1500, confidence: 0.9 });
  console.log(later.split('\n').slice(2).join('\n'));
  if (!later.includes('0:00:02.50,0:00:04.50') || !later.includes('The lanterns are lit, and so, we walk.')) throw new Error('the offset was not applied');

  // After a cut at 5 minutes (in the track's own time) the disc is 2 s ahead of the release.
  const split = retime(SCRIPT, { kind: 'split', parts: [{ fromMs: 0, offsetMs: 0 }, { fromMs: 300_000, offsetMs: -2000 }], confidence: 0.8 });
  if (!split.includes('0:00:01.00,0:00:03.00') || !split.includes('0:09:58.00,0:10:00.00')) throw new Error('the split was not applied');

  if (retime(SCRIPT, { kind: 'none', reason: 'low-confidence' }) !== SCRIPT) throw new Error('a none alignment changed the script');
}
