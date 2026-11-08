// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { clock, describeAlignment, firstDialogueMs, formatNudge, nextEpisode, nudgeForKey, previewTiming, previousEpisode } from './lineup-model';

describe('lineup-model', () => {
  it('says what lining up found', () => {
    expect(describeAlignment({ kind: 'offset', offsetMs: 1200, confidence: 0.9 })).toBe('Shifted +1.20 s, confident');
    expect(describeAlignment({ kind: 'offset', offsetMs: -840, confidence: 0.9 })).toBe('Shifted −0.84 s, confident');
    expect(describeAlignment({ kind: 'split', parts: [{ fromMs: 0, offsetMs: 1200 }, { fromMs: 724_000, offsetMs: 840 }], confidence: 0.8 })).toBe('Split at 12:04: +1.20 s, then +0.84 s');
    expect(describeAlignment({ kind: 'none', reason: 'no-speech' })).toBe('Could not line up: too little dialogue');
    expect(describeAlignment({ kind: 'none', reason: 'low-confidence' })).toBe('Could not line up: not confident');
  });

  it('maps the bracket keys to nudges', () => {
    expect([']', '[', '}', '{', 'a'].map(nudgeForKey)).toEqual([42, -42, 10, -10, null]);
    expect(formatNudge(-42)).toBe('−0.042 s');
    expect(formatNudge(0)).toBe('0.000 s');
  });

  it('fetches a track retimed only when lining up moved it', () => {
    expect(previewTiming({ kind: 'none', reason: 'no-speech' })).toEqual({ kind: 'original' });
    expect(previewTiming(undefined)).toEqual({ kind: 'original' });
    expect(previewTiming({ kind: 'offset', offsetMs: 5, confidence: 1 })).toEqual({ kind: 'offset', offsetMs: 5, confidence: 1 });
  });

  it("finds an ASS script's earliest dialogue line", () => {
    const script = 'Dialogue: 0,0:01:02.50,0:01:04.00,Default,,0,0,0,,b\nComment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,c\nDialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,a\n';
    expect(firstDialogueMs(script)).toBe(5000);
    expect(firstDialogueMs('[Events]\n')).toBeNull();
    expect(clock(3_725_000)).toBe('1:02:05');
  });

  it('moves on to the next episode still to check, wrapping round', () => {
    const choices = { 1: { releaseKey: 'tosho-7', fileId: '11', trackIds: ['2'] }, 2: 'none' as const, 3: { releaseKey: 'tosho-7', fileId: '13', trackIds: ['2'] } };
    expect(nextEpisode([1, 2, 3], 1, choices, {})).toBe(3);
    expect(nextEpisode([1, 2, 3], 3, choices, {})).toBe(1);
    expect(nextEpisode([1, 2, 3], 3, choices, { 1: { alignment: { kind: 'original' }, nudgeMs: 0, accepted: true } })).toBe(3);
  });

  it('previousEpisode is the one before in the order, null on the first', () => {
    expect(previousEpisode([1, 3, 4], 4)).toBe(3);
    expect(previousEpisode([1, 3, 4], 3)).toBe(1);
    expect(previousEpisode([1, 3, 4], 1)).toBeNull();
    expect(previousEpisode([1, 3, 4], 2)).toBeNull();
  });
});
