// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { chapterAction, chapterLabel } from './chapter-actions';

const S = 1_000_000;
const DURATION = 1440 * S;
const CHAPTERS = [
  { startUs: 0, name: 'Prologue' },
  { startUs: 90 * S, name: 'Opening' },
  { startUs: 180 * S, name: 'Part A' },
  { startUs: 1300 * S, name: 'Ending' },
  { startUs: 1390 * S, name: 'Preview' },
];

describe('chapterAction', () => {
  it('skip-opening jumps to the chapter after Opening', () => {
    expect(chapterAction(CHAPTERS, 100 * S, DURATION, true)).toEqual({ kind: 'skip-opening', toUs: 180 * S });
    // case-insensitive, and only while the opening plays
    expect(chapterAction([{ startUs: 0, name: 'OPENING' }, { startUs: 90 * S }], 10 * S, DURATION, false)).toEqual({ kind: 'skip-opening', toUs: 90 * S });
    expect(chapterAction(CHAPTERS, 200 * S, DURATION, true)).toBeNull();
    expect(chapterAction(CHAPTERS, 50 * S, DURATION, true)).toBeNull();
  });

  it('skip-ending when a chapter follows the Ending', () => {
    expect(chapterAction(CHAPTERS, 1310 * S, DURATION, true)).toEqual({ kind: 'skip-ending', toUs: 1390 * S });
    expect(chapterAction(CHAPTERS, 1310 * S, DURATION, false)).toEqual({ kind: 'skip-ending', toUs: 1390 * S });
  });

  it('next-episode during an Ending that nothing follows', () => {
    const chapters = CHAPTERS.slice(0, 4);
    expect(chapterAction(chapters, 1310 * S, DURATION, true)).toEqual({ kind: 'next-episode' });
  });

  it('next-episode during a Preview after the Ending', () => {
    expect(chapterAction(CHAPTERS, 1400 * S, DURATION, true)).toEqual({ kind: 'next-episode' });
    // a Preview that doesn't follow an Ending is just a chapter
    expect(chapterAction([{ startUs: 0, name: 'Part A' }, { startUs: 100 * S, name: 'Preview' }], 110 * S, DURATION, true)).toBeNull();
  });

  it("no next-episode action at the show's last episode", () => {
    expect(chapterAction(CHAPTERS, 1400 * S, DURATION, false)).toBeNull();
    expect(chapterAction(CHAPTERS.slice(0, 4), 1310 * S, DURATION, false)).toBeNull();
  });

  it('nothing without chapters or a length', () => {
    expect(chapterAction([], 10 * S, DURATION, true)).toBeNull();
    expect(chapterAction(CHAPTERS, 100 * S, 0, true)).toBeNull();
  });
});

describe('chapterLabel', () => {
  it('names a chapter by its own name, else by its number', () => {
    expect(chapterLabel({ index: 0, startUs: 90 * S, name: 'Opening' })).toBe('Opening · 1:30');
    expect(chapterLabel({ index: 2, startUs: 3725 * S })).toBe('Chapter 3 · 1:02:05');
    expect(chapterLabel({ index: 1, startUs: 0, name: '  ' })).toBe('Chapter 2 · 0:00');
  });
});
