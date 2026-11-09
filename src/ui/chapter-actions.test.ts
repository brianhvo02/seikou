// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { chapterAction, chapterLabel, countdownHeld } from './chapter-actions';

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

  it('next-episode during a Preview that comes after the Ending with a chapter between', () => {
    const chapters = [
      { startUs: 0, name: 'Part A' },
      { startUs: 1200 * S, name: 'Ending' },
      { startUs: 1290 * S, name: 'Part C' },
      { startUs: 1380 * S, name: 'Preview' },
    ];
    expect(chapterAction(chapters, 1210 * S, DURATION, true)).toEqual({ kind: 'skip-ending', toUs: 1290 * S });
    expect(chapterAction(chapters, 1300 * S, DURATION, true)).toBeNull();
    expect(chapterAction(chapters, 1390 * S, DURATION, true)).toEqual({ kind: 'next-episode' });
    expect(chapterAction(chapters, 1390 * S, DURATION, false)).toBeNull();
  });

  it('an Opening that is the last chapter offers nothing to skip to', () => {
    expect(chapterAction([{ startUs: 0, name: 'Part A' }, { startUs: 100 * S, name: 'Opening' }], 110 * S, DURATION, true)).toBeNull();
  });

  it('two Endings: the first skips to the second, the last offers the next episode', () => {
    const chapters = [{ startUs: 0, name: 'Part A' }, { startUs: 1200 * S, name: 'Ending' }, { startUs: 1300 * S, name: 'Ending' }];
    expect(chapterAction(chapters, 1250 * S, DURATION, true)).toEqual({ kind: 'skip-ending', toUs: 1300 * S });
    expect(chapterAction(chapters, 1350 * S, DURATION, true)).toEqual({ kind: 'next-episode' });
  });

  it('a chapter starts at its exact start time, not before', () => {
    expect(chapterAction(CHAPTERS, 90 * S, DURATION, true)).toEqual({ kind: 'skip-opening', toUs: 180 * S });
    expect(chapterAction(CHAPTERS, 90 * S - 1, DURATION, true)).toBeNull();
    expect(chapterAction(CHAPTERS, 180 * S, DURATION, true)).toBeNull();
  });

  it('anywhere in the middle of an Ending', () => {
    expect(chapterAction(CHAPTERS, 1345 * S, DURATION, true)).toEqual({ kind: 'skip-ending', toUs: 1390 * S });
    expect(chapterAction(CHAPTERS.slice(0, 4), 1345 * S, DURATION, true)).toEqual({ kind: 'next-episode' });
  });

  it('nothing without chapters or a length', () => {
    expect(chapterAction([], 10 * S, DURATION, true)).toBeNull();
    expect(chapterAction(CHAPTERS, 100 * S, 0, true)).toBeNull();
  });
});

describe('countdownHeld', () => {
  it('holds while paused, buffering or loading, and runs while playing or ended', () => {
    expect(['paused', 'buffering', 'loading'].map(countdownHeld)).toEqual([true, true, true]);
    expect(['playing', 'ended'].map(countdownHeld)).toEqual([false, false]);
  });
});

describe('chapterLabel', () => {
  it('names a chapter by its own name, else by its number', () => {
    expect(chapterLabel({ index: 0, startUs: 90 * S, name: 'Opening' })).toBe('Opening · 1:30');
    expect(chapterLabel({ index: 2, startUs: 3725 * S })).toBe('Chapter 3 · 1:02:05');
    expect(chapterLabel({ index: 1, startUs: 0, name: '  ' })).toBe('Chapter 2 · 0:00');
  });
});
