// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import { toVtt } from '../../src/package/vtt';

it('writes one cue per chapter, each ending where the next starts and the last at the end', () => {
  expect(
    toVtt(
      [
        { title: 'Opening', startNs: 0n },
        { title: 'Part A\nline two', startNs: 90_090_000_000n },
        { title: 'Ending --> credits', startNs: 3_661_001_000_000n },
      ],
      3_700_000,
    ),
  ).toBe(
    'WEBVTT\n\n1\n00:00:00.000 --> 00:01:30.090\nOpening\n\n2\n00:01:30.090 --> 01:01:01.001\nPart A line two\n\n3\n01:01:01.001 --> 01:01:40.000\nEnding --&gt; credits\n',
  );
});

it('writes only the header without chapters, and leaves out chapters at or after the end', () => {
  expect(toVtt([], 1000)).toBe('WEBVTT\n');
  expect(toVtt([{ title: 'A', startNs: 0n }, { title: 'B', startNs: 1_000_000_000n }], 1000)).toBe('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nA\n');
});
